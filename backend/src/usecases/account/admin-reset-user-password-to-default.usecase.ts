// src/usecases/account/admin-reset-user-password-to-default.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { ADMIN_USER_ERROR, DomainError, isDomainError } from '@core/common/errors/domain-error';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import type { AdminScope } from '@core/account/policy/admin-scope.policy';
import { Inject, Injectable } from '@nestjs/common';
import {
  ADMIN_ACCOUNT_RESET_OPTIONS,
  type AdminAccountResetOptions,
} from '@src/modules/account/admin-account-reset.contract';
import type { AdminUserView } from '@src/modules/account/account.types';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  normalizeAdminUserDefaultPasswordSetting,
  normalizeAdminUserTargetAccountId,
} from './admin-user-management.input.normalize';
import type {
  AdminResetUserPasswordResult,
  AdminResetUserPasswordToDefaultCommand,
} from './admin-user-management.types';
import { assertAdminUserManagementScope } from './admin-user-scope';
import {
  assertPasswordResetTargetStatusAllowed,
  loadWritableAdminUserTarget,
  logAdminUserWriteFailure,
} from './admin-user-write-support';

/** 事务内的写入阶段标记，只用于服务端日志定位，不出现在任何对外响应中。 */
type AdminResetUserPasswordToDefaultPhase =
  'LOCK_TARGET' | 'CHECK_TARGET_STATUS' | 'WRITE_PASSWORD_HASH';

/**
 * 重置为默认密码成功的固定安全提示（单一持有，不是调用方可控的自由文本）。
 *
 * 不含默认密码本身、密码哈希、配置键名或目标账号的任何身份信息。
 */
const RESET_TO_DEFAULT_NOTICE =
  '密码已重置为默认密码，目标用户下次登录必须修改密码；已签发的登录态不会立即失效，将在 Access Token 过期后自然退出';

/**
 *
 * `WRITE_PASSWORD_HASH` 阶段的 UPDATE 绑定参数嵌默认密码派生哈希，非领域异常的驱动
 * 错误文本不得经 `message` 进入日志（纵深防御，与旧重置链路一致）。
 */
const SUPPRESSED_MESSAGE_PHASES: ReadonlyArray<AdminResetUserPasswordToDefaultPhase> = [
  'WRITE_PASSWORD_HASH',
];

/**
 * 管理员把普通用户密码重置为系统默认密码（任务 08.4）。
 *
 * 与旧 `adminResetUserPassword`（管理员自填新密码）的关系：
 * - 入口作用域：本用例对一级 / 二级均开放（一级全范围，二级仅可信公司）；
 *   旧入口保留签名但只允许一级，不再向二级开放；
 * - 密码来源：本用例只接受运行期配置的默认密码，**不接受任何客户端密码字段**；
 * - 强制改密：写入哈希的同一 UPDATE 置 `must_change_password = true`，目标用户下次
 *   登录即进入 `MUST_CHANGE_PASSWORD` 受限会话，必须先改密才能访问业务接口。
 *
 * 执行顺序：
 * 1. `assertAdminUserManagementScope()`：精确 SUPER_ADMIN 身份 + 请求期等级；
 * 2. 目标账号 ID 规范化（只校验不修复）；
 * 3. 读取配置默认密码并校验密码策略——缺失或不合策略都在任何数据库访问之前以
 *    `DEFAULT_PASSWORD_NOT_CONFIGURED`（对外 INTERNAL_SERVER_ERROR）失败关闭，
 *    既不回退到硬编码弱口令，也不把策略原因或配置键名暴露给调用方；
 * 4. 事务内：锁定目标 → 二级归属校验 → SUPER_ADMIN 只读保护 → 目标双字段状态边界 →
 *    写哈希并置强制改密标记；
 * 5. 事务提交后记录成功日志（仅账号主键）。
 *
 * 结果复用 `AdminResetUserPasswordResult`：只含 `accountId` / `isUpdated` / 固定 `notice`，
 * 不含默认密码、哈希或配置细节。
 *
 * 旧 Token 按 `JWT_EXPIRES_IN` 自然过期；本用例不写 Token 黑名单、不改 tokenVersion、
 * 不引入 Refresh Token 或服务端 Session。
 */
@Injectable()
export class AdminResetUserPasswordToDefaultUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    @Inject(ADMIN_ACCOUNT_RESET_OPTIONS)
    private readonly resetOptions: AdminAccountResetOptions,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(AdminResetUserPasswordToDefaultUsecase.name);
  }

  async execute(
    command: AdminResetUserPasswordToDefaultCommand,
  ): Promise<AdminResetUserPasswordResult> {
    const scope = await assertAdminUserManagementScope({
      session: command.session,
      actionLabel: '重置密码',
      organizationContext: this.organizationContextQueryService,
    });

    const accountId = normalizeAdminUserTargetAccountId(command.accountId);
    const defaultPassword = this.resolveDefaultPassword();

    try {
      await this.transactionRunner.run((transactionContext) =>
        this.resetInTransaction({
          transactionContext,
          scope,
          accountId,
          defaultPassword,
        }),
      );
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      logAdminUserWriteFailure({
        logger: this.logger,
        phase: 'TRANSACTION_BOUNDARY',
        error,
        summary: '管理员重置用户密码为默认密码',
      });
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '重置密码失败，请稍后重试',
        undefined,
        error,
      );
    }

    this.logger.info({ accountId }, '管理员重置用户密码为默认密码成功');
    return { accountId, isUpdated: true, notice: RESET_TO_DEFAULT_NOTICE };
  }

  /**
   * 读取并校验配置默认密码。
   *
   * 与管理员创建 / 旧重置共用的 `PasswordPolicyService` 是唯一强度真源；这里刻意**不**
   * 调用 `assertAdminUserPasswordPolicy()`：后者面向管理员填写的密码，会把 `errors`
   * 明细拼进 `message` 并映射为 BAD_USER_INPUT；默认密码由部署侧配置，弱口令属服务端
   * 配置问题，必须收敛为统一的 `DEFAULT_PASSWORD_NOT_CONFIGURED` 且不回显策略原因。
   */
  private resolveDefaultPassword(): string {
    const configured = normalizeAdminUserDefaultPasswordSetting(this.resetOptions.defaultPassword);
    if (configured === null) {
      throw new DomainError(
        ADMIN_USER_ERROR.DEFAULT_PASSWORD_NOT_CONFIGURED,
        '系统未配置默认密码，暂时无法重置',
      );
    }

    const validation = this.passwordPolicyService.validatePassword(configured);
    if (!validation.isValid) {
      throw new DomainError(
        ADMIN_USER_ERROR.DEFAULT_PASSWORD_NOT_CONFIGURED,
        '系统默认密码不符合安全要求，暂时无法重置',
      );
    }

    return configured;
  }

  /**
   * 事务内的原子重置：锁定目标 → 目标状态边界 → 覆盖密码哈希并置强制改密标记。
   *
   * 目标加载（锁定、二级归属校验、三源收敛失败关闭与 SUPER_ADMIN 只读保护）由
   * `loadWritableAdminUserTarget()` 单点承担；状态边界与旧重置共用
   * `assertPasswordResetTargetStatusAllowed()`。
   *
   * 时间盐取锁内 View 的 `createdAt`（`base_user_account.created_at`），与登录验证侧
   * 同一列、同一 `toISOString()` 表示，避免重置后新旧密码都无法登录。
   */
  private async resetInTransaction(params: {
    transactionContext: PersistenceTransactionContext;
    scope: AdminScope;
    accountId: number;
    defaultPassword: string;
  }): Promise<void> {
    const { transactionContext, scope, accountId, defaultPassword } = params;
    let phase: AdminResetUserPasswordToDefaultPhase = 'LOCK_TARGET';

    try {
      const lockedView: AdminUserView = await loadWritableAdminUserTarget({
        accountService: this.accountService,
        adminUserQueryService: this.adminUserQueryService,
        organizationMembershipQueryService: this.organizationMembershipQueryService,
        scope,
        accountId,
        actionLabel: '重置密码',
        transactionContext,
      });

      phase = 'CHECK_TARGET_STATUS';
      const facts = await this.adminUserQueryService.findAdminUserStatusFacts({
        accountId,
        transactionContext,
      });
      if (facts === null) {
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '用户状态读取失败，请稍后重试',
          undefined,
          { diagnostic: 'PASSWORD_RESET_STATUS_FACTS_NOT_READABLE', accountId },
        );
      }
      assertPasswordResetTargetStatusAllowed(facts, accountId);

      phase = 'WRITE_PASSWORD_HASH';
      await this.accountService.updateAccountPasswordHash({
        accountId,
        passwordHash: AccountService.hashPasswordWithTimestamp(
          defaultPassword,
          lockedView.createdAt,
        ),
        transactionContext,
        mustChangePassword: true,
      });
    } catch (error) {
      logAdminUserWriteFailure({
        logger: this.logger,
        phase,
        error,
        summary: '管理员重置用户密码为默认密码',
        suppressMessagePhases: SUPPRESSED_MESSAGE_PHASES,
      });
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '重置用户密码失败，请稍后重试',
        undefined,
        error,
      );
    }
  }
}

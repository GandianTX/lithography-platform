// src/usecases/account/admin-reset-user-password.usecase.ts

import { AccountStatus } from '@app-types/models/account.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { ADMIN_USER_ERROR, DomainError, isDomainError } from '@core/common/errors/domain-error';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { isDualStatusFieldsConsistent } from '@core/account/policy/dual-status-consistency.policy';
import { Inject, Injectable } from '@nestjs/common';
import type { AdminUserStatusFacts, AdminUserView } from '@src/modules/account/account.types';
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
  normalizeAdminUserPasswordInput,
  normalizeAdminUserTargetAccountId,
} from './admin-user-management.input.normalize';
import type {
  AdminResetUserPasswordCommand,
  AdminResetUserPasswordResult,
} from './admin-user-management.types';
import { assertAdminUserManagementPermission } from './admin-user-permission';
import {
  assertAdminUserPasswordPolicy,
  loadWritableAdminUserTarget,
  logAdminUserWriteFailure,
} from './admin-user-write-support';

/** 事务内的写入阶段标记，只用于服务端日志定位，不出现在任何对外响应中。 */
type AdminResetUserPasswordPhase = 'LOCK_TARGET' | 'CHECK_TARGET_STATUS' | 'WRITE_PASSWORD_HASH';

/**
 * 重置成功的固定安全提示（单一持有，不是调用方可控的自由文本）。
 *
 * 下一次登录验证必然不匹配），已签发的 Access Token 不立即失效、按 `JWT_EXPIRES_IN`
 * 自然过期。不含目标账号的任何身份信息、密码策略细节或验证状态。
 */
const RESET_PASSWORD_NOTICE =
  '密码已重置，旧密码立即失效；已签发的登录态不会立即失效，将在 Access Token 过期后自然退出';

/**
 *
 * `WRITE_PASSWORD_HASH` 阶段的 UPDATE 绑定参数嵌新密码派生哈希，非领域异常的驱动错误文本
 * 不得经 `message` 进入日志（纵深防御，与 `AdminCreateUserUsecase` 对同名风险的处置一致）。
 * 刻意以 `AdminResetUserPasswordPhase` 联合类型约束成员而不用内联数组：
 * `logAdminUserWriteFailure()` 的参数是宽 `string`，内联字符串字面量在该阶段重命名时
 * 不会报错，抑制会**静默失效**；类型化常量使重命名被 tsc 捕获。
 */
const SUPPRESSED_MESSAGE_PHASES: ReadonlyArray<AdminResetUserPasswordPhase> = [
  'WRITE_PASSWORD_HASH',
];

/**
 * 管理员重置普通用户密码用例（P0-6）。
 *
 * 执行顺序刻意固定：
 * 1. **第一步就是精确 SUPER_ADMIN 权限断言**（`assertAdminUserManagementPermission()`，
 *    全仓单一实现，同时校验 `roles` 含 SUPER_ADMIN 且 `activeRole` 精确等于 SUPER_ADMIN），
 *    先于任何输入规范化与数据库访问；
 * 2. 场景输入规范化：目标账号 ID + 新密码非空断言（刻意不 trim，理由见
 *    `normalizeAdminUserPasswordInput()`）；
 * 3. 新密码策略校验（`assertAdminUserPasswordPolicy()`，与管理员创建共用同一实现），
 *    先于任何数据库访问：输入错误（`BAD_USER_INPUT`）不应在占用行锁之后才暴露；
 * 4. Usecase 持有的单一事务内：锁定目标账号 → 目标角色保护 → 目标双字段状态裁决
 *
 * verification token consume 链路（`ConsumeVerificationFlowUsecase` + `ResetPasswordUsecase`），
 * 由 token 持有者触发、无管理员会话、错误码落在 `VERIFICATION_RECORD_ERROR.*`。
 * 本用例是独立的管理员链路：不接触任何 verification token / 验证记录 / token 预读能力，
 * 不复用其 usecase、错误码或 GraphQL 流程充当管理员入口；两条链路只在密码**哈希与
 * 策略原语**上汇合（`PasswordPolicyService` / `hashPasswordWithTimestamp()` /
 * `updateAccountPasswordHash()`，全仓单一实现），流程编排零共享。
 *
 * 密码复用点（无任何第二套实现）：
 * - 非空断言：`normalizeAdminUserPasswordInput()`（P0-3 / P0-6 共用的安全前置条件，
 *   防 `CreateAccountUsecase` 的 `if (loginPassword)` 跳过校验缺陷）；
 * - 强度校验：`PasswordPolicyService.validatePassword()`（含 NFKC、纯空白与首尾空格驳回）；
 * - 哈希：`AccountService.hashPasswordWithTimestamp()`，时间盐取 `base_user_account.created_at`
 *   的 UTC ISO 表示；盐来自锁内读取的 View（`AdminUserView.createdAt` 即账号创建时间），
 *   不在用例侧另取时钟。策略放行后 `preprocessPassword()` 的驳回分支不可达（论证见
 *   `assertAdminUserPasswordPolicy()` JSDoc）；
 * - 写入：`AccountService.updateAccountPasswordHash()`，只更新 `login_password` 并由该方法
 *   维护 `updated_at`。
 *
 * 目标保护：任意 SUPER_ADMIN 目标一律不受理（`loadWritableAdminUserTarget()` 内
 * `assertWritableAdminUserTargetRole()` 依**锁内**数据库事实裁决）；管理员重置自己的密码
 * 同样被该断言驳回（自己的账号必然是 SUPER_ADMIN），本用例不另设自指分支。
 *
 * `loadWritableAdminUserTarget()` 内部的三源角色收敛失败（`ROLE_DATA_INCONSISTENT`）或
 * 资料行缺失（`READ_FAILED`）时，密码重置同样被驳回——即使密码重置本身不消费这些数据。
 * 这是刻意的：收敛不出单一角色就无法安全确认目标「不是 SUPER_ADMIN」，放行等于允许对
 * 身份不明的账号覆盖登录凭据。代价是三源脏数据的存量普通账号会被锁在本功能外。
 * 该口径与列表「整次失败关闭」同源；公开角色修改入口已经下线，但本用例仍对任何
 * 无法收敛的历史或异常数据保持失败关闭，不静默选择任一字段为真源。
 *
 * 目标状态只允许双字段一致的 `ACTIVE` / `INACTIVE` 普通账号。`PENDING` / `SUSPENDED` / `BANNED` / `DELETED`、双字段不一致与状态缺失
 * 一律拒绝（`PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED`，对外 `CONFLICT`，不复用
 * `STATUS_TRANSITION_NOT_ALLOWED`——后者专指启停状态转换），拒绝发生在哈希生成与
 * 任何写入之前——停用 / 封禁语义被尊重，`INACTIVE` 账号重置后仍是 `INACTIVE`
 * （本用例不写状态字段，不存在顺带启用），拒绝路径不操作 Token / Session。
 *
 * 旧 Token 按 `JWT_EXPIRES_IN` 自然过期；不写 Token 黑名单、不改 tokenVersion、
 * 不引入 Refresh Token 或服务端 Session，本用例不直接操作 Session 或 JWT。
 *
 * MySQL REPEATABLE READ 下，在本事务提交前已建立一致性快照、仍在进行的登录读取，可能
 * 读到旧 `login_password` 并以旧密码通过验证（极短窗口，快照隔离固有语义，不经本用例
 * 消除；消除它需要登录链路加锁，不可取）。`notice` 面向管理员表达「已重置」语义，
 * 不受该边界影响。
 *
 * 结果口径：只返回目标 `accountId`、`isUpdated` 与固定 `notice`，不含新密码、旧密码、
 * 密码哈希或验证细节（`AdminResetUserPasswordResult`）。成功日志只含账号主键。
 *
 * 写入正确性口径（与 P0-5 的 `user_state` 同理）：`AdminUserView` 刻意不含密码哈希
 * 由后续独立测试计划显式覆盖；`updateAccountPasswordHash()` 失败会抛错并使整个事务回滚。
 *
 * 依赖方向：事务边界由本用例经 `TransactionRunner` 持有，同一个 `transactionContext`
 * 显式传给全部下游；只调用 modules 细粒度方法与 QueryService，不访问 Repository、
 * 不接触 ORM API、不持有 ORM Entity。本用例只写 `base_user_account` 行（行锁 + 密码列），
 * 不触碰 `base_user_info`；取锁顺序（account 行优先）与本组统一口径一致
 *
 * 不含数据库复核。已停用或已降级的管理员账号在旧 Access Token 到期前仍可能通过该断言，
 * 即时失效由 `ValidateAccessTokenSessionUsecase`（P0-7）承担。
 */
@Injectable()
export class AdminResetUserPasswordUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(AdminResetUserPasswordUsecase.name);
  }

  async execute(command: AdminResetUserPasswordCommand): Promise<AdminResetUserPasswordResult> {
    assertAdminUserManagementPermission(command.session, '重置密码');

    const accountId = normalizeAdminUserTargetAccountId(command.accountId);
    const newPassword = normalizeAdminUserPasswordInput(command.newPassword, '新密码');
    assertAdminUserPasswordPolicy({
      passwordPolicyService: this.passwordPolicyService,
      password: newPassword,
      fieldName: '新密码',
    });

    try {
      await this.transactionRunner.run((transactionContext) =>
        this.resetInTransaction({
          transactionContext,
          adminAccountId: command.session.accountId,
          accountId,
          newPassword,
        }),
      );
    } catch (error) {
      // 事务内各阶段的异常已由 resetInTransaction 的 catch 记录日志并收敛为 DomainError；
      // 走到这里的非 DomainError 只可能来自事务边界本身（BEGIN / COMMIT 失败都不经过
      // 内层 catch），统一收敛为 WRITE_FAILED
      if (isDomainError(error)) {
        throw error;
      }
      logAdminUserWriteFailure({
        logger: this.logger,
        phase: 'TRANSACTION_BOUNDARY',
        error,
        summary: '管理员重置用户密码',
      });
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '重置密码失败，请稍后重试',
        undefined,
        error,
      );
    }

    // 成功日志在事务提交之后记录（同 AdminCreateUserUsecase 的假成功规避），
    // 只含账号主键：不含登录名、登录邮箱、昵称、密码或任何凭据派生物。
    this.logger.info({ accountId }, '管理员重置用户密码成功');
    return { accountId, isUpdated: true, notice: RESET_PASSWORD_NOTICE };
  }

  /**
   * 事务内的原子密码重置：锁定目标 → 目标角色保护 → 覆盖密码哈希。
   *
   * 目标加载（含锁定、三源收敛失败关闭与 SUPER_ADMIN 只读保护）由
   * `loadWritableAdminUserTarget()` 单一实现承担，本用例不重复实现任何一段。
   *
   * 写哈希阶段（`WRITE_PASSWORD_HASH`）的 UPDATE 绑定参数嵌新密码派生哈希，
   * 因此该阶段的失败日志经类型化常量 `SUPPRESSED_MESSAGE_PHASES` 抑制 `message`
   * （纵深防御，与 `AdminCreateUserUsecase` 对同名风险的处置一致），
   * 错误类型名与驱动错误码仍保留。
   *
   * `lockedView.createdAt` 为盐，登录验证侧（`login-with-password.usecase.ts`）以
   * 账号行 `created_at` 为盐，两侧必须永远指向同一列。当前由三个事实保证：
   * ① `AdminUserView.createdAt` 由 `toAdminUserView()` 直接取 `account.createdAt`
   *   （账号侧列，不经 `resolveUpdatedAt` 加工）；
   * ② `hashPasswordWithTimestamp()` 与 `verifyPassword()` 对称使用 `createdAt.toISOString()`；
   * ③ 本用例不在用例侧另取时钟。
   * 任一事实被破坏（如 View.createdAt 映射漂移、本用例误改用 `updatedAt` 或应用时钟），
   * 重置哈希将不再匹配登录验证——**该账号新旧密码都无法登录**（旧哈希已被覆盖），
   * 且全程静默（无异常、无编译告警）。刻意不做窄事实读取：`AdminUserView.createdAt`
   * 的语义已在 `account.types.ts` 的 View 注释中单点文档化，为取一个已随锁内 View
   * 返回的字段再新增一次锁内账号行查询，防漂移收益不抵成本；真正的兜底是后续
   *
   * （目标 ID 与新密码都来自入参），返回入参值会造成「有新值产出」的误导，
   * 外层直接使用闭包内的 `accountId`。
   */
  private async resetInTransaction(params: {
    transactionContext: PersistenceTransactionContext;
    adminAccountId: number;
    accountId: number;
    newPassword: string;
  }): Promise<void> {
    const { transactionContext, adminAccountId, accountId, newPassword } = params;
    let phase: AdminResetUserPasswordPhase = 'LOCK_TARGET';

    try {
      const lockedView: AdminUserView = await loadWritableAdminUserTarget({
        accountService: this.accountService,
        adminUserQueryService: this.adminUserQueryService,
        organizationContextQueryService: this.organizationContextQueryService,
        organizationMembershipQueryService: this.organizationMembershipQueryService,
        adminAccountId,
        accountId,
        actionLabel: '重置密码',
        transactionContext,
      });

      phase = 'CHECK_TARGET_STATUS';
      // 状态事实与 AdminSetUserStatusUsecase 同源（findAdminUserStatusFacts() 窄内部读取，
      // 不经对外 View）；两行已在前置目标加载阶段验证存在，null 属系统侧故障按读失败关闭
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
      this.assertPasswordResetTargetStatusAllowed(facts, accountId);

      phase = 'WRITE_PASSWORD_HASH';
      // 时间盐取账号创建时间（锁内 View 携带），与本仓注册 / 创建 / 公开重置链路同一实现
      await this.accountService.updateAccountPasswordHash({
        accountId,
        passwordHash: AccountService.hashPasswordWithTimestamp(newPassword, lockedView.createdAt),
        transactionContext,
      });
    } catch (error) {
      logAdminUserWriteFailure({
        logger: this.logger,
        phase,
        error,
        summary: '管理员重置用户密码',
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

  /**
   *
   * 与 P0-5 的状态转换矩阵（R8）同构但语义不同：这里不是状态转换裁决，而是「当前处于
   * 哪些状态的账号可以被管理员覆盖登录凭据」。拒绝时**不生成密码哈希、不写数据库、
   * 不改变账号状态与角色、不操作 Token / Session**（本方法在写哈希阶段之前执行）。
   *
   * 不复用 `STATUS_TRANSITION_NOT_ALLOWED`：该码专指启停状态转换，不是密码重置。
   * 一致性比对与 `AdminSetUserStatusUsecase` 同口径：两枚举类型不同、成员字符串当前
   * `details` 刻意留空，当前状态事实只进
   * `cause.diagnostic` 供服务端排查，不进对外响应。
   */
  private assertPasswordResetTargetStatusAllowed(
    facts: AdminUserStatusFacts,
    accountId: number,
  ): void {
    // 「双字段一致且处于两态」的两种合法形态：accountStatus 命中两态之一后，
    // isDualStatusFieldsConsistent({ accountStatus, userState }) 即等价于 userState 与之同值
    const isConsistentActive =
      facts.accountStatus === AccountStatus.ACTIVE &&
      isDualStatusFieldsConsistent({
        accountStatus: facts.accountStatus,
        userState: facts.userState,
      });
    const isConsistentInactive =
      facts.accountStatus === AccountStatus.INACTIVE &&
      isDualStatusFieldsConsistent({
        accountStatus: facts.accountStatus,
        userState: facts.userState,
      });
    if (isConsistentActive || isConsistentInactive) {
      return;
    }
    throw new DomainError(
      ADMIN_USER_ERROR.PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED,
      '账号当前状态不允许重置密码',
      undefined,
      {
        diagnostic: 'PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED',
        accountId,
        currentStatus: facts.accountStatus,
        currentUserState: facts.userState,
      },
    );
  }
}

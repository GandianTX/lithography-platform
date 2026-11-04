// src/usecases/account/admin-set-user-status.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import {
  ADMIN_USER_ERROR,
  DomainError,
  isDomainError,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
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
  normalizeAdminUserTargetAccountId,
  normalizeAdminUserWritableStatus,
} from './admin-user-management.input.normalize';
import type { AdminSetUserStatusCommand } from './admin-user-management.types';
import { assertAdminUserManagementPermission } from './admin-user-permission';
import { loadWritableAdminUserTarget, logAdminUserWriteFailure } from './admin-user-write-support';

/** 事务内的写入阶段标记，只用于服务端日志定位，不出现在任何对外响应中。 */
type AdminSetUserStatusPhase =
  'LOCK_TARGET' | 'CHECK_CURRENT_STATUS' | 'WRITE_STATUS' | 'READ_BACK_VIEW';
/**
 * 管理员设置用户状态用例（P0-5）。
 *
 * 执行顺序刻意固定：
 * 1. **第一步就是精确 SUPER_ADMIN 权限断言**（`assertAdminUserManagementPermission()`，
 *    全仓唯一实现），先于任何输入规范化与数据库访问；
 * 2. 场景输入规范化：目标账号 ID + 可写状态（`ACTIVE` / `INACTIVE`）；
 * 4. Usecase 持有的单一事务内：锁定目标 → 读取收敛 View → 目标角色保护 →
 *    读取双字段状态事实 → 转换矩阵裁决（不允许即失败关闭 / 同状态幂等返回）→
 *    双字段一致性写入 → 回读 View 并校验后置条件。
 *
 * - `base_user_account.status` = 目标状态（`AccountService.updateAccount()`）；
 * - `base_user_info.user_state` = 同值状态（`AccountService.updateUserInfoFields()`）；
 * 启用即两处同为 `ACTIVE`，停用即两处同为 `INACTIVE`。`PENDING` / `SUSPENDED` /
 * `BANNED` / `DELETED` 不是可写值（白名单拒绝），不做硬删除。
 *
 * `AccountStatus` 与 `UserState` 是两个不同枚举类型（成员字符串当前逐字相同），
 * 映射刻意显式书写而非断言复用：将来任一枚举扩容（如 `AccountStatus` 新增成员）时，
 * 显式映射处会在类型检查下暴露，静默复用则会把非法状态写入 `user_state`。
 *
 * （`ACTIVE` / `INACTIVE` 之外的请求值在此即被拒），锁内状态事实裁决**转换合法性**。
 * 允许的转换只有两行：
 * - 当前双字段同为 `ACTIVE`：改 `INACTIVE` 允许；改 `ACTIVE` 幂等成功（不执行 UPDATE）；
 * - 当前双字段同为 `INACTIVE`：改 `ACTIVE` 允许；改 `INACTIVE` 幂等成功（不执行 UPDATE）。
 *
 * 其余全部失败关闭、不允许写入，且**不自动修复、不选任一字段为真源、不继续执行双字段
 * UPDATE**（负责人裁决原话）：当前状态为 `PENDING` / `SUSPENDED` / `BANNED` / `DELETED`
 * （含无法识别的值——任何不在两态内的当前值都进不了矩阵）、`account.status` 与
 * `userInfo.user_state` 不一致、当前状态缺失。转换不允许使用独立错误码
 * `STATUS_TRANSITION_NOT_ALLOWED`（对外 `CONFLICT`：目标状态合法非 `BAD_USER_INPUT`、
 * 权限无问题非 `FORBIDDEN`、这是明确的当前状态冲突非系统侧 5xx）；同状态幂等请求
 * 直接返回锁内读取的安全 View，不执行任何 UPDATE、不 bump 任何时间列。
 *
 * 目标保护：任意 SUPER_ADMIN 目标一律拒绝（断言基于锁内读到的数据库事实）。
 * 「不能停用自己」在该断言之外**先行显式拒绝**：管理员自己的账号必然是 SUPER_ADMIN，
 * 目标保护断言同样会拒绝，但那是「管理员账号只读」的间接事实；停用自己是本功能的
 * 数据库访问之前。
 *
 * 受保护请求校验统一执行，本用例不直接操作 Session 或 JWT。
 *
 * 依赖方向：事务边界由本用例经 `TransactionRunner` 持有，同一个 `transactionContext`
 * 显式传给全部下游；只调用 modules 细粒度方法与 QueryService，不访问 Repository、
 * 不接触 ORM API、不持有 ORM Entity。
 *
 * 数据库复核。即时失效由 `ValidateAccessTokenSessionUsecase`（P0-7）承担。
 */
@Injectable()
export class AdminSetUserStatusUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(AdminSetUserStatusUsecase.name);
  }

  async execute(command: AdminSetUserStatusCommand): Promise<AdminUserView> {
    assertAdminUserManagementPermission(command.session, '修改状态');

    const accountId = normalizeAdminUserTargetAccountId(command.accountId);
    // 只接受 ACTIVE / INACTIVE：PENDING、SUSPENDED、BANNED、DELETED 在此即被拒绝
    const status = normalizeAdminUserWritableStatus(command.status);

    // 不依赖「自己的账号恰好是只读的 SUPER_ADMIN」这一间接事实
    if (status === AccountStatus.INACTIVE && accountId === command.session.accountId) {
      throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '管理员不能停用自己的账号');
    }

    let view: AdminUserView;
    try {
      view = await this.transactionRunner.run((transactionContext) =>
        this.setStatusInTransaction({
          transactionContext,
          adminAccountId: command.session.accountId,
          accountId,
          status,
        }),
      );
    } catch (error) {
      // 事务内各阶段的异常已由 setStatusInTransaction 的 catch 记录日志并收敛为
      // DomainError；走到这里的非 DomainError 只可能来自事务边界本身
      // （BEGIN / COMMIT 失败都不经过内层 catch），统一收敛为 WRITE_FAILED。
      if (isDomainError(error)) {
        throw error;
      }
      logAdminUserWriteFailure({
        logger: this.logger,
        phase: 'TRANSACTION_BOUNDARY',
        error,
        summary: '管理员设置用户状态',
      });
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '设置用户状态失败，请稍后重试',
        undefined,
        error,
      );
    }

    // 成功日志在事务提交之后记录（同 AdminCreateUserUsecase 的假成功规避），
    // 只含账号主键与新状态。
    this.logger.info({ accountId: view.id, status: view.status }, '管理员设置用户状态成功');
    return view;
  }

  /**
   * 事务内的原子状态修改：双字段一致写入与回读同成同败。
   *
   * 目标加载（含锁定、三源收敛失败关闭与 SUPER_ADMIN 只读保护）由
   * `loadWritableAdminUserTarget()` 单一实现承担；两处写入复用既有细粒度方法，
   * 时间列由下游方法内部维护或由本用例显式传应用时钟，不手工拼装第二套时间语义。
   *
   * 已知死锁窗口与处置口径见 `admin-user-write-support.ts` 文件头。
   */
  private async setStatusInTransaction(params: {
    transactionContext: PersistenceTransactionContext;
    adminAccountId: number;
    accountId: number;
    status: AccountStatus.ACTIVE | AccountStatus.INACTIVE;
  }): Promise<AdminUserView> {
    const { transactionContext, adminAccountId, accountId, status } = params;
    let phase: AdminSetUserStatusPhase = 'LOCK_TARGET';

    try {
      // 真实转换的对外返回走写入后的独立回读
      const lockedView = await loadWritableAdminUserTarget({
        accountService: this.accountService,
        adminUserQueryService: this.adminUserQueryService,
        organizationContextQueryService: this.organizationContextQueryService,
        organizationMembershipQueryService: this.organizationMembershipQueryService,
        adminAccountId,
        accountId,
        actionLabel: '修改状态',
        transactionContext,
      });

      phase = 'CHECK_CURRENT_STATUS';
      // 转换矩阵在锁定之后、任何写入之前裁决（负责人裁决实现边界第 2 条）：
      // 双字段当前事实由窄内部读取提供，不经对外 View（View 刻意不含 userState）
      const facts = await this.adminUserQueryService.findAdminUserStatusFacts({
        accountId,
        transactionContext,
      });
      if (facts === null) {
        // 两行在前置目标加载阶段已验证存在，此处缺失属系统侧故障，按读失败关闭；
        // 「当前状态缺失」因此不会以 CONFLICT 形态出现，也不存在可用的状态事实可供修复
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '用户状态读取失败，请稍后重试',
          undefined,
          { diagnostic: 'STATUS_FACTS_NOT_READABLE', accountId },
        );
      }
      this.assertStatusTransitionAllowed(facts, accountId);

      // 同状态幂等：锁内读到的 View 即当前事实，直接返回，不执行双字段 UPDATE，
      // 也不 bump 任何 updated_at（负责人裁决第 1 / 2 / 6 条）
      if (facts.accountStatus === status) {
        return lockedView;
      }

      phase = 'WRITE_STATUS';
      // 账号侧状态 + 显式 updatedAt（patch 由本用例逐字段构造，不透传调用方可控字段）
      await this.accountService.updateAccount(
        accountId,
        { status, updatedAt: new Date() },
        transactionContext,
      );
      // 资料侧 user_state 同值同步；两步在同一事务内，外部观察者只能看到一致的终态
      await this.accountService.updateUserInfoFields({
        accountId,
        patch: {
          userState: status === AccountStatus.ACTIVE ? UserState.ACTIVE : UserState.INACTIVE,
        },
        transactionContext,
      });

      phase = 'READ_BACK_VIEW';
      const view = await this.adminUserQueryService.findAdminUserViewById({
        accountId,
        transactionContext,
      });
      if (view === null) {
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '用户状态更新后读取失败，请稍后重试',
          undefined,
          { diagnostic: 'UPDATED_STATUS_NOT_READABLE', accountId },
        );
      }
      // 后置校验：回读 View 的 status 必须精确等于本次请求的状态，不等说明写入未按
      // user_state 的写入正确性由后续独立测试计划显式覆盖，本用例无法经 View 自证。
      if (view.status !== status) {
        throw new DomainError(
          ADMIN_USER_ERROR.WRITE_FAILED,
          '用户状态更新失败，请稍后重试',
          undefined,
          { diagnostic: 'STATUS_NOT_REFLECTED_AFTER_WRITE', accountId },
        );
      }
      return view;
    } catch (error) {
      logAdminUserWriteFailure({
        logger: this.logger,
        phase,
        error,
        summary: '管理员设置用户状态',
      });
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '用户状态更新失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   *
   * 允许的转换只有两行：
   * - 当前双字段同为 `ACTIVE`：改 `INACTIVE` 允许；改 `ACTIVE` 幂等成功（不写库）；
   * - 当前双字段同为 `INACTIVE`：改 `ACTIVE` 允许；改 `INACTIVE` 幂等成功（不写库）。
   *
   * 其余全部失败关闭、不允许写入，且**不自动修复、不选任一字段为真源、不继续执行
   * 双字段 UPDATE**：
   * - 当前状态为 `PENDING` / `SUSPENDED` / `BANNED` / `DELETED`（含无法识别的值——
   *   数据库列是 enum，但应用不信任这一层：任何不在两态白名单内的当前值都进不了矩阵）；
   * - `account.status` 与 `userInfo.userState` 不一致（两枚举类型不同、成员字符串当前
   *   逐字相同；一致性判定上收 core `dual-status-consistency.policy.ts` 单一实现）；
   * - 当前状态缺失（`findAdminUserStatusFacts()` 返回 `null`，上方已按系统侧读失败关闭）。
   *
   * 全部使用独立错误码 `STATUS_TRANSITION_NOT_ALLOWED`（对外 `CONFLICT`）：
   * 请求的目标状态本身合法（非 `BAD_USER_INPUT`）、管理员权限无问题（非 `FORBIDDEN`）、
   * 这是明确的当前状态冲突（非系统侧 5xx）。当前状态事实只进 `cause.diagnostic`
   * （`details` 留空），不进对外响应。
   */
  private assertStatusTransitionAllowed(facts: AdminUserStatusFacts, accountId: number): void {
    if (
      facts.accountStatus !== AccountStatus.ACTIVE &&
      facts.accountStatus !== AccountStatus.INACTIVE
    ) {
      throw new DomainError(
        ADMIN_USER_ERROR.STATUS_TRANSITION_NOT_ALLOWED,
        '账号当前状态不允许执行启用或停用',
        undefined,
        {
          diagnostic: 'CURRENT_STATUS_NOT_TRANSITIONABLE',
          accountId,
          currentStatus: facts.accountStatus,
          currentUserState: facts.userState,
        },
      );
    }
    if (
      !isDualStatusFieldsConsistent({
        accountStatus: facts.accountStatus,
        userState: facts.userState,
      })
    ) {
      throw new DomainError(
        ADMIN_USER_ERROR.STATUS_TRANSITION_NOT_ALLOWED,
        '账号当前状态不一致，无法执行启用或停用',
        undefined,
        {
          diagnostic: 'DUAL_STATUS_FIELDS_INCONSISTENT',
          accountId,
          currentStatus: facts.accountStatus,
          currentUserState: facts.userState,
        },
      );
    }
  }
}

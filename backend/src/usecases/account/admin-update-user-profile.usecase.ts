// src/usecases/account/admin-update-user-profile.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  isDomainError,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import type { AdminUserView } from '@src/modules/account/account.types';
import {
  AccountService,
  type UserInfoUpdateData,
} from '@src/modules/account/base/services/account.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  normalizeAdminUserProfileUpdateInput,
  normalizeAdminUserTargetAccountId,
} from './admin-user-management.input.normalize';
import type {
  AdminUpdateUserProfileCommand,
  AdminUserProfileUpdateNormalizeOutput,
} from './admin-user-management.types';
import { assertAdminUserManagementPermission } from './admin-user-permission';
import { loadWritableAdminUserTarget, logAdminUserWriteFailure } from './admin-user-write-support';

/** 事务内的写入阶段标记，只用于服务端日志定位，不出现在任何对外响应中。 */
type AdminUpdateUserProfilePhase = 'LOCK_TARGET' | 'WRITE_PROFILE' | 'READ_BACK_VIEW';

/**
 * 管理员编辑普通用户资料用例（P0-4）。
 *
 * 执行顺序刻意固定：
 * 1. **第一步就是精确 SUPER_ADMIN 权限断言**（`assertAdminUserManagementPermission()`，
 *    全仓唯一实现），先于任何输入规范化与数据库访问；
 * 2. 场景输入规范化：目标账号 ID（正整数、只校验不修复）+ 资料字段（trim + NFKC + 长度上限）；
 * 3. Usecase 持有的单一事务内：锁定目标 → 读取收敛 View → 目标角色保护 → 更新资料 → 回读 View。
 *
 * `contactEmail` 四个成员。**不接收**登录名、登录邮箱、角色、账号状态与密码——
 * 命令类型在结构上就不含这些字段：角色只在管理员创建账号时写入，创建后只读；
 * 状态与密码分别由专用用例（`adminSetUserStatus` / `adminResetUserPassword`）处理，
 * 不存在宽泛的混合 update mutation。
 *
 * 空值语义（`AdminUserProfileUpdateNormalizeOutput`）：
 * - `undefined` = 未提供 → 不进入 patch，该列保持原值；
 * - 昵称 string = 修改；显式 `null`、空字符串与纯空白均拒绝；
 * - 其余三列 `null` = 明确清空 → 进入 patch，写 `NULL`；
 * - `string` = 收敛后的新值 → 进入 patch。
 *
 * 也不做任何唯一性预检查。
 *
 * 头像、签名、地址、标签、地理信息、用户状态等）与权限口径宽于本需求，且会写账号访问
 * 语义摘要（`identityHint`），管理员资料编辑不得经由它改写角色事实。
 *
 * 空差异处理：规范化后四个字段均为 `undefined` 时，在事务前明确以 `BAD_USER_INPUT`
 * 拒绝，不获取行锁、不执行 UPDATE，也不返回假成功。前端同时阻止未修改表单发起 Mutation。
 *
 * （`PROFILE_NOT_REFLECTED_AFTER_WRITE`），与角色 / 状态用例的后置校验同构。
 *
 * 依赖方向：事务边界由本用例经 `TransactionRunner` 持有，同一个 `transactionContext`
 * 显式传给全部下游；只调用 modules 细粒度方法与 QueryService，不访问 Repository、
 * 不接触 ORM API、不持有 ORM Entity。
 *
 * 数据库复核。即时失效由 `ValidateAccessTokenSessionUsecase`（P0-7）承担。
 */
@Injectable()
export class AdminUpdateUserProfileUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(AdminUpdateUserProfileUsecase.name);
  }

  async execute(command: AdminUpdateUserProfileCommand): Promise<AdminUserView> {
    assertAdminUserManagementPermission(command.session, '编辑资料');

    const accountId = normalizeAdminUserTargetAccountId(command.accountId);
    // 只接收四个白名单资料字段；昵称提供时允许重复，不做任何唯一性查询
    const profile = normalizeAdminUserProfileUpdateInput({
      nickname: command.nickname,
      companyName: command.companyName,
      phone: command.phone,
      contactEmail: command.contactEmail,
    });
    // R1-M3：逐字段判定后构造只含目标列的 patch，禁止把规范化输出直接展开；
    // updatedFields 与 patch 在同一构造点产出，记的是协议字段名（R7-7）
    const { patch, updatedFields } = this.buildProfilePatch(profile);
    if (updatedFields.length === 0) {
      throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '请至少提供一个需要更新的资料字段');
    }

    let view: AdminUserView;
    try {
      view = await this.transactionRunner.run((transactionContext) =>
        this.updateInTransaction({
          transactionContext,
          adminAccountId: command.session.accountId,
          accountId,
          patch,
        }),
      );
    } catch (error) {
      // 事务内各阶段的异常已由 updateInTransaction 的 catch 记录日志并收敛为 DomainError；
      // 走到这里的非 DomainError 只可能来自事务边界本身（BEGIN / COMMIT 失败都不经过
      // 内层 catch），统一收敛为 WRITE_FAILED。
      if (isDomainError(error)) {
        throw error;
      }
      logAdminUserWriteFailure({
        logger: this.logger,
        phase: 'TRANSACTION_BOUNDARY',
        error,
        summary: '管理员编辑用户资料',
      });
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '编辑用户资料失败，请稍后重试',
        undefined,
        error,
      );
    }

    // 成功日志在事务提交之后记录：commit 阶段仍可能失败，事务内记录会产生
    // 「日志已成功、调用方收到异常」的假成功。日志只含账号主键与被更新的字段名清单：
    // 不含昵称等字段值，保持与管理员创建同量的最小信息面。
    this.logger.info({ accountId: view.id, updatedFields }, '管理员编辑用户资料成功');
    return view;
  }

  /**
   *
   * 刻意逐字段判定 `undefined` 后构造，**禁止** `{ ...profile }` 直接展开传入
   * `AccountService.updateUserInfoFields()`：该方法的空 patch 守卫是
   * `Object.keys(patch).length === 0`，而 `Object.keys` 会计入值为 `undefined` 的键，
   * 直接展开会让「未提供」的字段以 `undefined` 进入 `repository.update()`，
   * 其是否进入 SET 子句完全依赖 TypeORM 的隐式跳过行为，违反
   * `docs/project-convention/input-field-design.md` 第 4 节「四类空值不得视为同义」。
   *
   * `contactEmail` 映射 `base_user_info.email`（联系邮箱），**不得**写入
   * `base_user_account.login_email`（登录凭据邮箱）。
   *
   * 若四个字段均为 `undefined`，本方法返回空 patch；execute 会在进入事务前明确拒绝，
   * 因此空对象与任何值为 `undefined` 的键都不会进入 `updateUserInfoFields()`。
   *
   * `Object.keys(patch)`：patch 的键是 ORM 实体的属性名（联系邮箱在这一侧叫 `email`），
   * （`contactEmail`）。两处三态判定只写一份，避免「patch 与日志字段清单各自判定」的第二次漂移。
   */
  private buildProfilePatch(profile: AdminUserProfileUpdateNormalizeOutput): {
    readonly patch: UserInfoUpdateData;
    readonly updatedFields: ReadonlyArray<string>;
  } {
    const patch: UserInfoUpdateData = {};
    const updatedFields: string[] = [];
    if (profile.nickname !== undefined) {
      patch.nickname = profile.nickname;
      updatedFields.push('nickname');
    }
    if (profile.companyName !== undefined) {
      patch.companyName = profile.companyName;
      updatedFields.push('companyName');
    }
    if (profile.phone !== undefined) {
      patch.phone = profile.phone;
      updatedFields.push('phone');
    }
    if (profile.contactEmail !== undefined) {
      // 列名是 email（联系邮箱），协议名仍是 contactEmail
      patch.email = profile.contactEmail;
      updatedFields.push('contactEmail');
    }
    return { patch, updatedFields };
  }

  /**
   *
   * 为什么需要：`AccountService.updateUserInfoFields()` 走 `repository.update({ accountId }, …)`，
   * **不检查受影响行数**——资料行不存在时会静默 0 行更新。本路径下该情形已被
   * `loadWritableAdminUserTarget()` 的前置失败关闭排除（资料行缺失 ⇒ `toAdminUserView()` 抛
   * `READ_FAILED`），因此本校验当前实际不可达；保留它是为了与角色 / 状态用例保持同一
   * 失败关闭口径，并使「静默无操作」在将来前置条件被放宽时仍然可见，而不是退化为
   * 「返回一份未变更的 View」。
   *
   * 字段只在进入 patch 时比对：`undefined` = 未提供 ⇒ 该列保持原值，无从校验；
   * nullable 三态字段的 `null` 与 View 的 `null` 比对，`string` 与 View 值比对。
   *
   * 逐字段显式比对，不用 `Object.entries(patch)` 遍历：patch 的键是实体属性名而 View 的键是
   * 协议字段名（联系邮箱在两侧不同名），遍历会把这层映射隐式化。
   */
  private assertProfileReflected(
    view: AdminUserView,
    patch: UserInfoUpdateData,
    accountId: number,
  ): void {
    const isReflected =
      (patch.nickname === undefined || view.nickname === patch.nickname) &&
      (patch.companyName === undefined || view.companyName === patch.companyName) &&
      (patch.phone === undefined || view.phone === patch.phone) &&
      (patch.email === undefined || view.contactEmail === patch.email);

    if (!isReflected) {
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '用户资料更新失败，请稍后重试',
        undefined,
        { diagnostic: 'PROFILE_NOT_REFLECTED_AFTER_WRITE', accountId },
      );
    }
  }

  /**
   * 事务内的原子资料更新：锁定、目标保护、写入与回读同成同败。
   *
   * 目标加载（含锁定、三源收敛失败关闭与 SUPER_ADMIN 只读保护）由
   * `loadWritableAdminUserTarget()` 单一实现承担，本方法不重复实现；其返回的锁内 View
   * 刻意不接收：本用例调用它的唯一目的是目标保护（锁定 + 角色断言），写后校验使用
   * 写入之后重新回读的 View。
   *
   * 写入复用 `AccountService.updateUserInfoFields()` 细粒度方法，
   * 该方法内部自带 `updatedAt` 维护，本用例不手工拼装时间列。
   */
  private async updateInTransaction(params: {
    transactionContext: PersistenceTransactionContext;
    adminAccountId: number;
    accountId: number;
    patch: UserInfoUpdateData;
  }): Promise<AdminUserView> {
    const { transactionContext, adminAccountId, accountId, patch } = params;
    let phase: AdminUpdateUserProfilePhase = 'LOCK_TARGET';

    try {
      await loadWritableAdminUserTarget({
        accountService: this.accountService,
        adminUserQueryService: this.adminUserQueryService,
        organizationContextQueryService: this.organizationContextQueryService,
        organizationMembershipQueryService: this.organizationMembershipQueryService,
        adminAccountId,
        accountId,
        actionLabel: '编辑资料',
        transactionContext,
      });

      phase = 'WRITE_PROFILE';
      await this.accountService.updateUserInfoFields({
        accountId,
        patch,
        transactionContext,
      });

      // 因此读到的是尚未提交的本次写入
      phase = 'READ_BACK_VIEW';
      const view = await this.adminUserQueryService.findAdminUserViewById({
        accountId,
        transactionContext,
      });
      if (view === null) {
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '用户资料更新后读取失败，请稍后重试',
          undefined,
          { diagnostic: 'UPDATED_PROFILE_NOT_READABLE', accountId },
        );
      }
      this.assertProfileReflected(view, patch, accountId);
      return view;
    } catch (error) {
      logAdminUserWriteFailure({
        logger: this.logger,
        phase,
        error,
        summary: '管理员编辑用户资料',
      });
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '用户资料更新失败，请稍后重试',
        undefined,
        error,
      );
    }
  }
}

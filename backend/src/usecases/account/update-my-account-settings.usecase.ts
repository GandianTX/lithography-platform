// src/usecases/account/update-my-account-settings.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import {
  ADMIN_USER_ERROR,
  DomainError,
  isDomainError,
  MY_ACCOUNT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import type {
  MyAccountSettingsSnapshot,
  MyAccountSettingsView,
} from '@src/modules/account/account.types';
import {
  AccountService,
  type UserInfoUpdateData,
} from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  normalizeMyAccountSettingsAccountId,
  normalizeMyAccountSettingsUpdateInput,
} from './my-account-settings.input.normalize';
import {
  resolveTrustedOrganizationId,
  toMyAccountSettingsView,
} from './my-account-settings.support';
import { logAdminUserWriteFailure } from './admin-user-write-support';
import type {
  MyAccountTrustedOrganizationFacts,
  UpdateMyAccountSettingsCommand,
  UpdateMyAccountSettingsNormalizeOutput,
  UpdateMyAccountSettingsOutcome,
} from './my-account-settings.types';

/** 事务内的写入阶段标记，只用于服务端日志定位，不出现在任何对外响应中。 */
type UpdateMyAccountSettingsPhase =
  | 'LOCK_TARGET'
  | 'CHECK_CREDENTIALS'
  | 'PRECHECK_CREDENTIAL_CONFLICT'
  | 'WRITE_CREDENTIALS'
  | 'WRITE_PROFILE'
  | 'READ_BACK_VIEW';

/** 预期业务拒绝码（双空凭据、凭据占用）：命中共享失败日志 helper 的 warn 分流。 */
const UPDATE_MY_ACCOUNT_SETTINGS_WARN_ERROR_CODES: ReadonlyArray<string> = [
  MY_ACCOUNT_ERROR.LOGIN_CREDENTIAL_BOTH_EMPTY,
  MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT,
];

/**
 * 受限会话（待审 / 已拒绝 / 资格未生效）获准维护的本人资料字段白名单。
 *
 * 受限会话的公司归属由注册申请与审核流程决定，登录凭据属于账号安全操作，
 * 均不得由受限会话自助改写；服务端以**显式许可字段**表达，而非按已知越界字段黑名单。
 */
const RESTRICTED_PROFILE_ALLOWED_FIELDS = ['nickname', 'phone', 'contactEmail'] as const;

/** 事务内结果：公开 Outcome 之外附带被更新的协议字段名清单（仅用于成功日志）。 */
interface UpdateMyAccountSettingsTxResult {
  readonly isUpdated: boolean;
  readonly updatedFields: ReadonlyArray<string>;
  readonly settings: MyAccountSettingsView;
}

/**
 * 当前用户账号设置更新用例（P2，契约见 `docs/api/account-write-current.md`）。
 *
 * 执行顺序刻意固定：
 * 1. 从 Session 取得当前 `accountId`（防御性前置校验，畸形即失败关闭）；
 * 2. 场景专用 normalize：保留省略 / 清空 / 设置三态；「至少保留一个登录凭据」**不在此判定**
 *    ——它必须基于 input 与数据库当前值的合并结果，只能由锁内事务裁决；
 * 3. Usecase 持有的单一事务内：锁定 account 行 → 读取纯当前值事实 → 合并 → 双空拒绝 →
 *    变化凭据的唯一性预检查 → 窄写入（同值不写）→ 事务内回读并校验 → 返回 `isUpdated` + View。
 *
 * 目标边界：目标账号**只能**来自已认证 Session，Command 在结构上不含 `accountId` /
 * 角色 / 状态 / 密码字段；本用例不写 `identity_hint`、`access_group`、
 * `meta_digest`、`account.status`、`user_info.user_state`，也不进入旧 `updateUserInfo`
 * 与管理员写链路。
 *
 * 并发与原子性：
 * - 同一账号的并发更新由 account 行锁（`lockMyAccountSettingsFacts()` 的
 *   `pessimistic_write`）串行化，两个请求分别清空一种凭据不会留下双空；
 * - 唯一性预检查只服务友好提示，并发竞争由数据库唯一索引最终裁决——窄写入
 *   `updateMyAccountCredentials()` 把唯一冲突收敛为事实对象，本用例转译为
 *   `MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT`（对外 `CONFLICT`）；
 * - 账号列与资料列在同一事务写入，任一步失败整体回滚。
 *
 * 依赖方向：事务边界由本用例经 `TransactionRunner` 持有，同一个 `transactionContext`
 * 显式传给全部下游；只调用 modules 细粒度方法与 QueryService，不访问 Repository、
 * 不接触 ORM API、不持有 ORM Entity。写后读复用 `findMyAccountSettingsSnapshot()`
 * （三源角色收敛 + 双状态一致性判定的单一失败关闭实现），本用例不重复实现。
 *
 * 不含 Session / Token 操作：本用例不签发、不撤销任何 Token，已签发 Access Token
 * 按当前契约自然过期。
 */
@Injectable()
export class UpdateMyAccountSettingsUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(UpdateMyAccountSettingsUsecase.name);
  }

  async execute(command: UpdateMyAccountSettingsCommand): Promise<UpdateMyAccountSettingsOutcome> {
    const accountId = normalizeMyAccountSettingsAccountId(command.session);
    // 受限会话的字段白名单先于任何输入收敛：越界字段直接 FORBIDDEN，不因字段值本身
    // 合法或非法而改变错误类别；混传时整体拒绝，事务不启动，因而零部分写入
    this.assertRestrictedProfileUpdateAllowed(command);
    const input = normalizeMyAccountSettingsUpdateInput({
      loginName: command.loginName,
      loginEmail: command.loginEmail,
      nickname: command.nickname,
      realName: command.realName,
      companyName: command.companyName,
      phone: command.phone,
      contactEmail: command.contactEmail,
    });

    let result: UpdateMyAccountSettingsTxResult;
    try {
      result = await this.transactionRunner.run((transactionContext) =>
        this.updateInTransaction({
          transactionContext,
          accountId,
          input,
          trustedOrganizations: command.trustedOrganizations,
        }),
      );
    } catch (error) {
      // 事务内各阶段的异常已由 updateInTransaction 的 catch 记录日志并收敛为 DomainError；
      // 走到这里的非 DomainError 只可能来自事务边界本身（BEGIN / COMMIT 失败都不经过
      // 内层 catch），统一收敛为 WRITE_FAILED
      if (isDomainError(error)) {
        throw error;
      }
      logAdminUserWriteFailure({
        logger: this.logger,
        phase: 'TRANSACTION_BOUNDARY',
        error,
        summary: '账号设置更新',
        accountId,
        warnErrorCodes: UPDATE_MY_ACCOUNT_SETTINGS_WARN_ERROR_CODES,
      });
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '账号设置更新失败，请稍后重试',
        undefined,
        error,
      );
    }

    // 成功日志在事务提交之后记录（同 admin 写用例的假成功规避），只含账号主键与
    // 被更新的协议字段名清单：不含任何字段值、密码或凭据派生物
    this.logger.info(
      { accountId, isUpdated: result.isUpdated, updatedFields: result.updatedFields },
      '账号设置更新成功',
    );
    return { isUpdated: result.isUpdated, settings: result.settings };
  }

  /**
   * 受限会话字段白名单：只允许 `nickname` / `phone` / `contactEmail`。
   *
   * - 依据**每次请求复核后**的限制状态（`ValidateAccessTokenSessionUsecase` 产出），
   *   不信任 Token 签发时的旧结论；
   * - 越界判定看「字段是否被提供」（`undefined` 才表示未提供），因此显式
   *   `companyName: null`、`loginName: null` 等清空语义同样被拒绝；
   * - 混传（合法昵称 + 越界公司）整体拒绝：抛错发生在事务之前，不存在部分写入；
   * - 错误类别沿用稳定的权限码 `PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS`
   *   （对外 `FORBIDDEN`），details 只记字段名，不含任何字段值。
   */
  private assertRestrictedProfileUpdateAllowed(command: UpdateMyAccountSettingsCommand): void {
    if (command.restriction === SessionRestriction.NONE) {
      return;
    }

    const allowedFields = new Set<string>(RESTRICTED_PROFILE_ALLOWED_FIELDS);
    const rejectedFields = (
      [
        'loginName',
        'loginEmail',
        'nickname',
        'realName',
        'companyName',
        'phone',
        'contactEmail',
      ] as const
    ).filter((field) => !allowedFields.has(field) && command[field] !== undefined);
    if (rejectedFields.length === 0) {
      return;
    }

    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '受限会话仅可维护昵称、电话与联系邮箱',
      undefined,
      {
        diagnostic: 'RESTRICTED_PROFILE_FIELDS_REJECTED',
        restriction: command.restriction,
        fields: rejectedFields,
      },
    );
  }

  /**
   * 事务内的原子设置更新：锁定 → 合并 → 双空拒绝 → 预检查 → 窄写入 → 回读校验。
   *
   * 合并与同值抑制的口径：
   * - 凭据：input 三态合并到当前值上（省略 = 保持当前值），合并后任一列与当前值不同才写
   *   （一次写两列），且仅对**发生变化且非空**的候选值做排除自身的唯一性预检查
   *   （清空为 `null` 不冲突，多个 NULL 可共存，无需检查）；
   * - 资料：仅 input 提供且与当前值不同的字段进入 patch（`undefined` = 未提供 ≠ `null` =
   *   清空，二者不得合并）；patch 不含 `userState`——资料更新不触碰状态字段；
   * - 全部字段同值或未提供时不执行任何写入，返回 `isUpdated: false` 与当前 View
   *   （「同值提交不落库并返回 isUpdated: false」，与 admin 资料更新的
   *   「空 patch 拒绝」口径刻意不同）。
   */
  private async updateInTransaction(params: {
    transactionContext: PersistenceTransactionContext;
    accountId: number;
    input: UpdateMyAccountSettingsNormalizeOutput;
    trustedOrganizations: MyAccountTrustedOrganizationFacts;
  }): Promise<UpdateMyAccountSettingsTxResult> {
    const { transactionContext, accountId, input, trustedOrganizations } = params;
    let phase: UpdateMyAccountSettingsPhase = 'LOCK_TARGET';
    const updatedFields: string[] = [];

    try {
      const facts = await this.accountService.lockMyAccountSettingsFacts({
        accountId,
        transactionContext,
      });
      if (!facts) {
        // Session 引用的账号行在库中不存在，属数据不变量被破坏，失败关闭为
        // INTERNAL_SERVER_ERROR（不得塌缩为 UNAUTHENTICATED）
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '账号设置读取失败，请稍后重试',
          undefined,
          { diagnostic: 'ACCOUNT_ROW_MISSING', accountId },
        );
      }

      phase = 'CHECK_CREDENTIALS';
      const mergedLoginName = input.loginName === undefined ? facts.loginName : input.loginName;
      const mergedLoginEmail = input.loginEmail === undefined ? facts.loginEmail : input.loginEmail;
      if (mergedLoginName === null && mergedLoginEmail === null) {
        // 合并后双空：至少保留一个登录方式的组合约束在此裁决（锁内合并之后）。
        // 该分支同时覆盖历史遗留的「两列均为 NULL」异常账号（现有登录链路要求至少
        // 一个凭据，该状态不应存在）：即使本次提交只改资料、未触碰凭据字段，合并
        // 结果仍双空即拒绝（失败关闭），不自动修复、不代填任一列；错误文案引导
        // 用户补填一个登录凭据。details 留空；账号主键经失败日志记录，不进对外响应
        throw new DomainError(
          MY_ACCOUNT_ERROR.LOGIN_CREDENTIAL_BOTH_EMPTY,
          '登录名与登录邮箱至少需要保留一个',
          undefined,
          { diagnostic: 'LOGIN_CREDENTIAL_BOTH_EMPTY', accountId },
        );
      }
      const isLoginNameChanged = mergedLoginName !== facts.loginName;
      const isLoginEmailChanged = mergedLoginEmail !== facts.loginEmail;
      const isCredentialChanged = isLoginNameChanged || isLoginEmailChanged;

      phase = 'PRECHECK_CREDENTIAL_CONFLICT';
      if (isCredentialChanged) {
        const conflictField = await this.accountQueryService.findMyAccountCredentialConflictField({
          accountId,
          loginName: isLoginNameChanged && mergedLoginName !== null ? mergedLoginName : undefined,
          loginEmail:
            isLoginEmailChanged && mergedLoginEmail !== null ? mergedLoginEmail : undefined,
          transactionContext,
        });
        if (conflictField !== null) {
          throw new DomainError(
            MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT,
            conflictField === 'loginName'
              ? '登录名已被占用，请更换后重试'
              : '登录邮箱已被占用，请更换后重试',
            undefined,
            { diagnostic: 'CREDENTIAL_PRECHECK_CONFLICT', field: conflictField, accountId },
          );
        }
      }

      phase = 'WRITE_CREDENTIALS';
      if (isCredentialChanged) {
        const writeOutcome = await this.accountService.updateMyAccountCredentials({
          accountId,
          loginName: mergedLoginName,
          loginEmail: mergedLoginEmail,
          transactionContext,
        });
        if (writeOutcome.kind === 'CREDENTIAL_CONFLICT') {
          // 并发竞争：预检查已通过但唯一索引最终裁决冲突。唯一索引无法可靠告知
          // 具体列（此时只能返回通用凭据冲突），不暴露驱动错误与索引名
          throw new DomainError(
            MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT,
            '登录名或登录邮箱已被占用，请稍后重试',
            undefined,
            { diagnostic: 'CREDENTIAL_UNIQUE_INDEX_CONFLICT', accountId },
          );
        }
        if (isLoginNameChanged) {
          updatedFields.push('loginName');
        }
        if (isLoginEmailChanged) {
          updatedFields.push('loginEmail');
        }
      }

      phase = 'WRITE_PROFILE';
      const { patch, profileUpdatedFields } = this.buildProfilePatch(input, facts);
      if (profileUpdatedFields.length > 0) {
        await this.accountService.updateUserInfoFields({
          accountId,
          patch,
          transactionContext,
        });
        updatedFields.push(...profileUpdatedFields);
      }

      phase = 'READ_BACK_VIEW';
      const snapshot: MyAccountSettingsSnapshot | null =
        await this.accountQueryService.findMyAccountSettingsSnapshot({
          accountId,
          transactionContext,
        });
      if (!snapshot) {
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '账号设置更新后读取失败，请稍后重试',
          undefined,
          { diagnostic: 'UPDATED_SETTINGS_NOT_READABLE', accountId },
        );
      }
      this.assertSettingsReflected({ snapshot, input, facts, accountId });
      // 可信公司名称与写入同事务读取：组织 ID 按回读快照的角色解析；id 或名称缺失一律 null，
      // 不回退 companyName（二者来源不同，回退会把用户自填公司名伪造成可信事实）
      const organizationId = resolveTrustedOrganizationId(snapshot.role, trustedOrganizations);
      const trustedCompanyName =
        organizationId === null
          ? null
          : await this.organizationQueryService.findOrganizationNameById({
              organizationId,
              transactionContext,
            });
      return {
        isUpdated: updatedFields.length > 0,
        updatedFields,
        settings: toMyAccountSettingsView(snapshot, trustedCompanyName),
      };
    } catch (error) {
      logAdminUserWriteFailure({
        logger: this.logger,
        phase,
        error,
        summary: '账号设置更新',
        accountId,
        warnErrorCodes: UPDATE_MY_ACCOUNT_SETTINGS_WARN_ERROR_CODES,
      });
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '账号设置更新失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 逐字段判定 `undefined` 后构造只含**发生变化**列的资料 patch，**禁止**把规范化输出
   * 直接展开传入 `AccountService.updateUserInfoFields()`：该方法的空 patch 守卫是
   * `Object.keys(patch).length === 0`，而 `Object.keys` 会计入值为 `undefined` 的键，
   * 直接展开会让「未提供」的字段以 `undefined` 进入 `repository.update()`，其是否进入
   * SET 子句完全依赖 TypeORM 的隐式跳过行为，违反「四类空值不得视为同义」。
   *
   * 同值抑制（「同值不写」）：提供值与当前值相同的字段不进入 patch，
   * 使「只回传未变更资料的提交」不产生无意义写入与 `updated_at` 抖动。
   *
   * `contactEmail` 映射 `base_user_info.email`（联系邮箱），**不得**写入
   * `base_user_account.login_email`（登录凭据邮箱）；patch 类型刻意不写 `userState`。
   * updatedFields 记协议字段名（联系邮箱在 patch 侧叫 `email`，协议侧仍叫 `contactEmail`）。
   */
  private buildProfilePatch(
    input: UpdateMyAccountSettingsNormalizeOutput,
    facts: {
      readonly nickname: string;
      readonly realName: string | null;
      readonly companyName: string | null;
      readonly phone: string | null;
      readonly contactEmail: string | null;
    },
  ): {
    readonly patch: UserInfoUpdateData;
    readonly profileUpdatedFields: ReadonlyArray<string>;
  } {
    const patch: UserInfoUpdateData = {};
    const fields: string[] = [];
    if (input.nickname !== undefined && input.nickname !== facts.nickname) {
      patch.nickname = input.nickname;
      fields.push('nickname');
    }
    if (input.realName !== undefined && input.realName !== facts.realName) {
      patch.realName = input.realName;
      fields.push('realName');
    }
    if (input.companyName !== undefined && input.companyName !== facts.companyName) {
      patch.companyName = input.companyName;
      fields.push('companyName');
    }
    if (input.phone !== undefined && input.phone !== facts.phone) {
      patch.phone = input.phone;
      fields.push('phone');
    }
    if (input.contactEmail !== undefined && input.contactEmail !== facts.contactEmail) {
      // 列名是 email（联系邮箱），协议名仍是 contactEmail
      patch.email = input.contactEmail;
      fields.push('contactEmail');
    }
    return { patch, profileUpdatedFields: fields };
  }

  /**
   * 写后校验：回读快照必须逐字段等于「合并后的期望状态」——发生变化的列证明写入已生效，
   * 未提供 / 同值的列证明没有意外改写（与 admin 资料更新的 `assertProfileReflected()`
   * 同构的失败关闭口径；`updateUserInfoFields()` 与凭据窄写入都不检查受影响行数，
   * 静默 0 行更新在该口径下不可见）。
   *
   * 刻意逐字段显式比对（含未变更列）：本事务 REPEATABLE READ 快照内，未变更列必然等于
   * 锁内事实；不等说明不变量被破坏（如并发路径绕过行锁写资料行），失败关闭优于静默返回。
   */
  private assertSettingsReflected(args: {
    readonly snapshot: MyAccountSettingsSnapshot;
    readonly input: UpdateMyAccountSettingsNormalizeOutput;
    readonly facts: {
      readonly loginName: string | null;
      readonly loginEmail: string | null;
      readonly nickname: string;
      readonly realName: string | null;
      readonly companyName: string | null;
      readonly phone: string | null;
      readonly contactEmail: string | null;
    };
    readonly accountId: number;
  }): void {
    const { snapshot, input, facts, accountId } = args;
    const expectedLoginName = input.loginName === undefined ? facts.loginName : input.loginName;
    const expectedLoginEmail = input.loginEmail === undefined ? facts.loginEmail : input.loginEmail;
    const expectedNickname = input.nickname === undefined ? facts.nickname : input.nickname;
    const expectedRealName = input.realName === undefined ? facts.realName : input.realName;
    const expectedCompanyName =
      input.companyName === undefined ? facts.companyName : input.companyName;
    const expectedPhone = input.phone === undefined ? facts.phone : input.phone;
    const expectedContactEmail =
      input.contactEmail === undefined ? facts.contactEmail : input.contactEmail;

    const isReflected =
      snapshot.loginName === expectedLoginName &&
      snapshot.loginEmail === expectedLoginEmail &&
      snapshot.nickname === expectedNickname &&
      snapshot.realName === expectedRealName &&
      snapshot.companyName === expectedCompanyName &&
      snapshot.phone === expectedPhone &&
      snapshot.contactEmail === expectedContactEmail;

    if (!isReflected) {
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '账号设置更新失败，请稍后重试',
        undefined,
        { diagnostic: 'SETTINGS_NOT_REFLECTED_AFTER_WRITE', accountId },
      );
    }
  }
}

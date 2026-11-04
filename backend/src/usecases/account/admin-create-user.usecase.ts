// src/usecases/account/admin-create-user.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { ADMIN_USER_ERROR, DomainError, isDomainError } from '@core/common/errors/domain-error';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { Inject, Injectable } from '@nestjs/common';
import type { AdminUserView, AdminUserWritableRole } from '@src/modules/account/account.types';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  normalizeAdminUserCredentialInput,
  normalizeAdminUserPasswordInput,
  normalizeAdminUserProfileInput,
  normalizeAdminUserWritableRole,
} from './admin-user-management.input.normalize';
import type {
  AdminCreateUserCommand,
  AdminUserCredentialNormalizeOutput,
  AdminUserProfileNormalizeOutput,
} from './admin-user-management.types';
import { assertAdminUserManagementPermission } from './admin-user-permission';
import {
  assertAdminUserPasswordPolicy,
  errorMessage,
  extractDriverErrorCode,
} from './admin-user-write-support';

/**
 * 账号插入时的占位密码。
 *
 * 密码哈希以 `base_user_account.created_at` 的 UTC ISO 表示作为时间盐
 * （`AccountService.hashPasswordWithTimestamp()`），因此必须先落库拿到**数据库权威**的
 * `createdAt`，再回写真实哈希——这与 `CreateAccountUsecase` / `RegisterWithEmailUsecase`
 * 同源。占位值只在同一事务内存在，事务提交前必被 `updateAccountPasswordHash()` 覆盖；
 * 任一步失败整个事务回滚，不会留下可用占位口令登录的账号。
 */
const PLACEHOLDER_LOGIN_PASSWORD = 'temp';

/** 事务内的写入阶段标记，只用于服务端日志定位，不出现在任何对外响应中。 */
type AdminCreateUserPhase =
  | 'RESOLVE_ORGANIZATION'
  | 'INSERT_ACCOUNT'
  | 'UPDATE_PASSWORD_HASH'
  | 'SAVE_USER_INFO'
  | 'BIND_ORGANIZATION'
  | 'READ_BACK_VIEW'
  | 'TRANSACTION_BOUNDARY';

/**
 * 管理员创建普通用户用例（P0-3）。
 *
 * 执行顺序刻意固定：
 * 1. **第一步就是精确 SUPER_ADMIN 权限断言**（`assertAdminUserManagementPermission()`，
 *    全仓唯一实现，同时校验 `roles` 含 SUPER_ADMIN 且 `activeRole` 精确等于 SUPER_ADMIN，
 *    缺失或矛盾即失败关闭为 `FORBIDDEN`），先于任何输入规范化与数据库访问；
 * 2. 场景输入规范化（凭据至少一个、初始密码非空断言、单值可写角色、资料字段）；
 * 3. 初始密码策略校验；
 * 4. 登录凭据唯一性预检查；
 * 5. Usecase 持有的单一事务内完成账号 + 密码哈希 + 资料写入 + 组织绑定
 *    （ENGINEER 与 CUSTOMER 均绑定管理员当前有效组织），并回读稳定 View。
 *
 * 第 3 步排在第 4 步之前是刻意的：输入错误（`BAD_USER_INPUT`）应先于占用冲突（`CONFLICT`）
 * 表达，否则一个连合法密码都未提交的调用者也能借响应差异探测登录名/登录邮箱是否已存在。
 *
 * 依赖方向（`usecase.rules.md` / `usecase-write-flow-boundaries.rules.md`）：
 * - 事务边界由本用例通过 `TransactionRunner` 持有，并把同一个 `transactionContext`
 *   显式传给全部下游参与方（`AccountService` 写方法 + `AdminUserQueryService` 事务内只读）；
 * - 只调用 modules 的细粒度 service 方法与 QueryService，**不访问 Repository、不接触 ORM API**；
 * - 不持有 ORM Entity：账号插入结果由 `AccountService.insertAccount()` 以
 *   `AccountCreateOutcome` 事实对象返回，创建成功后的对外结果是稳定 `AdminUserView`。
 *
 * 该用例内部走 `AccountService.saveAccount()`，既不识别唯一索引冲突（会把 `ER_DUP_ENTRY`
 * 原样上抛，违反 P0-3 第 7 项），又返回 `UserAccountView` 而非管理员 View；而 R1-C3 明确
 * 不得改动注册链路依赖的既有口径。因此本用例沿用 `RegisterWithEmailUsecase` 的既有
 * precedent——由 Usecase 直接编排 `AccountService` 的细粒度方法，并复用**同一份**
 * `PasswordPolicyService`、`hashPasswordWithTimestamp()` 与 `createUserInfoEntity()` 路径，
 * 密码策略与哈希算法没有任何第二套实现。
 *
 * A-PR0 §4.3 + 组织数据增量（组织绑定）：创建 ENGINEER 或 CUSTOMER 时在同一事务内绑定
 * **管理员当前有效组织**（`TrustedOrganizationContextQueryService` 可信解析，绝不取客户端
 * 自报）。组织解析先于任何写入 fail-fast（管理员无有效组织时账号零落库）；
 * 绑定写入失败与其它阶段同口径整体回滚，不留半成品账号；不改密码、角色编辑与 Session 规则。
 *
 * 本用例职责不含资料编辑、状态修改与密码重置；也不创建 SUPER_ADMIN；
 * 普通用户角色只在创建时单选一次，创建后角色只读。
 *
 * 不含数据库复核。已停用或已降级的账号在旧 Access Token 到期前仍可能通过该断言，
 * 即时失效由 `ValidateAccessTokenSessionUsecase`（P0-7）承担。
 */
@Injectable()
export class AdminCreateUserUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipService: OrganizationMembershipService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(AdminCreateUserUsecase.name);
  }

  async execute(command: AdminCreateUserCommand): Promise<AdminUserView> {
    assertAdminUserManagementPermission(command.session, '创建');

    // 登录名与登录邮箱至少一个，两者均可为 null；组合约束由 normalize 层裁决
    const credential = normalizeAdminUserCredentialInput({
      loginName: command.loginName,
      loginEmail: command.loginEmail,
    });
    // 只断言「非空字符串」，刻意不 trim：trim 会静默改写秘密，并掩盖策略层
    const initialPassword = normalizeAdminUserPasswordInput(command.loginPassword, '初始密码');
    // 单值可写角色：SUPER_ADMIN、空值与非字符串（含数组形式的多角色）在此即被拒绝
    const role = normalizeAdminUserWritableRole(command.role);
    // 昵称必填、trim + NFKC + 长度上限，**允许重复**，不做任何唯一性查询
    const profile = normalizeAdminUserProfileInput({
      nickname: command.nickname,
      companyName: command.companyName,
      phone: command.phone,
      contactEmail: command.contactEmail,
    });

    // 密码策略校验与管理员重置密码共用同一实现（P0-6 起抽到
    assertAdminUserPasswordPolicy({
      passwordPolicyService: this.passwordPolicyService,
      password: initialPassword,
      fieldName: '初始密码',
    });

    // 预检查只为友好提示，**不是**并发保护：数据库唯一索引 `uk_login_name` / `uk_login_email`
    const conflictField =
      await this.adminUserQueryService.findAdminUserCredentialConflict(credential);
    if (conflictField !== null) {
      throw new DomainError(
        ADMIN_USER_ERROR.CREDENTIAL_CONFLICT,
        conflictField === 'loginName'
          ? '该登录名已被占用，请更换后重试'
          : '该登录邮箱已被占用，请更换后重试',
      );
    }

    let view: AdminUserView;
    try {
      view = await this.transactionRunner.run((transactionContext) =>
        this.createInTransaction({
          transactionContext,
          adminAccountId: command.session.accountId,
          credential,
          initialPassword,
          role,
          profile,
        }),
      );
    } catch (error) {
      // 事务内各阶段的异常已由 createInTransaction 的 catch 记录日志并收敛为 DomainError；
      // 走到这里的非 DomainError 只可能来自**事务边界本身**：`manager.transaction()` 的
      // BEGIN（如连接池耗尽）与 COMMIT（callback 返回后提交）失败都不经过内层 catch，
      // 统一收敛为 WRITE_FAILED（P0-3 第 13 项「数据库故障」口径）。
      if (isDomainError(error)) {
        throw error;
      }
      this.logCreateFailure('TRANSACTION_BOUNDARY', error);
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '创建用户失败，请稍后重试',
        undefined,
        error,
      );
    }

    // 事务内记录会产生「日志已成功、调用方收到异常」的假成功。
    this.logger.info({ accountId: view.id, role: view.role }, '管理员创建普通用户成功');
    return view;
  }

  /**
   * 事务内的原子创建：账号行、密码哈希、资料行与组织绑定同成同败，
   * 并在同一事务内回读稳定 View。
   *
   * 组织绑定（A-PR0 §4.3 + 组织数据增量）：创建 ENGINEER 或 CUSTOMER 时，
   * 把新账号绑定到管理员当前有效组织，成员角色与写入角色一致。
   * 解析先于任何写入——管理员自身无有效组织时 fail-fast，不给「先建账号又回滚」
   * 留下无谓的并发窗口；绑定仅使用可信解析出的 organizationId，不接受客户端自报。
   *
   * `access_group` = 单元素数组、`meta_digest` = 同一个单元素数组，
   * 且 `status` 与 `user_state` 同为 `ACTIVE`——因此新建账号必然能通过
   * `convergeAccountRole()`，不会立刻成为让管理员列表整次失败关闭的异常行。
   *
   * `meta_digest` 由 `FieldEncryptionSubscriber.beforeInsert` 自动加密，本用例只传数组明文，
   * 不做任何手工加密或 `JSON.stringify`。
   */
  private async createInTransaction(params: {
    transactionContext: PersistenceTransactionContext;
    adminAccountId: number;
    credential: AdminUserCredentialNormalizeOutput;
    initialPassword: string;
    role: AdminUserWritableRole;
    profile: AdminUserProfileNormalizeOutput;
  }): Promise<AdminUserView> {
    const { transactionContext, adminAccountId, credential, initialPassword, role, profile } =
      params;
    let phase: AdminCreateUserPhase = 'RESOLVE_ORGANIZATION';

    try {
      // 组织数据增量：ENGINEER 与 CUSTOMER 均绑定管理员当前有效组织，
      // 成员角色与写入角色精确一致；其他角色仍不自动加入。
      let bindOrganizationId: number | null = null;
      const bindMemberRole =
        role === IdentityTypeEnum.ENGINEER || role === IdentityTypeEnum.CUSTOMER ? role : null;
      if (bindMemberRole !== null) {
        const organizationFact = await this.organizationContextQueryService.resolveForAccount({
          accountId: adminAccountId,
          transactionContext,
        });
        bindOrganizationId = organizationFact.organizationId;
      }

      phase = 'INSERT_ACCOUNT';
      const outcome = await this.accountService.insertAccount({
        transactionContext,
        accountData: {
          loginName: credential.loginName,
          loginEmail: credential.loginEmail,
          loginPassword: PLACEHOLDER_LOGIN_PASSWORD,
          status: AccountStatus.ACTIVE,
          identityHint: role,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // 预检查通过后仍可能命中唯一索引：这是预期的并发竞争结果，不是缺陷。
      // 文案不再区分维度——并发窗口内无法保证「哪一维被谁占用」仍然成立，
      // 且区分维度等于向调用方确认另一个账号的存在。
      if (outcome.kind === 'CREDENTIAL_CONFLICT') {
        throw new DomainError(
          ADMIN_USER_ERROR.CREDENTIAL_CONFLICT,
          '该登录名或登录邮箱已被占用，请更换后重试',
        );
      }

      phase = 'UPDATE_PASSWORD_HASH';
      await this.accountService.updateAccountPasswordHash({
        accountId: outcome.accountId,
        passwordHash: AccountService.hashPasswordWithTimestamp(initialPassword, outcome.createdAt),
        transactionContext,
      });

      phase = 'SAVE_USER_INFO';
      // 经 insertUserInfo() 一次完成 create + save：`UserInfoEntity` 不出 AccountService，
      await this.accountService.insertUserInfo({
        transactionContext,
        userInfoData: {
          accountId: outcome.accountId,
          nickname: profile.nickname,
          // 创建场景把「未提供」与「明确清空」同样处理为不写入该列（列本身 nullable）
          companyName: profile.companyName ?? null,
          phone: profile.phone ?? null,
          // 联系邮箱写入 `base_user_info.email`，**不得**写进 `base_user_account.login_email`
          email: profile.contactEmail ?? null,
          accessGroup: [role],
          metaDigest: [role],
          userState: UserState.ACTIVE,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // 绑定写入引用同一事务内刚创建的账号：外键在提交前即成立，任一步失败整体回滚
      if (bindOrganizationId !== null && bindMemberRole !== null) {
        phase = 'BIND_ORGANIZATION';
        await this.organizationMembershipService.insertMembership(
          {
            organizationId: bindOrganizationId,
            accountId: outcome.accountId,
            memberRole: bindMemberRole,
          },
          transactionContext,
        );
      }

      // 该读取使用同一个 transactionContext，因此读到的是尚未提交的本次写入
      phase = 'READ_BACK_VIEW';
      const view = await this.adminUserQueryService.findAdminUserViewById({
        accountId: outcome.accountId,
        transactionContext,
      });
      if (view === null) {
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '用户账号创建后读取失败，请稍后重试',
          undefined,
          { diagnostic: 'CREATED_ACCOUNT_NOT_READABLE', accountId: outcome.accountId },
        );
      }

      // 会产生「日志已成功、调用方收到异常」的假成功。提交成功后由 execute() 记录，
      // 同样只含账号主键与角色：不含登录名、登录邮箱、昵称、密码或任何凭据派生物。
      return view;
    } catch (error) {
      this.logCreateFailure(phase, error);
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '用户账号创建失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   *
   * TypeORM 1.0 的 `QueryFailedError` 以 `super(driverError.toString())` 构造，因此 `message` 是
   * **驱动错误文本**（形如 `ER_DUP_ENTRY: Duplicate entry 'x' for key 'uk_login_name'`），
   * **不携带 SQL 文本**；SQL 在 `error.query`、绑定参数在 `error.parameters`，两者当前都不入日志。
   * 而 `UPDATE_PASSWORD_HASH` 阶段的 `error.parameters` 里嵌着密码派生哈希，把它写进日志等于让
   * 可离线爆破的凭据派生物长期留存在日志系统。因此该阶段仍只记录阶段名、异常类型与驱动
   * 错误码（**纵深防御**：即使将来把 `query` / `parameters` 加进日志，或驱动文本形态变化，
   * 该阶段也不会经本方法泄露）；其余阶段的语句不含任何密码派生物，记录 `message` 以便定位。
   *
   * 领域异常记录错误码、阶段名与（由本用例或下游自己构造的）纯对象 `diagnostic`：`cause`
   * 为 `Error` 实例时丢弃 `message`，只保留异常类型名与**驱动错误码**（MySQL `errno` /
   * `'ER_*'`，如 `1062` / `'ER_DUP_ENTRY'`）。错误码不含敏感数据，却足以区分「唯一索引冲突」
   * 「连接中断」「死锁」等故障类别，避免 `insertAccount()` 重包的 `WRITE_FAILED` 在日志里
   * 退化为「只知道写失败、不知道为什么」。唯一索引冲突属预期业务结果，记 `warn` 而非 `error`。
   */
  private logCreateFailure(phase: AdminCreateUserPhase, error: unknown): void {
    if (!isDomainError(error)) {
      const errorName = error instanceof Error ? error.name : 'UNKNOWN';
      // 只有 UPDATE_PASSWORD_HASH 阶段的写入参数（`error.parameters`，当前不入日志）嵌着
      // 密码派生哈希，该阶段仍一律抑制 message 作为纵深防御；其余阶段照常记录 message
      const message = phase === 'UPDATE_PASSWORD_HASH' ? undefined : errorMessage(error);
      this.logger.error(
        {
          reason: 'UNEXPECTED',
          phase,
          errorName,
          driverCode: extractDriverErrorCode(error),
          message,
        },
        '管理员创建普通用户失败（非领域异常，已收敛为 WRITE_FAILED 上抛）',
      );
      return;
    }

    if (error.code === ADMIN_USER_ERROR.CREDENTIAL_CONFLICT) {
      this.logger.warn({ phase }, '管理员创建普通用户时登录凭据已被占用，已按 CONFLICT 返回');
      return;
    }

    const cause = error.cause;
    const diagnostic = cause instanceof Error || cause === undefined ? undefined : cause;
    this.logger.error(
      {
        errorCode: error.code,
        phase,
        diagnostic,
        causeErrorName: cause instanceof Error ? cause.name : undefined,
        driverCode: cause instanceof Error ? extractDriverErrorCode(cause) : undefined,
      },
      '管理员创建普通用户失败',
    );
  }
}

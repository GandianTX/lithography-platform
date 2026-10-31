// test/support/account/admin-user.fixture.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import type { AdminUserStatusFacts, AdminUserView } from '@src/modules/account/account.types';
import type { OrganizationMembershipFact } from '@src/modules/lithography/organization.types';
import type { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';

/**
 * 管理员用户管理写用例的共享测试 fixture。
 *
 * 为什么放在 `test/support/`：`src` 下的 spec 引用共享 fixture 的既有先例是
 * `test/support/capability/capability-state-reader.fixture.ts`；放进 `src/` 会被
 * `tsconfig.build.json` 之外的产物扫描与架构规则当成生产代码对待。
 *
 * 只承载「形状」，不承载断言：账号 ID、会话角色组合、稳定 View 与状态事实的构造，
 * 以及一个忠实的事务替身。事务提交/回滚的真实语义由 `TransactionRunner` 在生产侧承担，
 * 这里的替身只做「回调正常返回即提交、回调抛错即回滚并上抛」，从而让单元层能证明
 * 「任一写入失败 ⇒ 事务回滚 ⇒ 所有字段都不落库」。
 *
 * 既有 `src/usecases/account/admin-set-user-status.usecase.spec.ts` 的 P1 分组自带同形
 * fixture，为不重写已验证通过的既有改动而原样保留，不回改。
 */

/** 管理员自己的账号 ID：用于「不能停用自己」与「管理员目标是只读 SUPER_ADMIN」两类用例 */
export const ADMIN_ACCOUNT_ID = 1;

/** 被管理的普通用户账号 ID */
export const TARGET_ACCOUNT_ID = 2;

/** 管理员所在的可信组织主键（测试用固定值，不参与任何断言比较） */
export const ADMIN_ORGANIZATION_ID = 100;

/**
 * 管理员可信组织成员事实的构造器。
 * 缺省表示「管理员与目标同属一个有效组织」，即组织隔离校验通过的正常前置。
 */
export const createAdminOrganizationFact = (
  overrides: Partial<OrganizationMembershipFact> = {},
): OrganizationMembershipFact => ({
  membershipId: 1,
  organizationId: ADMIN_ORGANIZATION_ID,
  organizationCode: 'E2E_TEST_PRIMARY',
  organizationName: '测试组织',
  organizationKind: 'CLIENT',
  memberRole: 'SUPER_ADMIN',
  ...overrides,
});

/**
 * 组织隔离相关的两个下游替身。
 *
 * 缺省全部「成功」：管理员有单一可信组织、目标在该组织内有有效成员关系、组织内账号
 * 清单包含管理员与目标。组织隔离的**拒绝**分支由各用例按需覆盖（mockResolvedValue(null)
 * / mockRejectedValue(...)），不在缺省值里预置失败，避免既有用例被连带改红。
 */
export const createOrganizationIsolationMocks = (): {
  readonly organizationContextQueryService: TrustedOrganizationContextQueryService;
  readonly organizationMembershipQueryService: OrganizationMembershipQueryService;
  readonly resolveForAccount: jest.Mock;
  readonly listActiveAccountIdsByOrganization: jest.Mock;
  readonly findActiveMembership: jest.Mock;
} => {
  const resolveForAccount = jest.fn().mockResolvedValue(createAdminOrganizationFact());
  const listActiveAccountIdsByOrganization = jest
    .fn()
    .mockResolvedValue([ADMIN_ACCOUNT_ID, TARGET_ACCOUNT_ID]);
  const findActiveMembership = jest.fn().mockResolvedValue(createAdminOrganizationFact());

  return {
    organizationContextQueryService: {
      resolveForAccount,
    } as unknown as TrustedOrganizationContextQueryService,
    organizationMembershipQueryService: {
      listActiveAccountIdsByOrganization,
      findActiveMembership,
    } as unknown as OrganizationMembershipQueryService,
    resolveForAccount,
    listActiveAccountIdsByOrganization,
    findActiveMembership,
  };
};

/**
 * 精确 SUPER_ADMIN 会话：`roles` 含 SUPER_ADMIN **且** `activeRole` 精确等于 SUPER_ADMIN。
 * `assertAdminUserManagementPermission()` 要求两个条件同时成立，缺一即失败关闭。
 */
export const createSuperAdminSession = (
  overrides: Partial<UsecaseSession> = {},
): UsecaseSession => ({
  accountId: ADMIN_ACCOUNT_ID,
  roles: [IdentityTypeEnum.SUPER_ADMIN],
  activeRole: IdentityTypeEnum.SUPER_ADMIN,
  ...overrides,
});

/**
 * 无管理员权限的会话组合：两个纯普通角色，以及两类「半管理员」矛盾会话。
 *
 * 后两类是精确授权的关键边界——只校验 `roles` 会放行 activeRole 已切换为普通身份的
 * 管理员，只校验 `activeRole` 会放行 roles 里根本没有 SUPER_ADMIN 的伪造会话。
 *
 * 返回可变数组而非 `ReadonlyArray`：`it.each()` 的类型签名不接受 readonly 元组数组，
 * 用 ReadonlyArray 会让回调形参退化为 `any[]` 并触发 TS2345。
 */
export const createUnauthorizedSessions = (): Array<[string, UsecaseSession]> => [
  [
    'CUSTOMER 会话',
    {
      accountId: TARGET_ACCOUNT_ID,
      roles: [IdentityTypeEnum.CUSTOMER],
      activeRole: IdentityTypeEnum.CUSTOMER,
    },
  ],
  [
    'ENGINEER 会话',
    {
      accountId: TARGET_ACCOUNT_ID,
      roles: [IdentityTypeEnum.ENGINEER],
      activeRole: IdentityTypeEnum.ENGINEER,
    },
  ],
  [
    'roles 含 SUPER_ADMIN 但 activeRole 为 ENGINEER',
    {
      accountId: ADMIN_ACCOUNT_ID,
      roles: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
      activeRole: IdentityTypeEnum.ENGINEER,
    },
  ],
  [
    'activeRole 为 SUPER_ADMIN 但 roles 不含 SUPER_ADMIN（矛盾会话）',
    {
      accountId: ADMIN_ACCOUNT_ID,
      roles: [IdentityTypeEnum.ENGINEER],
      activeRole: IdentityTypeEnum.SUPER_ADMIN,
    },
  ],
];

/**
 * 稳定读模型 `AdminUserView` 的构造器。缺省是一个可写的 CUSTOMER、当前 ACTIVE 的目标。
 * 该 View 刻意不含 `userState` / `metaDigest` / 任何密码派生物，与生产契约一致。
 */
export const createAdminUserView = (overrides: Partial<AdminUserView> = {}): AdminUserView => ({
  id: TARGET_ACCOUNT_ID,
  loginName: 'target_user',
  loginEmail: 'target@example.com',
  nickname: 'target_nickname',
  companyName: null,
  phone: null,
  contactEmail: null,
  role: IdentityTypeEnum.CUSTOMER,
  status: AccountStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/** 只读的 SUPER_ADMIN 目标：用于「管理员账号一律只读」的目标保护用例 */
export const createSuperAdminTargetView = (overrides: Partial<AdminUserView> = {}): AdminUserView =>
  createAdminUserView({
    id: ADMIN_ACCOUNT_ID,
    loginName: 'admin_user',
    loginEmail: 'admin@example.com',
    nickname: 'admin_nickname',
    role: IdentityTypeEnum.SUPER_ADMIN,
    ...overrides,
  });

/**
 * 双字段当前事实。`account.status` 与 `userInfo.user_state` 是两个不同枚举类型、
 * 成员字符串当前逐字相同，一致性由 `isDualStatusFieldsConsistent()` 按字符串值比对。
 */
export const createStatusFacts = (
  accountStatus: AccountStatus,
  userState: UserState,
): AdminUserStatusFacts => ({ accountStatus, userState });

/** 双字段一致 ACTIVE 的当前事实（最常见的缺省前置） */
export const createActiveStatusFacts = (): AdminUserStatusFacts =>
  createStatusFacts(AccountStatus.ACTIVE, UserState.ACTIVE);

export type FakeTransactionHarness = {
  /** 注入到被测 Usecase 的事务替身 */
  readonly transactionRunner: TransactionRunner;
  /** 唯一的事务上下文对象：下游全部写入必须都收到它，才谈得上同一事务原子回滚 */
  readonly txContext: PersistenceTransactionContext;
  /**
   * `run` 的 jest.Mock 视图：需要模拟「事务边界自身失败」（BEGIN / COMMIT 报错）的用例
   * 经它安装 once 实现；直接用 `transactionRunner.run` 需反复 cast，容易遗漏。
   */
  readonly runMock: jest.Mock;
  readonly isCommitted: () => boolean;
  readonly isRolledBack: () => boolean;
  readonly reset: () => void;
};

/**
 * 忠实的事务替身：不吞异常、不假装提交。
 * 每个用例前调用 `reset()`，避免上一用例的提交/回滚标记与未消费的 once 实现泄漏。
 */
export const createFakeTransactionHarness = (): FakeTransactionHarness => {
  const txContext = {
    fakeTx: 'admin-user-management',
  } as unknown as PersistenceTransactionContext;

  let committed = false;
  let rolledBack = false;

  const baseRun = async (
    callback: (ctx: PersistenceTransactionContext) => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      const result = await callback(txContext);
      committed = true;
      return result;
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };

  const runMock = jest.fn(baseRun);

  const transactionRunner = { run: runMock } as unknown as TransactionRunner;

  return {
    transactionRunner,
    txContext,
    runMock,
    isCommitted: () => committed,
    isRolledBack: () => rolledBack,
    reset: () => {
      committed = false;
      rolledBack = false;
      // mockClear 不会清 once 队列，mockReset 又会一并清掉基础实现：
      // 先 reset 再重新安装，才能既防泄漏又保留忠实行为
      runMock.mockReset();
      runMock.mockImplementation(baseRun);
    },
  };
};

/**
 * 把「预期抛错」的调用结果转成可断言的值。
 * 意外成功时抛出明确原因，而不是让后续断言以难懂的 `undefined` 失败。
 */
export const captureThrownError = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('预期抛出 DomainError，但调用成功了');
    },
    (error: unknown) => error,
  );

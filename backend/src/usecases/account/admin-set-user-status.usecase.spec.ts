import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import {
  ACCOUNT_ERROR,
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AdminUserStatusFacts, AdminUserView } from '@src/modules/account/account.types';
import type { AccountService } from '@src/modules/account/base/services/account.service';
import type { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { PinoLogger } from 'nestjs-pino';
import {
  createAdminOrganizationFact,
  createOrganizationIsolationMocks,
} from '../../../test/support/account/admin-user.fixture';
import { AdminSetUserStatusUsecase } from './admin-set-user-status.usecase';

/**
 * P1 回归（点 4）：`AdminSetUserStatusUsecase` 的双字段写入原子性。
 *
 * 只覆盖「account.status 与 userInfo.user_state 在同一事务内同成同败」这一收口后置条件，
 * 不改动、也不重测该用例既有的转换矩阵 / 目标保护 / 权限断言规则。
 * 事务提交/回滚由 `TransactionRunner` 承担，这里用一个忠实的替身：回调抛错即回滚并上抛，
 * 正常返回即提交——从而在单元层证明「第二个字段写入失败 ⇒ 事务回滚 ⇒ 两个字段都不落库」。
 */
describe('AdminSetUserStatusUsecase 双字段写入原子性', () => {
  const ADMIN_ACCOUNT_ID = 1;
  const TARGET_ACCOUNT_ID = 2;

  const superAdminSession = (): UsecaseSession => ({
    accountId: ADMIN_ACCOUNT_ID,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
  });

  const adminUserView = (overrides: Partial<AdminUserView> = {}): AdminUserView => ({
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

  const activeFacts = (): AdminUserStatusFacts => ({
    accountStatus: AccountStatus.ACTIVE,
    userState: UserState.ACTIVE,
  });

  // 唯一的事务上下文对象：两处写入必须都收到它，才谈得上同一事务原子回滚
  const txContext = {
    fakeTx: 'admin-set-user-status',
  } as unknown as PersistenceTransactionContext;

  let committed: boolean;
  let rolledBack: boolean;

  const accountService = {
    lockByIdForUpdate: jest.fn(),
    updateAccount: jest.fn(),
    updateUserInfoFields: jest.fn(),
  } as unknown as AccountService;

  const adminUserQueryService = {
    findAdminUserViewById: jest.fn(),
    findAdminUserStatusFacts: jest.fn(),
  } as unknown as AdminUserQueryService;

  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const transactionRunner = {
    run: jest.fn(async (callback: (ctx: PersistenceTransactionContext) => Promise<unknown>) => {
      try {
        const result = await callback(txContext);
        committed = true;
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    }),
  } as unknown as TransactionRunner;

  const organizationIsolation = createOrganizationIsolationMocks();

  /** 组织隔离替身回到「成功」缺省：管理员有单一可信组织、目标同组织有效成员 */
  const givenOrganizationIsolation = (): void => {
    organizationIsolation.resolveForAccount
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
    organizationIsolation.findActiveMembership
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
  };

  const usecase = new AdminSetUserStatusUsecase(
    accountService,
    adminUserQueryService,
    organizationIsolation.organizationContextQueryService,
    organizationIsolation.organizationMembershipQueryService,
    logger,
    transactionRunner,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    committed = false;
    rolledBack = false;
    // clearAllMocks 不清空 mockResolvedValueOnce 队列：显式 reset，
    // 防止前一用例中途失败时残留的 once 实现泄漏到下一用例、干扰定位
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockReset();
    (accountService.lockByIdForUpdate as jest.Mock).mockResolvedValue(undefined);
    (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(activeFacts());
    givenOrganizationIsolation();
  });

  it('第二个字段（user_state）写入失败时，事务回滚且两个字段都不落库', async () => {
    // 锁内读取到的目标 View（READ_BACK 阶段在失败前不可达，只需一次）
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockResolvedValueOnce(
      adminUserView({ status: AccountStatus.ACTIVE }),
    );
    // 第一个字段写入成功、第二个字段写入失败
    (accountService.updateAccount as jest.Mock).mockResolvedValue(undefined);
    (accountService.updateUserInfoFields as jest.Mock).mockRejectedValue(
      new Error('simulated user_info write failure'),
    );

    await expect(
      usecase.execute({
        session: superAdminSession(),
        accountId: TARGET_ACCOUNT_ID,
        status: AccountStatus.INACTIVE,
      }),
    ).rejects.toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });

    // 两处写入确实都被触达，且共用同一事务上下文
    expect(accountService.updateAccount).toHaveBeenCalledTimes(1);
    expect(accountService.updateAccount).toHaveBeenCalledWith(
      TARGET_ACCOUNT_ID,
      expect.objectContaining({ status: AccountStatus.INACTIVE }),
      txContext,
    );
    expect(accountService.updateUserInfoFields).toHaveBeenCalledTimes(1);
    expect(accountService.updateUserInfoFields).toHaveBeenCalledWith({
      accountId: TARGET_ACCOUNT_ID,
      patch: { userState: UserState.INACTIVE },
      transactionContext: txContext,
    });

    // 事务回滚、未提交 ⇒ account.status 与 userInfo.user_state 一并撤销
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
  });

  it('两个字段写入都成功时在同一事务内提交（正例对照）', async () => {
    (adminUserQueryService.findAdminUserViewById as jest.Mock)
      .mockResolvedValueOnce(adminUserView({ status: AccountStatus.ACTIVE })) // 锁内 View
      .mockResolvedValueOnce(adminUserView({ status: AccountStatus.INACTIVE })); // 写后回读
    (accountService.updateAccount as jest.Mock).mockResolvedValue(undefined);
    (accountService.updateUserInfoFields as jest.Mock).mockResolvedValue(undefined);

    await expect(
      usecase.execute({
        session: superAdminSession(),
        accountId: TARGET_ACCOUNT_ID,
        status: AccountStatus.INACTIVE,
      }),
    ).resolves.toMatchObject({ status: AccountStatus.INACTIVE });

    expect(accountService.updateAccount).toHaveBeenCalledWith(
      TARGET_ACCOUNT_ID,
      expect.objectContaining({ status: AccountStatus.INACTIVE }),
      txContext,
    );
    expect(accountService.updateUserInfoFields).toHaveBeenCalledWith({
      accountId: TARGET_ACCOUNT_ID,
      patch: { userState: UserState.INACTIVE },
      transactionContext: txContext,
    });
    expect(committed).toBe(true);
    expect(rolledBack).toBe(false);
  });
});

/**
 * P2-1A：`AdminSetUserStatusUsecase` 的授权、目标保护、状态转换矩阵与输入白名单。
 *
 * 与上方「双字段写入原子性」互补：上一组证明同一事务内两字段同成同败，本组证明
 * 「谁能改、能改谁、从什么状态能改到什么状态、非法输入在哪一步失败关闭」。
 * 本组沿用同一种忠实事务替身，因此拒绝路径同样可观察「已回滚、未提交」；
 * 全部用例不触碰真实数据库，端到端双字段落库事实由管理员用户管理 E2E 覆盖。
 */
describe('AdminSetUserStatusUsecase 授权、目标保护与状态转换矩阵', () => {
  const ADMIN_ACCOUNT_ID = 1;
  const TARGET_ACCOUNT_ID = 2;

  const txContext = {
    fakeTx: 'admin-set-user-status-matrix',
  } as unknown as PersistenceTransactionContext;

  /** 缺省会话即「精确 SUPER_ADMIN」：roles 含 SUPER_ADMIN 且 activeRole 精确等于 SUPER_ADMIN */
  const session = (overrides: Partial<UsecaseSession> = {}): UsecaseSession => ({
    accountId: ADMIN_ACCOUNT_ID,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    ...overrides,
  });

  const adminUserView = (overrides: Partial<AdminUserView> = {}): AdminUserView => ({
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

  /** 双字段当前事实：两个枚举类型不同、成员字符串逐字相同，一致性按字符串值比对 */
  const facts = (accountStatus: AccountStatus, userState: UserState): AdminUserStatusFacts => ({
    accountStatus,
    userState,
  });

  let committed: boolean;
  let rolledBack: boolean;

  const accountService = {
    lockByIdForUpdate: jest.fn(),
    updateAccount: jest.fn(),
    updateUserInfoFields: jest.fn(),
  } as unknown as AccountService;

  const adminUserQueryService = {
    findAdminUserViewById: jest.fn(),
    findAdminUserStatusFacts: jest.fn(),
  } as unknown as AdminUserQueryService;

  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const transactionRunner = {
    run: jest.fn(async (callback: (ctx: PersistenceTransactionContext) => Promise<unknown>) => {
      try {
        const result = await callback(txContext);
        committed = true;
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    }),
  } as unknown as TransactionRunner;

  const organizationIsolation = createOrganizationIsolationMocks();

  /** 组织隔离替身回到「成功」缺省：管理员有单一可信组织、目标同组织有效成员 */
  const givenOrganizationIsolation = (): void => {
    organizationIsolation.resolveForAccount
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
    organizationIsolation.findActiveMembership
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
  };

  const usecase = new AdminSetUserStatusUsecase(
    accountService,
    adminUserQueryService,
    organizationIsolation.organizationContextQueryService,
    organizationIsolation.organizationMembershipQueryService,
    logger,
    transactionRunner,
  );

  /** 锁内目标加载成功（缺省目标是可写的 CUSTOMER、当前 ACTIVE） */
  const givenLockedTarget = (overrides: Partial<AdminUserView> = {}): void => {
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockResolvedValue(
      adminUserView(overrides),
    );
  };

  const executeAsSuperAdmin = (status: unknown, accountId: unknown = TARGET_ACCOUNT_ID) =>
    usecase.execute({ session: session(), accountId, status });

  /**
   * 原样透传入参的执行入口：不给 `accountId` 设默认值。
   * JS 默认参数只在实参为 `undefined` 时生效，用它会静默把「未传 accountId」
   * 改写成合法 ID，使白名单用例测不到真实的 normalize 分支。
   */
  const executeWithRawAccountId = (accountId: unknown, status: unknown) =>
    usecase.execute({ session: session(), accountId, status });

  /** 把「预期抛错」的调用结果转成可断言的值；意外成功时给出明确失败原因 */
  const captureError = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('预期抛出 DomainError，但调用成功了');
      },
      (error: unknown) => error,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    committed = false;
    rolledBack = false;
    // clearAllMocks 既不清 once 队列也不清 mockResolvedValue：逐个 reset 后再铺缺省实现
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockReset();
    (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockReset();
    (accountService.lockByIdForUpdate as jest.Mock).mockReset().mockResolvedValue(undefined);
    (accountService.updateAccount as jest.Mock).mockReset().mockResolvedValue(undefined);
    (accountService.updateUserInfoFields as jest.Mock).mockReset().mockResolvedValue(undefined);
    (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(
      facts(AccountStatus.ACTIVE, UserState.ACTIVE),
    );
    givenOrganizationIsolation();
    givenLockedTarget();
  });

  describe('精确 SUPER_ADMIN 授权', () => {
    const unauthorizedSessions: ReadonlyArray<[string, Partial<UsecaseSession>]> = [
      [
        'CUSTOMER 会话',
        { roles: [IdentityTypeEnum.CUSTOMER], activeRole: IdentityTypeEnum.CUSTOMER },
      ],
      [
        'ENGINEER 会话',
        { roles: [IdentityTypeEnum.ENGINEER], activeRole: IdentityTypeEnum.ENGINEER },
      ],
      [
        'roles 含 SUPER_ADMIN 但 activeRole 为 ENGINEER',
        {
          roles: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          activeRole: IdentityTypeEnum.ENGINEER,
        },
      ],
      [
        'activeRole 为 SUPER_ADMIN 但 roles 不含 SUPER_ADMIN（矛盾会话）',
        { roles: [IdentityTypeEnum.ENGINEER], activeRole: IdentityTypeEnum.SUPER_ADMIN },
      ],
    ];

    it.each(unauthorizedSessions)(
      '%s 被拒，且不开启事务、不触碰数据库',
      async (_label, overrides) => {
        await expect(
          usecase.execute({
            session: session(overrides),
            accountId: TARGET_ACCOUNT_ID,
            status: AccountStatus.INACTIVE,
          }),
        ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

        // 授权是第一步：失败关闭在任何数据库访问与事务边界之前
        expect(transactionRunner.run).not.toHaveBeenCalled();
        expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
        expect(accountService.updateAccount).not.toHaveBeenCalled();
        expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
        expect(committed).toBe(false);
        expect(rolledBack).toBe(false);
      },
    );
  });

  describe('SUPER_ADMIN 目标只读保护', () => {
    it.each([
      ['停用', AccountStatus.INACTIVE],
      ['启用', AccountStatus.ACTIVE],
    ])('SUPER_ADMIN 目标的%s请求被拒且事务回滚', async (_label, status) => {
      givenLockedTarget({ role: IdentityTypeEnum.SUPER_ADMIN, status });

      const error = await captureError(executeAsSuperAdmin(status));

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      // 目标保护基于锁内读到的数据库事实：锁已获取，但双字段一律未写
      expect(accountService.lockByIdForUpdate).toHaveBeenCalledWith(TARGET_ACCOUNT_ID, txContext);
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    });

    it('目标账号不存在时收敛为 TARGET_NOT_FOUND，不塌缩为 UNAUTHENTICATED', async () => {
      (accountService.lockByIdForUpdate as jest.Mock).mockRejectedValue(
        new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账号不存在'),
      );

      const error = await captureError(executeAsSuperAdmin(AccountStatus.INACTIVE));

      // ACCOUNT_ERROR.ACCOUNT_NOT_FOUND 与 AUTH_ERROR.ACCOUNT_NOT_FOUND 码值相同，
      // 原样上抛会被过滤器映射为 UNAUTHENTICATED，故必须收敛为管理员场景的独立码
      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
      expect(error).not.toMatchObject({ code: ACCOUNT_ERROR.ACCOUNT_NOT_FOUND });
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    });
  });

  describe('组织隔离（管理员只能管理本组织）', () => {
    it('目标不在管理员可信组织内时收敛为 TARGET_NOT_FOUND，零写入并回滚', async () => {
      organizationIsolation.findActiveMembership.mockReset().mockResolvedValue(null);

      const error = await captureError(executeAsSuperAdmin(AccountStatus.INACTIVE));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
      expect(organizationIsolation.findActiveMembership).toHaveBeenCalledWith({
        accountId: TARGET_ACCOUNT_ID,
        organizationId: createAdminOrganizationFact().organizationId,
        transactionContext: txContext,
      });
    });

    it('管理员自身没有有效组织时失败关闭为 FORBIDDEN，且零写入', async () => {
      organizationIsolation.resolveForAccount
        .mockReset()
        .mockRejectedValue(
          new DomainError(
            ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
            '当前账号没有有效组织成员关系，无法执行组织范围操作',
          ),
        );

      const error = await captureError(executeAsSuperAdmin(AccountStatus.INACTIVE));

      expect(error).toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
      // 组织解析已后移到行锁之后：先锁定目标，组织裁决失败后不再读取目标资料与写入
      expect(accountService.lockByIdForUpdate).toHaveBeenCalledWith(TARGET_ACCOUNT_ID, txContext);
      expect(organizationIsolation.findActiveMembership).not.toHaveBeenCalled();
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    });
  });

  describe('同状态幂等', () => {
    it.each([
      ['ACTIVE', AccountStatus.ACTIVE, UserState.ACTIVE],
      ['INACTIVE', AccountStatus.INACTIVE, UserState.INACTIVE],
    ])('目标已是 %s 时重复设置零写入并提交', async (_label, status, userState) => {
      (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(
        facts(status, userState),
      );
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValue(adminUserView({ status }));

      await expect(executeAsSuperAdmin(status)).resolves.toMatchObject({ status });

      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      // 幂等路径直接返回锁内 View：不触发写后回读，也不 bump 任何时间列
      expect(adminUserQueryService.findAdminUserViewById).toHaveBeenCalledTimes(1);
      expect(committed).toBe(true);
      expect(rolledBack).toBe(false);
    });
  });

  /**
   * 旧快照回归：并发方 A 已持锁并提交停用，B 在锁前建立的普通读取仍会看到 ACTIVE。
   * 本组用「锁前的读返回旧值、锁后的读返回最新值」的替身，直接区分两种实现顺序：
   * 顺序交换（先组织解析/先读 View 再锁）会在 B 上重复执行一次停用或错误地幂等返回。
   */
  describe('锁后读取最新状态（旧快照回归）', () => {
    const installLockAwareReads = (latestStatus: AccountStatus): void => {
      let locked = false;
      let writtenStatus: AccountStatus | null = null;
      (accountService.lockByIdForUpdate as jest.Mock).mockImplementation(() => {
        locked = true;
      });
      (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockImplementation(() =>
        locked
          ? facts(latestStatus, UserState.INACTIVE)
          : facts(AccountStatus.ACTIVE, UserState.ACTIVE),
      );
      (adminUserQueryService.findAdminUserViewById as jest.Mock).mockImplementation(() =>
        adminUserView({ status: writtenStatus ?? (locked ? latestStatus : AccountStatus.ACTIVE) }),
      );
      (accountService.updateAccount as jest.Mock).mockImplementation(
        (_accountId: number, patch: { status: AccountStatus }) => {
          writtenStatus = patch.status;
        },
      );
    };

    it('锁后读到 INACTIVE 时，重复停用必须幂等且不 bump 时间列', async () => {
      installLockAwareReads(AccountStatus.INACTIVE);

      const view = await executeAsSuperAdmin(AccountStatus.INACTIVE);

      expect(view.status).toBe(AccountStatus.INACTIVE);
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      // 幂等路径只读取锁内 View 一次，不触发写后回读
      expect(adminUserQueryService.findAdminUserViewById).toHaveBeenCalledTimes(1);
      // 回归核心：锁定必须早于组织解析、View 与状态事实读取
      const lockOrder = (accountService.lockByIdForUpdate as jest.Mock).mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(
        organizationIsolation.resolveForAccount.mock.invocationCallOrder[0],
      );
      expect(lockOrder).toBeLessThan(
        (adminUserQueryService.findAdminUserViewById as jest.Mock).mock.invocationCallOrder[0],
      );
      expect(lockOrder).toBeLessThan(
        (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mock.invocationCallOrder[0],
      );
      expect(committed).toBe(true);
      expect(rolledBack).toBe(false);
    });

    it('锁后读到 INACTIVE 时，启用必须真正写入而不是沿用旧快照幂等', async () => {
      installLockAwareReads(AccountStatus.INACTIVE);

      const view = await executeAsSuperAdmin(AccountStatus.ACTIVE);

      expect(view.status).toBe(AccountStatus.ACTIVE);
      expect(accountService.updateAccount).toHaveBeenCalledTimes(1);
      expect(accountService.updateAccount).toHaveBeenCalledWith(
        TARGET_ACCOUNT_ID,
        expect.objectContaining({ status: AccountStatus.ACTIVE }),
        txContext,
      );
      expect(accountService.updateUserInfoFields).toHaveBeenCalledTimes(1);
      expect(committed).toBe(true);
      expect(rolledBack).toBe(false);
    });
  });

  describe('状态转换矩阵失败关闭', () => {
    it('双字段不一致时拒绝写入并回滚（不选任一字段为真源、不自动修复）', async () => {
      (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(
        facts(AccountStatus.ACTIVE, UserState.INACTIVE),
      );

      const error = await captureError(executeAsSuperAdmin(AccountStatus.INACTIVE));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.STATUS_TRANSITION_NOT_ALLOWED,
        // 当前状态事实只进 cause（服务端排查），details 留空 ⇒ 不写入 extensions
        cause: { diagnostic: 'DUAL_STATUS_FIELDS_INCONSISTENT' },
        details: undefined,
      });
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    });

    it.each([
      ['SUSPENDED', AccountStatus.SUSPENDED, UserState.SUSPENDED],
      ['PENDING', AccountStatus.PENDING, UserState.PENDING],
      ['BANNED', AccountStatus.BANNED, UserState.ACTIVE],
    ])('当前状态为 %s 时不允许转换', async (_label, accountStatus, userState) => {
      (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(
        facts(accountStatus, userState),
      );

      const error = await captureError(executeAsSuperAdmin(AccountStatus.ACTIVE));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.STATUS_TRANSITION_NOT_ALLOWED,
        cause: { diagnostic: 'CURRENT_STATUS_NOT_TRANSITIONABLE' },
      });
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
    });

    it('状态事实读不到时按读失败关闭，不以 CONFLICT 形态出现', async () => {
      (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(null);

      const error = await captureError(executeAsSuperAdmin(AccountStatus.INACTIVE));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: { diagnostic: 'STATUS_FACTS_NOT_READABLE' },
      });
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
    });
  });

  describe('禁止停用自己', () => {
    it('管理员停用自己的账号被拒，且不开启事务', async () => {
      const error = await captureError(
        executeAsSuperAdmin(AccountStatus.INACTIVE, ADMIN_ACCOUNT_ID),
      );

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      // 先行显式拒绝：不依赖「自己的账号恰好是只读 SUPER_ADMIN」这一间接事实
      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
      expect(rolledBack).toBe(false);
      expect(committed).toBe(false);
    });

    it('自停用检查只拦 INACTIVE：请求 ACTIVE 时进入事务并由目标保护裁决', async () => {
      givenLockedTarget({ id: ADMIN_ACCOUNT_ID, role: IdentityTypeEnum.SUPER_ADMIN });

      const error = await captureError(executeAsSuperAdmin(AccountStatus.ACTIVE, ADMIN_ACCOUNT_ID));

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
      expect(accountService.lockByIdForUpdate).toHaveBeenCalledTimes(1);
      expect(accountService.updateAccount).not.toHaveBeenCalled();
    });
  });

  describe('输入白名单失败关闭', () => {
    const illegalStatuses: ReadonlyArray<unknown> = [
      AccountStatus.BANNED,
      AccountStatus.PENDING,
      AccountStatus.SUSPENDED,
      AccountStatus.DELETED,
      'active',
      '',
      '   ',
      null,
      undefined,
      [AccountStatus.ACTIVE],
    ];

    it.each(illegalStatuses)('非法目标状态 %p 被拒且不开启事务', async (status) => {
      await expect(executeAsSuperAdmin(status)).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE,
      });
      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.updateAccount).not.toHaveBeenCalled();
    });

    const illegalAccountIds: ReadonlyArray<unknown> = [
      0,
      -1,
      1.5,
      Number.NaN,
      '2',
      '',
      null,
      undefined,
      [],
    ];

    it.each(illegalAccountIds)('非法目标账号 ID %p 被拒且不开启事务', async (accountId) => {
      await expect(
        executeWithRawAccountId(accountId, AccountStatus.INACTIVE),
      ).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE,
      });
      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
    });
  });

  describe('启用方向与写后回读', () => {
    it('INACTIVE → ACTIVE 时 account.status 与 user_state 同步为 ACTIVE', async () => {
      (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(
        facts(AccountStatus.INACTIVE, UserState.INACTIVE),
      );
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(adminUserView({ status: AccountStatus.INACTIVE }))
        .mockResolvedValueOnce(adminUserView({ status: AccountStatus.ACTIVE }));

      await expect(executeAsSuperAdmin(AccountStatus.ACTIVE)).resolves.toMatchObject({
        status: AccountStatus.ACTIVE,
      });

      expect(accountService.updateAccount).toHaveBeenCalledWith(
        TARGET_ACCOUNT_ID,
        expect.objectContaining({ status: AccountStatus.ACTIVE }),
        txContext,
      );
      expect(accountService.updateUserInfoFields).toHaveBeenCalledWith({
        accountId: TARGET_ACCOUNT_ID,
        patch: { userState: UserState.ACTIVE },
        transactionContext: txContext,
      });
      expect(committed).toBe(true);
      expect(rolledBack).toBe(false);
    });

    it('写后回读状态未反映时按写失败关闭并回滚', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(adminUserView({ status: AccountStatus.ACTIVE }))
        // 回读仍是旧状态：写入未按预期生效
        .mockResolvedValueOnce(adminUserView({ status: AccountStatus.ACTIVE }));

      const error = await captureError(executeAsSuperAdmin(AccountStatus.INACTIVE));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
        cause: { diagnostic: 'STATUS_NOT_REFLECTED_AFTER_WRITE' },
      });
      // 两处写入都已触达 ⇒ 只能靠事务回滚保证「不一致终态」不落库
      expect(accountService.updateAccount).toHaveBeenCalledTimes(1);
      expect(accountService.updateUserInfoFields).toHaveBeenCalledTimes(1);
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    });

    it('写后回读为空时按读失败关闭', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(adminUserView({ status: AccountStatus.ACTIVE }))
        .mockResolvedValueOnce(null);

      const error = await captureError(executeAsSuperAdmin(AccountStatus.INACTIVE));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: { diagnostic: 'UPDATED_STATUS_NOT_READABLE' },
      });
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    });

    it('事务边界自身失败时收敛为 WRITE_FAILED', async () => {
      (transactionRunner.run as jest.Mock).mockRejectedValueOnce(
        new Error('simulated COMMIT failure'),
      );

      await expect(executeAsSuperAdmin(AccountStatus.INACTIVE)).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });
      expect(committed).toBe(false);
    });
  });
});

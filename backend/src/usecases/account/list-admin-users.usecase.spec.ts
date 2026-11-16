// src/usecases/account/list-admin-users.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import type { AdminUserListPage } from '@src/modules/account/account.types';
import type { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { PinoLogger } from 'nestjs-pino';
import {
  TARGET_ACCOUNT_ID,
  captureThrownError,
  createAdminOrganizationFact,
  createAdminUserView,
  createLevelTwoAdminSession,
  createOrganizationIsolationMocks,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { ListAdminUsersUsecase } from './list-admin-users.usecase';

/**
 * P2-1A：`ListAdminUsersUsecase` 的授权、分页钳制、筛选白名单与「整次失败关闭」冒泡。
 *
 * 三源角色收敛与资料行缺失的判定在 `AdminUserQueryService`（另有定向单测），
 * 本文件只核实用例层的三件事：
 * 1. 精确 SUPER_ADMIN 授权是第一步，失败关闭时不触发任何查询；
 * 2. 分页与筛选走既有 policy / normalize 单一真源，不另写第二套钳制；
 * 3. QueryService 抛出的 `ROLE_DATA_INCONSISTENT` / `READ_FAILED` **原样冒泡**——
 *    不返回部分列表、不排除异常行、不改写错误码，只补服务端日志。
 */
describe('ListAdminUsersUsecase', () => {
  const offsetPagination = (overrides: Partial<OffsetParams> = {}): PaginationParams => ({
    mode: 'OFFSET',
    page: 1,
    pageSize: 20,
    ...overrides,
  });

  const listPage = (overrides: Partial<AdminUserListPage> = {}): AdminUserListPage => ({
    items: [createAdminUserView()],
    total: 1,
    page: 1,
    pageSize: 20,
    ...overrides,
  });

  const adminUserQueryService = {
    listAdminUsers: jest.fn(),
  } as unknown as AdminUserQueryService;

  const organizationIsolation = createOrganizationIsolationMocks();

  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const usecase = new ListAdminUsersUsecase(
    adminUserQueryService,
    organizationIsolation.organizationContextQueryService,
    organizationIsolation.organizationMembershipQueryService,
    logger,
  );

  const executeAsSuperAdmin = (
    overrides: {
      readonly pagination?: PaginationParams;
      readonly keyword?: unknown;
      readonly role?: unknown;
      readonly status?: unknown;
      readonly session?: UsecaseSession;
    } = {},
  ) =>
    usecase.execute({
      session: overrides.session ?? createSuperAdminSession(),
      pagination: overrides.pagination ?? offsetPagination(),
      keyword: overrides.keyword,
      role: overrides.role,
      status: overrides.status,
    });

  /** 取本次传给 QueryService 的查询对象，用于结构性断言（多余字段是否被丢弃） */
  const capturedQuery = (): Record<string, unknown> =>
    (adminUserQueryService.listAdminUsers as jest.Mock).mock.calls[0][0] as Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    (adminUserQueryService.listAdminUsers as jest.Mock).mockReset();
    (adminUserQueryService.listAdminUsers as jest.Mock).mockResolvedValue(listPage());
    // 组织隔离替身回到「成功」缺省：clearAllMocks 不清实现，拒绝分支的 mock 会泄漏到后续用例
    organizationIsolation.resolveForAccount
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
    organizationIsolation.listActiveEngineerAccountIdsByOrganization
      .mockReset()
      .mockResolvedValue([TARGET_ACCOUNT_ID]);
  });

  describe('精确 SUPER_ADMIN 授权', () => {
    it.each(createUnauthorizedSessions())('%s 被拒且不触发查询', async (_label, session) => {
      await expect(executeAsSuperAdmin({ session })).rejects.toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      });

      // 授权先于任何输入规范化与数据库读取：无权限者既触发不了查询，
      // 也无法从错误文案里推断出筛选值域；组织解析同样不执行
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
      expect(organizationIsolation.resolveForAccount).not.toHaveBeenCalled();
    });
  });

  describe('两级管理员作用域', () => {
    it('一级管理员：不解析成员公司、不下推组织范围，读面即平台全范围', async () => {
      await executeAsSuperAdmin();

      expect(organizationIsolation.resolveForAccount).not.toHaveBeenCalled();
      expect(
        organizationIsolation.listActiveEngineerAccountIdsByOrganization,
      ).not.toHaveBeenCalled();
      expect(capturedQuery().organizationScope).toBeUndefined();
      // 读面仍强制只返回普通用户
      expect(capturedQuery().visibleRoles).toEqual([
        IdentityTypeEnum.ENGINEER,
        IdentityTypeEnum.CUSTOMER,
      ]);
    });

    it('二级管理员：复核可信公司成员关系，并按角色分流下推组织范围', async () => {
      await executeAsSuperAdmin({ session: createLevelTwoAdminSession() });

      expect(organizationIsolation.resolveForAccount).toHaveBeenCalledWith({
        accountId: createLevelTwoAdminSession().accountId,
        transactionContext: undefined,
      });
      // 客户范围由 QueryService 按资料列比较，不依赖成员 ID 清单；
      // 工程师范围来自本公司有效工程师成员关系
      expect(
        organizationIsolation.listActiveEngineerAccountIdsByOrganization,
      ).toHaveBeenCalledWith({
        organizationId: createAdminOrganizationFact().organizationId,
      });
      expect(capturedQuery().organizationScope).toEqual({
        organizationId: createAdminOrganizationFact().organizationId,
        engineerAccountIds: [TARGET_ACCOUNT_ID],
      });
    });

    it('二级管理员的成员关系被撤销或公司不一致时失败关闭为 FORBIDDEN，且不触发列表查询', async () => {
      organizationIsolation.resolveForAccount
        .mockReset()
        .mockResolvedValue(createAdminOrganizationFact({ organizationId: 999 }));

      await expect(
        executeAsSuperAdmin({ session: createLevelTwoAdminSession() }),
      ).rejects.toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      });
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
      expect(
        organizationIsolation.listActiveEngineerAccountIdsByOrganization,
      ).not.toHaveBeenCalled();
    });

    it('二级管理员的成员角色不再是 SUPER_ADMIN 时失败关闭为 FORBIDDEN', async () => {
      organizationIsolation.resolveForAccount
        .mockReset()
        .mockResolvedValue(createAdminOrganizationFact({ memberRole: 'ENGINEER' }));

      await expect(
        executeAsSuperAdmin({ session: createLevelTwoAdminSession() }),
      ).rejects.toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      });
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
    });

    it('公司内没有有效工程师时仍保留客户范围条件（不返回空页）', async () => {
      organizationIsolation.listActiveEngineerAccountIdsByOrganization
        .mockReset()
        .mockResolvedValue([]);

      await executeAsSuperAdmin({ session: createLevelTwoAdminSession() });

      expect(capturedQuery().organizationScope).toEqual({
        organizationId: createAdminOrganizationFact().organizationId,
        engineerAccountIds: [],
      });
      expect(adminUserQueryService.listAdminUsers).toHaveBeenCalledTimes(1);
    });

    it('等级缺失 / 非法的管理员会话被拒且不触发查询', async () => {
      for (const adminLevel of [null, 0, 3, undefined]) {
        await expect(
          executeAsSuperAdmin({ session: createSuperAdminSession({ adminLevel }) }),
        ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      }
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
    });
  });

  describe('查询入参收敛', () => {
    it('keyword / role / status / 分页原样收敛后交给 QueryService', async () => {
      await executeAsSuperAdmin({
        pagination: offsetPagination({ page: 3, pageSize: 50 }),
        keyword: '  Target_User  ',
        role: IdentityTypeEnum.ENGINEER,
        status: AccountStatus.INACTIVE,
      });

      expect(adminUserQueryService.listAdminUsers).toHaveBeenCalledTimes(1);
      expect(adminUserQueryService.listAdminUsers).toHaveBeenCalledWith({
        page: 3,
        pageSize: 50,
        // 关键字只做 trim 与长度上限，刻意不做小写归一（登录名大小写不敏感由列排序规则负责）
        keyword: 'Target_User',
        role: IdentityTypeEnum.ENGINEER,
        status: AccountStatus.INACTIVE,
        organizationScope: undefined,
        visibleRoles: [IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER],
      });
    });

    it('未提供筛选时 keyword / role / status 收敛为 undefined（不筛选）', async () => {
      await executeAsSuperAdmin();

      expect(adminUserQueryService.listAdminUsers).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        keyword: undefined,
        role: undefined,
        status: undefined,
        organizationScope: undefined,
        visibleRoles: [IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER],
      });
    });

    it('空白关键字视为不搜索', async () => {
      await executeAsSuperAdmin({ keyword: '   ' });

      expect(capturedQuery().keyword).toBeUndefined();
    });

    it('role 筛选值域只含 ENGINEER / CUSTOMER，SUPER_ADMIN 被白名单拒绝', async () => {
      await executeAsSuperAdmin({ role: IdentityTypeEnum.ENGINEER });
      expect(capturedQuery().role).toBe(IdentityTypeEnum.ENGINEER);

      (adminUserQueryService.listAdminUsers as jest.Mock).mockClear();
      await expect(
        executeAsSuperAdmin({ role: IdentityTypeEnum.SUPER_ADMIN }),
      ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE });
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
    });

    it('sorts 与 withTotal 被结构性丢弃（排序与统计由固定契约给出）', async () => {
      // 显式写成 OFFSET 字面量而不用展开工厂：展开后 TS 无法窄化到 OffsetParams 分支，
      // 会报 withTotal 不存在于 CursorParams
      const paginationWithClientSorts: PaginationParams = {
        mode: 'OFFSET',
        page: 1,
        pageSize: 20,
        sorts: [{ field: 'nickname', direction: 'ASC' }],
        withTotal: false,
      };

      await executeAsSuperAdmin({ pagination: paginationWithClientSorts });

      const query = capturedQuery();
      expect(query).not.toHaveProperty('sorts');
      expect(query).not.toHaveProperty('withTotal');
      expect(query).not.toHaveProperty('mode');
    });
  });

  describe('分页钳制走 core policy 单一真源', () => {
    it.each([
      [500, 100],
      [101, 100],
      [100, 100],
      [0, 1],
      [-20, 1],
    ])('pageSize %p 钳制为 %p', async (input, expected) => {
      await executeAsSuperAdmin({ pagination: offsetPagination({ pageSize: input }) });

      expect(capturedQuery().pageSize).toBe(expected);
    });

    it.each([
      [0, 1],
      [-5, 1],
      [7, 7],
    ])('page %p 钳制为 %p', async (input, expected) => {
      await executeAsSuperAdmin({ pagination: offsetPagination({ page: input }) });

      expect(capturedQuery().page).toBe(expected);
    });

    it('CURSOR 分页被拒且不触发查询', async () => {
      const cursorPagination: PaginationParams = { mode: 'CURSOR', limit: 20 };

      await expect(executeAsSuperAdmin({ pagination: cursorPagination })).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE,
      });
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
    });
  });

  describe('筛选值白名单失败关闭', () => {
    const illegalRoles: ReadonlyArray<unknown> = ['ADMIN', 'super_admin', '', '   ', 1, []];

    it.each(illegalRoles)('非法角色筛选 %p 被拒且不触发查询', async (role) => {
      await expect(executeAsSuperAdmin({ role })).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE,
      });
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
    });

    const illegalStatuses: ReadonlyArray<unknown> = [
      AccountStatus.BANNED,
      AccountStatus.PENDING,
      AccountStatus.SUSPENDED,
      AccountStatus.DELETED,
      'active',
      '',
    ];

    it.each(illegalStatuses)('非法状态筛选 %p 被拒且不触发查询', async (status) => {
      await expect(executeAsSuperAdmin({ status })).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE,
      });
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
    });

    it('超长关键字被拒（防御性上限，不截断、不静默退化为全量）', async () => {
      await expect(executeAsSuperAdmin({ keyword: 'a'.repeat(101) })).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      });
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
    });
  });

  describe('整次失败关闭：QueryService 异常原样冒泡', () => {
    it('三源角色无法收敛时整次查询失败，错误码不被改写', async () => {
      const inconsistency = new DomainError(
        ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
        '用户账号数据异常，暂时无法加载用户信息',
        undefined,
        { diagnostic: 'ROLE_CONVERGENCE_FAILED', accountId: 7, reason: 'SOURCES_INCONSISTENT' },
      );
      (adminUserQueryService.listAdminUsers as jest.Mock).mockRejectedValue(inconsistency);

      // 原样冒泡：同一错误对象引用，不返回部分列表、不排除异常行、不选任一源兜底
      await expect(executeAsSuperAdmin()).rejects.toBe(inconsistency);

      // 专用日志分支：保留定位所需的最小信息（账号主键 + 失败原因分类），
      // 不记录三源角色原值、access_group / meta_digest 内容
      expect(logger.error).toHaveBeenCalledWith(
        { accountId: 7, reason: 'SOURCES_INCONSISTENT' },
        expect.stringContaining('三源角色数据无法收敛'),
      );
    });

    it('资料行缺失导致的 READ_FAILED 原样冒泡，日志保留结构化 diagnostic', async () => {
      const readFailure = new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '用户账号资料缺失，无法生成用户视图',
        undefined,
        { diagnostic: 'USER_INFO_ROW_MISSING', accountId: 9 },
      );
      (adminUserQueryService.listAdminUsers as jest.Mock).mockRejectedValue(readFailure);

      await expect(executeAsSuperAdmin()).rejects.toBe(readFailure);
      expect(logger.error).toHaveBeenCalledWith(
        {
          errorCode: ADMIN_USER_ERROR.READ_FAILED,
          diagnostic: { diagnostic: 'USER_INFO_ROW_MISSING', accountId: 9 },
          causeErrorName: undefined,
        },
        '管理员用户列表读取失败',
      );
    });

    it('驱动故障的 cause 为 Error 实例时丢弃 message（可能含 SQL 文本）', async () => {
      const driverError = Object.assign(new Error('SELECT * FROM base_user_account WHERE ...'), {
        name: 'QueryFailedError',
      });
      (adminUserQueryService.listAdminUsers as jest.Mock).mockRejectedValue(
        new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '用户列表读取失败，请稍后重试',
          undefined,
          driverError,
        ),
      );

      await expect(executeAsSuperAdmin()).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
      });
      expect(logger.error).toHaveBeenCalledWith(
        {
          errorCode: ADMIN_USER_ERROR.READ_FAILED,
          diagnostic: undefined,
          causeErrorName: 'QueryFailedError',
        },
        '管理员用户列表读取失败',
      );
      // 断言 message 从未进入日志（SQL 文本不外泄）
      const loggedPayload = (logger.error as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(JSON.stringify(loggedPayload)).not.toContain('base_user_account');
    });

    it('非领域异常原样上抛并记 UNEXPECTED', async () => {
      const unexpected = new Error('simulated infrastructure failure');
      (adminUserQueryService.listAdminUsers as jest.Mock).mockRejectedValue(unexpected);

      const error = await captureThrownError(executeAsSuperAdmin());

      expect(error).toBe(unexpected);
      expect(logger.error).toHaveBeenCalledWith(
        { reason: 'UNEXPECTED' },
        expect.stringContaining('非领域异常'),
      );
    });
  });

  it('成功时把 QueryService 的分页结果原样返回', async () => {
    const page = listPage({
      items: [
        createAdminUserView({ id: 3, role: IdentityTypeEnum.ENGINEER }),
        createAdminUserView({ id: 4, role: IdentityTypeEnum.CUSTOMER }),
      ],
      total: 42,
      page: 2,
      pageSize: 20,
    });
    (adminUserQueryService.listAdminUsers as jest.Mock).mockResolvedValue(page);

    await expect(executeAsSuperAdmin({ pagination: offsetPagination({ page: 2 }) })).resolves.toBe(
      page,
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});

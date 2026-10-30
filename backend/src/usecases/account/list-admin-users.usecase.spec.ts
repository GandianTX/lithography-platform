// src/usecases/account/list-admin-users.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import type { AdminUserListPage } from '@src/modules/account/account.types';
import type { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { PinoLogger } from 'nestjs-pino';
import {
  ADMIN_ACCOUNT_ID,
  TARGET_ACCOUNT_ID,
  captureThrownError,
  createAdminOrganizationFact,
  createAdminUserView,
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
    organizationIsolation.listActiveAccountIdsByOrganization
      .mockReset()
      .mockResolvedValue([ADMIN_ACCOUNT_ID, TARGET_ACCOUNT_ID]);
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

  describe('组织隔离（管理员只能查看本组织）', () => {
    it('以 Session 账号解析可信组织，并把组织内有效账号 ID 下推给 QueryService', async () => {
      await executeAsSuperAdmin();

      expect(organizationIsolation.resolveForAccount).toHaveBeenCalledWith({
        accountId: createSuperAdminSession().accountId,
      });
      expect(organizationIsolation.listActiveAccountIdsByOrganization).toHaveBeenCalledWith({
        organizationId: createAdminOrganizationFact().organizationId,
      });
      expect(capturedQuery().accountIds).toEqual([ADMIN_ACCOUNT_ID, TARGET_ACCOUNT_ID]);
    });

    it('管理员无有效组织时失败关闭为 FORBIDDEN，且不触发列表查询', async () => {
      organizationIsolation.resolveForAccount
        .mockReset()
        .mockRejectedValue(
          new DomainError(
            ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
            '当前账号没有有效组织成员关系，无法执行组织范围操作',
          ),
        );

      await expect(executeAsSuperAdmin()).rejects.toMatchObject({
        code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
      });
      expect(adminUserQueryService.listAdminUsers).not.toHaveBeenCalled();
      expect(organizationIsolation.listActiveAccountIdsByOrganization).not.toHaveBeenCalled();
    });

    it('组织内没有任何有效账号时下推空清单（QueryService 返回空页，不退化为全库）', async () => {
      organizationIsolation.listActiveAccountIdsByOrganization.mockReset().mockResolvedValue([]);
      (adminUserQueryService.listAdminUsers as jest.Mock).mockResolvedValue(
        listPage({ items: [], total: 0 }),
      );

      await executeAsSuperAdmin();

      expect(capturedQuery().accountIds).toEqual([]);
      expect(adminUserQueryService.listAdminUsers).toHaveBeenCalledTimes(1);
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
        accountIds: [ADMIN_ACCOUNT_ID, TARGET_ACCOUNT_ID],
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
        accountIds: [ADMIN_ACCOUNT_ID, TARGET_ACCOUNT_ID],
      });
    });

    it('空白关键字视为不搜索', async () => {
      await executeAsSuperAdmin({ keyword: '   ' });

      expect(capturedQuery().keyword).toBeUndefined();
    });

    it('role 筛选值域比可写值域多出 SUPER_ADMIN（管理页面只读展示管理员）', async () => {
      await executeAsSuperAdmin({ role: IdentityTypeEnum.SUPER_ADMIN });

      expect(capturedQuery().role).toBe(IdentityTypeEnum.SUPER_ADMIN);
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

// src/modules/account/queries/admin-user.query.service.spec.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { ADMIN_USER_ERROR, DomainError } from '@core/common/errors/domain-error';
import type { SearchOptions, SearchResult } from '@core/search/search.types';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import type { SearchService } from '@src/modules/common/search.module';
import type { EntityManager, Repository } from 'typeorm';
import type { AdminUserListQuery } from '../account.types';
import { AccountEntity } from '../base/entities/account.entity';
import { UserInfoEntity } from '../base/entities/user-info.entity';
import { AdminUserQueryService } from './admin-user.query.service';

/**
 * P2-1A：`AdminUserQueryService` 的查询构造、options 白名单、窄事实读取与「整次失败关闭」。
 *
 * 本文件核实的是**读链路的数据不变量**，授权不在这里（QueryService 刻意不含权限断言，
 * 精确 SUPER_ADMIN 授权由 `ListAdminUsersUsecase` 与各写用例的入口断言承担）：
 * 1. 筛选 / 排序 / 搜索列全部来自本文件的固定常量与白名单映射，不接受外部列名；
 * 2. 资料行缺失与三源角色不收敛都让**整次查询失败**——不排除异常行、不返回部分列表、
 *    不选任一源字段兜底、不静默修复；
 * 3. `details` 一律留空（全局过滤器会把它原样写进 `extensions.details`），定位信息只进 `cause`；
 * 4. `total` 缺失不以 0 兜底；
 * 5. 走 entity 水合路径与 LEFT JOIN：`meta_digest` 是加密列，`getRawMany()` 拿到密文会让
 *    三源收敛对每一行都失败；INNER JOIN 会让资料缺失行在 SQL 层被静默排除。
 */
describe('AdminUserQueryService', () => {
  const TARGET_ACCOUNT_ID = 2;

  /** 加密列解密失败时 `decryptEntity()` 会保留密文字符串，用它构造 NOT_ARRAY 失败 */
  const CIPHER_TEXT = 'enc:v1:9f2c7a41b8e0d3c5';

  const createFakeQueryBuilder = () => {
    const qb = {
      leftJoinAndSelect: jest.fn(),
      innerJoinAndSelect: jest.fn(),
      andWhere: jest.fn(),
      getRawMany: jest.fn(),
      getMany: jest.fn(),
    };
    qb.leftJoinAndSelect.mockReturnValue(qb);
    qb.innerJoinAndSelect.mockReturnValue(qb);
    qb.andWhere.mockReturnValue(qb);
    return qb;
  };

  const buildUserInfo = (overrides: Record<string, unknown> = {}): UserInfoEntity =>
    ({
      accountId: TARGET_ACCOUNT_ID,
      nickname: 'target_nickname',
      companyName: '示例公司',
      phone: '13800000000',
      email: 'contact@example.com',
      accessGroup: [IdentityTypeEnum.CUSTOMER],
      metaDigest: [IdentityTypeEnum.CUSTOMER],
      userState: UserState.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }) as unknown as UserInfoEntity;

  const buildAccount = (overrides: Record<string, unknown> = {}): AccountEntity =>
    ({
      id: TARGET_ACCOUNT_ID,
      loginName: 'target_user',
      loginEmail: 'target@example.com',
      // 刻意放一个明显的凭据派生物：任何 View 出现它都属泄露
      loginPassword: 'pbkdf2$stored-hash$should-never-leak',
      identityHint: IdentityTypeEnum.CUSTOMER,
      status: AccountStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      userInfo: buildUserInfo(),
      ...overrides,
    }) as unknown as AccountEntity;

  const accountRepository = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    existsBy: jest.fn(),
    query: jest.fn(),
  } as unknown as Repository<AccountEntity>;

  const searchService = { search: jest.fn() } as unknown as SearchService;

  const service = new AdminUserQueryService(accountRepository, searchService);

  const qb = createFakeQueryBuilder();

  const listQuery = (overrides: Partial<AdminUserListQuery> = {}): AdminUserListQuery => ({
    page: 1,
    pageSize: 20,
    ...overrides,
  });

  const searchResult = (
    items: ReadonlyArray<AccountEntity>,
    overrides: Partial<SearchResult<AccountEntity>> = {},
  ): SearchResult<AccountEntity> => ({
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    ...overrides,
  });

  const givenSearchResult = (result: SearchResult<AccountEntity>): void => {
    (searchService.search as jest.Mock).mockResolvedValue(result);
  };

  type CapturedSearchArg = {
    readonly qb: unknown;
    readonly params: {
      readonly query?: string;
      readonly filters: Record<string, unknown>;
      readonly pagination: Record<string, unknown>;
    };
    readonly options: SearchOptions;
  };

  const capturedSearchArg = (): CapturedSearchArg =>
    (searchService.search as jest.Mock).mock.calls[0][0] as CapturedSearchArg;

  /** 经生产工厂构造真事务上下文：绑定一个只暴露 getRepository 的假 EntityManager */
  const createTransactionContext = (txRepository: Repository<AccountEntity>) => {
    const manager = {
      getRepository: jest.fn().mockReturnValue(txRepository),
    } as unknown as EntityManager;
    return {
      transactionContext: createTypeOrmPersistenceTransactionContext(manager),
      manager,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (accountRepository.createQueryBuilder as jest.Mock).mockReset().mockReturnValue(qb);
    qb.leftJoinAndSelect.mockClear().mockReturnValue(qb);
    qb.innerJoinAndSelect.mockClear();
    qb.andWhere.mockClear().mockReturnValue(qb);
    qb.getRawMany.mockClear();
    qb.getMany.mockClear();
    (accountRepository.findOne as jest.Mock).mockReset();
    (accountRepository.existsBy as jest.Mock).mockReset().mockResolvedValue(false);
    (accountRepository.query as jest.Mock).mockReset();
    (searchService.search as jest.Mock).mockReset();
    givenSearchResult(searchResult([buildAccount()]));
  });

  describe('listAdminUsers：查询构造', () => {
    it('以 account 别名建 QueryBuilder 并 LEFT JOIN 资料行', async () => {
      await service.listAdminUsers(listQuery());

      expect(accountRepository.createQueryBuilder).toHaveBeenCalledWith('account');
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('account.userInfo', 'userInfo');
      // INNER JOIN 会让资料缺失行在 SQL 层被静默排除：既不进 items 也不计入 total，
      // 等于「跳过异常账号 + 返回部分列表」
      expect(qb.innerJoinAndSelect).not.toHaveBeenCalled();
      // meta_digest 是加密列，只有 entity 水合路径才会被订阅者解密
      expect(qb.getRawMany).not.toHaveBeenCalled();
      expect(accountRepository.query).not.toHaveBeenCalled();
    });

    it('未提供筛选时 filters 为空对象，不写入 undefined 键', async () => {
      await service.listAdminUsers(listQuery({ role: undefined, status: undefined }));

      expect(capturedSearchArg().params.filters).toEqual({});
      expect(Object.keys(capturedSearchArg().params.filters)).toEqual([]);
    });

    it('角色与状态筛选下推数据库，且列名来自固定映射而非外部输入', async () => {
      await service.listAdminUsers(
        listQuery({ role: IdentityTypeEnum.ENGINEER, status: AccountStatus.INACTIVE }),
      );

      expect(capturedSearchArg().params.filters).toEqual({
        role: IdentityTypeEnum.ENGINEER,
        status: AccountStatus.INACTIVE,
      });
    });

    it('只提供一个筛选维度时另一个维度不出现在 filters 中', async () => {
      await service.listAdminUsers(listQuery({ status: AccountStatus.ACTIVE }));

      const filters = capturedSearchArg().params.filters;
      expect(Object.keys(filters)).toEqual(['status']);
      expect(filters).not.toHaveProperty('role');
    });

    it('关键字原样交给搜索引擎，不在本层拼接 LIKE 或通配符', async () => {
      await service.listAdminUsers(listQuery({ keyword: 'target%' }));

      expect(capturedSearchArg().params.query).toBe('target%');
    });

    it('分页只走 OFFSET 且 withTotal 恒开（管理页面依赖 total 渲染服务端分页）', async () => {
      await service.listAdminUsers(listQuery({ page: 3, pageSize: 50 }));

      expect(capturedSearchArg().params.pagination).toEqual({
        mode: 'OFFSET',
        page: 3,
        pageSize: 50,
        withTotal: true,
      });
    });

    it('options 白名单：搜索三列、筛选两维、排序两键，且 id 是 tieBreaker', async () => {
      await service.listAdminUsers(listQuery());

      const { options } = capturedSearchArg();
      expect(options.searchColumns).toEqual([
        'account.loginName',
        'account.loginEmail',
        'userInfo.nickname',
      ]);
      expect(options.allowedFilters).toEqual(['role', 'status']);
      expect(options.allowedSorts).toEqual(['createdAt', 'id']);
      expect(options.defaultSorts).toEqual([
        { field: 'createdAt', direction: 'DESC' },
        // created_at 是 TIMESTAMP(3)，批量创建会落在同一毫秒：缺 tieBreaker 会翻页重复/漏行
        { field: 'id', direction: 'DESC' },
      ]);
      // 排序契约固定，不接受客户端传入（AdminUserListQuery 没有 sorts 字段）
      expect(options.defaultSorts).toHaveLength(2);
    });

    it('resolveColumn 只映射白名单业务字段，未映射字段返回 null 而不猜列名', async () => {
      await service.listAdminUsers(listQuery());

      const { resolveColumn } = capturedSearchArg().options;
      expect(resolveColumn('role')).toBe('account.identityHint');
      expect(resolveColumn('status')).toBe('account.status');
      expect(resolveColumn('createdAt')).toBe('account.createdAt');
      expect(resolveColumn('id')).toBe('account.id');
      // 登录名只作为搜索列，不作为筛选/排序列；未知字段不得回退成同名裸列
      expect(resolveColumn('loginName')).toBeNull();
      expect(resolveColumn('nickname')).toBeNull();
      expect(resolveColumn('login_password')).toBeNull();
      expect(resolveColumn('1; DROP TABLE base_user_account')).toBeNull();
    });

    it('allowedFilters / allowedSorts 的成员都能被 resolveColumn 解析出安全列', async () => {
      await service.listAdminUsers(listQuery());

      const { allowedFilters = [], allowedSorts, resolveColumn } = capturedSearchArg().options;
      for (const field of [...allowedFilters, ...allowedSorts]) {
        expect(resolveColumn(field)).toMatch(/^account\./);
      }
    });

    it('组织范围以账号 ID 清单下推 IN，不改变其余筛选与分页', async () => {
      await service.listAdminUsers(listQuery({ accountIds: [1, 2, 3] }));

      // 下推为命名参数化的 IN，避免把 ID 拼进 SQL 文本
      expect(qb.andWhere).toHaveBeenCalledWith('account.id IN (:...accountIds)', {
        accountIds: [1, 2, 3],
      });
      expect(capturedSearchArg().params.filters).toEqual({});
    });

    it('组织范围为空清单时直接返回空页，不退化为不筛选的全库查询', async () => {
      const page = await service.listAdminUsers(listQuery({ accountIds: [] }));

      expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
      // 关键：不得绕过组织范围去查库——那会把「没有可见账号」静默变成「全部账号」
      expect(searchService.search).not.toHaveBeenCalled();
      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('listAdminUsers：分页结果', () => {
    it('items 与 total 取自同一次搜索结果', async () => {
      givenSearchResult(
        searchResult([buildAccount(), buildAccount({ id: 3 })], {
          total: 137,
          page: 2,
          pageSize: 20,
        }),
      );

      const page = await service.listAdminUsers(listQuery({ page: 2 }));

      expect(page.total).toBe(137);
      expect(page.items).toHaveLength(2);
      expect(page.items[0].id).toBe(TARGET_ACCOUNT_ID);
      expect(page.items[1].id).toBe(3);
    });

    it('引擎未回传 page / pageSize 时回落到查询入参', async () => {
      givenSearchResult(
        searchResult([buildAccount()], { total: 1, page: undefined, pageSize: undefined }),
      );

      const page = await service.listAdminUsers(listQuery({ page: 4, pageSize: 10 }));

      expect(page.page).toBe(4);
      expect(page.pageSize).toBe(10);
    });

    const invalidTotals: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['字符串数字', '5'],
      ['null', null],
    ];

    it.each(invalidTotals)('total 为 %s 时失败关闭，不以 0 静默兜底', async (_label, total) => {
      givenSearchResult(searchResult([buildAccount()], { total: total as number | undefined }));

      const error = await service.listAdminUsers(listQuery()).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: { diagnostic: 'SEARCH_TOTAL_MISSING' },
      });
      // 兜底成 0 会让前端把服务端故障渲染成「共 0 条用户」
      expect((error as DomainError).details).toBeUndefined();
    });
  });

  describe('listAdminUsers：稳定 View 整形', () => {
    it('contactEmail 取资料侧 email，与登录凭据 loginEmail 严格区分', async () => {
      givenSearchResult(
        searchResult([
          buildAccount({
            loginEmail: 'login@example.com',
            userInfo: buildUserInfo({ email: 'contact@example.com' }),
          }),
        ]),
      );

      const [view] = (await service.listAdminUsers(listQuery())).items;

      expect(view.loginEmail).toBe('login@example.com');
      expect(view.contactEmail).toBe('contact@example.com');
    });

    it('updatedAt 取账号侧与资料侧的较新值', async () => {
      const accountUpdatedAt = new Date('2026-02-01T00:00:00.000Z');
      const userInfoUpdatedAt = new Date('2026-05-01T00:00:00.000Z');
      givenSearchResult(
        searchResult([
          buildAccount({
            updatedAt: accountUpdatedAt,
            userInfo: buildUserInfo({ updatedAt: userInfoUpdatedAt }),
          }),
        ]),
      );

      const [newerUserInfo] = (await service.listAdminUsers(listQuery())).items;
      expect(newerUserInfo.updatedAt).toEqual(userInfoUpdatedAt);

      givenSearchResult(
        searchResult([
          buildAccount({
            updatedAt: userInfoUpdatedAt,
            userInfo: buildUserInfo({ updatedAt: accountUpdatedAt }),
          }),
        ]),
      );
      const [newerAccount] = (await service.listAdminUsers(listQuery())).items;
      expect(newerAccount.updatedAt).toEqual(userInfoUpdatedAt);
    });

    it('View 不含密码哈希、metaDigest、userState 或任何 ORM Entity 引用', async () => {
      const account = buildAccount();
      givenSearchResult(searchResult([account]));

      const [view] = (await service.listAdminUsers(listQuery())).items;

      expect(Object.keys(view).sort()).toEqual([
        'companyName',
        'contactEmail',
        'createdAt',
        'id',
        'loginEmail',
        'loginName',
        'nickname',
        'phone',
        'role',
        'status',
        'updatedAt',
      ]);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain('should-never-leak');
      expect(serialized).not.toContain('loginPassword');
      expect(serialized).not.toContain('metaDigest');
      expect(serialized).not.toContain('userState');
      expect(view).not.toBe(account);
    });

    it('三源收敛出唯一角色，role 不来自任何单一源字段', async () => {
      givenSearchResult(
        searchResult([
          buildAccount({
            identityHint: IdentityTypeEnum.ENGINEER,
            userInfo: buildUserInfo({
              accessGroup: [IdentityTypeEnum.ENGINEER],
              metaDigest: [IdentityTypeEnum.ENGINEER],
            }),
          }),
        ]),
      );

      const [view] = (await service.listAdminUsers(listQuery())).items;
      expect(view.role).toBe(IdentityTypeEnum.ENGINEER);
    });
  });

  describe('listAdminUsers：整次失败关闭', () => {
    it('资料行缺失即整次查询失败，不返回部分列表', async () => {
      givenSearchResult(
        searchResult([buildAccount(), buildAccount({ id: 3, userInfo: undefined })], { total: 2 }),
      );

      const error = await service.listAdminUsers(listQuery()).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        details: undefined,
        cause: { diagnostic: 'USER_INFO_ROW_MISSING', accountId: 3 },
      });
      // details 会被过滤器原样写进 extensions.details：不得暴露异常账号 ID
      expect(JSON.stringify((error as DomainError).toJSON())).not.toContain('3');
    });

    /**
     * 三源失败的穷举形态，按来源列拆成两张表：`identity_hint` 在 `base_user_account`，
     * `access_group` / `meta_digest` 在 `base_user_info`，两侧不可混填
     * （混填会让覆盖落到不存在的列上、静默测不到目标分支）。
     * reason 取值穷举见 `AccountRoleConvergenceFailureReason`。
     */
    const accountSideFailures: Array<[string, Record<string, unknown>, string]> = [
      ['identity_hint 为 null', { identityHint: null }, 'IDENTITY_HINT_MISSING'],
      ['identity_hint 为空串', { identityHint: '' }, 'IDENTITY_HINT_MISSING'],
      ['identity_hint 非法枚举', { identityHint: 'admin' }, 'IDENTITY_HINT_INVALID'],
      [
        'identity_hint 是小写合法角色（不做大小写归一）',
        { identityHint: 'engineer' },
        'IDENTITY_HINT_INVALID',
      ],
    ];

    const infoSideFailures: Array<[string, Record<string, unknown>, string]> = [
      ['access_group 是密文字符串', { accessGroup: CIPHER_TEXT }, 'ACCESS_GROUP_NOT_ARRAY'],
      ['access_group 为空数组', { accessGroup: [] }, 'ACCESS_GROUP_EMPTY'],
      [
        'access_group 多角色',
        { accessGroup: [IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER] },
        'ACCESS_GROUP_MULTI_ROLE',
      ],
      ['access_group 成员非法', { accessGroup: ['admin'] }, 'ACCESS_GROUP_INVALID_MEMBER'],
      ['meta_digest 缺失', { metaDigest: null }, 'META_DIGEST_MISSING'],
      ['meta_digest 是密文字符串', { metaDigest: CIPHER_TEXT }, 'META_DIGEST_NOT_ARRAY'],
      ['meta_digest 为空数组', { metaDigest: [] }, 'META_DIGEST_EMPTY'],
      ['meta_digest 多角色', { metaDigest: ['ENGINEER', 'CUSTOMER'] }, 'META_DIGEST_MULTI_ROLE'],
      ['meta_digest 成员非法', { metaDigest: ['admin'] }, 'META_DIGEST_INVALID_MEMBER'],
      ['三源不一致', { metaDigest: [IdentityTypeEnum.ENGINEER] }, 'SOURCES_INCONSISTENT'],
    ];

    const assertConvergenceFailure = (error: unknown, reason: string): void => {
      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
        message: '用户账号数据异常，暂时无法加载用户信息',
        details: undefined,
        cause: {
          diagnostic: 'ROLE_CONVERGENCE_FAILED',
          accountId: TARGET_ACCOUNT_ID,
          reason,
        },
      });
      // 三源原值与失败原因只进 cause（过滤器不序列化 cause），不进对外响应
      const serializedForClient = JSON.stringify((error as DomainError).toJSON());
      expect(serializedForClient).not.toContain(CIPHER_TEXT);
      expect(serializedForClient).not.toContain(reason);
    };

    it.each(accountSideFailures)(
      '%s 时整次查询失败关闭为 ROLE_DATA_INCONSISTENT',
      async (_label, accountOverrides, reason) => {
        givenSearchResult(searchResult([buildAccount(accountOverrides)], { total: 1 }));

        const error = await service.listAdminUsers(listQuery()).then(
          () => null,
          (thrown: unknown) => thrown,
        );

        assertConvergenceFailure(error, reason);
      },
    );

    it.each(infoSideFailures)(
      '%s 时整次查询失败关闭为 ROLE_DATA_INCONSISTENT',
      async (_label, userInfoOverrides, reason) => {
        givenSearchResult(
          searchResult([buildAccount({ userInfo: buildUserInfo(userInfoOverrides) })], {
            total: 1,
          }),
        );

        const error = await service.listAdminUsers(listQuery()).then(
          () => null,
          (thrown: unknown) => thrown,
        );

        assertConvergenceFailure(error, reason);
      },
    );

    it('异常行在列表末尾时同样整次失败，不存在「前几行已返回」的部分成功', async () => {
      const healthy = [buildAccount({ id: 10 }), buildAccount({ id: 11 })];
      givenSearchResult(
        searchResult([...healthy, buildAccount({ id: 12, userInfo: undefined })], { total: 3 }),
      );

      await expect(service.listAdminUsers(listQuery())).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
      });
    });

    it('搜索引擎异常收敛为 READ_FAILED 且丢弃 details，原始异常只留在 cause', async () => {
      const engineError = new DomainError(
        'DB_QUERY_FAILED',
        '查询执行失败',
        // 引擎会把底层数据库错误文本放进 details，而过滤器会把 details 写进 extensions
        {
          sql: 'SELECT * FROM base_user_account WHERE login_password = ?',
          driverMessage: 'ER_PARSE_ERROR near SELECT',
        },
      );
      (searchService.search as jest.Mock).mockRejectedValue(engineError);

      const error = await service.listAdminUsers(listQuery()).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        message: '用户列表读取失败，请稍后重试',
        details: undefined,
      });
      // 不被引擎错误码穿透，否则用例层针对收敛失败的专门日志分支会失效
      expect((error as DomainError).code).not.toBe('DB_QUERY_FAILED');
      expect((error as DomainError).cause).toBe(engineError);
    });

    it('映射阶段的领域异常原样冒泡，不被引擎 catch 重包为 READ_FAILED', async () => {
      givenSearchResult(searchResult([buildAccount({ userInfo: undefined })], { total: 1 }));

      const error = await service.listAdminUsers(listQuery()).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect((error as DomainError).code).toBe(ADMIN_USER_ERROR.READ_FAILED);
      // 若被外层 catch 重包，cause 会变成 DomainError 而不是结构化诊断对象
      expect((error as DomainError).cause).toEqual({
        diagnostic: 'USER_INFO_ROW_MISSING',
        accountId: TARGET_ACCOUNT_ID,
      });
    });
  });

  describe('findAdminUserViewById', () => {
    it('无事务时走注入的 repository，按主键 + 资料关系读取', async () => {
      (accountRepository.findOne as jest.Mock).mockResolvedValue(buildAccount());

      const view = await service.findAdminUserViewById({ accountId: TARGET_ACCOUNT_ID });

      expect(view).toMatchObject({ id: TARGET_ACCOUNT_ID, role: IdentityTypeEnum.CUSTOMER });
      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { id: TARGET_ACCOUNT_ID },
        relations: { userInfo: true },
      });
    });

    it('账号不存在返回 null（由 Usecase 决定错误口径），不抛错', async () => {
      (accountRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findAdminUserViewById({ accountId: 999 })).resolves.toBeNull();
    });

    it('传入事务上下文时改读事务 EntityManager 的 repository，不读注入的 repository', async () => {
      const txRepository = {
        findOne: jest.fn().mockResolvedValue(buildAccount({ id: 7 })),
      } as unknown as Repository<AccountEntity>;
      const { transactionContext, manager } = createTransactionContext(txRepository);

      const view = await service.findAdminUserViewById({
        accountId: 7,
        transactionContext,
      });

      expect(view).toMatchObject({ id: 7 });
      expect(manager.getRepository).toHaveBeenCalledWith(AccountEntity);
      expect(txRepository.findOne).toHaveBeenCalledTimes(1);
      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });

    it('伪造的事务上下文失败关闭为 READ_FAILED，不回退到已提交数据', async () => {
      const forged = { fakeTx: 'forged' } as unknown as PersistenceTransactionContext;

      await expect(
        service.findAdminUserViewById({ accountId: TARGET_ACCOUNT_ID, transactionContext: forged }),
      ).rejects.toMatchObject({ code: ADMIN_USER_ERROR.READ_FAILED });

      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });

    it('资料行缺失时失败关闭，不当作「查无此人」', async () => {
      (accountRepository.findOne as jest.Mock).mockResolvedValue(
        buildAccount({ userInfo: undefined }),
      );

      await expect(
        service.findAdminUserViewById({ accountId: TARGET_ACCOUNT_ID }),
      ).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: { diagnostic: 'USER_INFO_ROW_MISSING', accountId: TARGET_ACCOUNT_ID },
      });
    });

    it('三源不收敛时失败关闭为 ROLE_DATA_INCONSISTENT（写后回读同样拒绝）', async () => {
      (accountRepository.findOne as jest.Mock).mockResolvedValue(
        buildAccount({
          userInfo: buildUserInfo({ metaDigest: [IdentityTypeEnum.ENGINEER] }),
        }),
      );

      await expect(
        service.findAdminUserViewById({ accountId: TARGET_ACCOUNT_ID }),
      ).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
        cause: { diagnostic: 'ROLE_CONVERGENCE_FAILED', reason: 'SOURCES_INCONSISTENT' },
      });
    });

    it('repository 抛非领域异常时收敛为 READ_FAILED，原始异常只留在 cause', async () => {
      const driverError = Object.assign(new Error('ER_CONN_LOST: Connection lost'), {
        name: 'QueryFailedError',
        driverError: { errno: 2013 },
      });
      (accountRepository.findOne as jest.Mock).mockRejectedValue(driverError);

      const error = await service.findAdminUserViewById({ accountId: TARGET_ACCOUNT_ID }).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        message: '用户账号读取失败，请稍后重试',
        details: undefined,
      });
      expect((error as DomainError).cause).toBe(driverError);
    });
  });

  describe('findAdminUserStatusFacts', () => {
    it('只返回两个状态字段的窄事实，不含身份或资料字段', async () => {
      (accountRepository.findOne as jest.Mock).mockResolvedValue(
        buildAccount({
          status: AccountStatus.INACTIVE,
          userInfo: buildUserInfo({ userState: UserState.INACTIVE }),
        }),
      );

      const facts = await service.findAdminUserStatusFacts({ accountId: TARGET_ACCOUNT_ID });

      expect(facts).toEqual({
        accountStatus: AccountStatus.INACTIVE,
        userState: UserState.INACTIVE,
      });
      expect(Object.keys(facts ?? {}).sort()).toEqual(['accountStatus', 'userState']);
    });

    it.each([
      ['账号行缺失', null],
      ['资料行缺失', buildAccount({ userInfo: undefined })],
    ])('%s 时返回 null（由 Usecase 决定错误口径）', async (_label, account) => {
      (accountRepository.findOne as jest.Mock).mockResolvedValue(account);

      await expect(
        service.findAdminUserStatusFacts({ accountId: TARGET_ACCOUNT_ID }),
      ).resolves.toBeNull();
    });

    it('双字段不一致时如实返回两个值，不在读侧修数据', async () => {
      (accountRepository.findOne as jest.Mock).mockResolvedValue(
        buildAccount({
          status: AccountStatus.ACTIVE,
          userInfo: buildUserInfo({ userState: UserState.INACTIVE }),
        }),
      );

      await expect(
        service.findAdminUserStatusFacts({ accountId: TARGET_ACCOUNT_ID }),
      ).resolves.toEqual({
        accountStatus: AccountStatus.ACTIVE,
        userState: UserState.INACTIVE,
      });
    });

    it('传入事务上下文时读事务 EntityManager，供写入前在同一事务内裁决', async () => {
      const txRepository = {
        findOne: jest.fn().mockResolvedValue(buildAccount()),
      } as unknown as Repository<AccountEntity>;
      const { transactionContext, manager } = createTransactionContext(txRepository);

      await service.findAdminUserStatusFacts({
        accountId: TARGET_ACCOUNT_ID,
        transactionContext,
      });

      expect(manager.getRepository).toHaveBeenCalledWith(AccountEntity);
      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });

    it('非领域异常收敛为 READ_FAILED，不把驱动错误文本上行', async () => {
      (accountRepository.findOne as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded'), {
          name: 'QueryFailedError',
          driverError: { errno: 1205 },
        }),
      );

      const error = await service.findAdminUserStatusFacts({ accountId: TARGET_ACCOUNT_ID }).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        details: undefined,
      });
      expect(JSON.stringify((error as DomainError).details ?? null)).not.toContain(
        'ER_LOCK_WAIT_TIMEOUT',
      );
    });
  });

  describe('findAdminUserCredentialConflict', () => {
    it('两维都空闲时返回 null', async () => {
      await expect(
        service.findAdminUserCredentialConflict({
          loginName: 'new_user',
          loginEmail: 'new@example.com',
        }),
      ).resolves.toBeNull();

      expect(accountRepository.existsBy).toHaveBeenCalledTimes(2);
      expect(accountRepository.existsBy).toHaveBeenNthCalledWith(1, { loginName: 'new_user' });
      expect(accountRepository.existsBy).toHaveBeenNthCalledWith(2, {
        loginEmail: 'new@example.com',
      });
    });

    it('登录名被占用时返回 loginName，且不再查询登录邮箱（一次只提示一个原因）', async () => {
      (accountRepository.existsBy as jest.Mock).mockResolvedValueOnce(true);

      await expect(
        service.findAdminUserCredentialConflict({
          loginName: 'taken_user',
          loginEmail: 'new@example.com',
        }),
      ).resolves.toBe('loginName');

      expect(accountRepository.existsBy).toHaveBeenCalledTimes(1);
    });

    it('两维都被占用时优先返回 loginName，不同时暴露两个已占用账号', async () => {
      (accountRepository.existsBy as jest.Mock).mockResolvedValue(true);

      await expect(
        service.findAdminUserCredentialConflict({
          loginName: 'taken_user',
          loginEmail: 'taken@example.com',
        }),
      ).resolves.toBe('loginName');

      expect(accountRepository.existsBy).toHaveBeenCalledTimes(1);
    });

    it('登录名空闲而登录邮箱被占用时返回 loginEmail', async () => {
      (accountRepository.existsBy as jest.Mock)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await expect(
        service.findAdminUserCredentialConflict({
          loginName: 'new_user',
          loginEmail: 'taken@example.com',
        }),
      ).resolves.toBe('loginEmail');

      expect(accountRepository.existsBy).toHaveBeenCalledTimes(2);
    });

    const partialCredentials: Array<
      [
        string,
        { loginName: string | null; loginEmail: string | null },
        { loginName?: string; loginEmail?: string },
      ]
    > = [
      [
        '登录名为 null',
        { loginName: null, loginEmail: 'new@example.com' },
        { loginEmail: 'new@example.com' },
      ],
      ['登录邮箱为 null', { loginName: 'new_user', loginEmail: null }, { loginName: 'new_user' }],
    ];

    it.each(partialCredentials)('%s 时只查已填维度', async (_label, params, expectedWhere) => {
      await expect(service.findAdminUserCredentialConflict(params)).resolves.toBeNull();

      expect(accountRepository.existsBy).toHaveBeenCalledTimes(1);
      expect(accountRepository.existsBy).toHaveBeenCalledWith(expectedWhere);
    });

    it('两维都为 null 时不查询数据库直接返回 null', async () => {
      await expect(
        service.findAdminUserCredentialConflict({ loginName: null, loginEmail: null }),
      ).resolves.toBeNull();

      expect(accountRepository.existsBy).not.toHaveBeenCalled();
    });

    it('existsBy 失败时收敛为 READ_FAILED，不按「可用」放行', async () => {
      (accountRepository.existsBy as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ER_DUP_ENTRY: Duplicate entry'), {
          name: 'QueryFailedError',
          driverError: { errno: 1062 },
        }),
      );

      const error = await service
        .findAdminUserCredentialConflict({ loginName: 'new_user', loginEmail: null })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        message: '登录凭据可用性检查失败，请稍后重试',
        details: undefined,
      });
    });

    it('预检查不替代唯一索引：并发命中由 insertAccount 收敛，本方法不做加锁读取', async () => {
      await service.findAdminUserCredentialConflict({
        loginName: 'new_user',
        loginEmail: 'new@example.com',
      });

      expect(accountRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });
  });
});

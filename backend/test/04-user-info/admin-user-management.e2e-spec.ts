// test/04-user-info/admin-user-management.e2e-spec.ts
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { OrganizationMembershipEntity } from '../../src/modules/lithography/entities/organization-membership.entity';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import {
  buildSuiteOrganizationCodes,
  requireOrganizationId,
  seedTestMemberships,
  seedTestOrganizations,
} from '../utils/test-organizations';

/**
 * P2-1B：管理员用户管理五个 GraphQL 操作（adminUsers + 四个写操作）的真实 MySQL E2E。
 *
 * 与定向单测（`src/usecases/account/*.spec.ts` / `src/modules/account/queries/*.spec.ts`）的分工：
 * - 单测断言**协作契约**（写入顺序、事务边界、单元素数组、盐口径、日志脱敏）；
 * - 本文件断言**跨进程可观察事实**：三源角色列在真实数据库里确实一致、双字段状态确实同步、
 *   重置后的密码确实能通过公开登录入口验证、错误确实以契约大类出现在 `extensions.code` 上。
 *
 * 造数纪律：
 * - 全部写入只走 GraphQL 业务入口，不直接改库绕过 Usecase；数据库只用于**只读核验**；
 * - 只 seed 三源可收敛的账号（`accessGroup` 恰为单元素）；`emptyRoles` / `staffGuest` /
 *   `hybridStaff` 的多元素或空 `access_group` 会让 `adminUsers` 整次失败关闭，故不在本文件 seed；
 * - 会改变账号事实的用例尽量自建幂等前置并在结尾恢复；两处**已知且刻意**的组内顺序依赖：
 *   「创建用户」的唯一性冲突用例依赖同组先创建出被冲突的账号；「资料编辑」会永久改写
 *   `guestPrimary` 的昵称/公司/电话/联系邮箱且不恢复——因此列表的昵称维度刻意改用全程
 *   只读的 `staffPrimary`。跨 describe 仍可任意调序或单独 `.only`。
 * - `SUPER_ADMIN` 目标只读保护在 E2E 上有一处不可达：本文件只 seed 一个 SUPER_ADMIN，
 *   它同时是发起方自己，故 `adminSetUserStatus` 命中的是「不能停用自己」这条先行显式拒绝，
 *   而非目标保护分支（其余写操作命中的是真·目标保护）。补齐它需要第二个 SUPER_ADMIN，
 *   而改 Seed 与直接改库都在禁止清单内，故该分支由
 *   `src/usecases/account/admin-set-user-status.usecase.spec.ts` 覆盖，不在此违规造数。
 * - 同理，「资料缺失或三源无法收敛时整次查询失败关闭」需要脏行才能触发，而造脏行只能
 *   绕过业务入口直接改库，故该分支由 `admin-user.query.service.spec.ts` 覆盖，不在本文件重现。
 *
 * 角色口径：普通用户角色只在管理员创建账号时单选一次，创建后角色只读；
 * 不存在任何公开角色修改 Mutation（`adminChangeUserRole` / `updateAccessGroup` 均已下线），
 * 角色只作列表展示与筛选。
 */

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string; details?: unknown };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type AdminUserPayload = {
  id: number;
  loginName: string | null;
  loginEmail: string | null;
  nickname: string;
  companyName: string | null;
  phone: string | null;
  contactEmail: string | null;
  role: IdentityTypeEnum;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
};

type AdminUserListPayload = {
  items: AdminUserPayload[];
  total: number;
  page: number;
  pageSize: number;
};

type ResetPasswordPayload = { accountId: number; isUpdated: boolean; notice: string };

type SchemaRootPayload = {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __schema?: {
    mutationType?: { fields?: Array<{ name: string }> } | null;
    queryType?: { fields?: Array<{ name: string }> } | null;
  };
};

/** 闭包表执行结果：`[operation, extensions.code, extensions.errorCode, extensions.details]` */
type CollectedErrors = Array<[string, string | undefined, string | undefined, unknown]>;

/** DTO 字段清单（列表与写后读共用同一形态，集中一处避免各用例字段漂移） */
const ADMIN_USER_FIELDS =
  'id loginName loginEmail nickname companyName phone contactEmail role status createdAt updatedAt';

const ADMIN_USERS_QUERY = `
  query AdminUsers(
    $pagination: PaginationArgs!
    $keyword: String
    $role: IdentityTypeEnum
    $status: AccountStatus
  ) {
    adminUsers(pagination: $pagination, keyword: $keyword, role: $role, status: $status) {
      items { ${ADMIN_USER_FIELDS} }
      total
      page
      pageSize
    }
  }
`;

const ADMIN_CREATE_USER_MUTATION = `
  mutation AdminCreateUser($input: AdminCreateUserInput!) {
    adminCreateUser(input: $input) { ${ADMIN_USER_FIELDS} }
  }
`;

const ADMIN_UPDATE_USER_PROFILE_MUTATION = `
  mutation AdminUpdateUserProfile($input: AdminUpdateUserProfileInput!) {
    adminUpdateUserProfile(input: $input) { ${ADMIN_USER_FIELDS} }
  }
`;

const ADMIN_SET_USER_STATUS_MUTATION = `
  mutation AdminSetUserStatus($input: AdminSetUserStatusInput!) {
    adminSetUserStatus(input: $input) { ${ADMIN_USER_FIELDS} }
  }
`;

const ADMIN_RESET_USER_PASSWORD_MUTATION = `
  mutation AdminResetUserPassword($input: AdminResetUserPasswordInput!) {
    adminResetUserPassword(input: $input) { accountId isUpdated notice }
  }
`;

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) { accessToken }
  }
`;

const USER_INFO_QUERY = `
  query UserInfo($id: Int!) { userInfo(accountId: $id) { nickname } }
`;

const SCHEMA_ROOT_QUERY = `
  query SchemaRoot {
    __schema {
      mutationType { fields { name } }
      queryType { fields { name } }
    }
  }
`;

/** 管理员写操作全清单（授权准入与错误契约用例共用同一枚举，避免漏测某个 operation） */
const ADMIN_WRITE_MUTATIONS = [
  'adminCreateUser',
  'adminUpdateUserProfile',
  'adminSetUserStatus',
  'adminResetUserPassword',
] as const;

/** 创建路径专用账号：与 seed 账号名不重叠，便于按登录名做确定性计数 */
const CREATED_LOGIN_NAME = 'e2ecreatedengineer';
const CREATED_LOGIN_EMAIL = 'e2e.created.engineer@example.com';
const CREATED_INITIAL_PASSWORD = 'E2eNewUser@2026';

/** 只提供登录邮箱的创建路径专用账号（登录名列为 NULL） */
const EMAIL_ONLY_LOGIN_EMAIL = 'e2e.email.only@example.com';
const EMAIL_ONLY_INITIAL_PASSWORD = 'E2eEmailOnly@2026';

const RESET_NEW_PASSWORD = 'E2eResetPwd@2027';
const RESET_INACTIVE_PASSWORD = 'E2eInactivePwd@2028';

/** 必然不存在的账号 ID：用于核验 not-found 不塌缩为 UNAUTHENTICATED */
const MISSING_ACCOUNT_ID = 2147483000;

/**
 * 授权准入用例的探测凭据。
 * 被 Guard 拒绝的调用不得留下任何账号行，故这两个值在用例结尾用于反证「零写入」。
 */
const FORBIDDEN_PROBE_LOGIN_NAME = 'e2eforbiddenprobe';
const FORBIDDEN_PROBE_LOGIN_EMAIL = 'e2e.forbidden.probe@example.com';

const DEFAULT_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 20 };

describe('管理员用户管理 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let previousIntrospectionEnabled: string | undefined;

  let adminToken: string;
  /** CUSTOMER 会话：授权准入用例的拒绝方，自身账号事实不被本文件修改 */
  let guestToken: string;
  /** ENGINEER 会话：授权准入用例的拒绝方，自身账号事实不被本文件修改 */
  let staffToken: string;

  let adminAccountId: number;
  let guestAccountId: number;
  let guestSecondaryAccountId: number;

  // 规格专属测试组织（不借用开发库默认组织；编码带 E2E 前缀，清理以编码为界）
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('ADMUSER');
  let primaryOrganizationId = 0;
  const ownership = createOwnedResourceLedger();

  beforeAll(async () => {
    // E2E 基线默认关闭 introspection；本 spec 只在 API 初始化期间临时开启，用于核验公开契约面，
    // 不修改任何 .env / Entity / Migration / schema 产物。
    previousIntrospectionEnabled = process.env.GRAPHQL_INTROSPECTION_ENABLED;
    process.env.GRAPHQL_INTROSPECTION_ENABLED = 'true';
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);

    // 预清理（窄范围）：组织与账号均按完整指纹核验；不接管同名异主残留
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: [
          {
            organizationCode: suiteOrganizationCodes.primary,
            name: 'E2E 甲方组织（账号管理）',
            kind: 'CLIENT',
          },
        ],
        accounts: [
          testAccountsConfig.admin,
          testAccountsConfig.guestPrimary,
          testAccountsConfig.guestSecondary,
          testAccountsConfig.staffPrimary,
          testAccountsConfig.staffSecondary,
        ]
          .map(toResidueAccountFingerprint)
          .concat(
            {
              loginName: CREATED_LOGIN_NAME,
              loginEmail: CREATED_LOGIN_EMAIL,
              status: AccountStatus.ACTIVE,
              identityHint: IdentityTypeEnum.ENGINEER,
              nickname: 'E2E 新建工程师',
              accessGroup: [IdentityTypeEnum.ENGINEER],
            },
            {
              loginName: null,
              loginEmail: EMAIL_ONLY_LOGIN_EMAIL,
              status: AccountStatus.ACTIVE,
              identityHint: IdentityTypeEnum.CUSTOMER,
              nickname: 'E2E 仅邮箱账号',
              accessGroup: [IdentityTypeEnum.CUSTOMER],
            },
          ),
      },
      helper: 'admin-user-management.e2e-spec beforeAll 预清理',
    });
    await seedTestAccounts({
      dataSource,
      includeKeys: ['admin', 'guestPrimary', 'guestSecondary', 'staffPrimary', 'staffSecondary'],
      ownership,
    });

    // 管理员创建工程师时绑定其当前可信组织（S2c）：管理员必须先有 ACTIVE 成员关系
    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: 'E2E 甲方组织（账号管理）',
          kind: 'CLIENT',
        },
      ],
      ownership,
    });
    primaryOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
    await seedTestMemberships({
      dataSource,
      organizationIdsByCode: organizationIds,
      ownership,
      memberships: [
        {
          accountLoginName: testAccountsConfig.admin.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'SUPER_ADMIN',
        },
      ],
    });

    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    guestToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
    staffToken = await login({
      app,
      loginName: testAccountsConfig.staffPrimary.loginName,
      loginPassword: testAccountsConfig.staffPrimary.loginPassword,
    });

    adminAccountId = await getAccountIdByLoginName(dataSource, testAccountsConfig.admin.loginName);
    guestAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.guestPrimary.loginName,
    );
    guestSecondaryAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.guestSecondary.loginName,
    );
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (dataSource?.isInitialized) {
          // 收尾只删除本轮登记的真实 ID；清理失败向 jest 传播，不吞错
          await runGuardedSpecCleanup({
            dataSource,
            owned: ownership,
            helper: 'admin-user-management.e2e-spec afterAll 收尾',
          });
        }
      },
      finalize: () => {
        if (previousIntrospectionEnabled === undefined) {
          delete process.env.GRAPHQL_INTROSPECTION_ENABLED;
        } else {
          process.env.GRAPHQL_INTROSPECTION_ENABLED = previousIntrospectionEnabled;
        }
      },
      closeApp: app ? async () => await app.close() : null,
    });
  });

  // ---------------------------------------------------------------------------
  // GraphQL 执行与断言 helper
  // ---------------------------------------------------------------------------

  /**
   * 统一执行入口。
   * 业务错误经全局过滤器渲染为 HTTP 200 + `errors[]`，协议级校验失败可能是 400，
   * 故这里不预设单一状态码，由各用例断言 `data` / `errors` 本身。
   */
  const gql = async <T>(params: {
    query: string;
    variables?: unknown;
    token?: string;
  }): Promise<GqlBody<T>> => {
    const response = await postGql({
      app,
      query: params.query,
      variables: params.variables,
      token: params.token,
    }).expect((res) => {
      expect([200, 400]).toContain(res.status);
    });
    return response.body as GqlBody<T>;
  };

  /**
   * 五个 operation 的调用入口：`token` 一律为**必填首参**，刻意不提供 `?? adminToken` 默认值。
   *
   * 授权类用例一旦漏传 token 就会静默以管理员身份执行，把「应被拒绝」变成「成功」，
   * 而失败信息只表现为 code 不匹配，极难定位到「token 没传」这个真因；
   * 提为必填首参后，漏传即编译错误。
   */
  const listAdminUsers = (
    token: string,
    params?: {
      pagination?: Record<string, unknown>;
      keyword?: string;
      role?: IdentityTypeEnum;
      status?: AccountStatus;
    },
  ): Promise<GqlBody<{ adminUsers?: AdminUserListPayload }>> =>
    gql({
      query: ADMIN_USERS_QUERY,
      variables: {
        pagination: params?.pagination ?? DEFAULT_PAGINATION,
        keyword: params?.keyword,
        role: params?.role,
        status: params?.status,
      },
      token,
    });

  const createUser = (
    token: string,
    input: Record<string, unknown>,
  ): Promise<GqlBody<{ adminCreateUser?: AdminUserPayload }>> =>
    gql({
      query: ADMIN_CREATE_USER_MUTATION,
      variables: { input },
      token,
    });

  const updateUserProfile = (
    token: string,
    input: Record<string, unknown>,
  ): Promise<GqlBody<{ adminUpdateUserProfile?: AdminUserPayload }>> =>
    gql({
      query: ADMIN_UPDATE_USER_PROFILE_MUTATION,
      variables: { input },
      token,
    });

  const setUserStatus = (
    token: string,
    input: Record<string, unknown>,
  ): Promise<GqlBody<{ adminSetUserStatus?: AdminUserPayload }>> =>
    gql({
      query: ADMIN_SET_USER_STATUS_MUTATION,
      variables: { input },
      token,
    });

  const resetUserPassword = (
    token: string,
    input: Record<string, unknown>,
  ): Promise<GqlBody<{ adminResetUserPassword?: ResetPasswordPayload }>> =>
    gql({
      query: ADMIN_RESET_USER_PASSWORD_MUTATION,
      variables: { input },
      token,
    });

  const attemptLogin = (
    loginName: string,
    loginPassword: string,
  ): Promise<GqlBody<{ login?: { accessToken?: string } }>> =>
    gql({
      query: LOGIN_MUTATION,
      variables: {
        input: {
          loginName,
          loginPassword,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
        },
      },
    });

  const expectSingleError = (body: GqlBody<unknown>, code: string, errorCode?: string): void => {
    expect(body.errors).toBeDefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.extensions?.code).toBe(code);
    if (errorCode !== undefined) {
      expect(body.errors?.[0]?.extensions?.errorCode).toBe(errorCode);
    }
  };

  // ---------------------------------------------------------------------------
  // 数据库只读核验 helper（本文件不通过这些入口写入）
  // ---------------------------------------------------------------------------

  const readAccountRow = (accountId: number): Promise<AccountEntity | null> =>
    dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } });

  const readUserInfoRow = (accountId: number): Promise<UserInfoEntity | null> =>
    dataSource.getRepository(UserInfoEntity).findOne({ where: { accountId } });

  /** 角色三源：`identity_hint` / `access_group` / `meta_digest`（后者由订阅者解密为数组） */
  const readRoleSources = async (
    accountId: number,
  ): Promise<{ identityHint: string | null; accessGroup: unknown; metaDigest: unknown }> => {
    const account = await readAccountRow(accountId);
    const userInfo = await readUserInfoRow(accountId);
    return {
      identityHint: account?.identityHint ?? null,
      accessGroup: userInfo?.accessGroup ?? null,
      metaDigest: userInfo?.metaDigest ?? null,
    };
  };

  /** 状态双字段：`account.status` / `userInfo.user_state` */
  const readDualStatus = async (
    accountId: number,
  ): Promise<{ accountStatus: AccountStatus | null; userState: UserState | null }> => {
    const account = await readAccountRow(accountId);
    const userInfo = await readUserInfoRow(accountId);
    return {
      accountStatus: account?.status ?? null,
      userState: userInfo?.userState ?? null,
    };
  };

  const countAccounts = (where: Record<string, unknown>): Promise<number> =>
    dataSource.getRepository(AccountEntity).count({ where });

  /** 幂等自建前置：同状态时 Usecase 零写入，故可无条件调用 */
  const ensureStatus = async (accountId: number, status: AccountStatus): Promise<void> => {
    const body = await setUserStatus(adminToken, { accountId, status });
    expect(body.errors).toBeUndefined();
    expect(body.data?.adminSetUserStatus?.status).toBe(status);
  };

  /**
   * 五个管理员 operation 的调用闭包表：授权准入用例共用，避免漏测某个 operation。
   * token 位于首参且无默认值，确保「谁在调用」在用例里一目了然。
   */
  const allAdminOperations = (params: {
    token: string;
    targetAccountId: number;
  }): Array<[string, () => Promise<GqlBody<unknown>>]> => [
    ['adminUsers', () => listAdminUsers(params.token)],
    [
      'adminCreateUser',
      () =>
        createUser(params.token, {
          loginName: FORBIDDEN_PROBE_LOGIN_NAME,
          loginEmail: FORBIDDEN_PROBE_LOGIN_EMAIL,
          initialPassword: CREATED_INITIAL_PASSWORD,
          role: IdentityTypeEnum.CUSTOMER,
          nickname: '准入探测',
        }),
    ],
    [
      'adminUpdateUserProfile',
      () =>
        updateUserProfile(params.token, {
          accountId: params.targetAccountId,
          nickname: '准入探测昵称',
        }),
    ],
    [
      'adminSetUserStatus',
      () =>
        setUserStatus(params.token, {
          accountId: params.targetAccountId,
          status: AccountStatus.INACTIVE,
        }),
    ],
    [
      'adminResetUserPassword',
      () =>
        resetUserPassword(params.token, {
          accountId: params.targetAccountId,
          newPassword: RESET_NEW_PASSWORD,
        }),
    ],
  ];

  /** 三个写操作对不存在目标的调用闭包表 */
  const missingTargetOperations = (): Array<[string, () => Promise<GqlBody<unknown>>]> => [
    [
      'adminUpdateUserProfile',
      () =>
        updateUserProfile(adminToken, { accountId: MISSING_ACCOUNT_ID, nickname: '不存在目标' }),
    ],
    [
      'adminSetUserStatus',
      () =>
        setUserStatus(adminToken, {
          accountId: MISSING_ACCOUNT_ID,
          status: AccountStatus.INACTIVE,
        }),
    ],
    [
      'adminResetUserPassword',
      () =>
        resetUserPassword(adminToken, {
          accountId: MISSING_ACCOUNT_ID,
          newPassword: RESET_NEW_PASSWORD,
        }),
    ],
  ];

  /**
   * 顺序执行闭包表并收集 `[operation, code, errorCode, details]`。
   * 用数组比对而非逐个断言：失败信息能直接定位到具体 operation，而不是「某个 code 不对」。
   */
  const collectErrors = async (
    operations: Array<[string, () => Promise<GqlBody<unknown>>]>,
  ): Promise<CollectedErrors> => {
    const collected: CollectedErrors = [];
    for (const [name, run] of operations) {
      const body = await run();
      collected.push([
        name,
        body.errors?.[0]?.extensions?.code,
        body.errors?.[0]?.extensions?.errorCode,
        body.errors?.[0]?.extensions?.details,
      ]);
    }
    return collected;
  };

  // ---------------------------------------------------------------------------
  // 授权准入
  // ---------------------------------------------------------------------------

  describe('授权准入（CUSTOMER / ENGINEER 全部拒绝）', () => {
    const unauthorizedSessions: Array<[string, () => string]> = [
      ['CUSTOMER', () => guestToken],
      ['ENGINEER', () => staffToken],
    ];

    it.each(unauthorizedSessions)(
      '%s 会话调用全部五个管理员接口均返回 FORBIDDEN 且不产生任何写入',
      async (_label, tokenOf) => {
        const operations = allAdminOperations({
          token: tokenOf(),
          targetAccountId: guestSecondaryAccountId,
        });
        const collected = await collectErrors(operations);

        expect(collected.map(([name, code]) => [name, code])).toEqual(
          operations.map(([name]) => [name, 'FORBIDDEN']),
        );
        // 拒绝发生在任何写入之前：准入探测用的凭据不得落库
        expect(await countAccounts({ loginName: FORBIDDEN_PROBE_LOGIN_NAME })).toBe(0);
        expect(await countAccounts({ loginEmail: FORBIDDEN_PROBE_LOGIN_EMAIL })).toBe(0);
        // 目标账号的状态双字段与角色三源零变化
        expect(await readDualStatus(guestSecondaryAccountId)).toEqual({
          accountStatus: AccountStatus.ACTIVE,
          userState: UserState.ACTIVE,
        });
        expect(await readRoleSources(guestSecondaryAccountId)).toEqual({
          identityHint: IdentityTypeEnum.CUSTOMER,
          accessGroup: [IdentityTypeEnum.CUSTOMER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
        });
      },
    );

    it('未携带 Token 调用 adminUsers 返回 UNAUTHENTICATED（不误报 FORBIDDEN）', async () => {
      const body = await gql<{ adminUsers?: unknown }>({
        query: ADMIN_USERS_QUERY,
        variables: { pagination: DEFAULT_PAGINATION },
      });
      expectSingleError(body, 'UNAUTHENTICATED');
      expect(body.data?.adminUsers).toBeFalsy();
    });
  });

  // ---------------------------------------------------------------------------
  // 列表查询
  // ---------------------------------------------------------------------------

  describe('列表查询 adminUsers', () => {
    it('SUPER_ADMIN 成功查询列表：seed 账号全部可见、分页字段自洽、口令哈希不外泄', async () => {
      const body = await listAdminUsers(adminToken);
      expect(body.errors).toBeUndefined();
      const page = body.data?.adminUsers;
      expect(page).toBeDefined();
      expect(page?.page).toBe(1);
      expect(page?.pageSize).toBe(20);
      // 账号总量远小于 pageSize，故 items 与 total 必须同源于同一次查询
      expect(page?.items.length ?? 0).toBe(page?.total ?? -1);
      expect(page?.total ?? 0).toBeGreaterThanOrEqual(5);

      const loginNames = (page?.items ?? []).map((item) => item.loginName);
      expect(loginNames).toEqual(
        expect.arrayContaining([
          testAccountsConfig.admin.loginName,
          testAccountsConfig.guestPrimary.loginName,
          testAccountsConfig.guestSecondary.loginName,
          testAccountsConfig.staffPrimary.loginName,
          testAccountsConfig.staffSecondary.loginName,
        ]),
      );

      // DTO 形态与契约一致，且 role / status 均为已注册枚举成员
      const dtoKeys = [
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
      ];
      for (const item of page?.items ?? []) {
        expect(Object.keys(item).sort()).toEqual(dtoKeys);
        expect(Object.values(IdentityTypeEnum)).toContain(item.role);
        expect(Object.values(AccountStatus)).toContain(item.status);
      }

      // 口令哈希不得以任何形式出现在响应体里
      const adminRow = await readAccountRow(adminAccountId);
      expect(adminRow?.loginPassword).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain(adminRow?.loginPassword ?? '__absent__');
    });

    it('排序契约固定为 created_at DESC, id DESC（客户端不可改）', async () => {
      const body = await listAdminUsers(adminToken, {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 100 },
      });
      const items = body.data?.adminUsers?.items ?? [];
      expect(items.length).toBeGreaterThanOrEqual(5);

      for (let index = 1; index < items.length; index += 1) {
        const previousTime = Date.parse(items[index - 1].createdAt);
        const currentTime = Date.parse(items[index].createdAt);
        expect(Number.isNaN(previousTime)).toBe(false);
        expect(Number.isNaN(currentTime)).toBe(false);
        expect(previousTime >= currentTime).toBe(true);
        // created_at 是 TIMESTAMP(3)，同毫秒批量创建时次序由 id DESC 决定
        if (previousTime === currentTime) {
          expect(items[index - 1].id > items[index].id).toBe(true);
        }
      }
    });

    it('keyword 分别命中登录名、登录邮箱、昵称三个维度且 total 精确', async () => {
      const byLoginName = await listAdminUsers(adminToken, {
        keyword: testAccountsConfig.staffPrimary.loginName,
      });
      expect(byLoginName.errors).toBeUndefined();
      expect(byLoginName.data?.adminUsers?.total).toBe(1);
      expect(byLoginName.data?.adminUsers?.items[0]?.loginName).toBe(
        testAccountsConfig.staffPrimary.loginName,
      );

      const byLoginEmail = await listAdminUsers(adminToken, {
        keyword: testAccountsConfig.guestSecondary.loginEmail,
      });
      expect(byLoginEmail.errors).toBeUndefined();
      expect(byLoginEmail.data?.adminUsers?.total).toBe(1);
      expect(byLoginEmail.data?.adminUsers?.items[0]?.loginEmail).toBe(
        testAccountsConfig.guestSecondary.loginEmail,
      );

      // seed 昵称口径为 `${loginName}_nickname`，用于核验昵称维度确实参与搜索。
      // 刻意选 staffPrimary：本文件「资料编辑」分组会改写 guestPrimary 的昵称且不恢复，
      // 用 guestPrimary 会让本断言退化成对 describe 声明顺序的隐式依赖；
      // staffPrimary 全程只作只读引用（连 accountId 都不取），昵称恒为 seed 值。
      const byNickname = await listAdminUsers(adminToken, {
        keyword: `${testAccountsConfig.staffPrimary.loginName}_nickname`,
      });
      expect(byNickname.errors).toBeUndefined();
      expect(byNickname.data?.adminUsers?.total).toBe(1);
      expect(byNickname.data?.adminUsers?.items[0]?.loginName).toBe(
        testAccountsConfig.staffPrimary.loginName,
      );
    });

    it('keyword 前后空白被 trim；纯空白视为不筛选', async () => {
      const padded = await listAdminUsers(adminToken, {
        keyword: `  ${testAccountsConfig.staffPrimary.loginName}  `,
      });
      expect(padded.errors).toBeUndefined();
      expect(padded.data?.adminUsers?.total).toBe(1);

      const blank = await listAdminUsers(adminToken, { keyword: '   ' });
      expect(blank.errors).toBeUndefined();
      expect(blank.data?.adminUsers?.total ?? 0).toBeGreaterThanOrEqual(5);
    });

    it('role 筛选：SUPER_ADMIN 精确一条（管理员账号只读可见），ENGINEER 全为 ENGINEER', async () => {
      const admins = await listAdminUsers(adminToken, { role: IdentityTypeEnum.SUPER_ADMIN });
      expect(admins.errors).toBeUndefined();
      expect(admins.data?.adminUsers?.total).toBe(1);
      expect(admins.data?.adminUsers?.items[0]?.id).toBe(adminAccountId);
      expect(admins.data?.adminUsers?.items[0]?.role).toBe(IdentityTypeEnum.SUPER_ADMIN);

      const engineers = await listAdminUsers(adminToken, { role: IdentityTypeEnum.ENGINEER });
      expect(engineers.errors).toBeUndefined();
      const engineerItems = engineers.data?.adminUsers?.items ?? [];
      expect(engineerItems.length).toBeGreaterThanOrEqual(2);
      expect(engineerItems.every((item) => item.role === IdentityTypeEnum.ENGINEER)).toBe(true);
      expect(engineerItems.map((item) => item.loginName)).toEqual(
        expect.arrayContaining([
          testAccountsConfig.staffPrimary.loginName,
          testAccountsConfig.staffSecondary.loginName,
        ]),
      );
      expect(engineers.data?.adminUsers?.total).toBe(engineerItems.length);
    });

    it('status 筛选：INACTIVE 只返回 INACTIVE（自建前置后恢复）', async () => {
      await ensureStatus(guestSecondaryAccountId, AccountStatus.INACTIVE);

      const inactive = await listAdminUsers(adminToken, { status: AccountStatus.INACTIVE });
      expect(inactive.errors).toBeUndefined();
      const inactiveItems = inactive.data?.adminUsers?.items ?? [];
      expect(inactiveItems.length).toBeGreaterThanOrEqual(1);
      expect(inactiveItems.every((item) => item.status === AccountStatus.INACTIVE)).toBe(true);
      expect(inactiveItems.map((item) => item.id)).toContain(guestSecondaryAccountId);
      expect(inactive.data?.adminUsers?.total).toBe(inactiveItems.length);

      const active = await listAdminUsers(adminToken, { status: AccountStatus.ACTIVE });
      expect(active.errors).toBeUndefined();
      const activeItems = active.data?.adminUsers?.items ?? [];
      expect(activeItems.every((item) => item.status === AccountStatus.ACTIVE)).toBe(true);
      expect(activeItems.map((item) => item.id)).not.toContain(guestSecondaryAccountId);

      await ensureStatus(guestSecondaryAccountId, AccountStatus.ACTIVE);
    });

    it('分页：total 为全量匹配数且与页码无关，items 不超 pageSize，翻页无重叠', async () => {
      const firstPage = await listAdminUsers(adminToken, {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 2 },
      });
      const secondPage = await listAdminUsers(adminToken, {
        pagination: { mode: 'OFFSET', page: 2, pageSize: 2 },
      });
      expect(firstPage.errors).toBeUndefined();
      expect(secondPage.errors).toBeUndefined();

      const first = firstPage.data?.adminUsers;
      const second = secondPage.data?.adminUsers;
      expect(first?.page).toBe(1);
      expect(first?.pageSize).toBe(2);
      expect(second?.page).toBe(2);
      expect(second?.pageSize).toBe(2);
      expect(first?.items).toHaveLength(2);
      expect(second?.items).toHaveLength(2);
      // total 恒返且与分页参数无关：两页必须报出同一个全量匹配数
      expect(first?.total).toBe(second?.total);
      expect(first?.total ?? 0).toBeGreaterThanOrEqual(5);

      const firstIds = new Set((first?.items ?? []).map((item) => item.id));
      expect((second?.items ?? []).some((item) => firstIds.has(item.id))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 创建用户
  // ---------------------------------------------------------------------------

  describe('创建用户 adminCreateUser', () => {
    it('创建 ENGINEER 用户成功并落库：三源一致、双字段 ACTIVE、联系邮箱与登录邮箱分离、初始密码可登录', async () => {
      const body = await createUser(adminToken, {
        // 刻意带空白与大小写，核验收敛口径与 DTO 回读一致
        loginName: CREATED_LOGIN_NAME,
        loginEmail: '  E2E.Created.Engineer@Example.COM ',
        initialPassword: CREATED_INITIAL_PASSWORD,
        role: IdentityTypeEnum.ENGINEER,
        nickname: '  E2E 新建工程师  ',
        companyName: '  E2E 示例公司  ',
        phone: ' 13800000001 ',
        contactEmail: '  Created.Contact@Example.com ',
      });

      expect(body.errors).toBeUndefined();
      const view = body.data?.adminCreateUser;
      expect(view).toBeDefined();
      expect(view).toMatchObject({
        loginName: CREATED_LOGIN_NAME,
        loginEmail: CREATED_LOGIN_EMAIL,
        nickname: 'E2E 新建工程师',
        companyName: 'E2E 示例公司',
        phone: '13800000001',
        contactEmail: 'created.contact@example.com',
        role: IdentityTypeEnum.ENGINEER,
        status: AccountStatus.ACTIVE,
      });

      const createdAccountId = view?.id ?? 0;
      expect(createdAccountId).toBeGreaterThan(0);
      recordOwnedResource(ownership, 'account', createdAccountId);

      // 账号行：登录邮箱小写收敛、identity_hint 与请求角色一致、状态 ACTIVE、口令非明文
      const account = await readAccountRow(createdAccountId);
      expect(account?.loginName).toBe(CREATED_LOGIN_NAME);
      expect(account?.loginEmail).toBe(CREATED_LOGIN_EMAIL);
      expect(account?.identityHint).toBe(IdentityTypeEnum.ENGINEER);
      expect(account?.status).toBe(AccountStatus.ACTIVE);
      expect(account?.loginPassword).not.toBe(CREATED_INITIAL_PASSWORD);
      expect(account?.loginPassword ?? '').not.toContain(CREATED_INITIAL_PASSWORD);

      // 资料行：双字段 ACTIVE、联系邮箱落 email 列而非登录凭据列
      const userInfo = await readUserInfoRow(createdAccountId);
      expect(userInfo?.nickname).toBe('E2E 新建工程师');
      expect(userInfo?.companyName).toBe('E2E 示例公司');
      expect(userInfo?.phone).toBe('13800000001');
      expect(userInfo?.email).toBe('created.contact@example.com');
      expect(userInfo?.email).not.toBe(CREATED_LOGIN_EMAIL);
      expect(userInfo?.userState).toBe(UserState.ACTIVE);

      // 角色三源在真实数据库里确实收敛为同一个单元素值（meta_digest 经订阅者解密）
      expect(await readRoleSources(createdAccountId)).toEqual({
        identityHint: IdentityTypeEnum.ENGINEER,
        accessGroup: [IdentityTypeEnum.ENGINEER],
        metaDigest: [IdentityTypeEnum.ENGINEER],
      });

      // S2c：ENGINEER 创建时在事务内绑定管理员当前组织；成员关系落库校验
      const membership = await dataSource
        .getRepository(OrganizationMembershipEntity)
        .findOne({ where: { accountId: createdAccountId } });
      expect(membership).toMatchObject({
        organizationId: primaryOrganizationId,
        memberRole: IdentityTypeEnum.ENGINEER,
        status: 'ACTIVE',
      });
      expect(membership?.leftAt).toBeNull();

      // 初始密码经公开登录入口可验证：证明哈希盐取的是数据库权威 createdAt
      const createdToken = await login({
        app,
        loginName: CREATED_LOGIN_NAME,
        loginPassword: CREATED_INITIAL_PASSWORD,
      });
      const access = await gql<{ userInfo?: { nickname?: string } }>({
        query: USER_INFO_QUERY,
        variables: { id: createdAccountId },
        token: createdToken,
      });
      expect(access.errors).toBeUndefined();
      expect(access.data?.userInfo?.nickname).toBe('E2E 新建工程师');
    });

    it('只提供登录邮箱（不提供登录名）也能创建成功', async () => {
      const body = await createUser(adminToken, {
        loginName: null,
        loginEmail: EMAIL_ONLY_LOGIN_EMAIL,
        initialPassword: EMAIL_ONLY_INITIAL_PASSWORD,
        role: IdentityTypeEnum.CUSTOMER,
        nickname: 'E2E 仅邮箱账号',
      });
      expect(body.errors).toBeUndefined();
      const view = body.data?.adminCreateUser;
      expect(view?.loginName).toBeNull();
      expect(view?.loginEmail).toBe(EMAIL_ONLY_LOGIN_EMAIL);
      expect(view?.role).toBe(IdentityTypeEnum.CUSTOMER);

      const account = await readAccountRow(view?.id ?? 0);
      if (view?.id) {
        recordOwnedResource(ownership, 'account', view.id);
      }
      expect(account?.loginName).toBeNull();
      expect(account?.loginEmail).toBe(EMAIL_ONLY_LOGIN_EMAIL);
      expect(await countAccounts({ loginEmail: EMAIL_ONLY_LOGIN_EMAIL })).toBe(1);

      // S2c 口径：CUSTOMER 不建立组织成员关系
      expect(
        await dataSource
          .getRepository(OrganizationMembershipEntity)
          .findOne({ where: { accountId: view?.id ?? 0 } }),
      ).toBeNull();
    });

    it('重复登录名返回 CONFLICT 且不落库', async () => {
      const body = await createUser(adminToken, {
        loginName: CREATED_LOGIN_NAME,
        loginEmail: 'e2e.conflict.email@example.com',
        initialPassword: CREATED_INITIAL_PASSWORD,
        role: IdentityTypeEnum.CUSTOMER,
        nickname: 'E2E 冲突探测',
      });
      expectSingleError(body, 'CONFLICT', 'ADMIN_USER_CREDENTIAL_CONFLICT');
      expect(body.data?.adminCreateUser).toBeFalsy();
      // 新邮箱未被占用：证明整次创建回滚，不是「只写了账号行」
      expect(await countAccounts({ loginEmail: 'e2e.conflict.email@example.com' })).toBe(0);
      expect(await countAccounts({ loginName: CREATED_LOGIN_NAME })).toBe(1);
    });

    it('重复登录邮箱返回 CONFLICT（大小写与空白差异不绕过唯一性）且不落库', async () => {
      const body = await createUser(adminToken, {
        loginName: 'e2econflictname',
        loginEmail: '  E2E.Created.Engineer@EXAMPLE.com ',
        initialPassword: CREATED_INITIAL_PASSWORD,
        role: IdentityTypeEnum.CUSTOMER,
        nickname: 'E2E 冲突探测',
      });
      expectSingleError(body, 'CONFLICT', 'ADMIN_USER_CREDENTIAL_CONFLICT');
      expect(await countAccounts({ loginName: 'e2econflictname' })).toBe(0);
      expect(await countAccounts({ loginEmail: CREATED_LOGIN_EMAIL })).toBe(1);
    });

    it('role=SUPER_ADMIN 被拒（BAD_USER_INPUT）且不落库', async () => {
      const body = await createUser(adminToken, {
        loginName: 'e2esuperadminprobe',
        loginEmail: 'e2e.super.admin.probe@example.com',
        initialPassword: CREATED_INITIAL_PASSWORD,
        role: IdentityTypeEnum.SUPER_ADMIN,
        nickname: 'E2E 越权探测',
      });
      expectSingleError(body, 'BAD_USER_INPUT', 'INPUT_NORMALIZE_INVALID_ENUM_VALUE');
      expect(await countAccounts({ loginName: 'e2esuperadminprobe' })).toBe(0);
    });

    it('弱初始密码在协议层被拒（BAD_USER_INPUT）且不落库', async () => {
      const body = await createUser(adminToken, {
        loginName: 'e2eweakpassword',
        loginEmail: 'e2e.weak.password@example.com',
        initialPassword: 'weak',
        role: IdentityTypeEnum.CUSTOMER,
        nickname: 'E2E 弱密码探测',
      });
      expectSingleError(body, 'BAD_USER_INPUT');
      expect(await countAccounts({ loginName: 'e2eweakpassword' })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 资料编辑
  // ---------------------------------------------------------------------------

  describe('资料编辑 adminUpdateUserProfile', () => {
    it('编辑昵称 / 公司 / 电话 / 联系邮箱成功并落库，登录凭据列与角色三源不受影响', async () => {
      await ensureStatus(guestAccountId, AccountStatus.ACTIVE);

      const body = await updateUserProfile(adminToken, {
        accountId: guestAccountId,
        nickname: '  E2E 编辑后昵称  ',
        companyName: '  E2E 编辑后公司  ',
        phone: ' 13900000002 ',
        contactEmail: '  Edited.Contact@Example.com ',
      });

      expect(body.errors).toBeUndefined();
      expect(body.data?.adminUpdateUserProfile).toMatchObject({
        id: guestAccountId,
        nickname: 'E2E 编辑后昵称',
        companyName: 'E2E 编辑后公司',
        phone: '13900000002',
        contactEmail: 'edited.contact@example.com',
        role: IdentityTypeEnum.CUSTOMER,
        status: AccountStatus.ACTIVE,
      });

      const userInfo = await readUserInfoRow(guestAccountId);
      expect(userInfo?.nickname).toBe('E2E 编辑后昵称');
      expect(userInfo?.companyName).toBe('E2E 编辑后公司');
      expect(userInfo?.phone).toBe('13900000002');
      // contactEmail 落 base_user_info.email，不得改写登录凭据列
      expect(userInfo?.email).toBe('edited.contact@example.com');

      const account = await readAccountRow(guestAccountId);
      expect(account?.loginName).toBe(testAccountsConfig.guestPrimary.loginName);
      expect(account?.loginEmail).toBe(testAccountsConfig.guestPrimary.loginEmail);
      expect(await readRoleSources(guestAccountId)).toEqual({
        identityHint: IdentityTypeEnum.CUSTOMER,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
        metaDigest: [IdentityTypeEnum.CUSTOMER],
      });
    });

    it('不传字段 = 不修改；显式 null = 清空', async () => {
      await ensureStatus(guestAccountId, AccountStatus.ACTIVE);
      const seeded = await updateUserProfile(adminToken, {
        accountId: guestAccountId,
        nickname: 'E2E 三态昵称',
        companyName: 'E2E 待清空公司',
        phone: '13900000003',
        contactEmail: 'to.clear@example.com',
      });
      expect(seeded.errors).toBeUndefined();

      // nickname 不传 → 保持；三个可选字段显式 null → 清空
      const body = await updateUserProfile(adminToken, {
        accountId: guestAccountId,
        companyName: null,
        phone: null,
        contactEmail: null,
      });
      expect(body.errors).toBeUndefined();
      expect(body.data?.adminUpdateUserProfile).toMatchObject({
        id: guestAccountId,
        nickname: 'E2E 三态昵称',
        companyName: null,
        phone: null,
        contactEmail: null,
      });

      const userInfo = await readUserInfoRow(guestAccountId);
      expect(userInfo?.nickname).toBe('E2E 三态昵称');
      expect(userInfo?.companyName).toBeNull();
      expect(userInfo?.phone).toBeNull();
      expect(userInfo?.email).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 状态切换
  // ---------------------------------------------------------------------------

  describe('状态切换 adminSetUserStatus（双字段同步）', () => {
    it('ACTIVE → INACTIVE：account.status 与 userInfo.userState 同步', async () => {
      await ensureStatus(guestAccountId, AccountStatus.ACTIVE);

      const body = await setUserStatus(adminToken, {
        accountId: guestAccountId,
        status: AccountStatus.INACTIVE,
      });
      expect(body.errors).toBeUndefined();
      expect(body.data?.adminSetUserStatus).toMatchObject({
        id: guestAccountId,
        status: AccountStatus.INACTIVE,
      });
      expect(await readDualStatus(guestAccountId)).toEqual({
        accountStatus: AccountStatus.INACTIVE,
        userState: UserState.INACTIVE,
      });
    });

    it('INACTIVE → ACTIVE：双字段同步恢复，且重新启用后新登录可访问受保护查询', async () => {
      await ensureStatus(guestAccountId, AccountStatus.INACTIVE);

      const body = await setUserStatus(adminToken, {
        accountId: guestAccountId,
        status: AccountStatus.ACTIVE,
      });
      expect(body.errors).toBeUndefined();
      expect(body.data?.adminSetUserStatus?.status).toBe(AccountStatus.ACTIVE);
      expect(await readDualStatus(guestAccountId)).toEqual({
        accountStatus: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });

      // 重新启用后走全新登录签发 Token，验证正常访问路径
      // （原 P1 `user-state-write-guard` 点 6 的运行时半句，已收拢到本文件）
      const freshToken = await login({
        app,
        loginName: testAccountsConfig.guestPrimary.loginName,
        loginPassword: testAccountsConfig.guestPrimary.loginPassword,
      });
      const access = await gql<{ userInfo?: { nickname?: string } }>({
        query: USER_INFO_QUERY,
        variables: { id: guestAccountId },
        token: freshToken,
      });
      expect(access.errors).toBeUndefined();
      // 不断言具体昵称：「资料编辑」分组会改写 guestPrimary 的昵称且不恢复，
      // 写死值会重新引入跨 describe 顺序依赖；本用例只需证明「能访问」。
      expect(access.data?.userInfo).toBeDefined();
    });

    it('同状态幂等：ACTIVE → ACTIVE 零写入（updatedAt 不变）且双字段保持一致', async () => {
      // 不用 ensureStatus 做前置：本用例自己就是幂等路径。
      // 无论进入时是 ACTIVE 还是 INACTIVE，第一次调用后必为 ACTIVE，
      // 第二次调用必走幂等短路，因此断言与用例执行顺序无关。
      const prepared = await setUserStatus(adminToken, {
        accountId: guestAccountId,
        status: AccountStatus.ACTIVE,
      });
      expect(prepared.errors).toBeUndefined();
      const updatedAtBefore = prepared.data?.adminSetUserStatus?.updatedAt;
      expect(updatedAtBefore).toBeDefined();

      const body = await setUserStatus(adminToken, {
        accountId: guestAccountId,
        status: AccountStatus.ACTIVE,
      });
      expect(body.errors).toBeUndefined();
      expect(body.data?.adminSetUserStatus?.status).toBe(AccountStatus.ACTIVE);
      expect(body.data?.adminSetUserStatus?.updatedAt).toBe(updatedAtBefore);
      expect(await readDualStatus(guestAccountId)).toEqual({
        accountStatus: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });
    });

    it('停用后旧 Token 的下一次受保护请求返回 UNAUTHENTICATED（自建前置并恢复）', async () => {
      await ensureStatus(guestAccountId, AccountStatus.ACTIVE);
      const tokenBeforeDisable = await login({
        app,
        loginName: testAccountsConfig.guestPrimary.loginName,
        loginPassword: testAccountsConfig.guestPrimary.loginPassword,
      });

      await ensureStatus(guestAccountId, AccountStatus.INACTIVE);

      const body = await gql<{ userInfo?: unknown }>({
        query: USER_INFO_QUERY,
        variables: { id: guestAccountId },
        token: tokenBeforeDisable,
      });
      expectSingleError(body, 'UNAUTHENTICATED', 'JWT_AUTHENTICATION_FAILED');
      expect(body.data?.userInfo).toBeFalsy();

      // 恢复 ACTIVE，不遗留停用态给其他用例
      await ensureStatus(guestAccountId, AccountStatus.ACTIVE);
    });

    it('管理员不能停用自己（显式自我拒绝先于目标保护）', async () => {
      const body = await setUserStatus(adminToken, {
        accountId: adminAccountId,
        status: AccountStatus.INACTIVE,
      });
      expectSingleError(body, 'FORBIDDEN');
      expect(body.errors?.[0]?.message).toContain('不能停用自己');
      expect(await readDualStatus(adminAccountId)).toEqual({
        accountStatus: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });
    });

    const unwritableStatuses: Array<[string, AccountStatus]> = [
      ['SUSPENDED', AccountStatus.SUSPENDED],
      ['BANNED', AccountStatus.BANNED],
      ['PENDING', AccountStatus.PENDING],
      ['DELETED', AccountStatus.DELETED],
    ];

    it.each(unwritableStatuses)(
      '请求不可转换的目标状态 %s 被拒（BAD_USER_INPUT）且状态零变化',
      async (_label, status) => {
        await ensureStatus(guestAccountId, AccountStatus.ACTIVE);

        const body = await setUserStatus(adminToken, { accountId: guestAccountId, status });
        expectSingleError(body, 'BAD_USER_INPUT', 'INPUT_NORMALIZE_INVALID_ENUM_VALUE');
        expect(await readDualStatus(guestAccountId)).toEqual({
          accountStatus: AccountStatus.ACTIVE,
          userState: UserState.ACTIVE,
        });
      },
    );
  });

  // ---------------------------------------------------------------------------
  // SUPER_ADMIN 目标写保护
  // ---------------------------------------------------------------------------

  describe('SUPER_ADMIN 目标写保护', () => {
    /**
     * 本文件只 seed 一个 SUPER_ADMIN（admin），它同时是发起方自己的账号，
     * 因此 `adminSetUserStatus` 命中的是「不能停用自己」这一先行显式拒绝；
     * 两者对外同为 FORBIDDEN，本用例只锁定「全部拒绝 + 数据库零变化」这一不变量。
     */
    it('资料编辑 / 启停 / 重置密码全部拒绝且数据库零变化', async () => {
      const operations: Array<[string, () => Promise<GqlBody<unknown>>]> = [
        [
          'adminUpdateUserProfile',
          () =>
            updateUserProfile(adminToken, {
              accountId: adminAccountId,
              nickname: 'E2E 管理员改名',
            }),
        ],
        [
          'adminSetUserStatus',
          () =>
            setUserStatus(adminToken, {
              accountId: adminAccountId,
              status: AccountStatus.INACTIVE,
            }),
        ],
        [
          'adminResetUserPassword',
          () =>
            resetUserPassword(adminToken, {
              accountId: adminAccountId,
              newPassword: RESET_NEW_PASSWORD,
            }),
        ],
      ];

      const accountBefore = await readAccountRow(adminAccountId);
      const userInfoBefore = await readUserInfoRow(adminAccountId);

      const collected = await collectErrors(operations);
      expect(collected.map(([name, code]) => [name, code])).toEqual(
        operations.map(([name]) => [name, 'FORBIDDEN']),
      );

      const accountAfter = await readAccountRow(adminAccountId);
      const userInfoAfter = await readUserInfoRow(adminAccountId);
      expect(accountAfter?.identityHint).toBe(accountBefore?.identityHint);
      expect(accountAfter?.status).toBe(accountBefore?.status);
      expect(accountAfter?.loginPassword).toBe(accountBefore?.loginPassword);
      expect(userInfoAfter?.nickname).toBe(userInfoBefore?.nickname);
      expect(userInfoAfter?.accessGroup).toEqual(userInfoBefore?.accessGroup);
      expect(userInfoAfter?.metaDigest).toEqual(userInfoBefore?.metaDigest);
      expect(userInfoAfter?.userState).toBe(userInfoBefore?.userState);
      expect(await readRoleSources(adminAccountId)).toEqual({
        identityHint: IdentityTypeEnum.SUPER_ADMIN,
        accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
        metaDigest: [IdentityTypeEnum.SUPER_ADMIN],
      });

      // 口令哈希未被改写：管理员仍能用原密码登录
      const stillAdminToken = await login({
        app,
        loginName: testAccountsConfig.admin.loginName,
        loginPassword: testAccountsConfig.admin.loginPassword,
      });
      expect(stillAdminToken).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // 目标不存在（错误契约）
  // ---------------------------------------------------------------------------

  describe('目标不存在（错误契约）', () => {
    it('三个写操作均返回 NOT_FOUND，不塌缩为 UNAUTHENTICATED 且 details 留空', async () => {
      const operations = missingTargetOperations();
      const collected = await collectErrors(operations);

      expect(collected).toEqual(
        operations.map(([name]) => [name, 'NOT_FOUND', 'ADMIN_USER_TARGET_NOT_FOUND', undefined]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 密码重置
  // ---------------------------------------------------------------------------

  describe('密码重置 adminResetUserPassword', () => {
    it('ACTIVE 目标重置成功：结果只含固定三项、新密码可登录、旧密码立即失效、响应不含密码派生物', async () => {
      await ensureStatus(guestSecondaryAccountId, AccountStatus.ACTIVE);
      const hashBefore = (await readAccountRow(guestSecondaryAccountId))?.loginPassword;

      const body = await resetUserPassword(adminToken, {
        accountId: guestSecondaryAccountId,
        newPassword: RESET_NEW_PASSWORD,
      });
      expect(body.errors).toBeUndefined();
      expect(body.data?.adminResetUserPassword).toEqual({
        accountId: guestSecondaryAccountId,
        isUpdated: true,
        notice: expect.any(String),
      });
      expect((body.data?.adminResetUserPassword?.notice ?? '').length).toBeGreaterThan(0);

      // 整个响应体不得出现新密码（含大小写变体）
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(RESET_NEW_PASSWORD);
      expect(serialized).not.toContain(RESET_NEW_PASSWORD.toLowerCase());

      // 口令哈希确实被改写，且不是明文
      const hashAfter = (await readAccountRow(guestSecondaryAccountId))?.loginPassword;
      expect(hashAfter).toBeTruthy();
      expect(hashAfter).not.toBe(hashBefore);
      expect(hashAfter ?? '').not.toContain(RESET_NEW_PASSWORD);

      // 新密码经公开登录入口可验证，并可访问受保护查询
      const freshToken = await login({
        app,
        loginName: testAccountsConfig.guestSecondary.loginName,
        loginPassword: RESET_NEW_PASSWORD,
      });
      const access = await gql<{ userInfo?: { nickname?: string } }>({
        query: USER_INFO_QUERY,
        variables: { id: guestSecondaryAccountId },
        token: freshToken,
      });
      expect(access.errors).toBeUndefined();
      expect(access.data?.userInfo?.nickname).toBeTruthy();

      // 旧密码立即失效
      const staleLogin = await attemptLogin(
        testAccountsConfig.guestSecondary.loginName,
        testAccountsConfig.guestSecondary.loginPassword,
      );
      expect(staleLogin.data?.login?.accessToken).toBeFalsy();
      expect(staleLogin.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    });

    it('INACTIVE 目标（双字段一致）也允许重置，且不顺带改动状态双字段', async () => {
      await ensureStatus(guestSecondaryAccountId, AccountStatus.INACTIVE);
      expect(await readDualStatus(guestSecondaryAccountId)).toEqual({
        accountStatus: AccountStatus.INACTIVE,
        userState: UserState.INACTIVE,
      });

      const body = await resetUserPassword(adminToken, {
        accountId: guestSecondaryAccountId,
        newPassword: RESET_INACTIVE_PASSWORD,
      });
      expect(body.errors).toBeUndefined();
      expect(body.data?.adminResetUserPassword?.isUpdated).toBe(true);

      expect(await readDualStatus(guestSecondaryAccountId)).toEqual({
        accountStatus: AccountStatus.INACTIVE,
        userState: UserState.INACTIVE,
      });

      // 恢复 ACTIVE 后，重置期间写入的新密码仍可登录
      await ensureStatus(guestSecondaryAccountId, AccountStatus.ACTIVE);
      const token = await login({
        app,
        loginName: testAccountsConfig.guestSecondary.loginName,
        loginPassword: RESET_INACTIVE_PASSWORD,
      });
      expect(token).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // 契约面
  // ---------------------------------------------------------------------------

  describe('契约面：角色修改入口已下线、管理员现行操作已上线', () => {
    it('Mutation root 不暴露 updateAccessGroup / adminChangeUserRole，但暴露四个管理员写操作', async () => {
      const body = await gql<SchemaRootPayload>({ query: SCHEMA_ROOT_QUERY });
      expect(body.errors).toBeUndefined();

      const mutationNames =
        body.data?.__schema?.mutationType?.fields?.map((field) => field.name) ?? [];
      expect(mutationNames.length).toBeGreaterThan(0);
      expect(mutationNames).not.toContain('updateAccessGroup');
      expect(mutationNames).not.toContain('adminChangeUserRole');
      expect(mutationNames).toEqual(expect.arrayContaining([...ADMIN_WRITE_MUTATIONS]));
    });

    it('Query root 暴露 adminUsers', async () => {
      const body = await gql<SchemaRootPayload>({ query: SCHEMA_ROOT_QUERY });
      expect(body.errors).toBeUndefined();

      const queryNames = body.data?.__schema?.queryType?.fields?.map((field) => field.name) ?? [];
      expect(queryNames).toContain('adminUsers');
    });
  });
});

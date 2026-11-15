// test/01-auth/session-status-combination.e2e-spec.ts
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { EngineerRegistrationApplicationEntity } from '@src/modules/lithography/entities/engineer-registration-application.entity';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { requireOrganizationId, seedTestOrganizations } from '../utils/test-organizations';

/**
 * P2：登录与令牌复核的账号/资料双状态组合门禁。
 *
 * 背景：旧实现把账号状态与资料状态拆成两个独立谓词，`allowRestrictedSession=true`
 * 时「仅供账号 PENDING」或「仅供资料 PENDING」都能各自返回 true，于是单边状态也会
 * 签发/放行会话。本规格保留真实 GraphQL resolver、JWT 策略、MySQL 读写与每请求复核，
 * 验证组合门禁：
 * 1. 合法双待审（PENDING/PENDING + 待审申请）允许受限会话登录；
 * 2. 两种单边状态均被密码登录拒绝且不签发 accessToken；
 * 3. 双启用（ACTIVE/ACTIVE）按正常契约签发，无限制；
 * 4. 已签发受限 Token 在数据库仅改一侧状态后即被认证层拒绝，恢复双待审后重新可用；
 * 5. 双待审会话仍被 SessionRestrictionGuard 拦截业务接口。
 */
type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type LoginPayload = { accessToken: string; restriction: SessionRestriction };
type SessionIdentityPayload = { accountId: number; restriction: SessionRestriction };

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) { accessToken restriction }
  }
`;

const MY_SESSION_IDENTITY_QUERY = `
  query MySessionIdentity {
    mySessionIdentity { accountId restriction }
  }
`;

const BUSINESS_USER_INFO_QUERY = `
  query BusinessUserInfo($accountId: Int!) {
    userInfo(accountId: $accountId) { accountId }
  }
`;

/** 本轮唯一标识：账号、邮箱、昵称与组织全部带 tag，避免与任何外部/历史数据同指纹。 */
const RUN_TAG = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
const ORG_CODE = `E2E_SC3_${RUN_TAG}`;
const ORG_NAME = `E2E SC3 双状态门禁组织 ${RUN_TAG}`;
const APPLICATION_NOTE = `E2E SC3 双状态门禁申请 ${RUN_TAG}`;

/**
 * 外部哨兵：沿用旧版固定指纹（不含本轮 tag），且**不登记**进本轮台账。
 *
 * 旧实现在 beforeAll 按该固定业务指纹预清理，会直接接管并删除这行外部数据；
 * 新实现必须在整轮清理后保持其账号与资料关键值完全不变。
 */
const EXTERNAL_SENTINEL = {
  loginName: 'sc3dualpending',
  loginEmail: 'sc3.dual.pending@example.com',
  nickname: 'sc3dualpending_nickname',
  identityHint: IdentityTypeEnum.ENGINEER,
  status: AccountStatus.PENDING,
  accessGroup: [IdentityTypeEnum.ENGINEER],
  userState: UserState.PENDING,
} as const;

type FixtureKey =
  | 'dualPendingLogin'
  | 'accountOnlyPending'
  | 'userOnlyPending'
  | 'dualActiveCustomer'
  | 'dualPendingToken';

interface SessionFixtureSpec {
  readonly key: FixtureKey;
  readonly loginName: string;
  readonly loginEmail: string;
  readonly loginPassword: string;
  readonly status: AccountStatus;
  readonly userState: UserState;
  readonly identityHint: IdentityTypeEnum;
  readonly accessGroup: IdentityTypeEnum[];
}

/** 固定业务字段模板；登录名/邮箱在生成 fixture 时统一追加本轮 tag。 */
const SESSION_FIXTURE_TEMPLATES: readonly SessionFixtureSpec[] = [
  {
    key: 'dualPendingLogin',
    loginName: 'sc3dualpending',
    loginEmail: 'sc3.dual.pending@example.com',
    loginPassword: 'Sc3DualPending@2026',
    status: AccountStatus.PENDING,
    userState: UserState.PENDING,
    identityHint: IdentityTypeEnum.ENGINEER,
    accessGroup: [IdentityTypeEnum.ENGINEER],
  },
  {
    key: 'accountOnlyPending',
    loginName: 'sc3accountpending',
    loginEmail: 'sc3.account.pending@example.com',
    loginPassword: 'Sc3AccountPending@2026',
    status: AccountStatus.PENDING,
    userState: UserState.ACTIVE,
    identityHint: IdentityTypeEnum.ENGINEER,
    accessGroup: [IdentityTypeEnum.ENGINEER],
  },
  {
    key: 'userOnlyPending',
    loginName: 'sc3userpending',
    loginEmail: 'sc3.user.pending@example.com',
    loginPassword: 'Sc3UserPending@2026',
    status: AccountStatus.ACTIVE,
    userState: UserState.PENDING,
    identityHint: IdentityTypeEnum.ENGINEER,
    accessGroup: [IdentityTypeEnum.ENGINEER],
  },
  {
    key: 'dualActiveCustomer',
    loginName: 'sc3dualactive',
    loginEmail: 'sc3.dual.active@example.com',
    loginPassword: 'Sc3DualActive@2026',
    status: AccountStatus.ACTIVE,
    userState: UserState.ACTIVE,
    identityHint: IdentityTypeEnum.CUSTOMER,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
  },
  {
    key: 'dualPendingToken',
    loginName: 'sc3tokenpending',
    loginEmail: 'sc3.token.pending@example.com',
    loginPassword: 'Sc3TokenPending@2026',
    status: AccountStatus.PENDING,
    userState: UserState.PENDING,
    identityHint: IdentityTypeEnum.ENGINEER,
    accessGroup: [IdentityTypeEnum.ENGINEER],
  },
];

const withRunTag = (spec: SessionFixtureSpec): SessionFixtureSpec => ({
  ...spec,
  loginName: `${spec.loginName}_${RUN_TAG}`,
  loginEmail: spec.loginEmail.replace('@', `.${RUN_TAG}@`),
});

const SESSION_FIXTURES: readonly SessionFixtureSpec[] = SESSION_FIXTURE_TEMPLATES.map(withRunTag);

const ENGINEER_PENDING_KEYS: readonly FixtureKey[] = [
  'dualPendingLogin',
  'accountOnlyPending',
  'userOnlyPending',
  'dualPendingToken',
];

describe('登录与令牌复核的双状态组合门禁 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();
  const sentinelOwnership: OwnedResourceLedger = createOwnedResourceLedger();
  const accountIds = new Map<FixtureKey, number>();
  let sentinelAccountId: number | null = null;

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    // 外部哨兵先于本轮数据创建：不登记台账，用于证明清理边界只覆盖本轮写入。
    await ensureExternalSentinel();

    for (const spec of SESSION_FIXTURES) {
      accountIds.set(spec.key, await seedFixture(spec));
    }

    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [{ organizationCode: ORG_CODE, name: ORG_NAME, kind: 'CLIENT' }],
      ownership,
    });
    const organizationId = requireOrganizationId(organizationIds, ORG_CODE);

    for (const key of ENGINEER_PENDING_KEYS) {
      await seedPendingApplication(accountIds.get(key) as number, organizationId);
    }
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (!dataSource?.isInitialized) return;
        await runGuardedSpecCleanup({
          dataSource,
          owned: ownership,
          helper: 'session-status-combination.e2e-spec afterAll 收尾',
        });
      },
      finalize: async () => {
        if (!dataSource?.isInitialized) return;
        // 先核验外部哨兵原样保留，再按独立台账精确回收本轮创建的那一份；
        // 残留断言放在最后，避免残留失败时跳过哨兵回收而留下额外脏数据。
        if (sentinelAccountId !== null) {
          await expectExternalSentinelUnchanged(sentinelAccountId);
        }
        await cleanupExternalSentinel();
        await expectRoundResidueZero();
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
    });
  });

  /** 受控夹具：账号 + 资料同一事务落库，提交后登记真实 ID。 */
  const seedFixture = async (spec: SessionFixtureSpec): Promise<number> => {
    const accountId = await dataSource.transaction(async (manager) => {
      const accountRepo = manager.getRepository(AccountEntity);
      const userInfoRepo = manager.getRepository(UserInfoEntity);

      const placeholder = await accountRepo.save(
        accountRepo.create({
          loginName: spec.loginName,
          loginEmail: spec.loginEmail,
          loginPassword: 'temp',
          status: spec.status,
          identityHint: spec.identityHint,
          mustChangePassword: false,
        }),
      );
      await accountRepo.update(placeholder.id, {
        loginPassword: AccountService.hashPasswordWithTimestamp(
          spec.loginPassword,
          placeholder.createdAt,
        ),
      });
      await userInfoRepo.save(
        userInfoRepo.create({
          accountId: placeholder.id,
          nickname: `${spec.loginName}_nickname`,
          gender: Gender.SECRET,
          email: spec.loginEmail,
          accessGroup: spec.accessGroup,
          metaDigest: spec.accessGroup,
          notifyCount: 0,
          unreadCount: 0,
          userState: spec.userState,
        }),
      );
      return placeholder.id;
    });

    recordOwnedResource(ownership, 'account', accountId, {
      loginName: spec.loginName,
      loginEmail: spec.loginEmail,
      status: spec.status,
      identityHint: spec.identityHint,
      accessGroup: spec.accessGroup,
      nickname: `${spec.loginName}_nickname`,
      userInfoEmail: spec.loginEmail,
      userState: spec.userState,
    });
    return accountId;
  };

  const seedPendingApplication = async (
    accountId: number,
    organizationId: number,
  ): Promise<void> => {
    const repository = dataSource.getRepository(EngineerRegistrationApplicationEntity);
    const saved = await repository.save(
      repository.create({
        accountId,
        organizationId,
        status: 'PENDING',
        applicationNote: APPLICATION_NOTE,
        submittedAt: new Date(Date.now() - 60_000),
        reviewedByAccountId: null,
        reviewedAt: null,
        reviewComment: null,
      }),
    );
    recordOwnedResource(ownership, 'engineerRegistrationApplication', saved.id, {
      accountId,
      organizationId,
      applicationNote: APPLICATION_NOTE,
    });
  };

  const countRows = async (sql: string, params: unknown[]): Promise<number> => {
    const rows = await dataSource.query<Array<{ n: number | string }>>(sql, params);
    return Number(rows[0]?.n ?? -1);
  };

  /**
   * 外部哨兵：沿用旧版固定业务指纹，且**不登记**本轮台账。
   *
   * - 库内已存在同指纹行：只记录真实 ID，绝不认领、绝不删除（这正是旧实现
   *   「beforeAll 按固定指纹预清理」会误删外部账号的场景）；
   * - 不存在：按固定指纹创建，并登记进**独立**台账 `sentinelOwnership`，
   *   收尾核验关键值未变后再按真实 ID 精确删除。
   */
  const ensureExternalSentinel = async (): Promise<void> => {
    const existing = await dataSource
      .getRepository(AccountEntity)
      .findOne({ where: { loginEmail: EXTERNAL_SENTINEL.loginEmail } });
    if (existing) {
      sentinelAccountId = existing.id;
      return;
    }

    const accountId = await dataSource.transaction(async (manager) => {
      const accountRepo = manager.getRepository(AccountEntity);
      const userInfoRepo = manager.getRepository(UserInfoEntity);

      const placeholder = await accountRepo.save(
        accountRepo.create({
          loginName: EXTERNAL_SENTINEL.loginName,
          loginEmail: EXTERNAL_SENTINEL.loginEmail,
          loginPassword: 'temp',
          status: EXTERNAL_SENTINEL.status,
          identityHint: EXTERNAL_SENTINEL.identityHint,
          mustChangePassword: false,
        }),
      );
      await accountRepo.update(placeholder.id, {
        loginPassword: AccountService.hashPasswordWithTimestamp(
          'Sc3Sentinel@2026',
          placeholder.createdAt,
        ),
      });
      await userInfoRepo.save(
        userInfoRepo.create({
          accountId: placeholder.id,
          nickname: EXTERNAL_SENTINEL.nickname,
          gender: Gender.SECRET,
          email: EXTERNAL_SENTINEL.loginEmail,
          accessGroup: [...EXTERNAL_SENTINEL.accessGroup],
          metaDigest: [...EXTERNAL_SENTINEL.accessGroup],
          notifyCount: 0,
          unreadCount: 0,
          userState: EXTERNAL_SENTINEL.userState,
        }),
      );
      return placeholder.id;
    });

    sentinelAccountId = accountId;
    recordOwnedResource(sentinelOwnership, 'account', accountId, {
      loginName: EXTERNAL_SENTINEL.loginName,
      loginEmail: EXTERNAL_SENTINEL.loginEmail,
      status: EXTERNAL_SENTINEL.status,
      identityHint: EXTERNAL_SENTINEL.identityHint,
      accessGroup: EXTERNAL_SENTINEL.accessGroup,
      nickname: EXTERNAL_SENTINEL.nickname,
      userInfoEmail: EXTERNAL_SENTINEL.loginEmail,
      userState: EXTERNAL_SENTINEL.userState,
    });
  };

  /** 清理后核验外部哨兵的账号与资料关键值完全未变。 */
  const expectExternalSentinelUnchanged = async (accountId: number): Promise<void> => {
    const rows = await dataSource.query<Array<Record<string, unknown>>>(
      `SELECT a.login_name AS loginName, a.login_email AS loginEmail, a.status AS status,
              a.identity_hint AS identityHint, ui.nickname AS nickname,
              ui.email AS userInfoEmail, ui.user_state AS userState
         FROM base_user_account a
         JOIN base_user_info ui ON ui.account_id = a.id
        WHERE a.id = ?`,
      [accountId],
    );

    expect(rows).toHaveLength(1);
    expect({
      loginName: rows[0]?.loginName,
      loginEmail: rows[0]?.loginEmail,
      status: rows[0]?.status,
      identityHint: rows[0]?.identityHint,
      nickname: rows[0]?.nickname,
      userInfoEmail: rows[0]?.userInfoEmail,
      userState: rows[0]?.userState,
    }).toEqual({
      loginName: EXTERNAL_SENTINEL.loginName,
      loginEmail: EXTERNAL_SENTINEL.loginEmail,
      status: EXTERNAL_SENTINEL.status,
      identityHint: EXTERNAL_SENTINEL.identityHint,
      nickname: EXTERNAL_SENTINEL.nickname,
      userInfoEmail: EXTERNAL_SENTINEL.loginEmail,
      userState: EXTERNAL_SENTINEL.userState,
    });
  };

  /**
   * 只回收「本轮创建的那一份」哨兵；预先存在的外部行不在台账中，因此本函数对它是 no-op。
   */
  const cleanupExternalSentinel = async (): Promise<void> => {
    if (sentinelOwnership.accountIds.length === 0) {
      return;
    }
    await runGuardedSpecCleanup({
      dataSource,
      owned: sentinelOwnership,
      helper: 'session-status-combination.e2e-spec 外部哨兵精确回收',
    });
  };

  /** 本轮唯一 tag 派生出的账号/资料/组织/申请必须全部归零。 */
  const expectRoundResidueZero = async (): Promise<void> => {
    const loginNamePattern = `%!_${RUN_TAG}`;
    const loginEmailPattern = `%.!_${RUN_TAG}@%`;

    const accounts = await countRows(
      "SELECT COUNT(*) AS n FROM base_user_account WHERE login_name LIKE ? ESCAPE '!' OR login_email LIKE ? ESCAPE '!'",
      [loginNamePattern, loginEmailPattern],
    );
    const userInfos = await countRows(
      "SELECT COUNT(*) AS n FROM base_user_info WHERE email LIKE ? ESCAPE '!'",
      [loginEmailPattern],
    );
    const organizations = await countRows(
      'SELECT COUNT(*) AS n FROM organization WHERE organization_code = ? OR name = ?',
      [ORG_CODE, ORG_NAME],
    );
    const applications = await countRows(
      'SELECT COUNT(*) AS n FROM engineer_registration_application WHERE application_note = ?',
      [APPLICATION_NOTE],
    );

    expect({ accounts, userInfos, organizations, applications }).toEqual({
      accounts: 0,
      userInfos: 0,
      organizations: 0,
      applications: 0,
    });
  };

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

  const passwordLogin = (
    loginName: string,
    loginPassword: string,
    allowRestrictedSession: boolean,
  ): Promise<GqlBody<{ login?: LoginPayload }>> =>
    gql({
      query: LOGIN_MUTATION,
      variables: {
        input: {
          loginName,
          loginPassword,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
          allowRestrictedSession,
        },
      },
    });

  const readSessionRestriction = async (token: string): Promise<SessionRestriction | undefined> => {
    const body = await gql<{ mySessionIdentity?: SessionIdentityPayload }>({
      query: MY_SESSION_IDENTITY_QUERY,
      token,
    });
    expect(body.errors).toBeUndefined();
    return body.data?.mySessionIdentity?.restriction;
  };

  const expectUnauthenticated = async (token: string): Promise<void> => {
    const body = await gql<{ mySessionIdentity?: SessionIdentityPayload }>({
      query: MY_SESSION_IDENTITY_QUERY,
      token,
    });
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('JWT_AUTHENTICATION_FAILED');
  };

  const expectBusinessRejected = async (token: string, accountId: number): Promise<void> => {
    const body = await gql<{ userInfo?: { accountId: number } }>({
      query: BUSINESS_USER_INFO_QUERY,
      variables: { accountId },
      token,
    });
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
  };

  /**
   * 受控状态改写：写入成功后立即同步台账预期。
   *
   * 断言中断发生在任一改写之后时，afterAll 的清理预检仍以「最后一次已知写入」为准，
   * 不会因预期漂移而拒绝回收、把本轮账号泄漏到库里。
   */
  const updateAccountStatus = async (accountId: number, status: AccountStatus): Promise<void> => {
    await dataSource.getRepository(AccountEntity).update(accountId, { status });
    updateOwnedExpectation(ownership, 'account', accountId, { status });
  };

  const updateUserState = async (accountId: number, userState: UserState): Promise<void> => {
    await dataSource.getRepository(UserInfoEntity).update(accountId, { userState });
    updateOwnedExpectation(ownership, 'account', accountId, { userState });
  };

  it('合法双待审允许受限会话登录并返回 ENGINEER_PENDING', async () => {
    const spec = SESSION_FIXTURES.find((fixture) => fixture.key === 'dualPendingLogin');
    const body = await passwordLogin(
      spec?.loginName as string,
      spec?.loginPassword as string,
      true,
    );

    expect(body.errors).toBeUndefined();
    expect(body.data?.login?.accessToken).toBeTruthy();
    expect(body.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_PENDING);
  });

  it.each([
    ['账号 PENDING / 资料 ACTIVE', 'accountOnlyPending'],
    ['账号 ACTIVE / 资料 PENDING', 'userOnlyPending'],
  ])('%s 的单边状态即使开启受限会话也被密码登录拒绝', async (_label, key) => {
    const spec = SESSION_FIXTURES.find((fixture) => fixture.key === key);
    const accountId = accountIds.get(key as FixtureKey) as number;

    // 先确认夹具确实是单边状态：另一侧仍为预期值。
    const account = await dataSource
      .getRepository(AccountEntity)
      .findOneOrFail({ where: { id: accountId } });
    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOneOrFail({ where: { accountId } });
    expect(`${account.status}/${userInfo.userState}`).not.toBe('PENDING/PENDING');

    const body = await passwordLogin(
      spec?.loginName as string,
      spec?.loginPassword as string,
      true,
    );

    expect(body.data?.login?.accessToken).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('ACCOUNT_INACTIVE');
    expect(body.errors?.[0]?.message).toBe('账户未激活或已被禁用');
  });

  it('双启用账号按正常契约签发无限制会话', async () => {
    const spec = SESSION_FIXTURES.find((fixture) => fixture.key === 'dualActiveCustomer');
    const body = await passwordLogin(
      spec?.loginName as string,
      spec?.loginPassword as string,
      false,
    );

    expect(body.errors).toBeUndefined();
    expect(body.data?.login?.restriction).toBe(SessionRestriction.NONE);
    const token = body.data?.login?.accessToken as string;
    expect(await readSessionRestriction(token)).toBe(SessionRestriction.NONE);
  });

  it('已签发双待审 Token 在仅改一侧状态后立即失效，恢复双待审后重新可用', async () => {
    const spec = SESSION_FIXTURES.find((fixture) => fixture.key === 'dualPendingToken');
    const accountId = accountIds.get('dualPendingToken') as number;

    const loginBody = await passwordLogin(
      spec?.loginName as string,
      spec?.loginPassword as string,
      true,
    );
    expect(loginBody.errors).toBeUndefined();
    const token = loginBody.data?.login?.accessToken as string;
    expect(loginBody.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_PENDING);

    expect(await readSessionRestriction(token)).toBe(SessionRestriction.ENGINEER_PENDING);
    await expectBusinessRejected(token, accountId);

    await updateAccountStatus(accountId, AccountStatus.ACTIVE);
    await expectUnauthenticated(token);

    await updateAccountStatus(accountId, AccountStatus.PENDING);
    await updateUserState(accountId, UserState.ACTIVE);
    await expectUnauthenticated(token);

    await updateUserState(accountId, UserState.PENDING);
    expect(await readSessionRestriction(token)).toBe(SessionRestriction.ENGINEER_PENDING);

    // 读回恢复后的真实事实，避免清理或断言依赖内存预期。
    const account = await dataSource
      .getRepository(AccountEntity)
      .findOneOrFail({ where: { id: accountId } });
    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOneOrFail({ where: { accountId } });
    expect(`${account.status}/${userInfo.userState}`).toBe('PENDING/PENDING');
  });
});

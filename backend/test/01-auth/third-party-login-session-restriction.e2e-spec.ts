// test/01-auth/third-party-login-session-restriction.e2e-spec.ts
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
  ThirdPartyLoginProviderEnum,
  ThirdPartyProviderEnum,
} from '@app-types/models/account.types';
import { ThirdPartySession } from '@app-types/models/third-party-auth.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { EngineerRegistrationApplicationEntity } from '@src/modules/lithography/entities/engineer-registration-application.entity';
import {
  THIRD_PARTY_PROVIDER_TOKENS,
  WeAppProviderContract,
} from '@src/modules/third-party-auth/contracts/third-party-provider.contract';
import { ThirdPartyAuthEntity } from '@src/modules/third-party-auth/third-party-auth.entity';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
  type ResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { requireOrganizationId, seedTestOrganizations } from '../utils/test-organizations';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * Q1：第三方签发的会话限制事实。
 *
 * 背景：`thirdPartyLogin → LoginByAccountIdUsecase → ExecuteLoginFlow / EnrichLoginWithIdentity`
 * 此前不计算 `restriction`，增强结果缺省为 `NONE`；每请求复核（`ValidateAccessTokenSessionUsecase`）
 * 却按数据库事实重算并由 `SessionRestrictionGuard` 拦截业务。于是「必须改密 / 工程师资格未生效」
 * 的账号用第三方登录会拿到 `restriction: NONE`，客户端被误导进入业务页，随后每个请求才被拒。
 *
 * 本规格保留真实 resolver、签发、数据库读取与每请求守卫，只把第三方凭据解析替换为受控替身：
 * 1. 正常绑定：`restriction` 与 `mySessionIdentity` 一致为 `NONE`，代表业务可访问；
 * 2. 无绑定：维持既有 `THIRDPARTY_ACCOUNT_NOT_BOUND` 拒绝；
 * 3. 待审工程师：第三方入口维持既有登录拒绝（`ACCOUNT_INACTIVE`），密码登录受限会话为
 *    `ENGINEER_PENDING`——不提供绕过审核的路径；
 * 4. 必须改密：第三方签发返回 `MUST_CHANGE_PASSWORD`，与每请求复核一致，代表业务被拒；
 * 5. 批准后成员不足：第三方签发返回 `ENGINEER_INACTIVE`，与每请求复核一致，代表业务被拒。
 */
type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type ThirdPartyLoginPayload = {
  accessToken: string;
  refreshToken: string;
  accountId: number;
  role: IdentityTypeEnum;
  restriction: SessionRestriction;
  adminLevel: number | null;
  customerOrganizationId: number | null;
  engineerOrganizationId: number | null;
  adminOrganizationId: number | null;
  registrationOrganizationId: number | null;
};

type LoginPayload = { accessToken: string; restriction: SessionRestriction };
type SessionIdentityPayload = { accountId: number; restriction: SessionRestriction };

const THIRD_PARTY_LOGIN_MUTATION = `
  mutation ThirdPartyLogin($input: ThirdPartyLoginInput!) {
    thirdPartyLogin(input: $input) {
      accessToken
      refreshToken
      accountId
      role
      restriction
      adminLevel
      customerOrganizationId
      engineerOrganizationId
      adminOrganizationId
      registrationOrganizationId
    }
  }
`;

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

const ORG_CODE = 'E2E_Q1_PRIMARY';
const ORG_NAME = 'E2E Q1 第三方会话限制组织';
const APPLICATION_NOTE = 'E2E Q1 第三方会话限制申请';

const CREDENTIAL_BOUND = 'q1-bound';
const CREDENTIAL_UNBOUND = 'q1-unbound';
const CREDENTIAL_PENDING = 'q1-pending';
const CREDENTIAL_MUST_CHANGE = 'q1-must-change';
const CREDENTIAL_ENGINEER_INACTIVE = 'q1-engineer-inactive';

const OPENID_BOUND = 'weapp_openid_e2e_q1_bound';
const OPENID_UNBOUND = 'weapp_openid_e2e_q1_unbound';
const OPENID_PENDING = 'weapp_openid_e2e_q1_pending';
const OPENID_MUST_CHANGE = 'weapp_openid_e2e_q1_must_change';
const OPENID_ENGINEER_INACTIVE = 'weapp_openid_e2e_q1_engineer_inactive';

interface SessionFixtureSpec {
  readonly key: 'pendingEngineer' | 'mustChangeCustomer' | 'engineerInactive';
  readonly loginName: string;
  readonly loginEmail: string;
  readonly loginPassword: string;
  readonly status: AccountStatus;
  readonly userState: UserState;
  readonly identityHint: IdentityTypeEnum;
  readonly accessGroup: IdentityTypeEnum[];
  readonly mustChangePassword: boolean;
}

const PENDING_ENGINEER: SessionFixtureSpec = {
  key: 'pendingEngineer',
  loginName: 'q1engpending',
  loginEmail: 'q1.engineer.pending@example.com',
  loginPassword: 'Q1Pending@2026',
  status: AccountStatus.PENDING,
  userState: UserState.PENDING,
  identityHint: IdentityTypeEnum.ENGINEER,
  accessGroup: [IdentityTypeEnum.ENGINEER],
  mustChangePassword: false,
};

const MUST_CHANGE_CUSTOMER: SessionFixtureSpec = {
  key: 'mustChangeCustomer',
  loginName: 'q1custmustchange',
  loginEmail: 'q1.customer.mustchange@example.com',
  loginPassword: 'Q1MustChange@2026',
  status: AccountStatus.ACTIVE,
  userState: UserState.ACTIVE,
  identityHint: IdentityTypeEnum.CUSTOMER,
  accessGroup: [IdentityTypeEnum.CUSTOMER],
  mustChangePassword: true,
};

const ENGINEER_INACTIVE: SessionFixtureSpec = {
  key: 'engineerInactive',
  loginName: 'q1enginactive',
  loginEmail: 'q1.engineer.inactive@example.com',
  loginPassword: 'Q1Inactive@2026',
  status: AccountStatus.ACTIVE,
  userState: UserState.ACTIVE,
  identityHint: IdentityTypeEnum.ENGINEER,
  accessGroup: [IdentityTypeEnum.ENGINEER],
  mustChangePassword: false,
};

const SESSION_FIXTURES: readonly SessionFixtureSpec[] = [
  PENDING_ENGINEER,
  MUST_CHANGE_CUSTOMER,
  ENGINEER_INACTIVE,
];

const toFixtureFingerprint = (spec: SessionFixtureSpec): ResidueAccountFingerprint => ({
  loginName: spec.loginName,
  loginEmail: spec.loginEmail,
  status: spec.status,
  identityHint: spec.identityHint,
  nickname: `${spec.loginName}_nickname`,
  accessGroup: spec.accessGroup,
});

/** 仅按受控凭据返回对应 openid，不调用真实微信服务。 */
const mockWeAppProvider: WeAppProviderContract = {
  provider: ThirdPartyProviderEnum.WEAPP,
  exchangeCredential: ({ authCredential }): Promise<ThirdPartySession> => {
    if (authCredential === CREDENTIAL_UNBOUND) {
      return Promise.resolve({
        providerUserId: OPENID_UNBOUND,
        unionId: null,
        profile: { nickname: 'Q1Unbound' },
        sessionKeyRaw: 'mock-session-key-q1-unbound',
      });
    }
    const providerUserId =
      authCredential === CREDENTIAL_PENDING
        ? OPENID_PENDING
        : authCredential === CREDENTIAL_MUST_CHANGE
          ? OPENID_MUST_CHANGE
          : authCredential === CREDENTIAL_ENGINEER_INACTIVE
            ? OPENID_ENGINEER_INACTIVE
            : OPENID_BOUND;
    return Promise.resolve({
      providerUserId,
      unionId: null,
      profile: { nickname: 'Q1Bound' },
      sessionKeyRaw: `mock-session-key-${providerUserId}`,
    });
  },
  getAccessToken: () => Promise.resolve('mock-access-token'),
  getPhoneNumber: () =>
    Promise.resolve({
      phoneNumber: '13800138000',
      purePhoneNumber: '13800138000',
      countryCode: '86',
    }),
  createWxaCodeUnlimit: () =>
    Promise.resolve({
      buffer: Buffer.from('mock-qrcode'),
      contentType: 'image/png',
    }),
};

describe('第三方签发的会话限制事实 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();
  const accountIds = new Map<SessionFixtureSpec['key'] | 'guest' | 'admin', number>();

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    })
      .overrideProvider(THIRD_PARTY_PROVIDER_TOKENS.WEAPP)
      .useValue(mockWeAppProvider)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    // 预清理：只按本规格账号完整指纹回收已知残留。
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        accounts: SESSION_FIXTURES.map(toFixtureFingerprint),
      },
      helper: 'third-party-login-session-restriction.e2e-spec beforeAll 预清理',
    });

    await seedTestAccounts({ dataSource, includeKeys: ['guest', 'admin'], ownership });
    accountIds.set(
      'guest',
      await getAccountIdByLoginNameOrFail(testAccountsConfig.guest.loginName),
    );
    const adminAccountId = await getAccountIdByLoginNameOrFail(testAccountsConfig.admin.loginName);
    accountIds.set('admin', adminAccountId);

    for (const spec of SESSION_FIXTURES) {
      accountIds.set(spec.key, await seedSessionFixture(spec));
    }

    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [{ organizationCode: ORG_CODE, name: ORG_NAME, kind: 'CLIENT' }],
      ownership,
    });
    const organizationId = requireOrganizationId(organizationIds, ORG_CODE);

    await seedEngineerApplication({
      accountId: accountIds.get('pendingEngineer') as number,
      organizationId,
      status: 'PENDING',
      reviewerAccountId: null,
    });
    await seedEngineerApplication({
      accountId: accountIds.get('engineerInactive') as number,
      organizationId,
      status: 'APPROVED',
      reviewerAccountId: adminAccountId,
    });

    await seedThirdPartyBinding({
      accountId: accountIds.get('guest') as number,
      providerUserId: OPENID_BOUND,
    });
    await seedThirdPartyBinding({
      accountId: accountIds.get('pendingEngineer') as number,
      providerUserId: OPENID_PENDING,
    });
    await seedThirdPartyBinding({
      accountId: accountIds.get('mustChangeCustomer') as number,
      providerUserId: OPENID_MUST_CHANGE,
    });
    await seedThirdPartyBinding({
      accountId: accountIds.get('engineerInactive') as number,
      providerUserId: OPENID_ENGINEER_INACTIVE,
    });
  }, 60000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        helper: 'third-party-login-session-restriction.e2e-spec afterAll 收尾',
      });
    }
    if (app) await app.close();
  });

  const getAccountIdByLoginNameOrFail = async (loginName: string): Promise<number> => {
    const account = await dataSource
      .getRepository(AccountEntity)
      .findOneOrFail({ where: { loginName } });
    return account.id;
  };

  /** 受控夹具：账号 + 资料 + 强制改密标记同一事务落库，提交后登记真实 ID 与预期事实。 */
  const seedSessionFixture = async (spec: SessionFixtureSpec): Promise<number> => {
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
          mustChangePassword: spec.mustChangePassword,
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

  const seedEngineerApplication = async (params: {
    accountId: number;
    organizationId: number;
    status: 'PENDING' | 'APPROVED';
    reviewerAccountId: number | null;
  }): Promise<void> => {
    const repository = dataSource.getRepository(EngineerRegistrationApplicationEntity);
    const isPending = params.status === 'PENDING';
    const saved = await repository.save(
      repository.create({
        accountId: params.accountId,
        organizationId: params.organizationId,
        status: params.status,
        applicationNote: APPLICATION_NOTE,
        submittedAt: new Date(Date.now() - 60_000),
        reviewedByAccountId: isPending ? null : params.reviewerAccountId,
        reviewedAt: isPending ? null : new Date(),
        reviewComment: null,
      }),
    );
    recordOwnedResource(ownership, 'engineerRegistrationApplication', saved.id, {
      accountId: params.accountId,
      organizationId: params.organizationId,
      applicationNote: APPLICATION_NOTE,
    });
  };

  const seedThirdPartyBinding = async (params: {
    accountId: number;
    providerUserId: string;
  }): Promise<void> => {
    const repository = dataSource.getRepository(ThirdPartyAuthEntity);
    const saved = await repository.save(
      repository.create({
        accountId: params.accountId,
        provider: ThirdPartyProviderEnum.WEAPP,
        providerUserId: params.providerUserId,
        unionId: null,
        accessToken: null,
      }),
    );
    recordOwnedResource(ownership, 'thirdPartyAuth', saved.id, {
      accountId: params.accountId,
      provider: ThirdPartyProviderEnum.WEAPP,
      providerUserId: params.providerUserId,
      unionId: null,
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

  const thirdPartyLogin = (
    authCredential: string,
  ): Promise<GqlBody<{ thirdPartyLogin?: ThirdPartyLoginPayload }>> =>
    gql({
      query: THIRD_PARTY_LOGIN_MUTATION,
      variables: {
        input: {
          provider: ThirdPartyLoginProviderEnum.WEAPP,
          authCredential,
          audience: AudienceTypeEnum.SSTSTEST,
        },
      },
    });

  const passwordLogin = (
    loginName: string,
    loginPassword: string,
  ): Promise<GqlBody<{ login?: LoginPayload }>> =>
    gql({
      query: LOGIN_MUTATION,
      variables: {
        input: {
          loginName,
          loginPassword,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
          allowRestrictedSession: true,
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

  const expectBusinessRejected = async (token: string, accountId: number): Promise<void> => {
    const body = await gql<{ userInfo?: { accountId: number } }>({
      query: BUSINESS_USER_INFO_QUERY,
      variables: { accountId },
      token,
    });
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
    expect(body.errors?.[0]?.message).toBe('当前会话受限，请先完成必要的账号操作');
  };

  it('正常绑定：restriction 与 mySessionIdentity 一致为 NONE，代表业务可访问', async () => {
    const body = await thirdPartyLogin(CREDENTIAL_BOUND);
    expect(body.errors).toBeUndefined();

    const payload = body.data?.thirdPartyLogin;
    expect(payload?.accountId).toBe(accountIds.get('guest'));
    expect(payload?.restriction).toBe(SessionRestriction.NONE);
    expect(payload?.adminLevel).toBeNull();
    expect(payload?.customerOrganizationId).toBeNull();
    expect(payload?.engineerOrganizationId).toBeNull();
    expect(payload?.adminOrganizationId).toBeNull();
    expect(payload?.registrationOrganizationId).toBeNull();

    const token = payload?.accessToken as string;
    expect(await readSessionRestriction(token)).toBe(SessionRestriction.NONE);

    const businessBody = await gql<{ userInfo?: { accountId: number } }>({
      query: BUSINESS_USER_INFO_QUERY,
      variables: { accountId: accountIds.get('guest') },
      token,
    });
    expect(businessBody.errors).toBeUndefined();
    expect(businessBody.data?.userInfo?.accountId).toBe(accountIds.get('guest'));
  });

  it('未绑定：维持既有 THIRDPARTY_ACCOUNT_NOT_BOUND 拒绝', async () => {
    const body = await thirdPartyLogin(CREDENTIAL_UNBOUND);
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.[0]?.message).toBe('该第三方账户未绑定');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('THIRDPARTY_ACCOUNT_NOT_BOUND');
  });

  it('待审工程师：第三方入口维持登录拒绝，密码受限会话返回 ENGINEER_PENDING', async () => {
    const body = await thirdPartyLogin(CREDENTIAL_PENDING);
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.[0]?.message).toBe('账户未激活');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('ACCOUNT_INACTIVE');

    const passwordBody = await passwordLogin(
      PENDING_ENGINEER.loginName,
      PENDING_ENGINEER.loginPassword,
    );
    expect(passwordBody.errors).toBeUndefined();
    expect(passwordBody.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_PENDING);
  });

  it('必须改密：第三方签发返回 MUST_CHANGE_PASSWORD，每请求复核一致且代表业务被拒', async () => {
    const body = await thirdPartyLogin(CREDENTIAL_MUST_CHANGE);
    expect(body.errors).toBeUndefined();

    const payload = body.data?.thirdPartyLogin;
    expect(payload?.accountId).toBe(accountIds.get('mustChangeCustomer'));
    expect(payload?.restriction).toBe(SessionRestriction.MUST_CHANGE_PASSWORD);
    expect(payload?.registrationOrganizationId).toBeNull();

    const token = payload?.accessToken as string;
    expect(await readSessionRestriction(token)).toBe(SessionRestriction.MUST_CHANGE_PASSWORD);
    await expectBusinessRejected(token, accountIds.get('mustChangeCustomer') as number);

    // 密码登录回归：同一事实在密码入口同样体现。
    const passwordBody = await passwordLogin(
      MUST_CHANGE_CUSTOMER.loginName,
      MUST_CHANGE_CUSTOMER.loginPassword,
    );
    expect(passwordBody.errors).toBeUndefined();
    expect(passwordBody.data?.login?.restriction).toBe(SessionRestriction.MUST_CHANGE_PASSWORD);
  });

  it('批准后成员不足：第三方签发返回 ENGINEER_INACTIVE，每请求复核一致且代表业务被拒', async () => {
    const body = await thirdPartyLogin(CREDENTIAL_ENGINEER_INACTIVE);
    expect(body.errors).toBeUndefined();

    const payload = body.data?.thirdPartyLogin;
    expect(payload?.accountId).toBe(accountIds.get('engineerInactive'));
    expect(payload?.restriction).toBe(SessionRestriction.ENGINEER_INACTIVE);
    expect(payload?.engineerOrganizationId).toBeNull();
    expect(payload?.registrationOrganizationId).not.toBeNull();

    const token = payload?.accessToken as string;
    expect(await readSessionRestriction(token)).toBe(SessionRestriction.ENGINEER_INACTIVE);
    await expectBusinessRejected(token, accountIds.get('engineerInactive') as number);

    const passwordBody = await passwordLogin(
      ENGINEER_INACTIVE.loginName,
      ENGINEER_INACTIVE.loginPassword,
    );
    expect(passwordBody.errors).toBeUndefined();
    expect(passwordBody.data?.login?.restriction).toBe(SessionRestriction.ENGINEER_INACTIVE);
  });
});

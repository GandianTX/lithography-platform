// test/04-user-info/change-my-password-must-change.e2e-spec.ts
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { ADMIN_ACCOUNT_RESET_OPTIONS } from '../../src/modules/account/admin-account-reset.contract';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { AccountService } from '../../src/modules/account/base/services/account.service';
import { EngineerRegistrationApplicationEntity } from '../../src/modules/lithography/entities/engineer-registration-application.entity';
import { postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
  updateOwnedExpectation,
  type OwnedResourceLedger,
  type ResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { seedTestOrganizations, requireOrganizationId } from '../utils/test-organizations';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * I1（P1）：强制改密必须实际更换密码的真实 GraphQL + MySQL E2E。
 *
 * 缺陷背景：`must_change_password=true` 的账号提交「与当前密码相同」的新密码时，旧实现会在
 * 同一 UPDATE 内重写同值哈希并清除强制改密标记，用户重新登录即恢复完整访问，却从未更换凭据。
 *
 * 本规格断言跨进程可观察事实：
 * 1. 同值提交被拒为 `BAD_USER_INPUT` / `MY_ACCOUNT_NEW_PASSWORD_UNCHANGED`，数据库哈希与
 *    `must_change_password` 均不变，重新登录仍为 `MUST_CHANGE_PASSWORD`，代表业务仍受限；
 * 2. 错误当前密码同样保持哈希与标记（既有语义对照）；
 * 3. 异值提交真正生效：旧密码登录失败、新密码登录成功；正常客户恢复 `NONE`，工程师仍为
 *    待审 / 已拒绝（异值改密只解除强制改密，不改变申请事实）。
 *
 * 造数纪律：
 * - `must_change_password` 的业务入口是管理员重置密码（`adminResetUserPassword` 在同一事务
 *   内与哈希一并置位），由 `admin-user-management.e2e-spec.ts` 覆盖；本规格只关心「已处于
 *   强制改密」后的本人改密语义，故仍由受控夹具直接写入该列；夹具在同一事务成功后
 *   才登记真实 ID 与预期事实，清理走 `runGuardedSpecCleanup` 的精确台账；
 * - 待审 / 已拒绝工程师的申请行是真实 ``engineer_registration_application`` 记录（含审核人、
 *   审核时间与拒绝意见），因此会话限制由真实申请状态而非伪造字段产生；
 * - 组内存在**已声明**的顺序依赖：同一账号先验证同值/错误密码被拒（均不写库），再验证异值成功。
 */
type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type LoginPayload = { accessToken: string; restriction: SessionRestriction };
type SessionIdentityPayload = { accountId: number; restriction: SessionRestriction };
type ChangePasswordPayload = { isUpdated: boolean; notice: string };

const CHANGE_MY_PASSWORD_MUTATION = `
  mutation ChangeMyPassword($input: ChangeMyPasswordInput!) {
    changeMyPassword(input: $input) { isUpdated notice }
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

const UPDATE_MY_ACCOUNT_SETTINGS_MUTATION = `
  mutation UpdateMyAccountSettings($input: UpdateMyAccountSettingsInput!) {
    updateMyAccountSettings(input: $input) { isUpdated }
  }
`;

const UPDATE_MY_ACCOUNT_PROFILE_MUTATION = `
  mutation UpdateMyAccountProfile($input: UpdateMyAccountProfileInput!) {
    updateMyAccountProfile(input: $input) { isUpdated }
  }
`;

const ORG_CODE = 'E2E_I1_PRIMARY';
const ORG_NAME = 'E2E I1 强制改密规格组织';

const APPLICATION_NOTE = 'E2E I1 强制改密规格申请';

/** 部署默认重置密码（经 DI 覆盖注入，与管理员默认重置入口同一配置项） */
const DEPLOY_DEFAULT_PASSWORD = 'E2eDeploy#Default2026';
/** 与默认密码 NFKC 等价的整角写法：策略层先做 NFKC，故能到达默认密码守卫 */
const FULL_WIDTH_DEPLOY_DEFAULT_PASSWORD = 'Ｅ２ｅＤｅｐｌｏｙ＃Ｄｅｆａｕｌｔ２０２６';

interface ForcedChangeAccountSpec {
  readonly loginName: string;
  readonly loginEmail: string;
  readonly loginPassword: string;
  readonly status: AccountStatus;
  readonly identityHint: IdentityTypeEnum;
  readonly accessGroup: IdentityTypeEnum[];
  readonly userState: UserState;
}

const CUSTOMER: ForcedChangeAccountSpec = {
  loginName: 'i1custforcechange',
  loginEmail: 'i1.customer@example.com',
  loginPassword: 'I1Customer@2026',
  status: AccountStatus.ACTIVE,
  identityHint: IdentityTypeEnum.CUSTOMER,
  accessGroup: [IdentityTypeEnum.CUSTOMER],
  userState: UserState.ACTIVE,
};

const PENDING_ENGINEER: ForcedChangeAccountSpec = {
  loginName: 'i1engpending',
  loginEmail: 'i1.engineer.pending@example.com',
  loginPassword: 'I1Pending@2026',
  status: AccountStatus.PENDING,
  identityHint: IdentityTypeEnum.ENGINEER,
  accessGroup: [IdentityTypeEnum.ENGINEER],
  userState: UserState.PENDING,
};

const REJECTED_ENGINEER: ForcedChangeAccountSpec = {
  loginName: 'i1engrejected',
  loginEmail: 'i1.engineer.rejected@example.com',
  loginPassword: 'I1Rejected@2026',
  status: AccountStatus.PENDING,
  identityHint: IdentityTypeEnum.ENGINEER,
  accessGroup: [IdentityTypeEnum.ENGINEER],
  userState: UserState.PENDING,
};

const toFixtureFingerprint = (spec: ForcedChangeAccountSpec): ResidueAccountFingerprint => ({
  loginName: spec.loginName,
  loginEmail: spec.loginEmail,
  status: spec.status,
  identityHint: spec.identityHint,
  nickname: `${spec.loginName}_nickname`,
  accessGroup: spec.accessGroup,
});

describe('changeMyPassword 强制改密必须实际换密 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const ownership: OwnedResourceLedger = createOwnedResourceLedger();
  const accountIds = new Map<string, number>();
  let adminAccountId: number;

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    })
      // 显式注入部署默认重置密码：覆盖真实环境配置，使「拒绝默认值」用例可确定复现
      .overrideProvider(ADMIN_ACCOUNT_RESET_OPTIONS)
      .useValue({ defaultPassword: DEPLOY_DEFAULT_PASSWORD })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    // 预清理（窄范围）：只按本规格账号完整指纹回收已知残留，不整表清成员/账号
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        accounts: [
          ...([CUSTOMER, PENDING_ENGINEER, REJECTED_ENGINEER] as ForcedChangeAccountSpec[]).map(
            toFixtureFingerprint,
          ),
          toResidueAccountFingerprint(testAccountsConfig.admin),
        ],
      },
      helper: 'change-my-password-must-change.e2e-spec beforeAll 预清理',
    });

    await seedTestAccounts({ dataSource, includeKeys: ['admin'], ownership });
    adminAccountId = (
      await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({ where: { loginName: testAccountsConfig.admin.loginName } })
    ).id;

    accountIds.set('customer', await seedForcedChangeAccount(CUSTOMER));
    accountIds.set('pendingEngineer', await seedForcedChangeAccount(PENDING_ENGINEER));
    accountIds.set('rejectedEngineer', await seedForcedChangeAccount(REJECTED_ENGINEER));

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
      accountId: accountIds.get('rejectedEngineer') as number,
      organizationId,
      status: 'REJECTED',
      reviewerAccountId: adminAccountId,
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        helper: 'change-my-password-must-change.e2e-spec afterAll 收尾',
      });
    }
    if (app) await app.close();
  });

  /** 受控夹具：账号 + 资料 + 强制改密标记在同一事务内落库，成功后登记真实 ID 与预期事实。 */
  const seedForcedChangeAccount = async (spec: ForcedChangeAccountSpec): Promise<number> => {
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
          mustChangePassword: true,
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
    status: 'PENDING' | 'REJECTED';
    reviewerAccountId: number | null;
  }): Promise<void> => {
    const repository = dataSource.getRepository(EngineerRegistrationApplicationEntity);
    const submittedAt = new Date(Date.now() - 60_000);
    const isRejected = params.status === 'REJECTED';
    const saved = await repository.save(
      repository.create({
        accountId: params.accountId,
        organizationId: params.organizationId,
        status: params.status,
        applicationNote: APPLICATION_NOTE,
        submittedAt,
        reviewedByAccountId: isRejected ? params.reviewerAccountId : null,
        reviewedAt: isRejected ? new Date() : null,
        reviewComment: isRejected ? 'E2E I1 拒绝原因' : null,
      }),
    );
    recordOwnedResource(ownership, 'engineerRegistrationApplication', saved.id, {
      accountId: params.accountId,
      organizationId: params.organizationId,
      applicationNote: APPLICATION_NOTE,
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

  /** Web 登录入口形态：显式允许受限会话（待审 / 已拒绝 / 强制改密均可签发令牌）。 */
  const loginAs = (
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

  const expectLoginRestriction = async (
    loginName: string,
    loginPassword: string,
    restriction: SessionRestriction,
  ): Promise<string> => {
    const body = await loginAs(loginName, loginPassword);
    expect(body.errors).toBeUndefined();
    expect(body.data?.login?.restriction).toBe(restriction);
    const token = body.data?.login?.accessToken;
    expect(typeof token).toBe('string');
    return token as string;
  };

  const expectLoginFails = async (loginName: string, loginPassword: string): Promise<void> => {
    const body = await loginAs(loginName, loginPassword);
    expect(body.data?.login?.accessToken).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  };

  const changePassword = (
    token: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<GqlBody<{ changeMyPassword?: ChangePasswordPayload }>> =>
    gql({
      query: CHANGE_MY_PASSWORD_MUTATION,
      variables: { input: { currentPassword, newPassword } },
      token,
    });

  const readAccountRow = (accountId: number): Promise<AccountEntity | null> =>
    dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } });

  const readSessionRestriction = async (token: string): Promise<SessionRestriction> => {
    const body = await gql<{ mySessionIdentity?: SessionIdentityPayload }>({
      query: MY_SESSION_IDENTITY_QUERY,
      token,
    });
    expect(body.errors).toBeUndefined();
    return body.data?.mySessionIdentity?.restriction as SessionRestriction;
  };

  /** 代表业务：强制改密未完成时，旧广写与 Web 窄写入口都必须被 MustChangePasswordGuard 拒绝。 */
  const expectBusinessRejected = async (token: string): Promise<void> => {
    const body = await gql<{ updateMyAccountSettings?: { isUpdated: boolean } }>({
      query: UPDATE_MY_ACCOUNT_SETTINGS_MUTATION,
      variables: { input: { nickname: 'i1_should_not_persist' } },
      token,
    });
    expect(body.data?.updateMyAccountSettings).toBeUndefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('INSUFFICIENT_PERMISSIONS');

    const narrowBody = await gql<{ updateMyAccountProfile?: { isUpdated: boolean } }>({
      query: UPDATE_MY_ACCOUNT_PROFILE_MUTATION,
      variables: { input: { nickname: 'i1_narrow_should_not_persist' } },
      token,
    });
    expect(narrowBody.data?.updateMyAccountProfile).toBeUndefined();
    expect(narrowBody.errors).toHaveLength(1);
    expect(narrowBody.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(narrowBody.errors?.[0]?.extensions?.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
  };

  /** 同值提交被拒的公共断言：大类/细码、零写入、身份与代表业务均保持受限。 */
  const expectSameValueRejected = async (params: {
    spec: ForcedChangeAccountSpec;
    accountId: number;
    token: string;
  }): Promise<void> => {
    const rowBefore = await readAccountRow(params.accountId);
    expect(rowBefore?.mustChangePassword).toBe(true);
    const hashBefore = rowBefore?.loginPassword;

    const body = await changePassword(
      params.token,
      params.spec.loginPassword,
      params.spec.loginPassword,
    );

    expect(body.data?.changeMyPassword).toBeUndefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('MY_ACCOUNT_NEW_PASSWORD_UNCHANGED');
    expect(body.errors?.[0]?.message).toBe('新密码需与当前密码不同');

    const rowAfter = await readAccountRow(params.accountId);
    expect(rowAfter?.loginPassword).toBe(hashBefore);
    expect(rowAfter?.mustChangePassword).toBe(true);

    // 原密码仍可登录，重新计算出的会话限制仍优先为强制改密
    const reloginToken = await expectLoginRestriction(
      params.spec.loginName,
      params.spec.loginPassword,
      SessionRestriction.MUST_CHANGE_PASSWORD,
    );
    expect(await readSessionRestriction(reloginToken)).toBe(
      SessionRestriction.MUST_CHANGE_PASSWORD,
    );
    await expectBusinessRejected(reloginToken);
  };

  /** 异值提交成功的公共断言：真正换密，并按申请事实重算限制状态。 */
  const expectChangedPassword = async (params: {
    spec: ForcedChangeAccountSpec;
    accountId: number;
    token: string;
    newPassword: string;
    expectedRestriction: SessionRestriction;
  }): Promise<void> => {
    const hashBefore = (await readAccountRow(params.accountId))?.loginPassword;

    const body = await changePassword(params.token, params.spec.loginPassword, params.newPassword);

    expect(body.errors).toBeUndefined();
    expect(body.data?.changeMyPassword).toMatchObject({ isUpdated: true });

    const row = await readAccountRow(params.accountId);
    expect(row?.mustChangePassword).toBe(false);
    expect(row?.loginPassword).not.toBe(hashBefore);

    await expectLoginFails(params.spec.loginName, params.spec.loginPassword);
    const freshToken = await expectLoginRestriction(
      params.spec.loginName,
      params.newPassword,
      params.expectedRestriction,
    );
    expect(await readSessionRestriction(freshToken)).toBe(params.expectedRestriction);
  };

  /**
   * 提交部署默认重置密码被拒的公共断言：`BAD_USER_INPUT` / 通用细码 `MY_ACCOUNT_NEW_PASSWORD_NOT_ALLOWED`、
   * 通用文案、零写入（哈希与标记不变）、会话不退出、原密码仍可登录，且响应不回显配置值。
   */
  const expectDefaultPasswordRejected = async (newPassword: string): Promise<void> => {
    const token = await expectLoginRestriction(
      testAccountsConfig.admin.loginName,
      testAccountsConfig.admin.loginPassword,
      SessionRestriction.NONE,
    );
    const rowBefore = await readAccountRow(adminAccountId);
    const hashBefore = rowBefore?.loginPassword;
    expect(rowBefore?.mustChangePassword).toBe(false);

    const body = await changePassword(token, testAccountsConfig.admin.loginPassword, newPassword);

    expect(body.data?.changeMyPassword).toBeUndefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(body.errors?.[0]?.extensions?.errorCode).toBe('MY_ACCOUNT_NEW_PASSWORD_NOT_ALLOWED');
    expect(body.errors?.[0]?.message).toBe('新密码不被允许，请更换其他密码');
    expect(JSON.stringify(body)).not.toContain(DEPLOY_DEFAULT_PASSWORD);
    expect(JSON.stringify(body)).not.toContain(FULL_WIDTH_DEPLOY_DEFAULT_PASSWORD);

    const rowAfter = await readAccountRow(adminAccountId);
    expect(rowAfter?.loginPassword).toBe(hashBefore);
    expect(rowAfter?.mustChangePassword).toBe(false);

    expect(await readSessionRestriction(token)).toBe(SessionRestriction.NONE);
    await expectLoginRestriction(
      testAccountsConfig.admin.loginName,
      testAccountsConfig.admin.loginPassword,
      SessionRestriction.NONE,
    );
  };

  describe('正常客户', () => {
    it('同值改密被拒：哈希与标记不变、仍为 MUST_CHANGE_PASSWORD、代表业务仍受限', async () => {
      const token = await expectLoginRestriction(
        CUSTOMER.loginName,
        CUSTOMER.loginPassword,
        SessionRestriction.MUST_CHANGE_PASSWORD,
      );

      await expectSameValueRejected({
        spec: CUSTOMER,
        accountId: accountIds.get('customer') as number,
        token,
      });
    });

    it('错误当前密码同样保持哈希与标记（既有语义对照）', async () => {
      const token = await expectLoginRestriction(
        CUSTOMER.loginName,
        CUSTOMER.loginPassword,
        SessionRestriction.MUST_CHANGE_PASSWORD,
      );
      const hashBefore = (await readAccountRow(accountIds.get('customer') as number))
        ?.loginPassword;

      const body = await changePassword(token, 'Totally#Wrong2026', 'I1Customer#New2026');

      expect(body.data?.changeMyPassword).toBeUndefined();
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors?.[0]?.extensions?.errorCode).toBe('MY_ACCOUNT_CURRENT_PASSWORD_MISMATCH');

      const rowAfter = await readAccountRow(accountIds.get('customer') as number);
      expect(rowAfter?.loginPassword).toBe(hashBefore);
      expect(rowAfter?.mustChangePassword).toBe(true);
      expect(await readSessionRestriction(token)).toBe(SessionRestriction.MUST_CHANGE_PASSWORD);
    });

    it('异值改密真正生效：旧密码拒绝、新密码登录恢复 NONE', async () => {
      const token = await expectLoginRestriction(
        CUSTOMER.loginName,
        CUSTOMER.loginPassword,
        SessionRestriction.MUST_CHANGE_PASSWORD,
      );
      const newPassword = 'I1Customer#New2026';

      await expectChangedPassword({
        spec: CUSTOMER,
        accountId: accountIds.get('customer') as number,
        token,
        newPassword,
        expectedRestriction: SessionRestriction.NONE,
      });

      // 改密前的旧 Token 按既有契约不做服务端撤销，但每请求复核已按数据库事实重算为 NONE
      expect(await readSessionRestriction(token)).toBe(SessionRestriction.NONE);
    });
  });

  describe('待审工程师', () => {
    it('同值改密被拒后仍为 MUST_CHANGE_PASSWORD，代表业务仍受限', async () => {
      const token = await expectLoginRestriction(
        PENDING_ENGINEER.loginName,
        PENDING_ENGINEER.loginPassword,
        SessionRestriction.MUST_CHANGE_PASSWORD,
      );

      await expectSameValueRejected({
        spec: PENDING_ENGINEER,
        accountId: accountIds.get('pendingEngineer') as number,
        token,
      });
    });

    it('异值改密生效后继续为 ENGINEER_PENDING', async () => {
      const token = await expectLoginRestriction(
        PENDING_ENGINEER.loginName,
        PENDING_ENGINEER.loginPassword,
        SessionRestriction.MUST_CHANGE_PASSWORD,
      );
      const newPassword = 'I1Pending#New2026';

      await expectChangedPassword({
        spec: PENDING_ENGINEER,
        accountId: accountIds.get('pendingEngineer') as number,
        token,
        newPassword,
        expectedRestriction: SessionRestriction.ENGINEER_PENDING,
      });
    });

    it('解除强制改密后混传姓名仍被拒为 FORBIDDEN，且不产生任何写入', async () => {
      const token = await expectLoginRestriction(
        PENDING_ENGINEER.loginName,
        'I1Pending#New2026',
        SessionRestriction.ENGINEER_PENDING,
      );

      // 受限会话白名单只含 nickname / phone / contactEmail：混传 realName 整体拒绝
      const body = await gql<{ updateMyAccountSettings?: { isUpdated: boolean } }>({
        query: UPDATE_MY_ACCOUNT_SETTINGS_MUTATION,
        variables: { input: { nickname: 'i1_restricted_write', realName: '受限会话不可改姓名' } },
        token,
      });

      expect(body.data?.updateMyAccountSettings).toBeUndefined();
      expect(body.errors).toHaveLength(1);
      expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(body.errors?.[0]?.extensions?.errorCode).toBe('INSUFFICIENT_PERMISSIONS');

      // 窄写入口同样只放行白名单：混传 realName 整体拒绝且零部分写入
      const narrowBody = await gql<{ updateMyAccountProfile?: { isUpdated: boolean } }>({
        query: UPDATE_MY_ACCOUNT_PROFILE_MUTATION,
        variables: {
          input: { nickname: 'i1_narrow_restricted_write', realName: '受限会话不可改姓名' },
        },
        token,
      });
      expect(narrowBody.data?.updateMyAccountProfile).toBeUndefined();
      expect(narrowBody.errors).toHaveLength(1);
      expect(narrowBody.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(narrowBody.errors?.[0]?.extensions?.errorCode).toBe('INSUFFICIENT_PERMISSIONS');

      // 整体拒绝：合法昵称也不得部分写入
      const info = await dataSource
        .getRepository(UserInfoEntity)
        .findOne({ where: { accountId: accountIds.get('pendingEngineer') as number } });
      expect(info?.nickname).toBe(`${PENDING_ENGINEER.loginName}_nickname`);
      expect(info?.realName).toBeNull();

      // 白名单内字段经窄写入口成功写入
      const allowedBody = await gql<{ updateMyAccountProfile?: { isUpdated: boolean } }>({
        query: UPDATE_MY_ACCOUNT_PROFILE_MUTATION,
        variables: {
          input: {
            nickname: 'i1_narrow_allowed',
            phone: '13600003333',
            contactEmail: 'i1.narrow@example.com',
          },
        },
        token,
      });
      expect(allowedBody.errors).toBeUndefined();
      expect(allowedBody.data?.updateMyAccountProfile?.isUpdated).toBe(true);
      const updatedInfo = await dataSource
        .getRepository(UserInfoEntity)
        .findOne({ where: { accountId: accountIds.get('pendingEngineer') as number } });
      expect(updatedInfo?.nickname).toBe('i1_narrow_allowed');
      expect(updatedInfo?.phone).toBe('13600003333');
      expect(updatedInfo?.email).toBe('i1.narrow@example.com');
      expect(updatedInfo?.realName).toBeNull();
      updateOwnedExpectation(ownership, 'account', accountIds.get('pendingEngineer') as number, {
        nickname: 'i1_narrow_allowed',
        userInfoEmail: 'i1.narrow@example.com',
      });
    });
  });

  describe('已拒绝工程师', () => {
    it('同值改密被拒后仍为 MUST_CHANGE_PASSWORD，代表业务仍受限', async () => {
      const token = await expectLoginRestriction(
        REJECTED_ENGINEER.loginName,
        REJECTED_ENGINEER.loginPassword,
        SessionRestriction.MUST_CHANGE_PASSWORD,
      );

      await expectSameValueRejected({
        spec: REJECTED_ENGINEER,
        accountId: accountIds.get('rejectedEngineer') as number,
        token,
      });
    });

    it('异值改密生效后继续为 ENGINEER_REJECTED', async () => {
      const token = await expectLoginRestriction(
        REJECTED_ENGINEER.loginName,
        REJECTED_ENGINEER.loginPassword,
        SessionRestriction.MUST_CHANGE_PASSWORD,
      );
      const newPassword = 'I1Rejected#New2026';

      await expectChangedPassword({
        spec: REJECTED_ENGINEER,
        accountId: accountIds.get('rejectedEngineer') as number,
        token,
        newPassword,
        expectedRestriction: SessionRestriction.ENGINEER_REJECTED,
      });
    });
  });

  describe('普通账号（未被要求强制改密）', () => {
    it('提交部署默认重置密码被拒：哈希与标记不变、会话不退出、原密码仍可登录', async () => {
      await expectDefaultPasswordRejected(DEPLOY_DEFAULT_PASSWORD);
    });

    it('与部署默认密码 NFKC 等价的整角写法同样被拒，不能改写默认值守卫', async () => {
      await expectDefaultPasswordRejected(FULL_WIDTH_DEPLOY_DEFAULT_PASSWORD);
    });

    it('同一错误当前密码下，默认值 / NFKC 等价 / 其他合规值返回完全一致的当前密码错误', async () => {
      // 独立复验双请求反例的固化：持有有效会话但没有当前密码时，响应不得暴露
      // 「猜中了部署默认值」——三次提交的大类码、细码、文案必须完全一致。
      const token = await expectLoginRestriction(
        testAccountsConfig.admin.loginName,
        testAccountsConfig.admin.loginPassword,
        SessionRestriction.NONE,
      );
      const hashBefore = (await readAccountRow(adminAccountId))?.loginPassword;
      const wrongCurrentPassword = 'Totally#Wrong2026';
      const candidates = [
        DEPLOY_DEFAULT_PASSWORD,
        FULL_WIDTH_DEPLOY_DEFAULT_PASSWORD,
        'I1Admin#Another2026',
      ];
      const bodies: Array<Awaited<ReturnType<typeof changePassword>>> = [];

      for (const candidate of candidates) {
        bodies.push(await changePassword(token, wrongCurrentPassword, candidate));
      }

      for (const body of bodies) {
        expect(body.data?.changeMyPassword).toBeUndefined();
        expect(body.errors).toHaveLength(1);
        expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
        expect(body.errors?.[0]?.extensions?.errorCode).toBe(
          'MY_ACCOUNT_CURRENT_PASSWORD_MISMATCH',
        );
        expect(body.errors?.[0]?.message).toBe('当前密码不正确');
        expect(JSON.stringify(body)).not.toContain(DEPLOY_DEFAULT_PASSWORD);
        expect(JSON.stringify(body)).not.toContain(FULL_WIDTH_DEPLOY_DEFAULT_PASSWORD);
      }

      const rowAfter = await readAccountRow(adminAccountId);
      expect(rowAfter?.loginPassword).toBe(hashBefore);
      expect(rowAfter?.mustChangePassword).toBe(false);
      expect(await readSessionRestriction(token)).toBe(SessionRestriction.NONE);
      await expectLoginRestriction(
        testAccountsConfig.admin.loginName,
        testAccountsConfig.admin.loginPassword,
        SessionRestriction.NONE,
      );
    });

    it('提交与当前密码相同的新密码同样被拒，哈希与标记不变且会话不退出', async () => {
      const token = await expectLoginRestriction(
        testAccountsConfig.admin.loginName,
        testAccountsConfig.admin.loginPassword,
        SessionRestriction.NONE,
      );
      const rowBefore = await readAccountRow(adminAccountId);
      const hashBefore = rowBefore?.loginPassword;
      expect(rowBefore?.mustChangePassword).toBe(false);

      const body = await changePassword(
        token,
        testAccountsConfig.admin.loginPassword,
        testAccountsConfig.admin.loginPassword,
      );

      expect(body.data?.changeMyPassword).toBeUndefined();
      expect(body.errors).toHaveLength(1);
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors?.[0]?.extensions?.errorCode).toBe('MY_ACCOUNT_NEW_PASSWORD_UNCHANGED');
      expect(body.errors?.[0]?.message).toBe('新密码需与当前密码不同');

      const rowAfter = await readAccountRow(adminAccountId);
      expect(rowAfter?.loginPassword).toBe(hashBefore);
      expect(rowAfter?.mustChangePassword).toBe(false);

      // 会话未退出：原 Token 仍有效，原密码仍可登录
      expect(await readSessionRestriction(token)).toBe(SessionRestriction.NONE);
      await expectLoginRestriction(
        testAccountsConfig.admin.loginName,
        testAccountsConfig.admin.loginPassword,
        SessionRestriction.NONE,
      );
    });
  });
});

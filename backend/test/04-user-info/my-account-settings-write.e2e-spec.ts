// test/04-user-info/my-account-settings-write.e2e-spec.ts
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
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * P2 / P3：`updateMyAccountSettings` 与 `changeMyPassword` 两个写 Mutation 的真实
 * MySQL + GraphQL E2E。
 *
 * 与定向单测（`update-my-account-settings.usecase.spec.ts` / `change-my-password.usecase.spec.ts`）
 * 的分工：单测断言协作契约（三态合并、事务边界、盐口径、日志脱敏）；本文件断言**跨进程
 * 可观察事实**：
 * 1. 写入确实落到真实数据库，且**改后的登录名 / 登录邮箱 / 新密码能通过公开登录入口验证**；
 * 2. 三个角色都只能改自己的设置，别人的资料不受影响；
 * 3. 唯一索引冲突、双空凭据、当前密码错误、弱密码都以契约大类出现在 `extensions.code`；
 * 4. 写 Input 在 Schema 层面**不存在**角色 / 状态 / identityHint / accessGroup / metaDigest /
 *    userState 字段，硬塞会被 GraphQL 校验拒绝且不产生任何写入；
 * 5. 失败的写入不留半成功数据（凭据被拒时资料字段不落库，改密被拒时哈希不变）；
 * 6. 已签发 Access Token 按现有契约自然过期：改密后旧 Token 仍可用，响应不声称服务端撤销。
 *
 * 造数纪律（同 `admin-user-management.e2e-spec.ts`）：
 * - 全部写入只走 GraphQL 业务入口，数据库只用于**只读核验**，不直接改库；
 * - 只 seed 三源可收敛、双状态一致的账号；`guestSecondary` 仅作为唯一性冲突的对照目标，
 *   全程只读；
 * - 「预检查通过但唯一索引最终裁决冲突」的并发竞争需要两个事务交错才能触发，E2E 无法在
 *   不改库的前提下稳定重现，故该分支由 `update-my-account-settings.usecase.spec.ts` 覆盖；
 * - 组内存在**刻意且已声明**的顺序依赖：`guestPrimary` 的登录名 / 登录邮箱在各用例中被
 *   逐步改写，后续用例以改写后的事实为前置（每步都用当次返回值或只读查库确认当前凭据）；
 *   跨 describe 可任意调序或单独 `.only`，因为每个 describe 自建前置。
 */

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string; details?: unknown };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type MyAccountSettingsPayload = {
  loginName: string | null;
  loginEmail: string | null;
  nickname: string;
  companyName: string | null;
  phone: string | null;
  contactEmail: string | null;
  role: IdentityTypeEnum;
  status: AccountStatus;
  updatedAt: string;
};

type UpdateSettingsPayload = { isUpdated: boolean; settings: MyAccountSettingsPayload };

type ChangePasswordPayload = { isUpdated: boolean; notice: string };

type IntrospectionPayload = {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __schema?: {
    mutationType?: { fields?: Array<{ name: string }> } | null;
  };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __type?: {
    name?: string;
    kind?: string;
    inputFields?: Array<{ name: string }> | null;
    fields?: Array<{ name: string }> | null;
  } | null;
};

/** DTO 字段清单：集中一处，避免各用例字段漂移；刻意不含 accountId */
const MY_ACCOUNT_SETTINGS_FIELDS =
  'loginName loginEmail nickname companyName phone contactEmail role status updatedAt';

const MY_ACCOUNT_SETTINGS_QUERY = `
  query MyAccountSettings {
    myAccountSettings { ${MY_ACCOUNT_SETTINGS_FIELDS} }
  }
`;

const UPDATE_MY_ACCOUNT_SETTINGS_MUTATION = `
  mutation UpdateMyAccountSettings($input: UpdateMyAccountSettingsInput!) {
    updateMyAccountSettings(input: $input) {
      isUpdated
      settings { ${MY_ACCOUNT_SETTINGS_FIELDS} }
    }
  }
`;

const CHANGE_MY_PASSWORD_MUTATION = `
  mutation ChangeMyPassword($input: ChangeMyPasswordInput!) {
    changeMyPassword(input: $input) { isUpdated notice }
  }
`;

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) { accessToken }
  }
`;

const SCHEMA_ROOT_QUERY = `
  query SchemaRoot {
    __schema { mutationType { fields { name } } }
  }
`;

const TYPE_FIELDS_QUERY = `
  query TypeFields($name: String!) {
    __type(name: $name) { name kind inputFields { name } fields { name } }
  }
`;

describe('当前用户账号设置写链路 updateMyAccountSettings / changeMyPassword (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let previousIntrospectionEnabled: string | undefined;

  let adminToken: string;
  let staffToken: string;
  let guestToken: string;
  const ownership = createOwnedResourceLedger();
  let guestAccountId: number;
  let staffAccountId: number;

  /** `guestPrimary` 的当前登录凭据事实：随各用例的写入逐步推进（组内顺序依赖已声明） */
  const guestCredentials = {
    loginName: testAccountsConfig.guestPrimary.loginName,
    loginEmail: testAccountsConfig.guestPrimary.loginEmail,
    password: testAccountsConfig.guestPrimary.loginPassword,
  };

  /** `staffPrimary` 的当前密码事实：改密用例推进它 */
  const staffPassword = { current: testAccountsConfig.staffPrimary.loginPassword };

  const NEW_STAFF_PASSWORD = 'Staff#New2026Pass';

  beforeAll(async () => {
    // E2E 基线默认关闭 introspection；本 spec 只在 API 初始化期间临时开启以核验契约面，
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

    // 预清理（窄范围）：只按本规格账号完整指纹回收已知残留，不整表清成员/账号
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        accounts: [
          testAccountsConfig.admin,
          testAccountsConfig.staffPrimary,
          testAccountsConfig.guestPrimary,
          testAccountsConfig.guestSecondary,
        ].map(toResidueAccountFingerprint),
      },
      helper: 'my-account-settings-write.e2e-spec beforeAll 预清理',
    });
    await seedTestAccounts({
      dataSource,
      includeKeys: ['admin', 'staffPrimary', 'guestPrimary', 'guestSecondary'],
      ownership,
    });

    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    staffToken = await login({
      app,
      loginName: testAccountsConfig.staffPrimary.loginName,
      loginPassword: testAccountsConfig.staffPrimary.loginPassword,
    });
    guestToken = await login({
      app,
      loginName: guestCredentials.loginName,
      loginPassword: guestCredentials.password,
    });

    guestAccountId = await getAccountIdByLoginName(dataSource, guestCredentials.loginName);
    staffAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staffPrimary.loginName,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        helper: 'my-account-settings-write.e2e-spec afterAll 收尾',
      });
    }
    if (app) await app.close();
    if (previousIntrospectionEnabled === undefined) {
      delete process.env.GRAPHQL_INTROSPECTION_ENABLED;
    } else {
      process.env.GRAPHQL_INTROSPECTION_ENABLED = previousIntrospectionEnabled;
    }
  });

  // ---------------------------------------------------------------------------
  // 请求 helper
  // ---------------------------------------------------------------------------

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

  const readMySettings = (
    token?: string,
  ): Promise<GqlBody<{ myAccountSettings?: MyAccountSettingsPayload }>> =>
    gql({ query: MY_ACCOUNT_SETTINGS_QUERY, token });

  const updateSettings = (
    token: string | undefined,
    input: Record<string, unknown>,
  ): Promise<GqlBody<{ updateMyAccountSettings?: UpdateSettingsPayload }>> =>
    gql({ query: UPDATE_MY_ACCOUNT_SETTINGS_MUTATION, variables: { input }, token });

  const changePassword = (
    token: string | undefined,
    input: Record<string, unknown>,
  ): Promise<GqlBody<{ changeMyPassword?: ChangePasswordPayload }>> =>
    gql({ query: CHANGE_MY_PASSWORD_MUTATION, variables: { input }, token });

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

  /** 断言登录成功并返回新 Token（证明凭据在真实登录链路可用） */
  const expectLoginSucceeds = async (loginName: string, loginPassword: string): Promise<string> => {
    const body = await attemptLogin(loginName, loginPassword);
    expect(body.errors).toBeUndefined();
    const token = body.data?.login?.accessToken;
    expect(typeof token).toBe('string');
    return token as string;
  };

  /** 断言登录失败为 UNAUTHENTICATED（凭据不存在或不匹配） */
  const expectLoginFails = async (loginName: string, loginPassword: string): Promise<void> => {
    const body = await attemptLogin(loginName, loginPassword);
    expect(body.data?.login?.accessToken).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  };

  const readAccountRow = (accountId: number): Promise<AccountEntity | null> =>
    dataSource.getRepository(AccountEntity).findOne({ where: { id: accountId } });

  const readUserInfoRow = (accountId: number): Promise<UserInfoEntity | null> =>
    dataSource.getRepository(UserInfoEntity).findOne({ where: { accountId } });

  /** 成功写入的公共断言：无错误、isUpdated、settings 回显 */
  const expectUpdated = (
    body: GqlBody<{ updateMyAccountSettings?: UpdateSettingsPayload }>,
    expected: Partial<MyAccountSettingsPayload>,
  ): MyAccountSettingsPayload => {
    expect(body.errors).toBeUndefined();
    expect(body.data?.updateMyAccountSettings?.isUpdated).toBe(true);
    const settings = body.data?.updateMyAccountSettings?.settings;
    expect(settings).toBeDefined();
    expect(settings).toMatchObject(expected);
    return settings as MyAccountSettingsPayload;
  };

  // ---------------------------------------------------------------------------
  // 1. 三个角色各自只能修改自己的设置
  // ---------------------------------------------------------------------------

  describe('三个角色修改自己的设置', () => {
    it.each([
      ['SUPER_ADMIN', (): string => adminToken, 'admin_renamed_by_self'],
      ['ENGINEER', (): string => staffToken, 'staff_renamed_by_self'],
      ['CUSTOMER', (): string => guestToken, 'guest_renamed_by_self'],
    ])('%s 可改自己的昵称，角色/状态保持只读且不变', async (_label, getToken, nickname) => {
      const body = await updateSettings(getToken(), { nickname });

      expect(body.errors).toBeUndefined();
      expect(body.data?.updateMyAccountSettings?.isUpdated).toBe(true);
      const settings = body.data?.updateMyAccountSettings?.settings;
      expect(settings?.nickname).toBe(nickname);
      // 角色与状态由响应回显但**不可写**：改昵称不得改写它们
      expect(settings?.role).toBe(
        _label === 'SUPER_ADMIN'
          ? IdentityTypeEnum.SUPER_ADMIN
          : _label === 'ENGINEER'
            ? IdentityTypeEnum.ENGINEER
            : IdentityTypeEnum.CUSTOMER,
      );
      expect(settings?.status).toBe(AccountStatus.ACTIVE);

      const row = await readUserInfoRow(
        _label === 'CUSTOMER'
          ? guestAccountId
          : _label === 'ENGINEER'
            ? staffAccountId
            : await getAccountIdByLoginName(dataSource, testAccountsConfig.admin.loginName),
      );
      expect(row?.nickname).toBe(nickname);
    });

    it('一个会话的写入不影响其他会话读到的自己的资料', async () => {
      const [adminBody, staffBody, guestBody] = await Promise.all([
        readMySettings(adminToken),
        readMySettings(staffToken),
        readMySettings(guestToken),
      ]);

      expect(adminBody.data?.myAccountSettings?.nickname).toBe('admin_renamed_by_self');
      expect(staffBody.data?.myAccountSettings?.nickname).toBe('staff_renamed_by_self');
      expect(guestBody.data?.myAccountSettings?.nickname).toBe('guest_renamed_by_self');
      expect(adminBody.data?.myAccountSettings?.loginName).toBe(testAccountsConfig.admin.loginName);
      expect(guestBody.data?.myAccountSettings?.loginName).toBe(
        testAccountsConfig.guestPrimary.loginName,
      );
    });

    it('同值提交不落库：isUpdated 为 false 且资料不变', async () => {
      const body = await updateSettings(guestToken, { nickname: 'guest_renamed_by_self' });

      expect(body.errors).toBeUndefined();
      expect(body.data?.updateMyAccountSettings?.isUpdated).toBe(false);
      expect(body.data?.updateMyAccountSettings?.settings?.nickname).toBe('guest_renamed_by_self');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. 契约面：写 Input / Result 的字段白名单
  // ---------------------------------------------------------------------------

  describe('契约面', () => {
    it('Mutation root 暴露两个写操作', async () => {
      const body = await gql<IntrospectionPayload>({ query: SCHEMA_ROOT_QUERY, token: adminToken });
      expect(body.errors).toBeUndefined();
      const names = (body.data?.__schema?.mutationType?.fields ?? []).map((f) => f.name);
      expect(names).toEqual(
        expect.arrayContaining(['updateMyAccountSettings', 'changeMyPassword']),
      );
    });

    it('UpdateMyAccountSettingsInput 只有六个白名单字段，不含角色/状态/敏感字段', async () => {
      const body = await gql<IntrospectionPayload>({
        query: TYPE_FIELDS_QUERY,
        variables: { name: 'UpdateMyAccountSettingsInput' },
        token: adminToken,
      });
      expect(body.errors).toBeUndefined();
      const fields = (body.data?.__type?.inputFields ?? []).map((f) => f.name).sort();
      expect(fields).toEqual([
        'companyName',
        'contactEmail',
        'loginEmail',
        'loginName',
        'nickname',
        'phone',
      ]);
      for (const forbidden of [
        'accountId',
        'role',
        'status',
        'identityHint',
        'accessGroup',
        'metaDigest',
        'userState',
        'password',
        'currentPassword',
        'newPassword',
      ]) {
        expect(fields).not.toContain(forbidden);
      }
    });

    it('ChangeMyPasswordInput 只有当前密码与新密码两个字段', async () => {
      const body = await gql<IntrospectionPayload>({
        query: TYPE_FIELDS_QUERY,
        variables: { name: 'ChangeMyPasswordInput' },
        token: adminToken,
      });
      const fields = (body.data?.__type?.inputFields ?? []).map((f) => f.name).sort();
      expect(fields).toEqual(['currentPassword', 'newPassword']);
    });

    it('两个写操作的 Result 是最小信息面（无 Token、无密码、无 accountId）', async () => {
      const updateResult = await gql<IntrospectionPayload>({
        query: TYPE_FIELDS_QUERY,
        variables: { name: 'UpdateMyAccountSettingsResultDTO' },
        token: adminToken,
      });
      expect((updateResult.data?.__type?.fields ?? []).map((f) => f.name).sort()).toEqual([
        'isUpdated',
        'settings',
      ]);

      const passwordResult = await gql<IntrospectionPayload>({
        query: TYPE_FIELDS_QUERY,
        variables: { name: 'ChangeMyPasswordResultDTO' },
        token: adminToken,
      });
      expect((passwordResult.data?.__type?.fields ?? []).map((f) => f.name).sort()).toEqual([
        'isUpdated',
        'notice',
      ]);
    });

    it('硬塞角色/状态/敏感字段被 GraphQL 校验拒绝，且不产生任何写入', async () => {
      const before = await readMySettings(guestToken);
      const body = await updateSettings(guestToken, {
        nickname: 'should_not_persist',
        role: 'SUPER_ADMIN',
        status: 'INACTIVE',
        accessGroup: ['SUPER_ADMIN'],
        metaDigest: ['SUPER_ADMIN'],
        identityHint: 'SUPER_ADMIN',
        userState: 'SUSPENDED',
      });

      expect(body.data?.updateMyAccountSettings).toBeUndefined();
      expect(body.errors?.length).toBeGreaterThan(0);
      // 这些字段在 GraphQL 输入类型中根本不存在，变量校验阶段即拒绝（早于装配层与业务层）
      body.errors?.forEach((error) => {
        expect(error.extensions?.code).toBe('BAD_USER_INPUT');
      });
      const messages = (body.errors ?? []).map((error) => error.message).join(' | ');
      for (const field of [
        'role',
        'status',
        'accessGroup',
        'metaDigest',
        'identityHint',
        'userState',
      ]) {
        expect(messages).toContain(
          `Field "${field}" is not defined by type "UpdateMyAccountSettingsInput"`,
        );
      }

      const after = await readMySettings(guestToken);
      expect(after.data?.myAccountSettings?.nickname).toBe(
        before.data?.myAccountSettings?.nickname,
      );
      expect(after.data?.myAccountSettings?.role).toBe(IdentityTypeEnum.CUSTOMER);
      expect(after.data?.myAccountSettings?.status).toBe(AccountStatus.ACTIVE);
      const accountRow = await readAccountRow(guestAccountId);
      const userInfoRow = await readUserInfoRow(guestAccountId);
      expect(accountRow?.status).toBe(AccountStatus.ACTIVE);
      expect(userInfoRow?.userState).toBe(UserState.ACTIVE);
      expect(userInfoRow?.accessGroup).toEqual([IdentityTypeEnum.CUSTOMER]);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. 登录名 / 登录邮箱：改后可用新凭据登录
  // ---------------------------------------------------------------------------

  describe('登录凭据修改并用于登录', () => {
    it('改登录名后可用新登录名登录，旧登录名立即失效', async () => {
      const renamed = 'guestrenamed';
      const body = await updateSettings(guestToken, { loginName: renamed });

      expectUpdated(body, { loginName: renamed, loginEmail: guestCredentials.loginEmail });

      await expectLoginSucceeds(renamed, guestCredentials.password);
      await expectLoginFails(guestCredentials.loginName, guestCredentials.password);

      const row = await readAccountRow(guestAccountId);
      expect(row?.loginName).toBe(renamed);
      // 联系邮箱是 base_user_info.email，不随登录名变化
      expect((await readUserInfoRow(guestAccountId))?.email).toBe(
        testAccountsConfig.guestPrimary.loginEmail,
      );

      guestCredentials.loginName = renamed;
    });

    it('改登录邮箱后可用新邮箱登录，旧邮箱立即失效', async () => {
      const renamedEmail = 'guest.renamed@example.com';
      const body = await updateSettings(guestToken, { loginEmail: renamedEmail });

      expectUpdated(body, { loginName: guestCredentials.loginName, loginEmail: renamedEmail });

      // 登录入口同时接受登录名与登录邮箱
      await expectLoginSucceeds(renamedEmail, guestCredentials.password);
      await expectLoginFails(guestCredentials.loginEmail, guestCredentials.password);

      const row = await readAccountRow(guestAccountId);
      expect(row?.loginEmail).toBe(renamedEmail);
      guestCredentials.loginEmail = renamedEmail;
    });

    it('联系邮箱永不成为登录凭据', async () => {
      const contactOnly = 'contact.only@example.com';
      const body = await updateSettings(guestToken, { contactEmail: contactOnly });

      expectUpdated(body, {
        contactEmail: contactOnly,
        loginEmail: guestCredentials.loginEmail,
      });

      await expectLoginFails(contactOnly, guestCredentials.password);
      await expectLoginSucceeds(guestCredentials.loginEmail, guestCredentials.password);

      const row = await readAccountRow(guestAccountId);
      expect(row?.loginEmail).toBe(guestCredentials.loginEmail);
      expect((await readUserInfoRow(guestAccountId))?.email).toBe(contactOnly);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. 凭据组合约束与唯一性冲突
  // ---------------------------------------------------------------------------

  describe('凭据组合约束', () => {
    it('同时清空登录名与登录邮箱被拒为 BAD_USER_INPUT，且不产生任何写入', async () => {
      const body = await updateSettings(guestToken, { loginName: null, loginEmail: null });

      expectSingleError(body, 'BAD_USER_INPUT', 'MY_ACCOUNT_LOGIN_CREDENTIAL_BOTH_EMPTY');

      const after = await readMySettings(guestToken);
      expect(after.data?.myAccountSettings?.loginName).toBe(guestCredentials.loginName);
      expect(after.data?.myAccountSettings?.loginEmail).toBe(guestCredentials.loginEmail);
      const row = await readAccountRow(guestAccountId);
      expect(row?.loginName).toBe(guestCredentials.loginName);
      expect(row?.loginEmail).toBe(guestCredentials.loginEmail);
    });

    it('清空登录名但保留登录邮箱时允许，之后仍可用邮箱登录', async () => {
      const body = await updateSettings(guestToken, { loginName: null });

      expectUpdated(body, { loginName: null, loginEmail: guestCredentials.loginEmail });

      const row = await readAccountRow(guestAccountId);
      expect(row?.loginName).toBeNull();
      expect(row?.loginEmail).toBe(guestCredentials.loginEmail);
      await expectLoginSucceeds(guestCredentials.loginEmail, guestCredentials.password);
      await expectLoginFails(guestCredentials.loginName, guestCredentials.password);
    });
  });

  describe('凭据唯一性冲突', () => {
    it('登录名与他人重复被拒为 CONFLICT，且原凭据不变', async () => {
      const body = await updateSettings(guestToken, {
        loginName: testAccountsConfig.guestSecondary.loginName,
      });

      expectSingleError(body, 'CONFLICT', 'MY_ACCOUNT_CREDENTIAL_CONFLICT');
      expect(body.errors?.[0]?.message).toContain('登录名已被占用');

      const after = await readMySettings(guestToken);
      expect(after.data?.myAccountSettings?.loginName).toBeNull();
      await expectLoginSucceeds(guestCredentials.loginEmail, guestCredentials.password);
    });

    it('登录邮箱与他人重复被拒为 CONFLICT，且原凭据不变', async () => {
      const body = await updateSettings(guestToken, {
        loginEmail: testAccountsConfig.guestSecondary.loginEmail,
      });

      expectSingleError(body, 'CONFLICT', 'MY_ACCOUNT_CREDENTIAL_CONFLICT');
      expect(body.errors?.[0]?.message).toContain('登录邮箱已被占用');

      const after = await readMySettings(guestToken);
      expect(after.data?.myAccountSettings?.loginEmail).toBe(guestCredentials.loginEmail);
    });

    it('恢复登录名后原登录名重新可用（证明前两次冲突未留下半成功数据）', async () => {
      const body = await updateSettings(guestToken, { loginName: guestCredentials.loginName });

      expectUpdated(body, { loginName: guestCredentials.loginName });
      await expectLoginSucceeds(guestCredentials.loginName, guestCredentials.password);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. 资料字段修改与清空
  // ---------------------------------------------------------------------------

  describe('资料字段三态', () => {
    it('设置公司/电话/联系邮箱后回显并落库', async () => {
      const body = await updateSettings(guestToken, {
        companyName: '示例科技有限公司',
        phone: '13900001111',
        contactEmail: 'contact.updated@example.com',
      });

      expectUpdated(body, {
        companyName: '示例科技有限公司',
        phone: '13900001111',
        contactEmail: 'contact.updated@example.com',
      });

      const row = await readUserInfoRow(guestAccountId);
      expect(row?.companyName).toBe('示例科技有限公司');
      expect(row?.phone).toBe('13900001111');
      expect(row?.email).toBe('contact.updated@example.com');
      // 资料更新不触碰状态与角色列
      expect(row?.userState).toBe(UserState.ACTIVE);
      expect(row?.accessGroup).toEqual([IdentityTypeEnum.CUSTOMER]);
    });

    it('未提供的字段不被改写（三态中的 undefined 语义）', async () => {
      const body = await updateSettings(guestToken, { nickname: 'guest_profile_round2' });

      expectUpdated(body, {
        nickname: 'guest_profile_round2',
        companyName: '示例科技有限公司',
        phone: '13900001111',
        contactEmail: 'contact.updated@example.com',
      });
    });

    it('显式 null 清空公司/电话/联系邮箱，且写后读为 null', async () => {
      const body = await updateSettings(guestToken, {
        companyName: null,
        phone: null,
        contactEmail: null,
      });

      const settings = body.data?.updateMyAccountSettings?.settings;
      expect(body.errors).toBeUndefined();
      expect(body.data?.updateMyAccountSettings?.isUpdated).toBe(true);
      expect(settings?.companyName).toBeNull();
      expect(settings?.phone).toBeNull();
      expect(settings?.contactEmail).toBeNull();

      const row = await readUserInfoRow(guestAccountId);
      expect(row?.companyName).toBeNull();
      expect(row?.phone).toBeNull();
      expect(row?.email).toBeNull();

      const after = await readMySettings(guestToken);
      expect(after.data?.myAccountSettings?.companyName).toBeNull();
      expect(after.data?.myAccountSettings?.nickname).toBe('guest_profile_round2');
    });

    it.each([
      ['昵称显式 null', { nickname: null }],
      ['昵称空字符串', { nickname: '' }],
      ['昵称纯空白', { nickname: '   ' }],
    ])('%s 被拒为 BAD_USER_INPUT 且原昵称不变', async (_label, input) => {
      const body = await updateSettings(guestToken, input);

      expect(body.data?.updateMyAccountSettings).toBeUndefined();
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

      const after = await readMySettings(guestToken);
      expect(after.data?.myAccountSettings?.nickname).toBe('guest_profile_round2');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. 自助改密
  // ---------------------------------------------------------------------------

  describe('自助修改密码', () => {
    it('当前密码错误被拒为 BAD_USER_INPUT，哈希不变且新密码不可登录', async () => {
      const hashBefore = (await readAccountRow(staffAccountId))?.loginPassword;

      const body = await changePassword(staffToken, {
        currentPassword: 'Totally#Wrong2026',
        newPassword: NEW_STAFF_PASSWORD,
      });

      expectSingleError(body, 'BAD_USER_INPUT', 'MY_ACCOUNT_CURRENT_PASSWORD_MISMATCH');

      expect((await readAccountRow(staffAccountId))?.loginPassword).toBe(hashBefore);
      await expectLoginFails(testAccountsConfig.staffPrimary.loginName, NEW_STAFF_PASSWORD);
      await expectLoginSucceeds(testAccountsConfig.staffPrimary.loginName, staffPassword.current);
    });

    it('弱新密码被拒为 BAD_USER_INPUT，原密码仍可登录', async () => {
      const body = await changePassword(staffToken, {
        currentPassword: staffPassword.current,
        newPassword: 'weak',
      });

      expect(body.data?.changeMyPassword).toBeUndefined();
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

      await expectLoginSucceeds(testAccountsConfig.staffPrimary.loginName, staffPassword.current);
    });

    it('改密成功后旧密码失效、新密码可登录，响应不含任何密码派生物', async () => {
      const hashBefore = (await readAccountRow(staffAccountId))?.loginPassword;
      const tokenBeforeChange = staffToken;

      const response = await postGql({
        app,
        query: CHANGE_MY_PASSWORD_MUTATION,
        variables: {
          input: { currentPassword: staffPassword.current, newPassword: NEW_STAFF_PASSWORD },
        },
        token: staffToken,
      }).expect(200);
      const body = response.body as GqlBody<{ changeMyPassword?: ChangePasswordPayload }>;

      expect(body.errors).toBeUndefined();
      expect(body.data?.changeMyPassword).toEqual({
        isUpdated: true,
        notice: '密码已更新，请使用新密码重新登录',
      });

      const raw = JSON.stringify(body);
      expect(raw).not.toContain(NEW_STAFF_PASSWORD);
      expect(raw).not.toContain(staffPassword.current);
      expect(raw).not.toContain('accessToken');
      expect(raw).not.toContain('loginPassword');

      const hashAfter = (await readAccountRow(staffAccountId))?.loginPassword;
      expect(hashAfter).not.toBe(hashBefore);
      expect(hashAfter).not.toContain(NEW_STAFF_PASSWORD);

      await expectLoginFails(testAccountsConfig.staffPrimary.loginName, staffPassword.current);
      const freshToken = await expectLoginSucceeds(
        testAccountsConfig.staffPrimary.loginName,
        NEW_STAFF_PASSWORD,
      );
      staffPassword.current = NEW_STAFF_PASSWORD;

      // 已签发 Access Token 按现有契约自然过期：本链路**不做**服务端撤销，
      // 故改密前签发的 Token 仍可读取自己的设置（这是刻意断言的现状契约）
      const withOldToken = await readMySettings(tokenBeforeChange);
      expect(withOldToken.errors).toBeUndefined();
      expect(withOldToken.data?.myAccountSettings?.nickname).toBe('staff_renamed_by_self');
      const withNewToken = await readMySettings(freshToken);
      expect(withNewToken.data?.myAccountSettings?.nickname).toBe('staff_renamed_by_self');
    });

    it('密码为空时在业务校验之前失败关闭', async () => {
      const body = await changePassword(staffToken, {
        currentPassword: '',
        newPassword: NEW_STAFF_PASSWORD,
      });

      expect(body.data?.changeMyPassword).toBeUndefined();
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. 未认证边界
  // ---------------------------------------------------------------------------

  describe('未认证边界', () => {
    it('三个账号设置入口未携带 Token 一律 UNAUTHENTICATED', async () => {
      const readBody = await readMySettings(undefined);
      expectSingleError(readBody, 'UNAUTHENTICATED');

      const updateBody = await updateSettings(undefined, { nickname: 'anonymous' });
      expectSingleError(updateBody, 'UNAUTHENTICATED');

      const passwordBody = await changePassword(undefined, {
        currentPassword: 'Whatever#2026',
        newPassword: NEW_STAFF_PASSWORD,
      });
      expectSingleError(passwordBody, 'UNAUTHENTICATED');

      // 未认证请求不得留下任何写入
      const after = await readMySettings(guestToken);
      expect(after.data?.myAccountSettings?.nickname).toBe('guest_profile_round2');
    });
  });
});

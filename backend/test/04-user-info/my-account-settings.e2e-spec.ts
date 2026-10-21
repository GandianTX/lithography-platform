// test/04-user-info/my-account-settings.e2e-spec.ts
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * P1：`myAccountSettings` 只读 Query 的真实 MySQL + GraphQL E2E。
 *
 * 与定向单测（`account.query.service.my-account-settings.spec.ts` / `get-my-account-settings.usecase.spec.ts`）
 * 的分工：单测断言映射与失败关闭的**协作契约**；本文件断言**跨进程可观察事实**：
 * 1. 契约面：Query root 暴露 `myAccountSettings`，且**无任何入参**（尤其无目标账号 ID）；
 * 2. 三个合法角色（SUPER_ADMIN / ENGINEER / CUSTOMER）都能读取**自己的**设置，角色/状态只读且正确；
 * 3. 响应**不含** accountId、密码、Token、identityHint、metaDigest、accessGroup、userState 等敏感字段；
 * 4. 未携带 Token 失败关闭为 `UNAUTHENTICATED`；
 * 5. 各角色只能读到自己的资料（登录名/邮箱随会话身份而变），不存在读取他人设置的入口。
 *
 * 造数纪律：全部走 seed + 公开登录入口，不直接改库；只 seed 三源可收敛、双状态一致的账号
 * （`admin` / `staffPrimary` / `guestPrimary`）。「资料缺失 / 三源不收敛 / 双状态不一致」需要脏行
 * 才能触发，而造脏行只能绕过业务入口直接改库，故这些失败关闭分支由 QueryService 定向单测覆盖，
 * 不在本文件重现（与 admin E2E 的同一取舍）。
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

type QueryFieldIntrospection = { name: string; args: Array<{ name: string }> };

type SchemaRootPayload = {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __schema?: {
    queryType?: { fields?: QueryFieldIntrospection[] } | null;
  };
};

/** DTO 字段清单：集中一处，避免各用例字段漂移；刻意不含 accountId */
const MY_ACCOUNT_SETTINGS_FIELDS =
  'loginName loginEmail nickname companyName phone contactEmail role status updatedAt';

const MY_ACCOUNT_SETTINGS_QUERY = `
  query MyAccountSettings {
    myAccountSettings { ${MY_ACCOUNT_SETTINGS_FIELDS} }
  }
`;

const SCHEMA_ROOT_QUERY = `
  query SchemaRoot {
    __schema {
      queryType { fields { name args { name } } }
    }
  }
`;

describe('当前用户账号设置 myAccountSettings (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let previousIntrospectionEnabled: string | undefined;

  let adminToken: string;
  let staffToken: string;
  let guestToken: string;
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

    // 预清理（窄范围）：只按本规格账号完整指纹回收已知残留，不整表清成员/账号
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        accounts: [
          testAccountsConfig.admin,
          testAccountsConfig.staffPrimary,
          testAccountsConfig.guestPrimary,
        ].map(toResidueAccountFingerprint),
      },
      helper: 'my-account-settings.e2e-spec beforeAll 预清理',
    });
    await seedTestAccounts({
      dataSource,
      includeKeys: ['admin', 'staffPrimary', 'guestPrimary'],
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
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // 正常回收：只删除本轮登记的真实 ID；失败向 jest 传播，不吞错
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        helper: 'my-account-settings.e2e-spec afterAll 收尾',
      });
    }
    if (app) await app.close();
    if (previousIntrospectionEnabled === undefined) {
      delete process.env.GRAPHQL_INTROSPECTION_ENABLED;
    } else {
      process.env.GRAPHQL_INTROSPECTION_ENABLED = previousIntrospectionEnabled;
    }
  });

  const gql = async <T>(params: { query: string; token?: string }): Promise<GqlBody<T>> => {
    const response = await postGql({ app, query: params.query, token: params.token }).expect(
      (res) => {
        expect([200, 400]).toContain(res.status);
      },
    );
    return response.body as GqlBody<T>;
  };

  const readMySettings = (
    token?: string,
  ): Promise<GqlBody<{ myAccountSettings?: MyAccountSettingsPayload }>> =>
    gql({ query: MY_ACCOUNT_SETTINGS_QUERY, token });

  describe('契约面', () => {
    it('Query root 暴露 myAccountSettings 且无任何入参（无目标账号 ID）', async () => {
      const body = await gql<SchemaRootPayload>({ query: SCHEMA_ROOT_QUERY, token: adminToken });
      expect(body.errors).toBeUndefined();

      const fields = body.data?.__schema?.queryType?.fields ?? [];
      const field = fields.find((item) => item.name === 'myAccountSettings');
      expect(field).toBeDefined();
      expect(field?.args).toEqual([]);
    });
  });

  describe('三个角色读取自己的设置', () => {
    it.each([
      [
        'SUPER_ADMIN',
        (): string => adminToken,
        testAccountsConfig.admin,
        IdentityTypeEnum.SUPER_ADMIN,
      ],
      [
        'ENGINEER',
        (): string => staffToken,
        testAccountsConfig.staffPrimary,
        IdentityTypeEnum.ENGINEER,
      ],
      [
        'CUSTOMER',
        (): string => guestToken,
        testAccountsConfig.guestPrimary,
        IdentityTypeEnum.CUSTOMER,
      ],
    ])('%s 可读自己的设置，角色/状态只读且正确', async (_label, getToken, cfg, expectedRole) => {
      const body = await readMySettings(getToken());
      expect(body.errors).toBeUndefined();

      const settings = body.data?.myAccountSettings;
      expect(settings).toBeDefined();
      expect(settings?.loginName).toBe(cfg.loginName);
      expect(settings?.loginEmail).toBe(cfg.loginEmail);
      expect(settings?.nickname).toBe(`${cfg.loginName}_nickname`);
      // seed 把联系邮箱写为 cfg.loginEmail；公司名称/电话未写入故为 null
      expect(settings?.contactEmail).toBe(cfg.loginEmail);
      expect(settings?.companyName).toBeNull();
      expect(settings?.phone).toBeNull();
      expect(settings?.role).toBe(expectedRole);
      expect(settings?.status).toBe(AccountStatus.ACTIVE);
      expect(typeof settings?.updatedAt).toBe('string');
    });

    it('不同会话读到各自的资料，不存在读取他人设置的入口', async () => {
      const [adminBody, guestBody] = await Promise.all([
        readMySettings(adminToken),
        readMySettings(guestToken),
      ]);
      expect(adminBody.data?.myAccountSettings?.loginName).toBe(testAccountsConfig.admin.loginName);
      expect(guestBody.data?.myAccountSettings?.loginName).toBe(
        testAccountsConfig.guestPrimary.loginName,
      );
      expect(adminBody.data?.myAccountSettings?.loginName).not.toBe(
        guestBody.data?.myAccountSettings?.loginName,
      );
    });
  });

  describe('敏感字段边界', () => {
    it('响应不含 accountId、密码、Token、identityHint、metaDigest、accessGroup、userState', async () => {
      const token = guestToken;

      const response = await postGql({ app, query: MY_ACCOUNT_SETTINGS_QUERY, token }).expect(200);
      const raw = JSON.stringify(response.body);
      const settings = (response.body as GqlBody<{ myAccountSettings?: MyAccountSettingsPayload }>)
        .data?.myAccountSettings;

      // 显式字段清单只含公开只读字段（accountId 不在其中，故结构上不可能被暴露）
      expect(Object.keys(settings as object).sort()).toEqual([
        'companyName',
        'contactEmail',
        'loginEmail',
        'loginName',
        'nickname',
        'phone',
        'role',
        'status',
        'updatedAt',
      ]);
      // 字段名层面的敏感键一律不得出现（不做数值子串比对：个位数 accountId 会偶然命中时间戳）
      expect(raw).not.toContain('accountId');
      expect(raw).not.toContain('identityHint');
      expect(raw).not.toContain('metaDigest');
      expect(raw).not.toContain('accessGroup');
      expect(raw).not.toContain('userState');
      expect(raw).not.toContain('accessToken');
      expect(raw).not.toContain('loginPassword');
    });
  });

  describe('认证边界', () => {
    it('未携带 Token 失败关闭为 UNAUTHENTICATED', async () => {
      const body = await readMySettings(undefined);
      expect(body.data?.myAccountSettings).toBeUndefined();
      expect(body.errors).toBeDefined();
      expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    });
  });
});

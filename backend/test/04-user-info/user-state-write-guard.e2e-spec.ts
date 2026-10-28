// 文件位置：test/04-user-info/user-state-write-guard.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { login } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * P1 回归：`userState` 写入口收口——**只负责协议层契约面**。
 *
 * 收口后置条件：
 * - 点 1：`UpdateUserInfoInput` 的 introspection inputFields 不再包含 `userState`；
 * - 点 7：全 schema 任何 INPUT_OBJECT 与 Mutation 顶层参数都不再暴露 `userState`（无其他公开写入口）；
 * - 点 2：构造带 `userState` 的 `updateUserInfo` 请求在 GraphQL 协议层被拒，不落任何写入。
 *
 * 点 3/5/6（`adminSetUserStatus` 的 `account.status` 与 `userInfo.userState` 同事务同步、
 * 停用后旧 Token 即时失效返回 `UNAUTHENTICATED`、重新启用后新登录可访问）属于管理员写
 * 操作的**运行时行为**，已统一由 `test/04-user-info/admin-user-management.e2e-spec.ts` 的
 * 「状态切换」分组覆盖；本文件不再重复，以免 core 分组为同一断言多启动一个 Nest 应用。
 *
 * 三条用例都是纯 introspection / 协议层校验，不读取也不变更任何账号事实，因此无顺序耦合。
 *
 * 仅在 API 初始化期间临时开启 introspection，不修改任何 .env / Entity / Migration / schema 产物。
 */

type GqlError = { message: string; extensions?: { code?: string; errorCode?: string } };

type NamedTypeIntrospection = {
  data?: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __type?: { name?: string; kind?: string; inputFields?: Array<{ name: string }> | null } | null;
  };
  errors?: GqlError[];
};

type SchemaTypesIntrospection = {
  data?: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __schema?: {
      types?: Array<{
        kind?: string;
        name?: string;
        inputFields?: Array<{ name: string }> | null;
      }>;
    };
  };
  errors?: GqlError[];
};

type SchemaMutationArgsIntrospection = {
  data?: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __schema?: {
      mutationType?: {
        fields?: Array<{ name?: string; args?: Array<{ name: string }> | null }>;
      } | null;
    };
  };
  errors?: GqlError[];
};

describe('userState 写入口收口 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let previousIntrospectionEnabled: string | undefined;

  /** 点 2 需要一个能通过 JwtAuthGuard 的合法会话，因此只需 admin 一个账号 */
  let adminToken: string;
  const ownership = createOwnedResourceLedger();

  beforeAll(async () => {
    // E2E 基线默认关闭 introspection；本 spec 只在 API 初始化期间临时开启，用于核验公开契约，
    // 不修改任何 .env 或运行时生产配置。
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
      residue: { accounts: [toResidueAccountFingerprint(testAccountsConfig.admin)] },
      helper: 'user-state-write-guard.e2e-spec beforeAll 预清理',
    });
    // 协议层校验发生在 Usecase 之前，不需要任何被管理目标账号
    await seedTestAccounts({ dataSource, includeKeys: ['admin'], ownership });

    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        helper: 'user-state-write-guard.e2e-spec afterAll 收尾',
      });
    }
    if (app) await app.close();
    if (previousIntrospectionEnabled === undefined) {
      delete process.env.GRAPHQL_INTROSPECTION_ENABLED;
    } else {
      process.env.GRAPHQL_INTROSPECTION_ENABLED = previousIntrospectionEnabled;
    }
  });

  describe('协议层收口（点 1/2/7）', () => {
    it('点 1：UpdateUserInfoInput introspection 不含 userState（普通资料字段保留）', async () => {
      const response = await request(app.getHttpServer())
        .post('/graphql')
        .send({
          query: `
            query UpdateUserInfoInputShape {
              __type(name: "UpdateUserInfoInput") {
                name
                kind
                inputFields { name }
              }
            }
          `,
        })
        .expect(200);
      const body = response.body as NamedTypeIntrospection;

      expect(body.errors).toBeUndefined();
      expect(body.data?.__type?.kind).toBe('INPUT_OBJECT');
      const fieldNames = body.data?.__type?.inputFields?.map((field) => field.name) ?? [];
      expect(fieldNames).not.toContain('userState');
      // 非回归：普通资料编辑字段不被误删（点 7 的边界）
      expect(fieldNames).toEqual(
        expect.arrayContaining(['nickname', 'gender', 'phone', 'signature', 'avatarUrl']),
      );
    });

    it('点 7：全 schema 任何 INPUT_OBJECT 与 Mutation 顶层参数都不暴露 userState', async () => {
      const response = await request(app.getHttpServer())
        .post('/graphql')
        .send({
          query: `
            query AllInputObjects {
              __schema {
                types { kind name inputFields { name } }
              }
            }
          `,
        })
        .expect(200);
      const body = response.body as SchemaTypesIntrospection;

      expect(body.errors).toBeUndefined();
      const inputObjects = (body.data?.__schema?.types ?? []).filter(
        (type) => type.kind === 'INPUT_OBJECT',
      );
      expect(inputObjects.length).toBeGreaterThan(0);
      const offenders = inputObjects
        .map((type) => ({ name: type.name, fields: (type.inputFields ?? []).map((f) => f.name) }))
        .filter((type) => type.fields.includes('userState'));
      // 无任何输入类型再暴露 userState ⇒ 无其他绕过 AdminSetUserStatusUsecase 的公开写入口
      expect(offenders).toEqual([]);

      // 协议面盲区闭环：顶层独立参数形态（如 mutation x(userState: UserState)）
      // 不出现在 INPUT_OBJECT.inputFields 中，需单独扫描 Mutation 根字段 args
      const argsResponse = await request(app.getHttpServer())
        .post('/graphql')
        .send({
          query: `
            query MutationRootArgs {
              __schema {
                mutationType { fields { name args { name } } }
              }
            }
          `,
        })
        .expect(200);
      const argsBody = argsResponse.body as SchemaMutationArgsIntrospection;

      expect(argsBody.errors).toBeUndefined();
      const mutationFields = argsBody.data?.__schema?.mutationType?.fields ?? [];
      expect(mutationFields.length).toBeGreaterThan(0);
      const argOffenders = mutationFields
        .map((field) => ({ name: field.name, args: (field.args ?? []).map((arg) => arg.name) }))
        .filter((field) => field.args.includes('userState'));
      expect(argOffenders).toEqual([]);
    });

    it('点 2：带 userState 的 updateUserInfo 请求在协议层被拒（不落写入）', async () => {
      const response = await request(app.getHttpServer())
        .post('/graphql')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          query: `
            mutation UpdateUserInfoWithUserState {
              updateUserInfo(input: { userState: INACTIVE }) { isUpdated }
            }
          `,
        })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });
      const body = response.body as { data?: { updateUserInfo?: unknown }; errors?: GqlError[] };

      expect(body.errors).toBeDefined();
      expect(body.errors?.length ?? 0).toBeGreaterThan(0);
      expect(body.data?.updateUserInfo).toBeFalsy();
      const joined = (body.errors ?? []).map((error) => error.message).join(' | ');
      expect(joined).toContain('userState');
    });
  });
});

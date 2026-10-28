// test/04-user-info/my-account-settings-write-production.e2e-spec.ts
import { AudienceTypeEnum, LoginTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import { decode, sign, type JwtPayload } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { GqlAllExceptionsFilter } from '../../src/infrastructure/graphql/filters/graphql-exception.filter';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';

/**
 * P3 自助改密在**临时 production 配置**下的真实 GraphQL 错误分类 E2E。
 *
 * 与 `my-account-settings-write.e2e-spec.ts`（e2e 配置）的分工：那里断言功能行为，
 * 本文件断言**生产环境下的错误分类不丢失**——完整链路
 * DTO/ValidateInput → Resolver → Usecase → `PasswordPolicyService` → `GqlAllExceptionsFilter`
 * 全部真实执行，生产过滤器对 DomainError 路径保留分类（对 HttpException 路径会塌缩为
 * `INTERNAL_SERVER_ERROR`，这正是 DTO 层不设 `@IsValidPassword` 的原因）。
 *
 * R3 修正：应用以 E2E 日志配置初始化，不依赖 /var/log/backend 或 sudo。仅实际
 * `GqlAllExceptionsFilter` 注入 production 判定；DTO、Resolver、Usecase 与密码策略服务
 * 均保持真实链路，生产日志默认目录不受测试修改。
 *
 * R4 修正：ApiModule 已把全局过滤器收口为 `GqlAllExceptionsFilter` 具名 provider +
 * `APP_FILTER useExisting` 别名，本文件 override 的正是**实际生效的过滤器 token**；
 * 并以两个等价哨兵证明链路真实生效——
 * 1. `filterFactoryCalls`：override 工厂被调用（单例装配，非默认 useClass 路径）；
 * 2. `filterNodeEnvReads`：每个拒绝请求恰好触发一次过滤器的 `NODE_ENV` production
 *    判定读取（过滤器 catch() 首行每次异常读取一次），证明请求确实走进了被
 *    override 的过滤器实例而非其他装配。
 */

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string };
};

type GqlBody<T> = { data?: T; errors?: GqlError[] };

type ChangePasswordPayload = { isUpdated: boolean; notice: string };

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

/** E2E 日志配置：stdout 直写（无 pino/file transport），不触碰生产日志目录 */
const E2E_LOGGER_PARAMS = {
  pinoHttp: {
    level: 'info',
  },
} as unknown as Params;

/** 哨兵 1：override 工厂被调用的次数（期望恰 1：单例装配） */
let filterFactoryCalls = 0;
/** 哨兵 2：被 override 的过滤器实例读取 NODE_ENV production 判定的次数 */
let filterNodeEnvReads = 0;

/**
 * production 判定包装：NODE_ENV 恒读作 'production'（每次读取计数），
 * 其余配置键透传真实 ConfigService——保证除 production 判定外链路全部真实。
 */
function wrapConfigForProduction(configService: ConfigService): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => {
      if (key === 'NODE_ENV') {
        filterNodeEnvReads += 1;

        return 'production';
      }

      return configService.get(key, defaultValue);
    },
  } as unknown as ConfigService;
}

/** 造数纪律同源：只 seed staffPrimary，数据库仅用于只读核验 */
const STAFF = testAccountsConfig.staffPrimary;
const CORRECT_CURRENT_PASSWORD = STAFF.loginPassword;
/** 满足全部策略的有效新密码：用于「错误当前密码」与「过期 Token」路径的对照 */
const VALID_NEW_PASSWORD = 'Prod#Valid2026Pass';

const INVALID_NEW_PASSWORDS: ReadonlyArray<{
  readonly label: string;
  readonly newPassword: string;
}> = [
  { label: '弱密码（长度不足）', newPassword: 'Ab1!' },
  { label: '超长密码（超过 128 位）', newPassword: `a1!${'x'.repeat(130)}` },
  { label: '缺少小写字母', newPassword: 'ABCD1234!#' },
  { label: '缺少数字', newPassword: 'Abcdefgh!#' },
  { label: '缺少特殊字符', newPassword: 'Abcdefg1' },
];

describe('changeMyPassword 生产环境错误分类 (e2e, NODE_ENV=production)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let staffToken: string;
  let staffAccountId: number;
  const ownership = createOwnedResourceLedger();

  beforeAll(async () => {
    // 应用保持 E2E 配置初始化；仅真实 GqlAllExceptionsFilter 接收 production 判定，
    // 因而不会走 production logger 的 /var/log/backend 默认目录。
    // 动态 import 保持 schema 初始化顺序
    const [{ initGraphQLSchema }, { ApiModule: apiModule }] = await Promise.all([
      import('../../src/adapters/api/graphql/schema/schema.init'),
      import('../../src/bootstraps/api/api.module'),
    ]);

    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [apiModule],
    })
      // E2E 日志配置仅走 stdout；不修改生产默认日志目录。
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useValue(E2E_LOGGER_PARAMS)
      // R4：override 实际生效的过滤器 token（ApiModule 已收口为具名 provider +
      // APP_FILTER useExisting 别名）；工厂调用与 NODE_ENV 读取均以计数哨兵记录。
      .overrideProvider(GqlAllExceptionsFilter)
      .useFactory({
        inject: [ConfigService],
        factory: (configService: ConfigService) => {
          filterFactoryCalls += 1;

          return new GqlAllExceptionsFilter(wrapConfigForProduction(configService));
        },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);

    // 预清理（窄范围）：只按本规格账号完整指纹回收已知残留，不整表清成员/账号
    await runGuardedSpecCleanup({
      dataSource,
      residue: { accounts: [toResidueAccountFingerprint(STAFF)] },
      helper: 'my-account-settings-write-production.e2e-spec beforeAll 预清理',
    });
    await seedTestAccounts({ dataSource, includeKeys: ['staffPrimary'], ownership });

    staffToken = await login({
      app,
      loginName: STAFF.loginName,
      loginPassword: CORRECT_CURRENT_PASSWORD,
    });
    staffAccountId = await getAccountIdByLoginName(dataSource, STAFF.loginName);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await runGuardedSpecCleanup({
        dataSource,
        owned: ownership,
        helper: 'my-account-settings-write-production.e2e-spec afterAll 收尾',
      });
    }
    if (app) await app.close();
  });

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

  const changePassword = (
    token: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<GqlBody<{ changeMyPassword?: ChangePasswordPayload }>> =>
    gql({ query: CHANGE_MY_PASSWORD_MUTATION, variables: { input }, token });

  const readAccountRow = (): Promise<AccountEntity | null> =>
    dataSource.getRepository(AccountEntity).findOne({ where: { id: staffAccountId } });

  const expectSingleError = (body: GqlBody<unknown>, code: string, errorCode: string): void => {
    expect(body.errors).toBeDefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.extensions?.code).toBe(code);
    expect(body.errors?.[0]?.extensions?.errorCode).toBe(errorCode);
  };

  /**
   * 断言被 override 的过滤器真实处理了本次请求：catch() 首行每异常恰好读取一次
   * NODE_ENV，故拒绝请求后读取计数必须精确 +1（缺失即证明 override 未生效）。
   */
  const expectRejectionViaOverriddenFilter = async (run: () => Promise<unknown>): Promise<void> => {
    const readsBefore = filterNodeEnvReads;

    await run();

    expect(filterNodeEnvReads).toBe(readsBefore + 1);
  };

  it('生产分类链路有效性：全局过滤器来自 override 工厂（单例装配）而非默认 useClass 路径', () => {
    expect(filterFactoryCalls).toBe(1);
    expect(app.get(GqlAllExceptionsFilter)).toBeDefined();
  });

  it.each(INVALID_NEW_PASSWORDS)(
    '生产分类：$label 的新密码被拒为 BAD_USER_INPUT 且哈希不变',
    async ({ newPassword }) => {
      const hashBefore = (await readAccountRow())?.loginPassword;
      expect(hashBefore).toBeDefined();

      await expectRejectionViaOverriddenFilter(async () => {
        const body = await changePassword(staffToken, {
          currentPassword: CORRECT_CURRENT_PASSWORD,
          newPassword,
        });

        expectSingleError(body, 'BAD_USER_INPUT', 'INPUT_NORMALIZE_INVALID_TEXT');
        expect(body.data?.changeMyPassword).toBeUndefined();
      });
      expect((await readAccountRow())?.loginPassword).toBe(hashBefore);
    },
  );

  it('生产分类：当前密码错误为 BAD_USER_INPUT（非 UNAUTHENTICATED），哈希不变且原密码仍可登录', async () => {
    const hashBefore = (await readAccountRow())?.loginPassword;
    expect(hashBefore).toBeDefined();

    await expectRejectionViaOverriddenFilter(async () => {
      const body = await changePassword(staffToken, {
        currentPassword: 'Totally#Wrong2026',
        newPassword: VALID_NEW_PASSWORD,
      });

      expectSingleError(body, 'BAD_USER_INPUT', 'MY_ACCOUNT_CURRENT_PASSWORD_MISMATCH');
    });
    expect((await readAccountRow())?.loginPassword).toBe(hashBefore);

    const attemptLogin = (
      loginPassword: string,
    ): Promise<GqlBody<{ login?: { accessToken?: string } }>> =>
      gql({
        query: LOGIN_MUTATION,
        variables: {
          input: {
            loginName: STAFF.loginName,
            loginPassword,
            type: LoginTypeEnum.PASSWORD,
            audience: AudienceTypeEnum.DESKTOP,
          },
        },
      });

    // 原密码仍可登录、被拒的新密码未生效：证明拒绝路径没有半成功写入
    const relogin = await attemptLogin(CORRECT_CURRENT_PASSWORD);
    expect(relogin.data?.login?.accessToken).toBeDefined();

    const newPasswordLogin = await attemptLogin(VALID_NEW_PASSWORD);
    expect(newPasswordLogin.data?.login?.accessToken).toBeUndefined();
  });

  it('生产分类：过期 Token 为 UNAUTHENTICATED（JWT_AUTHENTICATION_FAILED），哈希不变', async () => {
    const payload = decode(staffToken);
    expect(payload).toBeTruthy();
    const claims = payload as JwtPayload;

    // 以真实 Token 同形载荷重签一个已过期 Token（同密钥同 aud，仅 exp 指向过去）：
    // 只让「过期」成为唯一失败原因，确保断言的是过期分类而非签名/受众分类
    const expiredToken = sign(
      { ...claims, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET as string,
      // aud 已在载荷内，不能再传 audience 选项（jsonwebtoken 禁止二者同时出现）
      { algorithm: 'HS256' },
    );

    const hashBefore = (await readAccountRow())?.loginPassword;
    expect(hashBefore).toBeDefined();

    await expectRejectionViaOverriddenFilter(async () => {
      const body = await changePassword(expiredToken, {
        currentPassword: CORRECT_CURRENT_PASSWORD,
        newPassword: VALID_NEW_PASSWORD,
      });

      // 过期 Token 的真实生产链路：passport-jwt 在 Strategy.validate 之前即以
      // ignoreExpiration=false 拒绝过期 Token，guard 收到的是原始 TokenExpiredError
      //（非 DomainError），按统一口径包装为 JWT_ERROR.AUTHENTICATION_FAILED，
      // 再由过滤器稳定映射为 UNAUTHENTICATED（生产与开发一致）。
      // token.helper 的 JWT_TOKEN_EXPIRED 只出现在手动验签路径（如 refresh），不在本链路。
      expectSingleError(body, 'UNAUTHENTICATED', 'JWT_AUTHENTICATION_FAILED');
      expect(body.data?.changeMyPassword).toBeUndefined();
    });
    expect((await readAccountRow())?.loginPassword).toBe(hashBefore);
  });
});

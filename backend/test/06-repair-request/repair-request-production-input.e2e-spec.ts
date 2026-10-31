// test/06-repair-request/repair-request-production-input.e2e-spec.ts
//
// PR4 回归：工程师列表 Query（engineerRepairRequests）在**临时 production 配置**下的
// 真实 GraphQL 输入错误分类 E2E。
//
// 背景：engineerRepairRequests 原有 @ValidateInput() 抛 BadRequestException；生产环境的
// GqlAllExceptionsFilter 会把所有 HttpException 一律降级为 INTERNAL_SERVER_ERROR 并隐藏
// message / errorCode，导致 DTO 校验失败被误分类为系统故障。PR4 起该入口改用模块局部
// ValidateRepairRequestInput（DomainError → REPAIR_REQUEST_INVALID_PARAMS → BAD_USER_INPUT）。
//
// 本文件断言（完整链路 DTO pipe → Resolver → Usecase → 实际 GqlAllExceptionsFilter
// 全部真实执行，仅过滤器拿到的 ConfigService 把 NODE_ENV 恒读为 production）：
// - 长度上限合法值在上限端点不误伤、全链路成功；
// - equipmentModelId=0、customerNickname 上限 +1、非法 page/pageSize、非法 scope、
//   filter 携带未知字段 在 production 均为 BAD_USER_INPUT + REPAIR_REQUEST_INVALID_PARAMS + 可读文案；
// - 被拒请求不进入查询逻辑（ListEngineerRepairRequestsUsecase.execute 未被调用）；
// - 未登录 / CUSTOMER 仍为 UNAUTHENTICATED / FORBIDDEN；
// - 注入的真实内部异常仍为 INTERNAL_SERVER_ERROR（不伪装为 BAD_USER_INPUT，不泄漏细节）。
//
// 数据安全：本 spec 只创建/清理**专属夹具**（专属账号 + 专属型号），主键由数据库生成并
// 在运行期记录；不依赖 global-setup 的全表 TRUNCATE，也不做任何整表删除。

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import { DataSource } from 'typeorm';

import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { ListEngineerRepairRequestsUsecase } from '@src/usecases/repair-request/list-engineer-repair-requests.usecase';
import { GqlAllExceptionsFilter } from '../../src/infrastructure/graphql/filters/graphql-exception.filter';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import { login, postGql } from '../utils/e2e-graphql-utils';
import {
  REPAIR_REQUEST_FIXTURE_ACCOUNTS,
  cleanupRepairRequestFixtureByIds,
  cleanupRepairRequestFixtureResidue,
  createRepairRequestFixtureModel,
  createRepairRequestFixtureOwnership,
  runRepairRequestFixtureTeardown,
  seedRepairRequestFixtureAccounts,
  seedRepairRequestFixtureOrganizationScope,
  type RepairRequestFixtureOwnership,
} from './repair-request-fixture';

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string; errorMessage?: string };
};

type GqlBody<T> = { data?: T | null; errors?: GqlError[] };

type EngineerRepairRequestsData = {
  engineerRepairRequests: {
    items: Array<{ id: number; isAccepted: boolean }>;
    total: number;
  };
};

const ENGINEER_LIST_QUERY = `
  query EngineerRepairRequests($scope: String, $pagination: PaginationArgs!, $filter: EngineerRepairRequestFilterInput) {
    engineerRepairRequests(scope: $scope, pagination: $pagination, filter: $filter) {
      items { id isAccepted }
      total
    }
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

const VALID_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true };

/** 与 DTO / usecase 校验断言的期望文案一一对应（生产环境必须保留可读文案） */
const INVALID_INPUT_CASES: ReadonlyArray<{
  readonly label: string;
  readonly variables: Record<string, unknown>;
  readonly messagePart: string;
}> = [
  {
    label: 'equipmentModelId=0（低于下限）',
    variables: {
      scope: 'ALL',
      pagination: VALID_PAGINATION,
      filter: { equipmentModelId: 0 },
    },
    messagePart: '设备型号 ID 必须大于 0',
  },
  {
    label: 'customerNickname 上限 +1（101 字符）',
    variables: {
      scope: 'ALL',
      pagination: VALID_PAGINATION,
      filter: { customerNickname: '客'.repeat(101) },
    },
    messagePart: '客户昵称关键词不能超过 100 个字符',
  },
  {
    label: 'pageSize=101（超过上限）',
    variables: { scope: 'ALL', pagination: { ...VALID_PAGINATION, pageSize: 101 } },
    messagePart: '每页数量不能超过 100',
  },
  {
    label: 'pageSize=0（低于下限）',
    variables: { scope: 'ALL', pagination: { ...VALID_PAGINATION, pageSize: 0 } },
    messagePart: '每页数量必须大于等于 1',
  },
  {
    label: 'page=0（低于下限）',
    variables: { scope: 'ALL', pagination: { ...VALID_PAGINATION, page: 0 } },
    messagePart: '页码必须大于等于 1',
  },
  {
    label: '非法 scope（usecase 层校验）',
    variables: { scope: 'BOGUS', pagination: VALID_PAGINATION },
    messagePart: '工程师列表范围无效',
  },
];

describe('engineerRepairRequests 生产环境输入错误分类 (e2e, NODE_ENV=production)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let engineerToken: string;
  let customerToken: string;
  let readModelId: number;
  /** 本轮实际创建并记录的所有权上下文（ID 只在运行期存在，收尾只按这里的 ID 回收） */
  const ownership: RepairRequestFixtureOwnership = createRepairRequestFixtureOwnership();
  /** 仅当 beforeAll 在「写夹具之前」完成白名单验证才置位，afterAll 据此决定能否清理 */
  let fixtureTargetValidated = false;

  beforeAll(async () => {
    // 应用保持 E2E 配置初始化；仅真实 GqlAllExceptionsFilter 接收 production 判定，
    // 因而不会走 production logger 的默认日志目录。动态 import 保持 schema 初始化顺序。
    const [{ initGraphQLSchema }, { ApiModule: apiModule }] = await Promise.all([
      import('../../src/adapters/api/graphql/schema/schema.init'),
      import('../../src/bootstraps/api/api.module'),
    ]);

    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [apiModule],
    })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useValue(E2E_LOGGER_PARAMS)
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

    // 🔒 第一条写/删除之前复用不可跳过的目标库白名单守卫
    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    fixtureTargetValidated = true;
    // 先按专属标记 + 完整归属校验回收上一次运行的崩溃残留；无残留时 no-op（连跑两遍幂等）
    await cleanupRepairRequestFixtureResidue(dataSource);

    const accounts = await seedRepairRequestFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
      includeKeys: ['engineerA', 'customerA'],
    });
    // 本轮专属组织与唯一 ACTIVE 成员关系：保证工程师查询走真实组织过滤分支，
    // 本 spec 不创建任何工单，故合法边界查询仍返回空页（不放宽生产权限）
    await seedRepairRequestFixtureOrganizationScope({
      dataSource,
      ownership,
      accountIds: accounts,
    });
    readModelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });

    engineerToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerA.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.engineerA.loginPassword,
    });
    customerToken = await login({
      app,
      loginName: REPAIR_REQUEST_FIXTURE_ACCOUNTS.customerA.loginName,
      loginPassword: REPAIR_REQUEST_FIXTURE_ACCOUNTS.customerA.loginPassword,
    });
    // 断言账号已就绪（避免未使用导入告警同时保证造数成功）
    expect(accounts.engineerA).toBeGreaterThan(0);
    expect(accounts.customerA).toBeGreaterThan(0);
  });

  afterAll(async () => {
    // 守卫拒绝 / 装配失败 / DataSource 未就绪 → 只关闭 app，不做任何删除；
    // 精确清理失败仍关闭 app（try/finally），且不吞掉原错误。
    await runRepairRequestFixtureTeardown({
      app,
      dataSource,
      targetValidated: fixtureTargetValidated,
      cleanup: (ds) => cleanupRepairRequestFixtureByIds(ds, ownership),
    });
  });

  const gql = async <T>(params: { variables: unknown; token?: string }): Promise<GqlBody<T>> => {
    const response = await postGql({
      app,
      query: ENGINEER_LIST_QUERY,
      variables: params.variables,
      token: params.token,
    }).expect((res) => {
      expect([200, 400]).toContain(res.status);
    });
    return response.body as GqlBody<T>;
  };

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

  /** production 下的输入类拒绝：BAD_USER_INPUT + 业务码 + 可读文案（不得是兜底「请求失败」） */
  const expectBadUserInput = async (
    run: () => Promise<GqlBody<unknown>>,
    messagePart: string,
  ): Promise<void> => {
    await expectRejectionViaOverriddenFilter(async () => {
      const body = await run();

      expectSingleError(body, 'BAD_USER_INPUT', 'REPAIR_REQUEST_INVALID_PARAMS');
      expect(body.errors?.[0]?.message).toContain(messagePart);
      expect(body.errors?.[0]?.message).not.toBe('请求失败');
    });
  };

  it('生产分类链路有效性：全局过滤器来自 override 工厂（单例装配）', () => {
    expect(filterFactoryCalls).toBe(1);
    expect(app.get(GqlAllExceptionsFilter)).toBeDefined();
  });

  it('未登录：UNAUTHENTICATED（JWT_AUTHENTICATION_FAILED），不因生产环境塌缩为 500', async () => {
    await expectRejectionViaOverriddenFilter(async () => {
      const body = await gql<EngineerRepairRequestsData>({
        variables: { scope: 'ALL', pagination: VALID_PAGINATION },
      });

      expectSingleError(body, 'UNAUTHENTICATED', 'JWT_AUTHENTICATION_FAILED');
    });
  });

  it('CUSTOMER 直调：FORBIDDEN（INSUFFICIENT_PERMISSIONS）', async () => {
    await expectRejectionViaOverriddenFilter(async () => {
      const body = await gql<EngineerRepairRequestsData>({
        variables: { scope: 'ALL', pagination: VALID_PAGINATION },
        token: customerToken,
      });

      expectSingleError(body, 'FORBIDDEN', 'INSUFFICIENT_PERMISSIONS');
    });
  });

  it('边界合法（上限值）不误伤：customerNickname 100 字符 + pageSize=100 + 合法型号查询成功', async () => {
    const body = await gql<EngineerRepairRequestsData>({
      variables: {
        scope: 'ALL',
        pagination: { ...VALID_PAGINATION, pageSize: 100 },
        filter: { equipmentModelId: readModelId, customerNickname: '客'.repeat(100) },
      },
      token: engineerToken,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.engineerRepairRequests.items).toEqual([]);
    expect(body.data?.engineerRepairRequests.total).toBe(0);
  });

  it.each(INVALID_INPUT_CASES)(
    '生产分类：$label → BAD_USER_INPUT + REPAIR_REQUEST_INVALID_PARAMS + 可读文案',
    async ({ variables, messagePart }) => {
      await expectBadUserInput(
        () => gql<unknown>({ variables, token: engineerToken }),
        messagePart,
      );
    },
  );

  it('filter 携带未知字段被 GraphQL schema 层拒绝（BAD_USER_INPUT，不进入查询逻辑）', async () => {
    // 说明：GraphQL 输入类型本身不含未知字段，schema 校验先于 Resolver 的 ValidationPipe
    // 拒绝请求（因此这里没有 REPAIR_REQUEST_INVALID_PARAMS 业务码）；DTO 的
    // whitelist / forbidNonWhitelisted 作为纵深防御保留。
    const listUsecase = app.get(ListEngineerRepairRequestsUsecase);
    const spy = jest.spyOn(listUsecase, 'execute');

    try {
      const body = await gql<unknown>({
        variables: {
          scope: 'ALL',
          pagination: VALID_PAGINATION,
          filter: { unknownField: 1 },
        },
        token: engineerToken,
      });

      expect(body.errors).toBeDefined();
      expect(body.errors).toHaveLength(1);
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(JSON.stringify(body.errors)).toContain('unknownField');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('被拒请求不进入查询逻辑：DTO 校验失败时 ListEngineerRepairRequestsUsecase.execute 未被调用', async () => {
    const listUsecase = app.get(ListEngineerRepairRequestsUsecase);
    const spy = jest.spyOn(listUsecase, 'execute');

    try {
      // DTO 校验失败（pagination 越界）：pipe 在 Resolver 之前抛错，usecase 不得被调用
      await gql<unknown>({
        variables: { scope: 'ALL', pagination: { ...VALID_PAGINATION, pageSize: 101 } },
        token: engineerToken,
      });
      expect(spy).not.toHaveBeenCalled();

      // 对照：合法输入确实进入 usecase（证明 spy 有效）
      await gql<unknown>({
        variables: { scope: 'ALL', pagination: VALID_PAGINATION },
        token: engineerToken,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('注入的真实内部异常仍为 INTERNAL_SERVER_ERROR（不得伪装为参数错误，且不泄漏细节）', async () => {
    const listUsecase = app.get(ListEngineerRepairRequestsUsecase);
    // 故障注入：仅本次调用拒绝，其余用例继续使用真实 usecase（finally 恢复）
    const spy = jest
      .spyOn(listUsecase, 'execute')
      .mockRejectedValueOnce(new Error('测试注入的内部错误（不得外泄）'));

    try {
      await expectRejectionViaOverriddenFilter(async () => {
        const body = await gql<unknown>({
          variables: { scope: 'ALL', pagination: VALID_PAGINATION },
          token: engineerToken,
        });

        expect(body.errors).toHaveLength(1);
        expect(body.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
        // 生产环境不返回 errorCode / 原始 message，只给安全兜底文案
        expect(body.errors?.[0]?.extensions?.errorCode).toBeUndefined();
        expect(body.errors?.[0]?.message).toBe('系统繁忙，请稍后重试');
        expect(body.errors?.[0]?.message).not.toContain('测试注入');
      });
    } finally {
      spy.mockRestore();
    }
  });
});

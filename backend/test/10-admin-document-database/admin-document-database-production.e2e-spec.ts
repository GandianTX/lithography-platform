// test/10-admin-document-database/admin-document-database-production.e2e-spec.ts
//
// PR3 负责人 review #2（R2）回归：管理员文档数据库在**临时 production 配置**下的
// 真实 GraphQL 输入错误分类 E2E。
//
// 背景：三个带 @ValidateInput() 的列表 Query 抛 BadRequestException；生产环境的
// GqlAllExceptionsFilter 会把所有 HttpException 一律降级为 INTERNAL_SERVER_ERROR
// 并隐藏 message / errorCode，导致 DTO 校验失败被误分类为系统故障。R2 起本模块统一
// 使用模块局部 ValidateAdminDocumentDatabaseInput（DomainError → BAD_USER_INPUT）。
//
// 本文件断言（完整链路 DTO pipe → Resolver → Usecase → 实际 GqlAllExceptionsFilter
// 全部真实执行，仅过滤器拿到的 ConfigService 把 NODE_ENV 恒读为 production）：
// - 长度上限合法值在上限端点不误伤、全链路成功；
// - 长度上限 +1、equipmentModelId=0、非法 page/pageSize、日期范围倒置、非法详情 ID
//   在 production 均为 BAD_USER_INPUT + ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS + 可读文案；
// - adminAiMessages（R2 修补前无任何 DTO 校验的 Query）同样走一致契约；
// - 未登录 / ENGINEER / CUSTOMER 仍为 UNAUTHENTICATED / FORBIDDEN；
// - 不存在的详情仍为 NOT_FOUND（非输入类 DomainError 分类不变）；
// - 注入的真实内部异常仍为 INTERNAL_SERVER_ERROR（不得伪装为 BAD_USER_INPUT；
//   生产文案固定为「系统繁忙，请稍后重试」，不泄漏内部细节）；
// - 合法输入成功路径不受影响（无 errors，total 为真实计数）。
//
// 哨兵（同 my-account-settings-write-production 范式）：
// 1. filterFactoryCalls：override 工厂被调用（单例装配）；
// 2. filterNodeEnvReads：每个被拒请求恰好触发一次被 override 过滤器的 NODE_ENV
//    判定读取（catch() 首行每异常读取一次），证明请求确实走进了生产过滤器实例。
//
// R5/R6 回归补充（0922；敌对式终审 F1 后校准）：
// - R5：专属账号（testpr3r5*）+ **按数据库返回并记录的 ID** 精确回收
//   （cleanupProductionFixtureByIds）+ 崩溃残留按专属标记与完整归属校验恢复
//   （cleanupProductionFixtureResidue）+ 夹具外哨兵链；禁止无 WHERE 整表删除，
//   禁止以固定主键代表所有权；
// - R6：nullable 规整矩阵（省略 / {} / null / false / true / 合法 ID / 0 / 内部异常）。
//
// F1 全域授权收口后的准入事实：
// - 七个管理员查询入口统一要求「当前 admin_level=1」+「可信组织单一 ACTIVE 成员关系」，
//   因此本 spec 的管理员夹具在造数后补写等级并建立规格专属组织成员关系；
// - 组织/成员关系经 scoped 台账（runGuardedSpecCleanup）在账号精确回收之前清理，
//   否则 fk_organization_membership_account 的 RESTRICT 会让 cleanupProductionFixtureByIds
//   失败关闭；崩溃残留同样先按组织编码清理再走 cleanupProductionFixtureResidue。

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import { DataSource } from 'typeorm';

import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { ListAdminRepairRequestsUsecase } from '@src/usecases/admin-document-database/list-admin-repair-requests.usecase';
import { GqlAllExceptionsFilter } from '../../src/infrastructure/graphql/filters/graphql-exception.filter';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import { login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import {
  buildSuiteOrganizationCodes,
  seedTestMemberships,
  seedTestOrganizations,
} from '../utils/test-organizations';
import { runAdminDocFixtureTeardown } from './admin-document-database-fixture';
import {
  cleanupProductionFixtureByIds,
  cleanupProductionFixtureResidue,
  cleanupProductionSentinelChain,
  createProductionFixtureOwnership,
  ensureProductionSentinelChain,
  findProductionFixtureAccountIds,
  PRODUCTION_FIXTURE_ACCOUNTS,
  PRODUCTION_FIXTURE_MARKERS,
  type ProductionFixtureBusinessIds,
  type ProductionFixtureOwnership,
  readProductionSentinelSnapshot,
  seedProductionFixtureAccounts,
  seedProductionFixtureBusiness,
} from './admin-document-database-production-fixture';

type GqlError = {
  message: string;
  extensions?: { code?: string; errorCode?: string; errorMessage?: string };
};

type GqlBody<T> = { data?: T | null; errors?: GqlError[] };

type AdminRepairRequestsData = {
  adminRepairRequests: {
    items: Array<{ id: number; requestNo: string; isAccepted: boolean }>;
    total: number;
  };
};

type AdminConversationsData = { adminAiConversations: { items: unknown[]; total: number } };
type AdminMessagesData = { adminAiMessages: { items: unknown[]; total: number } };
type AdminReportsData = { adminAiReports: { items: unknown[]; total: number } };
type AdminReportDetailData = { adminAiReport: { id: number; reportTitle: string } };

const ADMIN_REPAIR_REQUESTS_QUERY = `
  query AdminRepairRequests($pagination: PaginationArgs!, $filter: AdminRepairRequestFilterInput) {
    adminRepairRequests(pagination: $pagination, filter: $filter) {
      items { id requestNo isAccepted }
      total
    }
  }
`;

const ADMIN_AI_CONVERSATIONS_QUERY = `
  query AdminAiConversations($pagination: PaginationArgs!, $filter: AdminAiConversationFilterInput) {
    adminAiConversations(pagination: $pagination, filter: $filter) {
      items { id }
      total
    }
  }
`;

const ADMIN_AI_MESSAGES_QUERY = `
  query AdminAiMessages($conversationId: Int!, $pagination: PaginationArgs!) {
    adminAiMessages(conversationId: $conversationId, pagination: $pagination) {
      items { id messageSeq }
      total
    }
  }
`;

const ADMIN_AI_REPORTS_QUERY = `
  query AdminAiReports($pagination: PaginationArgs!, $filter: AdminAiReportFilterInput) {
    adminAiReports(pagination: $pagination, filter: $filter) {
      items { id reportTitle }
      total
    }
  }
`;

const ADMIN_AI_REPORT_DETAIL_QUERY = `
  query AdminAiReport($id: Int!) {
    adminAiReport(id: $id) { id reportTitle }
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

/**
 * F1：管理员准入所需的规格专属组织（可信组织上下文来源）。
 * 编码带 E2E 前缀且本 spec 唯一：清理只按编码/本轮记录 ID 收敛。
 */
const PRODUCTION_ORGANIZATION_CODES = buildSuiteOrganizationCodes('ADMDOCPROD');
const PRODUCTION_ORGANIZATION = {
  organizationCode: PRODUCTION_ORGANIZATION_CODES.primary,
  name: 'E2E 甲方组织（生产分类夹具）',
  kind: 'CLIENT',
} as const;

/** 仅用于成员归属核验的账号指纹（账号本身由 production fixture 精确回收） */
const RETAINED_ACCOUNT_FINGERPRINTS = Object.values(PRODUCTION_FIXTURE_ACCOUNTS).map(
  toResidueAccountFingerprint,
);

/** 与 DTO / usecase 校验断言的期望文案一一对应（生产环境必须保留可读文案） */
const INVALID_INPUT_CASES: ReadonlyArray<{
  readonly label: string;
  readonly query: string;
  readonly variables: Record<string, unknown>;
  readonly messagePart: string;
}> = [
  {
    label: 'requestNo 上限 +1（65 字符）',
    query: ADMIN_REPAIR_REQUESTS_QUERY,
    variables: {
      pagination: VALID_PAGINATION,
      filter: { requestNo: 'R'.repeat(65) },
    },
    messagePart: '申请编号搜索词不能超过 64 个字符',
  },
  {
    label: 'customerKeyword 上限 +1（101 字符）',
    query: ADMIN_REPAIR_REQUESTS_QUERY,
    variables: {
      pagination: VALID_PAGINATION,
      filter: { customerKeyword: '客'.repeat(101) },
    },
    messagePart: '客户关键字不能超过 100 个字符',
  },
  {
    label: 'equipmentModelId=0',
    query: ADMIN_REPAIR_REQUESTS_QUERY,
    variables: {
      pagination: VALID_PAGINATION,
      filter: { equipmentModelId: 0 },
    },
    messagePart: '设备型号 ID 必须大于 0',
  },
  {
    label: 'pageSize=101（超过上限）',
    query: ADMIN_REPAIR_REQUESTS_QUERY,
    variables: { pagination: { ...VALID_PAGINATION, pageSize: 101 } },
    messagePart: '每页数量不能超过 100',
  },
  {
    label: 'pageSize=0（低于下限）',
    query: ADMIN_REPAIR_REQUESTS_QUERY,
    variables: { pagination: { ...VALID_PAGINATION, pageSize: 0 } },
    messagePart: '每页数量必须大于等于 1',
  },
  {
    label: 'page=0（低于下限）',
    query: ADMIN_REPAIR_REQUESTS_QUERY,
    variables: { pagination: { ...VALID_PAGINATION, page: 0 } },
    messagePart: '页码必须大于等于 1',
  },
  {
    label: '日期范围倒置（usecase 层校验）',
    query: ADMIN_REPAIR_REQUESTS_QUERY,
    variables: {
      pagination: VALID_PAGINATION,
      filter: {
        createdAtFrom: '2026-02-01T00:00:00.000Z',
        createdAtTo: '2026-01-01T00:00:00.000Z',
      },
    },
    messagePart: '时间范围无效：起始时间不能晚于结束时间',
  },
  {
    label: 'AI 会话 engineerKeyword 上限 +1（101 字符）',
    query: ADMIN_AI_CONVERSATIONS_QUERY,
    variables: {
      pagination: VALID_PAGINATION,
      filter: { engineerKeyword: '工'.repeat(101) },
    },
    messagePart: '工程师关键字不能超过 100 个字符',
  },
  {
    label: 'AI 报告 reportType 上限 +1（101 字符）',
    query: ADMIN_AI_REPORTS_QUERY,
    variables: {
      pagination: VALID_PAGINATION,
      filter: { reportType: 'T'.repeat(101) },
    },
    messagePart: '报告类型不能超过 100 个字符',
  },
  {
    label: 'adminAiMessages pageSize=101（R2 新增校验覆盖）',
    query: ADMIN_AI_MESSAGES_QUERY,
    variables: { conversationId: 301, pagination: { ...VALID_PAGINATION, pageSize: 101 } },
    messagePart: '每页数量不能超过 100',
  },
  {
    label: '详情 ID=0（usecase 正整数校验）',
    query: ADMIN_AI_REPORT_DETAIL_QUERY,
    variables: { id: 0 },
    messagePart: 'AI 报告 ID无效',
  },
];

describe('admin-document-database 生产环境输入错误分类 (e2e, NODE_ENV=production)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let engineerToken: string;
  let customerToken: string;
  /**
   * R5：本轮实际创建并记录的所有权上下文。
   * ID 只在运行期存在（数据库生成）；收尾只按这里的 ID 回收，不使用任何固定主键。
   */
  const ownership: ProductionFixtureOwnership = createProductionFixtureOwnership();
  /** R6 锚点业务数据（型号 / 申请的 ID 由数据库生成） */
  let businessIds: ProductionFixtureBusinessIds;
  /**
   * F1：本轮创建的规格专属组织与成员关系（scoped 台账）。
   * 成员关系必须先于账号回收删除（外键 RESTRICT），因此单独持有并最先清理。
   */
  const suiteOwnership = createOwnedResourceLedger();
  /** R5：仅当 beforeAll 在「写夹具之前」完成白名单验证才置位，afterAll 据此决定能否清理。 */
  let fixtureTargetValidated = false;

  /** 先清组织成员/组织，再按归属精确清账号与业务行（顺序不可交换） */
  const cleanupOrganizationThenFixture = async (ds: DataSource): Promise<void> => {
    await runGuardedSpecCleanup({
      dataSource: ds,
      owned: suiteOwnership,
      retainedAccounts: RETAINED_ACCOUNT_FINGERPRINTS,
      helper: 'admin-document-database-production.e2e-spec 组织链清理',
    });
    await cleanupProductionFixtureByIds(ds, ownership);
  };

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

    // 🔒 第一条 DELETE 之前复用不可跳过的目标库白名单守卫（0918 P0 / R5）
    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    // R5：守卫通过后才允许清理/写夹具（守卫拒绝 / 装配中途失败时 afterAll 只关闭 app）
    fixtureTargetValidated = true;

    // R5 精确生命周期：先按专属标记 + 完整归属校验回收上一次运行的崩溃残留，
    // 再按本轮记录的 ID 收尾；无残留时全部 no-op（连跑两遍幂等）；禁止无 WHERE 整表删除。
    // F1：上一次中断可能留下组织成员关系（RESTRICT 会阻塞账号回收），
    // 先按组织编码 + 账号指纹核验清理组织链残留，再回收夹具账号。
    await runGuardedSpecCleanup({
      dataSource,
      residue: { organizations: [PRODUCTION_ORGANIZATION] },
      retainedAccounts: RETAINED_ACCOUNT_FINGERPRINTS,
      helper: 'admin-document-database-production.e2e-spec beforeAll 组织残留清理',
    });
    await cleanupProductionFixtureResidue(dataSource);

    const { created, failures } = await seedProductionFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    if (failures.length > 0) {
      // 部分造数失败：仅按已记录的成功 ID 回收 + fail fast（不留半残夹具）
      await cleanupProductionFixtureByIds(dataSource, ownership);
      throw new Error(
        `production 专属账号创建失败：${failures
          .map((failure) => `${failure.key}(${failure.loginName})`)
          .join(', ')}`,
      );
    }

    const accountIdByKey = new Map(created.map((seed) => [seed.key, seed.accountId]));
    const adminAccountId = accountIdByKey.get('admin');
    const customerAccountId = accountIdByKey.get('customer');
    const engineerAccountId = accountIdByKey.get('engineer');
    if (
      adminAccountId === undefined ||
      customerAccountId === undefined ||
      engineerAccountId === undefined
    ) {
      throw new Error('production 专属账号创建记录不完整（缺少 admin / customer / engineer）');
    }
    // F1：等级事实取当前库（`base_user_account.admin_level`），不信任 JWT 静态等级；
    // 管理员必须为一级，且拥有唯一 ACTIVE 组织成员关系，才能通过七个查询入口的准入判断。
    await dataSource.query('UPDATE base_user_account SET admin_level = 1 WHERE id = ?', [
      adminAccountId,
    ]);
    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [PRODUCTION_ORGANIZATION],
      ownership: suiteOwnership,
    });
    await seedTestMemberships({
      dataSource,
      organizationIdsByCode: organizationIds,
      ownership: suiteOwnership,
      memberships: [
        {
          accountLoginName: PRODUCTION_FIXTURE_ACCOUNTS.admin.loginName,
          organizationCode: PRODUCTION_ORGANIZATION.organizationCode,
          memberRole: 'SUPER_ADMIN',
        },
      ],
    });

    // R6 锚点业务数据（专属标记的型号 + 申请；主键由数据库生成，成功即记进 ownership）
    businessIds = await seedProductionFixtureBusiness({
      dataSource,
      ownership,
      customerAccountId,
      engineerAccountId,
    });

    adminToken = await login({
      app,
      loginName: PRODUCTION_FIXTURE_ACCOUNTS.admin.loginName,
      loginPassword: PRODUCTION_FIXTURE_ACCOUNTS.admin.loginPassword,
    });
    engineerToken = await login({
      app,
      loginName: PRODUCTION_FIXTURE_ACCOUNTS.engineer.loginName,
      loginPassword: PRODUCTION_FIXTURE_ACCOUNTS.engineer.loginPassword,
    });
    customerToken = await login({
      app,
      loginName: PRODUCTION_FIXTURE_ACCOUNTS.customer.loginName,
      loginPassword: PRODUCTION_FIXTURE_ACCOUNTS.customer.loginPassword,
    });
  });

  afterAll(async () => {
    // R5：守卫拒绝 / 装配失败 / DataSource 未就绪 → 只关闭 app，不做任何删除；
    // 精确清理失败仍关闭 app（try/finally），且不吞掉原错误。
    await runAdminDocFixtureTeardown({
      app,
      dataSource,
      targetValidated: fixtureTargetValidated,
      cleanup: cleanupOrganizationThenFixture,
    });
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

      expectSingleError(body, 'BAD_USER_INPUT', 'ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS');
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
      const body = await gql<AdminRepairRequestsData>({
        query: ADMIN_REPAIR_REQUESTS_QUERY,
        variables: { pagination: VALID_PAGINATION },
      });

      expectSingleError(body, 'UNAUTHENTICATED', 'JWT_AUTHENTICATION_FAILED');
    });
  });

  it.each([
    { label: 'ENGINEER', tokenKey: 'engineer' as const },
    { label: 'CUSTOMER', tokenKey: 'customer' as const },
  ])('$label 直调：FORBIDDEN（INSUFFICIENT_PERMISSIONS）', async ({ tokenKey }) => {
    const token = tokenKey === 'engineer' ? engineerToken : customerToken;

    await expectRejectionViaOverriddenFilter(async () => {
      const body = await gql<AdminRepairRequestsData>({
        query: ADMIN_REPAIR_REQUESTS_QUERY,
        variables: { pagination: VALID_PAGINATION },
        token,
      });

      expectSingleError(body, 'FORBIDDEN', 'INSUFFICIENT_PERMISSIONS');
    });
  });

  it('边界合法（上限值）不误伤：requestNo 64 字符 + customerKeyword 100 字符 + pageSize=100 成功', async () => {
    const body = await gql<AdminRepairRequestsData>({
      query: ADMIN_REPAIR_REQUESTS_QUERY,
      variables: {
        pagination: { ...VALID_PAGINATION, pageSize: 100 },
        filter: { requestNo: 'R'.repeat(64), customerKeyword: '客'.repeat(100) },
      },
      token: adminToken,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.adminRepairRequests.total).toBe(0);
  });

  it('边界合法（上限值）不误伤：engineerKeyword 100 字符 + reportType 100 字符成功', async () => {
    const conversations = await gql<AdminConversationsData>({
      query: ADMIN_AI_CONVERSATIONS_QUERY,
      variables: {
        pagination: { ...VALID_PAGINATION, pageSize: 100 },
        filter: { engineerKeyword: '工'.repeat(100) },
      },
      token: adminToken,
    });
    expect(conversations.errors).toBeUndefined();
    expect(conversations.data?.adminAiConversations.total).toBe(0);

    const reports = await gql<AdminReportsData>({
      query: ADMIN_AI_REPORTS_QUERY,
      variables: {
        pagination: { ...VALID_PAGINATION, pageSize: 100 },
        filter: { reportType: 'T'.repeat(100) },
      },
      token: adminToken,
    });
    expect(reports.errors).toBeUndefined();
    expect(reports.data?.adminAiReports.total).toBe(0);
  });

  it('合法输入成功路径不受新校验影响：adminAiMessages 空页语义（total 0，非报错）', async () => {
    const body = await gql<AdminMessagesData>({
      query: ADMIN_AI_MESSAGES_QUERY,
      variables: { conversationId: 999999, pagination: { ...VALID_PAGINATION, pageSize: 100 } },
      token: adminToken,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.adminAiMessages.items).toEqual([]);
    expect(body.data?.adminAiMessages.total).toBe(0);
  });

  it.each(INVALID_INPUT_CASES)(
    '生产分类：$label → BAD_USER_INPUT + 可读文案',
    async ({ query, variables, messagePart }) => {
      await expectBadUserInput(
        () => gql<unknown>({ query, variables, token: adminToken }),
        messagePart,
      );
    },
  );

  it('非输入类 DomainError 分类不变：不存在的报告为 NOT_FOUND（非 BAD_USER_INPUT / 500）', async () => {
    await expectRejectionViaOverriddenFilter(async () => {
      const body = await gql<AdminReportDetailData>({
        query: ADMIN_AI_REPORT_DETAIL_QUERY,
        variables: { id: 99999999 },
        token: adminToken,
      });

      expectSingleError(body, 'NOT_FOUND', 'ADMIN_DOCUMENT_DATABASE_NOT_FOUND');
      expect(body.data?.adminAiReport).toBeUndefined();
    });
  });

  it('注入的真实内部异常仍为 INTERNAL_SERVER_ERROR（不得伪装为参数错误，且不泄漏细节）', async () => {
    const listUsecase = app.get(ListAdminRepairRequestsUsecase);
    // 故障注入：仅本次调用拒绝，其余用例继续使用真实 usecase（finally 恢复）
    const spy = jest
      .spyOn(listUsecase, 'execute')
      .mockRejectedValueOnce(new Error('测试注入的内部错误（不得外泄）'));

    try {
      await expectRejectionViaOverriddenFilter(async () => {
        const body = await gql<unknown>({
          query: ADMIN_REPAIR_REQUESTS_QUERY,
          variables: { pagination: VALID_PAGINATION },
          token: adminToken,
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

  describe('R6 nullable 规整矩阵（production GraphQL，真实链路）', () => {
    const matrixPagination = { mode: 'OFFSET', page: 1, pageSize: 50, withTotal: true };

    // 锚点业务数据（专属标记的型号 + 两条申请，主键由数据库生成）由文件级 beforeAll
    // 统一创建，生命周期随 R5 精确清理收口（本 describe 不再单独干预）。

    const listRepairRequests = async (filter?: Record<string, unknown>) => {
      const body = await gql<AdminRepairRequestsData>({
        query: ADMIN_REPAIR_REQUESTS_QUERY,
        variables: { pagination: matrixPagination, filter },
        token: adminToken,
      });
      expect(body.errors).toBeUndefined();
      if (!body.data) {
        throw new Error('R6 矩阵查询缺少 data');
      }
      return body.data.adminRepairRequests;
    };

    it('省略 filter 与 filter:{} 等价（默认结果一致）', async () => {
      const omitted = await listRepairRequests();
      const emptyFilter = await listRepairRequests({});
      expect(emptyFilter.total).toBe(omitted.total);
    });

    it('isAccepted:null 与省略等价（显式 null 不得进入 ORM 条件）', async () => {
      const omitted = await listRepairRequests();
      const withNull = await listRepairRequests({ isAccepted: null });
      expect(withNull.total).toBe(omitted.total);
    });

    it('equipmentModelId:null 与省略等价（显式 null 不得进入 ORM 条件）', async () => {
      const omitted = await listRepairRequests();
      const withNull = await listRepairRequests({ equipmentModelId: null });
      expect(withNull.total).toBe(omitted.total);
    });

    it('isAccepted:false 只筛未接单：false 不丢失且命中未接单锚点', async () => {
      const page = await listRepairRequests({ isAccepted: false });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.isAccepted === false)).toBe(true);
      expect(page.items.map((item) => item.requestNo)).toContain(
        PRODUCTION_FIXTURE_MARKERS.openRequestNo,
      );
    });

    it('isAccepted:true 只筛已接单且命中已接单锚点', async () => {
      const page = await listRepairRequests({ isAccepted: true });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.isAccepted === true)).toBe(true);
      expect(page.items.map((item) => item.requestNo)).toContain(
        PRODUCTION_FIXTURE_MARKERS.acceptedRequestNo,
      );
    });

    it('isAccepted false/true 互补：两集合之和等于默认全集', async () => {
      const [omitted, openOnly, acceptedOnly] = await Promise.all([
        listRepairRequests(),
        listRepairRequests({ isAccepted: false }),
        listRepairRequests({ isAccepted: true }),
      ]);
      expect(openOnly.total + acceptedOnly.total).toBe(omitted.total);
    });

    it('合法设备 ID 等值过滤命中锚点申请', async () => {
      const page = await listRepairRequests({
        equipmentModelId: businessIds.equipmentModelId,
      });
      expect(page.total).toBe(2);
      const requestNos = page.items.map((item) => item.requestNo);
      expect(requestNos).toContain(PRODUCTION_FIXTURE_MARKERS.openRequestNo);
      expect(requestNos).toContain(PRODUCTION_FIXTURE_MARKERS.acceptedRequestNo);
    });
  });

  describe('R5 清理边界：专属范围精确回收（真实隔离库）', () => {
    it('按本轮记录 ID 精确回收专属账号与锚点行；夹具外哨兵链运行前后完全一致', async () => {
      // 夹具外哨兵链（独立 loginName 与独立标记）：不属于专属清理边界
      const sentinelOwnership = createProductionFixtureOwnership();
      const sentinelIds = await ensureProductionSentinelChain({
        dataSource,
        ownership: sentinelOwnership,
        createAccountUsecase: app.get(CreateAccountUsecase),
      });

      const before = await readProductionSentinelSnapshot(dataSource, sentinelIds);
      expect(before.account).not.toBeNull();
      expect(before.userInfo).not.toBeNull();
      expect(before.model).not.toBeNull();
      expect(before.request).not.toBeNull();

      try {
        // 只按本轮实际创建并记录的 ID 回收（不接受任何裸固定 ID）
        // F1：组织成员关系先于账号删除，否则 RESTRICT 会使清理失败关闭
        await cleanupOrganizationThenFixture(dataSource);

        // 专属账号已被精确回收（清理确实发生，而非整表删除后的错删/报错）
        expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);
        // 哨兵链（账号 / userInfo / 型号 / 关联申请）原样存在：ID、字段、行数完全一致
        expect(await readProductionSentinelSnapshot(dataSource, sentinelIds)).toEqual(before);
      } finally {
        await cleanupProductionSentinelChain(dataSource, sentinelIds);
      }
    });

    it('连续两次精确回收幂等：第二次为 no-op，不报错且哨兵不受影响', async () => {
      // 前置：先确保文件级夹具已收口（等价于「上次残留 → 连续两次回收」的真实路径）
      // F1：同样先清组织成员关系，保证单独运行本用例时账号回收不被 RESTRICT 阻断
      await cleanupOrganizationThenFixture(dataSource);

      const sentinelOwnership = createProductionFixtureOwnership();
      const sentinelIds = await ensureProductionSentinelChain({
        dataSource,
        ownership: sentinelOwnership,
        createAccountUsecase: app.get(CreateAccountUsecase),
      });

      // 重种专属账号 + 锚点行（本轮新的所有权上下文）
      const reseedOwnership = createProductionFixtureOwnership();
      const reseeded = await seedProductionFixtureAccounts({
        dataSource,
        ownership: reseedOwnership,
        createAccountUsecase: app.get(CreateAccountUsecase),
      });
      expect(reseeded.failures).toEqual([]);
      const reseededIdByKey = new Map(reseeded.created.map((seed) => [seed.key, seed.accountId]));
      const customerAccountId = reseededIdByKey.get('customer');
      const engineerAccountId = reseededIdByKey.get('engineer');
      if (customerAccountId === undefined || engineerAccountId === undefined) {
        throw new Error('重种专属账号记录不完整（缺少 customer / engineer）');
      }
      await seedProductionFixtureBusiness({
        dataSource,
        ownership: reseedOwnership,
        customerAccountId,
        engineerAccountId,
      });

      const before = await readProductionSentinelSnapshot(dataSource, sentinelIds);

      try {
        await cleanupProductionFixtureByIds(dataSource, reseedOwnership);
        expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);
        // 第二次调用：ID 集合仍在，但行已不存在 → 必须 no-op，且不影响夹具外哨兵
        await cleanupProductionFixtureByIds(dataSource, reseedOwnership);
        expect(await readProductionSentinelSnapshot(dataSource, sentinelIds)).toEqual(before);
      } finally {
        await cleanupProductionSentinelChain(dataSource, sentinelIds);
      }
    });
  });
});

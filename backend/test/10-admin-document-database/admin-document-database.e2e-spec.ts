// test/10-admin-document-database/admin-document-database.e2e-spec.ts

import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { login, postGql } from '../utils/e2e-graphql-utils';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
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
import {
  ADMIN_DOC_FIXTURE_ACCOUNTS,
  ADMIN_DOC_FIXTURE_MARKERS,
  cleanupAdminDocumentFixtureByIds,
  cleanupAdminDocumentFixtureResidue,
  createAdminDocFixtureOwnership,
  runAdminDocFixtureTeardown,
  seedAdminDocumentFixtureAccounts,
  seedAdminDocumentFixtureBusiness,
  type AdminDocFixtureIds,
} from './admin-document-database-fixture';

/**
 * PR3 S4：管理员文档数据库只读聚合 E2E（真实 MySQL + 真实 GraphQL 链路）。
 *
 * 覆盖计划表 S4.3/S4.7 的接口层回归：
 * - 角色矩阵：SUPER_ADMIN 成功；ENGINEER / CUSTOMER FORBIDDEN；匿名 UNAUTHENTICATED；
 * - 软删除默认过滤与真实 total（比对 total 与列表长度）；
 * - 100 轮会话 200 条消息按 messageSeq ASC 的分页稳定顺序读取；
 * - M-04 权威口径：报告 requestNo 以会话归属申请为准 + requestMismatch 审计标记；
 * - 空筛选结果为正式空页（items 空、total 0），不报错。
 */
describe('AdminDocumentDatabase (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let adminToken: string;
  let engineerToken: string;
  let customerToken: string;
  let fixtureIds: AdminDocFixtureIds;
  const ownership = createAdminDocFixtureOwnership();
  const suiteOwnership = createOwnedResourceLedger();
  // 规格专属测试组织（聚合统计用例的可信组织上下文；编码带 E2E 前缀，清理以编码为界）
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('ADMDOC');
  /** R1：仅当 beforeAll 在「写夹具之前」完成白名单验证才置位，afterAll 据此决定能否清理。 */
  let fixtureTargetValidated = false;

  const REQUEST_NO_A = ADMIN_DOC_FIXTURE_MARKERS.requestA;
  const TOTAL_MESSAGES = 200; // 100 轮 × 每轮 USER + ASSISTANT

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);

    await app.init();

    // 🔒 首次删除夹具之前，复用与 global-setup 同一不可跳过的目标库白名单守卫：
    //    即使有人用 E2E_SKIP_INFRA_CHECKS / E2E_SKIP_DB_CLEANUP 绕过了全局清理校验，
    //    本 spec 也绝不会在未验证（非隔离 E2E 库）的数据库上执行 DELETE。
    await assertDataSourceOnAllowedE2eDatabase(dataSource);

    // R1：守卫通过后才允许清理（写夹具之前置位）；守卫拒绝 / 半途失败时
    // afterAll 只关闭 app，不会在未授权目标上 DELETE。
    fixtureTargetValidated = true;

    // A-PR0 组织适配：先按组织编码清理残留成员/组织（fk_organization_membership_account
    // RESTRICT 会阻塞 fixture 账号回收）；删除经双门禁（许可+库名，互相独立），
    // 再清 fixture 残留
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: [
          {
            organizationCode: suiteOrganizationCodes.primary,
            name: 'E2E 甲方组织（文档库统计）',
            kind: 'CLIENT',
          },
        ],
      },
      // fixture 账号由相邻的 cleanupAdminDocumentFixture* 事务管理：这里只用于成员归属核验
      retainedAccounts: Object.values(ADMIN_DOC_FIXTURE_ACCOUNTS).map(toResidueAccountFingerprint),
      helper: 'admin-document-database.e2e-spec beforeAll 预清理',
    });

    // 上轮残留只能按专属标记定位，逐字段/引用核验通过后才在事务中精确回收。
    await cleanupAdminDocumentFixtureResidue(dataSource);

    const accountIds = await seedAdminDocumentFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    const businessIds = await seedAdminDocumentFixtureBusiness({
      dataSource,
      ownership,
      customerAccountId: accountIds.customer,
      engineerAccountId: accountIds.engineer,
    });
    fixtureIds = {
      adminAccountId: accountIds.admin,
      engineerAccountId: accountIds.engineer,
      customerAccountId: accountIds.customer,
      ...businessIds,
    };

    // 聚合统计用例（adminDocumentDatabaseStats）经可信组织上下文解析：
    // fixture 管理员需要本规格专属组织的 ACTIVE 成员关系
    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: 'E2E 甲方组织（文档库统计）',
          kind: 'CLIENT',
        },
      ],
      ownership: suiteOwnership,
    });
    await seedTestMemberships({
      dataSource,
      organizationIdsByCode: organizationIds,
      ownership: suiteOwnership,
      memberships: [
        {
          accountLoginName: ADMIN_DOC_FIXTURE_ACCOUNTS.admin.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'SUPER_ADMIN',
        },
      ],
    });

    adminToken = await login({
      app,
      loginName: ADMIN_DOC_FIXTURE_ACCOUNTS.admin.loginName,
      loginPassword: ADMIN_DOC_FIXTURE_ACCOUNTS.admin.loginPassword,
    });
    engineerToken = await login({
      app,
      loginName: ADMIN_DOC_FIXTURE_ACCOUNTS.engineer.loginName,
      loginPassword: ADMIN_DOC_FIXTURE_ACCOUNTS.engineer.loginPassword,
    });
    customerToken = await login({
      app,
      loginName: ADMIN_DOC_FIXTURE_ACCOUNTS.customer.loginName,
      loginPassword: ADMIN_DOC_FIXTURE_ACCOUNTS.customer.loginPassword,
    });
  });

  afterAll(async () => {
    // R1：守卫拒绝、模块装配失败、连接未完成 → 只关闭已创建的 app，不做任何删除；
    // 清理失败不吞错且仍会关闭 app（try/finally 在 helper 内实现）。
    await runAdminDocFixtureTeardown({
      app,
      dataSource,
      targetValidated: fixtureTargetValidated,
      cleanup: async (ds) => {
        // 先清组织成员/组织（否则成员关系阻塞 fixture 账号回收，组织链清理经双门禁），
        // 再按归属精确清 fixture
        await runGuardedSpecCleanup({
          dataSource: ds,
          owned: suiteOwnership,
          retainedAccounts: Object.values(ADMIN_DOC_FIXTURE_ACCOUNTS).map(
            toResidueAccountFingerprint,
          ),
          helper: 'admin-document-database.e2e-spec afterAll 组织链清理',
        });
        await cleanupAdminDocumentFixtureByIds(ds, ownership);
      },
    });
  });

  const executeGql = (query: string, token?: string, variables?: unknown) =>
    postGql({ app, query, token, variables });

  describe('角色矩阵（计划表 S4.3）', () => {
    const listQuery = `
      query AdminRepairRequests($pagination: PaginationArgs!) {
        adminRepairRequests(pagination: $pagination) {
          items { id requestNo }
          total
        }
      }
    `;
    const pagination = { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true };

    it('SUPER_ADMIN 读取成功且 total 与列表一致', async () => {
      const response = await executeGql(listQuery, adminToken, { pagination }).expect(200);

      const page = (
        response.body as { data: { adminRepairRequests: { items: unknown[]; total: number } } }
      ).data.adminRepairRequests;
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(2);
    });

    it('ENGINEER 直调返回 FORBIDDEN', async () => {
      const response = await executeGql(listQuery, engineerToken, { pagination }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(response.body.data).toBeNull();
    });

    it('CUSTOMER 直调返回 FORBIDDEN', async () => {
      const response = await executeGql(listQuery, customerToken, { pagination }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    it('匿名（无 token）返回 UNAUTHENTICATED', async () => {
      const response = await executeGql(listQuery, undefined, { pagination }).expect(200);

      expect(response.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('软删除过滤、真实总数与筛选', () => {
    it('默认排除软删除申请：专属软删行不出现在列表与总数', async () => {
      const response = await executeGql(
        `
        query ($pagination: PaginationArgs!) {
          adminRepairRequests(pagination: $pagination) {
            items { id requestNo errorCode isAccepted customerNickname }
            total
          }
        }
      `,
        adminToken,
        { pagination: { mode: 'OFFSET', page: 1, pageSize: 50, withTotal: true } },
      ).expect(200);

      const page = (
        response.body as {
          data: { adminRepairRequests: { items: Array<{ requestNo: string }>; total: number } };
        }
      ).data.adminRepairRequests;
      expect(page.total).toBe(2);
      const requestNos = page.items.map((item) => item.requestNo);
      expect(requestNos).toContain(REQUEST_NO_A);
      expect(requestNos).not.toContain(ADMIN_DOC_FIXTURE_MARKERS.requestDeleted);
    });

    it('requestNo 模糊筛选命中唯一申请（SQL 侧筛选 + 真实 total）', async () => {
      const response = await executeGql(
        `
        query ($filter: AdminRepairRequestFilterInput, $pagination: PaginationArgs!) {
          adminRepairRequests(filter: $filter, pagination: $pagination) {
            items { requestNo }
            total
          }
        }
      `,
        adminToken,
        {
          filter: { requestNo: 'CORE-A' },
          pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
        },
      ).expect(200);

      const page = (
        response.body as {
          data: { adminRepairRequests: { items: Array<{ requestNo: string }>; total: number } };
        }
      ).data.adminRepairRequests;
      expect(page.total).toBe(1);
      expect(page.items[0].requestNo).toBe(REQUEST_NO_A);
    });

    it('无命中筛选返回正式空页（items 空、total 0，不报错）', async () => {
      const response = await executeGql(
        `
        query ($filter: AdminRepairRequestFilterInput, $pagination: PaginationArgs!) {
          adminRepairRequests(filter: $filter, pagination: $pagination) {
            items { requestNo }
            total
          }
        }
      `,
        adminToken,
        {
          filter: { requestNo: 'E2E-不存在-999' },
          pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
        },
      ).expect(200);

      const page = (
        response.body as { data: { adminRepairRequests: { items: unknown[]; total: number } } }
      ).data.adminRepairRequests;
      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });
  });

  describe('100 轮会话消息稳定顺序（计划表 S4.2）', () => {
    const messagesQuery = `
      query AdminAiMessages($conversationId: Int!, $pagination: PaginationArgs!) {
        adminAiMessages(conversationId: $conversationId, pagination: $pagination) {
          items { id messageSeq turnNo role contentText }
          total
        }
      }
    `;

    it('total 为 200（100 轮 × 2）；第一页 messageSeq 1..100 严格递增', async () => {
      const response = await executeGql(messagesQuery, adminToken, {
        conversationId: fixtureIds.conversationAId,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 100, withTotal: true },
      }).expect(200);

      const page = (
        response.body as {
          data: {
            adminAiMessages: { items: Array<{ messageSeq: number; role: string }>; total: number };
          };
        }
      ).data.adminAiMessages;
      expect(page.total).toBe(TOTAL_MESSAGES);
      expect(page.items).toHaveLength(100);
      const seqs = page.items.map((item) => item.messageSeq);
      expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
      // 每轮 USER → ASSISTANT 交替
      expect(page.items[0].role).toBe('USER');
      expect(page.items[1].role).toBe('ASSISTANT');
      expect(page.items[2].role).toBe('USER');
    });

    it('第二页衔接第一页（messageSeq 101..200），分页不重不漏', async () => {
      const response = await executeGql(messagesQuery, adminToken, {
        conversationId: fixtureIds.conversationAId,
        pagination: { mode: 'OFFSET', page: 2, pageSize: 100, withTotal: true },
      }).expect(200);

      const page = (
        response.body as { data: { adminAiMessages: { items: Array<{ messageSeq: number }> } } }
      ).data.adminAiMessages;
      expect(page.items.map((item) => item.messageSeq)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 101),
      );
    });

    it('不存在的会话返回空页（分页语义，不报错）', async () => {
      const response = await executeGql(messagesQuery, adminToken, {
        conversationId: 2147483647,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 50, withTotal: true },
      }).expect(200);

      const page = (
        response.body as { data: { adminAiMessages: { items: unknown[]; total: number } } }
      ).data.adminAiMessages;
      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });
  });

  describe('M-04 权威口径与统计（真实 count）', () => {
    it('报告详情：requestNo 以会话归属申请为权威，mismatch 标记准确', async () => {
      const response = await executeGql(
        `
        query ($reportAId: Int!, $reportMismatchId: Int!) {
          reportA: adminAiReport(id: $reportAId) { id requestNo requestMismatch }
          reportMismatch: adminAiReport(id: $reportMismatchId) { id requestNo requestMismatch }
        }
      `,
        adminToken,
        {
          reportAId: fixtureIds.reportAId,
          reportMismatchId: fixtureIds.reportMismatchId,
        },
      ).expect(200);

      const data = (
        response.body as {
          data: {
            reportA: { requestNo: string; requestMismatch: boolean };
            reportMismatch: { requestNo: string; requestMismatch: boolean };
          };
        }
      ).data;
      expect(data.reportA.requestNo).toBe(REQUEST_NO_A);
      expect(data.reportA.requestMismatch).toBe(false);
      // mismatch 报告记录指向软删申请，会话仍归属 A —— 展示权威编号并标记审计
      expect(data.reportMismatch.requestNo).toBe(REQUEST_NO_A);
      expect(data.reportMismatch.requestMismatch).toBe(true);
    });

    it('统计四类计数与夹具一致（参考资料全空 → 0，无演示数字）', async () => {
      const response = await executeGql(
        `
        query {
          adminDocumentDatabaseStats {
            repairRequestTotal
            referenceDocumentTotal
            aiConversationTotal
            aiReportTotal
          }
        }
      `,
        adminToken,
      ).expect(200);

      const stats = (
        response.body as { data: { adminDocumentDatabaseStats: Record<string, number> } }
      ).data.adminDocumentDatabaseStats;
      expect(stats).toEqual({
        repairRequestTotal: 2,
        referenceDocumentTotal: 0,
        aiConversationTotal: 2,
        aiReportTotal: 2,
      });
    });
  });
});

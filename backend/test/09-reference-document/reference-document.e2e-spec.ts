// test/09-reference-document/reference-document.e2e-spec.ts

/**
 * AI 参考资料库端点级回归（core 组，任务 07 口径）
 *
 * 造数纪律：确认需求已关闭普通资料新增（createReferenceDocument）、通用编辑
 * （updateReferenceDocument）与 REST multipart 上传，本规格不再用这些生产入口造数，
 * 全部夹具直接写 reference_document（`withReferenceDocumentFixtureState` 补齐 V13 必填
 * 状态），并按真实 ID 与创建即定事实登记本轮台账；清理只回收本轮登记的行。
 *
 * 覆盖范围：
 * - 读侧统一可见谓词（未软删 + ONLINE + CONFIRMED + 服务端可信范围）在列表 / 详情 /
 *   历史版本 / 下载四个入口一致：软删、下架、归属待核实、跨公司一律 NOT_FOUND；
 * - 旧写入口已从 schema 移除（协议层校验失败，不进入守卫与用例）；
 * - 一级管理员管理动作 R058 修订 / R059 下架 / R060 管理删除 / R061-02 归属更正，
 *   含 expected_version 过期拒绝、二级管理员与工程师/客户被拒、关键审计落库；
 * - 原作者删除 R053：仅本人条目、版本核对、管理员作为原作者补写关键审计；
 * - REST 只保留授权下载（上传端点已下线）。
 *
 * 存储隔离：运行级临时目录，先于应用初始化设置 env，收尾按精确路径清理并恢复原值。
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
  updateOwnedExpectation,
} from '../utils/e2e-scoped-cleanup';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from '../utils/e2e-teardown';
import {
  readReferenceDocumentFacts,
  registerReferenceDocumentAuditEvents,
  registerReferenceDocumentRevisions,
  seedReferenceDocumentFixture,
} from '../utils/reference-document-fixtures';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import {
  buildSuiteOrganizationCodes,
  requireOrganizationId,
  seedTestMemberships,
  seedTestOrganizations,
} from '../utils/test-organizations';

const LIST_QUERY = `
  query ReferenceDocuments($pagination: PaginationArgs!, $filter: ReferenceDocumentFilterInput) {
    referenceDocuments(pagination: $pagination, filter: $filter) {
      items { id title equipmentModelId organizationName effectiveRevisionNo creatorNickname }
      total
      page
      pageSize
    }
  }
`;

const DETAIL_QUERY = `
  query ReferenceDocument($id: Int!) {
    referenceDocument(id: $id) {
      id title contentText contentSource effectiveRevisionNo hasFile mimeType originalFilename
      organizationName viewerIsOriginalAuthor
    }
  }
`;

const REVISIONS_QUERY = `
  query ReferenceDocumentRevisions($id: Int!) {
    referenceDocumentRevisions(id: $id) {
      documentId currentRevisionNo sourceKind revisions { revisionNo reason actorNickname createdAt }
    }
  }
`;

const REVISE_MUTATION = `
  mutation ReviseReferenceDocument($id: Int!, $input: ReviseReferenceDocumentInput!) {
    reviseReferenceDocument(id: $id, input: $input) { id revisionNo }
  }
`;

const OFFLINE_MUTATION = `
  mutation OfflineReferenceDocument($id: Int!, $input: OfflineReferenceDocumentInput!) {
    offlineReferenceDocument(id: $id, input: $input) { id revisionNo }
  }
`;

const ADMIN_DELETE_MUTATION = `
  mutation AdminDeleteReferenceDocument($id: Int!, $input: AdminDeleteReferenceDocumentInput!) {
    adminDeleteReferenceDocument(id: $id, input: $input) { id revisionNo }
  }
`;

const CORRECT_OWNERSHIP_MUTATION = `
  mutation CorrectReferenceDocumentOwnership($id: Int!, $input: CorrectReferenceDocumentOwnershipInput!) {
    correctReferenceDocumentOwnership(id: $id, input: $input) { id revisionNo }
  }
`;

const SOFT_DELETE_MUTATION = `
  mutation SoftDeleteReferenceDocument($id: Int!, $expectedVersion: Int!) {
    softDeleteReferenceDocument(id: $id, expectedVersion: $expectedVersion) { id }
  }
`;

// 已下线入口：只用内联字面量断言 schema 不再接受（不引用已移除的输入类型，
// 否则会先触发「未知类型」错误，掩盖字段移除这一真实信号）
const REMOVED_CREATE_MUTATION = `
  mutation {
    createReferenceDocument(input: { title: "E2E 复活检查", documentType: MANUAL }) { id }
  }
`;

const REMOVED_UPDATE_MUTATION = `
  mutation {
    updateReferenceDocument(id: 1, input: { title: "E2E 复活编辑" }) { id }
  }
`;

// 运行级临时存储目录：先于 beforeAll 设置 env，使 config 加载时读到本规格专属目录
const originalStorageDir = captureEnvValue('REFERENCE_DOCUMENT_STORAGE_DIR');
const e2eStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refdoc-e2e-storage-'));
process.env.REFERENCE_DOCUMENT_STORAGE_DIR = e2eStorageRoot;

describe('AI 参考资料库 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let modelRepository: Repository<EquipmentModelEntity>;
  let adminToken: string;
  let engineerToken: string;
  let staffPrimaryToken: string;
  let customerToken: string;
  let peerEngineerToken: string;
  let peerAdminToken: string;
  let noOrgEngineerToken: string;
  let adminAccountId: number;
  let engineerAccountId: number;
  let peerAdminAccountId: number;

  const suiteOrganizationCodes = buildSuiteOrganizationCodes('REFDOC');
  let primaryOrganizationId = 0;
  let peerOrganizationId = 0;
  let referenceModelId = 0;
  const ownership = createOwnedResourceLedger();

  const PAGE = { mode: 'OFFSET', page: 1, pageSize: 20 };

  // —— 读侧夹具（只读用例共享，行状态不在用例中改变） ——
  let primaryTextDocumentId = 0;
  let genericDocumentId = 0;
  let offlineDocumentId = 0;
  let deletedDocumentId = 0;
  let peerDocumentId = 0;
  let percentTitleDocumentId = 0;
  let fileDocumentId = 0;
  const fixtureFileName = `${'a'.repeat(32)}.pdf`;

  const expectUnauthenticated = (error: unknown): void => {
    const err = error as { message: string; extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('UNAUTHENTICATED');
    expect(err.extensions.errorCode).toBe('JWT_AUTHENTICATION_FAILED');
  };

  const expectForbidden = (error: unknown, requiredRoles: string[], userRoles: string[]): void => {
    const err = error as { message: string; extensions: Record<string, unknown> };
    expect(err.message).toContain('缺少所需角色');
    expect(err.extensions.code).toBe('FORBIDDEN');
    expect(err.extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
    expect(err.extensions.details).toMatchObject({ requiredRoles, userRoles });
  };

  const createDocument = async (
    overrides: {
      title?: string;
      documentType?: string;
      contentText?: string | null;
      createdByAccountId?: number;
      ownerOrganizationId?: number | null;
      equipmentModelId?: number | null;
      publicationStatus?: 'ONLINE' | 'OFFLINE';
      storageReference?: string | null;
      originalFilename?: string | null;
      mimeType?: string | null;
    } = {},
  ): Promise<number> => {
    const saved = await seedReferenceDocumentFixture({
      dataSource,
      ownership,
      fixture: {
        title: overrides.title ?? 'E2E 夹具资料',
        documentType: overrides.documentType ?? 'MANUAL',
        createdByAccountId: overrides.createdByAccountId ?? adminAccountId,
        ownerOrganizationId:
          overrides.ownerOrganizationId === undefined
            ? primaryOrganizationId
            : overrides.ownerOrganizationId,
        contentText: overrides.contentText === undefined ? '夹具正文' : overrides.contentText,
        equipmentModelId: overrides.equipmentModelId ?? null,
        publicationStatus: overrides.publicationStatus,
        storageBackend: overrides.storageReference === undefined ? null : 'LOCAL',
        storageReference: overrides.storageReference ?? null,
        originalFilename: overrides.originalFilename ?? null,
        mimeType: overrides.mimeType ?? null,
      },
    });
    return saved.id;
  };

  const listIds = async (
    token: string,
    filter?: unknown,
  ): Promise<{ ids: number[]; total: number }> => {
    const response = await postGql({
      app,
      query: LIST_QUERY,
      variables: { pagination: { ...PAGE, pageSize: 100, withTotal: true }, filter },
      token,
    }).expect(200);
    expect(response.body.errors).toBeUndefined();
    const page = response.body.data.referenceDocuments as {
      items: Array<{ id: number }>;
      total: number;
    };
    return { ids: page.items.map((item) => item.id), total: page.total };
  };

  /**
   * 期望顺序直接取自同一读模型排序（创建时间倒序 + 主键倒序），不硬编码种子顺序。
   * 以本规格标题前缀圈定范围，避免把库内其他来源的残留行算进期望（清理仍按台账执行）。
   */
  const expectedVisibleOrder = async (organizationId: number | null): Promise<number[]> => {
    const rows = await dataSource.query<Array<{ id: number | string }>>(
      organizationId === null
        ? `SELECT id FROM reference_document
            WHERE deprecated = 0 AND publication_status = 'ONLINE' AND ownership_status = 'CONFIRMED'
              AND title LIKE '%E2E%'
            ORDER BY created_at DESC, id DESC`
        : `SELECT id FROM reference_document
            WHERE deprecated = 0 AND publication_status = 'ONLINE' AND ownership_status = 'CONFIRMED'
              AND owner_organization_id = ? AND title LIKE '%E2E%'
            ORDER BY created_at DESC, id DESC`,
      organizationId === null ? [] : [organizationId],
    );
    return rows.map((row) => Number(row.id));
  };

  /**
   * 旧写入口已从 GraphQL schema 移除：请求在协议校验阶段失败，
   * 不进入守卫与用例，也不产生任何写入。
   */
  const expectOperationRemoved = async (params: {
    query: string;
    field: string;
    token?: string;
  }): Promise<void> => {
    const response = await postGql({
      app,
      query: params.query,
      token: params.token,
    });
    expect(response.body.data).toBeUndefined();
    const messages = (response.body.errors as Array<{ message: string }>).map(
      (item) => item.message,
    );
    expect(
      messages.some((message) => message.includes(`Cannot query field "${params.field}"`)),
    ).toBe(true);
    // 内联字面量不应引入「未知类型」噪声：失败原因必须是字段已移除
    expect(messages.join('\n')).not.toContain('Unknown type');
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    modelRepository = dataSource.getRepository(EquipmentModelEntity);

    await app.init();

    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: [
          {
            organizationCode: suiteOrganizationCodes.primary,
            name: 'E2E 甲方组织（参考资料）',
            kind: 'CLIENT',
          },
          {
            organizationCode: suiteOrganizationCodes.peer,
            name: 'E2E 同行组织（参考资料）',
            kind: 'PEER',
          },
        ],
        accounts: [
          testAccountsConfig.staff,
          testAccountsConfig.staffPrimary,
          testAccountsConfig.staffSecondary,
          testAccountsConfig.guestPrimary,
          testAccountsConfig.admin,
          testAccountsConfig.peerAdmin,
          testAccountsConfig.noOrgEngineer,
          testAccountsConfig.ambiguousEngineer,
        ].map(toResidueAccountFingerprint),
        equipmentModels: [
          {
            modelCode: 'E2E-REF',
            modelName: '资料库链路型号',
            enabled: true,
            sortOrder: 1,
          },
        ],
      },
      helper: 'reference-document.e2e-spec beforeAll 预清理',
    });

    await seedTestAccounts({
      dataSource,
      createAccountUsecase: app.get(CreateAccountUsecase),
      includeKeys: [
        'staff',
        'staffPrimary',
        'staffSecondary',
        'guestPrimary',
        'admin',
        'peerAdmin',
        'noOrgEngineer',
        'ambiguousEngineer',
      ],
      ownership,
    });

    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: 'E2E 甲方组织（参考资料）',
          kind: 'CLIENT',
        },
        {
          organizationCode: suiteOrganizationCodes.peer,
          name: 'E2E 同行组织（参考资料）',
          kind: 'PEER',
        },
      ],
      ownership,
    });
    primaryOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
    peerOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.peer);

    await seedTestMemberships({
      dataSource,
      organizationIdsByCode: organizationIds,
      ownership,
      memberships: [
        {
          accountLoginName: testAccountsConfig.admin.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: testAccountsConfig.staff.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: testAccountsConfig.staffPrimary.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: testAccountsConfig.staffSecondary.loginName,
          organizationCode: suiteOrganizationCodes.peer,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: testAccountsConfig.peerAdmin.loginName,
          organizationCode: suiteOrganizationCodes.peer,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: testAccountsConfig.ambiguousEngineer.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'ENGINEER',
        },
      ],
    });

    adminAccountId = await getAccountIdByLoginName(dataSource, testAccountsConfig.admin.loginName);
    engineerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staff.loginName,
    );
    peerAdminAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.peerAdmin.loginName,
    );

    // 等级事实取请求期查库（`base_user_account.admin_level`），不信任 JWT 静态等级：
    // 一级管理员放行全范围与管理动作；二级管理员只读本公司、管理动作一律拒绝。
    await dataSource.query('UPDATE base_user_account SET admin_level = 1 WHERE id = ?', [
      adminAccountId,
    ]);
    await dataSource.query('UPDATE base_user_account SET admin_level = 2 WHERE id = ?', [
      peerAdminAccountId,
    ]);

    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    engineerToken = await login({
      app,
      loginName: testAccountsConfig.staff.loginName,
      loginPassword: testAccountsConfig.staff.loginPassword,
    });
    staffPrimaryToken = await login({
      app,
      loginName: testAccountsConfig.staffPrimary.loginName,
      loginPassword: testAccountsConfig.staffPrimary.loginPassword,
    });
    customerToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
    peerEngineerToken = await login({
      app,
      loginName: testAccountsConfig.staffSecondary.loginName,
      loginPassword: testAccountsConfig.staffSecondary.loginPassword,
    });
    peerAdminToken = await login({
      app,
      loginName: testAccountsConfig.peerAdmin.loginName,
      loginPassword: testAccountsConfig.peerAdmin.loginPassword,
    });
    noOrgEngineerToken = await login({
      app,
      loginName: testAccountsConfig.noOrgEngineer.loginName,
      loginPassword: testAccountsConfig.noOrgEngineer.loginPassword,
    });

    const savedModel = await modelRepository.save(
      modelRepository.create({
        modelCode: 'E2E-REF',
        modelName: '资料库链路型号',
        enabled: true,
        sortOrder: 1,
      }),
    );
    referenceModelId = savedModel.id;
    recordOwnedResource(ownership, 'equipmentModel', referenceModelId, {
      modelCode: 'E2E-REF',
      modelName: '资料库链路型号',
      enabled: true,
      sortOrder: 1,
    });

    // 读侧夹具：指定型号文本资料 / 通用资料 / 已下架 / 已软删 / 第二组织 /
    // 含 LIKE 通配符标题 / 带物理原件（本规格临时存储目录内真实字节）
    primaryTextDocumentId = await createDocument({
      title: 'E2E 错误码手册',
      documentType: 'ERROR_CODE_MANUAL',
      contentText: 'E-CHUCK-101',
      equipmentModelId: referenceModelId,
    });
    genericDocumentId = await createDocument({
      title: 'E2E 通用安全规范',
      documentType: 'SAFETY_SPEC',
      contentText: '通用内容',
    });
    offlineDocumentId = await createDocument({
      title: 'E2E 已下架检查表',
      documentType: 'CHECKLIST',
      contentText: '下架前正文',
      publicationStatus: 'OFFLINE',
    });
    const deleted = await seedReferenceDocumentFixture({
      dataSource,
      ownership,
      fixture: {
        title: 'E2E 已软删资料',
        documentType: 'CHECKLIST',
        createdByAccountId: adminAccountId,
        ownerOrganizationId: primaryOrganizationId,
        contentText: '旧版内容',
        deprecated: true,
        deletedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    deletedDocumentId = deleted.id;
    peerDocumentId = await createDocument({
      title: 'E2E 同行组织资料',
      documentType: 'MANUAL',
      contentText: 'PEER-ONLY',
      createdByAccountId: peerAdminAccountId,
      ownerOrganizationId: peerOrganizationId,
    });
    percentTitleDocumentId = await createDocument({
      title: 'E2E 搜索 100% 命中_行',
      documentType: 'CHECKLIST',
      contentText: '通配符转义链路验证',
    });
    // 带原件资料：存储四列在插入时即给出（V13 CHECK 要求 MATERIAL 正文或存储引用非空）
    fileDocumentId = await createDocument({
      title: 'E2E 带原件资料',
      documentType: 'MANUAL',
      contentText: 'E-CHUCK-101',
      equipmentModelId: referenceModelId,
      storageReference: fixtureFileName,
      originalFilename: 'E2E 手册.pdf',
      mimeType: 'application/pdf',
    });
    fs.writeFileSync(path.join(e2eStorageRoot, fixtureFileName), Buffer.from('e2e-pdf-content'));
  }, 30000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (dataSource?.isInitialized) {
          await runGuardedSpecCleanup({
            dataSource,
            owned: ownership,
            helper: 'reference-document.e2e-spec afterAll 收尾',
          });
        }
      },
      finalize: () => {
        fs.rmSync(e2eStorageRoot, { recursive: true, force: true });
        restoreEnvValue('REFERENCE_DOCUMENT_STORAGE_DIR', originalStorageDir);
      },
      closeApp: app
        ? async () => {
            await app.close();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        : null,
    });
  });

  describe('旧写入口已下线（不重新开放、不为造数保留）', () => {
    it('createReferenceDocument / updateReferenceDocument 已从 schema 移除', async () => {
      await expectOperationRemoved({
        query: REMOVED_CREATE_MUTATION,
        field: 'createReferenceDocument',
        token: adminToken,
      });
      await expectOperationRemoved({
        query: REMOVED_UPDATE_MUTATION,
        field: 'updateReferenceDocument',
        token: adminToken,
      });

      // 未产生任何写入：标题与正文保持夹具值
      const facts = await readReferenceDocumentFacts({
        dataSource,
        documentId: primaryTextDocumentId,
      });
      expect(facts?.title).toBe('E2E 错误码手册');
      expect(facts?.content_text).toBe('E-CHUCK-101');
    });

    it('REST multipart 上传端点已下线（404，无路由可直调）', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/reference-documents/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', Buffer.from('x'), 'e2e-reopen.pdf')
        .field('title', 'E2E 复活上传')
        .field('documentType', 'MANUAL');
      expect(response.status).toBe(404);
      const rows = await dataSource.query<Array<{ total: number }>>(
        `SELECT COUNT(*) AS total FROM reference_document WHERE title = ?`,
        ['E2E 复活上传'],
      );
      expect(Number(rows[0]?.total)).toBe(0);
    });
  });

  describe('未登录（无 Token）', () => {
    it('读侧与新写侧全部 UNAUTHENTICATED', async () => {
      const cases = [
        { query: LIST_QUERY, variables: { pagination: PAGE } },
        { query: DETAIL_QUERY, variables: { id: primaryTextDocumentId } },
        { query: REVISIONS_QUERY, variables: { id: primaryTextDocumentId } },
        {
          query: REVISE_MUTATION,
          variables: { id: primaryTextDocumentId, input: { expectedVersion: 0, reason: 'x' } },
        },
        {
          query: OFFLINE_MUTATION,
          variables: { id: primaryTextDocumentId, input: { expectedVersion: 0, reason: 'x' } },
        },
        {
          query: ADMIN_DELETE_MUTATION,
          variables: { id: primaryTextDocumentId, input: { expectedVersion: 0, reason: 'x' } },
        },
        {
          query: CORRECT_OWNERSHIP_MUTATION,
          variables: {
            id: primaryTextDocumentId,
            input: { expectedVersion: 0, verificationReason: 'x', ownerOrganizationId: 1 },
          },
        },
        {
          query: SOFT_DELETE_MUTATION,
          variables: { id: primaryTextDocumentId, expectedVersion: 0 },
        },
      ];
      for (const item of cases) {
        const response = await postGql({ app, ...item }).expect(200);
        expect(response.body.errors).toHaveLength(1);
        expectUnauthenticated(response.body.errors[0]);
      }
    });
  });

  describe('CUSTOMER 不参与资料库', () => {
    it('列表 / 详情 FORBIDDEN，管理动作同样被守卫拒绝', async () => {
      const listResponse = await postGql({
        app,
        query: LIST_QUERY,
        variables: { pagination: PAGE },
        token: customerToken,
      }).expect(200);
      expectForbidden(listResponse.body.errors[0], ['ENGINEER', 'SUPER_ADMIN'], ['CUSTOMER']);

      const detailResponse = await postGql({
        app,
        query: DETAIL_QUERY,
        variables: { id: primaryTextDocumentId },
        token: customerToken,
      }).expect(200);
      expectForbidden(detailResponse.body.errors[0], ['ENGINEER', 'SUPER_ADMIN'], ['CUSTOMER']);

      const deleteResponse = await postGql({
        app,
        query: ADMIN_DELETE_MUTATION,
        variables: { id: primaryTextDocumentId, input: { expectedVersion: 0, reason: 'x' } },
        token: customerToken,
      }).expect(200);
      expectForbidden(deleteResponse.body.errors[0], ['SUPER_ADMIN'], ['CUSTOMER']);
    });
  });

  describe('ENGINEER 读侧（本公司范围）', () => {
    it('列表只含本公司可见资料：软删/下架/归属待核实/跨公司均不出现', async () => {
      const expected = await expectedVisibleOrder(primaryOrganizationId);
      const result = await listIds(engineerToken, { title: 'E2E' });
      expect(result.ids).toEqual(expected);
      expect(result.total).toBe(expected.length);
      expect(result.ids).toEqual(
        expect.arrayContaining([primaryTextDocumentId, genericDocumentId]),
      );
      expect(result.ids).not.toContain(deletedDocumentId);
      expect(result.ids).not.toContain(offlineDocumentId);
      expect(result.ids).not.toContain(peerDocumentId);
    });

    it('同组织两工程师列表一致', async () => {
      const first = await listIds(engineerToken, { title: 'E2E' });
      const second = await listIds(staffPrimaryToken, { title: 'E2E' });
      expect(second.ids).toEqual(first.ids);
      expect(second.total).toBe(first.total);
    });

    it('详情：正文与元数据可读；作者标识只对本人为真', async () => {
      const response = await postGql({
        app,
        query: DETAIL_QUERY,
        variables: { id: primaryTextDocumentId },
        token: engineerToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.referenceDocument).toMatchObject({
        id: primaryTextDocumentId,
        title: 'E2E 错误码手册',
        contentText: 'E-CHUCK-101',
        contentSource: 'ORIGINAL',
        effectiveRevisionNo: 0,
        // 同组织资料以原组织展示名返回
        organizationName: 'E2E 甲方组织（参考资料）',
        viewerIsOriginalAuthor: false,
      });

      const ownDocumentId = await createDocument({
        title: 'E2E 工程师本人资料',
        contentText: '本人正文',
        createdByAccountId: engineerAccountId,
      });
      const ownResponse = await postGql({
        app,
        query: DETAIL_QUERY,
        variables: { id: ownDocumentId },
        token: engineerToken,
      }).expect(200);
      expect(ownResponse.body.data.referenceDocument.viewerIsOriginalAuthor).toBe(true);
    });

    it('已软删 / 已下架 / 跨公司详情统一 NOT_FOUND（不泄露状态与存在性）', async () => {
      for (const id of [deletedDocumentId, offlineDocumentId, peerDocumentId, 999999]) {
        const response = await postGql({
          app,
          query: DETAIL_QUERY,
          variables: { id },
          token: engineerToken,
        }).expect(200);
        const err = response.body.errors[0] as { extensions: Record<string, unknown> };
        expect(err.extensions.code).toBe('NOT_FOUND');
        expect(err.extensions.errorCode).toBe('REFERENCE_DOCUMENT_NOT_FOUND');
      }
    });

    it('历史版本：与详情共用可见范围；无修订时返回空列表', async () => {
      const response = await postGql({
        app,
        query: REVISIONS_QUERY,
        variables: { id: primaryTextDocumentId },
        token: engineerToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.referenceDocumentRevisions).toMatchObject({
        documentId: primaryTextDocumentId,
        currentRevisionNo: 0,
        sourceKind: 'MATERIAL',
        revisions: [],
      });

      const offlineResponse = await postGql({
        app,
        query: REVISIONS_QUERY,
        variables: { id: offlineDocumentId },
        token: engineerToken,
      }).expect(200);
      expect(offlineResponse.body.errors[0].extensions.errorCode).toBe(
        'REFERENCE_DOCUMENT_NOT_FOUND',
      );
    });

    it('管理动作与作者删除：工程师无管理权限（守卫拒绝）', async () => {
      for (const item of [
        {
          query: REVISE_MUTATION,
          variables: { id: primaryTextDocumentId, input: { expectedVersion: 0, reason: 'x' } },
        },
        {
          query: OFFLINE_MUTATION,
          variables: { id: primaryTextDocumentId, input: { expectedVersion: 0, reason: 'x' } },
        },
        {
          query: ADMIN_DELETE_MUTATION,
          variables: { id: primaryTextDocumentId, input: { expectedVersion: 0, reason: 'x' } },
        },
        {
          query: CORRECT_OWNERSHIP_MUTATION,
          variables: {
            id: primaryTextDocumentId,
            input: { expectedVersion: 0, verificationReason: 'x', ownerOrganizationId: 1 },
          },
        },
      ]) {
        const response = await postGql({ app, ...item, token: engineerToken }).expect(200);
        expectForbidden(response.body.errors[0], ['SUPER_ADMIN'], ['ENGINEER']);
      }
    });
  });

  describe('组织范围解析与库级约束', () => {
    it('第二组织工程师只见本组织资料；跨组织详情 NOT_FOUND', async () => {
      const expected = await expectedVisibleOrder(peerOrganizationId);
      const result = await listIds(peerEngineerToken, { title: 'E2E' });
      expect(result.ids).toEqual(expected);
      expect(result.ids).toContain(peerDocumentId);
      expect(result.ids).not.toContain(primaryTextDocumentId);
    });

    it('无有效成员关系：列表 FORBIDDEN + ORGANIZATION_NO_ACTIVE_MEMBERSHIP（不泄露成员数量）', async () => {
      const response = await postGql({
        app,
        query: LIST_QUERY,
        variables: { pagination: PAGE },
        token: noOrgEngineerToken,
      }).expect(200);
      expect(response.body.errors).toHaveLength(1);
      const err = response.body.errors[0] as { extensions: Record<string, unknown> };
      expect(err.extensions.code).toBe('FORBIDDEN');
      expect(err.extensions.errorCode).toBe('ORGANIZATION_NO_ACTIVE_MEMBERSHIP');
      expect(err.extensions.details).toBeUndefined();
    });

    it('同账号重复 ACTIVE 组织归属：库唯一键拒绝（事务回滚，无残留）', async () => {
      const ambiguousAccountId = await getAccountIdByLoginName(
        dataSource,
        testAccountsConfig.ambiguousEngineer.loginName,
      );
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await expect(
          runner.query(
            `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
             VALUES (?, ?, 'ENGINEER', 'ACTIVE')`,
            [peerOrganizationId, ambiguousAccountId],
          ),
        ).rejects.toMatchObject({
          code: 'ER_DUP_ENTRY',
          sqlMessage: expect.stringContaining('uk_organization_membership_active_account'),
        });
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }

      const activeRows = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM organization_membership
         WHERE account_id = ? AND status = 'ACTIVE'`,
        [ambiguousAccountId],
      );
      expect(Number(activeRows[0]?.total)).toBe(1);
    });
  });

  describe('二级管理员：只读本公司，管理动作被拒（非资源不可见）', () => {
    it('列表为第二组织范围', async () => {
      const expected = await expectedVisibleOrder(peerOrganizationId);
      const result = await listIds(peerAdminToken, { title: 'E2E' });
      expect(result.ids).toEqual(expected);
    });

    it('二级管理员直接读取他司详情/历史版本：统一 NOT_FOUND（不泄露状态与存在性）', async () => {
      for (const item of [
        { query: DETAIL_QUERY, variables: { id: primaryTextDocumentId } },
        { query: REVISIONS_QUERY, variables: { id: primaryTextDocumentId } },
      ]) {
        const response = await postGql({ app, ...item, token: peerAdminToken }).expect(200);
        const err = response.body.errors[0] as { extensions: Record<string, unknown> };
        expect(err.extensions.code).toBe('NOT_FOUND');
        expect(err.extensions.errorCode).toBe('REFERENCE_DOCUMENT_NOT_FOUND');
      }
    });

    it('四个管理动作 INSUFFICIENT_PERMISSIONS（等级 2 失败关闭）', async () => {
      const documentId = await createDocument({
        title: 'E2E 二级管理员目标',
        createdByAccountId: peerAdminAccountId,
        ownerOrganizationId: peerOrganizationId,
        contentText: '二级目标正文',
      });
      for (const item of [
        {
          query: REVISE_MUTATION,
          variables: { id: documentId, input: { expectedVersion: 0, reason: '越级尝试' } },
        },
        {
          query: OFFLINE_MUTATION,
          variables: { id: documentId, input: { expectedVersion: 0, reason: '越级尝试' } },
        },
        {
          query: ADMIN_DELETE_MUTATION,
          variables: { id: documentId, input: { expectedVersion: 0, reason: '越级尝试' } },
        },
        {
          query: CORRECT_OWNERSHIP_MUTATION,
          variables: {
            id: documentId,
            input: {
              expectedVersion: 0,
              verificationReason: '越级尝试',
              ownerOrganizationId: peerOrganizationId,
            },
          },
        },
      ]) {
        const response = await postGql({ app, ...item, token: peerAdminToken }).expect(200);
        const err = response.body.errors[0] as { extensions: Record<string, unknown> };
        expect(err.extensions.code).toBe('FORBIDDEN');
        expect(err.extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
      }
    });
  });

  describe('一级管理员：列表全范围（已确认归属的正式资料）', () => {
    it('列表含甲乙两公司资料，仍排除软删/下架/归属待核实', async () => {
      const expected = await expectedVisibleOrder(null);
      const result = await listIds(adminToken, { title: 'E2E' });
      expect(result.ids).toEqual(expected);
      expect(result.ids).toContain(primaryTextDocumentId);
      expect(result.ids).toContain(peerDocumentId);
      expect(result.ids).not.toContain(offlineDocumentId);
      expect(result.ids).not.toContain(deletedDocumentId);
    });
  });

  describe('R058 管理修订（版本 + 正文生效 + 历史）', () => {
    it('令牌 0 修订成功：新版本 1、标题与正文生效、历史可追溯', async () => {
      const documentId = await createDocument({
        title: 'E2E 待修订资料',
        contentText: '原始正文',
      });

      const response = await postGql({
        app,
        query: REVISE_MUTATION,
        variables: {
          id: documentId,
          input: {
            expectedVersion: 0,
            reason: '补充校准判据',
            title: 'E2E 待修订资料（已修订）',
            contentText: '修订后正文',
          },
        },
        token: adminToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.reviseReferenceDocument).toEqual({
        id: documentId,
        revisionNo: 1,
      });

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts).toMatchObject({
        title: 'E2E 待修订资料（已修订）',
        content_text: '修订后正文',
        current_revision_no: 1,
        publication_status: 'ONLINE',
      });
      expect(await registerReferenceDocumentRevisions({ dataSource, ownership, documentId })).toBe(
        1,
      );

      const detailResponse = await postGql({
        app,
        query: DETAIL_QUERY,
        variables: { id: documentId },
        token: engineerToken,
      }).expect(200);
      expect(detailResponse.body.data.referenceDocument).toMatchObject({
        contentSource: 'CURRENT_REVISION',
        effectiveRevisionNo: 1,
        contentText: '修订后正文',
        title: 'E2E 待修订资料（已修订）',
      });

      const revisionsResponse = await postGql({
        app,
        query: REVISIONS_QUERY,
        variables: { id: documentId },
        token: engineerToken,
      }).expect(200);
      const revisions = revisionsResponse.body.data.referenceDocumentRevisions as {
        currentRevisionNo: number;
        revisions: Array<{ revisionNo: number; reason: string; actorNickname: string }>;
      };
      expect(revisions.currentRevisionNo).toBe(1);
      expect(revisions.revisions).toEqual([
        expect.objectContaining({
          revisionNo: 1,
          reason: '补充校准判据',
          actorNickname: 'testadmin_nickname',
        }),
      ]);
    });

    it('过期 expected_version 拒绝（CONFLICT），库内版本与正文不变', async () => {
      const documentId = await createDocument({
        title: 'E2E 版本竞争资料',
        contentText: '初始正文',
      });

      const first = await postGql({
        app,
        query: REVISE_MUTATION,
        variables: {
          id: documentId,
          input: { expectedVersion: 0, reason: '第一次修订', contentText: '第一次正文' },
        },
        token: adminToken,
      }).expect(200);
      expect(first.body.data.reviseReferenceDocument.revisionNo).toBe(1);
      await registerReferenceDocumentRevisions({ dataSource, ownership, documentId });

      const stale = await postGql({
        app,
        query: REVISE_MUTATION,
        variables: {
          id: documentId,
          input: { expectedVersion: 0, reason: '过期修订', contentText: '覆盖尝试' },
        },
        token: adminToken,
      }).expect(200);
      const err = stale.body.errors[0] as { extensions: Record<string, unknown> };
      expect(err.extensions.code).toBe('CONFLICT');
      expect(err.extensions.errorCode).toBe('REFERENCE_DOCUMENT_VERSION_CONFLICT');

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts?.current_revision_no).toBe(1);
      expect(facts?.content_text).toBe('第一次正文');
    });

    it('负数 expected_version 在协议层拒绝（BAD_USER_INPUT），不进入用例', async () => {
      const documentId = await createDocument({ title: 'E2E 负数版本资料' });
      const response = await postGql({
        app,
        query: REVISE_MUTATION,
        variables: { id: documentId, input: { expectedVersion: -1, reason: '负数令牌' } },
        token: adminToken,
      }).expect(200);
      const err = response.body.errors[0] as {
        message: string;
        extensions: Record<string, unknown>;
      };
      expect(err.extensions.code).toBe('BAD_USER_INPUT');
      expect(err.message).toContain('不能为负数');

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts?.current_revision_no).toBe(0);
    });

    it('下架 / 归属待核实目标不可经修订入口访问（NOT_FOUND）', async () => {
      const offlineTarget = await createDocument({
        title: 'E2E 修订下架目标',
        publicationStatus: 'OFFLINE',
      });
      const pendingTarget = await createDocument({
        title: 'E2E 修订待核实目标',
        ownerOrganizationId: null,
      });
      for (const id of [offlineTarget, pendingTarget]) {
        const response = await postGql({
          app,
          query: REVISE_MUTATION,
          // 补丁需含至少一个可编辑字段（入口校验先于可见性检查），
          // 让请求穿过用例入参校验、命中统一 NOT_FOUND 可见谓词
          variables: {
            id,
            input: { expectedVersion: 0, reason: '不可见目标', title: '不可见目标' },
          },
          token: adminToken,
        }).expect(200);
        expect(response.body.errors[0].extensions.errorCode).toBe('REFERENCE_DOCUMENT_NOT_FOUND');
      }
    });
  });

  describe('R059 下架 → R060 管理删除（状态与审计）', () => {
    it('下架写业务历史但不下架正文：列表与详情立即不可见，不写关键审计', async () => {
      const documentId = await createDocument({
        title: 'E2E 待下架资料',
        contentText: '下架前正文',
      });

      const response = await postGql({
        app,
        query: OFFLINE_MUTATION,
        variables: { id: documentId, input: { expectedVersion: 0, reason: '内容待复核' } },
        token: adminToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.offlineReferenceDocument).toEqual({
        id: documentId,
        revisionNo: 1,
      });

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts).toMatchObject({ publication_status: 'OFFLINE', current_revision_no: 1 });
      expect(facts?.deleted_at).toBeNull();
      expect(await registerReferenceDocumentRevisions({ dataSource, ownership, documentId })).toBe(
        1,
      );

      const list = await listIds(adminToken);
      expect(list.ids).not.toContain(documentId);

      const detail = await postGql({
        app,
        query: DETAIL_QUERY,
        variables: { id: documentId },
        token: adminToken,
      }).expect(200);
      expect(detail.body.errors[0].extensions.errorCode).toBe('REFERENCE_DOCUMENT_NOT_FOUND');

      // R059 不写三类关键操作记录：审计表里没有该资料行
      const auditRows = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM management_audit_event
          WHERE target_type = 'REFERENCE_DOCUMENT' AND target_id = ?`,
        [String(documentId)],
      );
      expect(Number(auditRows[0]?.total)).toBe(0);
    });

    it('管理删除：软删 + 关键审计同事务；下架资料仍可删', async () => {
      const documentId = await createDocument({
        title: 'E2E 待管理删除资料',
        contentText: '删除前正文',
      });

      // 先下架（版本 0 → 1），再以版本 1 管理删除
      await postGql({
        app,
        query: OFFLINE_MUTATION,
        variables: { id: documentId, input: { expectedVersion: 0, reason: '先下架' } },
        token: adminToken,
      }).expect(200);
      await registerReferenceDocumentRevisions({ dataSource, ownership, documentId });

      const response = await postGql({
        app,
        query: ADMIN_DELETE_MUTATION,
        variables: { id: documentId, input: { expectedVersion: 1, reason: '来源已确认作废' } },
        token: adminToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.adminDeleteReferenceDocument).toEqual({
        id: documentId,
        revisionNo: 2,
      });

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts).toMatchObject({
        deprecated: 1,
        publication_status: 'OFFLINE',
        current_revision_no: 2,
      });
      expect(facts?.deleted_at).not.toBeNull();
      expect(await registerReferenceDocumentRevisions({ dataSource, ownership, documentId })).toBe(
        2,
      );
      expect(
        await registerReferenceDocumentAuditEvents({ dataSource, ownership, documentId }),
      ).toBe(1);

      const auditRows = await dataSource.query<
        Array<{ operation: string; actor_admin_level: number; result: string; detail: string }>
      >(
        `SELECT operation, actor_admin_level, result, detail FROM management_audit_event
          WHERE target_type = 'REFERENCE_DOCUMENT' AND target_id = ?`,
        [String(documentId)],
      );
      expect(auditRows[0]).toMatchObject({
        operation: 'ADMIN_DELETE_DOCUMENT',
        actor_admin_level: 1,
        result: 'SUCCEEDED',
      });
      expect(auditRows[0]?.detail).toContain('来源已确认作废');
    });

    it('管理删除的过期版本拒绝（CONFLICT），删除事实不落库', async () => {
      const documentId = await createDocument({ title: 'E2E 删除版本竞争资料' });
      const response = await postGql({
        app,
        query: ADMIN_DELETE_MUTATION,
        variables: { id: documentId, input: { expectedVersion: 5, reason: '过期删除' } },
        token: adminToken,
      }).expect(200);
      const err = response.body.errors[0] as { extensions: Record<string, unknown> };
      expect(err.extensions.errorCode).toBe('REFERENCE_DOCUMENT_VERSION_CONFLICT');

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts?.deprecated).toBe(0);
      expect(facts?.deleted_at).toBeNull();
    });
  });

  describe('R061-02 归属更正（只改显式字段 + 核实状态 + 审计）', () => {
    it('同时更正上传者与上传时公司：置 CONFIRMED 并写字段级审计', async () => {
      const documentId = await createDocument({
        title: 'E2E 归属待核实资料',
        ownerOrganizationId: null,
        contentText: '待核实正文',
      });
      const pendingFacts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(pendingFacts).toMatchObject({
        ownership_status: 'PENDING',
        owner_organization_id: null,
      });

      const response = await postGql({
        app,
        query: CORRECT_OWNERSHIP_MUTATION,
        variables: {
          id: documentId,
          input: {
            expectedVersion: 0,
            verificationReason: '核对原始工单后确认',
            createdByAccountId: engineerAccountId,
            ownerOrganizationId: primaryOrganizationId,
          },
        },
        token: adminToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.correctReferenceDocumentOwnership).toEqual({
        id: documentId,
        revisionNo: 1,
      });

      // 受控变更成功后才更新台账预期（不在写入前预置期望值）
      updateOwnedExpectation(ownership, 'document', documentId, {
        ownerOrganizationId: primaryOrganizationId,
        createdByAccountId: engineerAccountId,
      });

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts).toMatchObject({
        ownership_status: 'CONFIRMED',
        owner_organization_id: primaryOrganizationId,
        created_by_account_id: engineerAccountId,
        content_text: '待核实正文',
        current_revision_no: 1,
      });
      expect(await registerReferenceDocumentRevisions({ dataSource, ownership, documentId })).toBe(
        1,
      );
      expect(
        await registerReferenceDocumentAuditEvents({ dataSource, ownership, documentId }),
      ).toBe(1);

      const auditRows = await dataSource.query<
        Array<{ operation: string; detail: string; organization_id: number }>
      >(
        `SELECT operation, detail, organization_id FROM management_audit_event
          WHERE target_type = 'REFERENCE_DOCUMENT' AND target_id = ?`,
        [String(documentId)],
      );
      expect(auditRows[0]?.operation).toBe('CORRECT_DOCUMENT_OWNERSHIP');
      expect(auditRows[0]?.organization_id).toBe(primaryOrganizationId);
      expect(auditRows[0]?.detail).toContain('createdByAccountId');

      // 归属确认后进入普通列表（本公司）
      const list = await listIds(engineerToken);
      expect(list.ids).toContain(documentId);
    });

    it('单项更正保留待核实状态（不因未核实项自动确认）', async () => {
      const uploaderOnly = await createDocument({
        title: 'E2E 只更正上传者',
        ownerOrganizationId: null,
      });
      const uploaderResponse = await postGql({
        app,
        query: CORRECT_OWNERSHIP_MUTATION,
        variables: {
          id: uploaderOnly,
          input: {
            expectedVersion: 0,
            verificationReason: '仅确认上传者',
            createdByAccountId: engineerAccountId,
          },
        },
        token: adminToken,
      }).expect(200);
      expect(uploaderResponse.body.errors).toBeUndefined();
      updateOwnedExpectation(ownership, 'document', uploaderOnly, {
        createdByAccountId: engineerAccountId,
      });
      const uploaderFacts = await readReferenceDocumentFacts({
        dataSource,
        documentId: uploaderOnly,
      });
      expect(uploaderFacts).toMatchObject({
        ownership_status: 'PENDING',
        owner_organization_id: null,
        created_by_account_id: engineerAccountId,
      });
      await registerReferenceDocumentRevisions({
        dataSource,
        ownership,
        documentId: uploaderOnly,
      });
      await registerReferenceDocumentAuditEvents({
        dataSource,
        ownership,
        documentId: uploaderOnly,
      });

      const organizationOnly = await createDocument({
        title: 'E2E 只更正公司',
        ownerOrganizationId: null,
      });
      const organizationResponse = await postGql({
        app,
        query: CORRECT_OWNERSHIP_MUTATION,
        variables: {
          id: organizationOnly,
          input: {
            expectedVersion: 0,
            verificationReason: '仅确认公司',
            ownerOrganizationId: primaryOrganizationId,
          },
        },
        token: adminToken,
      }).expect(200);
      expect(organizationResponse.body.errors).toBeUndefined();
      updateOwnedExpectation(ownership, 'document', organizationOnly, {
        ownerOrganizationId: primaryOrganizationId,
      });
      const organizationFacts = await readReferenceDocumentFacts({
        dataSource,
        documentId: organizationOnly,
      });
      expect(organizationFacts).toMatchObject({
        ownership_status: 'PENDING',
        owner_organization_id: primaryOrganizationId,
      });
      await registerReferenceDocumentRevisions({
        dataSource,
        ownership,
        documentId: organizationOnly,
      });
      await registerReferenceDocumentAuditEvents({
        dataSource,
        ownership,
        documentId: organizationOnly,
      });
    });

    it('未提交任何更正字段 → REFERENCE_DOCUMENT_INVALID_PARAMS', async () => {
      const documentId = await createDocument({
        title: 'E2E 空更正资料',
        ownerOrganizationId: null,
      });
      const response = await postGql({
        app,
        query: CORRECT_OWNERSHIP_MUTATION,
        variables: {
          id: documentId,
          input: { expectedVersion: 0, verificationReason: '未提交字段' },
        },
        token: adminToken,
      }).expect(200);
      const err = response.body.errors[0] as { extensions: Record<string, unknown> };
      expect(err.extensions.code).toBe('BAD_USER_INPUT');
      expect(err.extensions.errorCode).toBe('REFERENCE_DOCUMENT_INVALID_PARAMS');
    });
  });

  describe('R053 原作者删除（仅本人条目 + 版本核对 + 管理员补审计）', () => {
    it('工程师删除本人条目：软删 + OFFLOINE 事实落库，列表不再可见', async () => {
      const documentId = await createDocument({
        title: 'E2E 工程师本人待删资料',
        createdByAccountId: engineerAccountId,
      });

      const response = await postGql({
        app,
        query: SOFT_DELETE_MUTATION,
        variables: { id: documentId, expectedVersion: 0 },
        token: engineerToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.softDeleteReferenceDocument).toEqual({ id: documentId });

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts).toMatchObject({
        deprecated: 1,
        publication_status: 'OFFLINE',
        current_revision_no: 1,
      });
      expect(facts?.deleted_at).not.toBeNull();
      expect(await registerReferenceDocumentRevisions({ dataSource, ownership, documentId })).toBe(
        1,
      );

      const list = await listIds(engineerToken);
      expect(list.ids).not.toContain(documentId);

      // 普通工程师作者删除不写关键审计
      const auditRows = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM management_audit_event
          WHERE target_type = 'REFERENCE_DOCUMENT' AND target_id = ?`,
        [String(documentId)],
      );
      expect(Number(auditRows[0]?.total)).toBe(0);
    });

    it('删除他人条目统一 NOT_FOUND（不泄露存在性），库不变', async () => {
      const response = await postGql({
        app,
        query: SOFT_DELETE_MUTATION,
        variables: { id: primaryTextDocumentId, expectedVersion: 0 },
        token: engineerToken,
      }).expect(200);
      const err = response.body.errors[0] as { extensions: Record<string, unknown> };
      expect(err.extensions.code).toBe('NOT_FOUND');
      expect(err.extensions.errorCode).toBe('REFERENCE_DOCUMENT_NOT_FOUND');

      const facts = await readReferenceDocumentFacts({
        dataSource,
        documentId: primaryTextDocumentId,
      });
      expect(facts?.deprecated).toBe(0);
    });

    it('过期 expected_version 拒绝（CONFLICT）', async () => {
      const documentId = await createDocument({
        title: 'E2E 作者删除版本竞争资料',
        createdByAccountId: engineerAccountId,
      });
      const response = await postGql({
        app,
        query: SOFT_DELETE_MUTATION,
        variables: { id: documentId, expectedVersion: 3 },
        token: engineerToken,
      }).expect(200);
      expect(response.body.errors[0].extensions.errorCode).toBe(
        'REFERENCE_DOCUMENT_VERSION_CONFLICT',
      );

      const facts = await readReferenceDocumentFacts({ dataSource, documentId });
      expect(facts?.deprecated).toBe(0);
    });

    it('管理员以原作者身份删除本人条目：补写 ADMIN_DELETE_DOCUMENT 关键审计', async () => {
      const documentId = await createDocument({
        title: 'E2E 管理员本人待删资料',
        createdByAccountId: adminAccountId,
      });

      const response = await postGql({
        app,
        query: SOFT_DELETE_MUTATION,
        variables: { id: documentId, expectedVersion: 0 },
        token: adminToken,
      }).expect(200);
      expect(response.body.errors).toBeUndefined();
      await registerReferenceDocumentRevisions({ dataSource, ownership, documentId });
      expect(
        await registerReferenceDocumentAuditEvents({ dataSource, ownership, documentId }),
      ).toBe(1);

      const auditRows = await dataSource.query<
        Array<{ operation: string; actor_admin_level: number }>
      >(
        `SELECT operation, actor_admin_level FROM management_audit_event
          WHERE target_type = 'REFERENCE_DOCUMENT' AND target_id = ?`,
        [String(documentId)],
      );
      expect(auditRows[0]).toMatchObject({
        operation: 'ADMIN_DELETE_DOCUMENT',
        actor_admin_level: 1,
      });
    });
  });

  describe('筛选：标题模糊（LIKE 通配符按字面）与型号等值', () => {
    it('子串命中、无关键词零结果、通配符不扩大范围', async () => {
      const seedHit = await listIds(engineerToken, { title: '安全规范' });
      expect(seedHit.ids).toEqual([genericDocumentId]);

      const percentHit = await listIds(engineerToken, { title: '100%' });
      expect(percentHit.ids).toEqual([percentTitleDocumentId]);

      const percentOnly = await listIds(engineerToken, { title: '%' });
      expect(percentOnly.ids).toEqual([percentTitleDocumentId]);

      const noHit = await listIds(engineerToken, { title: 'ZZZ_无此行_' });
      expect(noHit.ids).toEqual([]);
      expect(noHit.total).toBe(0);
    });

    it('型号筛选：指定型号命中带型号资料，通用资料被排除', async () => {
      const byModel = await listIds(engineerToken, { equipmentModelId: referenceModelId });
      expect(byModel.ids).toEqual(expect.arrayContaining([primaryTextDocumentId, fileDocumentId]));
      expect(byModel.ids).not.toContain(genericDocumentId);

      const noModel = await listIds(engineerToken, { equipmentModelId: 999999 });
      expect(noModel.ids).toEqual([]);
      expect(noModel.total).toBe(0);
    });
  });

  describe('REST 授权下载（上传入口已下线，仅保留读取）', () => {
    const download = (token: string | null, id: number) => {
      const req = request(app.getHttpServer()).get(`/api/reference-documents/${id}/download`);
      if (token) {
        req.set('Authorization', `Bearer ${token}`);
      }
      return req;
    };

    // 非 text/* MIME（如 application/pdf）不进 superagent 文本解析器，
    // response.text 为 undefined；成功用例显式缓冲后断言原始字节。
    // 错误响应（401/403/404 JSON）仍走默认解析，保留 body.data 断言。
    const downloadRaw = (token: string, id: number) =>
      download(token, id)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

    it('工程师与管理员下载成功：DB MIME、RFC 5987 文件名、字节一致', async () => {
      for (const token of [adminToken, engineerToken]) {
        const response = await downloadRaw(token, fileDocumentId).expect(200);
        expect(response.headers['content-type']).toContain('application/pdf');
        expect(response.headers['content-disposition']).toContain(
          `filename*=UTF-8''${encodeURIComponent('E2E 手册.pdf')}`,
        );
        expect((response.body as Buffer).toString('utf8')).toBe('e2e-pdf-content');
      }
    });

    it('客户 403（无资料库页面权限）；匿名 401', async () => {
      const customerResponse = await download(customerToken, fileDocumentId).expect(403);
      expect(customerResponse.body.data).toMatchObject({
        statusCode: 403,
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      const anonymousResponse = await download(null, fileDocumentId).expect(401);
      expect(anonymousResponse.body.data).toMatchObject({
        statusCode: 401,
        code: 'JWT_AUTHENTICATION_FAILED',
      });
    });

    it('软删 / 下架 / 跨公司统一 404 NOT_FOUND（不泄露状态）', async () => {
      for (const id of [deletedDocumentId, offlineDocumentId, peerDocumentId]) {
        const response = await download(engineerToken, id).expect(404);
        expect(response.body.data).toMatchObject({
          statusCode: 404,
          code: 'REFERENCE_DOCUMENT_NOT_FOUND',
        });
      }
    });

    it('伪格式引用行不能读任意文件（404 FILE_NOT_AVAILABLE，不泄露路径）', async () => {
      const documentId = await createDocument({
        title: 'E2E 伪引用行',
        contentText: null,
        storageReference: '../evil.pdf',
        originalFilename: 'evil.pdf',
        mimeType: 'application/pdf',
      });

      const response = await download(engineerToken, documentId).expect(404);
      expect(response.body.data).toMatchObject({
        statusCode: 404,
        code: 'REFERENCE_DOCUMENT_FILE_NOT_AVAILABLE',
        message: '该资料没有可下载的文件',
      });
      expect(JSON.stringify(response.body)).not.toContain('evil');
    });

    it('有效引用但存储对象缺失 → 404 FILE_NOT_AVAILABLE', async () => {
      const documentId = await createDocument({
        title: 'E2E 缺失文件行',
        contentText: null,
        storageReference: `${'0'.repeat(32)}.pdf`,
        originalFilename: 'missing.pdf',
        mimeType: 'application/pdf',
      });

      const response = await download(engineerToken, documentId).expect(404);
      expect(response.body.data).toMatchObject({
        statusCode: 404,
        code: 'REFERENCE_DOCUMENT_FILE_NOT_AVAILABLE',
      });
    });
  });

  describe('数据库删除一致性约束（绕过应用层同样拒绝）', () => {
    it('已软删行不允许抹回 deleted_at；未删行不允许只置 deprecated', async () => {
      await expect(
        dataSource.query('UPDATE reference_document SET deleted_at = NULL WHERE id = ?', [
          deletedDocumentId,
        ]),
      ).rejects.toThrow(/chk_reference_document_deletion_consistency/);

      await expect(
        dataSource.query('UPDATE reference_document SET deprecated = 1 WHERE id = ?', [
          genericDocumentId,
        ]),
      ).rejects.toThrow(/chk_reference_document_deletion_consistency/);

      const facts = await readReferenceDocumentFacts({
        dataSource,
        documentId: genericDocumentId,
      });
      expect(facts).toMatchObject({ deprecated: 0, deleted_at: null });
    });
  });
});

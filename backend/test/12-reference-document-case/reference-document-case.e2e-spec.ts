// test/12-reference-document-case/reference-document-case.e2e-spec.ts

/**
 * 正式案例更正与普通写入口隔离端点级回归（A-PR0 §S6 / 任务 07 口径）
 *
 * 造数纪律：投稿审核决定（`reviewContentSubmissionDecision` APPROVE 发布
 * REVIEWED_SUBMISSION 资料）与普通资料新增/通用编辑/上传写入口已按确认需求关闭。
 * 本规格不再经任何生产写入口建立「已发布正式案例」，改为直接写
 * `reference_document` + `reference_document_case_detail` 夹具（可读正文由
 * `formatFaultCaseReferenceContent` 单一格式化真源生成，与生产链路同构），并按
 * 真实 ID 与创建即定事实登记本轮台账。
 *
 * 覆盖范围：
 * - 案例专属更正 `updateReferenceDocumentCase`：部分提交合并、正文再生成、
 *   明细与读视图一致、不可变字段（类型/归属/来源/原件）不变；
 * - 隔离：案例正文不得经管理修订（R058）改造；普通资料新增/通用编辑入口已从
 *   schema 移除，不再有绕过案例保护的通用写入口；
 * - 权限与范围：工程师/匿名/跨公司被拒；管理删除后统一 NOT_FOUND；
 * - 真实 MySQL 行锁：并发更正不同字段零覆盖；管理修订与案例更正共享主资料行锁。
 *
 * 存储隔离：运行级临时目录，收尾按精确路径清理并恢复原值。
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';

import { ApiModule } from '@src/bootstraps/api/api.module';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { ReferenceDocumentCaseDetailEntity } from '@src/modules/lithography/entities/reference-document-case-detail.entity';
import { formatFaultCaseReferenceContent } from '@src/usecases/common/fault-case-fields.contract';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
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
  seedReferenceDocumentCaseFixture,
  seedReferenceDocumentFixture,
} from '../utils/reference-document-fixtures';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import {
  buildSuiteOrganizationCodes,
  requireOrganizationId,
  seedTestMemberships,
  seedTestOrganizations,
} from '../utils/test-organizations';

// 运行级临时存储目录：先于应用初始化设置 env（与 09/11 spec 同一隔离纪律）
const originalStorageDir = captureEnvValue('REFERENCE_DOCUMENT_STORAGE_DIR');
const e2eStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refdoc-case-e2e-storage-'));
process.env.REFERENCE_DOCUMENT_STORAGE_DIR = e2eStorageRoot;

jest.setTimeout(60000);

const UPDATE_CASE_MUTATION = `
  mutation UpdateReferenceDocumentCase($id: Int!, $input: UpdateReferenceDocumentCaseInput!) {
    updateReferenceDocumentCase(id: $id, input: $input) { id updatedAt }
  }
`;

/** 已下线入口：只用内联字面量断言 schema 不再接受（不引用已移除的输入类型） */
const REMOVED_UPDATE_MUTATION = `
  mutation {
    updateReferenceDocument(id: 1, input: { title: "E2E 复活编辑" }) { id }
  }
`;

const REVISE_MUTATION = `
  mutation ReviseReferenceDocument($id: Int!, $input: ReviseReferenceDocumentInput!) {
    reviseReferenceDocument(id: $id, input: $input) { id revisionNo }
  }
`;

const ADMIN_DELETE_MUTATION = `
  mutation AdminDeleteReferenceDocument($id: Int!, $input: AdminDeleteReferenceDocumentInput!) {
    adminDeleteReferenceDocument(id: $id, input: $input) { id revisionNo }
  }
`;

const CASE_DETAIL_QUERY = `
  query ReferenceDocument($id: Int!) {
    referenceDocument(id: $id) {
      id title contentText documentType
      caseDetail {
        errorCode handlingStatus phenomenon conditionText
        reproductionSteps diagnosis actionTaken resolution
      }
    }
  }
`;

describe('正式案例更正与普通写入口隔离 (V-S6)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  let caseDetailRepository: Repository<ReferenceDocumentCaseDetailEntity>;
  let modelRepository: Repository<EquipmentModelEntity>;

  const suiteOrganizationCodes = buildSuiteOrganizationCodes('CONTENTCASE');
  const ownership = createOwnedResourceLedger();
  let primaryOrganizationId = 0;
  let caseModelId = 0;

  let adminAccountId = 0;
  let engineerAccountId = 0;
  let adminToken: string;
  let engineerToken: string;
  let peerAdminToken: string;

  const readStoredBytes = (storageReference: string): Buffer =>
    fs.readFileSync(path.join(e2eStorageRoot, storageReference));

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

  /**
   * 建立「已发布正式案例」前置事实（受控夹具，不经生产写入口）：
   * 主资料 + 案例明细 + 一份获准原件副本（本规格临时存储目录内真实字节）。
   * 可读正文由生产同源格式化函数生成，避免夹具与更正链路正文口径漂移。
   */
  const seedPublishedFaultCase = async (params: {
    title: string;
    errorCode: string | null;
    phenomenon: string;
    conditionText?: string | null;
    reproductionSteps: string;
    handlingStatus: 'UNRESOLVED' | 'IN_PROGRESS' | 'RESOLVED';
    resolution: string | null;
    diagnosis?: string | null;
    actionTaken?: string | null;
    attachmentName: string;
    attachmentContent: string;
  }): Promise<{ documentId: number; storageReference: string }> => {
    const storageReference = `${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}.txt`;
    fs.writeFileSync(
      path.join(e2eStorageRoot, storageReference),
      Buffer.from(params.attachmentContent),
    );

    const conditionText = params.conditionText ?? null;
    const diagnosis = params.diagnosis ?? null;
    const actionTaken = params.actionTaken ?? null;

    const document = await seedReferenceDocumentFixture({
      dataSource,
      ownership,
      fixture: {
        title: params.title,
        documentType: 'FAULT_CASE',
        createdByAccountId: engineerAccountId,
        ownerOrganizationId: primaryOrganizationId,
        contentText: formatFaultCaseReferenceContent({
          errorCode: params.errorCode,
          phenomenon: params.phenomenon,
          conditionText,
          reproductionSteps: params.reproductionSteps,
          diagnosis,
          actionTaken,
          handlingStatus: params.handlingStatus,
          resolution: params.resolution,
        }),
        description: null,
        originalFilename: params.attachmentName,
        mimeType: 'text/plain',
        storageBackend: 'LOCAL',
        storageReference,
        ingestMethod: 'REVIEWED_SUBMISSION',
      },
    });

    await seedReferenceDocumentCaseFixture({
      dataSource,
      ownership,
      fixture: {
        documentId: document.id,
        errorCode: params.errorCode,
        handlingStatus: params.handlingStatus,
        phenomenon: params.phenomenon,
        conditionText,
        reproductionSteps: params.reproductionSteps,
        diagnosis,
        actionTaken,
        resolution: params.resolution,
      },
    });

    return { documentId: document.id, storageReference };
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);

    caseDetailRepository = dataSource.getRepository(ReferenceDocumentCaseDetailEntity);
    modelRepository = dataSource.getRepository(EquipmentModelEntity);

    await app.init();

    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: [
          {
            organizationCode: suiteOrganizationCodes.primary,
            name: '案例更正测试甲方组织',
            kind: 'CLIENT',
          },
          {
            organizationCode: suiteOrganizationCodes.peer,
            name: '案例更正测试第二组织',
            kind: 'PEER',
          },
        ],
        accounts: [
          testAccountsConfig.staffPrimary,
          testAccountsConfig.admin,
          testAccountsConfig.peerAdmin,
        ].map(toResidueAccountFingerprint),
        equipmentModels: [
          {
            modelCode: 'E2E-CASE',
            modelName: '案例更正链路机型',
            enabled: true,
            sortOrder: 1,
          },
        ],
      },
      helper: 'reference-document-case.e2e-spec beforeAll 预清理',
    });

    await seedTestAccounts({
      dataSource,
      includeKeys: ['staffPrimary', 'admin', 'peerAdmin'],
      ownership,
    });

    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: '案例更正测试甲方组织',
          kind: 'CLIENT',
        },
        {
          organizationCode: suiteOrganizationCodes.peer,
          name: '案例更正测试第二组织',
          kind: 'PEER',
        },
      ],
      ownership,
    });
    primaryOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
    await seedTestMemberships({
      dataSource,
      memberships: [
        {
          accountLoginName: testAccountsConfig.staffPrimary.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: testAccountsConfig.admin.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: testAccountsConfig.peerAdmin.loginName,
          organizationCode: suiteOrganizationCodes.peer,
          memberRole: 'SUPER_ADMIN',
        },
      ],
      organizationIdsByCode: organizationIds,
      ownership,
    });

    const savedModel = await modelRepository.save(
      modelRepository.create({
        modelCode: 'E2E-CASE',
        modelName: '案例更正链路机型',
        enabled: true,
        sortOrder: 1,
      }),
    );
    caseModelId = savedModel.id;
    recordOwnedResource(ownership, 'equipmentModel', caseModelId, {
      modelCode: 'E2E-CASE',
      modelName: '案例更正链路机型',
      enabled: true,
      sortOrder: 1,
    });

    engineerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staffPrimary.loginName,
    );
    adminAccountId = await getAccountIdByLoginName(dataSource, testAccountsConfig.admin.loginName);

    // 等级事实取请求期查库：管理删除（R060）要求一级管理员
    await dataSource.query('UPDATE base_user_account SET admin_level = 1 WHERE id = ?', [
      adminAccountId,
    ]);

    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    engineerToken = await login({
      app,
      loginName: testAccountsConfig.staffPrimary.loginName,
      loginPassword: testAccountsConfig.staffPrimary.loginPassword,
    });
    peerAdminToken = await login({
      app,
      loginName: testAccountsConfig.peerAdmin.loginName,
      loginPassword: testAccountsConfig.peerAdmin.loginPassword,
    });
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (dataSource?.isInitialized) {
          await runGuardedSpecCleanup({
            dataSource,
            owned: ownership,
            helper: 'reference-document-case.e2e-spec afterAll 收尾',
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

  it('V-S6-1 更正闭环（未解决→已解决且有结果）：库读视图与正文一致；来源与原件不变', async () => {
    const published = await seedPublishedFaultCase({
      title: 'V-S6-1 案例：光源同步异常',
      errorCode: 'V-S6-1-ERR-100',
      phenomenon: '曝光期间同步误差超限。',
      reproductionSteps: '1. 复现同步误差；\n2. 记录趋势。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-1-report.txt',
      attachmentContent: 'v-s6-1-original-bytes',
    });
    const { documentId } = published;

    const before = await dataSource.query<
      Array<{
        content_text: string;
        document_type: string;
        owner_organization_id: number;
      }>
    >(
      `SELECT content_text, document_type, owner_organization_id FROM reference_document WHERE id = ?`,
      [documentId],
    );
    const beforeRow = before[0];
    expect(beforeRow?.content_text).toContain('处理状态：未解决');
    expect(beforeRow?.content_text).not.toContain('处理结果：');

    // 专属更正（真实 GraphQL 端点）：未解决 → 已解决且有结果
    const response = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: {
        id: documentId,
        input: { handlingStatus: 'RESOLVED', resolution: '更换目标模组后恢复，连续 5 批无异常。' },
      },
      token: adminToken,
    }).expect(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.updateReferenceDocumentCase.id).toBe(documentId);

    // —— 库读视图与正文一致：明细落新值，正文由合并后明细重新生成 ——
    const facts = await readReferenceDocumentFacts({ dataSource, documentId });
    const detailAfter = await caseDetailRepository.findOneByOrFail({ documentId });
    expect(detailAfter).toMatchObject({
      errorCode: 'V-S6-1-ERR-100',
      handlingStatus: 'RESOLVED',
      phenomenon: '曝光期间同步误差超限。',
      reproductionSteps: '1. 复现同步误差；\n2. 记录趋势。',
      resolution: '更换目标模组后恢复，连续 5 批无异常。',
    });
    expect(facts?.content_text).toContain('处理状态：已解决');
    expect(facts?.content_text).toContain('处理结果：\n更换目标模组后恢复，连续 5 批无异常。');
    expect(facts?.content_text).toContain('故障现象：\n曝光期间同步误差超限。');

    // GraphQL 详情读视图（工程师可读）与库内事实一致
    const detailResponse = await postGql({
      app,
      query: CASE_DETAIL_QUERY,
      variables: { id: documentId },
      token: engineerToken,
    }).expect(200);
    const view = detailResponse.body.data.referenceDocument as {
      contentText: string;
      caseDetail: Record<string, unknown>;
    };
    expect(view.caseDetail).toMatchObject({
      handlingStatus: 'RESOLVED',
      resolution: '更换目标模组后恢复，连续 5 批无异常。',
      errorCode: 'V-S6-1-ERR-100',
    });
    expect(view.contentText).toBe(facts?.content_text);

    // 修改人落库；返回更新时间与库内回读一致
    const updatedBy = await dataSource.query<
      Array<{ updated_by_account_id: number; updated_at: Date }>
    >('SELECT updated_by_account_id, updated_at FROM reference_document WHERE id = ?', [
      documentId,
    ]);
    expect(updatedBy[0]?.updated_by_account_id).toBe(adminAccountId);
    expect(new Date(response.body.data.updateReferenceDocumentCase.updatedAt).getTime()).toBe(
      new Date(updatedBy[0]?.updated_at).getTime(),
    );

    // —— 不可变字段（类型/归属/来源/原件）保持夹具值 ——
    expect(facts).toMatchObject({
      document_type: beforeRow?.document_type,
      owner_organization_id: beforeRow?.owner_organization_id,
    });

    // 案例更正走业务更正而非管理修订：不产生修订行（版本仍为 0）
    const revisions = await dataSource.query<Array<{ total: number }>>(
      'SELECT COUNT(*) AS total FROM reference_document_revision WHERE document_id = ?',
      [documentId],
    );
    expect(Number(revisions[0]?.total)).toBe(0);
    expect(facts?.current_revision_no).toBe(0);

    // —— 原件不被重写：夹具副本字节不变且可读 ——
    expect(readStoredBytes(published.storageReference).toString()).toBe('v-s6-1-original-bytes');
  });

  it('V-S6-2 字段更正（部分提交合并）：标题/机型/说明与明细字段更正；正文同步重生成', async () => {
    const published = await seedPublishedFaultCase({
      title: 'V-S6-2 案例：送料偏移',
      errorCode: 'V-S6-2-ERR-200',
      phenomenon: '送料机构存在周期性偏移。',
      conditionText: '连续运行超过 30 分钟。',
      reproductionSteps: '1. 空跑观察偏移；\n2. 记录偏移量。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-2-report.txt',
      attachmentContent: 'v-s6-2-original-bytes',
    });
    const { documentId } = published;
    const before = await readReferenceDocumentFacts({ dataSource, documentId });
    expect(before?.content_text).toContain('错误码：V-S6-2-ERR-200');

    // 部分提交：标题/说明/机型（文字→ID）/清空错误码/补充排查与措施
    const response = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: {
        id: documentId,
        input: {
          title: 'V-S6-2 案例：送料偏移（已更正）',
          description: '更正补充：增加送料校准说明。',
          equipmentModelText: null,
          equipmentModelId: caseModelId,
          errorCode: null,
          diagnosis: '排查补充：传动带张力不足。',
          actionTaken: '处理补充：更换并重新张紧。',
        },
      },
      token: adminToken,
    }).expect(200);
    expect(response.body.errors).toBeUndefined();
    // 更正成功改变机型绑定：显式刷新台账预期事实（R02），清理阶段按已登记事实核验
    updateOwnedExpectation(ownership, 'document', documentId, { equipmentModelId: caseModelId });

    const after = await dataSource.query<
      Array<{
        title: string;
        description: string | null;
        equipment_model_id: number | null;
        equipment_model_text: string | null;
        content_text: string;
        owner_organization_id: number | null;
        document_type: string;
      }>
    >(
      `SELECT title, description, equipment_model_id, equipment_model_text, content_text,
              owner_organization_id, document_type
         FROM reference_document WHERE id = ?`,
      [documentId],
    );
    const afterRow = after[0];
    expect(afterRow).toMatchObject({
      title: 'V-S6-2 案例：送料偏移（已更正）',
      description: '更正补充：增加送料校准说明。',
      equipment_model_id: caseModelId,
      equipment_model_text: null,
    });
    expect(afterRow?.content_text).not.toContain('错误码：');
    expect(afterRow?.content_text).toContain('排查过程：\n排查补充：传动带张力不足。');
    expect(afterRow?.content_text).toContain('处理措施：\n处理补充：更换并重新张紧。');
    expect(afterRow?.content_text).toContain('故障现象：\n送料机构存在周期性偏移。');
    expect(afterRow?.content_text).toContain('处理状态：未解决');
    expect(afterRow?.content_text).not.toContain('处理结果：');

    // 明细：未提交字段保持原值（部分提交合并语义）
    const detailAfter = await caseDetailRepository.findOneByOrFail({ documentId });
    expect(detailAfter).toMatchObject({
      errorCode: null,
      handlingStatus: 'UNRESOLVED',
      phenomenon: '送料机构存在周期性偏移。',
      conditionText: '连续运行超过 30 分钟。',
      reproductionSteps: '1. 空跑观察偏移；\n2. 记录偏移量。',
      diagnosis: '排查补充：传动带张力不足。',
      actionTaken: '处理补充：更换并重新张紧。',
      resolution: null,
    });

    // 不可变事实保持：类型/归属/原件引用
    expect(afterRow?.document_type).toBe(before?.document_type ?? 'FAULT_CASE');
    expect(afterRow?.owner_organization_id).toBe(before?.owner_organization_id ?? null);
    expect(readStoredBytes(published.storageReference).toString()).toBe('v-s6-2-original-bytes');
  });

  it('V-S6-3 隔离回归：通用编辑/新增入口已下线；案例正文不得经管理修订改造；专属更正仍可用', async () => {
    const published = await seedPublishedFaultCase({
      title: 'V-S6-3 案例：温漂超限',
      errorCode: 'V-S6-3-ERR-300',
      phenomenon: '温控漂移超限。',
      reproductionSteps: '1. 升温观测；\n2. 记录漂移。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-3-report.txt',
      attachmentContent: 'v-s6-3-original-bytes',
    });
    const before = await readReferenceDocumentFacts({
      dataSource,
      documentId: published.documentId,
    });

    // 旧通用编辑入口已从 schema 移除（不重新开放，也不再有绕过案例保护的通用写入口）
    const removed = await postGql({
      app,
      query: REMOVED_UPDATE_MUTATION,
      token: adminToken,
    });
    expect(removed.body.data).toBeUndefined();
    expect(removed.body.errors[0].message).toContain(
      'Cannot query field "updateReferenceDocument"',
    );

    // 案例正文与明细强耦合：管理修订（R058）不得单独改造正文
    const reviseContent = await postGql({
      app,
      query: REVISE_MUTATION,
      variables: {
        id: published.documentId,
        input: {
          expectedVersion: 0,
          reason: '尝试改写案例正文',
          contentText: '伪造改造后的案例正文。',
        },
      },
      token: adminToken,
    }).expect(200);
    expect(reviseContent.body.errors[0].extensions.errorCode).toBe(
      'REFERENCE_DOCUMENT_INVALID_PARAMS',
    );
    expect(reviseContent.body.errors[0].message).toContain('请使用案例更正接口');

    // 拒绝不改库：正文与版本保持夹具事实
    const afterRejects = await readReferenceDocumentFacts({
      dataSource,
      documentId: published.documentId,
    });
    expect(afterRejects?.content_text).toBe(before?.content_text);
    expect(afterRejects?.current_revision_no).toBe(0);

    // 案例更新仍由专属接口承接（隔离而非一刀切禁写）
    const caseFix = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: { id: published.documentId, input: { description: '通过专属更正确认说明。' } },
      token: adminToken,
    }).expect(200);
    expect(caseFix.body.errors).toBeUndefined();
  });

  it('V-S6-4 权限/跨组织/删除后拒绝：工程师与匿名禁止；跨组织统一 NOT_FOUND；删除后 NOT_FOUND；库不变', async () => {
    const published = await seedPublishedFaultCase({
      title: 'V-S6-4 案例：真空度波动',
      errorCode: 'V-S6-4-ERR-400',
      phenomenon: '工艺腔真空度周期性波动。',
      reproductionSteps: '1. 空载抽真空；\n2. 记录波动曲线。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-4-report.txt',
      attachmentContent: 'v-s6-4-original-bytes',
    });
    const before = await readReferenceDocumentFacts({
      dataSource,
      documentId: published.documentId,
    });
    const detailBefore = await caseDetailRepository.findOneByOrFail({
      documentId: published.documentId,
    });

    // 更正仅管理员：工程师被守卫拒绝（与通用写同一角色口径）
    const engineerResponse = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: { id: published.documentId, input: { handlingStatus: 'IN_PROGRESS' } },
      token: engineerToken,
    }).expect(200);
    expectForbidden(engineerResponse.body.errors[0], ['SUPER_ADMIN'], ['ENGINEER']);

    // 匿名会话：鉴权失败（不进入业务层）
    const anonymousResponse = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: { id: published.documentId, input: { handlingStatus: 'IN_PROGRESS' } },
    }).expect(200);
    expectUnauthenticated(anonymousResponse.body.errors[0]);

    // 跨组织管理员：本组织范围外统一 NOT_FOUND（不泄露存在性）
    const peerResponse = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: { id: published.documentId, input: { handlingStatus: 'IN_PROGRESS' } },
      token: peerAdminToken,
    }).expect(200);
    expect(peerResponse.body.errors[0].extensions.errorCode).toBe('REFERENCE_DOCUMENT_NOT_FOUND');

    // 管理删除后更正拒绝：已软删与不存在统一 NOT_FOUND（与详情读口径一致）
    const deleteResponse = await postGql({
      app,
      query: ADMIN_DELETE_MUTATION,
      variables: { id: published.documentId, input: { expectedVersion: 0, reason: '案例作废' } },
      token: adminToken,
    }).expect(200);
    expect(deleteResponse.body.errors).toBeUndefined();
    await registerReferenceDocumentRevisions({
      dataSource,
      ownership,
      documentId: published.documentId,
    });
    // 管理删除同事务写关键审计行：按创建即定事实登记，清理阶段按台账回收
    await registerReferenceDocumentAuditEvents({
      dataSource,
      ownership,
      documentId: published.documentId,
    });

    const deletedResponse = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: { id: published.documentId, input: { handlingStatus: 'IN_PROGRESS' } },
      token: adminToken,
    }).expect(200);
    expect(deletedResponse.body.errors[0].extensions.errorCode).toBe(
      'REFERENCE_DOCUMENT_NOT_FOUND',
    );

    // 所有拒绝均不改库：正文/修改人与明细保持原值；删除事实已落库
    const after = await readReferenceDocumentFacts({
      dataSource,
      documentId: published.documentId,
    });
    const detailAfter = await caseDetailRepository.findOneByOrFail({
      documentId: published.documentId,
    });
    expect(after?.content_text).toBe(before?.content_text);
    expect(detailAfter.handlingStatus).toBe(detailBefore.handlingStatus);
    expect(detailAfter.resolution).toBe(detailBefore.resolution);
    expect(after?.deprecated).toBe(1);
    expect(after?.deleted_at).not.toBeNull();
  });

  it('V-S6-5 真实并发更正（独立连接竞争）：不同字段补丁零覆盖；管理修订与专属更正共享资源锁', async () => {
    const published = await seedPublishedFaultCase({
      title: 'V-S6-5 案例：并发更正',
      errorCode: 'V-S6-5-OLD',
      phenomenon: '并发更正现象。',
      conditionText: '并发触发条件。',
      reproductionSteps: '1. 并发发起；\n2. 断言字段完整。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-5-report.txt',
      attachmentContent: 'v-s6-5-original-bytes',
    });
    const { documentId } = published;

    // G2/F01 真实独立连接竞争：每次 execute 经 TransactionRunner 从连接池取独立连接，
    // 且都在事务内对主资料行 FOR UPDATE 锁定读；后进入者在锁上等待，读到先写者已提交
    // 事实后再合并，两个补丁互不覆盖。「两请求已同时读到同一旧值再交错提交」的确定性
    // 时序注入由受控替身单测覆盖，本用例走真实 MySQL 行锁路径。
    const [correctionA, correctionB] = await Promise.all([
      postGql({
        app,
        query: UPDATE_CASE_MUTATION,
        variables: { id: documentId, input: { errorCode: 'V-S6-5-A-NEW' } },
        token: adminToken,
      }).expect(200),
      postGql({
        app,
        query: UPDATE_CASE_MUTATION,
        variables: { id: documentId, input: { conditionText: 'V-S6-5-B-NEW' } },
        token: adminToken,
      }).expect(200),
    ]);
    expect(correctionA.body.errors).toBeUndefined();
    expect(correctionB.body.errors).toBeUndefined();
    expect(correctionA.body.data.updateReferenceDocumentCase).toMatchObject({ id: documentId });
    expect(correctionB.body.data.updateReferenceDocumentCase).toMatchObject({ id: documentId });

    // 两个不同字段补丁都在：竞争未导致任一更新丢失（F01 核心断言）
    const detailAfter = await caseDetailRepository.findOneByOrFail({ documentId });
    expect(detailAfter.errorCode).toBe('V-S6-5-A-NEW');
    expect(detailAfter.conditionText).toBe('V-S6-5-B-NEW');

    // 管理修订（标题）与专属更正（案例现象）并发：两个写入口经同一主资料行锁串行化
    const [reviseResponse, caseResponse] = await Promise.all([
      postGql({
        app,
        query: REVISE_MUTATION,
        variables: {
          id: documentId,
          input: {
            expectedVersion: 0,
            reason: '并发修订标题',
            title: 'V-S6-5 案例：并发更正（标题已改）',
          },
        },
        token: adminToken,
      }).expect(200),
      postGql({
        app,
        query: UPDATE_CASE_MUTATION,
        variables: { id: documentId, input: { phenomenon: 'V-S6-5 现象已改。' } },
        token: adminToken,
      }).expect(200),
    ]);
    expect(reviseResponse.body.errors).toBeUndefined();
    expect(caseResponse.body.errors).toBeUndefined();
    await registerReferenceDocumentRevisions({ dataSource, ownership, documentId });

    const facts = await readReferenceDocumentFacts({ dataSource, documentId });
    const detailAfter2 = await caseDetailRepository.findOneByOrFail({ documentId });
    expect(facts?.title).toBe('V-S6-5 案例：并发更正（标题已改）');
    expect(detailAfter2.phenomenon).toBe('V-S6-5 现象已改。');
    // 正文与明细不脱节：正文由合并后明细重生成，含最新现象
    expect(facts?.content_text).toContain('V-S6-5 现象已改。');
  });
});

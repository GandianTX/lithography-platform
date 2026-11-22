// test/11-content-submission/frontend-response-samples.e2e-spec.ts

/**
 * S7 前端适配真实响应样例与 shape 校验（A-PR0 §S7-1 / §4.4，任务 07 收口口径）
 *
 * 口径变更（2026-11-20）：确认需求已关闭普通资料新增/通用编辑/REST 上传与资料审核
 * 决定（reviewContentSubmissionDecision）写路径。本规格随之调整：
 * - 造数改走受控隔离夹具（直接写 reference_document + 案例明细，
 *   withReferenceDocumentFixtureState 补齐 V13 必填状态），不依赖任何生产写入口；
 * - 旧写入口改为「协议层已移除」负例（不重新开放，也不为造数保留）；
 * - 保留前端仍消费的读路径与投稿自身写路径（建稿/附件/送审）形状断言；
 * - 案例更正 R061-01 与正式资料读取形状改由夹具前置已发布事实后验证。
 *
 * 边界声明：
 * - 本规格验证「前端 adapter 的操作文本与消费 shape」在真实后端上可调且形状一致。
 *   以下 GraphQL 操作文本与 frontend/src/features/content-submission/infrastructure/
 *   content-submission-adapter.ts、frontend/src/features/reference-document/infrastructure/
 *   reference-document-adapter.ts 逐字一致——前端操作文本变更时必须同步本文件，
 *   否则本规格将在真实后端上失败（前端文本与后端契约漂移的告警信号）；
 * - 只走真实 HTTP：GraphQL POST /graphql + REST multipart（真实守卫 / 错误过滤器 /
 *   事务 / 本地文件存储）；不直接调用 usecase；
 * - 每步以 [S7-SAMPLE] 单行 JSON 打印「请求变量 + 完整线上响应」，供交接材料抄录真实样例；
 *   设置 S7_SAMPLES_OUT=<path> 时另将全部样例数组落盘（JSON）；
 * - 失败样例只取代表路径（未确认告知 / 待审上传 / 待审改稿 / 已下线运营决定），
 *   完整错误矩阵由 content-submission-graphql.e2e-spec.ts 覆盖；
 * - 存储隔离：运行级临时上传目录（mkdtemp，先于应用初始化设置 env），结束后按精确路径删除。
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';

import { ApiModule } from '@src/bootstraps/api/api.module';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { formatFaultCaseReferenceContent } from '@src/usecases/common/fault-case-fields.contract';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from '../utils/e2e-teardown';
import {
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

// 运行级临时存储目录：先于应用初始化设置 env，使配置加载时读到本规格专属目录。
// 原环境变量值先捕获，收尾时恢复原值（不假定原值不存在）。
const originalStorageDir = captureEnvValue('REFERENCE_DOCUMENT_STORAGE_DIR');
const e2eStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's7-shape-storage-'));
process.env.REFERENCE_DOCUMENT_STORAGE_DIR = e2eStorageRoot;

jest.setTimeout(60000);

/** 规格专属机型夹具（本规格 beforeAll 自增创建，afterAll 自清） */
const S7_MODEL_NAME = 'S7 样例机型';
const S7_ORG_NAME = 'S7 样例契约组织';

// —— GraphQL 操作（逐字复制前端 adapter；见文件头边界声明） ——

const MY_LIST_QUERY = `
  query MyContentSubmissions($pagination: PaginationArgs!, $filter: ContentSubmissionFilterInput) {
    myContentSubmissions(pagination: $pagination, filter: $filter) {
      items {
        id
        title
        submissionKind
        status
        currentRevisionNo
        lastSubmittedAt
        updatedAt
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

const MY_DETAIL_QUERY = `
  query MyContentSubmission($id: Int!) {
    myContentSubmission(id: $id) {
      id
      submissionKind
      status
      currentRevisionNo
      lastSubmittedAt
      publishedAt
      material {
        title
        documentType
        equipmentModelId
        equipmentModelName
        equipmentModelText
        description
        contentText
      }
      faultCase {
        title
        equipmentModelId
        equipmentModelName
        equipmentModelText
        errorCode
        phenomenon
        conditionText
        reproductionSteps
        diagnosis
        actionTaken
        handlingStatus
        resolution
      }
      currentAttachment {
        id
        originalFilename
        mimeType
        byteSize
        uploadedAt
      }
      latestReview {
        decision
        comment
        publishAttachment
        reviewedAt
      }
      publishedDocument {
        documentId
        available
      }
      createdAt
      updatedAt
    }
  }
`;

const REVISION_QUERY = `
  query ContentSubmissionRevision($submissionId: Int!, $revisionNo: Int!) {
    contentSubmissionRevision(submissionId: $submissionId, revisionNo: $revisionNo) {
      revisionId
      submissionId
      submissionKind
      revisionNo
      schemaVersion
      titleSnapshot
      payloadSnapshot
      attachment {
        id
        originalFilename
        mimeType
        byteSize
        uploadedAt
      }
      noticeVersion
      confirmedAt
      submittedAt
      review {
        decision
        comment
        publishAttachment
        reviewedAt
      }
    }
  }
`;

const REVIEW_LIST_QUERY = `
  query ReviewContentSubmissions($pagination: PaginationArgs!, $filter: ContentSubmissionFilterInput) {
    reviewContentSubmissions(pagination: $pagination, filter: $filter) {
      items {
        id
        title
        submissionKind
        status
        currentRevisionNo
        lastSubmittedAt
        updatedAt
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

const REVIEW_DETAIL_QUERY = `
  query ReviewContentSubmission($id: Int!) {
    reviewContentSubmission(id: $id) {
      submissionId
      submissionKind
      status
      currentRevisionNo
      lastSubmittedAt
      submittedByAccountId
      currentRevision {
        revisionId
        submissionId
        submissionKind
        revisionNo
        schemaVersion
        titleSnapshot
        payloadSnapshot
        attachment {
          id
          originalFilename
          mimeType
          byteSize
          uploadedAt
        }
        noticeVersion
        confirmedAt
        submittedAt
        review {
          decision
          comment
          publishAttachment
          reviewedAt
        }
      }
      reviewHistory {
        revisionId
        revisionNo
        decision
        comment
        publishAttachment
        reviewedAt
      }
    }
  }
`;

const CREATE_DRAFT_MUTATION = `
  mutation CreateContentSubmissionDraft($input: CreateContentSubmissionDraftInput!) {
    createContentSubmissionDraft(input: $input) {
      id
      submissionKind
      status
      updatedAt
    }
  }
`;

const UPDATE_DRAFT_MUTATION = `
  mutation UpdateContentSubmissionDraft($id: Int!, $input: UpdateContentSubmissionDraftInput!) {
    updateContentSubmissionDraft(id: $id, input: $input) {
      id
      submissionKind
      status
      updatedAt
    }
  }
`;

const SUBMIT_MUTATION = `
  mutation SubmitContentSubmission($id: Int!, $input: SubmitContentSubmissionInput!) {
    submitContentSubmission(id: $id, input: $input) {
      submissionId
      revisionId
      revisionNo
      status
    }
  }
`;

// 已下线入口：只用内联字面量断言「schema 不再接受」，不引用已移除的输入类型
// （引用 ReviewContentSubmissionDecisionInput 会先触发未知类型错误，掩盖字段移除信号）
const REMOVED_DECISION_QUERY = `
  mutation {
    reviewContentSubmissionDecision(
      input: { submissionId: 1, revisionId: 1, decision: APPROVE, publishAttachment: true }
    ) {
      submissionId
      status
      documentId
    }
  }
`;

const REFERENCE_DOCUMENTS_QUERY = `
  query ReferenceDocuments($pagination: PaginationArgs!, $filter: ReferenceDocumentFilterInput) {
    referenceDocuments(pagination: $pagination, filter: $filter) {
      items {
        id
        title
        documentType
        equipmentModelId
        equipmentModelName
        equipmentModelText
        description
        originalFilename
        organizationName
        ingestMethod
        caseHandlingStatus
        creatorNickname
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

const REFERENCE_DOCUMENT_DETAIL_QUERY = `
  query ReferenceDocument($id: Int!) {
    referenceDocument(id: $id) {
      id
      title
      documentType
      equipmentModelId
      equipmentModelName
      equipmentModelText
      description
      originalFilename
      mimeType
      hasFile
      contentText
      organizationName
      ingestMethod
      caseDetail {
        errorCode
        handlingStatus
        phenomenon
        conditionText
        reproductionSteps
        diagnosis
        actionTaken
        resolution
      }
      creatorNickname
      createdAt
      updatedAt
    }
  }
`;

const UPDATE_REFERENCE_DOCUMENT_CASE_MUTATION = `
  mutation UpdateReferenceDocumentCase($id: Int!, $input: UpdateReferenceDocumentCaseInput!) {
    updateReferenceDocumentCase(id: $id, input: $input) {
      id
      updatedAt
    }
  }
`;

// —— shape 键集合（与前端 types 逐字段对齐；精确锁定 = 前端消费面契约） ——

const MY_DETAIL_KEYS = [
  'id',
  'submissionKind',
  'status',
  'currentRevisionNo',
  'lastSubmittedAt',
  'publishedAt',
  'material',
  'faultCase',
  'currentAttachment',
  'latestReview',
  'publishedDocument',
  'createdAt',
  'updatedAt',
];
const MATERIAL_DETAIL_KEYS = [
  'title',
  'documentType',
  'equipmentModelId',
  'equipmentModelName',
  'equipmentModelText',
  'description',
  'contentText',
];
const ATTACHMENT_META_KEYS = ['id', 'originalFilename', 'mimeType', 'byteSize', 'uploadedAt'];
const REVISION_KEYS = [
  'revisionId',
  'submissionId',
  'submissionKind',
  'revisionNo',
  'schemaVersion',
  'titleSnapshot',
  'payloadSnapshot',
  'attachment',
  'noticeVersion',
  'confirmedAt',
  'submittedAt',
  'review',
];
const REVIEW_DETAIL_KEYS = [
  'submissionId',
  'submissionKind',
  'status',
  'currentRevisionNo',
  'lastSubmittedAt',
  'submittedByAccountId',
  'currentRevision',
  'reviewHistory',
];
const CS_LIST_PAGE_KEYS = ['items', 'total', 'page', 'pageSize'];
const CS_LIST_ITEM_KEYS = [
  'id',
  'title',
  'submissionKind',
  'status',
  'currentRevisionNo',
  'lastSubmittedAt',
  'updatedAt',
  'createdAt',
];
const RD_LIST_ITEM_KEYS = [
  'id',
  'title',
  'documentType',
  'equipmentModelId',
  'equipmentModelName',
  'equipmentModelText',
  'description',
  'originalFilename',
  'organizationName',
  'ingestMethod',
  'caseHandlingStatus',
  'creatorNickname',
  'createdAt',
];
const RD_DETAIL_KEYS = [
  'id',
  'title',
  'documentType',
  'equipmentModelId',
  'equipmentModelName',
  'equipmentModelText',
  'description',
  'originalFilename',
  'mimeType',
  'hasFile',
  'contentText',
  'organizationName',
  'ingestMethod',
  'caseDetail',
  'creatorNickname',
  'createdAt',
  'updatedAt',
];
const RD_CASE_DETAIL_KEYS = [
  'errorCode',
  'handlingStatus',
  'phenomenon',
  'conditionText',
  'reproductionSteps',
  'diagnosis',
  'actionTaken',
  'resolution',
];

const PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true };

describe('S7 前端适配真实响应样例与 shape 校验', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let modelRepository: Repository<EquipmentModelEntity>;
  let s7ModelId = 0;
  const ownership = createOwnedResourceLedger();

  const suiteOrganizationCodes = buildSuiteOrganizationCodes('S7SHAPE');

  let engineerToken: string;
  let adminToken: string;
  let engineerAccountId = 0;
  let primaryOrganizationId = 0;

  // 样例数组（S7_SAMPLES_OUT 时落盘）
  const samples: Array<{ step: string; request: unknown; response: unknown }> = [];

  const recordSample = (step: string, requestPayload: unknown, responsePayload: unknown): void => {
    samples.push({ step, request: requestPayload, response: responsePayload });
    // 单行 JSON 便于日志提取；不包含任何凭据
    console.log(
      `[S7-SAMPLE] ${JSON.stringify({ step, request: requestPayload, response: responsePayload })}`,
    );
  };

  const expectIsoDateString = (value: unknown): void => {
    expect(typeof value).toBe('string');
    expect(Number.isNaN(Date.parse(value as string))).toBe(false);
  };

  const expectExactKeys = (value: unknown, keys: string[]): void => {
    expect(value).not.toBeNull();
    expect(Object.keys(value as object).sort()).toEqual([...keys].sort());
  };

  /** GraphQL 便捷调用（成功路径统一断言无 errors，返回 data） */
  const gqlSuccess = async (token: string, query: string, variables: unknown): Promise<any> => {
    const response = await postGql({ app, query, variables, token }).expect(200);
    expect(response.body.errors).toBeUndefined();
    return response.body.data;
  };

  const attachmentPath = (submissionId: number): string =>
    `/api/content-submissions/${submissionId}/attachment`;
  const downloadPath = (submissionId: number, attachmentId: number): string =>
    `/api/content-submissions/${submissionId}/attachments/${attachmentId}/download`;

  const restUpload = (
    token: string,
    submissionId: number,
    fileName: string,
    content: string,
  ): request.Test =>
    request(app.getHttpServer())
      .post(attachmentPath(submissionId))
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(content), fileName);

  const restRemove = (token: string, submissionId: number): request.Test =>
    request(app.getHttpServer())
      .delete(attachmentPath(submissionId))
      .set('Authorization', `Bearer ${token}`);

  const restDownload = (token: string, submissionId: number, attachmentId: number): request.Test =>
    request(app.getHttpServer())
      .get(downloadPath(submissionId, attachmentId))
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    modelRepository = dataSource.getRepository(EquipmentModelEntity);

    await app.init();

    // 预清理：组织/账号/机型均按完整指纹回收已知残留；投稿链由本轮 owned 组织/账号预检圈定
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: [
          {
            organizationCode: suiteOrganizationCodes.primary,
            name: S7_ORG_NAME,
            kind: 'CLIENT',
          },
        ],
        accounts: [testAccountsConfig.staffPrimary, testAccountsConfig.admin].map(
          toResidueAccountFingerprint,
        ),
        equipmentModels: [
          {
            modelCode: 'E2E-S7-MODEL',
            modelName: S7_MODEL_NAME,
            enabled: true,
            sortOrder: 1,
          },
        ],
      },
      helper: 'frontend-response-samples.e2e-spec beforeAll 预清理',
    });

    await seedTestAccounts({
      dataSource,
      includeKeys: ['staffPrimary', 'admin'],
      ownership,
    });

    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: S7_ORG_NAME,
          kind: 'CLIENT',
        },
      ],
      ownership,
    });
    await seedTestMemberships({
      dataSource,
      ownership,
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
      ],
      organizationIdsByCode: organizationIds,
    });
    primaryOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);

    const savedModel = await modelRepository.save(
      modelRepository.create({
        modelCode: 'E2E-S7-MODEL',
        modelName: S7_MODEL_NAME,
        enabled: true,
        sortOrder: 1,
      }),
    );
    s7ModelId = savedModel.id;
    recordOwnedResource(ownership, 'equipmentModel', s7ModelId, {
      modelCode: 'E2E-S7-MODEL',
      modelName: S7_MODEL_NAME,
      enabled: true,
      sortOrder: 1,
    });

    engineerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staffPrimary.loginName,
    );

    engineerToken = await login({
      app,
      loginName: testAccountsConfig.staffPrimary.loginName,
      loginPassword: testAccountsConfig.staffPrimary.loginPassword,
    });
    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (dataSource?.isInitialized) {
          await runGuardedSpecCleanup({
            dataSource,
            owned: ownership,
            helper: 'frontend-response-samples.e2e-spec afterAll 收尾',
          });
        }
      },
      finalize: () => {
        const outPath = process.env.S7_SAMPLES_OUT;
        if (outPath) {
          fs.writeFileSync(outPath, JSON.stringify(samples, null, 2));
          console.log(`[S7-SAMPLE] 样例已写入 ${outPath}（共 ${samples.length} 条）`);
        }
        // 临时存储目录按精确路径清理，并恢复捕获时的原环境变量值
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

  describe('S7-A 普通资料链路（建稿 → 附件 → 送审 → 待审读取；审核决定入口已下线）', () => {
    let materialSubmissionId = 0;
    let attachmentId = 0;
    let v1RevisionId = 0;

    const ATTACHMENT_NAME = 's7-sample-attachment.txt';
    const ATTACHMENT_CONTENT = 's7-sample-attachment-bytes-v1';

    // F01：A 链合并在同一 it 内，内部保留 A1–A4 命名步骤；
    // 定向执行 A 链即可独立准备全部前置状态，不依赖兄弟 it 的数据接力。
    it('A 普通资料链路：建稿 → 附件 → 送审 → 待审读取（单测独立）', async () => {
      // —— A1 建稿/改稿/回读：MATERIAL 形状（可空字段与机型互斥） ——
      const createInput = {
        kind: 'MATERIAL',
        fields: {
          title: 'S7 样例：光源能量校准作业手册',
          documentType: 'MAINTENANCE_GUIDE',
          contentText: 'S7 样例如正文 v1：1. 读取能量曲线；2. 执行校准；3. 记录结果。',
          description: 'S7 样例说明：适用于年度校准场景。',
          equipmentModelText: 'NXT:1980Di（手填）',
        },
      };

      const created = await gqlSuccess(engineerToken, CREATE_DRAFT_MUTATION, {
        input: createInput,
      });
      recordSample(
        'A1.1 createContentSubmissionDraft',
        { operation: 'createContentSubmissionDraft', variables: { input: createInput } },
        created,
      );
      expectExactKeys(created.createContentSubmissionDraft, [
        'id',
        'submissionKind',
        'status',
        'updatedAt',
      ]);
      expect(created.createContentSubmissionDraft).toMatchObject({
        submissionKind: 'MATERIAL',
        status: 'DRAFT',
      });
      expectIsoDateString(created.createContentSubmissionDraft.updatedAt);
      materialSubmissionId = created.createContentSubmissionDraft.id;
      expect(materialSubmissionId).toEqual(expect.any(Number));

      // 改稿：机型文字 → 机型 ID（同一补丁清空另一侧）；description 更新
      const patch = {
        description: 'S7 样例说明（已更新）：覆盖年度与季度校准场景。',
        equipmentModelText: null,
        equipmentModelId: s7ModelId,
      };
      const updated = await gqlSuccess(engineerToken, UPDATE_DRAFT_MUTATION, {
        id: materialSubmissionId,
        input: { patch },
      });
      recordSample(
        'A1.2 updateContentSubmissionDraft（机型文字→ID 同补丁替换）',
        {
          operation: 'updateContentSubmissionDraft',
          variables: { id: materialSubmissionId, input: { patch } },
        },
        updated,
      );
      expectExactKeys(updated.updateContentSubmissionDraft, [
        'id',
        'submissionKind',
        'status',
        'updatedAt',
      ]);
      expect(updated.updateContentSubmissionDraft).toMatchObject({
        id: materialSubmissionId,
        submissionKind: 'MATERIAL',
        status: 'DRAFT',
      });

      // 我的投稿详情：前端消费面 13 个键完整
      const mine = await gqlSuccess(engineerToken, MY_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      recordSample(
        'A1.3 myContentSubmission（建稿后）',
        { operation: 'myContentSubmission', variables: { id: materialSubmissionId } },
        mine,
      );
      expectExactKeys(mine.myContentSubmission, MY_DETAIL_KEYS);
      expectExactKeys(mine.myContentSubmission.material, MATERIAL_DETAIL_KEYS);
      expect(mine.myContentSubmission.material).toMatchObject({
        title: 'S7 样例：光源能量校准作业手册',
        documentType: 'MAINTENANCE_GUIDE',
        equipmentModelId: s7ModelId,
        equipmentModelText: null,
        description: 'S7 样例说明（已更新）：覆盖年度与季度校准场景。',
      });
      expect(mine.myContentSubmission.faultCase).toBeNull();
      expect(mine.myContentSubmission.currentAttachment).toBeNull();
      expect(mine.myContentSubmission.latestReview).toBeNull();
      expect(mine.myContentSubmission.publishedDocument).toBeNull();
      expect(mine.myContentSubmission.publishedAt).toBeNull();
      expect(mine.myContentSubmission).toMatchObject({
        status: 'DRAFT',
        currentRevisionNo: 0,
        lastSubmittedAt: null,
      });

      // 我的投稿列表：DRAFT 阶段形状
      const myList = await gqlSuccess(engineerToken, MY_LIST_QUERY, {
        pagination: PAGINATION,
        filter: { title: 'S7 样例' },
      });
      recordSample(
        'A1.4 myContentSubmissions（建稿后）',
        { operation: 'myContentSubmissions', variables: { pagination: PAGINATION } },
        myList,
      );
      const page = myList.myContentSubmissions;
      expectExactKeys(page, CS_LIST_PAGE_KEYS);
      expectExactKeys(page.items[0], CS_LIST_ITEM_KEYS);
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        id: materialSubmissionId,
        submissionKind: 'MATERIAL',
        status: 'DRAFT',
        currentRevisionNo: 0,
        lastSubmittedAt: null,
      });

      // —— A2 上传/送审：REST 附件元数据、未确认拒、待审冲突与版本冻结 ——
      const uploaded = await restUpload(
        engineerToken,
        materialSubmissionId,
        ATTACHMENT_NAME,
        ATTACHMENT_CONTENT,
      ).expect(201);
      recordSample(
        'A2.1 REST POST …/attachment（multipart 上传）',
        {
          method: 'POST',
          path: attachmentPath(materialSubmissionId),
          multipart: { file: ATTACHMENT_NAME, byteSize: Buffer.byteLength(ATTACHMENT_CONTENT) },
        },
        uploaded.body,
      );
      expectExactKeys(uploaded.body.data, [
        'attachmentId',
        'originalFilename',
        'mimeType',
        'byteSize',
      ]);
      expect(uploaded.body.data).toMatchObject({
        originalFilename: ATTACHMENT_NAME,
        mimeType: 'text/plain',
        byteSize: Buffer.byteLength(ATTACHMENT_CONTENT),
      });
      attachmentId = uploaded.body.data.attachmentId as number;

      const detailAfterUpload = await gqlSuccess(engineerToken, MY_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      recordSample(
        'A2.2 myContentSubmission（当前附件回读）',
        { operation: 'myContentSubmission', variables: { id: materialSubmissionId } },
        detailAfterUpload,
      );
      expectExactKeys(
        detailAfterUpload.myContentSubmission.currentAttachment,
        ATTACHMENT_META_KEYS,
      );
      expect(detailAfterUpload.myContentSubmission.currentAttachment).toMatchObject({
        id: attachmentId,
        originalFilename: ATTACHMENT_NAME,
        mimeType: 'text/plain',
        byteSize: Buffer.byteLength(ATTACHMENT_CONTENT),
      });
      expectIsoDateString(detailAfterUpload.myContentSubmission.currentAttachment.uploadedAt);

      // 未确认入库告知：拒绝送审（前端映射 invalid-input 的代表失败样例）
      const noConfirm = await postGql({
        app,
        query: SUBMIT_MUTATION,
        variables: { id: materialSubmissionId, input: { libraryNoticeConfirmed: false } },
        token: engineerToken,
      }).expect(200);
      recordSample(
        'A2.3 submitContentSubmission 未确认入库告知（失败样例）',
        {
          operation: 'submitContentSubmission',
          variables: { id: materialSubmissionId, input: { libraryNoticeConfirmed: false } },
        },
        { errors: noConfirm.body.errors },
      );
      expect(noConfirm.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(noConfirm.body.errors[0].extensions.errorCode).toBe(
        'CONTENT_SUBMISSION_INVALID_PARAMS',
      );

      const submitted = await gqlSuccess(engineerToken, SUBMIT_MUTATION, {
        id: materialSubmissionId,
        input: { libraryNoticeConfirmed: true },
      });
      recordSample(
        'A2.4 submitContentSubmission（冻结 v1）',
        {
          operation: 'submitContentSubmission',
          variables: { id: materialSubmissionId, input: { libraryNoticeConfirmed: true } },
        },
        submitted,
      );
      expectExactKeys(submitted.submitContentSubmission, [
        'submissionId',
        'revisionId',
        'revisionNo',
        'status',
      ]);
      expect(submitted.submitContentSubmission).toMatchObject({
        submissionId: materialSubmissionId,
        revisionNo: 1,
        status: 'PENDING_REVIEW',
      });
      v1RevisionId = submitted.submitContentSubmission.revisionId;
      expect(v1RevisionId).toEqual(expect.any(Number));

      // 待审中上传附件：状态冲突（REST 409 代表失败样例）
      const pendingUpload = await restUpload(
        engineerToken,
        materialSubmissionId,
        'blocked-while-pending.txt',
        'x',
      ).expect(409);
      recordSample(
        'A2.5 REST POST …/attachment 待审拒绝（失败样例）',
        {
          method: 'POST',
          path: attachmentPath(materialSubmissionId),
          multipart: { file: 'blocked-while-pending.txt' },
        },
        pendingUpload.body,
      );
      expect(pendingUpload.body.data).toMatchObject({
        statusCode: 409,
        code: 'CONTENT_SUBMISSION_STATE_NOT_EDITABLE',
      });

      const revisionData = await gqlSuccess(engineerToken, REVISION_QUERY, {
        submissionId: materialSubmissionId,
        revisionNo: 1,
      });
      recordSample(
        'A2.6 contentSubmissionRevision v1（送审后冻结快照）',
        {
          operation: 'contentSubmissionRevision',
          variables: { submissionId: materialSubmissionId, revisionNo: 1 },
        },
        revisionData,
      );
      const revision = revisionData.contentSubmissionRevision;
      expectExactKeys(revision, REVISION_KEYS);
      expectExactKeys(revision.attachment, ATTACHMENT_META_KEYS);
      expect(revision).toMatchObject({
        revisionId: v1RevisionId,
        submissionId: materialSubmissionId,
        submissionKind: 'MATERIAL',
        revisionNo: 1,
        schemaVersion: 1,
        titleSnapshot: 'S7 样例：光源能量校准作业手册',
        review: null,
      });
      expect(revision.payloadSnapshot).toMatchObject({
        title: 'S7 样例：光源能量校准作业手册',
        documentType: 'MAINTENANCE_GUIDE',
        equipmentModelId: s7ModelId,
        equipmentModelText: null,
        description: 'S7 样例说明（已更新）：覆盖年度与季度校准场景。',
        contentText: 'S7 样例如正文 v1：1. 读取能量曲线；2. 执行校准；3. 记录结果。',
      });
      expect(typeof revision.noticeVersion).toBe('string');
      expect((revision.noticeVersion as string).length).toBeGreaterThan(0);
      expectIsoDateString(revision.confirmedAt);
      expectIsoDateString(revision.submittedAt);

      // —— A3 待审读取：队列/详情（只读路径仍保留，审核决定写入口已下线） ——
      const queueData = await gqlSuccess(adminToken, REVIEW_LIST_QUERY, {
        pagination: PAGINATION,
        filter: { title: 'S7 样例' },
      });
      recordSample(
        'A3.1 reviewContentSubmissions（待审队列·缺省待审）',
        {
          operation: 'reviewContentSubmissions',
          variables: { pagination: PAGINATION, filter: { title: 'S7 样例' } },
        },
        queueData,
      );
      const queue = queueData.reviewContentSubmissions;
      expectExactKeys(queue, CS_LIST_PAGE_KEYS);
      expectExactKeys(queue.items[0], CS_LIST_ITEM_KEYS);
      expect(queue.total).toBe(1);
      expect(queue.items[0]).toMatchObject({
        id: materialSubmissionId,
        submissionKind: 'MATERIAL',
        status: 'PENDING_REVIEW',
        currentRevisionNo: 1,
      });

      const reviewData = await gqlSuccess(adminToken, REVIEW_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      recordSample(
        'A3.2 reviewContentSubmission（审核详情·v1 待审）',
        { operation: 'reviewContentSubmission', variables: { id: materialSubmissionId } },
        reviewData,
      );
      const reviewDetail = reviewData.reviewContentSubmission;
      expectExactKeys(reviewDetail, REVIEW_DETAIL_KEYS);
      expectExactKeys(reviewDetail.currentRevision, REVISION_KEYS);
      expect(reviewDetail).toMatchObject({
        submissionId: materialSubmissionId,
        submissionKind: 'MATERIAL',
        status: 'PENDING_REVIEW',
        currentRevisionNo: 1,
        submittedByAccountId: engineerAccountId,
      });
      expect(reviewDetail.currentRevision.revisionNo).toBe(1);
      expect(reviewDetail.reviewHistory).toEqual([]);

      // —— A4 审核决定入口已下线：协议层拒绝，投稿停在待审且不产生正式资料 ——
      const removedDecision = await postGql({
        app,
        query: REMOVED_DECISION_QUERY,
        token: adminToken,
      });
      recordSample(
        'A4.1 reviewContentSubmissionDecision 已下线（负例）',
        {
          operation: 'reviewContentSubmissionDecision',
          variables: { submissionId: materialSubmissionId, revisionId: v1RevisionId },
        },
        { errors: removedDecision.body.errors },
      );
      expect(removedDecision.body.data).toBeUndefined();
      expect(
        (removedDecision.body.errors as Array<{ message: string }>).some((item) =>
          item.message.includes('Cannot query field "reviewContentSubmissionDecision"'),
        ),
      ).toBe(true);

      const afterRemoved = await gqlSuccess(engineerToken, MY_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      expect(afterRemoved.myContentSubmission).toMatchObject({
        status: 'PENDING_REVIEW',
        currentRevisionNo: 1,
        latestReview: null,
        publishedDocument: null,
        publishedAt: null,
      });

      // 待审仍可下载原件（授权与发布状态无关）；文件名 RFC 5987 编码
      const downloaded = await restDownload(
        engineerToken,
        materialSubmissionId,
        attachmentId,
      ).expect(200);
      recordSample(
        'A4.2 REST GET …/download（待审原件原文）',
        { method: 'GET', path: downloadPath(materialSubmissionId, attachmentId) },
        {
          contentType: downloaded.headers['content-type'],
          contentDisposition: downloaded.headers['content-disposition'],
        },
      );
      expect(downloaded.headers['content-disposition']).toContain(
        `filename*=UTF-8''${ATTACHMENT_NAME}`,
      );
      expect(downloaded.text).toBe(ATTACHMENT_CONTENT);

      // 待审改稿被拒（GraphQL CONFLICT 代表失败样例）
      const editWhilePending = await postGql({
        app,
        query: UPDATE_DRAFT_MUTATION,
        variables: { id: materialSubmissionId, input: { patch: { title: 'S7 待审改稿' } } },
        token: engineerToken,
      }).expect(200);
      recordSample(
        'A4.3 updateContentSubmissionDraft 待审拒绝（失败样例）',
        {
          operation: 'updateContentSubmissionDraft',
          variables: { id: materialSubmissionId, input: { patch: { title: 'S7 待审改稿' } } },
        },
        { errors: editWhilePending.body.errors },
      );
      expect(editWhilePending.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(editWhilePending.body.errors[0].extensions.errorCode).toBe(
        'CONTENT_SUBMISSION_STATE_NOT_EDITABLE',
      );

      // 待审移除附件同样被拒（REST 409 代表失败样例，前端映射 state-conflict）
      const removeWhilePending = await restRemove(engineerToken, materialSubmissionId).expect(409);
      recordSample(
        'A4.4 REST DELETE …/attachment 待审拒绝（失败样例）',
        { method: 'DELETE', path: attachmentPath(materialSubmissionId) },
        removeWhilePending.body,
      );
      expect(removeWhilePending.body.data).toMatchObject({
        statusCode: 409,
        code: 'CONTENT_SUBMISSION_STATE_NOT_EDITABLE',
      });
    });
  });

  describe('S7-B 案例链路：正式案例读取 → 专属更正（前端消费面）', () => {
    // 发布入口（reviewContentSubmissionDecision APPROVE）已下线：正式案例用受控夹具
    // 直接落库（refdoc 表 + 案例明细），可读正文由生产同源格式化函数生成。
    it('B 案例：正式资料读形状与专属更正形状一致（单测独立）', async () => {
      const storageReference = `${'b'.repeat(32)}.txt`;
      const attachmentContent = 's7-b-original-bytes';
      fs.writeFileSync(path.join(e2eStorageRoot, storageReference), Buffer.from(attachmentContent));

      const caseTitle = 'S7-B 案例：涂胶厚度漂移';
      const caseFields = {
        errorCode: 'S7-B-ERR-900',
        phenomenon: '涂胶厚度呈周期性漂移。',
        conditionText: '连续生产 4 小时后出现。',
        reproductionSteps: '1. 连续涂胶 4 小时；\n2. 每 30 分钟记录厚度。',
        diagnosis: null,
        actionTaken: null,
        handlingStatus: 'UNRESOLVED' as const,
        resolution: null,
      };

      const document = await seedReferenceDocumentFixture({
        dataSource,
        ownership,
        fixture: {
          title: caseTitle,
          documentType: 'FAULT_CASE',
          createdByAccountId: engineerAccountId,
          ownerOrganizationId: primaryOrganizationId,
          contentText: formatFaultCaseReferenceContent(caseFields),
          equipmentModelId: s7ModelId,
          originalFilename: 's7-b-sample.txt',
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
          errorCode: caseFields.errorCode,
          handlingStatus: caseFields.handlingStatus,
          phenomenon: caseFields.phenomenon,
          conditionText: caseFields.conditionText,
          reproductionSteps: caseFields.reproductionSteps,
          resolution: caseFields.resolution,
        },
      });

      // —— B1 正式资料列表形状（工程师本公司范围可见） ——
      const listData = await gqlSuccess(engineerToken, REFERENCE_DOCUMENTS_QUERY, {
        pagination: PAGINATION,
        filter: { title: 'S7-B 案例' },
      });
      recordSample(
        'B1.1 referenceDocuments（正式案例列表）',
        { operation: 'referenceDocuments', variables: { pagination: PAGINATION } },
        listData,
      );
      const page = listData.referenceDocuments;
      expectExactKeys(page, CS_LIST_PAGE_KEYS);
      expectExactKeys(page.items[0], RD_LIST_ITEM_KEYS);
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        id: document.id,
        title: caseTitle,
        documentType: 'FAULT_CASE',
        equipmentModelId: s7ModelId,
        equipmentModelText: null,
        organizationName: S7_ORG_NAME,
        originalFilename: 's7-b-sample.txt',
        ingestMethod: 'REVIEWED_SUBMISSION',
        caseHandlingStatus: 'UNRESOLVED',
      });
      expectIsoDateString(page.items[0].createdAt);

      // —— B2 正式资料详情形状（含案例明细与正文） ——
      const detailData = await gqlSuccess(engineerToken, REFERENCE_DOCUMENT_DETAIL_QUERY, {
        id: document.id,
      });
      recordSample(
        'B2.1 referenceDocument（正式案例详情）',
        { operation: 'referenceDocument', variables: { id: document.id } },
        detailData,
      );
      const detail = detailData.referenceDocument;
      expectExactKeys(detail, RD_DETAIL_KEYS);
      expectExactKeys(detail.caseDetail, RD_CASE_DETAIL_KEYS);
      expect(detail).toMatchObject({
        id: document.id,
        documentType: 'FAULT_CASE',
        hasFile: true,
        mimeType: 'text/plain',
        organizationName: S7_ORG_NAME,
        ingestMethod: 'REVIEWED_SUBMISSION',
      });
      expect(detail.caseDetail).toMatchObject({
        errorCode: 'S7-B-ERR-900',
        handlingStatus: 'UNRESOLVED',
        phenomenon: '涂胶厚度呈周期性漂移。',
        conditionText: '连续生产 4 小时后出现。',
        resolution: null,
      });
      expect(detail.contentText).toContain('处理状态：未解决');
      expect(detail.contentText).not.toContain('处理结果：');

      // —— B3 案例专属更正：前端 adapter 消费的最小形状 ——
      const fixed = await gqlSuccess(adminToken, UPDATE_REFERENCE_DOCUMENT_CASE_MUTATION, {
        id: document.id,
        input: { handlingStatus: 'RESOLVED', resolution: '更换涂胶泵后恢复。' },
      });
      recordSample(
        'B3.1 updateReferenceDocumentCase（案例更正）',
        {
          operation: 'updateReferenceDocumentCase',
          variables: { id: document.id, input: { handlingStatus: 'RESOLVED' } },
        },
        fixed,
      );
      expectExactKeys(fixed.updateReferenceDocumentCase, ['id', 'updatedAt']);
      expect(fixed.updateReferenceDocumentCase.id).toBe(document.id);
      expectIsoDateString(fixed.updateReferenceDocumentCase.updatedAt);

      // —— B4 更正后回读：明细与正文同步，原件不被重写 ——
      const after = await gqlSuccess(engineerToken, REFERENCE_DOCUMENT_DETAIL_QUERY, {
        id: document.id,
      });
      recordSample(
        'B4.1 referenceDocument（更正后回读）',
        { operation: 'referenceDocument', variables: { id: document.id } },
        after,
      );
      expect(after.referenceDocument.caseDetail).toMatchObject({
        handlingStatus: 'RESOLVED',
        resolution: '更换涂胶泵后恢复。',
      });
      expect(after.referenceDocument.contentText).toContain('处理状态：已解决');
      expect(after.referenceDocument.contentText).toContain('处理结果：\n更换涂胶泵后恢复。');
      expect(fs.readFileSync(path.join(e2eStorageRoot, storageReference)).toString()).toBe(
        attachmentContent,
      );

      // —— B5 案例也不再经审核发布入口（已下线，不重新开放） ——
      const removedDecision = await postGql({
        app,
        query: REMOVED_DECISION_QUERY,
        token: adminToken,
      });
      expect(removedDecision.body.data).toBeUndefined();
      expect(
        (removedDecision.body.errors as Array<{ message: string }>).some((item) =>
          item.message.includes('Cannot query field "reviewContentSubmissionDecision"'),
        ),
      ).toBe(true);
    });
  });
});

// test/11-content-submission/frontend-response-samples.e2e-spec.ts
//
// S7 前端适配真实响应样例与 shape 校验（A-PR0 §S7-1 / §4.4）
//
// 边界声明：
// - 本规格验证「前端 adapter 的操作文本与消费 shape」在真实后端上可调且形状一致。
//   以下 GraphQL 操作文本与 frontend/src/features/content-submission/infrastructure/
//   content-submission-adapter.ts、frontend/src/features/reference-document/infrastructure/
//   reference-document-adapter.ts 逐字一致——前端操作文本变更时必须同步本文件，
//   否则本规格将在真实后端上失败（前端文本与后端契约漂移的告警信号）；
// - 只走真实 HTTP：GraphQL POST /graphql + REST multipart（真实守卫 / 错误过滤器 /
//   事务 / 本地文件存储）；不直接调用 usecase；
// - 每步以 [S7-SAMPLE] 单行 JSON 打印「请求变量 + 完整线上响应」，供交接材料抄录真实样例；
//   设置 S7_SAMPLES_OUT=<path> 时另将全部样例数组落盘（JSON）；
// - 失败样例只取代表路径（未确认告知 / 待审上传 / 白名单外类型 / 终态移除 / 案例接口误用），
//   完整错误矩阵由 content-submission-graphql.e2e-spec.ts 覆盖；
// - 存储隔离：运行级临时上传目录（mkdtemp，先于应用初始化设置 env），结束后按精确路径删除。
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';

import { ApiModule } from '@src/bootstraps/api/api.module';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import {
  buildSuiteOrganizationCodes,
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

const DECISION_MUTATION = `
  mutation ReviewContentSubmissionDecision($input: ReviewContentSubmissionDecisionInput!) {
    reviewContentSubmissionDecision(input: $input) {
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
const FAULT_CASE_DETAIL_KEYS = [
  'title',
  'equipmentModelId',
  'equipmentModelName',
  'equipmentModelText',
  'errorCode',
  'phenomenon',
  'conditionText',
  'reproductionSteps',
  'diagnosis',
  'actionTaken',
  'handlingStatus',
  'resolution',
];
const FAULT_CASE_PAYLOAD_KEYS = [
  'title',
  'equipmentModelId',
  'equipmentModelText',
  'errorCode',
  'phenomenon',
  'conditionText',
  'reproductionSteps',
  'diagnosis',
  'actionTaken',
  'handlingStatus',
  'resolution',
];
const ATTACHMENT_META_KEYS = ['id', 'originalFilename', 'mimeType', 'byteSize', 'uploadedAt'];
const LATEST_REVIEW_KEYS = ['decision', 'comment', 'publishAttachment', 'reviewedAt'];
const PUBLISHED_DOCUMENT_KEYS = ['documentId', 'available'];
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
const REVIEW_HISTORY_ITEM_KEYS = [
  'revisionId',
  'revisionNo',
  'decision',
  'comment',
  'publishAttachment',
  'reviewedAt',
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

    const savedModel = await modelRepository.save(
      modelRepository.create({
        modelCode: 'E2E-S7-MODEL',
        modelName: S7_MODEL_NAME,
        enabled: true,
        sortOrder: 1,
      }),
    );
    s7ModelId = savedModel.id;
    recordOwnedResource(ownership, 'equipmentModel', s7ModelId);

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

  describe('S7-A 普通资料全链（建稿 → 附件 → 送审 → 退回 → 重提 → 发布 → 下载）', () => {
    let materialSubmissionId = 0;
    let attachmentId = 0;
    let v1RevisionId = 0;
    let v2RevisionId = 0;

    const ATTACHMENT_NAME = 's7-sample-attachment.txt';
    const ATTACHMENT_CONTENT = 's7-sample-attachment-bytes-v1';

    // F01：A 链合并在同一 it 内，内部保留 A1–A4 命名步骤；
    // 定向执行 A 链即可独立准备全部前置状态，不依赖兄弟 it 的数据接力。
    it('A 普通资料全链：建稿 → 附件 → 送审 → 退回 → 重提 → 发布 → 下载（单测独立）', async () => {
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

      const detailData = await gqlSuccess(engineerToken, MY_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      recordSample(
        'A1.3 myContentSubmission（改稿后回读）',
        { operation: 'myContentSubmission', variables: { id: materialSubmissionId } },
        detailData,
      );
      const mine = detailData.myContentSubmission;
      expectExactKeys(mine, MY_DETAIL_KEYS);
      expectExactKeys(mine.material, MATERIAL_DETAIL_KEYS);
      expect(mine).toMatchObject({
        id: materialSubmissionId,
        submissionKind: 'MATERIAL',
        status: 'DRAFT',
        currentRevisionNo: 0,
        lastSubmittedAt: null,
        publishedAt: null,
        faultCase: null,
        currentAttachment: null,
        latestReview: null,
        publishedDocument: null,
        material: {
          title: 'S7 样例：光源能量校准作业手册',
          documentType: 'MAINTENANCE_GUIDE',
          equipmentModelId: s7ModelId,
          equipmentModelName: S7_MODEL_NAME,
          equipmentModelText: null,
          description: 'S7 样例说明（已更新）：覆盖年度与季度校准场景。',
          contentText: 'S7 样例如正文 v1：1. 读取能量曲线；2. 执行校准；3. 记录结果。',
        },
      });

      const listData = await gqlSuccess(engineerToken, MY_LIST_QUERY, {
        pagination: PAGINATION,
        filter: { title: '光源能量校准' },
      });
      recordSample(
        'A1.4 myContentSubmissions（标题筛选）',
        {
          operation: 'myContentSubmissions',
          variables: { pagination: PAGINATION, filter: { title: '光源能量校准' } },
        },
        listData,
      );
      const page = listData.myContentSubmissions;
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
      // —— A3 审核链路：队列/详情 → 退回缺意见拒 → 退回 → 版本审核事实 ——

      const queueData = await gqlSuccess(adminToken, REVIEW_LIST_QUERY, {
        pagination: PAGINATION,
        filter: { title: 'S7 样例' },
      });
      recordSample(
        'A3.1 reviewContentSubmissions（审核队列·缺省待审）',
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

      // 退回缺意见：拒绝（前端映射 invalid-input 的代表失败样例）
      const noComment = await postGql({
        app,
        query: DECISION_MUTATION,
        variables: {
          input: {
            submissionId: materialSubmissionId,
            revisionId: v1RevisionId,
            decision: 'RETURN',
          },
        },
        token: adminToken,
      }).expect(200);
      recordSample(
        'A3.3 reviewContentSubmissionDecision 退回缺意见（失败样例）',
        {
          operation: 'reviewContentSubmissionDecision',
          variables: {
            input: {
              submissionId: materialSubmissionId,
              revisionId: v1RevisionId,
              decision: 'RETURN',
            },
          },
        },
        { errors: noComment.body.errors },
      );
      expect(noComment.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(noComment.body.errors[0].extensions.errorCode).toBe(
        'CONTENT_SUBMISSION_INVALID_PARAMS',
      );
      expect(noComment.body.errors[0].message).toContain('退回时必须填写理由');

      // 退回：理由落审核事实，不产生正式资料
      const returnComment = '请补充机型适配说明与校准判据。';
      const returned = await gqlSuccess(adminToken, DECISION_MUTATION, {
        input: {
          submissionId: materialSubmissionId,
          revisionId: v1RevisionId,
          decision: 'RETURN',
          comment: returnComment,
        },
      });
      recordSample(
        'A3.4 reviewContentSubmissionDecision（RETURN）',
        {
          operation: 'reviewContentSubmissionDecision',
          variables: {
            input: {
              submissionId: materialSubmissionId,
              revisionId: v1RevisionId,
              decision: 'RETURN',
              comment: returnComment,
            },
          },
        },
        returned,
      );
      expectExactKeys(returned.reviewContentSubmissionDecision, [
        'submissionId',
        'status',
        'documentId',
      ]);
      expect(returned.reviewContentSubmissionDecision).toMatchObject({
        submissionId: materialSubmissionId,
        status: 'RETURNED',
        documentId: null,
      });

      const returnedMineData = await gqlSuccess(engineerToken, MY_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      recordSample(
        'A3.5 myContentSubmission（退回后·最近审核事实）',
        { operation: 'myContentSubmission', variables: { id: materialSubmissionId } },
        returnedMineData,
      );
      expect(returnedMineData.myContentSubmission.status).toBe('RETURNED');
      expectExactKeys(returnedMineData.myContentSubmission.latestReview, LATEST_REVIEW_KEYS);
      expect(returnedMineData.myContentSubmission.latestReview).toMatchObject({
        decision: 'RETURN',
        comment: returnComment,
        publishAttachment: false,
      });

      const v1ReturnedData = await gqlSuccess(engineerToken, REVISION_QUERY, {
        submissionId: materialSubmissionId,
        revisionNo: 1,
      });
      recordSample(
        'A3.6 contentSubmissionRevision v1（退回事实·历史版本不可变）',
        {
          operation: 'contentSubmissionRevision',
          variables: { submissionId: materialSubmissionId, revisionNo: 1 },
        },
        v1ReturnedData,
      );
      expectExactKeys(v1ReturnedData.contentSubmissionRevision.review, LATEST_REVIEW_KEYS);
      expect(v1ReturnedData.contentSubmissionRevision.review).toMatchObject({
        decision: 'RETURN',
        comment: returnComment,
      });

      // 退回后改稿 → 重提 v2（旧版保留）
      const resubmitPatch = {
        contentText: 'S7 样例正文 v2：1. 读取能量曲线并比对基线；2. 校准后复测；3. 归档记录。',
      };
      const reUpdated = await gqlSuccess(engineerToken, UPDATE_DRAFT_MUTATION, {
        id: materialSubmissionId,
        input: { patch: resubmitPatch },
      });
      recordSample(
        'A3.7 updateContentSubmissionDraft（退回改稿）',
        {
          operation: 'updateContentSubmissionDraft',
          variables: { id: materialSubmissionId, input: { patch: resubmitPatch } },
        },
        reUpdated,
      );
      expect(reUpdated.updateContentSubmissionDraft).toMatchObject({
        id: materialSubmissionId,
        status: 'RETURNED',
      });

      const resubmitted = await gqlSuccess(engineerToken, SUBMIT_MUTATION, {
        id: materialSubmissionId,
        input: { libraryNoticeConfirmed: true },
      });
      recordSample(
        'A3.8 submitContentSubmission（重提冻结 v2）',
        {
          operation: 'submitContentSubmission',
          variables: { id: materialSubmissionId, input: { libraryNoticeConfirmed: true } },
        },
        resubmitted,
      );
      expect(resubmitted.submitContentSubmission).toMatchObject({
        submissionId: materialSubmissionId,
        revisionNo: 2,
        status: 'PENDING_REVIEW',
      });
      v2RevisionId = resubmitted.submitContentSubmission.revisionId;

      const reviewAfterResubmitData = await gqlSuccess(adminToken, REVIEW_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      recordSample(
        'A3.9 reviewContentSubmission（重提后·审核历史一条）',
        { operation: 'reviewContentSubmission', variables: { id: materialSubmissionId } },
        reviewAfterResubmitData,
      );
      const reviewAfterResubmit = reviewAfterResubmitData.reviewContentSubmission;
      expect(reviewAfterResubmit.currentRevision.revisionNo).toBe(2);
      expect(reviewAfterResubmit.reviewHistory).toHaveLength(1);
      expectExactKeys(reviewAfterResubmit.reviewHistory[0], REVIEW_HISTORY_ITEM_KEYS);
      expect(reviewAfterResubmit.reviewHistory[0]).toMatchObject({
        revisionNo: 1,
        decision: 'RETURN',
      });
      // —— A4 通过发布与下载：APPROVE → 发布关联 → REST 下载 → 终态拒再操作 ——

      const approved = await gqlSuccess(adminToken, DECISION_MUTATION, {
        input: {
          submissionId: materialSubmissionId,
          revisionId: v2RevisionId,
          decision: 'APPROVE',
          publishAttachment: true,
        },
      });
      recordSample(
        'A4.1 reviewContentSubmissionDecision（APPROVE·发布附件）',
        {
          operation: 'reviewContentSubmissionDecision',
          variables: {
            input: {
              submissionId: materialSubmissionId,
              revisionId: v2RevisionId,
              decision: 'APPROVE',
              publishAttachment: true,
            },
          },
        },
        approved,
      );
      expect(approved.reviewContentSubmissionDecision).toMatchObject({
        submissionId: materialSubmissionId,
        status: 'PUBLISHED',
      });
      expect(approved.reviewContentSubmissionDecision.documentId).toEqual(expect.any(Number));
      const materialPublishedDocumentId = approved.reviewContentSubmissionDecision
        .documentId as number;

      const publishedMineData = await gqlSuccess(engineerToken, MY_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      recordSample(
        'A4.2 myContentSubmission（发布后·正式资料关联可用）',
        { operation: 'myContentSubmission', variables: { id: materialSubmissionId } },
        publishedMineData,
      );
      const publishedMine = publishedMineData.myContentSubmission;
      expect(publishedMine.status).toBe('PUBLISHED');
      expectIsoDateString(publishedMine.publishedAt);
      expectExactKeys(publishedMine.publishedDocument, PUBLISHED_DOCUMENT_KEYS);
      expect(publishedMine.publishedDocument).toMatchObject({
        documentId: materialPublishedDocumentId,
        available: true,
      });
      expect(publishedMine.latestReview).toMatchObject({ decision: 'APPROVE' });

      const v2Data = await gqlSuccess(engineerToken, REVISION_QUERY, {
        submissionId: materialSubmissionId,
        revisionNo: 2,
      });
      recordSample(
        'A4.3 contentSubmissionRevision v2（获准快照事实）',
        {
          operation: 'contentSubmissionRevision',
          variables: { submissionId: materialSubmissionId, revisionNo: 2 },
        },
        v2Data,
      );
      expect(v2Data.contentSubmissionRevision).toMatchObject({
        revisionId: v2RevisionId,
        revisionNo: 2,
        titleSnapshot: 'S7 样例：光源能量校准作业手册',
      });
      expect(v2Data.contentSubmissionRevision.payloadSnapshot).toMatchObject({
        contentText: 'S7 样例正文 v2：1. 读取能量曲线并比对基线；2. 校准后复测；3. 归档记录。',
      });
      expect(v2Data.contentSubmissionRevision.review).toMatchObject({
        decision: 'APPROVE',
        publishAttachment: true,
      });

      const historyData = await gqlSuccess(adminToken, REVIEW_DETAIL_QUERY, {
        id: materialSubmissionId,
      });
      recordSample(
        'A4.4 reviewContentSubmission（审核历史两条·新在前）',
        { operation: 'reviewContentSubmission', variables: { id: materialSubmissionId } },
        historyData,
      );
      const history = historyData.reviewContentSubmission.reviewHistory;
      expect(history).toHaveLength(2);
      expectExactKeys(history[0], REVIEW_HISTORY_ITEM_KEYS);
      expect(history[0]).toMatchObject({
        revisionNo: 2,
        decision: 'APPROVE',
        publishAttachment: true,
      });
      expect(history[1]).toMatchObject({ revisionNo: 1, decision: 'RETURN' });

      const downloaded = await restDownload(
        engineerToken,
        materialSubmissionId,
        attachmentId,
      ).expect(200);
      recordSample(
        'A4.5 REST GET …/download（发布附件原文）',
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

      // 终态：移除附件被拒（REST 409 代表失败样例）
      const removeAfterPublished = await restRemove(engineerToken, materialSubmissionId).expect(
        409,
      );
      recordSample(
        'A4.6 REST DELETE …/attachment 终态拒绝（失败样例）',
        { method: 'DELETE', path: attachmentPath(materialSubmissionId) },
        removeAfterPublished.body,
      );
      expect(removeAfterPublished.body.data).toMatchObject({
        statusCode: 409,
        code: 'CONTENT_SUBMISSION_STATE_NOT_EDITABLE',
      });

      // 终态：改稿被拒（GraphQL CONFLICT 代表失败样例）
      const editAfterPublished = await postGql({
        app,
        query: UPDATE_DRAFT_MUTATION,
        variables: { id: materialSubmissionId, input: { patch: { title: 'S7 终态改稿' } } },
        token: engineerToken,
      }).expect(200);
      recordSample(
        'A4.7 updateContentSubmissionDraft 终态拒绝（失败样例）',
        {
          operation: 'updateContentSubmissionDraft',
          variables: { id: materialSubmissionId, input: { patch: { title: 'S7 终态改稿' } } },
        },
        { errors: editAfterPublished.body.errors },
      );
      expect(editAfterPublished.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(editAfterPublished.body.errors[0].extensions.errorCode).toBe(
        'CONTENT_SUBMISSION_STATE_NOT_EDITABLE',
      );
    });
  });

  describe('S7-B 案例链路：案例送审发布 → 正式资料读取 → 案例更正（前端消费面）', () => {
    let caseSubmissionId = 0;
    let caseRevisionId = 0;
    let casePublishedDocumentId = 0;

    // F01：B 链合并在同一 it 内，内部保留 B1–B3 命名步骤；
    // 案例更正误用目标由本链自行准备，不消费 A 链的发布结果。
    it('B 案例全链：案例送审发布 → 正式资料读取 → 案例更正（单测独立）', async () => {
      // —— B1 案例建稿/送审/通过：FAULT_CASE 形状与无附件发布 ——
      const caseFields = {
        title: 'S7 样例案例：送料机构周期性偏移',
        equipmentModelId: s7ModelId,
        errorCode: 'E-S7-401',
        phenomenon: '送料机构在连续运行后出现 0.05mm 周期性偏移。',
        conditionText: '连续运行超过 2 小时。',
        reproductionSteps: '1. 空载运行 2 小时；\n2. 测量送料定位偏差。',
        handlingStatus: 'UNRESOLVED',
      };
      const created = await gqlSuccess(engineerToken, CREATE_DRAFT_MUTATION, {
        input: { kind: 'FAULT_CASE', fields: caseFields },
      });
      recordSample(
        'B1.1 createContentSubmissionDraft（FAULT_CASE）',
        {
          operation: 'createContentSubmissionDraft',
          variables: { input: { kind: 'FAULT_CASE', fields: caseFields } },
        },
        created,
      );
      expect(created.createContentSubmissionDraft).toMatchObject({
        submissionKind: 'FAULT_CASE',
        status: 'DRAFT',
      });
      caseSubmissionId = created.createContentSubmissionDraft.id;

      const submitted = await gqlSuccess(engineerToken, SUBMIT_MUTATION, {
        id: caseSubmissionId,
        input: { libraryNoticeConfirmed: true },
      });
      recordSample(
        'B1.2 submitContentSubmission（案例 v1）',
        {
          operation: 'submitContentSubmission',
          variables: { id: caseSubmissionId, input: { libraryNoticeConfirmed: true } },
        },
        submitted,
      );
      expect(submitted.submitContentSubmission).toMatchObject({
        submissionId: caseSubmissionId,
        revisionNo: 1,
        status: 'PENDING_REVIEW',
      });
      caseRevisionId = submitted.submitContentSubmission.revisionId;

      const approved = await gqlSuccess(adminToken, DECISION_MUTATION, {
        input: {
          submissionId: caseSubmissionId,
          revisionId: caseRevisionId,
          decision: 'APPROVE',
          publishAttachment: false,
        },
      });
      recordSample(
        'B1.3 reviewContentSubmissionDecision（案例无附件通过）',
        {
          operation: 'reviewContentSubmissionDecision',
          variables: {
            input: {
              submissionId: caseSubmissionId,
              revisionId: caseRevisionId,
              decision: 'APPROVE',
              publishAttachment: false,
            },
          },
        },
        approved,
      );
      expect(approved.reviewContentSubmissionDecision).toMatchObject({
        submissionId: caseSubmissionId,
        status: 'PUBLISHED',
      });
      expect(approved.reviewContentSubmissionDecision.documentId).toEqual(expect.any(Number));
      casePublishedDocumentId = approved.reviewContentSubmissionDecision.documentId as number;

      const mineData = await gqlSuccess(engineerToken, MY_DETAIL_QUERY, { id: caseSubmissionId });
      recordSample(
        'B1.4 myContentSubmission（案例发布后）',
        { operation: 'myContentSubmission', variables: { id: caseSubmissionId } },
        mineData,
      );
      const mine = mineData.myContentSubmission;
      expectExactKeys(mine.faultCase, FAULT_CASE_DETAIL_KEYS);
      expect(mine).toMatchObject({
        submissionKind: 'FAULT_CASE',
        status: 'PUBLISHED',
        material: null,
        faultCase: {
          title: 'S7 样例案例：送料机构周期性偏移',
          equipmentModelId: s7ModelId,
          equipmentModelName: S7_MODEL_NAME,
          equipmentModelText: null,
          errorCode: 'E-S7-401',
          handlingStatus: 'UNRESOLVED',
        },
        publishedDocument: { documentId: casePublishedDocumentId, available: true },
      });

      const revisionData = await gqlSuccess(engineerToken, REVISION_QUERY, {
        submissionId: caseSubmissionId,
        revisionNo: 1,
      });
      recordSample(
        'B1.5 contentSubmissionRevision（案例获准快照）',
        {
          operation: 'contentSubmissionRevision',
          variables: { submissionId: caseSubmissionId, revisionNo: 1 },
        },
        revisionData,
      );
      const caseRevision = revisionData.contentSubmissionRevision;
      expectExactKeys(caseRevision.payloadSnapshot, FAULT_CASE_PAYLOAD_KEYS);
      expect(caseRevision.attachment).toBeNull();
      expect(caseRevision.review).toMatchObject({ decision: 'APPROVE', publishAttachment: false });
      // —— B2 正式资料读取：列表筛选/案例状态筛选/详情（案例明细与可读正文） ——

      const listData = await gqlSuccess(engineerToken, REFERENCE_DOCUMENTS_QUERY, {
        pagination: PAGINATION,
        filter: { title: '送料机构' },
      });
      recordSample(
        'B2.1 referenceDocuments（标题筛选）',
        {
          operation: 'referenceDocuments',
          variables: { pagination: PAGINATION, filter: { title: '送料机构' } },
        },
        listData,
      );
      const list = listData.referenceDocuments;
      expectExactKeys(list, CS_LIST_PAGE_KEYS);
      expect(list.total).toBe(1);
      expectExactKeys(list.items[0], RD_LIST_ITEM_KEYS);
      expect(list.items[0]).toMatchObject({
        id: casePublishedDocumentId,
        title: 'S7 样例案例：送料机构周期性偏移',
        documentType: 'FAULT_CASE',
        equipmentModelId: s7ModelId,
        equipmentModelName: S7_MODEL_NAME,
        equipmentModelText: null,
        description: null,
        originalFilename: null,
        organizationName: S7_ORG_NAME,
        ingestMethod: 'REVIEWED_SUBMISSION',
        caseHandlingStatus: 'UNRESOLVED',
      });
      expect(typeof list.items[0].creatorNickname).toBe('string');

      const unresolvedListData = await gqlSuccess(engineerToken, REFERENCE_DOCUMENTS_QUERY, {
        pagination: PAGINATION,
        filter: { caseHandlingStatus: 'UNRESOLVED' },
      });
      recordSample(
        'B2.2 referenceDocuments（案例处理状态筛选·未解决）',
        {
          operation: 'referenceDocuments',
          variables: { pagination: PAGINATION, filter: { caseHandlingStatus: 'UNRESOLVED' } },
        },
        unresolvedListData,
      );
      expect(unresolvedListData.referenceDocuments.total).toBe(1);

      const resolvedBeforeListData = await gqlSuccess(engineerToken, REFERENCE_DOCUMENTS_QUERY, {
        pagination: PAGINATION,
        filter: { caseHandlingStatus: 'RESOLVED' },
      });
      recordSample(
        'B2.3 referenceDocuments（案例处理状态筛选·已解决·更正前）',
        {
          operation: 'referenceDocuments',
          variables: { pagination: PAGINATION, filter: { caseHandlingStatus: 'RESOLVED' } },
        },
        resolvedBeforeListData,
      );
      expect(resolvedBeforeListData.referenceDocuments.total).toBe(0);

      const detailData = await gqlSuccess(engineerToken, REFERENCE_DOCUMENT_DETAIL_QUERY, {
        id: casePublishedDocumentId,
      });
      recordSample(
        'B2.4 referenceDocument（案例详情）',
        { operation: 'referenceDocument', variables: { id: casePublishedDocumentId } },
        detailData,
      );
      const detail = detailData.referenceDocument;
      expectExactKeys(detail, RD_DETAIL_KEYS);
      expectExactKeys(detail.caseDetail, RD_CASE_DETAIL_KEYS);
      expect(detail).toMatchObject({
        id: casePublishedDocumentId,
        documentType: 'FAULT_CASE',
        ingestMethod: 'REVIEWED_SUBMISSION',
        hasFile: false,
        mimeType: null,
        organizationName: S7_ORG_NAME,
        caseDetail: {
          errorCode: 'E-S7-401',
          handlingStatus: 'UNRESOLVED',
          phenomenon: '送料机构在连续运行后出现 0.05mm 周期性偏移。',
          conditionText: '连续运行超过 2 小时。',
          reproductionSteps: '1. 空载运行 2 小时；\n2. 测量送料定位偏差。',
          diagnosis: null,
          actionTaken: null,
          resolution: null,
        },
      });
      expect(detail.contentText).toContain('故障现象：');
      expect(detail.contentText).toContain('处理状态：未解决');
      // —— B3 案例更正：patch 生效 → 正文再生成 → 已解决筛选 → 非案例误用拒绝 ——

      const patch = {
        handlingStatus: 'RESOLVED',
        diagnosis: '检查发现送料滚轮磨损导致周期性偏移。',
        actionTaken: '更换送料滚轮并重新标定。',
        resolution: '更换送料滚轮并重新标定后偏移消除。',
      };
      const updatedData = await gqlSuccess(adminToken, UPDATE_REFERENCE_DOCUMENT_CASE_MUTATION, {
        id: casePublishedDocumentId,
        input: patch,
      });
      recordSample(
        'B3.1 updateReferenceDocumentCase（更正·转已解决）',
        {
          operation: 'updateReferenceDocumentCase',
          variables: { id: casePublishedDocumentId, input: patch },
        },
        updatedData,
      );
      expectExactKeys(updatedData.updateReferenceDocumentCase, ['id', 'updatedAt']);
      expect(updatedData.updateReferenceDocumentCase).toMatchObject({
        id: casePublishedDocumentId,
      });
      expectIsoDateString(updatedData.updateReferenceDocumentCase.updatedAt);

      const afterData = await gqlSuccess(adminToken, REFERENCE_DOCUMENT_DETAIL_QUERY, {
        id: casePublishedDocumentId,
      });
      recordSample(
        'B3.2 referenceDocument（更正后·明细与正文再生成）',
        { operation: 'referenceDocument', variables: { id: casePublishedDocumentId } },
        afterData,
      );
      const after = afterData.referenceDocument;
      expect(after.caseDetail).toMatchObject({
        handlingStatus: 'RESOLVED',
        diagnosis: '检查发现送料滚轮磨损导致周期性偏移。',
        actionTaken: '更换送料滚轮并重新标定。',
        resolution: '更换送料滚轮并重新标定后偏移消除。',
      });
      expect(after.contentText).toContain('处理状态：已解决');
      expect(after.contentText).toContain('处理结果：');
      expect(after.contentText).toContain('排查过程：');
      expect(after.contentText).toContain('处理措施：');

      const resolvedListData = await gqlSuccess(adminToken, REFERENCE_DOCUMENTS_QUERY, {
        pagination: PAGINATION,
        filter: { caseHandlingStatus: 'RESOLVED' },
      });
      recordSample(
        'B3.3 referenceDocuments（案例处理状态筛选·已解决·更正后）',
        {
          operation: 'referenceDocuments',
          variables: { pagination: PAGINATION, filter: { caseHandlingStatus: 'RESOLVED' } },
        },
        resolvedListData,
      );
      expect(resolvedListData.referenceDocuments.total).toBe(1);

      // F01：非案例目标由本链自行创建并发布，不消费 A 链的 materialPublishedDocumentId。
      const misuseDraft = await gqlSuccess(engineerToken, CREATE_DRAFT_MUTATION, {
        input: {
          kind: 'MATERIAL',
          fields: {
            title: 'S7 样例：非案例误用准备稿',
            documentType: 'MAINTENANCE_GUIDE',
            contentText: '用于案例接口误用拒绝的普通资料。',
          },
        },
      });
      const misuseSubmissionId = misuseDraft.createContentSubmissionDraft.id as number;
      const misuseSubmitted = await gqlSuccess(engineerToken, SUBMIT_MUTATION, {
        id: misuseSubmissionId,
        input: { libraryNoticeConfirmed: true },
      });
      const misuseApproved = await gqlSuccess(adminToken, DECISION_MUTATION, {
        input: {
          submissionId: misuseSubmissionId,
          revisionId: misuseSubmitted.submitContentSubmission.revisionId,
          decision: 'APPROVE',
          publishAttachment: false,
        },
      });
      const materialPublishedDocumentId = misuseApproved.reviewContentSubmissionDecision
        .documentId as number;

      // 非案例资料误用案例更正：拒绝（前端映射 invalid-input 的代表失败样例）
      const misuse = await postGql({
        app,
        query: UPDATE_REFERENCE_DOCUMENT_CASE_MUTATION,
        variables: {
          id: materialPublishedDocumentId,
          input: { handlingStatus: 'RESOLVED', resolution: '误用样例' },
        },
        token: adminToken,
      }).expect(200);
      recordSample(
        'B3.4 updateReferenceDocumentCase 非案例误用（失败样例）',
        {
          operation: 'updateReferenceDocumentCase',
          variables: {
            id: materialPublishedDocumentId,
            input: { handlingStatus: 'RESOLVED', resolution: '误用样例' },
          },
        },
        { errors: misuse.body.errors },
      );
      expect(misuse.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(misuse.body.errors[0].extensions.errorCode).toBe('REFERENCE_DOCUMENT_INVALID_PARAMS');
      expect(misuse.body.errors[0].message).toContain('仅故障案例资料可以使用案例更正接口');
    });
  });
});

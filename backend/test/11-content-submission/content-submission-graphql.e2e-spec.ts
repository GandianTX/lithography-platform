// test/11-content-submission/content-submission-graphql.e2e-spec.ts
//
// 投稿域 GraphQL/REST 端点级验收（A-PR0 S7：协议装配后的真实请求验收）
//
// 任务 07 收口（2026-11-20）：资料审核决定写路径（reviewContentSubmissionDecision）
// 已按确认需求移除。原「退回→重提→发布→下载」链路断言改为：
// - 待审读取、附件下载、待审拒改/拒重复送审继续按真实行为验收；
// - 决定入口改为「schema 不再接受」负例（内联字面量，不引用已移除的输入类型）；
// - 发布产物（正式资料）不再由审核产生，改由 12/09 规格的受控夹具覆盖。
//
// 边界声明：本规格只通过真实 HTTP 请求验证协议装配后的行为——GraphQL POST /graphql
// 与 REST multipart（/api/content-submissions/:id/attachment 等），请求链路含真实
// 守卫（JwtAuthGuard/RolesGuard）、真实错误过滤器（extensions.code/errorCode 契约）、
// 真实事务与本地文件存储；不直接调用 usecase（内部行为已由同目录
// content-submission-integration.e2e-spec.ts 覆盖）。响应 shape 是本规格的验收对象，
// 也供前端适配（A-PR0 §4.4）以真实样例对齐。
//
// 存储隔离：本规格使用运行级临时上传目录（mkdtemp，先于应用初始化设置 env），
// 结束后按精确路径删除本测试拥有的目录与数据，不污染默认 var/。
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';

import { ApiModule } from '@src/bootstraps/api/api.module';
import { ContentSubmissionAttachmentEntity } from '@src/modules/lithography/entities/content-submission-attachment.entity';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
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
const e2eStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contsub-gql-storage-'));
process.env.REFERENCE_DOCUMENT_STORAGE_DIR = e2eStorageRoot;

jest.setTimeout(60000);

// —— GraphQL 操作（选择集与 DTO 契约逐字段对齐；端点级验收的真实调用样例） ——

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

type GqlError = { message: string; extensions: Record<string, unknown> };

describe('投稿域 GraphQL/REST 端点验收 (S7)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let attachmentRepository: Repository<ContentSubmissionAttachmentEntity>;

  // 规格专属测试组织（不借用开发库默认组织；编码带 E2E 前缀，清理以编码为界）
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('CONTSUBGM');
  const ownership = createOwnedResourceLedger();

  let engineerToken: string;
  let secondEngineerToken: string;
  let adminToken: string;
  let peerAdminToken: string;
  let guestToken: string;
  let engineerAccountId = 0;

  const storageFiles = (): string[] =>
    fs.existsSync(e2eStorageRoot) ? fs.readdirSync(e2eStorageRoot).sort() : [];

  const expectGqlError = (
    error: GqlError | undefined,
    expected: { code: string; errorCode: string; messageContains?: string },
  ): void => {
    if (!error) {
      throw new Error('期望 GraphQL 错误，但响应中没有 errors');
    }
    expect(error.extensions.code).toBe(expected.code);
    expect(error.extensions.errorCode).toBe(expected.errorCode);
    if (expected.messageContains) {
      expect(error.message).toContain(expected.messageContains);
    }
  };

  const expectUnauthenticated = (error: GqlError | undefined): void => {
    expectGqlError(error, { code: 'UNAUTHENTICATED', errorCode: 'JWT_AUTHENTICATION_FAILED' });
  };

  const expectForbidden = (
    error: GqlError | undefined,
    requiredRoles: string[],
    userRoles: string[],
  ): void => {
    if (!error) {
      throw new Error('期望 GraphQL 错误，但响应中没有 errors');
    }
    expect(error.message).toContain('缺少所需角色');
    expect(error.extensions.code).toBe('FORBIDDEN');
    expect(error.extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
    expect(error.extensions.details).toMatchObject({ requiredRoles, userRoles });
  };

  const expectStateConflict = (error: GqlError | undefined): void => {
    expectGqlError(error, {
      code: 'CONFLICT',
      errorCode: 'CONTENT_SUBMISSION_STATE_NOT_EDITABLE',
    });
  };

  const expectNotFound = (error: GqlError | undefined): void => {
    expectGqlError(error, { code: 'NOT_FOUND', errorCode: 'CONTENT_SUBMISSION_NOT_FOUND' });
  };

  // —— REST 附件边界请求封装（multipart 走真实 multer 解析） ——

  const restUpload = (
    token: string | null,
    submissionId: number,
    fileName: string,
    content: string,
  ) => {
    const req = request(app.getHttpServer()).post(
      `/api/content-submissions/${submissionId}/attachment`,
    );
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req.attach('file', Buffer.from(content), fileName);
  };

  const restRemove = (token: string | null, submissionId: number) => {
    const req = request(app.getHttpServer()).delete(
      `/api/content-submissions/${submissionId}/attachment`,
    );
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  };

  const restDownload = (token: string, submissionId: number, attachmentId: number) =>
    request(app.getHttpServer())
      .get(`/api/content-submissions/${submissionId}/attachments/${attachmentId}/download`)
      .set('Authorization', `Bearer ${token}`);

  // —— GraphQL 便捷调用（成功路径统一断言无 errors） ——

  const PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true };

  const createDraft = async (token: string, input: unknown) => {
    const response = await postGql({
      app,
      query: CREATE_DRAFT_MUTATION,
      variables: { input },
      token,
    }).expect(200);
    expect(response.body.errors).toBeUndefined();
    return response.body.data.createContentSubmissionDraft as {
      id: number;
      submissionKind: string;
      status: string;
      updatedAt: string;
    };
  };

  const submitSubmission = async (token: string, id: number) => {
    const response = await postGql({
      app,
      query: SUBMIT_MUTATION,
      variables: { id, input: { libraryNoticeConfirmed: true } },
      token,
    }).expect(200);
    expect(response.body.errors).toBeUndefined();
    return response.body.data.submitContentSubmission as {
      submissionId: number;
      revisionId: number;
      revisionNo: number;
      status: string;
    };
  };

  const fetchMyDetail = async (token: string, id: number) => {
    const response = await postGql({
      app,
      query: MY_DETAIL_QUERY,
      variables: { id },
      token,
    }).expect(200);
    expect(response.body.errors).toBeUndefined();
    return response.body.data.myContentSubmission;
  };

  const fetchRevision = async (token: string, submissionId: number, revisionNo: number) => {
    const response = await postGql({
      app,
      query: REVISION_QUERY,
      variables: { submissionId, revisionNo },
      token,
    }).expect(200);
    expect(response.body.errors).toBeUndefined();
    return response.body.data.contentSubmissionRevision;
  };

  const listReviewQueue = async (token: string, filter?: unknown) => {
    const response = await postGql({
      app,
      query: REVIEW_LIST_QUERY,
      variables:
        filter === undefined ? { pagination: PAGINATION } : { pagination: PAGINATION, filter },
      token,
    }).expect(200);
    expect(response.body.errors).toBeUndefined();
    return response.body.data.reviewContentSubmissions as {
      items: Array<{ id: number; status: string; currentRevisionNo: number }>;
      total: number;
    };
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);

    attachmentRepository = dataSource.getRepository(ContentSubmissionAttachmentEntity);

    await app.init();

    // 预清理：组织/账号均按完整指纹回收已知残留；投稿/资料链由本轮 owned 组织/账号预检圈定
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: [
          {
            organizationCode: suiteOrganizationCodes.primary,
            name: '投稿端点验收甲方组织',
            kind: 'CLIENT',
          },
          {
            organizationCode: suiteOrganizationCodes.peer,
            name: '投稿端点验收第二组织',
            kind: 'PEER',
          },
        ],
        accounts: [
          testAccountsConfig.staffPrimary,
          testAccountsConfig.staffSecondary,
          testAccountsConfig.admin,
          testAccountsConfig.peerAdmin,
          testAccountsConfig.guestPrimary,
        ].map(toResidueAccountFingerprint),
      },
      helper: 'content-submission-graphql.e2e-spec beforeAll 预清理',
    });

    await seedTestAccounts({
      dataSource,
      includeKeys: ['staffPrimary', 'staffSecondary', 'admin', 'peerAdmin', 'guestPrimary'],
      ownership,
    });

    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: '投稿端点验收甲方组织',
          kind: 'CLIENT',
        },
        {
          organizationCode: suiteOrganizationCodes.peer,
          name: '投稿端点验收第二组织',
          kind: 'PEER',
        },
      ],
      ownership,
    });
    await seedTestMemberships({
      dataSource,
      memberships: [
        {
          accountLoginName: testAccountsConfig.staffPrimary.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: testAccountsConfig.staffSecondary.loginName,
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

    engineerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staffPrimary.loginName,
    );

    engineerToken = await login({
      app,
      loginName: testAccountsConfig.staffPrimary.loginName,
      loginPassword: testAccountsConfig.staffPrimary.loginPassword,
    });
    secondEngineerToken = await login({
      app,
      loginName: testAccountsConfig.staffSecondary.loginName,
      loginPassword: testAccountsConfig.staffSecondary.loginPassword,
    });
    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    peerAdminToken = await login({
      app,
      loginName: testAccountsConfig.peerAdmin.loginName,
      loginPassword: testAccountsConfig.peerAdmin.loginPassword,
    });
    guestToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (dataSource?.isInitialized) {
          await runGuardedSpecCleanup({
            dataSource,
            owned: ownership,
            helper: 'content-submission-graphql.e2e-spec afterAll 收尾',
          });
        }
      },
      finalize: () => {
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

  describe('V-S7-1 普通资料全链（真实 GraphQL/REST）', () => {
    let submissionId = 0;
    let attachmentId = 0;
    let v1RevisionId = 0;

    const ATTACHMENT_NAME = 'v-s7-1-report.txt';
    const ATTACHMENT_CONTENT = 'v-s7-1-attachment-bytes';

    // F01：整条资料链合并在同一 it 内，内部按 a/b/c/d 命名步骤划分。
    // 定向执行 V-S7-1 即可独立完成全部前置状态准备，不依赖兄弟 it 的数据接力。
    it('V-S7-1 普通资料链路：草稿 → 附件送审 → 待审读取（单测独立）', async () => {
      // —— V-S7-1a 草稿链路：匿名拒 → 建稿 → 改稿 → 本人列表/详情（真实 GraphQL） ——
      // 匿名建稿：鉴权失败不进入业务层
      const anonymous = await postGql({
        app,
        query: CREATE_DRAFT_MUTATION,
        variables: { input: { kind: 'MATERIAL', fields: { title: 'V-S7-1 匿名稿' } } },
      }).expect(200);
      expectUnauthenticated(anonymous.body.errors[0]);

      // 工程师建稿：创建人/组织/状态一律由服务端裁定
      const created = await createDraft(engineerToken, {
        kind: 'MATERIAL',
        fields: {
          title: 'V-S7-1 投稿：光源校准作业手册',
          documentType: 'MAINTENANCE_GUIDE',
          contentText: 'V-S7-1 初始正文：校准步骤一、二、三。',
          equipmentModelText: 'V-S7-1 机型（初稿）',
        },
      });
      expect(created).toMatchObject({ submissionKind: 'MATERIAL', status: 'DRAFT' });
      expect(created.updatedAt).toEqual(expect.any(String));
      submissionId = created.id;

      // 改稿：patch 只含 description，未提供字段保持原值
      const updated = await postGql({
        app,
        query: UPDATE_DRAFT_MUTATION,
        variables: {
          id: submissionId,
          input: { patch: { description: 'V-S7-1 说明：适用于年度校准场景。' } },
        },
        token: engineerToken,
      }).expect(200);
      expect(updated.body.errors).toBeUndefined();
      expect(updated.body.data.updateContentSubmissionDraft).toMatchObject({
        id: submissionId,
        status: 'DRAFT',
      });

      // 本人详情：普通资料明细非空、案例明细为空、无附件/无审核/无发布关联
      const detail = await fetchMyDetail(engineerToken, submissionId);
      expect(detail).toMatchObject({
        id: submissionId,
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
          title: 'V-S7-1 投稿：光源校准作业手册',
          documentType: 'MAINTENANCE_GUIDE',
          equipmentModelId: null,
          equipmentModelName: null,
          equipmentModelText: 'V-S7-1 机型（初稿）',
          description: 'V-S7-1 说明：适用于年度校准场景。',
          contentText: 'V-S7-1 初始正文：校准步骤一、二、三。',
        },
      });

      // 本人列表：标题筛选命中且仅本人记录
      const listResponse = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: PAGINATION, filter: { title: 'V-S7-1' } },
        token: engineerToken,
      }).expect(200);
      expect(listResponse.body.errors).toBeUndefined();
      const list = listResponse.body.data.myContentSubmissions;
      expect(list.total).toBe(1);
      expect(list.items[0]).toMatchObject({
        id: submissionId,
        title: 'V-S7-1 投稿：光源校准作业手册',
        submissionKind: 'MATERIAL',
        status: 'DRAFT',
        currentRevisionNo: 0,
        lastSubmittedAt: null,
      });
      // —— V-S7-1b 附件上传与送审：REST multipart → 详情回读 → 冻结 v1 → 状态拒改 ——

      // REST 上传（multipart）：返回附件安全元数据（无存储引用）
      const uploaded = await restUpload(
        engineerToken,
        submissionId,
        ATTACHMENT_NAME,
        ATTACHMENT_CONTENT,
      ).expect(201);
      expect(uploaded.body.data).toMatchObject({
        originalFilename: ATTACHMENT_NAME,
        mimeType: 'text/plain',
        byteSize: Buffer.byteLength(ATTACHMENT_CONTENT),
      });
      attachmentId = uploaded.body.data.attachmentId as number;
      expect(attachmentId).toEqual(expect.any(Number));

      // 库事实：附件行为 CURRENT、存储引用在库可见（GraphQL 只暴露安全元数据）
      const attachmentRow = await attachmentRepository.findOneByOrFail({ id: attachmentId });
      expect(attachmentRow).toMatchObject({
        submissionId,
        status: 'CURRENT',
        originalFilename: ATTACHMENT_NAME,
        mimeType: 'text/plain',
      });
      expect(attachmentRow.storageReference).toMatch(/\.txt$/);

      // 详情回读当前附件
      const detailWithAttachment = await fetchMyDetail(engineerToken, submissionId);
      expect(detailWithAttachment.currentAttachment).toMatchObject({
        id: attachmentId,
        originalFilename: ATTACHMENT_NAME,
        mimeType: 'text/plain',
        byteSize: Buffer.byteLength(ATTACHMENT_CONTENT),
      });

      // 送审：从已保存稿冻结 v1；状态由服务端裁定
      const submitted = await submitSubmission(engineerToken, submissionId);
      expect(submitted).toMatchObject({
        submissionId,
        revisionNo: 1,
        status: 'PENDING_REVIEW',
      });
      v1RevisionId = submitted.revisionId;

      // 冻结版本读取：6 字段完整快照 + 附件元数据 + 告知版本
      const revision = await fetchRevision(engineerToken, submissionId, 1);
      expect(revision).toMatchObject({
        revisionId: v1RevisionId,
        submissionId,
        submissionKind: 'MATERIAL',
        revisionNo: 1,
        schemaVersion: 1,
        titleSnapshot: 'V-S7-1 投稿：光源校准作业手册',
        attachment: {
          id: attachmentId,
          originalFilename: ATTACHMENT_NAME,
          mimeType: 'text/plain',
        },
        review: null,
      });
      expect(revision.noticeVersion).toEqual(expect.any(String));
      expect(revision.payloadSnapshot).toMatchObject({
        title: 'V-S7-1 投稿：光源校准作业手册',
        documentType: 'MAINTENANCE_GUIDE',
        equipmentModelId: null,
        equipmentModelText: 'V-S7-1 机型（初稿）',
        description: 'V-S7-1 说明：适用于年度校准场景。',
        contentText: 'V-S7-1 初始正文：校准步骤一、二、三。',
      });

      // 本人详情：待审状态与版本信息
      const mine = await fetchMyDetail(engineerToken, submissionId);
      expect(mine).toMatchObject({
        status: 'PENDING_REVIEW',
        currentRevisionNo: 1,
        latestReview: null,
      });
      expect(mine.lastSubmittedAt).toEqual(expect.any(String));

      // 待审中改稿拒绝：PENDING_REVIEW 只读
      const editPending = await postGql({
        app,
        query: UPDATE_DRAFT_MUTATION,
        variables: { id: submissionId, input: { patch: { title: 'V-S7-1 待审改稿' } } },
        token: engineerToken,
      }).expect(200);
      expectStateConflict(editPending.body.errors[0]);

      // 重复送审拒绝：待审状态不可再送审
      const resubmitPending = await postGql({
        app,
        query: SUBMIT_MUTATION,
        variables: { id: submissionId, input: { libraryNoticeConfirmed: true } },
        token: engineerToken,
      }).expect(200);
      expectStateConflict(resubmitPending.body.errors[0]);
      // —— V-S7-1c 待审读取：队列/详情（只读路径保留） ——
      const queue = await listReviewQueue(adminToken, { title: 'V-S7-1' });
      expect(queue.total).toBe(1);
      expect(queue.items[0]).toMatchObject({
        id: submissionId,
        status: 'PENDING_REVIEW',
        currentRevisionNo: 1,
      });

      // 审核详情：投稿人账号 ID 仅审核链路返回；历史审核为空
      const reviewDetailResponse = await postGql({
        app,
        query: REVIEW_DETAIL_QUERY,
        variables: { id: submissionId },
        token: adminToken,
      }).expect(200);
      expect(reviewDetailResponse.body.errors).toBeUndefined();
      const reviewDetail = reviewDetailResponse.body.data.reviewContentSubmission;
      expect(reviewDetail).toMatchObject({
        submissionId,
        submissionKind: 'MATERIAL',
        status: 'PENDING_REVIEW',
        currentRevisionNo: 1,
        submittedByAccountId: engineerAccountId,
      });
      expect(reviewDetail.currentRevision.revisionNo).toBe(1);
      expect(reviewDetail.reviewHistory).toHaveLength(0);

      // —— V-S7-1d 审核决定入口已下线：协议层拒绝，投稿保持待审且不生成正式资料 ——
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

      const mineAfterRemoved = await fetchMyDetail(engineerToken, submissionId);
      expect(mineAfterRemoved).toMatchObject({
        status: 'PENDING_REVIEW',
        currentRevisionNo: 1,
        latestReview: null,
        publishedDocument: null,
        publishedAt: null,
      });
      expect(mineAfterRemoved.lastSubmittedAt).toEqual(expect.any(String));

      // 投稿未产生任何正式资料（旧发布链路的唯一产物）
      const publishedRows = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM reference_document
          WHERE source_submission_id = ? OR source_revision_id = ?`,
        [submissionId, String(v1RevisionId)],
      );
      expect(Number(publishedRows[0]?.total)).toBe(0);

      // 待审仍可下载原件：本人与同组织管理员均成功，字节一致
      const downloadedByEngineer = await restDownload(
        engineerToken,
        submissionId,
        attachmentId,
      ).expect(200);
      expect(downloadedByEngineer.headers['content-type']).toContain('text/plain');
      expect(downloadedByEngineer.headers['content-disposition']).toContain(
        `filename*=UTF-8''${ATTACHMENT_NAME}`,
      );
      expect(downloadedByEngineer.text).toBe(ATTACHMENT_CONTENT);
      await restDownload(adminToken, submissionId, attachmentId).expect(200);

      // 待审拒再操作：重复送审与改稿均状态冲突
      const resubmit = await postGql({
        app,
        query: SUBMIT_MUTATION,
        variables: { id: submissionId, input: { libraryNoticeConfirmed: true } },
        token: engineerToken,
      }).expect(200);
      expectStateConflict(resubmit.body.errors[0]);

      const reEdit = await postGql({
        app,
        query: UPDATE_DRAFT_MUTATION,
        variables: { id: submissionId, input: { patch: { title: 'V-S7-1 待审改稿' } } },
        token: engineerToken,
      }).expect(200);
      expectStateConflict(reEdit.body.errors[0]);
    });
  });

  describe('V-S7-2 故障案例链路与输入契约（真实 GraphQL）', () => {
    let faultCaseSubmissionId = 0;

    it('V-S7-2a 输入契约：跨类别字段拒 / 空草稿拒 / 送审完整性拒 / RESOLVED 结果必填', async () => {
      // 普通资料传案例字段：非空即拒
      const crossKind = await postGql({
        app,
        query: CREATE_DRAFT_MUTATION,
        variables: {
          input: { kind: 'MATERIAL', fields: { title: 'V-S7-2 跨类别', errorCode: 'E-1' } },
        },
        token: engineerToken,
      }).expect(200);
      expectGqlError(crossKind.body.errors[0], {
        code: 'BAD_USER_INPUT',
        errorCode: 'CONTENT_SUBMISSION_INVALID_PARAMS',
        messageContains: '不属于投稿类别',
      });

      // 空草稿（无任何已填写文字字段）：拒绝
      const emptyDraft = await postGql({
        app,
        query: CREATE_DRAFT_MUTATION,
        variables: { input: { kind: 'FAULT_CASE', fields: {} } },
        token: engineerToken,
      }).expect(200);
      expectGqlError(emptyDraft.body.errors[0], {
        code: 'BAD_USER_INPUT',
        errorCode: 'CONTENT_SUBMISSION_DRAFT_EMPTY',
      });

      // 已解决但无处理结果：草稿期即拒（与数据库 CHECK 同口径）
      const resolvedWithoutResult = await postGql({
        app,
        query: CREATE_DRAFT_MUTATION,
        variables: {
          input: {
            kind: 'FAULT_CASE',
            fields: {
              title: 'V-S7-2 已解决无结果',
              handlingStatus: 'RESOLVED',
              phenomenon: '异常。',
              reproductionSteps: '步骤。',
            },
          },
        },
        token: engineerToken,
      }).expect(200);
      expectGqlError(resolvedWithoutResult.body.errors[0], {
        code: 'BAD_USER_INPUT',
        errorCode: 'CONTENT_SUBMISSION_INVALID_PARAMS',
        messageContains: '必须填写处理结果',
      });

      // 送审前完整性：仅标题的案例稿直接送审被拒
      const minimal = await createDraft(engineerToken, {
        kind: 'FAULT_CASE',
        fields: { title: 'V-S7-2 未完整案例稿' },
      });
      const incompleteSubmit = await postGql({
        app,
        query: SUBMIT_MUTATION,
        variables: { id: minimal.id, input: { libraryNoticeConfirmed: true } },
        token: engineerToken,
      }).expect(200);
      expectGqlError(incompleteSubmit.body.errors[0], {
        code: 'BAD_USER_INPUT',
        errorCode: 'CONTENT_SUBMISSION_DRAFT_EMPTY',
        messageContains: '故障现象',
      });

      // 未确认入库告知：送审拒绝
      const noNotice = await postGql({
        app,
        query: SUBMIT_MUTATION,
        variables: { id: minimal.id, input: { libraryNoticeConfirmed: false } },
        token: engineerToken,
      }).expect(200);
      expectGqlError(noNotice.body.errors[0], {
        code: 'BAD_USER_INPUT',
        errorCode: 'CONTENT_SUBMISSION_INVALID_PARAMS',
      });
    });

    it('V-S7-2b 案例链路：建稿 → 送审 v1 → 待审读取（审核入口已下线）', async () => {
      const created = await createDraft(engineerToken, {
        kind: 'FAULT_CASE',
        fields: {
          title: 'V-S7-2 案例：真空泵压力异常',
          equipmentModelText: 'V-S7-2 机型',
          errorCode: 'V-S7-2-ERR-9',
          phenomenon: '真空泵压力在批次间波动。',
          conditionText: '连续运行超过 30 分钟。',
          reproductionSteps: '1. 空载抽真空；\n2. 记录压力曲线。',
          handlingStatus: 'UNRESOLVED',
        },
      });
      expect(created).toMatchObject({ submissionKind: 'FAULT_CASE', status: 'DRAFT' });
      faultCaseSubmissionId = created.id;

      const submitted = await submitSubmission(engineerToken, faultCaseSubmissionId);
      expect(submitted).toMatchObject({
        submissionId: faultCaseSubmissionId,
        revisionNo: 1,
        status: 'PENDING_REVIEW',
      });

      // 队列缺省待审命中
      const queue = await listReviewQueue(adminToken, { title: 'V-S7-2 案例' });
      expect(queue.total).toBe(1);
      expect(queue.items[0]).toMatchObject({ id: faultCaseSubmissionId, status: 'PENDING_REVIEW' });

      // 审核决定入口已下线：案例同样不能经此发布（不重新开放）
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

      // 冻结版本：11 字段完整快照（显式列举）
      const revision = await fetchRevision(engineerToken, faultCaseSubmissionId, 1);
      expect(revision).toMatchObject({
        submissionKind: 'FAULT_CASE',
        revisionNo: 1,
        titleSnapshot: 'V-S7-2 案例：真空泵压力异常',
        attachment: null,
      });
      expect(revision.payloadSnapshot).toMatchObject({
        title: 'V-S7-2 案例：真空泵压力异常',
        equipmentModelId: null,
        equipmentModelText: 'V-S7-2 机型',
        errorCode: 'V-S7-2-ERR-9',
        phenomenon: '真空泵压力在批次间波动。',
        conditionText: '连续运行超过 30 分钟。',
        reproductionSteps: '1. 空载抽真空；\n2. 记录压力曲线。',
        diagnosis: null,
        actionTaken: null,
        handlingStatus: 'UNRESOLVED',
        resolution: null,
      });

      // 仍待审：队列标题筛选继续命中（未被任何审核决定改变）
      const queueAfter = await listReviewQueue(adminToken, { title: 'V-S7-2 案例' });
      expect(queueAfter.total).toBe(1);
      expect(queueAfter.items[0]).toMatchObject({
        id: faultCaseSubmissionId,
        status: 'PENDING_REVIEW',
      });

      // 本人列表：类别 + 状态（待审）筛选命中
      const listResponse = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: {
          pagination: PAGINATION,
          filter: { title: 'V-S7-2 案例', submissionKind: 'FAULT_CASE', status: 'PENDING_REVIEW' },
        },
        token: engineerToken,
      }).expect(200);
      const list = listResponse.body.data.myContentSubmissions;
      expect(list.total).toBe(1);
      expect(list.items[0]).toMatchObject({ id: faultCaseSubmissionId, status: 'PENDING_REVIEW' });

      // 未生成正式资料
      const publishedRows = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM reference_document
          WHERE source_submission_id = ? OR source_revision_id = ?`,
        [faultCaseSubmissionId, String(submitted.revisionId)],
      );
      expect(Number(publishedRows[0]?.total)).toBe(0);
    });
  });

  describe('V-S7-3 权限边界与 REST 附件错误契约', () => {
    let boundaryDraftId = 0;

    it('V-S7-3a GraphQL 权限边界：客户拒 / 匿名拒 / 决定入口已移除 / 他人与跨组织统一 NOT_FOUND', async () => {
      // 客户（非投稿角色）：守卫拒绝
      const guestList = await postGql({
        app,
        query: MY_LIST_QUERY,
        variables: { pagination: PAGINATION },
        token: guestToken,
      }).expect(200);
      expectForbidden(guestList.body.errors[0], ['ENGINEER'], ['CUSTOMER']);

      // 匿名：鉴权失败
      const anonymousDetail = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: 1 },
      }).expect(200);
      expectUnauthenticated(anonymousDetail.body.errors[0]);

      // 工程师调审核链路（队列/决定）：守卫拒绝
      const engineerQueue = await postGql({
        app,
        query: REVIEW_LIST_QUERY,
        variables: { pagination: PAGINATION },
        token: engineerToken,
      }).expect(200);
      expectForbidden(engineerQueue.body.errors[0], ['SUPER_ADMIN'], ['ENGINEER']);

      // 工程师调审核决定：入口已从 schema 移除（连角色校验都不再进入）
      const engineerDecide = await postGql({
        app,
        query: REMOVED_DECISION_QUERY,
        token: engineerToken,
      });
      expect(engineerDecide.body.data).toBeUndefined();
      expect(
        (engineerDecide.body.errors as Array<{ message: string }>).some((item) =>
          item.message.includes('Cannot query field "reviewContentSubmissionDecision"'),
        ),
      ).toBe(true);

      // F01：本用例自行准备「真实存在」的目标投稿及版本，不消费兄弟 it 的发布结果。
      const boundaryTarget = await createDraft(engineerToken, {
        kind: 'MATERIAL',
        fields: {
          title: 'V-S7-3 权限边界目标稿',
          documentType: 'MAINTENANCE_GUIDE',
          contentText: '权限边界目标正文。',
        },
      });
      const boundaryTargetSubmitted = await submitSubmission(engineerToken, boundaryTarget.id);
      expect(boundaryTargetSubmitted).toMatchObject({
        submissionId: boundaryTarget.id,
        revisionNo: 1,
        status: 'PENDING_REVIEW',
      });

      // 同组织其他工程师读他人投稿（真实存在且已有 v1）：统一 NOT_FOUND（不泄露存在性）
      const otherEngineerDetail = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: boundaryTarget.id },
        token: secondEngineerToken,
      }).expect(200);
      expectNotFound(otherEngineerDetail.body.errors[0]);

      // 跨组织管理员读审核详情/版本：统一 NOT_FOUND
      const peerReviewDetail = await postGql({
        app,
        query: REVIEW_DETAIL_QUERY,
        variables: { id: boundaryTarget.id },
        token: peerAdminToken,
      }).expect(200);
      expectNotFound(peerReviewDetail.body.errors[0]);

      const peerRevision = await postGql({
        app,
        query: REVISION_QUERY,
        variables: { submissionId: boundaryTarget.id, revisionNo: 1 },
        token: peerAdminToken,
      }).expect(200);
      expectNotFound(peerRevision.body.errors[0]);
    });

    it('V-S7-3b REST 附件边界：客户 403 / 匿名 401 / 非本人 404 / 白名单外 415 不触盘 / 无附件移除幂等 / 待审移除 409', async () => {
      // 建一个待编辑草稿作为上传目标
      const draft = await createDraft(engineerToken, {
        kind: 'MATERIAL',
        fields: {
          title: 'V-S7-3 附件边界稿',
          documentType: 'MAINTENANCE_GUIDE',
          contentText: '边界测试正文。',
        },
      });
      boundaryDraftId = draft.id;

      // 客户：守卫拒绝（403 + REST 统一错误体）
      const guestUpload = await restUpload(guestToken, boundaryDraftId, 'v-s7-3.txt', 'x').expect(
        403,
      );
      expect(guestUpload.body.data).toMatchObject({
        statusCode: 403,
        code: 'INSUFFICIENT_PERMISSIONS',
      });

      // 匿名：鉴权失败
      const anonymousUpload = await restUpload(null, boundaryDraftId, 'v-s7-3.txt', 'x').expect(
        401,
      );
      expect(anonymousUpload.body.data).toMatchObject({
        statusCode: 401,
        code: 'JWT_AUTHENTICATION_FAILED',
      });

      // 同组织其他工程师：非本人投稿统一 NOT_FOUND
      const otherUpload = await restUpload(
        secondEngineerToken,
        boundaryDraftId,
        'v-s7-3.txt',
        'x',
      ).expect(404);
      expect(otherUpload.body.data).toMatchObject({
        statusCode: 404,
        code: 'CONTENT_SUBMISSION_NOT_FOUND',
      });

      // 白名单外扩展名：以扩展名为主判定；拒绝先于文件 I/O，不触盘
      const filesBefore = storageFiles();
      const evilUpload = await restUpload(
        engineerToken,
        boundaryDraftId,
        'v-s7-3-evil.exe',
        'MZ',
      ).expect(415);
      expect(evilUpload.body.data).toMatchObject({
        statusCode: 415,
        code: 'CONTENT_SUBMISSION_UPLOAD_FILE_TYPE_NOT_ALLOWED',
      });
      expect(storageFiles()).toEqual(filesBefore);

      // 无当前附件时移除：幂等成功
      await restRemove(engineerToken, boundaryDraftId).expect(204);

      // F01：自行创建一个已送审投稿作为「不可再编辑」目标，不依赖兄弟 it 的结果。
      // 发布链路已下线，故以 PENDING_REVIEW 作为只读终态验证附件移除拒绝。
      const terminalTarget = await createDraft(engineerToken, {
        kind: 'MATERIAL',
        fields: {
          title: 'V-S7-3 只读态附件稿',
          documentType: 'MAINTENANCE_GUIDE',
          contentText: '只读态附件正文。',
        },
      });
      await submitSubmission(engineerToken, terminalTarget.id);

      // 待审投稿移除附件：状态冲突
      const pendingRemove = await restRemove(engineerToken, terminalTarget.id).expect(409);
      expect(pendingRemove.body.data).toMatchObject({
        statusCode: 409,
        code: 'CONTENT_SUBMISSION_STATE_NOT_EDITABLE',
      });
    });
  });
});

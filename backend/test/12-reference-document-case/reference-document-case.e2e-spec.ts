// test/12-reference-document-case/reference-document-case.e2e-spec.ts
//
// 正式案例更正与普通编辑隔离端点级回归（A-PR0 §S6 / 行为矩阵 T15-T16）
//
// 边界声明：
// - 投稿发布链（草稿→附件→送审→审批）的协议层真实请求验收见
//   test/11-content-submission/content-submission-graphql.e2e-spec.ts（S7 已接入
//   协议入口）；本规格经真实 usecase + 真实 TypeOrmTransactionRunner + 真实 MySQL
//   + 真实本地文件存储建立「已发布正式案例」前置事实；
// - 更正与隔离断言走真实 GraphQL 端点（updateReferenceDocumentCase /
//   updateReferenceDocument / createReferenceDocument 等 mutation，含守卫与
//   业务错误契约），并断言读视图、正文、明细与历史冻结的一致性；
// - 存储隔离：运行级临时上传目录（mkdtemp，先于应用初始化设置 env），结束后
//   按精确路径删除本测试拥有的目录与数据，不污染默认 var/。
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { ContentSubmissionAttachmentEntity } from '@src/modules/lithography/entities/content-submission-attachment.entity';
import { ContentSubmissionEntity } from '@src/modules/lithography/entities/content-submission.entity';
import { ContentSubmissionReviewEntity } from '@src/modules/lithography/entities/content-submission-review.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { ReferenceDocumentCaseDetailEntity } from '@src/modules/lithography/entities/reference-document-case-detail.entity';
import { ReferenceDocumentEntity } from '@src/modules/lithography/entities/reference-document.entity';
import { ApproveContentSubmissionUsecase } from '@src/usecases/content-submission/approve-content-submission.usecase';
import { CreateContentSubmissionDraftUsecase } from '@src/usecases/content-submission/create-content-submission-draft.usecase';
import { GetContentSubmissionRevisionUsecase } from '@src/usecases/content-submission/get-content-submission-revision.usecase';
import { SubmitContentSubmissionUsecase } from '@src/usecases/content-submission/submit-content-submission.usecase';
import { UploadContentSubmissionAttachmentUsecase } from '@src/usecases/content-submission/upload-content-submission-attachment.usecase';
import { UpdateReferenceDocumentCaseUsecase } from '@src/usecases/reference-document/update-reference-document-case.usecase';
import { UpdateReferenceDocumentUsecase } from '@src/usecases/reference-document/update-reference-document.usecase';

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
  requireOrganizationId,
  seedTestMemberships,
  seedTestOrganizations,
} from '../utils/test-organizations';

// 运行级临时存储目录：先于应用初始化设置 env（与 09/11 spec 同一隔离纪律）。
// 原环境变量值先捕获，收尾时恢复原值（不假定原值不存在）。
const originalStorageDir = captureEnvValue('REFERENCE_DOCUMENT_STORAGE_DIR');
const e2eStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refdoc-case-e2e-storage-'));
process.env.REFERENCE_DOCUMENT_STORAGE_DIR = e2eStorageRoot;

jest.setTimeout(60000);

const UPDATE_CASE_MUTATION = `
  mutation UpdateReferenceDocumentCase($id: Int!, $input: UpdateReferenceDocumentCaseInput!) {
    updateReferenceDocumentCase(id: $id, input: $input) { id updatedAt }
  }
`;

const UPDATE_MUTATION = `
  mutation UpdateReferenceDocument($id: Int!, $input: UpdateReferenceDocumentInput!) {
    updateReferenceDocument(id: $id, input: $input) { id }
  }
`;

const CREATE_MUTATION = `
  mutation CreateReferenceDocument($input: CreateReferenceDocumentInput!) {
    createReferenceDocument(input: $input) { id }
  }
`;

const SOFT_DELETE_MUTATION = `
  mutation SoftDeleteReferenceDocument($id: Int!) {
    softDeleteReferenceDocument(id: $id) { id }
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

describe('正式案例更正与普通编辑隔离 (V-S6)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  let documentRepository: Repository<ReferenceDocumentEntity>;
  let caseDetailRepository: Repository<ReferenceDocumentCaseDetailEntity>;
  let submissionRepository: Repository<ContentSubmissionEntity>;
  let reviewRepository: Repository<ContentSubmissionReviewEntity>;
  let attachmentRepository: Repository<ContentSubmissionAttachmentEntity>;
  let modelRepository: Repository<EquipmentModelEntity>;

  let createDraft: CreateContentSubmissionDraftUsecase;
  let uploadAttachment: UploadContentSubmissionAttachmentUsecase;
  let submit: SubmitContentSubmissionUsecase;
  let approve: ApproveContentSubmissionUsecase;
  let getRevision: GetContentSubmissionRevisionUsecase;
  let updateCase: UpdateReferenceDocumentCaseUsecase;
  let updateDocument: UpdateReferenceDocumentUsecase;

  // 规格专属测试组织（不借用开发库默认组织；编码带 E2E 前缀，清理以编码为界）
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('CONTENTCASE');
  const ownership = createOwnedResourceLedger();
  let primaryOrganizationId = 0;
  /** 案例机型夹具：由数据库自增生成，仅凭 ledger 精确 ID 归属 */
  let caseModelId = 0;

  let engineerSession: UsecaseSession;
  let adminSession: UsecaseSession;
  let adminAccountId = 0;
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
   * 建立「已发布正式案例」前置事实（真实发布链，与 11 spec V9 同口径）：
   * 工程师建 FAULT_CASE 草稿 + 附件 → 送审 → 管理员审核通过并发布获准原件。
   */
  const publishFaultCaseDocument = async (params: {
    title: string;
    errorCode: string | null;
    phenomenon: string;
    reproductionSteps: string;
    handlingStatus: 'UNRESOLVED' | 'IN_PROGRESS' | 'RESOLVED';
    resolution: string | null;
    attachmentName: string;
    attachmentContent: string;
  }): Promise<{
    documentId: number;
    submissionId: number;
    revisionId: number;
    revisionNo: number;
    documentStorageReference: string;
    originalAttachmentReference: string;
  }> => {
    const draft = await createDraft.execute({
      session: engineerSession,
      kind: 'FAULT_CASE',
      fields: {
        title: params.title,
        equipmentModelText: '案例链路手填机型',
        errorCode: params.errorCode,
        phenomenon: params.phenomenon,
        conditionText: '连续运行超过 30 分钟。',
        reproductionSteps: params.reproductionSteps,
        diagnosis: null,
        actionTaken: null,
        handlingStatus: params.handlingStatus,
        resolution: params.resolution,
      },
    });

    const upload = await uploadAttachment.execute({
      session: engineerSession,
      submissionId: draft.id,
      file: {
        buffer: Buffer.from(params.attachmentContent),
        originalFilename: params.attachmentName,
      },
    });
    const originalRow = await attachmentRepository.findOneByOrFail({
      id: upload.attachmentId,
    });

    const submitted = await submit.execute({
      session: engineerSession,
      submissionId: draft.id,
      libraryNoticeConfirmed: true,
    });
    const approved = await approve.execute({
      session: adminSession,
      submissionId: draft.id,
      revisionId: submitted.revisionId,
      publishAttachment: true,
      comment: null,
    });
    expect(approved).toMatchObject({ status: 'PUBLISHED' });
    if (approved.documentId === null) {
      throw new Error('发布未返回正式资料 ID，后续断言无法继续');
    }
    const submissionRow = await submissionRepository.findOneByOrFail({ id: draft.id });
    expect(submissionRow.status).toBe('PUBLISHED');

    const document = await documentRepository.findOneByOrFail({ id: approved.documentId });
    if (document.storageReference === null) {
      throw new Error('发布未生成正式存储引用，后续断言无法继续');
    }
    return {
      documentId: approved.documentId,
      submissionId: draft.id,
      revisionId: submitted.revisionId,
      revisionNo: submitted.revisionNo,
      documentStorageReference: document.storageReference,
      originalAttachmentReference: originalRow.storageReference,
    };
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);

    documentRepository = dataSource.getRepository(ReferenceDocumentEntity);
    caseDetailRepository = dataSource.getRepository(ReferenceDocumentCaseDetailEntity);
    submissionRepository = dataSource.getRepository(ContentSubmissionEntity);
    reviewRepository = dataSource.getRepository(ContentSubmissionReviewEntity);
    attachmentRepository = dataSource.getRepository(ContentSubmissionAttachmentEntity);
    modelRepository = dataSource.getRepository(EquipmentModelEntity);

    createDraft = app.get(CreateContentSubmissionDraftUsecase);
    uploadAttachment = app.get(UploadContentSubmissionAttachmentUsecase);
    submit = app.get(SubmitContentSubmissionUsecase);
    approve = app.get(ApproveContentSubmissionUsecase);
    getRevision = app.get(GetContentSubmissionRevisionUsecase);
    updateCase = app.get(UpdateReferenceDocumentCaseUsecase);
    updateDocument = app.get(UpdateReferenceDocumentUsecase);

    await app.init();

    // 预清理（窄范围）：组织/账号/机型均按完整指纹回收已知残留，不接管异主行
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

    const engineerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staffPrimary.loginName,
    );
    adminAccountId = await getAccountIdByLoginName(dataSource, testAccountsConfig.admin.loginName);

    engineerSession = {
      accountId: engineerAccountId,
      roles: [IdentityTypeEnum.ENGINEER],
      activeRole: IdentityTypeEnum.ENGINEER,
    };
    adminSession = {
      accountId: adminAccountId,
      roles: [IdentityTypeEnum.SUPER_ADMIN],
      activeRole: IdentityTypeEnum.SUPER_ADMIN,
    };

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

  it('V-S6-1 更正闭环（未解决→已解决且有结果）：库读视图与正文一致；原送审版本内容仍是历史事实；原附件不变', async () => {
    const published = await publishFaultCaseDocument({
      title: 'V-S6-1 案例：光源同步异常',
      errorCode: 'V-S6-1-ERR-100',
      phenomenon: '曝光期间同步误差超限。',
      reproductionSteps: '1. 复现同步误差；\n2. 记录趋势。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-1-report.txt',
      attachmentContent: 'v-s6-1-original-bytes',
    });
    const { documentId, submissionId } = published;

    // 发布后基线：正文含未解决状态且无处理结果；正式文件为本规格专属新副本
    const before = await documentRepository.findOneByOrFail({ id: documentId });
    expect(before).toMatchObject({
      documentType: 'FAULT_CASE',
      ingestMethod: 'REVIEWED_SUBMISSION',
      sourceSubmissionId: submissionId,
      sourceRevisionId: published.revisionId,
      ownerOrganizationId: primaryOrganizationId,
    });
    expect(before.contentText).toContain('处理状态：未解决');
    expect(before.contentText).not.toContain('处理结果：');
    expect(published.documentStorageReference).not.toBe(published.originalAttachmentReference);

    const snapshotBefore = await getRevision.execute({
      session: engineerSession,
      submissionId,
      revisionNo: published.revisionNo,
    });
    expect(snapshotBefore.payloadSnapshot).toMatchObject({ handlingStatus: 'UNRESOLVED' });
    expect(snapshotBefore.payloadSnapshot.resolution ?? null).toBeNull();

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
    const after = await documentRepository.findOneByOrFail({ id: documentId });
    const detailAfter = await caseDetailRepository.findOneByOrFail({ documentId });
    expect(detailAfter).toMatchObject({
      errorCode: 'V-S6-1-ERR-100',
      handlingStatus: 'RESOLVED',
      phenomenon: '曝光期间同步误差超限。',
      reproductionSteps: '1. 复现同步误差；\n2. 记录趋势。',
      resolution: '更换目标模组后恢复，连续 5 批无异常。',
    });
    expect(after.contentText).toContain('处理状态：已解决');
    expect(after.contentText).toContain('处理结果：\n更换目标模组后恢复，连续 5 批无异常。');
    expect(after.contentText).toContain('故障现象：\n曝光期间同步误差超限。');

    // GraphQL 详情读视图（工程师可读）与库内事实一致：caseDetail 与正文均同源
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
    expect(view.contentText).toBe(after.contentText);

    // 修改人落库；返回更新时间与库内回读一致（回读真实落库状态）
    expect(after.updatedByAccountId).toBe(adminAccountId);
    expect(new Date(response.body.data.updateReferenceDocumentCase.updatedAt).getTime()).toBe(
      after.updatedAt.getTime(),
    );

    // —— 不可变字段（owner/source/type/来源方式/原附件）保持原值 ——
    expect(after).toMatchObject({
      documentType: before.documentType,
      ownerOrganizationId: before.ownerOrganizationId,
      sourceSubmissionId: before.sourceSubmissionId,
      sourceRevisionId: before.sourceRevisionId,
      ingestMethod: before.ingestMethod,
      storageReference: before.storageReference,
      originalFilename: before.originalFilename,
      mimeType: before.mimeType,
    });

    // —— 原送审版本内容仍是历史事实：冻结快照不变、审核事实不变 ——
    const snapshotAfter = await getRevision.execute({
      session: engineerSession,
      submissionId,
      revisionNo: published.revisionNo,
    });
    expect(snapshotAfter.payloadSnapshot).toEqual(snapshotBefore.payloadSnapshot);
    expect(snapshotAfter.attachment?.id).toBe(snapshotBefore.attachment?.id);
    const reviews = await reviewRepository.find({ where: { submissionId }, order: { id: 'ASC' } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ decision: 'APPROVE', revisionId: published.revisionId });

    // —— 原附件不被重写：正式副本与获准原件字节一致且可读 ——
    expect(readStoredBytes(published.documentStorageReference).toString()).toBe(
      'v-s6-1-original-bytes',
    );
    expect(readStoredBytes(published.originalAttachmentReference).toString()).toBe(
      'v-s6-1-original-bytes',
    );
  });

  it('V-S6-2 字段更正（部分提交合并）：标题/机型/说明与明细字段更正；正文同步重生成；owner/source/type/原附件不变', async () => {
    const published = await publishFaultCaseDocument({
      title: 'V-S6-2 案例：送料偏移',
      errorCode: 'V-S6-2-ERR-200',
      phenomenon: '送料机构存在周期性偏移。',
      reproductionSteps: '1. 空跑观察偏移；\n2. 记录偏移量。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-2-report.txt',
      attachmentContent: 'v-s6-2-original-bytes',
    });
    const { documentId } = published;
    const before = await documentRepository.findOneByOrFail({ id: documentId });
    expect(before.contentText).toContain('错误码：V-S6-2-ERR-200');

    // 部分提交：标题/说明/机型（文字→ID 同一补丁替换）/清空错误码/补充排查与措施
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

    // 主资料：字段更正落库，正文按合并后明细重生成（清空字段的段落同步省略）
    const after = await documentRepository.findOneByOrFail({ id: documentId });
    expect(after).toMatchObject({
      title: 'V-S6-2 案例：送料偏移（已更正）',
      description: '更正补充：增加送料校准说明。',
      equipmentModelId: caseModelId,
      equipmentModelText: null,
      updatedByAccountId: adminAccountId,
    });
    expect(after.contentText).not.toContain('错误码：');
    expect(after.contentText).toContain('排查过程：\n排查补充：传动带张力不足。');
    expect(after.contentText).toContain('处理措施：\n处理补充：更换并重新张紧。');
    expect(after.contentText).toContain('故障现象：\n送料机构存在周期性偏移。');
    expect(after.contentText).toContain('处理状态：未解决');
    expect(after.contentText).not.toContain('处理结果：');

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

    // 不可变事实保持：类型/归属/来源投稿与版本/原附件引用
    expect(after).toMatchObject({
      documentType: before.documentType,
      ownerOrganizationId: before.ownerOrganizationId,
      sourceSubmissionId: before.sourceSubmissionId,
      sourceRevisionId: before.sourceRevisionId,
      storageReference: before.storageReference,
    });

    // 原送审版本仍是送审当次事实（更正只影响正式资料与明细）
    const snapshot = await getRevision.execute({
      session: engineerSession,
      submissionId: published.submissionId,
      revisionNo: published.revisionNo,
    });
    expect(snapshot.payloadSnapshot).toMatchObject({ errorCode: 'V-S6-2-ERR-200' });
  });

  it('V-S6-3 通用编辑隔离回归：案例正文/类型改造拒绝且不落库；非正文可通用编辑；普通资料通用编辑兼容；直建不可伪造 FAULT_CASE', async () => {
    const published = await publishFaultCaseDocument({
      title: 'V-S6-3 案例：温漂超限',
      errorCode: 'V-S6-3-ERR-300',
      phenomenon: '温控漂移超限。',
      reproductionSteps: '1. 升温观测；\n2. 记录漂移。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-3-report.txt',
      attachmentContent: 'v-s6-3-original-bytes',
    });
    const before = await documentRepository.findOneByOrFail({ id: published.documentId });

    // 案例可读正文与明细强耦合：通用编辑不得单独改造（不得与明细脱节）
    const contentResponse = await postGql({
      app,
      query: UPDATE_MUTATION,
      variables: { id: published.documentId, input: { contentText: '伪造改造后的案例正文。' } },
      token: adminToken,
    }).expect(200);
    expect(contentResponse.body.errors[0].extensions.errorCode).toBe(
      'REFERENCE_DOCUMENT_INVALID_PARAMS',
    );

    // 类型改写拒绝：案例类型只能来自审核发布或专属更正
    const typeResponse = await postGql({
      app,
      query: UPDATE_MUTATION,
      variables: { id: published.documentId, input: { documentType: 'ERROR_CODE_MANUAL' } },
      token: adminToken,
    }).expect(200);
    expect(typeResponse.body.errors[0].extensions.errorCode).toBe(
      'REFERENCE_DOCUMENT_INVALID_PARAMS',
    );

    // 拒绝不改库
    const afterRejects = await documentRepository.findOneByOrFail({ id: published.documentId });
    expect(afterRejects.contentText).toBe(before.contentText);
    expect(afterRejects.documentType).toBe('FAULT_CASE');

    // 非正文/类型字段仍可用通用编辑（能力不过度收窄）
    const titleResponse = await postGql({
      app,
      query: UPDATE_MUTATION,
      variables: { id: published.documentId, input: { title: 'V-S6-3 通用编辑标题' } },
      token: adminToken,
    }).expect(200);
    expect(titleResponse.body.errors).toBeUndefined();
    expect(titleResponse.body.data.updateReferenceDocument.id).toBe(published.documentId);

    // 普通资料通用编辑兼容（含正文编辑）：案例保护不影响非案例资料
    const normalCreate = await postGql({
      app,
      query: CREATE_MUTATION,
      variables: {
        input: { title: 'V-S6-3 普通资料', documentType: 'MANUAL', contentText: '普通正文内容。' },
      },
      token: adminToken,
    }).expect(200);
    expect(normalCreate.body.errors).toBeUndefined();
    const normalId = normalCreate.body.data.createReferenceDocument.id as number;
    const normalUpdate = await postGql({
      app,
      query: UPDATE_MUTATION,
      variables: {
        id: normalId,
        input: { title: 'V-S6-3 普通资料（已编辑）', contentText: '普通正文内容（已编辑）。' },
      },
      token: adminToken,
    }).expect(200);
    expect(normalUpdate.body.errors).toBeUndefined();
    const normalRow = await documentRepository.findOneByOrFail({ id: normalId });
    expect(normalRow).toMatchObject({
      title: 'V-S6-3 普通资料（已编辑）',
      contentText: '普通正文内容（已编辑）。',
    });

    // 管理员直建不能伪造 FAULT_CASE（案例只能经审核发布进入正式库）
    const forgeResponse = await postGql({
      app,
      query: CREATE_MUTATION,
      variables: {
        input: { title: 'V-S6-3 伪造案例', documentType: 'FAULT_CASE', contentText: '伪造正文。' },
      },
      token: adminToken,
    }).expect(200);
    expect(forgeResponse.body.errors[0].extensions.errorCode).toBe(
      'REFERENCE_DOCUMENT_INVALID_PARAMS',
    );
    expect(await documentRepository.count({ where: { title: 'V-S6-3 伪造案例' } })).toBe(0);

    // 大小写变体同样不可伪造（与数据库列排序规则 utf8mb4_0900_ai_ci 同口径）
    const forgeVariant = await postGql({
      app,
      query: CREATE_MUTATION,
      variables: {
        input: {
          title: 'V-S6-3 伪造案例（变体）',
          documentType: 'fault_case',
          contentText: '伪造正文。',
        },
      },
      token: adminToken,
    }).expect(200);
    expect(forgeVariant.body.errors[0].extensions.errorCode).toBe(
      'REFERENCE_DOCUMENT_INVALID_PARAMS',
    );
    expect(await documentRepository.count({ where: { title: 'V-S6-3 伪造案例（变体）' } })).toBe(0);

    // 案例更新仍由专属接口承接（隔离而非一刀切禁写）
    const caseFix = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: { id: published.documentId, input: { description: '通过专属更正确认说明。' } },
      token: adminToken,
    }).expect(200);
    expect(caseFix.body.errors).toBeUndefined();
  });

  it('V-S6-4 权限/跨组织/软删拒绝：工程师与匿名禁止；跨组织统一 NOT_FOUND；软删后 NOT_FOUND；库不变', async () => {
    const published = await publishFaultCaseDocument({
      title: 'V-S6-4 案例：真空度波动',
      errorCode: 'V-S6-4-ERR-400',
      phenomenon: '工艺腔真空度周期性波动。',
      reproductionSteps: '1. 空载抽真空；\n2. 记录波动曲线。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-4-report.txt',
      attachmentContent: 'v-s6-4-original-bytes',
    });
    const before = await documentRepository.findOneByOrFail({ id: published.documentId });
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

    // 软删后更正拒绝：已软删与不存在统一 NOT_FOUND（与详情读口径一致）
    const deleteResponse = await postGql({
      app,
      query: SOFT_DELETE_MUTATION,
      variables: { id: published.documentId },
      token: adminToken,
    }).expect(200);
    expect(deleteResponse.body.errors).toBeUndefined();
    const deletedResponse = await postGql({
      app,
      query: UPDATE_CASE_MUTATION,
      variables: { id: published.documentId, input: { handlingStatus: 'IN_PROGRESS' } },
      token: adminToken,
    }).expect(200);
    expect(deletedResponse.body.errors[0].extensions.errorCode).toBe(
      'REFERENCE_DOCUMENT_NOT_FOUND',
    );

    // 所有拒绝均不改库：正文/修改人/明细保持原值；软删事实已落库
    const after = await documentRepository.findOneByOrFail({ id: published.documentId });
    const detailAfter = await caseDetailRepository.findOneByOrFail({
      documentId: published.documentId,
    });
    expect(after.contentText).toBe(before.contentText);
    expect(after.updatedByAccountId).toBe(before.updatedByAccountId);
    expect(detailAfter.handlingStatus).toBe(detailBefore.handlingStatus);
    expect(detailAfter.resolution).toBe(detailBefore.resolution);
    expect(after.deprecated).toBe(true);
    expect(after.deletedAt).not.toBeNull();
  });

  it('V-S6-5 真实并发更正（独立连接竞争）：不同字段补丁零覆盖；通用编辑与专属更正共享资源锁', async () => {
    const published = await publishFaultCaseDocument({
      title: 'V-S6-5 案例：并发更正',
      errorCode: 'V-S6-5-OLD',
      phenomenon: '并发更正现象。',
      reproductionSteps: '1. 并发发起；\n2. 断言字段完整。',
      handlingStatus: 'UNRESOLVED',
      resolution: null,
      attachmentName: 'v-s6-5-report.txt',
      attachmentContent: 'v-s6-5-original-bytes',
    });
    const { documentId } = published;

    // G2/F01 真实独立连接竞争：两管理员并发更正不同字段。每次 execute 经
    // TransactionRunner 从连接池取独立连接，且都在事务内对主资料行 FOR UPDATE
    // 锁定读；后进入者在锁上等待，读到先写者已提交事实后再合并，两个补丁互不覆盖。
    // 「两请求已同时读到同一旧值再交错提交」的确定性时序注入由受控替身单测
    // （reference-document-write-race.spec.ts）覆盖，本用例走真实 MySQL 行锁路径。
    const [correctionA, correctionB] = await Promise.all([
      updateCase.execute({
        session: adminSession,
        documentId,
        patch: { errorCode: 'V-S6-5-A-NEW' },
      }),
      updateCase.execute({
        session: adminSession,
        documentId,
        patch: { conditionText: 'V-S6-5-B-NEW' },
      }),
    ]);
    expect(correctionA).toMatchObject({ id: documentId });
    expect(correctionB).toMatchObject({ id: documentId });

    // 两个不同字段补丁都在：竞争未导致任一更新丢失（F01 核心断言）
    const detailAfter = await caseDetailRepository.findOneByOrFail({ documentId });
    expect(detailAfter.errorCode).toBe('V-S6-5-A-NEW');
    expect(detailAfter.conditionText).toBe('V-S6-5-B-NEW');

    // 通用编辑（标题）与专属更正（案例现象）并发：两个写入口经同一主资料行锁串行化
    await Promise.all([
      updateDocument.execute({
        session: adminSession,
        documentId,
        patch: { title: 'V-S6-5 案例：并发更正（标题已改）' },
      }),
      updateCase.execute({
        session: adminSession,
        documentId,
        patch: { phenomenon: 'V-S6-5 现象已改。' },
      }),
    ]);
    const docAfter = await documentRepository.findOneByOrFail({ id: documentId });
    const detailAfter2 = await caseDetailRepository.findOneByOrFail({ documentId });
    expect(docAfter.title).toBe('V-S6-5 案例：并发更正（标题已改）');
    expect(detailAfter2.phenomenon).toBe('V-S6-5 现象已改。');
    // 正文与明细不脱节：正文由合并后明细重生成，含最新现象
    expect(docAfter.contentText).toContain('V-S6-5 现象已改。');
  });
});

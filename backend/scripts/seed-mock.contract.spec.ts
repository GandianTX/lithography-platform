// scripts/seed-mock.contract.spec.ts

/**
 * 窄范围 Seed 契约测试（G3/F04）：直接消费 Seed 脚本实际声明的冻结快照数据
 * （`seed-mock-content-submissions`，与 `seed-mock.ts` 共用同一模块），
 * 交给真实发布用例 `ApproveContentSubmissionUsecase` 解析——
 * 不另手造一份正确 fixture，也不用 mock 复制发布解析语义。
 *
 * 背景（F04）：Seed 的两份故障案例 payload_snapshot 缺 reproductionSteps、
 * handlingStatus 等必填字段，且普通资料快照只写标题/现象/附件展示信息；
 * 修复前本规格的「真实发布解析」用例必然失败（送审版本快照数据不完整），
 * 修复后要求：
 * 1. 所有 Seed 声明快照可被真实发布解析消费；
 * 2. 发布正文 = 声明正文（快照字段确定性生成，与正式正文对应）；
 * 3. 正式案例明细字段与冻结快照逐字段一致；
 * 4. 快照字段集合与真实 submit 冻结结构一致（无 schemaVersion/
 *    submissionKind/attachment 等展示性字段）。
 *
 * 无真实物理文件的 Mock：本规格用 publishAttachment=false 验证正文/案例解析，
 * 存储接口必须零调用；文件下载与复制路径由测试专属物理文件另行验证。
 */

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { ContentSubmissionHandlingStatus } from '@src/modules/lithography/content-submission.types';
import type { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import type { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { ReferenceDocumentCaseDetailService } from '@src/modules/lithography/reference-document-case-detail.service';
import type { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import type { FaultCaseReferenceContentInput } from '@src/usecases/common/fault-case-fields.contract';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { ApproveContentSubmissionUsecase } from '@src/usecases/content-submission/approve-content-submission.usecase';
import { formatFaultCaseReferenceContent } from '@src/usecases/content-submission/content-submission-fields.normalize';
import {
  buildPendingFaultCaseSnapshot,
  buildPublishedCaseDocumentContent,
  buildPublishedFaultCaseSnapshot,
  buildReturnedMaterialSnapshot,
  CONTENT_SEED_IDS,
} from './seed-mock-content-submissions';

const transactionContext = { transaction: 'mock' };

/** 测试登记的机型主键（替代脚本内由数据库实际主键构造的解析器） */
const FAKE_MODEL_IDS = new Map<string, number>([
  ['ASML-TWINSCAN-NXT-1980DI', 930_001],
  ['ASML-TWINSCAN-NXE-3400C', 930_002],
]);
const resolveModelId = (modelCode: string): number => {
  const id = FAKE_MODEL_IDS.get(modelCode);
  if (id === undefined) {
    throw new Error(`测试未登记机型编码：${modelCode}`);
  }
  return id;
};

/** 真实发布要求 SUPER_ADMIN 精确角色（与审核链路同一断言） */
const superAdminSession = {
  accountId: 900_001,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as UsecaseSession;

/** 真实 submit 冻结结构的规范字段集（submit-content-submission.usecase 显式列举） */
const MATERIAL_SNAPSHOT_KEYS = [
  'contentText',
  'description',
  'documentType',
  'equipmentModelId',
  'equipmentModelText',
  'title',
];
const FAULT_CASE_SNAPSHOT_KEYS = [
  'actionTaken',
  'conditionText',
  'diagnosis',
  'equipmentModelId',
  'equipmentModelText',
  'errorCode',
  'handlingStatus',
  'phenomenon',
  'reproductionSteps',
  'resolution',
  'title',
];

/** 快照读取为正文格式化输入（缺失字段保持 undefined 参与格式化，供差异检测） */
const readCaseContentFields = (
  snapshot: Record<string, unknown>,
): FaultCaseReferenceContentInput => ({
  errorCode: snapshot['errorCode'] as string | null,
  phenomenon: snapshot['phenomenon'] as string,
  conditionText: snapshot['conditionText'] as string | null,
  reproductionSteps: snapshot['reproductionSteps'] as string,
  diagnosis: snapshot['diagnosis'] as string | null,
  actionTaken: snapshot['actionTaken'] as string | null,
  handlingStatus: snapshot['handlingStatus'] as ContentSubmissionHandlingStatus,
  resolution: snapshot['resolution'] as string | null,
});

describe('Seed 冻结快照契约（F04，消费脚本实际声明的数据）', () => {
  const membership = {
    membershipId: 950_001,
    organizationId: 910_001,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '甲方默认组织',
    organizationKind: 'CLIENT',
    memberRole: 'SUPER_ADMIN',
  };

  const reviewableLock = (submissionKind: 'MATERIAL' | 'FAULT_CASE') => ({
    id: 984_001,
    submissionKind,
    ownerOrganizationId: 910_001,
    submittedByAccountId: 900_101,
    status: 'PENDING_REVIEW',
    currentRevisionNo: 1,
  });

  const publishSource = (
    submissionKind: 'MATERIAL' | 'FAULT_CASE',
    payloadSnapshot: Record<string, unknown>,
  ) => ({
    revisionId: 988_001,
    revisionNo: 1,
    submissionKind,
    titleSnapshot: String(payloadSnapshot['title']),
    payloadSnapshot,
    // 无真实物理文件的 Mock：附件不参与本契约（publishAttachment=false 路径）
    attachment: null,
  });

  const makeQueryService = () => ({
    findSubmissionAccessFacts: jest
      .fn()
      .mockResolvedValue({ submittedByAccountId: 900_101, ownerOrganizationId: 910_001 }),
    findRevisionPublishSource: jest.fn(),
    findRevisionIdentity: jest.fn().mockResolvedValue({ revisionId: 988_001, revisionNo: 1 }),
    findReviewPrecheckFacts: jest
      .fn()
      .mockResolvedValue({ status: 'PENDING_REVIEW', currentRevisionNo: 1 }),
    readStatusSnapshot: jest.fn().mockResolvedValue({
      id: 984_001,
      submissionKind: 'FAULT_CASE',
      status: 'PUBLISHED',
      updatedAt: new Date('2026-01-21T09:30:00.000Z'),
    }),
    findPublishedDocumentFileRefBySourceSubmission: jest.fn().mockResolvedValue(null),
  });

  const makeWriteService = () => ({
    lockSubmissionForWrite: jest.fn(),
    insertReview: jest.fn().mockResolvedValue({ reviewId: 995_001 }),
    markSubmissionPublished: jest.fn().mockResolvedValue(undefined),
  });

  const makeDocumentService = () => ({
    insertDocument: jest.fn().mockResolvedValue({ id: 880_001 }),
  });

  const makeCaseDetailService = () => ({
    insertCaseDetail: jest.fn().mockResolvedValue({ documentId: 880_001 }),
  });

  const makeOrganizationContextService = () => ({
    resolveForAccount: jest.fn().mockResolvedValue(membership),
  });

  const makeTransactionRunner = () =>
    ({
      run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
    }) as unknown as TransactionRunner & { run: jest.Mock };

  /** 无物理文件 Mock：存储接口在 publishAttachment=false 路径必须零调用 */
  const makeStorage = () => ({
    open: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  });

  const runPublish = async (
    submissionKind: 'MATERIAL' | 'FAULT_CASE',
    submissionId: number,
    revisionId: number,
    payloadSnapshot: Record<string, unknown>,
  ) => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValue(
      publishSource(submissionKind, payloadSnapshot),
    );
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValue(reviewableLock(submissionKind));
    const referenceDocumentService = makeDocumentService();
    const referenceDocumentCaseDetailService = makeCaseDetailService();
    const storage = makeStorage();

    const usecase = new ApproveContentSubmissionUsecase(
      writeService as unknown as ContentSubmissionService,
      queryService as unknown as ContentSubmissionQueryService,
      referenceDocumentService as unknown as ReferenceDocumentService,
      referenceDocumentCaseDetailService as unknown as ReferenceDocumentCaseDetailService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
      makeTransactionRunner(),
      storage,
    );

    const result = await usecase.execute({
      session: superAdminSession,
      submissionId,
      revisionId,
      comment: null,
      // 无真实物理文件的 Mock：只验证正文/案例解析，不触盘
      publishAttachment: false,
    });
    return { result, referenceDocumentService, referenceDocumentCaseDetailService, storage };
  };

  it('普通资料退回稿声明快照：真实发布解析消费六字段完整快照，附件展示信息不进入正式资料', async () => {
    const snapshot = buildReturnedMaterialSnapshot();
    const { result, referenceDocumentService, referenceDocumentCaseDetailService, storage } =
      await runPublish(
        'MATERIAL',
        CONTENT_SEED_IDS.returnedSubmission,
        CONTENT_SEED_IDS.revisionReturned,
        snapshot,
      );

    expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: snapshot['title'],
        documentType: snapshot['documentType'],
        equipmentModelId: snapshot['equipmentModelId'],
        equipmentModelText: snapshot['equipmentModelText'],
        description: snapshot['description'],
        contentText: snapshot['contentText'],
        ingestMethod: 'REVIEWED_SUBMISSION',
        sourceSubmissionId: CONTENT_SEED_IDS.returnedSubmission,
        sourceRevisionId: CONTENT_SEED_IDS.revisionReturned,
        // 未发布附件：四列同空
        originalFilename: null,
        mimeType: null,
        storageBackend: null,
        storageReference: null,
      }),
      transactionContext,
    );
    expect(referenceDocumentCaseDetailService.insertCaseDetail).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(result).toEqual({
      submissionId: CONTENT_SEED_IDS.returnedSubmission,
      status: 'PUBLISHED',
      documentId: 880_001,
    });
  });

  it('待审故障案例声明快照：真实发布解析成功，正文由快照字段确定性生成，明细逐字段一致', async () => {
    const snapshot = buildPendingFaultCaseSnapshot(resolveModelId);
    const { referenceDocumentService, referenceDocumentCaseDetailService, storage } =
      await runPublish(
        'FAULT_CASE',
        CONTENT_SEED_IDS.pendingSubmission,
        CONTENT_SEED_IDS.revisionPending,
        snapshot,
      );

    expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: snapshot['title'],
        documentType: 'FAULT_CASE',
        equipmentModelId: snapshot['equipmentModelId'],
        equipmentModelText: snapshot['equipmentModelText'],
        contentText: formatFaultCaseReferenceContent(readCaseContentFields(snapshot)),
      }),
      transactionContext,
    );
    expect(referenceDocumentCaseDetailService.insertCaseDetail).toHaveBeenCalledWith(
      {
        documentId: 880_001,
        errorCode: snapshot['errorCode'],
        handlingStatus: snapshot['handlingStatus'],
        phenomenon: snapshot['phenomenon'],
        conditionText: snapshot['conditionText'],
        reproductionSteps: snapshot['reproductionSteps'],
        diagnosis: snapshot['diagnosis'],
        actionTaken: snapshot['actionTaken'],
        resolution: snapshot['resolution'],
        casePayloadJson: null,
      },
      transactionContext,
    );
    expect(storage.open).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('已发布故障案例声明快照：真实发布输出正文 = 脚本声明的正式正文（发布内容可解释）', async () => {
    const snapshot = buildPublishedFaultCaseSnapshot(resolveModelId);
    const { referenceDocumentService, referenceDocumentCaseDetailService } = await runPublish(
      'FAULT_CASE',
      CONTENT_SEED_IDS.publishedSubmission,
      CONTENT_SEED_IDS.revisionPublished,
      snapshot,
    );

    // 声明正文（Seed 落库的 content_text）与真实发布输出必须一致：
    // 已发布正式资料可完全由冻结快照字段解释
    const insertPayload = referenceDocumentService.insertDocument.mock.calls[0][0] as {
      contentText: string;
    };
    expect(insertPayload.contentText).toBe(buildPublishedCaseDocumentContent(resolveModelId));
    expect(insertPayload.contentText).toBe(
      formatFaultCaseReferenceContent(readCaseContentFields(snapshot)),
    );
    expect(referenceDocumentCaseDetailService.insertCaseDetail).toHaveBeenCalledWith(
      {
        documentId: 880_001,
        errorCode: snapshot['errorCode'],
        handlingStatus: snapshot['handlingStatus'],
        phenomenon: snapshot['phenomenon'],
        conditionText: snapshot['conditionText'],
        reproductionSteps: snapshot['reproductionSteps'],
        diagnosis: snapshot['diagnosis'],
        actionTaken: snapshot['actionTaken'],
        resolution: snapshot['resolution'],
        casePayloadJson: null,
      },
      transactionContext,
    );
  });

  it('三个声明快照字段集合 = 真实 submit 冻结结构；必填字段非空、处理状态在受控值域', () => {
    const material = buildReturnedMaterialSnapshot();
    const pending = buildPendingFaultCaseSnapshot(resolveModelId);
    const published = buildPublishedFaultCaseSnapshot(resolveModelId);

    expect(Object.keys(material).sort()).toEqual(MATERIAL_SNAPSHOT_KEYS);
    expect(Object.keys(pending).sort()).toEqual(FAULT_CASE_SNAPSHOT_KEYS);
    expect(Object.keys(published).sort()).toEqual(FAULT_CASE_SNAPSHOT_KEYS);

    // 送审校验保证的必填字段（发布解析失败关闭的直接依据）
    expect(typeof material['title']).toBe('string');
    expect(material['title'].length).toBeGreaterThan(0);
    expect(typeof material['documentType']).toBe('string');
    expect(material['documentType'].length).toBeGreaterThan(0);
    for (const snapshot of [pending, published]) {
      expect(typeof snapshot['title']).toBe('string');
      expect(snapshot['title'].length).toBeGreaterThan(0);
      expect(typeof snapshot['phenomenon']).toBe('string');
      expect(snapshot['phenomenon'].length).toBeGreaterThan(0);
      expect(typeof snapshot['reproductionSteps']).toBe('string');
      expect(snapshot['reproductionSteps'].length).toBeGreaterThan(0);
      expect(['UNRESOLVED', 'IN_PROGRESS', 'RESOLVED']).toContain(snapshot['handlingStatus']);
    }
    // 机型主键由解析器在声明期解析（与脚本内数据库实际主键同口径）
    expect(pending['equipmentModelId']).toBe(930_001);
    expect(published['equipmentModelId']).toBe(930_002);
  });
});

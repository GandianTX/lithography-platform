// src/usecases/content-submission/content-submission-approve-review.usecases.spec.ts

/// <reference types="jest" />
import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  CONTENT_SUBMISSION_ERROR,
  INPUT_NORMALIZE_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import type { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { ReferenceDocumentCaseDetailService } from '@src/modules/lithography/reference-document-case-detail.service';
import type { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { ApproveContentSubmissionUsecase } from './approve-content-submission.usecase';
import { GetReviewDetailUsecase } from './get-review-detail.usecase';
import { ListReviewQueueUsecase } from './list-review-queue.usecase';

afterEach(() => {
  jest.restoreAllMocks();
});

const transactionContext = { transaction: 'mock' };

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const superAdmin = session(['SUPER_ADMIN'], 900099);

/** 可信组织成员事实替身（甲方默认组织） */
const membership = {
  membershipId: 950001,
  organizationId: 910001,
  organizationCode: 'CLIENT_DEFAULT',
  organizationName: '甲方默认组织',
  organizationKind: 'CLIENT',
  memberRole: 'SUPER_ADMIN',
};

/** 行锁快照替身（默认本组织 + 待审 + 当前版本 1） */
const reviewableLock = (overrides: Record<string, unknown> = {}) => ({
  id: 970001,
  submissionKind: 'MATERIAL',
  ownerOrganizationId: 910001,
  submittedByAccountId: 900001,
  status: 'PENDING_REVIEW',
  currentRevisionNo: 1,
  ...overrides,
});

/** 普通资料冻结快照替身（送审校验保证必填非空） */
const materialSnapshot = (overrides: Record<string, unknown> = {}) => ({
  title: '操作手册',
  documentType: 'MANUAL',
  equipmentModelId: null,
  equipmentModelText: null,
  description: null,
  contentText: '正文',
  ...overrides,
});

/** 故障案例冻结快照替身 */
const faultCaseSnapshot = (overrides: Record<string, unknown> = {}) => ({
  title: '曝光异常',
  equipmentModelId: null,
  equipmentModelText: null,
  errorCode: 'E-100',
  phenomenon: '现象',
  conditionText: null,
  reproductionSteps: '步骤一\n步骤二',
  diagnosis: null,
  actionTaken: null,
  handlingStatus: 'RESOLVED',
  resolution: '已更换部件',
  ...overrides,
});

/** 发布来源替身（事务外读取的冻结版本事实） */
const publishSource = (overrides: Record<string, unknown> = {}) => ({
  revisionId: 990001,
  revisionNo: 1,
  submissionKind: 'MATERIAL',
  titleSnapshot: '操作手册',
  payloadSnapshot: materialSnapshot(),
  attachment: null,
  ...overrides,
});

/** 获准原件引用替身（含内部存储引用，仅 usecase 中转，不进任何视图） */
const attachmentRef = (overrides: Record<string, unknown> = {}) => ({
  id: 980001,
  originalFilename: 'manual.pdf',
  mimeType: 'application/pdf',
  storageReference: 'attachments/2026/02/uuid.pdf',
  ...overrides,
});

const publishedStatusSnapshot = () => ({
  id: 970001,
  submissionKind: 'MATERIAL',
  status: 'PUBLISHED',
  updatedAt: new Date('2026-02-01T10:00:00.000Z'),
});

describe('ApproveContentSubmissionUsecase（审核通过唯一发布）', () => {
  const makeWriteService = () => ({
    lockSubmissionForWrite: jest.fn().mockResolvedValue(reviewableLock()),
    insertReview: jest.fn().mockResolvedValue({ reviewId: 995001 }),
    markSubmissionPublished: jest.fn().mockResolvedValue(undefined),
  });

  const makeQueryService = () => ({
    findSubmissionAccessFacts: jest
      .fn()
      .mockResolvedValue({ submittedByAccountId: 900001, ownerOrganizationId: 910001 }),
    findRevisionPublishSource: jest.fn().mockResolvedValue(publishSource()),
    findRevisionIdentity: jest.fn().mockResolvedValue({ revisionId: 990001, revisionNo: 1 }),
    // 复制前预检默认通过（当前待审、版本 1 = 默认 publishSource.revisionNo）
    findReviewPrecheckFacts: jest
      .fn()
      .mockResolvedValue({ status: 'PENDING_REVIEW', currentRevisionNo: 1 }),
    readStatusSnapshot: jest.fn().mockResolvedValue(publishedStatusSnapshot()),
    // 补偿核查：默认无正式资料引用（确定回滚路径）；各测试按需覆盖
    findPublishedDocumentFileRefBySourceSubmission: jest.fn().mockResolvedValue(null),
  });

  const makeDocumentService = () => ({
    insertDocument: jest.fn().mockResolvedValue({ id: 880001 }),
  });

  const makeCaseDetailService = () => ({
    insertCaseDetail: jest.fn().mockResolvedValue({ documentId: 880001 }),
  });

  const makeOrganizationContextService = () => ({
    resolveForAccount: jest.fn().mockResolvedValue(membership),
  });

  const makeTransactionRunner = () =>
    ({
      run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
    }) as unknown as TransactionRunner & { run: jest.Mock };

  const makeStorage = () => ({
    open: jest.fn().mockResolvedValue(Readable.from([Buffer.from('pdf-bytes')])),
    save: jest.fn().mockResolvedValue('published/2026/02/copy.pdf'),
    delete: jest.fn().mockResolvedValue(undefined),
  });

  const makeUsecase = (
    overrides: {
      writeService?: ReturnType<typeof makeWriteService>;
      queryService?: ReturnType<typeof makeQueryService>;
      referenceDocumentService?: ReturnType<typeof makeDocumentService>;
      referenceDocumentCaseDetailService?: ReturnType<typeof makeCaseDetailService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
      transactionRunner?: ReturnType<typeof makeTransactionRunner>;
      storage?: ReturnType<typeof makeStorage>;
    } = {},
  ) => {
    const writeService = overrides.writeService ?? makeWriteService();
    const queryService = overrides.queryService ?? makeQueryService();
    const referenceDocumentService = overrides.referenceDocumentService ?? makeDocumentService();
    const referenceDocumentCaseDetailService =
      overrides.referenceDocumentCaseDetailService ?? makeCaseDetailService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    const transactionRunner = overrides.transactionRunner ?? makeTransactionRunner();
    const storage = overrides.storage ?? makeStorage();

    const usecase = new ApproveContentSubmissionUsecase(
      writeService as unknown as ContentSubmissionService,
      queryService as unknown as ContentSubmissionQueryService,
      referenceDocumentService as unknown as ReferenceDocumentService,
      referenceDocumentCaseDetailService as unknown as ReferenceDocumentCaseDetailService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
      storage,
    );

    return {
      usecase,
      writeService,
      queryService,
      referenceDocumentService,
      referenceDocumentCaseDetailService,
      organizationContextService,
      transactionRunner,
      storage,
    };
  };

  const approveCommand = (overrides: Record<string, unknown> = {}) => ({
    session: superAdmin,
    submissionId: 970001,
    revisionId: 990001,
    comment: null,
    publishAttachment: false,
    ...overrides,
  });

  it('资料正文发布：审核记录+正式资料+状态流转同事务，未选附件不触盘', async () => {
    const {
      usecase,
      writeService,
      referenceDocumentService,
      referenceDocumentCaseDetailService,
      storage,
    } = makeUsecase();

    const result = await usecase.execute(approveCommand());

    expect(writeService.insertReview).toHaveBeenCalledWith(
      {
        submissionId: 970001,
        revisionId: 990001,
        decision: 'APPROVE',
        reviewedByAccountId: 900099,
        comment: null,
        publishAttachment: false,
      },
      transactionContext,
    );
    expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '操作手册',
        documentType: 'MANUAL',
        contentText: '正文',
        ingestMethod: 'REVIEWED_SUBMISSION',
        sourceSubmissionId: 970001,
        sourceRevisionId: 990001,
        storageReference: null,
        originalFilename: null,
        ownerOrganizationId: 910001,
        createdByAccountId: 900099,
      }),
      transactionContext,
    );
    expect(referenceDocumentCaseDetailService.insertCaseDetail).not.toHaveBeenCalled();
    expect(writeService.markSubmissionPublished).toHaveBeenCalledWith({
      submissionId: 970001,
      transactionContext,
    });
    expect(storage.open).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(result).toEqual({ submissionId: 970001, status: 'PUBLISHED', documentId: 880001 });
  });

  it('资料附件发布：复制获准原件生成新正式引用，正式资料指向本次副本', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    const { usecase, referenceDocumentService, storage } = makeUsecase({ queryService });

    const result = await usecase.execute(approveCommand({ publishAttachment: true }));

    expect(storage.open).toHaveBeenCalledWith('attachments/2026/02/uuid.pdf');
    expect(storage.save).toHaveBeenCalledWith(expect.any(Buffer), 'pdf');
    expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        storageReference: 'published/2026/02/copy.pdf',
        originalFilename: 'manual.pdf',
        mimeType: 'application/pdf',
        storageBackend: 'local',
      }),
      transactionContext,
    );
    expect(storage.delete).not.toHaveBeenCalled();
    expect(result.documentId).toBe(880001);
  });

  it('仅附件资料发布：正文为空时附件承担唯一内容来源', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({
        payloadSnapshot: materialSnapshot({ contentText: null }),
        attachment: attachmentRef(),
      }),
    );
    const { usecase, referenceDocumentService } = makeUsecase({ queryService });

    await usecase.execute(approveCommand({ publishAttachment: true }));

    expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        contentText: null,
        storageReference: 'published/2026/02/copy.pdf',
      }),
      transactionContext,
    );
  });

  it('正文为空且未选发布附件：无内容来源拒绝且不进入事务、不触盘', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ payloadSnapshot: materialSnapshot({ contentText: null }) }),
    );
    const { usecase, transactionRunner, storage } = makeUsecase({ queryService });

    await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
      code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('无附件版本选择发布附件：拒绝（不得发布不存在的原件）', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute(approveCommand({ publishAttachment: true })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('故障案例发布：可读正文与结构化明细由同一份冻结字段生成', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({
        submissionKind: 'FAULT_CASE',
        titleSnapshot: '曝光异常',
        payloadSnapshot: faultCaseSnapshot(),
      }),
    );
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      reviewableLock({ submissionKind: 'FAULT_CASE' }),
    );
    const { usecase, referenceDocumentService, referenceDocumentCaseDetailService } = makeUsecase({
      queryService,
      writeService,
    });

    await usecase.execute(approveCommand());

    expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'FAULT_CASE',
        description: null,
      }),
      transactionContext,
    );
    const insertArgs = referenceDocumentService.insertDocument.mock.calls[0][0] as {
      contentText: string;
    };
    expect(insertArgs.contentText).toContain('故障现象：\n现象');
    expect(insertArgs.contentText).toContain('复现步骤：\n步骤一\n步骤二');
    expect(insertArgs.contentText).toContain('处理状态：已解决');
    expect(insertArgs.contentText).toContain('处理结果：\n已更换部件');
    expect(referenceDocumentCaseDetailService.insertCaseDetail).toHaveBeenCalledWith(
      {
        documentId: 880001,
        errorCode: 'E-100',
        handlingStatus: 'RESOLVED',
        phenomenon: '现象',
        conditionText: null,
        reproductionSteps: '步骤一\n步骤二',
        diagnosis: null,
        actionTaken: null,
        resolution: '已更换部件',
        casePayloadJson: null,
      },
      transactionContext,
    );
  });

  it('快照损坏（资料缺资料类型）：受控收敛拒绝，不进入事务', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ payloadSnapshot: materialSnapshot({ documentType: null }) }),
    );
    const { usecase, transactionRunner } = makeUsecase({ queryService });

    await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
      code: CONTENT_SUBMISSION_ERROR.UPDATE_FAILED,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('跨组织投稿：统一 NOT_FOUND 且先于任何文件 I/O', async () => {
    const queryService = makeQueryService();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910002,
    });
    const { usecase, storage, transactionRunner } = makeUsecase({ queryService });

    await expect(
      usecase.execute(approveCommand({ publishAttachment: true })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('投稿不存在：统一 NOT_FOUND', async () => {
    const queryService = makeQueryService();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(null);
    const { usecase } = makeUsecase({ queryService });

    await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
      code: CONTENT_SUBMISSION_ERROR.NOT_FOUND,
    });
  });

  it('非管理员账号（工程师）不能使用审核功能：不进入任何读取', async () => {
    const { usecase, queryService, storage } = makeUsecase();

    await expect(usecase.execute(approveCommand({ session: engineer }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(queryService.findSubmissionAccessFacts).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('发布附件决定非布尔：INVALID_PARAMS', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute(approveCommand({ publishAttachment: 'yes' as unknown as boolean })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
  });

  it('复制前预检：状态已流转（已发布重复审批）→ STATE_NOT_EDITABLE 且不发生文件 I/O', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    queryService.findReviewPrecheckFacts.mockResolvedValueOnce({
      status: 'PUBLISHED',
      currentRevisionNo: 1,
    });
    const { usecase, storage, transactionRunner, writeService } = makeUsecase({ queryService });

    await expect(
      usecase.execute(approveCommand({ publishAttachment: true })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    // 预检减少无效复制：不触盘、不进入事务、不写审核记录
    expect(storage.open).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(writeService.insertReview).not.toHaveBeenCalled();
  });

  it('复制前预检：目标版本不是当前待审版本（旧版本重复审批）→ STATE_NOT_EDITABLE 且不发生文件 I/O', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    queryService.findReviewPrecheckFacts.mockResolvedValueOnce({
      status: 'PENDING_REVIEW',
      currentRevisionNo: 2,
    });
    const { usecase, storage, transactionRunner } = makeUsecase({ queryService });

    await expect(
      usecase.execute(approveCommand({ publishAttachment: true })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(storage.open).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('并发防护：预检通过后事务内重核状态已流转 → STATE_NOT_EDITABLE，已复制副本被补偿删除', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      reviewableLock({ status: 'PUBLISHED' }),
    );
    const { usecase, storage } = makeUsecase({ queryService, writeService });

    await expect(
      usecase.execute(approveCommand({ publishAttachment: true })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(writeService.insertReview).not.toHaveBeenCalled();
    // 回调未完成（锁定内拒绝）→ 确定回滚且核查无正式资料 → 精确清理本次副本
    expect(storage.delete).toHaveBeenCalledWith('published/2026/02/copy.pdf');
  });

  it('并发防护：revisionId 不是当前待审版本 → STATE_NOT_EDITABLE 且不写审核记录', async () => {
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      reviewableLock({ currentRevisionNo: 2 }),
    );
    const { usecase } = makeUsecase({ writeService });

    await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });
    expect(writeService.insertReview).not.toHaveBeenCalled();
  });

  it('发布事务失败补偿：核查无正式资料引用且回调未完成 → 精确删除本次新副本', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    const writeService = makeWriteService();
    writeService.markSubmissionPublished.mockRejectedValueOnce(new Error('db down'));
    const {
      usecase,
      storage,
      queryService: queryServiceRef,
    } = makeUsecase({
      queryService,
      writeService,
    });

    await expect(usecase.execute(approveCommand({ publishAttachment: true }))).rejects.toThrow(
      'db down',
    );
    expect(queryServiceRef.findPublishedDocumentFileRefBySourceSubmission).toHaveBeenCalledWith({
      submissionId: 970001,
    });
    expect(storage.delete).toHaveBeenCalledWith('published/2026/02/copy.pdf');
  });

  it('提交确认丢失：正式资料已引用本次副本 → 绝不误删', async () => {
    const loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const transactionRunner = makeTransactionRunner();
    // 回调完整成功（提交已发出）→ 提交阶段抛错（确认丢失/连接异常）
    transactionRunner.run.mockImplementationOnce(async (cb: (ctx: unknown) => Promise<unknown>) => {
      await cb(transactionContext);
      throw new Error('commit ack lost');
    });
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    queryService.findPublishedDocumentFileRefBySourceSubmission.mockResolvedValueOnce({
      documentId: 880001,
      storageReference: 'published/2026/02/copy.pdf',
    });
    const { usecase, storage } = makeUsecase({ queryService, transactionRunner });

    try {
      await expect(usecase.execute(approveCommand({ publishAttachment: true }))).rejects.toThrow(
        'commit ack lost',
      );
      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('published/2026/02/copy.pdf'),
      );
    } finally {
      loggerWarnSpy.mockRestore();
    }
  });

  it('并发成功方场景：正式资料已引用其他副本 → 本次失败副本精确清理，成功方文件不被触碰', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    // 并发请求 A 已成功发布，其副本与本次副本不同（唯一来源约束闭环）
    queryService.findPublishedDocumentFileRefBySourceSubmission.mockResolvedValueOnce({
      documentId: 880001,
      storageReference: 'published/2026/02/copy-of-A.pdf',
    });
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      reviewableLock({ status: 'PUBLISHED' }),
    );
    const { usecase, storage } = makeUsecase({ queryService, writeService });

    await expect(
      usecase.execute(approveCommand({ publishAttachment: true })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(storage.delete).toHaveBeenCalledWith('published/2026/02/copy.pdf');
    expect(storage.delete).not.toHaveBeenCalledWith('published/2026/02/copy-of-A.pdf');
  });

  it('成功方未发布附件（正式资料无文件）：本次失败副本同样精确清理', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    queryService.findPublishedDocumentFileRefBySourceSubmission.mockResolvedValueOnce({
      documentId: 880001,
      storageReference: null,
    });
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      reviewableLock({ status: 'PUBLISHED' }),
    );
    const { usecase, storage } = makeUsecase({ queryService, writeService });

    await expect(
      usecase.execute(approveCommand({ publishAttachment: true })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(storage.delete).toHaveBeenCalledWith('published/2026/02/copy.pdf');
  });

  it('回调已完成但核查无正式资料（提交终局不明）：保留文件并记录，不做删除猜测', async () => {
    const loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const transactionRunner = makeTransactionRunner();
    transactionRunner.run.mockImplementationOnce(async (cb: (ctx: unknown) => Promise<unknown>) => {
      await cb(transactionContext);
      throw new Error('commit ack lost');
    });
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    const { usecase, storage } = makeUsecase({ queryService, transactionRunner });

    try {
      await expect(usecase.execute(approveCommand({ publishAttachment: true }))).rejects.toThrow(
        'commit ack lost',
      );
      // 单次读取为空不能当作终局回滚证据
      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('published/2026/02/copy.pdf'),
      );
    } finally {
      loggerErrorSpy.mockRestore();
    }
  });

  it('补偿核查读取失败：保留文件、记录待核查引用，原错误不被覆盖（fail-safe）', async () => {
    const loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    const writeService = makeWriteService();
    writeService.markSubmissionPublished.mockRejectedValueOnce(new Error('db down'));
    const { usecase, storage } = makeUsecase({ queryService, writeService });
    queryService.findPublishedDocumentFileRefBySourceSubmission.mockRejectedValueOnce(
      new Error('probe timeout'),
    );

    try {
      await expect(usecase.execute(approveCommand({ publishAttachment: true }))).rejects.toThrow(
        'db down',
      );
      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('published/2026/02/copy.pdf'),
        expect.anything(),
      );
    } finally {
      loggerErrorSpy.mockRestore();
    }
  });

  it('补偿删除失败不静默：记录错误日志并仍抛原错误', async () => {
    const loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    const writeService = makeWriteService();
    writeService.markSubmissionPublished.mockRejectedValueOnce(new Error('db down'));
    const storage = makeStorage();
    storage.delete.mockRejectedValueOnce(new Error('io error'));
    const { usecase } = makeUsecase({ queryService, writeService, storage });

    await expect(usecase.execute(approveCommand({ publishAttachment: true }))).rejects.toThrow(
      'db down',
    );
    expect(loggerErrorSpy).toHaveBeenCalled();
  });

  it('获准原件不可用：FILE_NOT_AVAILABLE 且不进入事务', async () => {
    const queryService = makeQueryService();
    queryService.findRevisionPublishSource.mockResolvedValueOnce(
      publishSource({ attachment: attachmentRef() }),
    );
    const storage = makeStorage();
    storage.open.mockRejectedValueOnce(new Error('gone'));
    const { usecase, transactionRunner } = makeUsecase({ queryService, storage });

    await expect(
      usecase.execute(approveCommand({ publishAttachment: true })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.FILE_NOT_AVAILABLE });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });
});

describe('ListReviewQueueUsecase（审核队列）', () => {
  const queuePage = () => ({ items: [], total: 0, page: 1, pageSize: 20 });

  const makeQueryService = () => ({
    listReviewQueue: jest.fn().mockResolvedValue(queuePage()),
  });

  const makeOrganizationContextService = () => ({
    resolveForAccount: jest.fn().mockResolvedValue(membership),
  });

  const makeUsecase = (
    overrides: {
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();

    const usecase = new ListReviewQueueUsecase(
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    return { usecase, queryService, organizationContextService };
  };

  const queueCommand = (overrides: Record<string, unknown> = {}) => ({
    session: superAdmin,
    pagination: { mode: 'OFFSET' as const, page: 1, pageSize: 20 },
    ...overrides,
  });

  it('默认待审队列：status 缺省按 PENDING_REVIEW，本组织范围单过滤', async () => {
    const { usecase, queryService } = makeUsecase();

    const result = await usecase.execute(queueCommand());

    expect(queryService.listReviewQueue).toHaveBeenCalledWith({
      ownerOrganizationId: 910001,
      filter: { title: undefined, submissionKind: undefined, status: 'PENDING_REVIEW' },
      pagination: { page: 1, pageSize: 20, withTotal: false },
    });
    expect(result).toEqual(queuePage());
  });

  it('显式筛选：标题词 trim、类别与状态透传', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute(
      queueCommand({
        filter: { title: ' 手册 ', submissionKind: 'MATERIAL', status: 'RETURNED' },
      }),
    );

    expect(queryService.listReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { title: '手册', submissionKind: 'MATERIAL', status: 'RETURNED' },
      }),
    );
  });

  it('空白状态筛选视为未提供：仍按默认待审', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute(queueCommand({ filter: { status: '   ' } }));

    expect(queryService.listReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({ status: 'PENDING_REVIEW' }),
      }),
    );
  });

  it('非法状态值：INVALID_PARAMS 且不触发查询', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute(queueCommand({ filter: { status: 'UNKNOWN' } })),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE });
    expect(queryService.listReviewQueue).not.toHaveBeenCalled();
  });

  it('工程师账号不能使用审核功能：不触发组织解析与查询', async () => {
    const { usecase, queryService, organizationContextService } = makeUsecase();

    await expect(usecase.execute(queueCommand({ session: engineer }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.listReviewQueue).not.toHaveBeenCalled();
  });

  it('非 OFFSET 分页：INVALID_PARAMS', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute(queueCommand({ pagination: { mode: 'CURSOR' as const } })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
  });

  it('页大小超过上限收敛为 100，页码下限为 1', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute(
      queueCommand({
        pagination: { mode: 'OFFSET' as const, page: 0, pageSize: 500, withTotal: true },
      }),
    );

    expect(queryService.listReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: { page: 1, pageSize: 100, withTotal: true } }),
    );
  });
});

describe('GetReviewDetailUsecase（审核详情）', () => {
  const reviewDetail = (overrides: Record<string, unknown> = {}) => ({
    submissionId: 970001,
    submissionKind: 'MATERIAL',
    status: 'PENDING_REVIEW',
    currentRevisionNo: 1,
    lastSubmittedAt: new Date('2026-02-01T10:00:00.000Z'),
    submittedByAccountId: 900001,
    currentRevision: null,
    reviewHistory: [],
    ...overrides,
  });

  const makeQueryService = () => ({
    findSubmissionAccessFacts: jest
      .fn()
      .mockResolvedValue({ submittedByAccountId: 900001, ownerOrganizationId: 910001 }),
    findReviewDetail: jest.fn().mockResolvedValue(reviewDetail()),
  });

  const makeOrganizationContextService = () => ({
    resolveForAccount: jest.fn().mockResolvedValue(membership),
  });

  const makeUsecase = (
    overrides: {
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();

    const usecase = new GetReviewDetailUsecase(
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    return { usecase, queryService, organizationContextService };
  };

  it('本组织管理员读取详情：完整视图透传', async () => {
    const { usecase, queryService } = makeUsecase();

    const result = await usecase.execute({ session: superAdmin, submissionId: 970001 });

    expect(queryService.findReviewDetail).toHaveBeenCalledWith({ submissionId: 970001 });
    expect(result).toEqual(reviewDetail());
  });

  it('跨组织投稿：统一 NOT_FOUND（不区分不存在）', async () => {
    const queryService = makeQueryService();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910002,
    });
    const { usecase, queryService: queryServiceRef } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryServiceRef.findReviewDetail).not.toHaveBeenCalled();
  });

  it('投稿不存在：统一 NOT_FOUND', async () => {
    const queryService = makeQueryService();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(null);
    const { usecase } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
  });

  it('工程师账号不能使用审核功能：不触发组织解析与读取', async () => {
    const { usecase, queryService, organizationContextService } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.findSubmissionAccessFacts).not.toHaveBeenCalled();
  });

  it('投稿 ID 非法：INVALID_PARAMS', async () => {
    const { usecase } = makeUsecase();

    await expect(usecase.execute({ session: superAdmin, submissionId: 0 })).rejects.toMatchObject({
      code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
    });
  });

  it('访问事实存在而详情缺失：NOT_FOUND（并发删除防御）', async () => {
    const queryService = makeQueryService();
    queryService.findReviewDetail.mockResolvedValueOnce(null);
    const { usecase } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
  });
});

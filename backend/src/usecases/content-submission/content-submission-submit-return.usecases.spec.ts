// src/usecases/content-submission/content-submission-submit-return.usecases.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { CONTENT_SUBMISSION_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import type { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { GetContentSubmissionRevisionUsecase } from './get-content-submission-revision.usecase';
import { ReturnContentSubmissionUsecase } from './return-content-submission.usecase';
import { SubmitContentSubmissionUsecase } from './submit-content-submission.usecase';

const transactionContext = { transaction: 'mock' };

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const otherEngineer = session(['ENGINEER'], 900002);
const superAdmin = session(['SUPER_ADMIN'], 900099);
const customer = session(['CUSTOMER']);

/** 行锁快照替身（默认本人 + 本组织 + DRAFT 普通资料 + 无历史版本） */
const materialLock = (overrides: Record<string, unknown> = {}) => ({
  id: 970001,
  submissionKind: 'MATERIAL',
  ownerOrganizationId: 910001,
  submittedByAccountId: 900001,
  status: 'DRAFT',
  currentRevisionNo: 0,
  ...overrides,
});

const faultCaseLock = (overrides: Record<string, unknown> = {}) =>
  materialLock({ submissionKind: 'FAULT_CASE', ...overrides });

/** 普通资料明细事务内事实替身（送审完整校验与快照来源） */
const materialDetail = (overrides: Record<string, unknown> = {}) => ({
  title: '操作手册',
  documentType: 'MANUAL',
  equipmentModelId: null,
  equipmentModelText: null,
  description: null,
  contentText: '正文',
  ...overrides,
});

/** 故障案例明细事务内事实替身 */
const faultCaseDetail = (overrides: Record<string, unknown> = {}) => ({
  title: '曝光异常',
  equipmentModelId: null,
  equipmentModelText: null,
  errorCode: null,
  phenomenon: '现象',
  conditionText: null,
  reproductionSteps: '步骤一\n步骤二',
  diagnosis: null,
  actionTaken: null,
  handlingStatus: 'UNRESOLVED',
  resolution: null,
  ...overrides,
});

/** 写后回读状态快照替身（write-then-read 真实落库状态） */
const statusSnapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 970001,
  submissionKind: 'MATERIAL',
  status: 'DRAFT',
  updatedAt: new Date('2026-02-01T10:00:00.000Z'),
  ...overrides,
});

/** 冻结版本稳定视图替身（附件只含安全元数据，无存储引用） */
const revisionView = (overrides: Record<string, unknown> = {}) => ({
  revisionId: 990001,
  submissionId: 970001,
  submissionKind: 'MATERIAL',
  revisionNo: 1,
  schemaVersion: 1,
  titleSnapshot: '操作手册',
  payloadSnapshot: {
    title: '操作手册',
    documentType: 'MANUAL',
    equipmentModelId: null,
    equipmentModelText: null,
    description: null,
    contentText: '正文',
  },
  attachment: null,
  noticeVersion: 'library-internal-v1',
  confirmedAt: new Date('2026-02-01T10:00:00.000Z'),
  submittedAt: new Date('2026-02-01T10:00:00.000Z'),
  review: null,
  ...overrides,
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 950001,
    organizationId: 910001,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '甲方默认组织',
    organizationKind: 'CLIENT',
    memberRole: 'ENGINEER',
  }),
});

const makeTransactionRunner = () =>
  ({
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
  }) as unknown as TransactionRunner & { run: jest.Mock };

describe('SubmitContentSubmissionUsecase', () => {
  const makeWriteService = () => ({
    lockSubmissionForWrite: jest.fn().mockResolvedValue(null),
    insertRevision: jest.fn().mockResolvedValue({ revisionId: 990001 }),
    markSubmissionPendingReview: jest.fn().mockResolvedValue(undefined),
  });

  const makeQueryService = () => ({
    readStatusSnapshot: jest.fn().mockResolvedValue(statusSnapshot({ status: 'PENDING_REVIEW' })),
    readMaterialDetailForWrite: jest.fn().mockResolvedValue(materialDetail()),
    readFaultCaseDetailForWrite: jest.fn().mockResolvedValue(faultCaseDetail()),
    readCurrentAttachmentsForSubmit: jest.fn().mockResolvedValue(null),
  });

  const makeUsecase = (
    overrides: {
      writeService?: ReturnType<typeof makeWriteService>;
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
      transactionRunner?: ReturnType<typeof makeTransactionRunner>;
    } = {},
  ) => {
    const writeService = overrides.writeService ?? makeWriteService();
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    const transactionRunner = overrides.transactionRunner ?? makeTransactionRunner();

    const usecase = new SubmitContentSubmissionUsecase(
      writeService as unknown as ContentSubmissionService,
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    );

    return { usecase, writeService, queryService, organizationContextService, transactionRunner };
  };

  it('DRAFT 资料送审：冻结版本 1 完整快照，告知版本/确认人服务端落库，状态流转待审', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(materialLock());

    const result = await usecase.execute({
      session: engineer,
      submissionId: 970001,
      libraryNoticeConfirmed: true,
    });

    expect(writeService.insertRevision).toHaveBeenCalledWith(
      {
        submissionId: 970001,
        revisionNo: 1,
        payloadSnapshot: {
          title: '操作手册',
          documentType: 'MANUAL',
          equipmentModelId: null,
          equipmentModelText: null,
          description: null,
          contentText: '正文',
        },
        schemaVersion: 1,
        titleSnapshot: '操作手册',
        attachmentId: null,
        noticeVersion: 'library-internal-v1',
        confirmedByAccountId: 900001,
      },
      transactionContext,
    );
    expect(writeService.markSubmissionPendingReview).toHaveBeenCalledWith({
      submissionId: 970001,
      revisionNo: 1,
      transactionContext,
    });
    // 结果状态来自同一事务回读，不回显请求入参
    expect(result).toEqual({
      submissionId: 970001,
      revisionId: 990001,
      revisionNo: 1,
      status: 'PENDING_REVIEW',
    });
  });

  it('有附件的资料送审：快照附件 ID 来自真实 CURRENT 附件，正文为空也可送审', async () => {
    const { usecase, writeService, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(materialLock());
    queryService.readMaterialDetailForWrite.mockResolvedValueOnce(
      materialDetail({ contentText: null }),
    );
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValueOnce({ attachmentId: 980001 });

    await usecase.execute({
      session: engineer,
      submissionId: 970001,
      libraryNoticeConfirmed: true,
    });

    expect(writeService.insertRevision).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 980001 }),
      transactionContext,
    );
  });

  it('RETURNED 重提：在旧版基础上新建下一版本（revisionNo=当前版本+1，旧版保留）', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      materialLock({ status: 'RETURNED', currentRevisionNo: 1 }),
    );
    writeService.insertRevision.mockResolvedValueOnce({ revisionId: 990002 });

    const result = await usecase.execute({
      session: engineer,
      submissionId: 970001,
      libraryNoticeConfirmed: true,
    });

    expect(writeService.insertRevision).toHaveBeenCalledWith(
      expect.objectContaining({ revisionNo: 2 }),
      transactionContext,
    );
    expect(writeService.markSubmissionPendingReview).toHaveBeenCalledWith({
      submissionId: 970001,
      revisionNo: 2,
      transactionContext,
    });
    expect(result.revisionId).toBe(990002);
    expect(result.revisionNo).toBe(2);
  });

  it('PENDING_REVIEW 重复送审：STATE_NOT_EDITABLE 且不生成新版本（并发防护不穿透）', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      materialLock({ status: 'PENDING_REVIEW', currentRevisionNo: 1 }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, libraryNoticeConfirmed: true }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(writeService.insertRevision).not.toHaveBeenCalled();
    expect(writeService.markSubmissionPendingReview).not.toHaveBeenCalled();
  });

  it('未确认入库告知：INVALID_PARAMS 且不进入事务（告知不接受客户端省略）', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, libraryNoticeConfirmed: false }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('资料缺标题：DRAFT_EMPTY 且不冻结版本', async () => {
    const { usecase, writeService, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(materialLock());
    queryService.readMaterialDetailForWrite.mockResolvedValueOnce(materialDetail({ title: null }));

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, libraryNoticeConfirmed: true }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY });
    expect(writeService.insertRevision).not.toHaveBeenCalled();
  });

  it('资料正文为空且无当前附件：DRAFT_EMPTY（正文与附件至少一项）', async () => {
    const { usecase, writeService, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(materialLock());
    queryService.readMaterialDetailForWrite.mockResolvedValueOnce(
      materialDetail({ contentText: null }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, libraryNoticeConfirmed: true }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY });
    expect(writeService.insertRevision).not.toHaveBeenCalled();
  });

  it('案例缺复现步骤：DRAFT_EMPTY 且不冻结版本', async () => {
    const { usecase, writeService, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(faultCaseLock());
    queryService.readFaultCaseDetailForWrite.mockResolvedValueOnce(
      faultCaseDetail({ reproductionSteps: null }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, libraryNoticeConfirmed: true }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY });
    expect(writeService.insertRevision).not.toHaveBeenCalled();
  });

  it('案例已解决但无结果：INVALID_PARAMS（与数据库 CHECK 同口径）', async () => {
    const { usecase, writeService, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(faultCaseLock());
    queryService.readFaultCaseDetailForWrite.mockResolvedValueOnce(
      faultCaseDetail({ handlingStatus: 'RESOLVED', resolution: null }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, libraryNoticeConfirmed: true }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.insertRevision).not.toHaveBeenCalled();
  });

  it('案例送审：冻结 11 字段完整快照', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(faultCaseLock());

    await usecase.execute({
      session: engineer,
      submissionId: 970001,
      libraryNoticeConfirmed: true,
    });

    expect(writeService.insertRevision).toHaveBeenCalledWith(
      {
        submissionId: 970001,
        revisionNo: 1,
        payloadSnapshot: {
          title: '曝光异常',
          equipmentModelId: null,
          equipmentModelText: null,
          errorCode: null,
          phenomenon: '现象',
          conditionText: null,
          reproductionSteps: '步骤一\n步骤二',
          diagnosis: null,
          actionTaken: null,
          handlingStatus: 'UNRESOLVED',
          resolution: null,
        },
        schemaVersion: 1,
        titleSnapshot: '曝光异常',
        attachmentId: null,
        noticeVersion: 'library-internal-v1',
        confirmedByAccountId: 900001,
      },
      transactionContext,
    );
  });

  it('他人投稿：NOT_FOUND 且不冻结版本（归属不可伪造）', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      materialLock({ submittedByAccountId: 900002 }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, libraryNoticeConfirmed: true }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(writeService.insertRevision).not.toHaveBeenCalled();
  });

  it('管理员账号（activeRole=SUPER_ADMIN）：PERMISSION_ERROR 且不进入事务（写入口不继承）', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001, libraryNoticeConfirmed: true }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });
});

describe('GetContentSubmissionRevisionUsecase', () => {
  const makeQueryService = () => ({
    findSubmissionAccessFacts: jest.fn().mockResolvedValue(null),
    findRevisionView: jest.fn().mockResolvedValue(null),
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

    const usecase = new GetContentSubmissionRevisionUsecase(
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    return { usecase, queryService, organizationContextService };
  };

  it('本人读取冻结版本：返回完整快照与安全附件元数据（无存储引用）', async () => {
    const { usecase, queryService } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910001,
    });
    const view = revisionView({
      attachment: {
        id: 980001,
        originalFilename: '操作手册.pdf',
        mimeType: 'application/pdf',
        byteSize: 10,
        uploadedAt: new Date('2026-02-01T10:00:00.000Z'),
      },
      review: {
        decision: 'RETURN',
        comment: '请补充说明',
        publishAttachment: false,
        reviewedAt: new Date('2026-02-02T10:00:00.000Z'),
      },
    });
    queryService.findRevisionView.mockResolvedValueOnce(view);

    const result = await usecase.execute({
      session: engineer,
      submissionId: 970001,
      revisionNo: 1,
    });

    expect(queryService.findRevisionView).toHaveBeenCalledWith({
      submissionId: 970001,
      revisionNo: 1,
    });
    expect(result).toEqual(view);
  });

  it('本组织管理员读取他人投稿版本：可读（本人或本组织管理员口径）', async () => {
    const { usecase, queryService } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900002,
      ownerOrganizationId: 910001,
    });
    queryService.findRevisionView.mockResolvedValueOnce(revisionView());

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001, revisionNo: 1 }),
    ).resolves.toEqual(revisionView());
  });

  it('角色含 SUPER_ADMIN 但 activeRole 为 ENGINEER（管理员兼工程师以工程师身份操作）：他人投稿 NOT_FOUND（精确口径失败关闭）', async () => {
    const { usecase, queryService } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900002,
      ownerOrganizationId: 910001,
    });

    await expect(
      usecase.execute({
        session: session(['ENGINEER', 'SUPER_ADMIN'], 900099),
        submissionId: 970001,
        revisionNo: 1,
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryService.findRevisionView).not.toHaveBeenCalled();
  });

  it('同组织其他工程师：NOT_FOUND 且不读版本（不泄露存在性）', async () => {
    const { usecase, queryService } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910001,
    });

    await expect(
      usecase.execute({ session: otherEngineer, submissionId: 970001, revisionNo: 1 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryService.findRevisionView).not.toHaveBeenCalled();
  });

  it('跨组织管理员：NOT_FOUND 且不读版本（第二组织不可读甲方数据）', async () => {
    const { usecase, queryService } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910002,
    });

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001, revisionNo: 1 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryService.findRevisionView).not.toHaveBeenCalled();
  });

  it('投稿不存在：NOT_FOUND 且不读版本', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, revisionNo: 1 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryService.findRevisionView).not.toHaveBeenCalled();
  });

  it('版本不存在：NOT_FOUND（不泄露版本存在性）', async () => {
    const { usecase, queryService } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910001,
    });

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, revisionNo: 9 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
  });

  it('版本号非法：INVALID_PARAMS 且不解析组织', async () => {
    const { usecase, organizationContextService } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, revisionNo: 0 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });

  it('客户角色：PERMISSION_ERROR 且不解析组织（读取入口不放开）', async () => {
    const { usecase, organizationContextService } = makeUsecase();

    await expect(
      usecase.execute({ session: customer, submissionId: 970001, revisionNo: 1 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });
});

describe('ReturnContentSubmissionUsecase', () => {
  const makeWriteService = () => ({
    lockSubmissionForWrite: jest.fn().mockResolvedValue(null),
    insertReview: jest.fn().mockResolvedValue({ reviewId: 995001 }),
    markSubmissionReturned: jest.fn().mockResolvedValue(undefined),
  });

  const makeQueryService = () => ({
    findRevisionIdentity: jest.fn().mockResolvedValue({ revisionId: 990001, revisionNo: 1 }),
    readStatusSnapshot: jest.fn().mockResolvedValue(statusSnapshot({ status: 'RETURNED' })),
  });

  const makeUsecase = (
    overrides: {
      writeService?: ReturnType<typeof makeWriteService>;
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
      transactionRunner?: ReturnType<typeof makeTransactionRunner>;
    } = {},
  ) => {
    const writeService = overrides.writeService ?? makeWriteService();
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    const transactionRunner = overrides.transactionRunner ?? makeTransactionRunner();

    const usecase = new ReturnContentSubmissionUsecase(
      writeService as unknown as ContentSubmissionService,
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    );

    return { usecase, writeService, queryService, organizationContextService, transactionRunner };
  };

  it('退回成功：理由 trim 落库、旧版保留（不清版本号），状态流转 RETURNED', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      materialLock({ status: 'PENDING_REVIEW', currentRevisionNo: 1 }),
    );

    const result = await usecase.execute({
      session: superAdmin,
      submissionId: 970001,
      revisionId: 990001,
      comment: '  描述不清，请补充  ',
    });

    expect(writeService.insertReview).toHaveBeenCalledWith(
      {
        submissionId: 970001,
        revisionId: 990001,
        decision: 'RETURN',
        reviewedByAccountId: 900099,
        comment: '描述不清，请补充',
        publishAttachment: false,
      },
      transactionContext,
    );
    expect(writeService.markSubmissionReturned).toHaveBeenCalledWith({
      submissionId: 970001,
      transactionContext,
    });
    // 结果状态来自回读；退回不产生正式资料
    expect(result).toEqual({ submissionId: 970001, status: 'RETURNED', documentId: null });
  });

  it('非待审状态（DRAFT）：STATE_NOT_EDITABLE 且不写审核记录', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(materialLock());

    await expect(
      usecase.execute({
        session: superAdmin,
        submissionId: 970001,
        revisionId: 990001,
        comment: '理由',
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(writeService.insertReview).not.toHaveBeenCalled();
  });

  it('revisionId 不是当前待审版本：STATE_NOT_EDITABLE 且不写审核记录', async () => {
    const { usecase, writeService, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      materialLock({ status: 'PENDING_REVIEW', currentRevisionNo: 2 }),
    );

    await expect(
      usecase.execute({
        session: superAdmin,
        submissionId: 970001,
        revisionId: 990001,
        comment: '理由',
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(queryService.findRevisionIdentity).toHaveBeenCalledWith({
      submissionId: 970001,
      revisionId: 990001,
      transactionContext,
    });
    expect(writeService.insertReview).not.toHaveBeenCalled();
  });

  it('revisionId 不属于该投稿：STATE_NOT_EDITABLE（统一收敛不泄露版本存在性）', async () => {
    const { usecase, writeService, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      materialLock({ status: 'PENDING_REVIEW', currentRevisionNo: 1 }),
    );
    queryService.findRevisionIdentity.mockResolvedValueOnce(null);

    await expect(
      usecase.execute({
        session: superAdmin,
        submissionId: 970001,
        revisionId: 990099,
        comment: '理由',
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(writeService.insertReview).not.toHaveBeenCalled();
  });

  it('退回理由缺失（undefined）：INVALID_PARAMS 且不进入事务', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001, revisionId: 990001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('退回理由为空白：INVALID_PARAMS 且不进入事务', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute({
        session: superAdmin,
        submissionId: 970001,
        revisionId: 990001,
        comment: '   ',
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('退回理由超长（>2000）：INVALID_PARAMS 且不进入事务', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute({
        session: superAdmin,
        submissionId: 970001,
        revisionId: 990001,
        comment: 'x'.repeat(2001),
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('跨组织管理员：NOT_FOUND 且不写审核记录（第二组织不可审核甲方数据）', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      materialLock({ status: 'PENDING_REVIEW', currentRevisionNo: 1, ownerOrganizationId: 910002 }),
    );

    await expect(
      usecase.execute({
        session: superAdmin,
        submissionId: 970001,
        revisionId: 990001,
        comment: '理由',
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(writeService.insertReview).not.toHaveBeenCalled();
  });

  it('工程师账号：PERMISSION_ERROR 且不进入事务（审核不继承工程师身份）', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineer,
        submissionId: 970001,
        revisionId: 990001,
        comment: '理由',
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('客户角色：PERMISSION_ERROR 且不进入事务', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute({
        session: customer,
        submissionId: 970001,
        revisionId: 990001,
        comment: '理由',
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });
});

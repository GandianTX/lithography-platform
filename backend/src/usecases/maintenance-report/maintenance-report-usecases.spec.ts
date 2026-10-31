// src/usecases/maintenance-report/maintenance-report-usecases.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  AnalysisOutputGenerationStatus,
  MaintenanceAiUsage,
  MaintenanceAlarmResetResult,
  MaintenancePhaseCode,
} from '@app-types/models/maintenance-report.types';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import {
  MAINTENANCE_REPORT_ERROR,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors/domain-error';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { UnavailableAnalysisOutputReader } from '@src/infrastructure/ai/unavailable-analysis-output-reader';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { ApproveMaintenanceReportUsecase } from './approve-maintenance-report.usecase';
import { ReturnMaintenanceReportUsecase } from './return-maintenance-report.usecase';
import { SubmitMaintenanceReportUsecase } from './submit-maintenance-report.usecase';
import { RecordRepairRequestHandlingResultUsecase } from './record-repair-request-handling-result.usecase';
import { normalizeMaintenanceReportDraft } from './maintenance-report.input.normalize';
import type { AnalysisOutputReader } from './ports/analysis-output-reader.contract';
import { InMemoryAnalysisOutputReader } from './testing/in-memory-analysis-output-reader';

const transactionContext = { transaction: 'mock' };
const REPORT_ID = 960001;
const VERSION_ID = 990001;
const ATTACHMENT_ID = 970001;
const ORGANIZATION_ID = 910001;
const REPAIR_REQUEST_ID = 955001;

const engineerSession = {
  accountId: 900001,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;
const adminSession = {
  accountId: 900099,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;
const customerSession = {
  accountId: 900050,
  roles: ['CUSTOMER'],
  activeRole: 'CUSTOMER',
} as unknown as UsecaseSession;

const makeReport = (overrides: Record<string, unknown> = {}) => ({
  id: REPORT_ID,
  ownerOrganizationId: ORGANIZATION_ID,
  sourceType: 'WORK_ORDER_SUMMARY',
  repairRequestId: REPAIR_REQUEST_ID,
  title: '曝光机报警维修报告',
  customerFactoryName: '某封测厂',
  equipmentModelId: null,
  equipmentModelText: 'NSR-2205i11',
  maintenanceDate: '2026-10-01',
  maintenanceEngineerAccountId: 900001,
  maintenanceEngineerNameSnapshot: '张工',
  phaseFlowVersion: 1,
  status: 'DRAFT',
  currentVersionNo: 0,
  lastSubmittedAt: null,
  lastReviewedAt: null,
  aiUsage: MaintenanceAiUsage.NOT_USED,
  aiSourceType: null,
  aiSourceId: null,
  aiSourceVersion: null,
  aiScore: null,
  aiCorrectness: null,
  aiHelpfulness: null,
  aiNote: null,
  createdByAccountId: 900001,
  updatedByAccountId: 900001,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const makeDetail = (overrides: Record<string, unknown> = {}) => ({
  report: makeReport(),
  alarms: [
    {
      id: 1,
      reportId: REPORT_ID,
      alarmIndex: 1,
      alarmCode: 'ALM-001',
      alarmDescription: '光源功率异常',
      phaseCode: 'PHASE_01',
      resetResult: 'RESET_OK',
    },
  ],
  steps: [
    {
      id: 1,
      reportId: REPORT_ID,
      stepNo: 1,
      stepCode: 'STEP-001',
      phaseCode: 'PHASE_02',
      partName: '光源模块',
      actionText: '更换光源模块并复位',
      resultText: '报警消除',
      newAlarmCode: null,
      isValidNewBranch: true,
    },
  ],
  attachments: [],
  latestReturnComment: null,
  ...overrides,
});

const makeAttachment = (overrides: Record<string, unknown> = {}) => ({
  id: ATTACHMENT_ID,
  reportId: REPORT_ID,
  originalFilename: '现场照片.jpg',
  mimeType: 'image/jpeg',
  byteSize: 1024,
  checksumSha256: null,
  storageBackend: 'LOCAL',
  storageReference: 'maintenance/report-960001/photo.jpg',
  sortOrder: 1,
  description: '现场照片',
  status: 'CURRENT',
  uploadedByAccountId: 900001,
  retiredAt: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const makeVersion = (overrides: Record<string, unknown> = {}) => ({
  id: VERSION_ID,
  reportId: REPORT_ID,
  versionNo: 1,
  changeKind: 'SUBMIT',
  changeReason: null,
  schemaVersion: 2,
  payloadSnapshot: {},
  submittedByAccountId: 900001,
  submittedAt: new Date('2026-10-01T00:00:00.000Z'),
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 950001,
    organizationId: ORGANIZATION_ID,
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

const makeWriteService = () => ({
  lockReportForWrite: jest.fn().mockResolvedValue(makeReport()),
  insertVersion: jest.fn().mockResolvedValue(makeVersion()),
  insertVersionAttachments: jest.fn().mockResolvedValue(undefined),
  markPendingReview: jest.fn().mockResolvedValue(undefined),
  insertReview: jest.fn().mockImplementation((data: Record<string, unknown>) =>
    Promise.resolve({
      id: 995001,
      ...data,
    }),
  ),
  markReturned: jest.fn().mockResolvedValue(undefined),
  markApproved: jest.fn().mockResolvedValue(undefined),
  publishVersionAttachments: jest.fn().mockResolvedValue(undefined),
});

const makeSubmitQueryService = (
  detail = makeDetail(),
  attachments: unknown[] = [],
  preReport: unknown = detail.report,
) => ({
  // 事务外预读：正常路径与事务内行锁回读同一报告事实；预读值可单独注入以模拟并发改动
  readReport: jest.fn().mockResolvedValue(preReport),
  readDraftDetail: jest.fn().mockResolvedValue(detail),
  readCurrentAttachmentsForSubmit: jest.fn().mockResolvedValue(attachments),
});

const makeSubmitUsecase = (params: {
  writeService?: ReturnType<typeof makeWriteService>;
  queryService?: ReturnType<typeof makeSubmitQueryService>;
  reader?: AnalysisOutputReader;
  organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
}) => {
  const writeService = params.writeService ?? makeWriteService();
  const queryService = params.queryService ?? makeSubmitQueryService();
  const organizationContextService =
    params.organizationContextService ?? makeOrganizationContextService();
  const reader = params.reader ?? new InMemoryAnalysisOutputReader();
  const transactionRunner = makeTransactionRunner();
  const usecase = new SubmitMaintenanceReportUsecase(
    writeService as unknown as MaintenanceReportService,
    queryService as unknown as MaintenanceReportQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    reader,
    transactionRunner,
  );
  return { usecase, writeService, queryService, reader };
};

const makeReviewUsecase = (params: {
  writeService?: ReturnType<typeof makeWriteService>;
  queryService?: ReturnType<typeof makeSubmitQueryService>;
  organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
}) => {
  const writeService = params.writeService ?? makeWriteService();
  const queryService = params.queryService ?? makeSubmitQueryService();
  const organizationContextService =
    params.organizationContextService ?? makeOrganizationContextService();
  const transactionRunner = makeTransactionRunner();
  return {
    writeService,
    queryService,
    returnUsecase: new ReturnMaintenanceReportUsecase(
      writeService as unknown as MaintenanceReportService,
      queryService as unknown as MaintenanceReportQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    ),
    approveUsecase: new ApproveMaintenanceReportUsecase(
      writeService as unknown as MaintenanceReportService,
      queryService as unknown as MaintenanceReportQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    ),
  };
};

describe('SubmitMaintenanceReportUsecase', () => {
  it('未使用 AI 的总结可直接提交并进入待审核', async () => {
    const { usecase, writeService, reader } = makeSubmitUsecase({});
    const readSpy = jest.spyOn(reader, 'read');

    const result = await usecase.execute({ session: engineerSession, reportId: REPORT_ID });

    expect(result).toMatchObject({ reportId: REPORT_ID, versionNo: 1, status: 'PENDING_REVIEW' });
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeService.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: REPORT_ID,
        versionNo: 1,
        changeKind: 'SUBMIT',
        submittedByAccountId: 900001,
      }),
      transactionContext,
    );
    const payload = writeService.insertVersion.mock.calls[0][0].payloadSnapshot as Record<
      string,
      unknown
    >;
    expect(payload.schemaVersion).toBe(2);
    expect(payload).not.toHaveProperty('attachments');
    expect((payload.ai as Record<string, unknown>).usage).toBe('NOT_USED');
    expect(writeService.markPendingReview).toHaveBeenCalledWith(
      REPORT_ID,
      1,
      expect.any(Date),
      900001,
      transactionContext,
    );
  });

  it('模拟分析结果关联后冻结 v2 评价与版本附件', async () => {
    const reader = new InMemoryAnalysisOutputReader();
    reader.add({
      sourceType: 'AI_ANALYSIS_REPORT',
      sourceId: 'analysis-1',
      sourceVersion: 'v1',
      ownerOrganizationId: ORGANIZATION_ID,
      repairRequestId: REPAIR_REQUEST_ID,
      generationStatus: AnalysisOutputGenerationStatus.GENERATED,
      content: '分析正文',
    });
    const report = makeReport({
      aiUsage: MaintenanceAiUsage.USED,
      aiSourceType: 'AI_ANALYSIS_REPORT',
      aiSourceId: 'analysis-1',
      aiSourceVersion: 'v1',
      aiScore: 4,
      aiCorrectness: 'CORRECT',
      aiHelpfulness: 5,
      aiNote: '分析准确',
    });
    const detail = makeDetail({ report });
    const attachment = makeAttachment();
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(report);
    const { usecase } = makeSubmitUsecase({
      reader,
      writeService,
      queryService: makeSubmitQueryService(detail, [attachment]),
    });

    await usecase.execute({ session: engineerSession, reportId: REPORT_ID });

    const payload = writeService.insertVersion.mock.calls[0][0].payloadSnapshot as {
      ai: Record<string, unknown>;
    };
    expect(payload.ai).toMatchObject({
      usage: 'USED',
      sourceId: 'analysis-1',
      sourceVersion: 'v1',
      score: 4,
      correctness: 'CORRECT',
      helpfulness: 5,
    });
    expect(writeService.insertVersionAttachments).toHaveBeenCalledWith(
      VERSION_ID,
      REPORT_ID,
      [{ attachmentId: ATTACHMENT_ID, sortOrder: 1, descriptionSnapshot: '现场照片' }],
      transactionContext,
    );
  });

  it('行锁后分析结果引用被并发改动：冲突失败且不冻结版本（客户端可重试）', async () => {
    const reader = new InMemoryAnalysisOutputReader();
    const readSpy = jest.spyOn(reader, 'read');
    const preReport = makeReport({ aiUsage: MaintenanceAiUsage.NOT_USED });
    const lockedReport = makeReport({
      aiUsage: MaintenanceAiUsage.USED,
      aiSourceType: 'AI_ANALYSIS_REPORT',
      aiSourceId: 'analysis-1',
      aiSourceVersion: 'v1',
    });
    const detail = makeDetail({ report: lockedReport });
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(lockedReport);
    const { usecase } = makeSubmitUsecase({
      reader,
      writeService,
      queryService: makeSubmitQueryService(detail, [], preReport),
    });

    await expect(
      usecase.execute({ session: engineerSession, reportId: REPORT_ID }),
    ).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REFERENCE_CHANGED,
    });

    expect(readSpy).not.toHaveBeenCalled();
    expect(writeService.insertVersion).not.toHaveBeenCalled();
    expect(writeService.markPendingReview).not.toHaveBeenCalled();
  });

  it('退回后重新提交生成下一个版本', async () => {
    const version = makeVersion();
    const reviewQueryService = {
      readReport: jest.fn().mockResolvedValue(makeReport()),
      readDraftDetail: jest.fn().mockResolvedValue(makeDetail()),
      readCurrentAttachmentsForSubmit: jest.fn().mockResolvedValue([]),
      readVersion: jest.fn().mockResolvedValue(version),
      readVersionAttachments: jest.fn().mockResolvedValue([]),
    };
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(
      makeReport({ status: 'PENDING_REVIEW', currentVersionNo: 1 }),
    );
    const { returnUsecase } = makeReviewUsecase({
      writeService,
      queryService: reviewQueryService,
    });

    await returnUsecase.execute({
      session: adminSession,
      reportId: REPORT_ID,
      comment: '请补充排查步骤',
    });

    expect(writeService.insertReview).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'RETURN', comment: '请补充排查步骤' }),
      transactionContext,
    );
    expect(writeService.markReturned).toHaveBeenCalledWith(
      REPORT_ID,
      expect.any(Date),
      900099,
      transactionContext,
    );

    const resubmitWriteService = makeWriteService();
    resubmitWriteService.lockReportForWrite.mockResolvedValue(
      makeReport({ status: 'RETURNED', currentVersionNo: 1 }),
    );
    resubmitWriteService.insertVersion.mockResolvedValue(makeVersion({ versionNo: 2 }));
    const resubmit = makeSubmitUsecase({ writeService: resubmitWriteService });
    const result = await resubmit.usecase.execute({
      session: engineerSession,
      reportId: REPORT_ID,
    });

    expect(result.versionNo).toBe(2);
    expect(resubmitWriteService.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({ versionNo: 2 }),
      transactionContext,
    );
  });

  it('缺项时在写入版本前失败关闭', async () => {
    const detail = makeDetail({ report: makeReport({ customerFactoryName: null }) });
    const { usecase, writeService } = makeSubmitUsecase({
      queryService: makeSubmitQueryService(detail),
    });

    await expect(
      usecase.execute({ session: engineerSession, reportId: REPORT_ID }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('非工程师角色被拒绝', async () => {
    const { usecase, writeService } = makeSubmitUsecase({});

    await expect(
      usecase.execute({ session: customerSession, reportId: REPORT_ID }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });
});

describe('SubmitMaintenanceReportUsecase 分析结果拒绝路径', () => {
  const usedReport = () =>
    makeReport({
      aiUsage: MaintenanceAiUsage.USED,
      aiSourceType: 'AI_ANALYSIS_REPORT',
      aiSourceId: 'analysis-1',
      aiSourceVersion: 'v1',
    });

  const run = (reader: AnalysisOutputReader, report: Record<string, unknown> = usedReport()) => {
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(report);
    return makeSubmitUsecase({
      reader,
      writeService,
      queryService: makeSubmitQueryService(makeDetail({ report })),
    });
  };

  const expectReject = async (
    reader: AnalysisOutputReader,
    code: string,
    report?: Record<string, unknown>,
  ) => {
    const { usecase, writeService } = run(reader, report);
    await expect(
      usecase.execute({ session: engineerSession, reportId: REPORT_ID }),
    ).rejects.toMatchObject({ code });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  };

  it('输出不存在时拒绝提交', async () => {
    await expectReject(
      new InMemoryAnalysisOutputReader(),
      MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_NOT_FOUND,
    );
  });

  it('输出未成功生成时拒绝提交', async () => {
    const reader = new InMemoryAnalysisOutputReader();
    reader.add({
      sourceType: 'AI_ANALYSIS_REPORT',
      sourceId: 'analysis-1',
      sourceVersion: 'v1',
      ownerOrganizationId: ORGANIZATION_ID,
      repairRequestId: REPAIR_REQUEST_ID,
      generationStatus: AnalysisOutputGenerationStatus.PARTIAL,
      content: '',
    });
    await expectReject(reader, MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_NOT_SUCCESSFUL);
  });

  it('输出属于其他组织时拒绝提交', async () => {
    const reader = new InMemoryAnalysisOutputReader();
    reader.add({
      sourceType: 'AI_ANALYSIS_REPORT',
      sourceId: 'analysis-1',
      sourceVersion: 'v1',
      ownerOrganizationId: 920000,
      repairRequestId: REPAIR_REQUEST_ID,
      generationStatus: AnalysisOutputGenerationStatus.GENERATED,
      content: '分析正文',
    });
    await expectReject(reader, MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_OWNER_MISMATCH);
  });

  it('输出关联工单与报告不一致时拒绝提交', async () => {
    const reader = new InMemoryAnalysisOutputReader();
    reader.add({
      sourceType: 'AI_ANALYSIS_REPORT',
      sourceId: 'analysis-1',
      sourceVersion: 'v1',
      ownerOrganizationId: ORGANIZATION_ID,
      repairRequestId: 955999,
      generationStatus: AnalysisOutputGenerationStatus.GENERATED,
      content: '分析正文',
    });
    await expectReject(reader, MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REQUEST_MISMATCH);
  });

  it('正式环境未接入读取服务时明确不可用，不降级为模拟成功', async () => {
    await expectReject(
      new UnavailableAnalysisOutputReader(),
      MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_UNAVAILABLE,
    );
  });

  it('非作者在读取外部分析结果前按不存在拒绝，避免元数据探测', async () => {
    const reader = new InMemoryAnalysisOutputReader();
    const readSpy = jest.spyOn(reader, 'read');
    const report = { ...usedReport(), maintenanceEngineerAccountId: 999999 };
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(report);
    const { usecase } = makeSubmitUsecase({
      reader,
      writeService,
      queryService: makeSubmitQueryService(makeDetail({ report }), [], report),
    });

    await expect(
      usecase.execute({ session: engineerSession, reportId: REPORT_ID }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    expect(readSpy).not.toHaveBeenCalled();
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('历史案例未关联工单时工单校验按 null 对齐', async () => {
    const reader = new InMemoryAnalysisOutputReader();
    reader.add({
      sourceType: 'AI_ANALYSIS_REPORT',
      sourceId: 'analysis-1',
      sourceVersion: 'v1',
      ownerOrganizationId: ORGANIZATION_ID,
      repairRequestId: null,
      generationStatus: AnalysisOutputGenerationStatus.GENERATED,
      content: '分析正文',
    });
    const report = usedReport();
    const historical = { ...report, sourceType: 'HISTORICAL_CASE', repairRequestId: null };
    const { usecase } = run(reader, historical);
    await expect(
      usecase.execute({ session: engineerSession, reportId: REPORT_ID }),
    ).resolves.toMatchObject({ versionNo: 1 });
  });
});

describe('ReturnMaintenanceReportUsecase / ApproveMaintenanceReportUsecase', () => {
  const makeReviewQueryService = (versionAttachments: unknown[]) => ({
    readReport: jest.fn().mockResolvedValue(makeReport()),
    readVersion: jest.fn().mockResolvedValue(makeVersion()),
    readVersionAttachments: jest.fn().mockResolvedValue(versionAttachments),
  });

  it('退回必须填写原因', async () => {
    const writeService = makeWriteService();
    const { returnUsecase } = makeReviewUsecase({
      writeService,
      queryService: makeReviewQueryService([]) as unknown as ReturnType<
        typeof makeSubmitQueryService
      >,
    });

    await expect(
      returnUsecase.execute({ session: adminSession, reportId: REPORT_ID, comment: '   ' }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    expect(writeService.insertReview).not.toHaveBeenCalled();
  });

  it('审核通过发布所选附件并置为 APPROVED', async () => {
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(
      makeReport({ status: 'PENDING_REVIEW', currentVersionNo: 1 }),
    );
    const { approveUsecase } = makeReviewUsecase({
      writeService,
      queryService: makeReviewQueryService([
        {
          versionId: VERSION_ID,
          attachmentId: ATTACHMENT_ID,
          reportId: REPORT_ID,
          sortOrder: 1,
          descriptionSnapshot: '现场照片',
          publishFlag: false,
        },
      ]) as unknown as ReturnType<typeof makeSubmitQueryService>,
    });

    const result = await approveUsecase.execute({
      session: adminSession,
      reportId: REPORT_ID,
      publishedAttachmentIds: [ATTACHMENT_ID],
    });

    expect(result).toMatchObject({ decision: 'APPROVE', status: 'APPROVED' });
    expect(writeService.publishVersionAttachments).toHaveBeenCalledWith(
      VERSION_ID,
      REPORT_ID,
      [ATTACHMENT_ID],
      transactionContext,
    );
    expect(writeService.markApproved).toHaveBeenCalledWith(
      REPORT_ID,
      expect.any(Date),
      900099,
      transactionContext,
    );
  });

  it('版本存在附件但未选择发布时拒绝通过', async () => {
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(
      makeReport({ status: 'PENDING_REVIEW', currentVersionNo: 1 }),
    );
    const { approveUsecase } = makeReviewUsecase({
      writeService,
      queryService: makeReviewQueryService([
        {
          versionId: VERSION_ID,
          attachmentId: ATTACHMENT_ID,
          reportId: REPORT_ID,
          sortOrder: 1,
          descriptionSnapshot: null,
          publishFlag: false,
        },
      ]) as unknown as ReturnType<typeof makeSubmitQueryService>,
    });

    await expect(
      approveUsecase.execute({ session: adminSession, reportId: REPORT_ID }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    expect(writeService.insertReview).not.toHaveBeenCalled();
  });

  it('纯文字版本（无附件）允许空发布选择', async () => {
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(
      makeReport({ status: 'PENDING_REVIEW', currentVersionNo: 1 }),
    );
    const { approveUsecase } = makeReviewUsecase({
      writeService,
      queryService: makeReviewQueryService([]) as unknown as ReturnType<
        typeof makeSubmitQueryService
      >,
    });

    await expect(
      approveUsecase.execute({ session: adminSession, reportId: REPORT_ID }),
    ).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('跨组织审核按不存在处理', async () => {
    const writeService = makeWriteService();
    writeService.lockReportForWrite.mockResolvedValue(
      makeReport({ status: 'PENDING_REVIEW', currentVersionNo: 1, ownerOrganizationId: 920000 }),
    );
    const { approveUsecase } = makeReviewUsecase({
      writeService,
      queryService: makeReviewQueryService([]) as unknown as ReturnType<
        typeof makeSubmitQueryService
      >,
    });

    await expect(
      approveUsecase.execute({ session: adminSession, reportId: REPORT_ID }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    expect(writeService.insertReview).not.toHaveBeenCalled();
  });
});

describe('维修报告草稿输入归一化', () => {
  const makeDraft = (overrides: Record<string, unknown> = {}) => ({
    title: '曝光机报警维修报告',
    customerFactoryName: '某封测厂',
    maintenanceDate: '2026-10-01',
    alarms: [
      {
        alarmIndex: 1,
        alarmCode: 'ALM-001',
        alarmDescription: '光源功率异常',
        phaseCode: MaintenancePhaseCode.PHASE_01,
        resetResult: MaintenanceAlarmResetResult.RESET_OK,
      },
    ],
    steps: [
      {
        stepCode: 'STEP-001',
        phaseCode: MaintenancePhaseCode.PHASE_02,
        actionText: '更换光源模块并复位',
        resultText: '报警消除',
      },
    ],
    ...overrides,
  });

  it('步骤动作超过 2000 字符被拒绝（避免冻结快照无界膨胀）', () => {
    let error: unknown;
    try {
      normalizeMaintenanceReportDraft(
        makeDraft({
          steps: [
            {
              stepCode: 'STEP-001',
              phaseCode: MaintenancePhaseCode.PHASE_02,
              actionText: '动'.repeat(2001),
            },
          ],
        }),
        900001,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
  });

  it('步骤动作等于上限时通过', () => {
    const result = normalizeMaintenanceReportDraft(
      makeDraft({
        steps: [
          {
            stepCode: 'STEP-001',
            phaseCode: MaintenancePhaseCode.PHASE_02,
            actionText: '动'.repeat(2000),
          },
        ],
      }),
      900001,
    );

    expect(result.steps[0].actionText).toHaveLength(2000);
  });
});

describe('RecordRepairRequestHandlingResultUsecase', () => {
  const REQUEST_ID = 955002;

  const makeService = () => ({
    readRepairRequestWriteContext: jest.fn().mockResolvedValue({
      repairRequestId: REQUEST_ID,
      deprecated: false,
      isAccepted: true,
      acceptedEngineerAccountId: 900001,
      ownerOrganizationId: ORGANIZATION_ID,
      handlingStatus: null,
    }),
    updateRepairRequestHandling: jest.fn().mockResolvedValue(undefined),
  });

  const makeUsecase = (service = makeService()) => {
    const organizationContextService = makeOrganizationContextService();
    const transactionRunner = makeTransactionRunner();
    return {
      service,
      usecase: new RecordRepairRequestHandlingResultUsecase(
        service as unknown as MaintenanceReportService,
        organizationContextService as unknown as TrustedOrganizationContextQueryService,
        transactionRunner,
      ),
    };
  };

  it('进行中结果：状态 IN_PROGRESS 且终结时间为空', async () => {
    const { usecase, service } = makeUsecase();

    const result = await usecase.execute({
      session: engineerSession,
      repairRequestId: REQUEST_ID,
      handlingResult: RepairRequestHandlingResult.INTERRUPTED,
    });

    expect(result).toMatchObject({
      repairRequestId: REQUEST_ID,
      handlingStatus: RepairRequestHandlingStatus.IN_PROGRESS,
      handlingEndedAt: null,
    });
    expect(service.updateRepairRequestHandling).toHaveBeenCalledWith(
      REQUEST_ID,
      expect.objectContaining({
        handlingStatus: RepairRequestHandlingStatus.IN_PROGRESS,
        handlingRecordedByAccountId: 900001,
        handlingEndedAt: null,
      }),
      // WHERE 条件收窄：归属组织与接单人必须与锁定时的事实一致
      { ownerOrganizationId: ORGANIZATION_ID, acceptedEngineerAccountId: 900001 },
      transactionContext,
    );
  });

  it('完成类结果：映射 COMPLETED 并写入服务端终结时间', async () => {
    const { usecase, service } = makeUsecase();

    const result = await usecase.execute({
      session: engineerSession,
      repairRequestId: REQUEST_ID,
      handlingResult: RepairRequestHandlingResult.FIXED,
    });

    expect(result.handlingStatus).toBe(RepairRequestHandlingStatus.COMPLETED);
    expect(result.handlingEndedAt).toBeInstanceOf(Date);
    const writeData = service.updateRepairRequestHandling.mock.calls[0][1];
    expect(writeData.handlingEndedAt).toBeInstanceOf(Date);
  });

  it('已终结（COMPLETED）的工单拒绝再次回写，且不执行更新', async () => {
    const service = makeService();
    service.readRepairRequestWriteContext.mockResolvedValue({
      repairRequestId: REQUEST_ID,
      deprecated: false,
      isAccepted: true,
      acceptedEngineerAccountId: 900001,
      ownerOrganizationId: ORGANIZATION_ID,
      handlingStatus: RepairRequestHandlingStatus.COMPLETED,
    });
    const { usecase } = makeUsecase(service);

    await expect(
      usecase.execute({
        session: engineerSession,
        repairRequestId: REQUEST_ID,
        handlingResult: RepairRequestHandlingResult.INTERRUPTED,
      }),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.HANDLING_STATE_CONFLICT });

    expect(service.updateRepairRequestHandling).not.toHaveBeenCalled();
  });

  it('已终结（UNRESOLVED）的工单同样拒绝改写', async () => {
    const service = makeService();
    service.readRepairRequestWriteContext.mockResolvedValue({
      repairRequestId: REQUEST_ID,
      deprecated: false,
      isAccepted: true,
      acceptedEngineerAccountId: 900001,
      ownerOrganizationId: ORGANIZATION_ID,
      handlingStatus: RepairRequestHandlingStatus.UNRESOLVED,
    });
    const { usecase } = makeUsecase(service);

    await expect(
      usecase.execute({
        session: engineerSession,
        repairRequestId: REQUEST_ID,
        handlingResult: RepairRequestHandlingResult.FIXED,
      }),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.HANDLING_STATE_CONFLICT });

    expect(service.updateRepairRequestHandling).not.toHaveBeenCalled();
  });

  it('跨组织工单按不存在处理，不泄露存在性', async () => {
    const service = makeService();
    service.readRepairRequestWriteContext.mockResolvedValue({
      repairRequestId: REQUEST_ID,
      deprecated: false,
      isAccepted: true,
      acceptedEngineerAccountId: 900001,
      ownerOrganizationId: 920000,
      handlingStatus: null,
    });
    const { usecase } = makeUsecase(service);

    await expect(
      usecase.execute({
        session: engineerSession,
        repairRequestId: REQUEST_ID,
        handlingResult: RepairRequestHandlingResult.FIXED,
      }),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.NOT_FOUND });

    expect(service.updateRepairRequestHandling).not.toHaveBeenCalled();
  });

  it('锁先行：先锁定工单行，再解析组织', async () => {
    const service = makeService();
    const organizationContextService = makeOrganizationContextService();
    const callOrder: string[] = [];
    service.readRepairRequestWriteContext.mockImplementation(() => {
      callOrder.push('lock-work-order');
      return Promise.resolve({
        repairRequestId: REQUEST_ID,
        deprecated: false,
        isAccepted: true,
        acceptedEngineerAccountId: 900001,
        ownerOrganizationId: ORGANIZATION_ID,
        handlingStatus: null,
      });
    });
    organizationContextService.resolveForAccount.mockImplementation(() => {
      callOrder.push('resolve-organization');
      return Promise.resolve({ organizationId: ORGANIZATION_ID });
    });
    const usecase = new RecordRepairRequestHandlingResultUsecase(
      service as unknown as MaintenanceReportService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      makeTransactionRunner(),
    );

    await usecase.execute({
      session: engineerSession,
      repairRequestId: REQUEST_ID,
      handlingResult: RepairRequestHandlingResult.FIXED,
    });

    expect(callOrder).toEqual(['lock-work-order', 'resolve-organization']);
  });

  it('非法处理结果值被拒绝（不做未知值透写）', async () => {
    const { usecase, service } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        repairRequestId: REQUEST_ID,
        handlingResult: 'NOT_A_RESULT',
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });

    expect(service.updateRepairRequestHandling).not.toHaveBeenCalled();
  });

  it('非工程师角色被拒绝', async () => {
    const { usecase, service } = makeUsecase();

    await expect(
      usecase.execute({
        session: customerSession,
        repairRequestId: REQUEST_ID,
        handlingResult: RepairRequestHandlingResult.FIXED,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(service.updateRepairRequestHandling).not.toHaveBeenCalled();
  });
});

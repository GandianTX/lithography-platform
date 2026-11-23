// src/usecases/maintenance-report/submit-maintenance-report-formal.spec.ts
//
// R051-01 正式提交用例单测：直接提交、幂等重试、冲突与机型登记裁决。
// 只验证用例编排与事务边界，不覆盖数据库约束（见集成 spec 与 v13 校验）。

/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { MaintenanceReportSourceType } from '@app-types/models/maintenance-report.types';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { EquipmentModelService } from '@src/modules/lithography/equipment-model.service';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { StoredFileService } from '@src/modules/lithography/stored-file.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { StoredFileStorage } from '@src/usecases/common/ports/stored-file-storage.contract';
import { SubmitMaintenanceReportFormalUsecase } from './submit-maintenance-report-formal.usecase';
import { computeSubmissionPayloadHash } from './maintenance-report-formal-submit.helpers';
import { normalizeMaintenanceReportDraft } from './maintenance-report.input.normalize';
import {
  fingerprintWorkOrderSummarySource,
  readWorkOrderSummarySourceFacts,
} from './maintenance-report-work-order-source.helpers';

/** 与用例完全相同的摘要计算：保证幂等/冲突用例使用真实摘要值 */
function digestOf(
  draftInput: Record<string, unknown>,
  sourceType: MaintenanceReportSourceType,
  repairRequestId: number | null,
  attachmentFileId: string | null = null,
): string {
  const draft = normalizeMaintenanceReportDraft(draftInput, ACCOUNT_ID);
  return computeSubmissionPayloadHash({ sourceType, repairRequestId, draft, attachmentFileId });
}

const transactionContext = { transaction: 'mock' };
const ACCOUNT_ID = 900001;
const ORGANIZATION_ID = 910001;
const REPAIR_REQUEST_ID = 955001;
const REPORT_ID = 960001;
const VERSION_ID = 990001;
const DOCUMENT_ID = 995001;
const REQUEST_ID = 'a1111111-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const engineerSession = {
  accountId: ACCOUNT_ID,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

/** 满足 R051-01 正式完整性的最小输入（未保存表单直接提交） */
const formalDraftInput = (overrides: Record<string, unknown> = {}) => ({
  customerFactoryName: '某封测厂',
  equipmentModelText: 'NSR-2205i11',
  maintenanceDate: '2026-10-01',
  handlingResult: 'FIXED',
  steps: [
    {
      stepCode: 'STEP-A',
      phaseCode: 'PHASE_02',
      actionText: '更换光源模块并复位',
      resultCode: 'RESOLVED',
    },
  ],
  faults: [
    {
      branchKind: 'INITIAL',
      phaseCode: 'PHASE_01',
      mainError: 'E001',
      description: '上片失败',
    },
  ],
  ...overrides,
});

const makeReport = (overrides: Record<string, unknown> = {}) => ({
  id: REPORT_ID,
  ownerOrganizationId: ORGANIZATION_ID,
  sourceType: 'HISTORICAL_CASE',
  repairRequestId: null,
  title: null,
  customerFactoryName: '某封测厂',
  equipmentModelId: null,
  equipmentModelText: null,
  maintenanceDate: '2026-10-01',
  maintenanceEngineerAccountId: ACCOUNT_ID,
  maintenanceEngineerNameSnapshot: '李工',
  phaseFlowVersion: 1,
  status: 'DRAFT',
  currentVersionNo: 0,
  submissionRequestId: null,
  submissionPayloadHash: null,
  lastSubmittedAt: null,
  lastReviewedAt: null,
  aiUsage: 'NOT_USED',
  aiSourceType: null,
  aiSourceId: null,
  aiSourceVersion: null,
  aiScore: null,
  aiCorrectness: null,
  aiHelpfulness: null,
  aiNote: null,
  createdByAccountId: ACCOUNT_ID,
  updatedByAccountId: ACCOUNT_ID,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const makeDetail = (report = makeReport()) => ({
  report,
  alarms: [],
  steps: [
    {
      id: 11,
      reportId: REPORT_ID,
      stepNo: 1,
      stepCode: 'STEP-A',
      phaseCode: 'PHASE_02',
      partName: null,
      actionText: '更换光源模块并复位',
      resultCode: 'RESOLVED',
      errorCode: null,
      resultText: '报警消除',
      newAlarmCode: null,
      isValidNewBranch: true,
    },
  ],
  faults: [
    {
      id: 'f1',
      reportId: REPORT_ID,
      branchKind: 'INITIAL',
      stepCode: null,
      phaseCode: 'PHASE_01',
      mainError: 'E001',
      unitError: null,
      source: null,
      errorType: null,
      gpibStatus: null,
      faultStatus: null,
      description: '上片失败',
      action: null,
      createdByAccountId: ACCOUNT_ID,
    },
  ],
  attachments: [],
  latestReturnComment: null,
});

const makeTransactionRunner = () =>
  ({
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
  }) as unknown as TransactionRunner & { run: jest.Mock };

/** 2026-11-20 需求调整：工单总结派生读侧默认事实（只读核对，内容来自工单） */
const closedWorkOrderContext = {
  id: REPAIR_REQUEST_ID,
  requestNo: 'RR-2026-1001',
  customerAccountId: 880001,
  equipmentModelId: 300001,
  acceptedEngineerAccountId: ACCOUNT_ID,
  isAccepted: true,
  deprecated: false,
  ownerOrganizationId: ORGANIZATION_ID,
  closureStatus: 'CLOSED',
  closedAt: new Date('2026-10-02T00:00:00.000Z'),
  handlingResult: 'FIXED',
  handlingStatus: 'COMPLETED',
  closureReason: null,
  customerOrganizationId: 930001,
  currentRevisionNo: 1,
};

const makeMaintenanceQueryService = () => ({
  findRecord: jest.fn().mockResolvedValue({
    maintenanceDate: '2026-10-02',
    resetResult: 'NORMAL',
    supplementaryNote: '已现场培训',
    attachment: null,
  }),
  findIntakeSource: jest.fn().mockResolvedValue(null),
  listSteps: jest.fn().mockResolvedValue([
    {
      id: 'step-1',
      stepNo: 1,
      errorCode: null,
      partName: '激光器',
      actionText: '重新插拔线缆',
      resultCode: 'RESOLVED',
    },
  ]),
  listFaultPanels: jest.fn().mockResolvedValue([
    {
      id: 'panel-1',
      panelType: 'INITIAL',
      stepId: null,
      phaseCode: 'PHASE_02',
      mainError: 'E-01',
      unitError: null,
      source: 'ALARM_HISTORY',
      errorType: null,
      gpibStatus: null,
      faultStatus: 'PERSISTENT',
      description: '上电报警',
      action: '检查供电',
    },
  ]),
});

const makeOrganizationQueryService = () => ({
  findOrganizationNameById: jest.fn().mockResolvedValue('客户公司A'),
});

/**
 * 用与 makeMaintenanceQueryService（及其变体）同口径的读侧重放来源事实，
 * 得到提交应携带的 sourceConfirmation（预览与校验同一份服务端事实）。
 */
const confirmationOf = async (
  maintenanceOverrides: Partial<ReturnType<typeof makeMaintenanceQueryService>> = {},
) => {
  const facts = await readWorkOrderSummarySourceFacts({
    request: closedWorkOrderContext,
    maintenanceQueryService: {
      ...makeMaintenanceQueryService(),
      ...maintenanceOverrides,
    } as never,
    organizationQueryService: makeOrganizationQueryService() as never,
  });
  return fingerprintWorkOrderSummarySource(facts);
};

/** 与派生事实一致的库内草稿（工单总结提交比对通过的前提） */
const makeSummaryDetail = () => {
  const detail = makeDetail(
    makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      equipmentModelId: 300001,
      customerFactoryName: '客户公司A',
      maintenanceDate: '2026-10-02',
      handlingResult: 'FIXED',
      closureReason: null,
      resetResult: 'NORMAL',
      actualCause: null,
      repairActions: null,
      verificationResult: null,
      supplementaryNote: '已现场培训',
    }),
  );
  (detail as Record<string, unknown>).steps = [
    {
      id: 21,
      reportId: REPORT_ID,
      stepNo: 1,
      stepCode: 'STEP-1',
      phaseCode: 'PHASE_02',
      partName: '激光器',
      actionText: '重新插拔线缆',
      resultCode: 'RESOLVED',
      errorCode: null,
      resultText: null,
      newAlarmCode: null,
      isValidNewBranch: false,
    },
  ];
  (detail as Record<string, unknown>).faults = [
    {
      id: 'sf1',
      reportId: REPORT_ID,
      branchKind: 'INITIAL',
      stepCode: null,
      phaseCode: 'PHASE_02',
      mainError: 'E-01',
      unitError: null,
      source: 'ALARM_HISTORY',
      errorType: null,
      gpibStatus: null,
      faultStatus: 'PERSISTENT',
      description: '上电报警',
      action: '检查供电',
      createdByAccountId: ACCOUNT_ID,
    },
  ];
  return detail;
};

/** 附件挂接后复核的存储契约默认实现：完整性一致 */
const makeStoredFileStorage = () =>
  ({
    save: jest.fn(),
    open: jest.fn(),
    delete: jest.fn(),
    verifyIntegrity: jest.fn().mockResolvedValue(true),
  }) as unknown as StoredFileStorage & { verifyIntegrity: jest.Mock; open: jest.Mock };

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

const makeWriteService = () => ({
  lockReportForWrite: jest.fn().mockResolvedValue(makeReport()),
  insertReport: jest.fn().mockResolvedValue(makeReport()),
  updateDraft: jest.fn().mockResolvedValue(undefined),
  replaceAlarms: jest.fn().mockResolvedValue(undefined),
  replaceSteps: jest.fn().mockResolvedValue(undefined),
  replaceFaults: jest.fn().mockResolvedValue(undefined),
  insertAttachment: jest.fn().mockResolvedValue({ id: 700002 }),
  insertVersion: jest.fn().mockResolvedValue({
    id: VERSION_ID,
    reportId: REPORT_ID,
    versionNo: 1,
    changeKind: 'SUBMIT',
  }),
  insertVersionAttachments: jest.fn().mockResolvedValue(undefined),
  markSubmitted: jest.fn().mockResolvedValue(undefined),
  readRepairRequestWriteContext: jest.fn().mockResolvedValue(null),
});

const makeQueryService = (detail = makeDetail()) => ({
  readDraftDetail: jest.fn().mockResolvedValue(detail),
  readCurrentAttachmentsForSubmit: jest.fn().mockResolvedValue([]),
  findBySubmissionKey: jest.fn().mockResolvedValue(null),
  findVersionIdByReportAndVersionNo: jest.fn().mockResolvedValue(VERSION_ID),
  hasWorkOrderSummary: jest.fn().mockResolvedValue(false),
  /** 冻结重试核对读取冻结版本 payload；默认无版本（重试用例按需覆盖） */
  readVersion: jest.fn().mockResolvedValue(null),
});

const makeEquipmentModelQueryService = () => ({
  findModelById: jest
    .fn()
    .mockResolvedValue({ id: 300001, modelCode: 'ASML-XT', modelName: 'ASML XT' }),
});

const makeEquipmentModelService = () => ({
  findModelsByName: jest.fn().mockResolvedValue([]),
  insertModelOrReuseSameName: jest.fn().mockResolvedValue({
    id: 300002,
    modelCode: 'MR0123',
    modelName: 'NSR-2205i11',
    enabled: true,
  }),
});

const makeReferenceDocumentService = () => ({
  insertDocument: jest.fn().mockResolvedValue({ id: DOCUMENT_ID }),
  findDocumentIdBySourceReportVersion: jest.fn().mockResolvedValue(DOCUMENT_ID),
});

const makeAccountQueryService = () => ({
  findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[ACCOUNT_ID, '李工']])),
});

const FILE_ID = '0f1e2d3c-4b5a-4978-8192-a3b4c5d6e7f8';
const UPLOAD_CONTEXT_ID = '1a2b3c4d-5e6f-4708-9192-b3c4d5e6f7a8';

const makeStoredFileService = (
  staged: Record<string, unknown> | null = {
    fileId: FILE_ID,
    uploadedByAccountId: ACCOUNT_ID,
    ownerOrganizationId: ORGANIZATION_ID,
    storageReference: 'mr/a.txt',
    originalFilename: 'a.txt',
    mimeType: 'text/plain',
    byteSize: 7,
    checksumSha256: 'a'.repeat(64),
    status: 'VALID',
    businessType: 'MAINTENANCE_REPORT',
    businessId: null,
    uploadContextId: UPLOAD_CONTEXT_ID,
    bindingStatus: 'TEMPORARY',
    createdAt: new Date(),
    verifiedAt: new Date(),
  },
) => ({
  lockForBinding: jest.fn().mockResolvedValue(staged),
  bindIfTemporary: jest.fn().mockResolvedValue(1),
});

const makeUsecase = (
  overrides: {
    writeService?: ReturnType<typeof makeWriteService>;
    queryService?: ReturnType<typeof makeQueryService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    equipmentModelQueryService?: ReturnType<typeof makeEquipmentModelQueryService>;
    equipmentModelService?: ReturnType<typeof makeEquipmentModelService>;
    referenceDocumentService?: ReturnType<typeof makeReferenceDocumentService>;
    accountQueryService?: ReturnType<typeof makeAccountQueryService>;
    storedFileService?: ReturnType<typeof makeStoredFileService>;
    transactionRunner?: TransactionRunner;
    storedFileStorage?: ReturnType<typeof makeStoredFileStorage>;
    /** 工单维修事实读侧（来源变化反例需要改步骤/面板/原件） */
    maintenanceQueryService?: ReturnType<typeof makeMaintenanceQueryService>;
    organizationQueryService?: ReturnType<typeof makeOrganizationQueryService>;
    /** 任务 05 会话读侧（AI 评价引用校验） */
    aiConversationQueryService?: {
      listVisible: jest.Mock;
      findVisibleDetail: jest.Mock;
    };
  } = {},
) => {
  const writeService = overrides.writeService ?? makeWriteService();
  const queryService = overrides.queryService ?? makeQueryService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const equipmentModelQueryService =
    overrides.equipmentModelQueryService ?? makeEquipmentModelQueryService();
  const equipmentModelService = overrides.equipmentModelService ?? makeEquipmentModelService();
  const referenceDocumentService =
    overrides.referenceDocumentService ?? makeReferenceDocumentService();
  const accountQueryService = overrides.accountQueryService ?? makeAccountQueryService();
  const storedFileService = overrides.storedFileService ?? makeStoredFileService();
  const transactionRunner = overrides.transactionRunner ?? makeTransactionRunner();
  const storedFileStorage = overrides.storedFileStorage ?? makeStoredFileStorage();
  const maintenanceQueryService =
    overrides.maintenanceQueryService ?? makeMaintenanceQueryService();
  const organizationQueryService =
    overrides.organizationQueryService ?? makeOrganizationQueryService();
  const usecase = new SubmitMaintenanceReportFormalUsecase(
    writeService as unknown as MaintenanceReportService,
    queryService as unknown as MaintenanceReportQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    equipmentModelQueryService as unknown as EquipmentModelQueryService,
    equipmentModelService as unknown as EquipmentModelService,
    referenceDocumentService as unknown as ReferenceDocumentService,
    accountQueryService as unknown as AccountQueryService,
    storedFileService as unknown as StoredFileService,
    maintenanceQueryService as never,
    organizationQueryService as never,
    (overrides.aiConversationQueryService ?? {
      // 默认：服务端确认没有可用会话（未评价提交可以放行）
      listVisible: jest.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
      findVisibleDetail: jest.fn().mockResolvedValue(null),
    }) as never,
    transactionRunner,
    storedFileStorage,
  );
  return {
    usecase,
    writeService,
    queryService,
    organizationContextService,
    equipmentModelQueryService,
    equipmentModelService,
    referenceDocumentService,
    storedFileService,
    storedFileStorage,
    maintenanceQueryService,
  };
};

describe('SubmitMaintenanceReportFormalUsecase 直接提交', () => {
  it('独立报告手填机型：登记新机型并回填机型 ID，同事务冻结并生成正式资料', async () => {
    // 冻结读取回读更新后的报告事实（mock 中直接注入登记后的机型）
    const frozenDetail = makeDetail(makeReport({ equipmentModelId: 300002 }));
    const { usecase, writeService, queryService, equipmentModelService, referenceDocumentService } =
      makeUsecase({
        queryService: { ...makeQueryService(frozenDetail) },
      });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      submissionRequestId: REQUEST_ID,
      draft: formalDraftInput(),
    });

    expect(result).toMatchObject({
      reportId: REPORT_ID,
      versionId: VERSION_ID,
      versionNo: 1,
      status: 'SUBMITTED',
      submissionRequestId: REQUEST_ID,
      referenceDocumentId: DOCUMENT_ID,
    });
    // 报告根创建即携带提交标识与摘要：唯一键兜底并发重试
    expect(writeService.insertReport).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'HISTORICAL_CASE',
        repairRequestId: null,
        submissionRequestId: REQUEST_ID,
        submissionPayloadHash: expect.any(String),
        ownerOrganizationId: ORGANIZATION_ID,
      }),
      transactionContext,
    );
    // 机型登记：文本转为机型 ID，正式结果不再以手填文本作为机型字段
    expect(equipmentModelService.insertModelOrReuseSameName).toHaveBeenCalledWith(
      { modelName: 'NSR-2205i11', modelCode: expect.stringMatching(/^MR[0-9a-f]{40}$/) },
      transactionContext,
    );
    expect(writeService.updateDraft).toHaveBeenCalledWith(
      REPORT_ID,
      expect.objectContaining({ equipmentModelId: 300002, equipmentModelText: null }),
      transactionContext,
    );
    expect(writeService.markSubmitted).toHaveBeenCalledWith(
      REPORT_ID,
      1,
      expect.any(Date),
      ACCOUNT_ID,
      REQUEST_ID,
      expect.any(String),
      transactionContext,
    );
    // 正式资料与报告来源方案二回链
    expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'MAINTENANCE_REPORT',
        ingestMethod: 'DIRECT_SUBMISSION',
        sourceKind: 'INDEPENDENT_REPORT',
        sourceReportId: REPORT_ID,
        sourceReportVersionId: VERSION_ID,
        equipmentModelId: 300002,
      }),
      transactionContext,
    );
    expect(queryService.readCurrentAttachmentsForSubmit).toHaveBeenCalled();
  });

  // 2026-11-21 修复：正式资料正文「机型」行此前取 equipmentModelText（提交后恒 null）
  // 导致机型为空。修复后以机型库按 equipmentModelId 解析名称；两条来源（历史记录/
  // 工单总结）提交后 equipmentModelText 均为 null，必须从 ID 反查。
  describe('正式资料正文机型行（2026-11-21 修复）', () => {
    it('历史维修记录：正文机型行显示机型库解析名称，不为空', async () => {
      const frozenDetail = makeDetail(
        makeReport({ equipmentModelId: 300002, equipmentModelText: null }),
      );
      const equipmentModelQueryService = makeEquipmentModelQueryService();
      equipmentModelQueryService.findModelById.mockResolvedValue({
        id: 300002,
        modelCode: 'MR0123',
        modelName: 'NSR-2205i11',
        enabled: true,
      });
      const { usecase, writeService, referenceDocumentService } = makeUsecase({
        queryService: makeQueryService(frozenDetail),
        equipmentModelQueryService,
      });

      await usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput(),
      });

      expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          contentText: expect.stringContaining('机型：NSR-2205i11'),
        }),
        transactionContext,
      );
      // 机型解析发生在同一事务内（与冻结/资料落库一致）
      expect(equipmentModelQueryService.findModelById).toHaveBeenCalledWith({
        id: 300002,
        transactionContext,
      });
      // 机型冻结语义：提交当时解析的显示名随快照冻结，导出旧版本不再依赖机型库
      expect(writeService.insertVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          payloadSnapshot: expect.objectContaining({ equipmentModelName: 'NSR-2205i11' }),
        }),
        transactionContext,
      );
    });

    it('工单总结：正文机型行显示来源工单机型库名称，不为空', async () => {
      const frozenDetail = makeDetail(
        makeReport({
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: REPAIR_REQUEST_ID,
          equipmentModelId: 300001,
          equipmentModelText: null,
        }),
      );
      const { usecase, writeService, referenceDocumentService } = makeUsecase({
        queryService: makeQueryService(frozenDetail),
      });
      writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

      await usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        submissionRequestId: REQUEST_ID,
        sourceConfirmation: await confirmationOf(),
        draft: {},
      });

      expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          contentText: expect.stringContaining('机型：ASML XT'),
        }),
        transactionContext,
      );
    });

    it('机型库记录缺失时回落为空机型行：不阻断提交（兼容历史数据）', async () => {
      const frozenDetail = makeDetail(
        makeReport({ equipmentModelId: 300002, equipmentModelText: null }),
      );
      const equipmentModelQueryService = makeEquipmentModelQueryService();
      equipmentModelQueryService.findModelById.mockResolvedValue(null);
      const { usecase, referenceDocumentService } = makeUsecase({
        queryService: makeQueryService(frozenDetail),
        equipmentModelQueryService,
      });

      const result = await usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput(),
      });

      expect(result.status).toBe('SUBMITTED');
      expect(referenceDocumentService.insertDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          contentText: expect.stringMatching(/机型：\n/),
        }),
        transactionContext,
      );
    });
  });

  it('工单总结直接提交：校验接单/结单事实且不登记机型（内容来自服务端派生）', async () => {
    const { usecase, writeService, equipmentModelService } = makeUsecase();
    const writeServiceWithOrder = writeService;
    writeServiceWithOrder.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      submissionRequestId: REQUEST_ID,
      sourceConfirmation: await confirmationOf(),
      draft: {},
    });

    expect(result.status).toBe('SUBMITTED');
    expect(equipmentModelService.findModelsByName).not.toHaveBeenCalled();
    expect(equipmentModelService.insertModelOrReuseSameName).not.toHaveBeenCalled();
    expect(writeService.insertReport).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        equipmentModelId: 300001,
      }),
      transactionContext,
    );
  });

  it('幂等重试：同标识同内容返回原结果，不再创建报告或版本', async () => {
    const digest = digestOf(formalDraftInput(), MaintenanceReportSourceType.HISTORICAL_CASE, null);
    const submittedReport = makeReport({
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: REQUEST_ID,
      submissionPayloadHash: digest,
    });
    const { usecase, writeService, queryService } = makeUsecase({
      queryService: {
        ...makeQueryService(),
        findBySubmissionKey: jest.fn().mockResolvedValue(submittedReport),
        findVersionIdByReportAndVersionNo: jest.fn().mockResolvedValue(VERSION_ID),
      },
    });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      submissionRequestId: REQUEST_ID,
      // 重试输入必须与首次完全一致才能命中同一摘要
      draft: formalDraftInput(),
    });

    expect(result).toMatchObject({
      reportId: REPORT_ID,
      versionId: VERSION_ID,
      versionNo: 1,
      status: 'SUBMITTED',
      referenceDocumentId: DOCUMENT_ID,
    });
    expect(writeService.insertReport).not.toHaveBeenCalled();
    expect(queryService.readDraftDetail).not.toHaveBeenCalled();
  });

  it('同标识不同内容：拒绝且不落库', async () => {
    const submittedReport = makeReport({
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: REQUEST_ID,
      submissionPayloadHash: '0'.repeat(64),
    });
    const { usecase, writeService } = makeUsecase({
      queryService: {
        ...makeQueryService(),
        findBySubmissionKey: jest.fn().mockResolvedValue(submittedReport),
      },
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput({ customerFactoryName: '另一家工厂' }),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT });
    expect(writeService.insertReport).not.toHaveBeenCalled();
  });

  it('工单已被总结：拒绝再次创建', async () => {
    const { usecase, writeService } = makeUsecase({
      queryService: {
        ...makeQueryService(),
        hasWorkOrderSummary: jest.fn().mockResolvedValue(true),
      },
    });
    const write = writeService;
    write.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        submissionRequestId: REQUEST_ID,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED });
  });
});

describe('SubmitMaintenanceReportFormalUsecase 已有草稿提交', () => {
  it('首次提交校验展示版本，冻结后标记 SUBMITTED（工单总结按派生内容比对）', async () => {
    const report = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
    });
    const writeService = {
      ...makeWriteService(),
      lockReportForWrite: jest.fn().mockResolvedValue(report),
      readRepairRequestWriteContext: jest.fn().mockResolvedValue(closedWorkOrderContext),
    };
    const { usecase } = makeUsecase({
      writeService,
      queryService: makeQueryService(makeSummaryDetail()),
    });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      reportId: REPORT_ID,
      expectedVersionNo: 0,
      submissionRequestId: REQUEST_ID,
      sourceConfirmation: await confirmationOf(),
      draft: {},
    });

    expect(result).toMatchObject({ reportId: REPORT_ID, versionNo: 1, status: 'SUBMITTED' });
    expect(writeService.markSubmitted).toHaveBeenCalledWith(
      REPORT_ID,
      1,
      expect.any(Date),
      ACCOUNT_ID,
      REQUEST_ID,
      expect.any(String),
      transactionContext,
    );
    expect(writeService.insertReport).not.toHaveBeenCalled();
  });

  /** 工单总结已有草稿：以指定来源工单事实提交（来源变化反例的真实入口） */
  const submitExistingSummary = (params: {
    maintenanceQueryService: ReturnType<typeof makeMaintenanceQueryService>;
  }) => {
    const report = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
    });
    const writeService = {
      ...makeWriteService(),
      lockReportForWrite: jest.fn().mockResolvedValue(report),
      readRepairRequestWriteContext: jest.fn().mockResolvedValue(closedWorkOrderContext),
    };
    const built = makeUsecase({
      writeService,
      queryService: makeQueryService(makeSummaryDetail()),
      maintenanceQueryService: params.maintenanceQueryService,
    });
    return { ...built, writeService };
  };

  it('草稿保存后只改排查步骤：拒绝提交且不落库（来源工单已修订）', async () => {
    const { usecase, writeService, storedFileService } = submitExistingSummary({
      maintenanceQueryService: {
        ...makeMaintenanceQueryService(),
        listSteps: jest.fn().mockResolvedValue([
          {
            id: 'step-1',
            stepNo: 1,
            errorCode: null,
            partName: '激光器',
            actionText: '改：重新压接线缆并测量阻抗',
            resultCode: 'RESOLVED',
          },
        ]),
      },
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    expect(writeService.updateDraft).not.toHaveBeenCalled();
    expect(writeService.insertVersion).not.toHaveBeenCalled();
    // 来源变化时不得借提交顺带改绑/复制来源原件
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  it('草稿保存后只改故障面板：拒绝提交且不落库', async () => {
    const { usecase, writeService, storedFileService } = submitExistingSummary({
      maintenanceQueryService: {
        ...makeMaintenanceQueryService(),
        listFaultPanels: jest.fn().mockResolvedValue([
          {
            id: 'panel-1',
            panelType: 'INITIAL',
            stepId: null,
            phaseCode: 'PHASE_02',
            mainError: 'E-01',
            unitError: null,
            source: 'ALARM_HISTORY',
            errorType: null,
            gpibStatus: null,
            faultStatus: 'PERSISTENT',
            description: '改：上电报警（补充描述）',
            action: '检查供电',
          },
        ]),
      },
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    expect(writeService.updateDraft).not.toHaveBeenCalled();
    expect(storedFileService.lockForBinding).not.toHaveBeenCalled();
    expect(storedFileService.bindIfTemporary).not.toHaveBeenCalled();
  });

  // 已知缺口（待负责人裁决）：只更换来源工单原件时内容比对不触发冲突，
  // 提交会把「工程师核对之后才出现的」新原件引用写进冻结快照。
  // 2026-11-21 需求：预览（sourcePreview/sourceConfirmation 同源读取）之后来源原件
  // 被更换/新增/移除，提交侧指纹复核必须拒绝，不创建半份报告；用户刷新重新核对后
  // 携带同源新指纹才能提交（成功路径见下方「重新核对后」用例）。
  it('预览后来源工单原件被更换（A→B）：携带旧指纹提交被拒绝且不落库', async () => {
    const newAttachment = {
      fileId: '22222222-2222-4222-8222-222222222222',
      originalFilename: '维修记录-新.pdf',
      byteSize: 2048,
    };
    const { usecase, writeService } = submitExistingSummary({
      maintenanceQueryService: {
        ...makeMaintenanceQueryService(),
        findRecord: jest.fn().mockResolvedValue({
          maintenanceDate: '2026-10-02',
          resetResult: 'NORMAL',
          supplementaryNote: '已现场培训',
          attachment: newAttachment,
        }),
      },
    });
    // 工程师核对时看到的还是旧原件（旧事实指纹）
    const staleConfirmation = await confirmationOf();

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        sourceConfirmation: staleConfirmation,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
    expect(writeService.markSubmitted).not.toHaveBeenCalled();
  });

  it('预览后来源工单原件从无到有：携带旧指纹提交被拒绝', async () => {
    const newAttachment = {
      fileId: '22222222-2222-4222-8222-222222222222',
      originalFilename: '维修记录-新增.pdf',
      byteSize: 2048,
    };
    const { usecase, writeService } = submitExistingSummary({
      maintenanceQueryService: {
        ...makeMaintenanceQueryService(),
        findRecord: jest.fn().mockResolvedValue({
          maintenanceDate: '2026-10-02',
          resetResult: 'NORMAL',
          supplementaryNote: '已现场培训',
          attachment: newAttachment,
        }),
      },
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        sourceConfirmation: await confirmationOf(),
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('预览后来源工单原件被移除（有→无）：携带旧指纹提交被拒绝', async () => {
    // 工程师核对时看到的是原件 B；提交时工单侧原件已被移除（默认读侧 attachment: null）
    const previewedAttachment = {
      fileId: '33333333-3333-4333-8333-333333333333',
      originalFilename: '维修记录-旧.pdf',
      byteSize: 1024,
    };
    const { usecase, writeService } = submitExistingSummary({
      maintenanceQueryService: makeMaintenanceQueryService(),
    });
    const staleConfirmation = await confirmationOf({
      findRecord: jest.fn().mockResolvedValue({
        maintenanceDate: '2026-10-02',
        resetResult: 'NORMAL',
        supplementaryNote: '已现场培训',
        attachment: previewedAttachment,
      }),
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        sourceConfirmation: staleConfirmation,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('重新核对并重新保存后：携带同源新指纹提交成功并冻结更新后的内容', async () => {
    const changedActionText = '改：重新压接线缆并测量阻抗';
    const report = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
    });
    const writeService = {
      ...makeWriteService(),
      lockReportForWrite: jest.fn().mockResolvedValue(report),
      readRepairRequestWriteContext: jest.fn().mockResolvedValue(closedWorkOrderContext),
    };
    // 重新保存后库内草稿已是新内容（服务端在保存时按当前工单事实重新派生）
    const reSavedDetail = makeSummaryDetail();
    (reSavedDetail.steps[0] as Record<string, unknown>).actionText = changedActionText;
    const refreshedSteps = {
      ...makeMaintenanceQueryService(),
      listSteps: jest.fn().mockResolvedValue([
        {
          id: 'step-1',
          stepNo: 1,
          errorCode: null,
          partName: '激光器',
          actionText: changedActionText,
          resultCode: 'RESOLVED',
        },
      ]),
    };
    const built = makeUsecase({
      writeService,
      queryService: makeQueryService(reSavedDetail),
      maintenanceQueryService: refreshedSteps,
    });

    const result = await built.usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      reportId: REPORT_ID,
      submissionRequestId: REQUEST_ID,
      sourceConfirmation: await confirmationOf(refreshedSteps),
      draft: {},
    });

    expect(result.status).toBe('SUBMITTED');
    expect(writeService.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadSnapshot: expect.objectContaining({
          steps: [expect.objectContaining({ actionText: changedActionText })],
        }),
      }),
      transactionContext,
    );
  });

  it('管理员修订但维修内容不变：按内容判定通过，修订号仅作为 provenance 冻结', async () => {
    const { usecase, writeService } = submitExistingSummary({
      maintenanceQueryService: makeMaintenanceQueryService(),
    });
    writeService.readRepairRequestWriteContext.mockResolvedValue({
      ...closedWorkOrderContext,
      currentRevisionNo: 7,
    });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      reportId: REPORT_ID,
      submissionRequestId: REQUEST_ID,
      sourceConfirmation: await confirmationOf(),
      draft: {},
    });

    expect(result.status).toBe('SUBMITTED');
    expect(writeService.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadSnapshot: expect.objectContaining({ sourceWorkOrderRevisionNo: 7 }),
      }),
      transactionContext,
    );
  });

  it('R062-01：提交携带新原件时同事务更换（退役旧关联→解绑→绑定→冻结）', async () => {
    const oldAttachmentRow = {
      id: 700001,
      byteSize: 7,
      sortOrder: 1,
      description: null,
      fileId: 'old0000-aaaa-4bbb-8ccc-dddddddddddd',
      uploadedByAccountId: ACCOUNT_ID,
      status: 'CURRENT',
      storageBackend: 'LOCAL',
      checksumSha256: 'a'.repeat(64),
      storageReference: 'old.txt',
    };
    const newAttachmentRow = { ...oldAttachmentRow, id: 700002, fileId: FILE_ID };
    const writeService = {
      ...makeWriteService(),
      retireAttachment: jest.fn().mockResolvedValue(true),
    };
    const queryService = makeQueryService();
    queryService.readCurrentAttachmentsForSubmit
      // 上限裁决读：看到旧附件行
      .mockResolvedValueOnce([oldAttachmentRow])
      // 绑定排序读：旧行已退役
      .mockResolvedValueOnce([])
      // 冻结读：返回新附件行
      .mockResolvedValue([newAttachmentRow]);
    const storedFileService = {
      ...makeStoredFileService(),
      unbindIfBoundTo: jest.fn().mockResolvedValue(1),
    };
    const { usecase } = makeUsecase({ writeService, queryService, storedFileService });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      reportId: REPORT_ID,
      expectedVersionNo: 0,
      submissionRequestId: REQUEST_ID,
      draft: formalDraftInput(),
      attachment: { fileId: FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID },
    });

    expect(result.status).toBe('SUBMITTED');
    expect(writeService.retireAttachment).toHaveBeenCalledWith(
      REPORT_ID,
      700001,
      expect.any(Date),
      transactionContext,
    );
    expect(storedFileService.unbindIfBoundTo).toHaveBeenCalledWith(
      {
        fileId: 'old0000-aaaa-4bbb-8ccc-dddddddddddd',
        businessType: 'MAINTENANCE_REPORT',
        businessId: String(REPORT_ID),
      },
      transactionContext,
    );
    expect(storedFileService.bindIfTemporary).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: FILE_ID }),
      transactionContext,
    );
    // 冻结版本关联的是更换后的新附件
    expect(writeService.insertVersionAttachments).toHaveBeenCalledWith(
      VERSION_ID,
      REPORT_ID,
      [{ attachmentId: 700002, sortOrder: 1, descriptionSnapshot: null }],
      transactionContext,
    );
  });

  it('展示版本不符：拒绝并提示刷新', async () => {
    const report = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      currentVersionNo: 3,
    });
    const writeService = {
      ...makeWriteService(),
      lockReportForWrite: jest.fn().mockResolvedValue(report),
      readRepairRequestWriteContext: jest.fn().mockResolvedValue(closedWorkOrderContext),
    };
    const { usecase } = makeUsecase({
      writeService,
      queryService: makeQueryService(makeSummaryDetail()),
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        expectedVersionNo: 0,
        submissionRequestId: REQUEST_ID,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('工单总结：库内草稿与派生内容不一致（工单已修订）时拒绝提交并要求重新保存', async () => {
    const report = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
    });
    const writeService = {
      ...makeWriteService(),
      lockReportForWrite: jest.fn().mockResolvedValue(report),
      readRepairRequestWriteContext: jest.fn().mockResolvedValue({
        ...closedWorkOrderContext,
        handlingResult: 'PART_PURCHASED',
      }),
    };
    const { usecase } = makeUsecase({
      writeService,
      queryService: makeQueryService(makeSummaryDetail()),
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        expectedVersionNo: 0,
        submissionRequestId: REQUEST_ID,
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('工单总结：拒绝客户端重复填写的内容字段', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput({ equipmentModelText: null, equipmentModelId: 300001 }),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
  });

  it('已 SUBMITTED 报告换标识：拒绝再次提交', async () => {
    const report = makeReport({
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: 'other0000-aaaa-4bbb-8ccc-dddddddddddd',
      submissionPayloadHash: 'a'.repeat(64),
    });
    const { usecase, writeService } = makeUsecase({
      writeService: {
        ...makeWriteService(),
        lockReportForWrite: jest.fn().mockResolvedValue(report),
      },
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput(),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_ALREADY_SUBMITTED });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('已有草稿同标识同内容重试：返回原结果，不生成新版本', async () => {
    const digest = digestOf(formalDraftInput(), MaintenanceReportSourceType.HISTORICAL_CASE, null);
    const report = makeReport({
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: REQUEST_ID,
      submissionPayloadHash: digest,
    });
    const { usecase, writeService } = makeUsecase({
      writeService: {
        ...makeWriteService(),
        lockReportForWrite: jest.fn().mockResolvedValue(report),
      },
      referenceDocumentService: {
        insertDocument: jest.fn(),
        findDocumentIdBySourceReportVersion: jest.fn().mockResolvedValue(DOCUMENT_ID),
      },
    });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      reportId: REPORT_ID,
      submissionRequestId: REQUEST_ID,
      draft: formalDraftInput(),
    });

    expect(result).toMatchObject({
      reportId: REPORT_ID,
      versionId: VERSION_ID,
      versionNo: 1,
      status: 'SUBMITTED',
      referenceDocumentId: DOCUMENT_ID,
    });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
    expect(writeService.markSubmitted).not.toHaveBeenCalled();
  });

  it('工单总结已有草稿首提成功后来源被修订，同标识原请求重试：按冻结请求返回原结果', async () => {
    // 第一次提交（已有草稿路径，成功）：捕获冻结快照（含来源确认指纹）
    const draftReport = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
    });
    const firstWrite = {
      ...makeWriteService(),
      lockReportForWrite: jest.fn().mockResolvedValue(draftReport),
      readRepairRequestWriteContext: jest.fn().mockResolvedValue(closedWorkOrderContext),
    };
    const first = makeUsecase({
      writeService: firstWrite,
      queryService: makeQueryService(makeSummaryDetail()),
    });
    await first.usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      reportId: REPORT_ID,
      expectedVersionNo: 0,
      submissionRequestId: REQUEST_ID,
      sourceConfirmation: await confirmationOf(),
      draft: {},
    });
    const frozenPayload = first.writeService.insertVersion.mock.calls[0][0]
      .payloadSnapshot as Record<string, unknown>;
    expect(frozenPayload.sourceWorkOrderConfirmationFingerprint).toBe(await confirmationOf());

    // 来源工单随后被管理员修订（排查步骤动作文本变化）；重试携带原标识与原指纹
    const submittedReport = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: REQUEST_ID,
      // 已有草稿路径的工单总结重试按冻结请求核对，不比对当前派生摘要
      submissionPayloadHash: '0'.repeat(64),
    });
    const retryWrite = {
      ...makeWriteService(),
      lockReportForWrite: jest.fn().mockResolvedValue(submittedReport),
      readRepairRequestWriteContext: jest.fn().mockResolvedValue(closedWorkOrderContext),
    };
    const retry = makeUsecase({
      writeService: retryWrite,
      queryService: {
        ...makeQueryService(),
        readVersion: jest.fn().mockResolvedValue({ payloadSnapshot: frozenPayload }),
      },
      maintenanceQueryService: {
        ...makeMaintenanceQueryService(),
        listSteps: jest.fn().mockResolvedValue([
          {
            id: 'step-1',
            stepNo: 1,
            errorCode: null,
            partName: '激光器',
            actionText: '改：工单已被管理员修订',
            resultCode: 'RESOLVED',
          },
        ]),
      },
    });

    const result = await retry.usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      reportId: REPORT_ID,
      submissionRequestId: REQUEST_ID,
      sourceConfirmation: await confirmationOf(),
      draft: {},
    });

    expect(result).toMatchObject({
      reportId: REPORT_ID,
      versionId: VERSION_ID,
      versionNo: 1,
      status: 'SUBMITTED',
      referenceDocumentId: DOCUMENT_ID,
    });
    // 不读取、不派生修订后的当前工单事实，不重复写报告/版本/资料
    expect(retry.maintenanceQueryService.listSteps).not.toHaveBeenCalled();
    expect(retry.queryService.readDraftDetail).not.toHaveBeenCalled();
    expect(retry.writeService.updateDraft).not.toHaveBeenCalled();
    expect(retry.writeService.insertVersion).not.toHaveBeenCalled();
    expect(retry.referenceDocumentService.insertDocument).not.toHaveBeenCalled();
  });
});

describe('SubmitMaintenanceReportFormalUsecase 机型登记裁决', () => {
  it('同名多启用项：拒绝并提示选择已有机型', async () => {
    const { usecase } = makeUsecase({
      equipmentModelService: {
        findModelsByName: jest.fn().mockResolvedValue([
          { id: 1, modelCode: 'A', modelName: 'NSR-2205i11', enabled: true },
          { id: 2, modelCode: 'B', modelName: 'NSR-2205i11', enabled: true },
        ]),
        insertModelOrReuseSameName: jest.fn(),
      },
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput(),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.EQUIPMENT_MODEL_AMBIGUOUS });
  });

  it('同名仅停用匹配：拒绝且不自动启用', async () => {
    const { usecase } = makeUsecase({
      equipmentModelService: {
        findModelsByName: jest
          .fn()
          .mockResolvedValue([{ id: 3, modelCode: 'C', modelName: 'NSR-2205i11', enabled: false }]),
        insertModelOrReuseSameName: jest.fn(),
      },
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput(),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.EQUIPMENT_MODEL_DISABLED_MATCH });
  });

  it('唯一启用项同名：复用不重复登记', async () => {
    const { usecase, equipmentModelService } = makeUsecase({
      equipmentModelService: {
        findModelsByName: jest
          .fn()
          .mockResolvedValue([
            { id: 300009, modelCode: 'ASML-XT', modelName: 'NSR-2205i11', enabled: true },
          ]),
        insertModelOrReuseSameName: jest.fn(),
      },
    });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      submissionRequestId: REQUEST_ID,
      draft: formalDraftInput(),
    });

    expect(result.status).toBe('SUBMITTED');
    expect(equipmentModelService.insertModelOrReuseSameName).not.toHaveBeenCalled();
  });
});

describe('SubmitMaintenanceReportFormalUsecase 正式完整性', () => {
  it.each([
    ['customerFactoryName', formalDraftInput({ customerFactoryName: null })],
    ['maintenanceDate', formalDraftInput({ maintenanceDate: null })],
    ['equipmentModel', formalDraftInput({ equipmentModelText: null, equipmentModelId: null })],
    ['handlingResult', formalDraftInput({ handlingResult: null })],
    ['steps', formalDraftInput({ steps: [] })],
    ['faults', formalDraftInput({ faults: [] })],
  ])('缺项 %s 拒绝且不进入事务', async (_field, draft) => {
    const { usecase } = makeUsecase();
    const runner = jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext));

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        submissionRequestId: REQUEST_ID,
        draft: draft,
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    expect(runner).not.toHaveBeenCalled();
  });

  it('提交标识形态非法：拒绝', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        submissionRequestId: 'short',
        draft: formalDraftInput(),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_INVALID });
  });
});

describe('SubmitMaintenanceReportFormalUsecase 附件挂接后复核', () => {
  const attachmentRow = (overrides: Record<string, unknown> = {}) => ({
    id: 700001,
    reportId: REPORT_ID,
    originalFilename: '故障照片.png',
    mimeType: 'image/png',
    byteSize: 1024,
    checksumSha256: 'a'.repeat(64),
    storageBackend: 'LOCAL',
    storageReference: 'img001.png',
    sortOrder: 1,
    description: null,
    status: 'CURRENT',
    uploadedByAccountId: ACCOUNT_ID,
    retiredAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  });

  it('附件文件完整性不符：冻结前失败关闭，不写版本与附件关联', async () => {
    const queryService = makeQueryService();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([attachmentRow()]);
    const { usecase, writeService, storedFileStorage } = makeUsecase({ queryService });
    storedFileStorage.verifyIntegrity.mockResolvedValue(false);

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        reportId: REPORT_ID,
        expectedVersionNo: 0,
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput(),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.ATTACHMENT_UNAVAILABLE });
    expect(storedFileStorage.verifyIntegrity).toHaveBeenCalledWith(
      'img001.png',
      'a'.repeat(64),
      1024,
    );
    expect(writeService.insertVersion).not.toHaveBeenCalled();
    expect(writeService.insertVersionAttachments).not.toHaveBeenCalled();
    expect(writeService.markSubmitted).not.toHaveBeenCalled();
  });

  it('附件归属被改变（非作者登记）：冻结前拒绝', async () => {
    const queryService = makeQueryService();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([
      attachmentRow({ uploadedByAccountId: 900002, checksumSha256: null }),
    ]);
    const { usecase, writeService, storedFileStorage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        reportId: REPORT_ID,
        expectedVersionNo: 0,
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput(),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.ATTACHMENT_UNAVAILABLE });
    // 归属校验先于存储访问
    expect(storedFileStorage.open).not.toHaveBeenCalled();
    expect(storedFileStorage.verifyIntegrity).not.toHaveBeenCalled();
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('附件可用（校验和一致）：正常冻结并登记版本附件', async () => {
    const queryService = makeQueryService();
    queryService.readCurrentAttachmentsForSubmit.mockResolvedValue([attachmentRow()]);
    const { usecase, writeService } = makeUsecase({ queryService });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      reportId: REPORT_ID,
      expectedVersionNo: 0,
      submissionRequestId: REQUEST_ID,
      draft: formalDraftInput(),
    });
    expect(result.status).toBe('SUBMITTED');
    expect(writeService.insertVersion).toHaveBeenCalledTimes(1);
    expect(writeService.insertVersionAttachments).toHaveBeenCalledWith(
      VERSION_ID,
      REPORT_ID,
      [{ attachmentId: 700001, sortOrder: 1, descriptionSnapshot: null }],
      transactionContext,
    );
  });
});

describe('SubmitMaintenanceReportFormalUsecase 直接提交附带暂存原件（R051-01/R062-01）', () => {
  it('直接提交带附件：冻结前绑定并登记含 file_id 的附件行，随版本关联', async () => {
    const { usecase, writeService, storedFileService } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      sourceType: 'HISTORICAL_CASE',
      submissionRequestId: REQUEST_ID,
      draft: formalDraftInput(),
      attachment: { fileId: FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID },
    });

    expect(storedFileService.bindIfTemporary).toHaveBeenCalledWith(
      {
        fileId: FILE_ID,
        businessType: 'MAINTENANCE_REPORT',
        businessId: String(REPORT_ID),
      },
      transactionContext,
    );
    expect(writeService.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: REPORT_ID, fileId: FILE_ID }),
      transactionContext,
    );
  });

  it('绑定失败（暂存原件已失效）：异常随事务传播，不冻结任何版本或资料', async () => {
    const { usecase, writeService, storedFileService } = makeUsecase();
    storedFileService.lockForBinding.mockResolvedValue(null);

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'HISTORICAL_CASE',
        submissionRequestId: REQUEST_ID,
        draft: formalDraftInput(),
        attachment: { fileId: FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID },
      }),
    ).rejects.toMatchObject({ code: 'STORED_FILE_NOT_FOUND' });

    expect(writeService.insertVersion).not.toHaveBeenCalled();
    expect(writeService.markSubmitted).not.toHaveBeenCalled();
    expect(writeService.insertReport).toHaveBeenCalledTimes(1);
  });

  it('附件 fileId 计入提交内容摘要：同标识换附件按异内容拒绝', () => {
    const withFile = digestOf(
      formalDraftInput(),
      MaintenanceReportSourceType.HISTORICAL_CASE,
      null,
      FILE_ID,
    );
    const withoutFile = digestOf(
      formalDraftInput(),
      MaintenanceReportSourceType.HISTORICAL_CASE,
      null,
      null,
    );
    expect(withFile).not.toBe(withoutFile);
  });
});

describe('SubmitMaintenanceReportFormalUsecase 工单总结 AI 评价（任务 05 真实会话）', () => {
  const aiDetail = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 700001,
      requestId: REPAIR_REQUEST_ID,
      ownerOrganizationId: ORGANIZATION_ID,
      creatorAccountId: ACCOUNT_ID,
      status: 'COMPLETED',
      contentVersion: 2,
      createdAt: new Date('2026-09-30T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      completedAt: new Date('2026-10-01T00:00:00.000Z'),
      deletedAt: null,
      messages: [
        {
          id: 1,
          conversationId: 700001,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          contentText: '上片失败怎么排查？',
          contentVersion: 1,
          createdAt: new Date('2026-09-30T00:00:00.000Z'),
        },
        {
          id: 2,
          conversationId: 700001,
          messageSeq: 2,
          turnNo: 1,
          role: 'ASSISTANT',
          contentText: '先检查真空与载台。',
          contentVersion: 2,
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
      ...overrides,
    }) as never;

  const aiDraft = {
    aiUsage: 'USED',
    aiSourceType: 'AI_CONVERSATION',
    aiSourceId: '700001',
    aiSourceVersion: '2',
    aiScore: 4,
    aiCorrectness: 'CORRECT',
    aiHelpfulness: 3,
    aiNote: '有帮助',
  };

  const makeSummarySubmit = (findVisibleDetail: jest.Mock) => {
    const report = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
    });
    const writeService = {
      ...makeWriteService(),
      lockReportForWrite: jest.fn().mockResolvedValue(report),
      readRepairRequestWriteContext: jest.fn().mockResolvedValue(closedWorkOrderContext),
    };
    return makeUsecase({
      writeService,
      queryService: makeQueryService(makeSummaryDetail()),
      aiConversationQueryService: { listVisible: jest.fn(), findVisibleDetail },
    });
  };

  it('引用真实会话版本：提交成功并冻结来源、版本与评分', async () => {
    const { usecase, writeService, queryService } = makeSummarySubmit(
      jest.fn().mockResolvedValue(aiDetail()),
    );
    // 模拟同事务写入后重新读取：冻结使用的是落库后的评价组
    const persisted = makeSummaryDetail();
    queryService.readDraftDetail.mockResolvedValue({
      ...persisted,
      report: {
        ...persisted.report,
        aiUsage: 'USED',
        aiSourceType: aiDraft.aiSourceType,
        aiSourceId: aiDraft.aiSourceId,
        aiSourceVersion: aiDraft.aiSourceVersion,
        aiScore: aiDraft.aiScore,
        aiCorrectness: aiDraft.aiCorrectness,
        aiHelpfulness: aiDraft.aiHelpfulness,
        aiNote: aiDraft.aiNote,
      },
    });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      reportId: REPORT_ID,
      submissionRequestId: REQUEST_ID,
      draft: aiDraft,
    });

    expect(result.status).toBe('SUBMITTED');
    expect(writeService.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadSnapshot: expect.objectContaining({
          ai: {
            usage: 'USED',
            sourceType: 'AI_CONVERSATION',
            sourceId: '700001',
            sourceVersion: '2',
            score: 4,
            correctness: 'CORRECT',
            helpfulness: 3,
            note: '有帮助',
          },
        }),
      }),
      transactionContext,
    );
  });

  it('会话在所选版本内没有有效回复：拒绝提交且不落库', async () => {
    const { usecase, writeService } = makeSummarySubmit(
      jest.fn().mockResolvedValue(
        aiDetail({
          contentVersion: 1,
          messages: [
            {
              id: 1,
              conversationId: 700001,
              messageSeq: 1,
              turnNo: 1,
              role: 'USER',
              contentText: '只有提问',
              contentVersion: 1,
              createdAt: new Date('2026-09-30T00:00:00.000Z'),
            },
          ],
        }),
      ),
    );

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        draft: { ...aiDraft, aiSourceVersion: '1' },
      }),
    ).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_NOT_APPLICABLE,
    });
    expect(writeService.updateDraft).not.toHaveBeenCalled();
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('会话不可见（他人的/跨公司）：拒绝提交', async () => {
    const { usecase, writeService } = makeSummarySubmit(jest.fn().mockResolvedValue(null));

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        draft: aiDraft,
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID });
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('只补填 AI 评价、维修内容未变：不触发来源修订冲突', async () => {
    const { usecase, writeService } = makeSummarySubmit(jest.fn().mockResolvedValue(aiDetail()));

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        reportId: REPORT_ID,
        submissionRequestId: REQUEST_ID,
        draft: aiDraft,
      }),
    ).resolves.toMatchObject({ status: 'SUBMITTED' });
    // 来源内容未变，不应被当成「工单已修订」
    expect(writeService.updateDraft).toHaveBeenCalledTimes(1);
  });

  it('客户端不带 AI 字段提交：沿用库内评价，追加消息不改变已评范围', async () => {
    // 会话在评价后继续追加了第 2 轮（新问题 v3、新回答 v4）；已评 v2 范围保持不变
    const appended = aiDetail({
      contentVersion: 4,
      messages: [
        {
          id: 1,
          conversationId: 700001,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          contentText: '上片失败怎么排查？',
          contentVersion: 1,
          createdAt: new Date('2026-09-30T00:00:00.000Z'),
        },
        {
          id: 2,
          conversationId: 700001,
          messageSeq: 2,
          turnNo: 1,
          role: 'ASSISTANT',
          contentText: '先检查真空与载台。',
          contentVersion: 2,
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
          id: 3,
          conversationId: 700001,
          messageSeq: 3,
          turnNo: 2,
          role: 'USER',
          contentText: '后续追加问题',
          contentVersion: 3,
          createdAt: new Date('2026-10-02T00:00:00.000Z'),
        },
        {
          id: 4,
          conversationId: 700001,
          messageSeq: 4,
          turnNo: 2,
          role: 'ASSISTANT',
          contentText: '后续追加回答',
          contentVersion: 4,
          createdAt: new Date('2026-10-02T00:00:01.000Z'),
        },
      ],
    });
    const findVisibleDetail = jest.fn().mockResolvedValue(appended);
    const { usecase, writeService, queryService } = makeSummarySubmit(findVisibleDetail);
    // 库内草稿已保存过评价（前一版保存的会话与版本）
    const persisted = makeSummaryDetail();
    queryService.readDraftDetail.mockResolvedValue({
      ...persisted,
      report: {
        ...persisted.report,
        aiUsage: 'USED',
        aiSourceType: aiDraft.aiSourceType,
        aiSourceId: aiDraft.aiSourceId,
        aiSourceVersion: aiDraft.aiSourceVersion,
        aiScore: aiDraft.aiScore,
        aiCorrectness: aiDraft.aiCorrectness,
        aiHelpfulness: aiDraft.aiHelpfulness,
        aiNote: aiDraft.aiNote,
      },
    });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      reportId: REPORT_ID,
      submissionRequestId: REQUEST_ID,
      draft: {},
    });

    expect(result.status).toBe('SUBMITTED');
    // 保存/冻结沿用库内评价组，不因客户端未携带 AI 字段而清空或改写
    expect(writeService.updateDraft).toHaveBeenCalledWith(
      REPORT_ID,
      expect.objectContaining({
        aiUsage: 'USED',
        aiSourceType: 'AI_CONVERSATION',
        aiSourceId: '700001',
        aiSourceVersion: '2',
        aiScore: 4,
      }),
      transactionContext,
    );
    expect(writeService.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadSnapshot: expect.objectContaining({
          ai: {
            usage: 'USED',
            sourceType: 'AI_CONVERSATION',
            sourceId: '700001',
            sourceVersion: '2',
            score: 4,
            correctness: 'CORRECT',
            helpfulness: 3,
            note: '有帮助',
          },
        }),
      }),
      transactionContext,
    );
    // 校验定位的是已保存的会话与版本，不含之后追加的消息
    expect(findVisibleDetail).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 700001 }),
    );
  });
});

describe('SubmitMaintenanceReportFormalUsecase 工单总结幂等与 AI 评价裁决（2026-11-21 需求）', () => {
  /** 直接提交的公共输入（无预建草稿、无附件） */
  const directSubmitCommand = async (overrides: Record<string, unknown> = {}) => ({
    session: engineerSession,
    sourceType: 'WORK_ORDER_SUMMARY',
    repairRequestId: REPAIR_REQUEST_ID,
    submissionRequestId: REQUEST_ID,
    sourceConfirmation: await confirmationOf(),
    draft: {},
    ...overrides,
  });

  it('首提响应丢失后同标识重试：返回原冻结结果，不被「已存在总结」挡住', async () => {
    // 第一次提交（成功）：捕获写入时的内容摘要与冻结快照（含来源确认指纹）
    const first = makeUsecase();
    first.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);
    const frozen = await first.usecase.execute(await directSubmitCommand());
    expect(frozen.status).toBe('SUBMITTED');
    const digest = first.writeService.insertReport.mock.calls[0][0].submissionPayloadHash as string;
    const frozenPayload = first.writeService.insertVersion.mock.calls[0][0]
      .payloadSnapshot as Record<string, unknown>;
    expect(frozenPayload.sourceWorkOrderConfirmationFingerprint).toBe(await confirmationOf());

    // 第二次提交（首提响应丢失后的重试）：库内已有总结（hasWorkOrderSummary=true），
    // 同标识+原请求按冻结快照核对命中幂等返回，不得被「已存在总结」挡住
    const retryReport = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: REQUEST_ID,
      submissionPayloadHash: digest,
    });
    const retry = makeUsecase({
      queryService: {
        ...makeQueryService(),
        hasWorkOrderSummary: jest.fn().mockResolvedValue(true),
        findBySubmissionKey: jest.fn().mockResolvedValue(retryReport),
        readVersion: jest.fn().mockResolvedValue({ payloadSnapshot: frozenPayload }),
      },
    });
    retry.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    const result = await retry.usecase.execute(await directSubmitCommand());

    expect(result).toMatchObject({
      reportId: REPORT_ID,
      versionId: VERSION_ID,
      versionNo: 1,
      status: 'SUBMITTED',
      referenceDocumentId: DOCUMENT_ID,
    });
    expect(retry.writeService.insertReport).not.toHaveBeenCalled();
    expect(retry.writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('首提成功后来源工单被修订，同标识原请求重试：仍返回原报告/冻结版本/资料 ID', async () => {
    // 第一次提交（成功）：捕获冻结快照
    const first = makeUsecase();
    first.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);
    await first.usecase.execute(await directSubmitCommand());
    const digest = first.writeService.insertReport.mock.calls[0][0].submissionPayloadHash as string;
    const frozenPayload = first.writeService.insertVersion.mock.calls[0][0]
      .payloadSnapshot as Record<string, unknown>;

    // 来源工单随后被管理员修订（排查步骤动作文本变化），指纹必然失配
    const retryReport = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: REQUEST_ID,
      submissionPayloadHash: digest,
    });
    const retry = makeUsecase({
      queryService: {
        ...makeQueryService(),
        findBySubmissionKey: jest.fn().mockResolvedValue(retryReport),
        readVersion: jest.fn().mockResolvedValue({ payloadSnapshot: frozenPayload }),
      },
      maintenanceQueryService: {
        ...makeMaintenanceQueryService(),
        listSteps: jest.fn().mockResolvedValue([
          {
            id: 'step-1',
            stepNo: 1,
            errorCode: null,
            partName: '激光器',
            actionText: '改：工单已被管理员修订',
            resultCode: 'RESOLVED',
          },
        ]),
      },
    });
    retry.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    const result = await retry.usecase.execute(await directSubmitCommand());

    expect(result).toMatchObject({
      reportId: REPORT_ID,
      versionId: VERSION_ID,
      versionNo: 1,
      status: 'SUBMITTED',
      referenceDocumentId: DOCUMENT_ID,
    });
    // 不依赖当前工单重新算出原请求：修订后的工单事实读取（派生）完全未发生
    expect(retry.maintenanceQueryService.listSteps).not.toHaveBeenCalled();
    expect(retry.maintenanceQueryService.listFaultPanels).not.toHaveBeenCalled();
    // 不重复写报告、版本或资料
    expect(retry.writeService.insertReport).not.toHaveBeenCalled();
    expect(retry.writeService.insertVersion).not.toHaveBeenCalled();
    expect(retry.referenceDocumentService.insertDocument).not.toHaveBeenCalled();
  });

  it('同标识重试但修改了 AI 评价：按冻结请求拒绝且不返回原结果', async () => {
    const first = makeUsecase();
    first.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);
    await first.usecase.execute(await directSubmitCommand());
    const frozenPayload = first.writeService.insertVersion.mock.calls[0][0]
      .payloadSnapshot as Record<string, unknown>;

    const retryReport = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: REQUEST_ID,
      submissionPayloadHash: '0'.repeat(64),
      aiUsage: 'NOT_USED',
    });
    const retry = makeUsecase({
      queryService: {
        ...makeQueryService(),
        findBySubmissionKey: jest.fn().mockResolvedValue(retryReport),
        readVersion: jest.fn().mockResolvedValue({ payloadSnapshot: frozenPayload }),
      },
      aiConversationQueryService: {
        listVisible: jest.fn(),
        findVisibleDetail: jest.fn(),
      },
    });
    retry.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    await expect(
      retry.usecase.execute(
        await directSubmitCommand({
          draft: {
            aiUsage: 'USED',
            aiSourceType: 'AI_CONVERSATION',
            aiSourceId: '700001',
            aiSourceVersion: '1',
            aiScore: 4,
            aiCorrectness: 'CORRECT',
            aiHelpfulness: 3,
            aiNote: '重试时补写的评价',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT });
    expect(retry.writeService.insertReport).not.toHaveBeenCalled();
    expect(retry.writeService.insertVersion).not.toHaveBeenCalled();
    expect(retry.referenceDocumentService.insertDocument).not.toHaveBeenCalled();
  });

  it('同标识重试但来源确认标识已变化：按冻结请求拒绝', async () => {
    const first = makeUsecase();
    first.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);
    await first.usecase.execute(await directSubmitCommand());
    const frozenPayload = first.writeService.insertVersion.mock.calls[0][0]
      .payloadSnapshot as Record<string, unknown>;

    const retryReport = makeReport({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      status: 'SUBMITTED',
      currentVersionNo: 1,
      submissionRequestId: REQUEST_ID,
      submissionPayloadHash: '0'.repeat(64),
    });
    const retry = makeUsecase({
      queryService: {
        ...makeQueryService(),
        findBySubmissionKey: jest.fn().mockResolvedValue(retryReport),
        readVersion: jest.fn().mockResolvedValue({ payloadSnapshot: frozenPayload }),
      },
    });
    retry.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    await expect(
      retry.usecase.execute(
        await directSubmitCommand({
          sourceConfirmation: 'f'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_CONFLICT });
    expect(retry.writeService.insertReport).not.toHaveBeenCalled();
  });

  it('他人重试同一提交标识：提交键含操作者，不得返回原结果', async () => {
    const retry = makeUsecase({
      queryService: {
        ...makeQueryService(),
        findBySubmissionKey: jest.fn().mockResolvedValue(null),
      },
    });
    retry.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    await expect(
      retry.usecase.execute({
        session: {
          accountId: 900002,
          roles: ['ENGINEER'],
          activeRole: 'ENGINEER',
        } as unknown as UsecaseSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        submissionRequestId: REQUEST_ID,
        sourceConfirmation: await confirmationOf(),
        draft: {},
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH });
    expect(retry.writeService.insertReport).not.toHaveBeenCalled();
    expect(retry.writeService.insertVersion).not.toHaveBeenCalled();
  });

  it('首次提交尚未成功且来源已变化：同标识旧指纹重试要求刷新重新核对，不留半份报告', async () => {
    // 首提失败（事务回滚）：库内无该提交标识的报告；来源工单随后被修订；
    // 客户端沿用原标识与原指纹重试 → 按当前工单派生核对指纹失配 → 拒绝
    const staleConfirmation = await confirmationOf();
    const retry = makeUsecase({
      queryService: {
        ...makeQueryService(),
        findBySubmissionKey: jest.fn().mockResolvedValue(null),
        hasWorkOrderSummary: jest.fn().mockResolvedValue(false),
      },
      maintenanceQueryService: {
        ...makeMaintenanceQueryService(),
        listSteps: jest.fn().mockResolvedValue([
          {
            id: 'step-1',
            stepNo: 1,
            errorCode: null,
            partName: '激光器',
            actionText: '改：来源在首提失败后被修订',
            resultCode: 'RESOLVED',
          },
        ]),
      },
    });
    retry.writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    await expect(
      retry.usecase.execute(await directSubmitCommand({ sourceConfirmation: staleConfirmation })),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    // 不生成半份报告，也不把最新来源当成已确认内容
    expect(retry.writeService.insertReport).not.toHaveBeenCalled();
    expect(retry.writeService.insertVersion).not.toHaveBeenCalled();
    expect(retry.referenceDocumentService.insertDocument).not.toHaveBeenCalled();
  });

  it('直接提交不携带来源确认标识：拒绝且不落库（预览与校验必须同源绑定）', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    await expect(
      usecase.execute(await directSubmitCommand({ sourceConfirmation: null })),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.SUBMISSION_VERSION_CONFLICT });
    expect(writeService.insertReport).not.toHaveBeenCalled();
  });

  it('存在适用 AI 会话但未评价：拒绝提交（确认无会话才不强制评分）', async () => {
    const aiConversationDetail = {
      id: 700001,
      contentVersion: 3,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      completedAt: new Date('2026-10-02T00:00:00.000Z'),
      messages: [
        {
          id: 1,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          contentText: '设备上电报警',
          contentVersion: 1,
          turnState: 'SUCCEEDED',
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
          id: 2,
          messageSeq: 2,
          turnNo: 1,
          role: 'ASSISTANT',
          contentText: '建议检查供电与灯泡状态',
          contentVersion: 1,
          turnState: 'SUCCEEDED',
          createdAt: new Date('2026-10-01T00:01:00.000Z'),
        },
      ],
    };
    const { usecase, writeService } = makeUsecase({
      aiConversationQueryService: {
        listVisible: jest.fn().mockResolvedValue({
          items: [{ id: 700001, requestId: REPAIR_REQUEST_ID }],
          total: 1,
          hasMore: false,
        }),
        findVisibleDetail: jest.fn().mockResolvedValue(aiConversationDetail),
      },
    });
    writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    await expect(usecase.execute(await directSubmitCommand())).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_REQUIRED,
    });
    expect(writeService.insertReport).not.toHaveBeenCalled();
  });

  it('AI 会话查询失败：提交失败，不得按无会话提交', async () => {
    const { usecase, writeService } = makeUsecase({
      aiConversationQueryService: {
        listVisible: jest.fn().mockRejectedValue(new Error('redis down')),
        findVisibleDetail: jest.fn(),
      },
    });
    writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    await expect(usecase.execute(await directSubmitCommand())).rejects.toThrow('redis down');
    expect(writeService.insertReport).not.toHaveBeenCalled();
  });

  it('服务端确认无适用会话：未评价提交按 NOT_USED 落库', async () => {
    const { usecase, writeService } = makeUsecase({
      aiConversationQueryService: {
        listVisible: jest.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
        findVisibleDetail: jest.fn(),
      },
    });
    writeService.readRepairRequestWriteContext.mockResolvedValue(closedWorkOrderContext);

    const result = await usecase.execute(await directSubmitCommand());
    expect(result.status).toBe('SUBMITTED');
    // AI 评价组经 persistDraftContent → updateDraft 落库
    expect(writeService.updateDraft.mock.calls[0][1]).toMatchObject({ aiUsage: 'NOT_USED' });
  });
});

describe('SubmitMaintenanceReportFormalUsecase 工单总结结单原因口径（2026-11-21 修复）', () => {
  /**
   * 回归背景（现场工单 DEV-RR-A-102 / RR20261121212950LMMBYY）：结单侧
   * （任务 04 CloseRepairRequestUsecase）允许「故障修复 + 可选结单原因」落库，
   * 总结派生校验此前按「仅中断/无法修复可填写原因」拒绝，导致 Word/PDF 导出
   * 与正式提交全部失败。修复后总结链路复用结单侧规则：终结结果必填非空原因，
   * 非终结结果原因可选；已有原因原样保留，不被清空或丢弃。
   */
  const REASON = '设备已恢复正常生产';

  /** DEV-RR-A-102 类完整事实：故障修复 + 非空结单原因 */
  const workOrderWithReason = { ...closedWorkOrderContext, closureReason: REASON };

  const factsFingerprint = async (
    workOrder: Record<string, unknown>,
    maintenanceOverrides: Partial<ReturnType<typeof makeMaintenanceQueryService>> = {},
  ): Promise<string> =>
    fingerprintWorkOrderSummarySource(
      await readWorkOrderSummarySourceFacts({
        request: workOrder as never,
        maintenanceQueryService: {
          ...makeMaintenanceQueryService(),
          ...maintenanceOverrides,
        } as never,
        organizationQueryService: makeOrganizationQueryService() as never,
      }),
    );

  const makeDirectSubmit = (workOrder: Record<string, unknown>) =>
    makeUsecase({
      writeService: {
        ...makeWriteService(),
        readRepairRequestWriteContext: jest.fn().mockResolvedValue(workOrder),
      },
    });

  it('故障修复 + 非空结单原因 + 有效 AI 评价：直接提交成功并冻结原因与评价', async () => {
    // 直接提交带 AI 评价：需要任务 05 会话读侧替身（所选版本有有效回复）
    const findVisibleDetail = jest.fn().mockResolvedValue({
      id: 700001,
      requestId: REPAIR_REQUEST_ID,
      ownerOrganizationId: ORGANIZATION_ID,
      creatorAccountId: ACCOUNT_ID,
      status: 'COMPLETED',
      contentVersion: 2,
      messages: [
        {
          id: 1,
          role: 'USER',
          contentText: '上片失败怎么排查？',
          contentVersion: 1,
          createdAt: new Date('2026-09-30T00:00:00.000Z'),
        },
        {
          id: 2,
          role: 'ASSISTANT',
          contentText: '先检查真空与载台。',
          contentVersion: 2,
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
    }) as never;
    // 冻结快照按「同事务写入后回读」的草稿详情构建：注入与派生一致的总结合计
    const persisted = makeSummaryDetail();
    Object.assign(persisted.report, {
      closureReason: REASON,
      aiUsage: 'USED',
      aiSourceType: 'AI_CONVERSATION',
      aiSourceId: '700001',
      aiSourceVersion: '2',
      aiScore: 4,
      aiCorrectness: 'CORRECT',
      aiHelpfulness: 3,
      aiNote: '有帮助',
    });
    const { usecase, writeService } = makeUsecase({
      writeService: {
        ...makeWriteService(),
        readRepairRequestWriteContext: jest.fn().mockResolvedValue(workOrderWithReason),
      },
      queryService: makeQueryService(persisted),
      aiConversationQueryService: {
        listVisible: jest.fn(),
        findVisibleDetail,
      },
    });

    const result = await usecase.execute({
      session: engineerSession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      submissionRequestId: REQUEST_ID,
      sourceConfirmation: await factsFingerprint(workOrderWithReason),
      draft: {
        aiUsage: 'USED',
        aiSourceType: 'AI_CONVERSATION',
        aiSourceId: '700001',
        aiSourceVersion: '2',
        aiScore: 4,
        aiCorrectness: 'CORRECT',
        aiHelpfulness: 3,
        aiNote: '有帮助',
      },
    });

    expect(result.status).toBe('SUBMITTED');
    // 结单原因与 AI 评价进入草稿内容与冻结快照，均不被清空或丢弃
    expect(writeService.updateDraft).toHaveBeenCalledWith(
      REPORT_ID,
      expect.objectContaining({ closureReason: REASON, aiUsage: 'USED' }),
      transactionContext,
    );
    expect(writeService.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadSnapshot: expect.objectContaining({
          closureReason: REASON,
          ai: expect.objectContaining({ usage: 'USED', sourceId: '700001' }),
        }),
      }),
      transactionContext,
    );
  });

  it('中断维修缺少结单原因：仍拒绝提交（终结结果原因必填、空白不算填写）', async () => {
    const { usecase, writeService } = makeDirectSubmit({
      ...closedWorkOrderContext,
      handlingResult: 'INTERRUPTED',
      closureReason: null,
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        submissionRequestId: REQUEST_ID,
        sourceConfirmation: await factsFingerprint(closedWorkOrderContext),
        draft: {},
      }),
    ).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      message: '中断或无法修复必须填写原因',
    });
    expect(writeService.insertReport).not.toHaveBeenCalled();
  });

  it('维修事实缺失（无日期/无步骤/无故障面板）：不再因结单原因被拒，完整性守卫拦截并提示缺失项', async () => {
    // RR20261121212950LMMBYY 类不完整事实：FIXED + 原因已保留，但维修记录未填写
    const incompleteMaintenance = {
      findRecord: jest.fn().mockResolvedValue(null),
      findIntakeSource: jest.fn().mockResolvedValue(null),
      listSteps: jest.fn().mockResolvedValue([]),
      listFaultPanels: jest.fn().mockResolvedValue([]),
    };
    const { usecase, writeService } = makeUsecase({
      writeService: {
        ...makeWriteService(),
        readRepairRequestWriteContext: jest.fn().mockResolvedValue(workOrderWithReason),
      },
      maintenanceQueryService: incompleteMaintenance,
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: REPAIR_REQUEST_ID,
        submissionRequestId: REQUEST_ID,
        sourceConfirmation: await factsFingerprint(workOrderWithReason, incompleteMaintenance),
        draft: {},
      }),
    ).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      message: '提交前必须填写维修日期',
    });
    expect(writeService.insertReport).not.toHaveBeenCalled();
    expect(writeService.insertVersion).not.toHaveBeenCalled();
  });
});

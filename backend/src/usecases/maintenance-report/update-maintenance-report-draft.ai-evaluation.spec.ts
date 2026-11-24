// src/usecases/maintenance-report/update-maintenance-report-draft.ai-evaluation.spec.ts
//
// 工单总结草稿保存的 AI 评价组（真实用例入口）：
// - 客户端只提交 AI 字段（不提交内容字段），保存仍由服务端派生内容；
// - 标记使用 AI 时必须指向本人本工单、所选版本有有效回复的会话；
// - 引用不可用时失败关闭，不落库、不静默改成「未使用」。

/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  MaintenanceAiCorrectness,
  MaintenanceAiUsage,
} from '@app-types/models/maintenance-report.types';
import { MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { MaintenanceReportSnapshot } from '@src/modules/lithography/maintenance-report.types';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { UpdateMaintenanceReportDraftUsecase } from './update-maintenance-report-draft.usecase';

const ACCOUNT_ID = 900301;
const ORGANIZATION_ID = 910301;
const REPAIR_REQUEST_ID = 955301;
const REPORT_ID = 960301;
const CONVERSATION_ID = 700301;

const engineerSession = {
  accountId: ACCOUNT_ID,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

const makeReport = (overrides: Partial<MaintenanceReportSnapshot> = {}) =>
  ({
    id: REPORT_ID,
    status: 'DRAFT',
    sourceType: 'WORK_ORDER_SUMMARY',
    repairRequestId: REPAIR_REQUEST_ID,
    maintenanceEngineerAccountId: ACCOUNT_ID,
    ownerOrganizationId: ORGANIZATION_ID,
    currentVersionNo: 0,
    title: null,
    customerFactoryName: null,
    equipmentModelId: 300301,
    equipmentModelText: null,
    maintenanceDate: null,
    handlingResult: null,
    closureReason: null,
    resetResult: null,
    actualCause: null,
    repairActions: null,
    verificationResult: null,
    supplementaryNote: null,
    aiUsage: MaintenanceAiUsage.NOT_USED,
    aiSourceType: null,
    aiSourceId: null,
    aiSourceVersion: null,
    aiScore: null,
    aiCorrectness: null,
    aiHelpfulness: null,
    aiNote: null,
    ...overrides,
  }) as MaintenanceReportSnapshot;

const closedWorkOrder = {
  id: REPAIR_REQUEST_ID,
  requestNo: 'RR-2026-3001',
  customerAccountId: 880301,
  equipmentModelId: 300301,
  acceptedEngineerAccountId: ACCOUNT_ID,
  isAccepted: true,
  deprecated: false,
  ownerOrganizationId: ORGANIZATION_ID,
  closureStatus: 'CLOSED',
  closedAt: new Date('2026-10-02T00:00:00.000Z'),
  handlingResult: 'FIXED',
  handlingStatus: 'COMPLETED',
  closureReason: null,
  customerOrganizationId: 930301,
  currentRevisionNo: 1,
};

const draftDetail = (report: MaintenanceReportSnapshot) => ({
  report,
  alarms: [],
  steps: [],
  faults: [],
});

const conversationDetail = {
  id: CONVERSATION_ID,
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
      conversationId: CONVERSATION_ID,
      messageSeq: 1,
      turnNo: 1,
      role: 'USER',
      contentText: '排查问题',
      contentVersion: 1,
      createdAt: new Date('2026-09-30T00:00:00.000Z'),
    },
    {
      id: 2,
      conversationId: CONVERSATION_ID,
      messageSeq: 2,
      turnNo: 1,
      role: 'ASSISTANT',
      contentText: '排查建议',
      contentVersion: 2,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    },
  ],
};

const makeUsecase = (
  params: { findVisibleDetail?: jest.Mock; storedReport?: MaintenanceReportSnapshot } = {},
) => {
  const report = params.storedReport ?? makeReport();
  const writeService = {
    lockReportForWrite: jest.fn().mockResolvedValue(report),
    readRepairRequestWriteContext: jest.fn().mockResolvedValue(closedWorkOrder),
    updateDraft: jest.fn().mockResolvedValue(undefined),
    replaceAlarms: jest.fn().mockResolvedValue(undefined),
    replaceSteps: jest.fn().mockResolvedValue(undefined),
    replaceFaults: jest.fn().mockResolvedValue(undefined),
  };
  const queryService = {
    readDraftDetail: jest.fn().mockResolvedValue(draftDetail(report)),
    readReport: jest.fn().mockResolvedValue({
      id: REPORT_ID,
      status: 'DRAFT',
      currentVersionNo: 1,
      updatedAt: new Date(),
    }),
  };
  const aiConversationQueryService = {
    listVisible: jest.fn(),
    findVisibleDetail: params.findVisibleDetail ?? jest.fn().mockResolvedValue(conversationDetail),
  };
  const usecase = new UpdateMaintenanceReportDraftUsecase(
    writeService as unknown as MaintenanceReportService,
    queryService as unknown as MaintenanceReportQueryService,
    {
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: ORGANIZATION_ID }),
    } as unknown as TrustedOrganizationContextQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertBusinessWritableInTransaction: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertCompanyWritableInTransaction: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    { findModelById: jest.fn().mockResolvedValue(null) } as unknown as EquipmentModelQueryService,
    { lockForBinding: jest.fn(), bindIfTemporary: jest.fn(), unbindIfBoundTo: jest.fn() } as never,
    {
      findRecord: jest.fn().mockResolvedValue({
        maintenanceDate: '2026-10-02',
        resetResult: 'NORMAL',
        supplementaryNote: '已现场培训',
        attachment: null,
      }),
      listSteps: jest.fn().mockResolvedValue([]),
      listFaultPanels: jest.fn().mockResolvedValue([]),
      findIntakeSource: jest.fn().mockResolvedValue(null),
    } as never,
    { findOrganizationNameById: jest.fn().mockResolvedValue('客户公司A') } as never,
    aiConversationQueryService as never,
    {
      run: async <T>(work: (context: never) => Promise<T>): Promise<T> => work({} as never),
    },
  );
  return { usecase, writeService, aiConversationQueryService };
};

const aiDraft = {
  aiUsage: 'USED',
  aiSourceType: 'AI_CONVERSATION',
  aiSourceId: String(CONVERSATION_ID),
  aiSourceVersion: '2',
  aiScore: 4,
  aiCorrectness: 'CORRECT',
  aiHelpfulness: 3,
  aiNote: '有帮助',
};

describe('UpdateMaintenanceReportDraftUsecase 工单总结 AI 评价', () => {
  it('只提交 AI 字段时保存成功，内容仍由服务端派生', async () => {
    const { usecase, writeService } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      reportId: REPORT_ID,
      draft: aiDraft,
      attachment: null,
    });

    expect(writeService.updateDraft).toHaveBeenCalledWith(
      REPORT_ID,
      expect.objectContaining({
        aiUsage: MaintenanceAiUsage.USED,
        aiSourceType: 'AI_CONVERSATION',
        aiSourceId: String(CONVERSATION_ID),
        aiSourceVersion: '2',
        aiScore: 4,
        aiCorrectness: 'CORRECT',
        aiHelpfulness: 3,
        aiNote: '有帮助',
        // 内容字段由工单事实派生（客户端未提交内容字段，也不为空）
        handlingResult: 'FIXED',
        resetResult: 'NORMAL',
      }),
      expect.anything(),
    );
  });

  it('会话无权/不存在：拒绝保存且不落库', async () => {
    const { usecase, writeService } = makeUsecase({
      findVisibleDetail: jest.fn().mockResolvedValue(null),
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        reportId: REPORT_ID,
        draft: aiDraft,
        attachment: null,
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID });
    expect(writeService.updateDraft).not.toHaveBeenCalled();
  });

  it('明确切回未使用：整组清空，不保留旧引用', async () => {
    const { usecase, writeService } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      reportId: REPORT_ID,
      draft: { aiUsage: 'NOT_USED' },
      attachment: null,
    });

    expect(writeService.updateDraft).toHaveBeenCalledWith(
      REPORT_ID,
      expect.objectContaining({
        aiUsage: MaintenanceAiUsage.NOT_USED,
        aiSourceId: null,
        aiSourceVersion: null,
        aiScore: null,
      }),
      expect.anything(),
    );
  });

  it('来源工单重新核对并再保存（客户端不带 AI 字段）：沿用库内评价', async () => {
    const storedReport = makeReport({
      aiUsage: MaintenanceAiUsage.USED,
      aiSourceType: 'AI_CONVERSATION',
      aiSourceId: String(CONVERSATION_ID),
      aiSourceVersion: '2',
      aiScore: 4,
      aiCorrectness: MaintenanceAiCorrectness.CORRECT,
      aiHelpfulness: 3,
      aiNote: '有帮助',
    });
    const { usecase, writeService } = makeUsecase({ storedReport });

    await usecase.execute({
      session: engineerSession,
      reportId: REPORT_ID,
      draft: {},
      attachment: null,
    });

    expect(writeService.updateDraft).toHaveBeenCalledWith(
      REPORT_ID,
      expect.objectContaining({
        aiUsage: MaintenanceAiUsage.USED,
        aiSourceType: 'AI_CONVERSATION',
        aiSourceId: String(CONVERSATION_ID),
        aiSourceVersion: '2',
        aiScore: 4,
        aiCorrectness: 'CORRECT',
        aiHelpfulness: 3,
        aiNote: '有帮助',
        // 内容仍由当前工单事实派生
        handlingResult: 'FIXED',
      }),
      expect.anything(),
    );
  });
});

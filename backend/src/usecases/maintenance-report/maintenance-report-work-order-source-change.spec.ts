// src/usecases/maintenance-report/maintenance-report-work-order-source-change.spec.ts
//
// 工单来源变化与「重新核对」反例（真实用例入口 + 真实派生/比对实现）：
//   1) 只改排查步骤内容            → 判定已变化（需重新核对并重新保存）
//   2) 只改故障面板内容            → 判定已变化
//   3) 来源工单原件无→有/A→B/有→无 → sourceChangedSinceDraft 不覆盖（见下方绑定模型说明）
//   4) 管理员修订但维修内容不变    → 判定为未变化（按内容比对，修订号只是 provenance）
//   5) 完全未变化                  → 判定为未变化
//   6) 工程师重新核对并重新保存    → 判定恢复为未变化
//
// 原件绑定模型（2026-11-21 需求调整）：`maintenance_report` 根表没有保存「保存草稿时
// 确认的来源原件事实」的列（唯一 JSON 列是冻结版本 `payload_snapshot`），本标志
// （sourceChangedSinceDraft）只做内容级提示；来源原件的新增/移除/更换由
// 「预览与校验同源」绑定保证——myWorkOrderSummary 的 sourcePreview 与 sourceConfirmation
// 来自同一次服务端读取，提交时在事务内以同一指纹函数复核，指纹失配即拒绝提交
// （SUBMISSION_VERSION_CONFLICT），不存在「仅凭两次请求成功就认定一致」的窗口。
//
// 只替换读侧 QueryService 的返回值（模拟数据库事实），派生、归一化与比对都用生产代码。

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetMyWorkOrderSummaryUsecase } from './get-my-work-order-summary.usecase';
import { normalizeMaintenanceReportDraft } from './maintenance-report.input.normalize';
import {
  buildWorkOrderSummaryDraftInput,
  readWorkOrderSummarySourceFacts,
} from './maintenance-report-work-order-source.helpers';

const ACCOUNT_ID = 900001;
const ORGANIZATION_ID = 920001;
const REPAIR_REQUEST_ID = 955001;
const REPORT_ID = 990001;

const SESSION = {
  accountId: ACCOUNT_ID,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

type WorkOrder = {
  id: number;
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  acceptedEngineerAccountId: number;
  isAccepted: boolean;
  deprecated: boolean;
  ownerOrganizationId: number;
  closureStatus: string;
  closedAt: Date;
  handlingResult: string;
  handlingStatus: string;
  closureReason: string | null;
  customerOrganizationId: number;
  currentRevisionNo: number;
};

const baseWorkOrder = (overrides: Partial<WorkOrder> = {}): WorkOrder => ({
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
  ...overrides,
});

const record = (overrides: Record<string, unknown> = {}) => ({
  maintenanceDate: '2026-10-02',
  resetResult: 'NORMAL',
  supplementaryNote: '已现场培训',
  attachment: null as null | { fileId: string; originalFilename: string; byteSize: number },
  ...overrides,
});

const stepRows = (actionText = '重新插拔线缆') => [
  {
    id: 'step-1',
    stepNo: 1,
    errorCode: null as string | null,
    partName: '激光器' as string | null,
    actionText,
    resultCode: 'RESOLVED',
  },
];

const panelRows = (description = '上电报警') => [
  {
    id: 'panel-1',
    panelType: 'INITIAL',
    stepId: null as string | null,
    phaseCode: 'PHASE_02',
    mainError: 'E-01',
    unitError: null,
    source: 'ALARM_HISTORY',
    errorType: null,
    gpibStatus: null,
    faultStatus: 'PERSISTENT',
    description,
    action: '检查供电',
  },
];

const maintenanceQueryService = (params: {
  record: ReturnType<typeof record>;
  steps: ReturnType<typeof stepRows>;
  panels: ReturnType<typeof panelRows>;
}) =>
  ({
    findRecord: jest.fn().mockResolvedValue(params.record),
    listSteps: jest.fn().mockResolvedValue(params.steps),
    listFaultPanels: jest.fn().mockResolvedValue(params.panels),
    // 客户原始报修（2026-11-21 起参与来源事实与指纹）
    findIntakeSource: jest.fn().mockResolvedValue(null),
  }) as unknown as RepairRequestMaintenanceQueryService;

const organizationQueryService = () =>
  ({
    findOrganizationNameById: jest.fn().mockResolvedValue('客户公司A'),
  }) as unknown as OrganizationQueryService;

/** 用「保存草稿时」的工单事实生成库内草稿（与生产写入结构一致） */
const buildStoredDraft = async (params: {
  workOrder: WorkOrder;
  record: ReturnType<typeof record>;
  steps: ReturnType<typeof stepRows>;
  panels: ReturnType<typeof panelRows>;
}) => {
  const facts = await readWorkOrderSummarySourceFacts({
    request: params.workOrder,
    maintenanceQueryService: maintenanceQueryService(params),
    organizationQueryService: organizationQueryService(),
  });
  const normalized = normalizeMaintenanceReportDraft(
    buildWorkOrderSummaryDraftInput(facts),
    ACCOUNT_ID,
  );
  const header = normalized as unknown as Record<string, unknown>;
  return {
    report: {
      ...header,
      id: REPORT_ID,
      status: 'DRAFT',
      currentVersionNo: 0,
      createdByAccountId: ACCOUNT_ID,
      updatedByAccountId: ACCOUNT_ID,
    },
    alarms: normalized.alarms,
    steps: normalized.steps.map((step, index) => ({
      ...step,
      id: 200 + index,
      reportId: REPORT_ID,
    })),
    faults: normalized.faults.map((fault, index) => ({
      ...fault,
      id: `fault-${index}`,
      reportId: REPORT_ID,
      createdByAccountId: ACCOUNT_ID,
    })),
    attachments: [],
    latestReturnComment: null,
  };
};

const run = async (params: {
  liveWorkOrder: WorkOrder;
  liveQuery: {
    record: ReturnType<typeof record>;
    steps: ReturnType<typeof stepRows>;
    panels: ReturnType<typeof panelRows>;
  };
  storedDraft: Awaited<ReturnType<typeof buildStoredDraft>>;
}) => {
  const reportService = {
    findRepairRequestWriteContext: jest.fn().mockResolvedValue(params.liveWorkOrder),
  };
  const queryService = {
    findEquipmentModelRef: jest
      .fn()
      .mockResolvedValue({ id: 300001, modelCode: 'ASML-XT', modelName: 'ASML XT' }),
    findOwnershipByRepairRequestId: jest.fn().mockResolvedValue({
      reportId: REPORT_ID,
      maintenanceEngineerAccountId: ACCOUNT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
    }),
    readReportDetail: jest.fn().mockResolvedValue({ ...params.storedDraft, canEdit: true }),
    readDraftDetail: jest.fn().mockResolvedValue(params.storedDraft),
  };
  const organizationContextService = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: ORGANIZATION_ID }),
  };
  const usecase = new GetMyWorkOrderSummaryUsecase(
    reportService as unknown as MaintenanceReportService,
    queryService as unknown as MaintenanceReportQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    maintenanceQueryService(params.liveQuery),
    organizationQueryService(),
  );
  return usecase.execute({ session: SESSION, repairRequestId: REPAIR_REQUEST_ID });
};

describe('工单总结来源变化判定（真实入口）', () => {
  it('完全未变化：不提示重新核对', async () => {
    const saved = { record: record(), steps: stepRows(), panels: panelRows() };
    const storedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...saved });

    const entry = await run({
      liveWorkOrder: baseWorkOrder(),
      liveQuery: saved,
      storedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(false);
  });

  it('只改排查步骤内容：判定已变化', async () => {
    const saved = { record: record(), steps: stepRows(), panels: panelRows() };
    const storedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...saved });

    const entry = await run({
      liveWorkOrder: baseWorkOrder(),
      liveQuery: {
        record: record(),
        steps: stepRows('改：重新压接线缆并测量阻抗'),
        panels: panelRows(),
      },
      storedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(true);
  });

  it('只改故障面板内容：判定已变化', async () => {
    const saved = { record: record(), steps: stepRows(), panels: panelRows() };
    const storedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...saved });

    const entry = await run({
      liveWorkOrder: baseWorkOrder(),
      liveQuery: {
        record: record(),
        steps: stepRows(),
        panels: panelRows('改：上电报警（补充描述）'),
      },
      storedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(true);
  });

  it('只新增/删除排查步骤：判定已变化', async () => {
    const saved = { record: record(), steps: stepRows(), panels: panelRows() };
    const storedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...saved });

    const entry = await run({
      liveWorkOrder: baseWorkOrder(),
      liveQuery: {
        record: record(),
        steps: [
          ...stepRows(),
          {
            id: 'step-2',
            stepNo: 2,
            errorCode: null,
            partName: null,
            actionText: '补充：检查冷却回路',
            resultCode: 'RESOLVED',
          },
        ],
        panels: panelRows(),
      },
      storedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(true);
  });

  // 绑定模型说明：来源原件变化不依赖 sourceChangedSinceDraft（本标志只做内容级提示），
  // 由「预览与校验同源」的提交侧指纹复核拒绝（见文件头注释与正式提交用例测试）。
  it('只更换来源工单原件（A→B）：sourceChangedSinceDraft 不覆盖（提交侧指纹兜底）', async () => {
    const oldAttachment = {
      fileId: '11111111-1111-4111-8111-111111111111',
      originalFilename: '维修记录-旧.pdf',
      byteSize: 1024,
    };
    const newAttachment = {
      fileId: '22222222-2222-4222-8222-222222222222',
      originalFilename: '维修记录-新.pdf',
      byteSize: 2048,
    };
    const saved = {
      record: record({ attachment: oldAttachment }),
      steps: stepRows(),
      panels: panelRows(),
    };
    const storedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...saved });

    const entry = await run({
      liveWorkOrder: baseWorkOrder(),
      liveQuery: { ...saved, record: record({ attachment: newAttachment }) },
      storedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(false);
  });

  it('来源工单原件从无到有：sourceChangedSinceDraft 不覆盖（提交侧指纹兜底）', async () => {
    const newAttachment = {
      fileId: '22222222-2222-4222-8222-222222222222',
      originalFilename: '维修记录-新增.pdf',
      byteSize: 2048,
    };
    const saved = { record: record(), steps: stepRows(), panels: panelRows() };
    const storedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...saved });

    const entry = await run({
      liveWorkOrder: baseWorkOrder(),
      liveQuery: { ...saved, record: record({ attachment: newAttachment }) },
      storedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(false);
  });

  it('来源工单原件被移除（有→无）：sourceChangedSinceDraft 不覆盖（提交侧指纹兜底）', async () => {
    const oldAttachment = {
      fileId: '11111111-1111-4111-8111-111111111111',
      originalFilename: '维修记录-旧.pdf',
      byteSize: 1024,
    };
    const saved = {
      record: record({ attachment: oldAttachment }),
      steps: stepRows(),
      panels: panelRows(),
    };
    const storedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...saved });

    const entry = await run({
      liveWorkOrder: baseWorkOrder(),
      liveQuery: { ...saved, record: record() },
      storedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(false);
  });

  it('工程师重新核对后重新保存：来源变化提示消失', async () => {
    const changed = {
      record: record(),
      steps: stepRows('改：重新压接线缆并测量阻抗'),
      panels: panelRows(),
    };
    // 重新保存 = 以当前工单事实重新派生落库（真实更新草稿用例的同一派生函数）
    const reSavedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...changed });

    const entry = await run({
      liveWorkOrder: baseWorkOrder(),
      liveQuery: changed,
      storedDraft: reSavedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(false);
  });

  it('管理员修订但维修内容不变：不判定为变化（按内容比对，修订号仅 provenance）', async () => {
    const saved = { record: record(), steps: stepRows(), panels: panelRows() };
    const storedDraft = await buildStoredDraft({ workOrder: baseWorkOrder(), ...saved });

    const entry = await run({
      liveWorkOrder: baseWorkOrder({ currentRevisionNo: 7 }),
      liveQuery: saved,
      storedDraft,
    });

    expect(entry.sourceChangedSinceDraft).toBe(false);
  });
});

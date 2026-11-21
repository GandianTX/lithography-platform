// src/usecases/maintenance-report/export-maintenance-report.spec.ts
//
// R051 导出用例单测：身份/来源/工单权限/内容完整性裁决，预览导出零业务写入，
// 隐藏分支剔除，附件失败关闭。渲染字节内容由渲染器单测覆盖（真实 DOCX/PDF 解析）。

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { ExportMaintenanceReportUsecase } from './export-maintenance-report.usecase';
import type { MaintenanceReportExportDocument } from './ports/maintenance-report-export-renderer.contract';

const ACCOUNT_ID = 900001;
const OTHER_ACCOUNT_ID = 900002;
const ORGANIZATION_ID = 910001;
const OTHER_ORGANIZATION_ID = 910002;
const REPAIR_REQUEST_ID = 955001;
const REPORT_ID = 960001;
const VERSION_ID = 990001;

const engineerSession = {
  accountId: ACCOUNT_ID,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

/** 满足正式完整性的最小当前表单输入（未保存草稿可导出） */
const currentFormInput = (overrides: Record<string, unknown> = {}) => ({
  format: 'DOCX',
  currentForm: {
    sourceType: 'HISTORICAL_CASE',
    repairRequestId: null,
    draft: {
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
    },
  },
  ...overrides,
});

const makeVersionPayload = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  sourceType: 'HISTORICAL_CASE',
  repairRequestId: null,
  title: '2026-10-01 某封测厂 历史维修记录',
  customerFactoryName: '某封测厂',
  equipmentModelId: null,
  equipmentModelText: 'NSR-2205i11',
  maintenanceDate: '2026-10-01',
  maintenanceEngineerAccountId: ACCOUNT_ID,
  maintenanceEngineerName: '李工',
  phaseFlowVersion: 1,
  alarms: [
    {
      alarmIndex: 1,
      alarmCode: 'E001',
      alarmDescription: '上片失败',
      phaseCode: 'PHASE_01',
      resetResult: 'RESET_OK',
    },
  ],
  steps: Array.from({ length: 15 }, (_, index) => ({
    stepNo: index + 1,
    stepCode: `STEP-${index + 1}`,
    phaseCode: 'PHASE_02',
    partName: null,
    actionText: `排查动作 ${index + 1}`,
    resultText: `步骤结果 ${index + 1}`,
    newAlarmCode: null,
    isValidNewBranch: false,
  })),
  faults: [
    {
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
      action: '更换光源模块',
    },
  ],
  handlingResult: 'FIXED',
  closureReason: null,
  resetResult: 'NORMAL',
  actualCause: '光源老化',
  repairActions: '更换光源模块',
  verificationResult: '复测通过',
  supplementaryNote: null,
  ai: {
    usage: 'NOT_USED',
    sourceType: null,
    sourceId: null,
    sourceVersion: null,
    score: null,
    correctness: null,
    helpfulness: null,
    note: null,
  },
  ...overrides,
});

const makeOrganizationContextService = (organizationId = ORGANIZATION_ID) => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 950001,
    organizationId,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '甲方默认组织',
    organizationKind: 'CLIENT',
    memberRole: 'ENGINEER',
  }),
});

const makeAccountQueryService = () => ({
  findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[ACCOUNT_ID, '李工']])),
});

const makeQueryService = () => ({
  readReportOwnership: jest.fn().mockResolvedValue({
    reportId: REPORT_ID,
    maintenanceEngineerAccountId: ACCOUNT_ID,
    ownerOrganizationId: ORGANIZATION_ID,
  }),
  readReport: jest.fn().mockResolvedValue({
    id: REPORT_ID,
    ownerOrganizationId: ORGANIZATION_ID,
    maintenanceEngineerAccountId: ACCOUNT_ID,
    currentVersionNo: 1,
  }),
  readVersion: jest.fn().mockResolvedValue({
    id: VERSION_ID,
    reportId: REPORT_ID,
    versionNo: 1,
    payloadSnapshot: makeVersionPayload(),
  }),
  readVersionAttachments: jest.fn().mockResolvedValue([]),
  readAttachmentsByIds: jest.fn().mockResolvedValue([]),
});

const makeWriteService = (workOrder: Record<string, unknown> | null = null) => ({
  findRepairRequestWriteContext: jest.fn().mockResolvedValue(workOrder),
  updateDraft: jest.fn(),
  replaceAlarms: jest.fn(),
  replaceSteps: jest.fn(),
  replaceFaults: jest.fn(),
  insertReport: jest.fn(),
  insertVersion: jest.fn(),
  insertVersionAttachments: jest.fn(),
  markSubmitted: jest.fn(),
});

const makeStorage = () => ({
  save: jest.fn(),
  open: jest.fn(),
  delete: jest.fn(),
  verifyIntegrity: jest.fn().mockResolvedValue(true),
});

/** 机型库读侧替身（2026-11-21 修复：导出机型标签按 ID 解析名称） */
const makeEquipmentModelQueryService = () => ({
  findModelById: jest
    .fn()
    .mockResolvedValue({ id: 300001, modelCode: 'ASML-XT', modelName: 'ASML XT', enabled: true }),
});

const makeRenderer = () => ({
  render: jest.fn().mockResolvedValue({
    content: Buffer.from('exported-bytes'),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileExtension: 'docx',
  }),
});

const makeUsecase = (
  overrides: {
    queryService?: ReturnType<typeof makeQueryService>;
    writeService?: ReturnType<typeof makeWriteService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    accountQueryService?: ReturnType<typeof makeAccountQueryService>;
    storage?: ReturnType<typeof makeStorage>;
    renderer?: ReturnType<typeof makeRenderer>;
    /** 来源工单维修事实读侧（冻结版本导出不应读取它） */
    maintenanceQueryService?: {
      findRecord: jest.Mock;
      findIntakeSource: jest.Mock;
      listSteps: jest.Mock;
      listFaultPanels: jest.Mock;
    };
  } = {},
) => {
  const queryService = overrides.queryService ?? makeQueryService();
  const writeService = overrides.writeService ?? makeWriteService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const accountQueryService = overrides.accountQueryService ?? makeAccountQueryService();
  const storage = overrides.storage ?? makeStorage();
  const renderer = overrides.renderer ?? makeRenderer();
  const maintenanceQueryService =
    overrides.maintenanceQueryService ??
    ({
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
    } satisfies {
      findRecord: jest.Mock;
      findIntakeSource: jest.Mock;
      listSteps: jest.Mock;
      listFaultPanels: jest.Mock;
    });
  const equipmentModelQueryService = makeEquipmentModelQueryService();
  const usecase = new ExportMaintenanceReportUsecase(
    queryService as unknown as MaintenanceReportQueryService,
    writeService as unknown as MaintenanceReportService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    accountQueryService as unknown as AccountQueryService,
    maintenanceQueryService as never,
    {
      findOrganizationNameById: jest.fn().mockResolvedValue('客户公司A'),
    } as never,
    equipmentModelQueryService as never,
    storage,
    renderer,
  );
  return {
    usecase,
    queryService,
    writeService,
    storage,
    renderer,
    organizationContextService,
    maintenanceQueryService,
    equipmentModelQueryService,
  };
};

describe('ExportMaintenanceReportUsecase 当前表单导出', () => {
  it('未保存表单 DOCX 导出：文档含归一化内容，零业务写入', async () => {
    const { usecase, writeService, renderer } = makeUsecase();
    const result = await usecase.execute({
      session: engineerSession,
      ...currentFormInput(),
    });

    expect(renderer.render).toHaveBeenCalledTimes(1);
    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.title).toContain('某封测厂');
    expect(document.customerFactoryName).toBe('某封测厂');
    expect(document.equipmentModelLabel).toBe('NSR-2205i11');
    expect(document.handlingResultLabel).toBe('故障修复');
    expect(document.steps).toHaveLength(1);
    expect(document.faults).toHaveLength(1);
    expect(document.faults[0]?.branchLabel).toBe('初始故障');
    expect(document.ai.status).toBe('NOT_USED');
    expect(document.attachments).toHaveLength(0);
    expect(result.format).toBe('DOCX');
    expect(result.fileName.endsWith('.docx')).toBe(true);
    expect(result.byteSize).toBe(Buffer.from(result.contentBase64, 'base64').length);
    expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('exported-bytes');
    // 预览/导出零写入：不触报告写方法，不登记机型
    expect(writeService.updateDraft).not.toHaveBeenCalled();
    expect(writeService.insertReport).not.toHaveBeenCalled();
    expect(writeService.insertVersion).not.toHaveBeenCalled();
    expect(writeService.replaceSteps).not.toHaveBeenCalled();
  });

  it('失效分支不进入导出内容：步骤结果非新故障时其故障面板被剔除', async () => {
    const { usecase, renderer } = makeUsecase();
    const input = currentFormInput();
    const draft = input.currentForm.draft as Record<string, unknown>;
    draft.steps = [
      {
        stepCode: 'STEP-A',
        phaseCode: 'PHASE_02',
        actionText: '清洁镜头并复测',
        resultCode: 'RESOLVED',
      },
    ];
    draft.faults = [
      {
        branchKind: 'INITIAL',
        phaseCode: 'PHASE_01',
        mainError: 'E001',
        description: '上片失败',
      },
      {
        branchKind: 'STEP_NEW_FAULT',
        stepNo: 1,
        phaseCode: 'PHASE_03',
        description: '已切走的旧分支内容',
      },
    ];
    await usecase.execute({ session: engineerSession, ...input });
    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.faults).toHaveLength(1);
    expect(document.faults.every((fault) => fault.branchLabel !== '排查步骤新故障')).toBe(true);
  });

  it('完整性与输入校验：缺厂家、非法格式、目标重复或缺失均拒绝', async () => {
    const { usecase } = makeUsecase();
    await expect(
      usecase.execute({
        session: engineerSession,
        format: 'DOCX',
        currentForm: {
          sourceType: 'HISTORICAL_CASE',
          repairRequestId: null,
          draft: { maintenanceDate: '2026-10-01', handlingResult: 'FIXED' },
        },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({ session: engineerSession, ...currentFormInput({ format: 'HTML' }) }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({
        session: engineerSession,
        format: 'DOCX',
        currentForm: currentFormInput().currentForm,
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({ session: engineerSession, format: 'DOCX' }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
  });

  it('工单总结导出复核工单前置：未结单/非接单人/跨组织拒绝', async () => {
    const notClosed = makeUsecase({
      writeService: makeWriteService({
        id: REPAIR_REQUEST_ID,
        deprecated: false,
        isAccepted: true,
        acceptedEngineerAccountId: ACCOUNT_ID,
        ownerOrganizationId: ORGANIZATION_ID,
        closureStatus: 'OPEN',
      }),
    });
    await expect(
      notClosed.usecase.execute({
        session: engineerSession,
        format: 'PDF',
        currentForm: {
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: REPAIR_REQUEST_ID,
          draft: {},
        },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_NOT_CLOSED });

    const otherEngineer = makeUsecase({
      writeService: makeWriteService({
        id: REPAIR_REQUEST_ID,
        deprecated: false,
        isAccepted: true,
        acceptedEngineerAccountId: OTHER_ACCOUNT_ID,
        ownerOrganizationId: ORGANIZATION_ID,
        closureStatus: 'CLOSED',
      }),
    });
    await expect(
      otherEngineer.usecase.execute({
        session: engineerSession,
        format: 'PDF',
        currentForm: {
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: REPAIR_REQUEST_ID,
          draft: {},
        },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH });

    const crossOrganization = makeUsecase({
      writeService: makeWriteService({
        id: REPAIR_REQUEST_ID,
        deprecated: false,
        isAccepted: true,
        acceptedEngineerAccountId: ACCOUNT_ID,
        ownerOrganizationId: OTHER_ORGANIZATION_ID,
        closureStatus: 'CLOSED',
      }),
    });
    await expect(
      crossOrganization.usecase.execute({
        session: engineerSession,
        format: 'PDF',
        currentForm: {
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: REPAIR_REQUEST_ID,
          draft: {},
        },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH });

    // 合法工单总结导出通过（内容以服务端派生的工单事实为准）
    const ok = makeUsecase({
      writeService: makeWriteService({
        id: REPAIR_REQUEST_ID,
        requestNo: 'RR-2026-1001',
        customerAccountId: 880001,
        equipmentModelId: 300001,
        deprecated: false,
        isAccepted: true,
        acceptedEngineerAccountId: ACCOUNT_ID,
        ownerOrganizationId: ORGANIZATION_ID,
        closureStatus: 'CLOSED',
        closedAt: new Date('2026-10-02T00:00:00.000Z'),
        handlingResult: 'FIXED',
        handlingStatus: 'COMPLETED',
        closureReason: null,
        customerOrganizationId: 930001,
        currentRevisionNo: 1,
      }),
    });
    await expect(
      ok.usecase.execute({
        session: engineerSession,
        format: 'PDF',
        currentForm: {
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: REPAIR_REQUEST_ID,
          draft: {},
        },
      }),
    ).resolves.toMatchObject({ format: 'PDF' });
  });

  // 2026-11-21 修复回归（现场工单 DEV-RR-A-102 / RR20261121212950LMMBYY）：
  // 结单侧允许「故障修复 + 可选结单原因」落库，总结导出此前按
  // 「仅中断/无法修复可填写原因」拒绝。修复后总结链路复用结单侧规则，
  // 已有原因在 Word/PDF 导出中原样保留，不被清空或丢弃。
  it('工单总结导出（故障修复 + 非空结单原因）：Word/PDF 均保留结单原因', async () => {
    const reason = '设备已恢复正常生产';
    const { usecase, renderer } = makeUsecase({
      writeService: makeWriteService({
        id: REPAIR_REQUEST_ID,
        requestNo: 'RR-2026-1001',
        customerAccountId: 880001,
        equipmentModelId: 300001,
        deprecated: false,
        isAccepted: true,
        acceptedEngineerAccountId: ACCOUNT_ID,
        ownerOrganizationId: ORGANIZATION_ID,
        closureStatus: 'CLOSED',
        closedAt: new Date('2026-10-02T00:00:00.000Z'),
        handlingResult: 'FIXED',
        handlingStatus: 'COMPLETED',
        closureReason: reason,
        customerOrganizationId: 930001,
        currentRevisionNo: 1,
      }),
    });

    for (const format of ['DOCX', 'PDF'] as const) {
      await expect(
        usecase.execute({
          session: engineerSession,
          format,
          currentForm: {
            sourceType: 'WORK_ORDER_SUMMARY',
            repairRequestId: REPAIR_REQUEST_ID,
            draft: {},
          },
        }),
      ).resolves.toMatchObject({ format });
    }

    expect(renderer.render).toHaveBeenCalledTimes(2);
    for (const call of renderer.render.mock.calls) {
      expect((call[0] as MaintenanceReportExportDocument).closureReason).toBe(reason);
    }
  });

  // 来源限定：独立历史记录表单不与工单结单事实对齐，保持既有规则
  it('独立历史记录保持既有规则：故障修复携带结单原因仍拒绝', async () => {
    const { usecase } = makeUsecase();
    await expect(
      usecase.execute({
        session: engineerSession,
        format: 'DOCX',
        currentForm: {
          sourceType: 'HISTORICAL_CASE',
          repairRequestId: null,
          draft: { ...currentFormInput().currentForm.draft, closureReason: '已修复' },
        },
      }),
    ).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      message: '仅中断或无法修复结果可填写原因',
    });
  });
});

describe('ExportMaintenanceReportUsecase 已保存版本导出', () => {
  // 2026-11-21 修复：冻结快照只存机型 ID（提交后 equipmentModelText 恒 null），
  // 导出标签此前显示「型号 #ID」占位符，与正式资料正文机型名不一致。
  it('冻结版本导出机型标签：按机型库 ID 解析名称，与正式资料正文同一语义', async () => {
    const queryService = makeQueryService();
    queryService.readVersion.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 1,
      payloadSnapshot: makeVersionPayload({
        equipmentModelId: 300001,
        equipmentModelText: null,
      }),
    });
    const { usecase, equipmentModelQueryService, renderer } = makeUsecase({ queryService });

    await usecase.execute({
      session: engineerSession,
      format: 'PDF',
      savedVersion: { reportId: REPORT_ID, versionNo: null },
    });

    expect(equipmentModelQueryService.findModelById).toHaveBeenCalledWith({ id: 300001 });
    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.equipmentModelLabel).toBe('ASML XT');
  });

  // 2026-11-21 机型冻结语义修复（先红后绿）：提交事务内解析的机型显示名随快照
  // 冻结（equipmentModelName）。已提交版本导出必须使用冻结名——机型库改名后旧
  // 版本导出内容不得变化；仅旧快照缺键时才按 ID 回落解析（如实回退，不伪造历史）。
  it('快照已冻结机型名：导出使用冻结名，不重读机型库（改名不影响旧版本）', async () => {
    const queryService = makeQueryService();
    queryService.readVersion.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 1,
      payloadSnapshot: makeVersionPayload({
        equipmentModelId: 300001,
        equipmentModelText: null,
        equipmentModelName: '机型A-提交当时名',
      }),
    });
    const { usecase, equipmentModelQueryService, renderer } = makeUsecase({ queryService });
    // 模拟提交之后机型库改名：实时读取会拿到新名 B，冻结语义下不得出现
    equipmentModelQueryService.findModelById.mockResolvedValue({
      id: 300001,
      modelCode: 'ASML-XT',
      modelName: '机型B-改名后',
      enabled: true,
    });

    await usecase.execute({
      session: engineerSession,
      format: 'PDF',
      savedVersion: { reportId: REPORT_ID, versionNo: null },
    });

    expect(equipmentModelQueryService.findModelById).not.toHaveBeenCalled();
    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.equipmentModelLabel).toBe('机型A-提交当时名');
  });

  it('机型库记录缺失时回落为 ID 占位标签，不伪称机型名', async () => {
    const queryService = makeQueryService();
    queryService.readVersion.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 1,
      payloadSnapshot: makeVersionPayload({
        equipmentModelId: 300001,
        equipmentModelText: null,
      }),
    });
    const { usecase, equipmentModelQueryService, renderer } = makeUsecase({ queryService });
    equipmentModelQueryService.findModelById.mockResolvedValue(null);

    await usecase.execute({
      session: engineerSession,
      format: 'PDF',
      savedVersion: { reportId: REPORT_ID, versionNo: null },
    });

    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.equipmentModelLabel).toBe('型号 #300001');
  });

  it('本人冻结版本导出：文档按快照内容渲染（15 步/有效分支/AI 不适用）', async () => {
    const { usecase, queryService, renderer } = makeUsecase();
    const result = await usecase.execute({
      session: engineerSession,
      format: 'PDF',
      savedVersion: { reportId: REPORT_ID, versionNo: null },
    });

    expect(queryService.readReportOwnership).toHaveBeenCalledWith(REPORT_ID);
    const readReportCall = queryService.readReport.mock.calls[0];
    // 归属裁决通过后仍以 ReadScope 谓词二次约束
    expect(readReportCall[2]).toEqual({
      ownerOrganizationId: ORGANIZATION_ID,
      maintenanceEngineerAccountId: ACCOUNT_ID,
    });
    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.title).toBe('2026-10-01 某封测厂 历史维修记录');
    expect(document.engineerName).toBe('李工');
    expect(document.steps).toHaveLength(15);
    expect(document.alarms).toHaveLength(1);
    expect(document.faults[0]?.description).toBe('上片失败');
    expect(document.ai.status).toBe('NOT_USED');
    expect(document.attachments).toHaveLength(0);
    expect(result.mimeType).toContain('openxmlformats');
  });

  it('跨用户/跨组织读取他人版本：统一 NOT_FOUND，不泄露存在性', async () => {
    const otherOwner = makeQueryService();
    otherOwner.readReportOwnership.mockResolvedValue({
      reportId: REPORT_ID,
      maintenanceEngineerAccountId: OTHER_ACCOUNT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
    });
    const { usecase } = makeUsecase({ queryService: otherOwner });
    await expect(
      usecase.execute({
        session: engineerSession,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    const crossOrg = makeQueryService();
    crossOrg.readReportOwnership.mockResolvedValue({
      reportId: REPORT_ID,
      maintenanceEngineerAccountId: ACCOUNT_ID,
      ownerOrganizationId: OTHER_ORGANIZATION_ID,
    });
    const crossOrgUsecase = makeUsecase({ queryService: crossOrg });
    await expect(
      crossOrgUsecase.usecase.execute({
        session: engineerSession,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('冻结快照 schema 版本不受支持：失败关闭（DATA_INCONSISTENT），不渲染半份内容', async () => {
    const queryService = makeQueryService();
    queryService.readVersion.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 1,
      payloadSnapshot: makeVersionPayload({ schemaVersion: 1 }),
    });
    const { usecase, renderer } = makeUsecase({ queryService });
    await expect(
      usecase.execute({
        session: engineerSession,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT });
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('附件可用性复核失败：文件完整性不符 → ATTACHMENT_UNAVAILABLE，不伪称导出成功', async () => {
    const queryService = makeQueryService();
    queryService.readVersionAttachments.mockResolvedValue([
      {
        versionId: VERSION_ID,
        attachmentId: 700001,
        reportId: REPORT_ID,
        sortOrder: 1,
        descriptionSnapshot: null,
        publishFlag: false,
      },
    ]);
    queryService.readAttachmentsByIds.mockResolvedValue([
      {
        id: 700001,
        reportId: REPORT_ID,
        originalFilename: '故障照片.png',
        mimeType: 'image/png',
        byteSize: 5,
        checksumSha256: 'a'.repeat(64),
        storageBackend: 'LOCAL',
        storageReference: 'abc123.png',
        sortOrder: 1,
        description: null,
        status: 'CURRENT',
        uploadedByAccountId: ACCOUNT_ID,
        retiredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const storage = makeStorage();
    storage.verifyIntegrity.mockResolvedValue(false);
    const { usecase, renderer } = makeUsecase({ queryService, storage });
    await expect(
      usecase.execute({
        session: engineerSession,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.ATTACHMENT_UNAVAILABLE });
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('附件归属被改变（非作者登记）：导出拒绝', async () => {
    const queryService = makeQueryService();
    queryService.readVersionAttachments.mockResolvedValue([
      {
        versionId: VERSION_ID,
        attachmentId: 700002,
        reportId: REPORT_ID,
        sortOrder: 1,
        descriptionSnapshot: null,
        publishFlag: false,
      },
    ]);
    queryService.readAttachmentsByIds.mockResolvedValue([
      {
        id: 700002,
        reportId: REPORT_ID,
        originalFilename: '原件.pdf',
        mimeType: 'application/pdf',
        byteSize: 10,
        checksumSha256: null,
        storageBackend: 'LOCAL',
        storageReference: 'doc456.pdf',
        sortOrder: 1,
        description: null,
        status: 'CURRENT',
        uploadedByAccountId: OTHER_ACCOUNT_ID,
        retiredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const storage = makeStorage();
    const { usecase, renderer } = makeUsecase({ queryService, storage });
    await expect(
      usecase.execute({
        session: engineerSession,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.ATTACHMENT_UNAVAILABLE });
    expect(storage.open).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('图片附件可用：嵌入文档模型（非图片仅列元数据）', async () => {
    const queryService = makeQueryService();
    queryService.readVersionAttachments.mockResolvedValue([
      {
        versionId: VERSION_ID,
        attachmentId: 700003,
        reportId: REPORT_ID,
        sortOrder: 1,
        descriptionSnapshot: '现场照片',
        publishFlag: false,
      },
      {
        versionId: VERSION_ID,
        attachmentId: 700004,
        reportId: REPORT_ID,
        sortOrder: 2,
        descriptionSnapshot: null,
        publishFlag: false,
      },
    ]);
    queryService.readAttachmentsByIds.mockResolvedValue([
      {
        id: 700003,
        reportId: REPORT_ID,
        originalFilename: '故障照片.png',
        mimeType: 'image/png',
        byteSize: 4,
        checksumSha256: null,
        storageBackend: 'LOCAL',
        storageReference: 'img789.png',
        sortOrder: 1,
        description: null,
        status: 'CURRENT',
        uploadedByAccountId: ACCOUNT_ID,
        retiredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 700004,
        reportId: REPORT_ID,
        originalFilename: '检测报告.pdf',
        mimeType: 'application/pdf',
        byteSize: 12,
        checksumSha256: null,
        storageBackend: 'LOCAL',
        storageReference: 'doc000.pdf',
        sortOrder: 2,
        description: null,
        status: 'CURRENT',
        uploadedByAccountId: ACCOUNT_ID,
        retiredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const storage = makeStorage();
    storage.open.mockImplementation(async (reference: string) => {
      // 模拟只读流：按存储引用返回字节
      const { Readable: readableStream } = await import('node:stream');
      const bytes = reference === 'img789.png' ? Buffer.from([1, 2, 3, 4]) : Buffer.alloc(12, 7);
      return readableStream.from(bytes);
    });
    const { usecase, renderer } = makeUsecase({ queryService, storage });
    await usecase.execute({
      session: engineerSession,
      format: 'DOCX',
      savedVersion: { reportId: REPORT_ID },
    });
    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.attachments).toHaveLength(2);
    expect(document.attachments[0]?.embeddableImage?.toString('hex')).toBe('01020304');
    expect(document.attachments[1]?.embeddableImage).toBeNull();
    expect(document.attachments[0]?.description).toBe('现场照片');
  });
});

describe('ExportMaintenanceReportUsecase 权限与角色', () => {
  /** 一级/二级管理员会话（R047/R048：SAVED_VERSION 可导出正式版本） */
  const adminLevel1Session = {
    accountId: 900010,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
    adminLevel: 1,
    adminOrganizationId: null,
  } as unknown as UsecaseSession;
  const adminLevel2Session = {
    accountId: 900011,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
    adminLevel: 2,
    adminOrganizationId: ORGANIZATION_ID,
  } as unknown as UsecaseSession;

  it('二级管理员导出本公司正式版本：允许，附件按报告作者归属复核', async () => {
    const { usecase, queryService, renderer } = makeUsecase();
    const result = await usecase.execute({
      session: adminLevel2Session,
      format: 'DOCX',
      savedVersion: { reportId: REPORT_ID },
    });
    // 二级 ReadScope 二次约束只按公司过滤，不按作者过滤
    expect(queryService.readReport).toHaveBeenCalledWith(REPORT_ID, undefined, {
      ownerOrganizationId: ORGANIZATION_ID,
    });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(result.format).toBe('DOCX');
  });

  it('一级管理员跨公司导出正式版本：允许（1 级全部公司）', async () => {
    const crossOrgOwner = makeQueryService();
    crossOrgOwner.readReportOwnership.mockResolvedValue({
      reportId: REPORT_ID,
      maintenanceEngineerAccountId: OTHER_ACCOUNT_ID,
      ownerOrganizationId: OTHER_ORGANIZATION_ID,
    });
    const { usecase } = makeUsecase({ queryService: crossOrgOwner });
    await expect(
      usecase.execute({
        session: adminLevel1Session,
        format: 'PDF',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).resolves.toMatchObject({ format: 'PDF' });
  });

  it('二级管理员跨公司导出：统一 NOT_FOUND', async () => {
    const crossOrgOwner = makeQueryService();
    crossOrgOwner.readReportOwnership.mockResolvedValue({
      reportId: REPORT_ID,
      maintenanceEngineerAccountId: OTHER_ACCOUNT_ID,
      ownerOrganizationId: OTHER_ORGANIZATION_ID,
    });
    const { usecase } = makeUsecase({ queryService: crossOrgOwner });
    await expect(
      usecase.execute({
        session: adminLevel2Session,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('管理员不可读他人工作态草稿（DRAFT/RETURNED）：统一 NOT_FOUND', async () => {
    const draftReport = makeQueryService();
    draftReport.readReport.mockResolvedValue({
      id: REPORT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
      maintenanceEngineerAccountId: ACCOUNT_ID,
      currentVersionNo: 0,
      status: 'DRAFT',
    });
    const { usecase } = makeUsecase({ queryService: draftReport });
    await expect(
      usecase.execute({
        session: adminLevel2Session,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    const returnedReport = makeQueryService();
    returnedReport.readReport.mockResolvedValue({
      id: REPORT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
      maintenanceEngineerAccountId: ACCOUNT_ID,
      currentVersionNo: 1,
      status: 'RETURNED',
    });
    const returned = makeUsecase({ queryService: returnedReport });
    await expect(
      returned.usecase.execute({
        session: adminLevel1Session,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('管理员不可使用 CURRENT_FORM 导出', async () => {
    const { usecase } = makeUsecase();
    await expect(
      usecase.execute({ session: adminLevel2Session, ...currentFormInput() }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('管理员等级缺失（会话未复核 adminLevel）：失败关闭', async () => {
    const { usecase } = makeUsecase();
    const unverifiedAdmin = {
      accountId: 900012,
      roles: ['SUPER_ADMIN'],
      activeRole: 'SUPER_ADMIN',
    } as unknown as UsecaseSession;
    await expect(
      usecase.execute({
        session: unverifiedAdmin,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('二级管理员缺少可信公司归属：失败关闭', async () => {
    const { usecase } = makeUsecase();
    const orgMissingAdmin = {
      accountId: 900013,
      roles: ['SUPER_ADMIN'],
      activeRole: 'SUPER_ADMIN',
      adminLevel: 2,
      adminOrganizationId: null,
    } as unknown as UsecaseSession;
    await expect(
      usecase.execute({
        session: orgMissingAdmin,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('非工程师会话拒绝导出', async () => {
    const { usecase } = makeUsecase();
    const customerSession = {
      accountId: ACCOUNT_ID,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
    } as unknown as UsecaseSession;
    await expect(
      usecase.execute({ session: customerSession, ...currentFormInput() }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    await expect(
      usecase.execute({
        session: customerSession,
        format: 'DOCX',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('org 事实缺失（无有效成员关系）时导出拒绝', async () => {
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError('ORGANIZATION_NO_ACTIVE_MEMBERSHIP', '无有效组织成员关系'),
    );
    const { usecase } = makeUsecase({ organizationContextService });
    await expect(
      usecase.execute({ session: engineerSession, ...currentFormInput() }),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_NO_ACTIVE_MEMBERSHIP' });
  });
});

describe('ExportMaintenanceReportUsecase 冻结版本与来源工单解耦', () => {
  /** 工单总结冻结快照：多步骤 + 每步新故障 + AI 评价 + 来源原件引用 */
  const summarySnapshot = () =>
    makeVersionPayload({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: REPAIR_REQUEST_ID,
      steps: [
        {
          stepNo: 1,
          stepCode: 'STEP-1',
          phaseCode: 'PHASE_02',
          partName: '激光器',
          actionText: '重新插拔线缆',
          errorCode: 'ERR-9',
          resultText: null,
          newAlarmCode: null,
          isValidNewBranch: false,
        },
        {
          stepNo: 2,
          stepCode: 'STEP-2',
          phaseCode: 'PHASE_02',
          partName: null,
          actionText: '检查冷却回路',
          errorCode: null,
          resultText: null,
          newAlarmCode: 'A-2',
          isValidNewBranch: true,
        },
      ],
      faults: [
        {
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
        },
        {
          branchKind: 'STEP_NEW_FAULT',
          stepCode: 'STEP-2',
          phaseCode: 'PHASE_03',
          mainError: 'E-02',
          unitError: null,
          source: 'ALARM_HISTORY',
          errorType: null,
          gpibStatus: null,
          faultStatus: 'PERSISTENT',
          description: '第 2 步出现的新故障',
          action: '更换阀门',
        },
      ],
      ai: {
        usage: 'USED',
        sourceType: 'AI_CONVERSATION',
        sourceId: '123',
        sourceVersion: '2',
        score: 4,
        correctness: 'CORRECT',
        helpfulness: 3,
        note: '有帮助',
      },
      sourceWorkOrderRevisionNo: 3,
      sourceWorkOrderAttachment: {
        fileId: '11111111-1111-4111-8111-111111111111',
        originalFilename: '维修记录.pdf',
        byteSize: 2048,
      },
    });

  const makeSummaryQueryService = () => {
    const queryService = makeQueryService();
    queryService.readVersion.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 1,
      payloadSnapshot: summarySnapshot(),
    });
    return queryService;
  };

  it('报告作者导出的冻结版本：步骤报错代码、步骤新故障关联、AI 评价与来源原件引用齐全', async () => {
    const { usecase, renderer } = makeUsecase({ queryService: makeSummaryQueryService() });

    await usecase.execute({
      session: engineerSession,
      format: 'DOCX',
      savedVersion: { reportId: REPORT_ID },
    });

    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    // 预览有、导出也有的步骤字段（此前 errorCode 未进快照）
    expect(document.steps[0]?.errorCode).toBe('ERR-9');
    // 每一步对应的新故障可对应到步骤顺序号
    expect(document.faults[1]?.branchLabel).toBe('排查步骤新故障');
    expect(document.faults[1]?.stepNo).toBe(2);
    expect(document.faults[0]?.stepNo).toBeNull();
    // AI 评价来自冻结快照
    expect(document.ai).toMatchObject({
      status: 'EVALUATED',
      sourceType: 'AI_CONVERSATION',
      sourceId: '123',
      sourceVersion: '2',
      score: 4,
      helpfulness: 3,
    });
    // 来源原件只是引用元数据（不冒称内容已冻结）
    expect(document.sourceWorkOrderOriginal).toEqual({
      filename: '维修记录.pdf',
      byteSize: 2048,
    });
  });

  it('冻结版本导出不读取来源工单实时事实：工单后续被改写也不改变旧报告', async () => {
    const liveSource = {
      findRecord: jest.fn(() => {
        throw new Error('冻结版本导出不得读取来源工单实时事实');
      }),
      listSteps: jest.fn(() => {
        throw new Error('冻结版本导出不得读取来源工单实时事实');
      }),
      listFaultPanels: jest.fn(() => {
        throw new Error('冻结版本导出不得读取来源工单实时事实');
      }),
      findIntakeSource: jest.fn(() => {
        throw new Error('冻结版本导出不得读取来源工单实时事实');
      }),
    };
    const { usecase, renderer } = makeUsecase({
      queryService: makeSummaryQueryService(),
      maintenanceQueryService: liveSource,
    });

    await expect(
      usecase.execute({
        session: engineerSession,
        format: 'PDF',
        savedVersion: { reportId: REPORT_ID },
      }),
    ).resolves.toMatchObject({ format: 'PDF' });

    expect(liveSource.findRecord).not.toHaveBeenCalled();
    expect(liveSource.listSteps).not.toHaveBeenCalled();
    expect(liveSource.listFaultPanels).not.toHaveBeenCalled();
    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.steps[1]?.actionText).toBe('检查冷却回路');
    expect(document.sourceWorkOrderOriginal?.filename).toBe('维修记录.pdf');
  });

  it('管理员导出冻结版本：省略来源工单原件引用（无权按工单读取原件）', async () => {
    const adminLevel2Session = {
      accountId: 900011,
      roles: ['SUPER_ADMIN'],
      activeRole: 'SUPER_ADMIN',
      adminLevel: 2,
      adminOrganizationId: ORGANIZATION_ID,
    } as unknown as UsecaseSession;
    const { usecase, renderer } = makeUsecase({ queryService: makeSummaryQueryService() });

    await usecase.execute({
      session: adminLevel2Session,
      format: 'DOCX',
      savedVersion: { reportId: REPORT_ID },
    });

    const document = renderer.render.mock.calls[0][0] as MaintenanceReportExportDocument;
    expect(document.sourceWorkOrderOriginal).toBeNull();
    // 业务文本仍来自冻结快照
    expect(document.steps[1]?.actionText).toBe('检查冷却回路');
  });
});

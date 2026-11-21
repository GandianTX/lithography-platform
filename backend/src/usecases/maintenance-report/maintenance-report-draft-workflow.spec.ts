/// <reference types="jest" />
// src/usecases/maintenance-report/maintenance-report-draft-workflow.spec.ts
//
// 任务 06 草稿工作流：故障分支归一化、处理结果/复位口径，以及工单总结入口的
// 归属与结单服务端复核。只验证本切片行为，不覆盖正式提交、导出与模型评价。

import type { UsecaseSession } from '@app-types/auth/session.types';
import { MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetMyWorkOrderSummaryUsecase } from './get-my-work-order-summary.usecase';
import { ListMyWorkOrderSummaryCandidatesUsecase } from './list-my-work-order-summary-candidates.usecase';
import { MaintenanceReportFaultBranchKind } from '@app-types/models/maintenance-report.types';
import { normalizeMaintenanceReportDraft } from './maintenance-report.input.normalize';
import {
  buildWorkOrderSummaryFrozenPreview,
  fingerprintWorkOrderSummarySource,
  readWorkOrderSummarySourceFacts,
} from './maintenance-report-work-order-source.helpers';

const ENGINEER_SESSION: UsecaseSession = {
  accountId: 900001,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as UsecaseSession;

const baseDraft = () => ({
  customerFactoryName: '某封测厂',
  maintenanceDate: '2026-10-01',
  steps: [
    {
      stepCode: 'STEP-A',
      actionText: '检查光源模块',
      resultCode: 'RESOLVED',
      phaseCode: 'PHASE_02',
    },
  ],
});

describe('维修报告草稿归一化：故障分支与结果', () => {
  it('初始故障保留八字段并保持阶段编码原样', () => {
    const draft = normalizeMaintenanceReportDraft(
      {
        ...baseDraft(),
        faults: [
          {
            branchKind: 'INITIAL',
            phaseCode: 'PHASE_01',
            mainError: 'E001',
            unitError: 'U01',
            source: 'SRC',
            errorType: 'TYPE',
            gpibStatus: 'GPIB-0',
            faultStatus: 'ALARM',
            description: '上片失败',
            action: '复位',
          },
        ],
      },
      900001,
    );

    expect(draft.faults).toHaveLength(1);
    expect(draft.faults[0]).toMatchObject({
      branchKind: 'INITIAL',
      stepCode: null,
      phaseCode: 'PHASE_01',
      mainError: 'E001',
      description: '上片失败',
    });
    expect(draft.steps[0].resultCode).toBe('RESOLVED');
  });

  it('复位结果不是新故障时丢弃复位新故障分支', () => {
    const draft = normalizeMaintenanceReportDraft(
      {
        ...baseDraft(),
        resetResult: 'NORMAL',
        faults: [
          { branchKind: 'INITIAL', description: '初始故障', phaseCode: 'PHASE_01' },
          { branchKind: 'RESET_NEW_FAULT', description: '复位新故障' },
        ],
      },
      900001,
    );

    expect(draft.faults.map((fault) => fault.branchKind)).toEqual(['INITIAL']);
  });

  it('复位结果为新故障时保留复位分支', () => {
    const draft = normalizeMaintenanceReportDraft(
      {
        ...baseDraft(),
        resetResult: 'NEW_FAULT',
        faults: [
          { branchKind: 'INITIAL', description: '初始故障', phaseCode: 'PHASE_01' },
          { branchKind: 'RESET_NEW_FAULT', description: '复位新故障', phaseCode: 'PHASE_03' },
        ],
      },
      900001,
    );

    expect(draft.resetResult).toBe('NEW_FAULT');
    expect(draft.faults.map((fault) => fault.branchKind)).toEqual(['INITIAL', 'RESET_NEW_FAULT']);
  });

  it('步骤新故障按步骤稳定编码关联，未选新故障的步骤分支被丢弃', () => {
    const draft = normalizeMaintenanceReportDraft(
      {
        ...baseDraft(),
        steps: [
          {
            stepCode: 'STEP-A',
            actionText: '动作A',
            resultCode: 'NEW_FAULT',
            phaseCode: 'PHASE_02',
          },
          {
            stepCode: 'STEP-B',
            actionText: '动作B',
            resultCode: 'RESOLVED',
            phaseCode: 'PHASE_02',
          },
        ],
        faults: [
          { branchKind: 'INITIAL', description: '初始故障' },
          { branchKind: 'STEP_NEW_FAULT', stepNo: 1, description: '步骤1新故障' },
          { branchKind: 'STEP_NEW_FAULT', stepNo: 2, description: '失效分支' },
        ],
      },
      900001,
    );

    const stepFaults = draft.faults.filter(
      (fault) => fault.branchKind === MaintenanceReportFaultBranchKind.STEP_NEW_FAULT,
    );
    expect(stepFaults).toHaveLength(1);
    expect(stepFaults[0]).toMatchObject({ stepCode: 'STEP-A', description: '步骤1新故障' });
  });

  it('故障描述为空时拒绝保存草稿', () => {
    expect(() =>
      normalizeMaintenanceReportDraft(
        {
          ...baseDraft(),
          faults: [{ branchKind: 'INITIAL', description: '   ' }],
        },
        900001,
      ),
    ).toThrow(expect.objectContaining({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS }));
  });

  it('同一分支重复面板被拒绝', () => {
    expect(() =>
      normalizeMaintenanceReportDraft(
        {
          ...baseDraft(),
          faults: [
            { branchKind: 'INITIAL', description: '第一次' },
            { branchKind: 'INITIAL', description: '第二次' },
          ],
        },
        900001,
      ),
    ).toThrow(expect.objectContaining({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS }));
  });

  it('中断必须填写原因，填写原因后按原值保存', () => {
    expect(() =>
      normalizeMaintenanceReportDraft(
        { ...baseDraft(), handlingResult: 'INTERRUPTED', closureReason: '  ' },
        900001,
      ),
    ).toThrow(expect.objectContaining({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS }));

    const draft = normalizeMaintenanceReportDraft(
      { ...baseDraft(), handlingResult: 'INTERRUPTED', closureReason: '客户停产' },
      900001,
    );
    expect(draft.closureReason).toBe('客户停产');
  });

  it('非中断结果携带原因被拒绝，避免静默丢弃输入', () => {
    expect(() =>
      normalizeMaintenanceReportDraft(
        { ...baseDraft(), handlingResult: 'FIXED', closureReason: '多余原因' },
        900001,
      ),
    ).toThrow(expect.objectContaining({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS }));
  });

  it('处理结果与复位结果只接受固定枚举', () => {
    expect(() =>
      normalizeMaintenanceReportDraft({ ...baseDraft(), handlingResult: 'DONE' }, 900001),
    ).toThrow(expect.objectContaining({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS }));
    expect(() =>
      normalizeMaintenanceReportDraft({ ...baseDraft(), resetResult: 'UNKNOWN' }, 900001),
    ).toThrow(expect.objectContaining({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS }));
  });

  it('步骤缺少阶段时继承初始故障阶段，避免写入空阶段', () => {
    const draft = normalizeMaintenanceReportDraft(
      {
        ...baseDraft(),
        faults: [{ branchKind: 'INITIAL', description: '初始故障', phaseCode: 'PHASE_05' }],
        steps: [{ stepCode: 'STEP-A', actionText: '动作A', resultCode: 'UNRESOLVED' }],
      },
      900001,
    );

    expect(draft.steps[0].phaseCode).toBe('PHASE_05');
  });
});

describe('GetMyWorkOrderSummaryUsecase 服务端归属与结单复核', () => {
  /** 来源工单维修事实读侧替身（与生产入口同一次读取的口径） */
  const makeSourceReaders = () => {
    const maintenanceQueryService = {
      findRecord: jest.fn().mockResolvedValue({
        maintenanceDate: '2026-10-02',
        engineerName: '李工',
        resetResult: 'NORMAL',
        supplementaryNote: null,
        versionNo: 1,
        attachment: null,
      }),
      listSteps: jest.fn().mockResolvedValue([]),
      listFaultPanels: jest.fn().mockResolvedValue([]),
      findIntakeSource: jest.fn().mockResolvedValue(null),
    };
    const organizationQueryService = {
      findOrganizationNameById: jest.fn().mockResolvedValue('客户公司A'),
    };
    return { maintenanceQueryService, organizationQueryService };
  };

  const makeUsecase = (options: {
    workOrder?: Record<string, unknown> | null;
    ownership?: Record<string, unknown> | null;
    detail?: Record<string, unknown> | null;
  }) => {
    const reportService = {
      findRepairRequestWriteContext: jest.fn().mockResolvedValue(options.workOrder ?? null),
    };
    const queryService = {
      findEquipmentModelRef: jest
        .fn()
        .mockResolvedValue({ id: 300001, modelCode: 'ASML-XT', modelName: 'ASML XT 扫描机' }),
      findOwnershipByRepairRequestId: jest.fn().mockResolvedValue(options.ownership ?? null),
      readReportDetail: jest.fn().mockResolvedValue(options.detail ?? null),
      readDraftDetail: jest.fn().mockResolvedValue(null),
    };
    const organizationContextService = {
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 920001 }),
    };
    const sourceReaders = makeSourceReaders();
    const usecase = new GetMyWorkOrderSummaryUsecase(
      reportService as unknown as MaintenanceReportService,
      queryService as unknown as MaintenanceReportQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      sourceReaders.maintenanceQueryService as never,
      sourceReaders.organizationQueryService as never,
    );
    return { usecase, queryService, sourceReaders };
  };

  const acceptedClosedWorkOrder = {
    id: 955001,
    requestNo: 'RR-2026-1001',
    customerAccountId: 880001,
    equipmentModelId: 300001,
    acceptedEngineerAccountId: 900001,
    isAccepted: true,
    deprecated: false,
    ownerOrganizationId: 920001,
    closureStatus: 'CLOSED',
    closedAt: new Date('2026-10-02T00:00:00.000Z'),
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    closureReason: null,
    customerOrganizationId: 930001,
    currentRevisionNo: 1,
  };

  /** 与 makeSourceReaders 同口径的预期来源事实（预览与指纹都由它派生） */
  const expectedSourcePreview = {
    customerCompanyName: '客户公司A',
    handlingResult: 'FIXED',
    closureReason: null,
    maintenanceDate: '2026-10-02',
    engineerName: '李工',
    resetResult: 'NORMAL',
    supplementaryNote: null,
    attachment: null,
    intakeFaultDescription: null,
    intakeCustomerFile: null,
    steps: [],
    panels: [],
  };

  it('他人工单统一按不存在处理，且不读取报告内容', async () => {
    const { usecase, queryService } = makeUsecase({
      workOrder: { ...acceptedClosedWorkOrder, acceptedEngineerAccountId: 900002 },
    });

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, repairRequestId: 955001 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
    expect(queryService.findOwnershipByRepairRequestId).not.toHaveBeenCalled();
  });

  it('跨组织工单按不存在处理', async () => {
    const { usecase } = makeUsecase({
      workOrder: { ...acceptedClosedWorkOrder, ownerOrganizationId: 929999 },
    });

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, repairRequestId: 955001 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('未结单工单拒绝进入总结入口', async () => {
    const { usecase } = makeUsecase({
      workOrder: { ...acceptedClosedWorkOrder, closureStatus: 'OPEN' },
    });

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, repairRequestId: 955001 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_NOT_CLOSED });
  });

  it('尚无草稿时返回空报告，不创建任何记录', async () => {
    const { usecase, queryService, sourceReaders } = makeUsecase({
      workOrder: acceptedClosedWorkOrder,
    });

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, repairRequestId: 955001 }),
    ).resolves.toEqual({
      repairRequestId: 955001,
      requestNo: 'RR-2026-1001',
      equipmentModelId: 300001,
      equipmentModelCode: 'ASML-XT',
      equipmentModelName: 'ASML XT 扫描机',
      closedAt: new Date('2026-10-02T00:00:00.000Z'),
      sourceConfirmation: await expectSourceConfirmation(sourceReaders),
      sourcePreview: expectedSourcePreview,
      report: null,
      sourceChangedSinceDraft: false,
    });
    expect(queryService.readReportDetail).not.toHaveBeenCalled();
  });

  /** 与 makeSourceReaders 同一替身重放来源事实，得到与生产一致的指纹 */
  const expectSourceConfirmation = async (sourceReaders: ReturnType<typeof makeSourceReaders>) => {
    const facts = await readWorkOrderSummarySourceFacts({
      request: acceptedClosedWorkOrder,
      maintenanceQueryService: sourceReaders.maintenanceQueryService as never,
      organizationQueryService: sourceReaders.organizationQueryService as never,
    });
    return fingerprintWorkOrderSummarySource(facts);
  };

  it('已有草稿时按本人范围读回同一份报告', async () => {
    const { usecase, queryService, sourceReaders } = makeUsecase({
      workOrder: acceptedClosedWorkOrder,
      ownership: {
        reportId: 990001,
        maintenanceEngineerAccountId: 900001,
        ownerOrganizationId: 920001,
      },
      detail: { report: { id: 990001 } },
    });

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, repairRequestId: 955001 }),
    ).resolves.toEqual({
      repairRequestId: 955001,
      requestNo: 'RR-2026-1001',
      equipmentModelId: 300001,
      equipmentModelCode: 'ASML-XT',
      equipmentModelName: 'ASML XT 扫描机',
      closedAt: new Date('2026-10-02T00:00:00.000Z'),
      sourceConfirmation: await expectSourceConfirmation(sourceReaders),
      sourcePreview: expectedSourcePreview,
      report: { report: { id: 990001 } },
      sourceChangedSinceDraft: false,
    });
    expect(queryService.readReportDetail).toHaveBeenCalledWith(990001, undefined, {
      ownerOrganizationId: 920001,
      maintenanceEngineerAccountId: 900001,
    });
  });

  it('已正式提交后管理员修订工单：入口读取冻结版本预览，不再拼装当前工单', async () => {
    // 与生产冻结写入同键名的冻结快照（提交时以当时工单事实生成，此后不随工单变化）
    const frozenPayload: Record<string, unknown> = {
      schemaVersion: 2,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: 955001,
      title: '',
      customerFactoryName: '客户公司A',
      equipmentModelId: 300001,
      equipmentModelText: null,
      maintenanceDate: '2026-10-02',
      maintenanceEngineerAccountId: 900001,
      maintenanceEngineerName: '李工',
      phaseFlowVersion: 1,
      alarms: [],
      steps: [
        {
          stepNo: 1,
          stepCode: 'STEP-1',
          phaseCode: 'PHASE_02',
          partName: '激光器',
          actionText: '重新插拔线缆',
          resultText: null,
          newAlarmCode: null,
          isValidNewBranch: false,
          errorCode: null,
          resultCode: 'RESOLVED',
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
      ],
      handlingResult: 'FIXED',
      closureReason: null,
      resetResult: 'NORMAL',
      actualCause: null,
      repairActions: null,
      verificationResult: null,
      supplementaryNote: '已现场培训',
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
      sourceWorkOrderRevisionNo: 1,
      sourceWorkOrderAttachment: null,
      sourceWorkOrderConfirmationFingerprint: 'frozen-source-fingerprint',
      sourceWorkOrderIntakeFaultDescription: '设备上电后无法出光',
      sourceWorkOrderIntakeCustomerFile: {
        fileId: 'intake-file-1',
        originalFilename: 'intake.txt',
        byteSize: 42,
      },
    };
    const { usecase, sourceReaders } = makeUsecase({
      workOrder: acceptedClosedWorkOrder,
      ownership: {
        reportId: 990001,
        maintenanceEngineerAccountId: 900001,
        ownerOrganizationId: 920001,
      },
      detail: {
        report: { id: 990001 },
        canEdit: false,
        currentVersion: { payloadSnapshot: frozenPayload },
      },
    });
    // 管理员随后修订来源工单（同一替身实例改写返回值，模拟「当前工单已变化」）
    sourceReaders.maintenanceQueryService.findRecord.mockResolvedValue({
      maintenanceDate: '2027-01-01',
      engineerName: '改名工',
      resetResult: 'FAIL',
      supplementaryNote: '改：维修内容被修订',
      versionNo: 2,
      attachment: { fileId: 'other-file', originalFilename: 'other.txt', byteSize: 9 },
    });
    sourceReaders.maintenanceQueryService.listSteps.mockResolvedValue([
      {
        id: 'step-1',
        stepNo: 1,
        errorCode: null,
        partName: '激光器',
        actionText: '改：步骤被修订',
        resultCode: 'RESOLVED',
      },
    ]);

    const entry = await usecase.execute({ session: ENGINEER_SESSION, repairRequestId: 955001 });

    // 页面展示与提交校验标识全部来自冻结版本 payload（与 Word/PDF 导出同源）
    expect(entry.sourceConfirmation).toBe('frozen-source-fingerprint');
    expect(entry.sourcePreview).toEqual(buildWorkOrderSummaryFrozenPreview(frozenPayload, 990001));
    expect(entry.sourcePreview.steps[0]).toMatchObject({
      actionText: '重新插拔线缆',
      resultCode: 'RESOLVED',
    });
    expect(entry.sourcePreview.maintenanceDate).toBe('2026-10-02');
    expect(entry.sourcePreview.intakeFaultDescription).toBe('设备上电后无法出光');
    expect(entry.sourceChangedSinceDraft).toBe(false);
    // 冻结读取不得回读当前工单事实
    expect(sourceReaders.maintenanceQueryService.findRecord).not.toHaveBeenCalled();
    expect(sourceReaders.maintenanceQueryService.listSteps).not.toHaveBeenCalled();
    expect(sourceReaders.maintenanceQueryService.listFaultPanels).not.toHaveBeenCalled();
    expect(sourceReaders.maintenanceQueryService.findIntakeSource).not.toHaveBeenCalled();
  });

  it('非工程师角色在读取工单事实之前即被拒绝', async () => {
    const { usecase } = makeUsecase({ workOrder: acceptedClosedWorkOrder });

    await expect(
      usecase.execute({
        session: {
          accountId: 900001,
          roles: ['CUSTOMER'],
          activeRole: 'CUSTOMER',
        } as UsecaseSession,
        repairRequestId: 955001,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });
});

describe('ListMyWorkOrderSummaryCandidatesUsecase', () => {
  it('只按可信会话与组织查询候选，不接受客户端传入作者或公司', async () => {
    const queryService = {
      listWorkOrderSummaryCandidates: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      }),
    };
    const organizationContextService = {
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 920001 }),
    };
    const usecase = new ListMyWorkOrderSummaryCandidatesUsecase(
      queryService as unknown as MaintenanceReportQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    await usecase.execute({ session: ENGINEER_SESSION });

    expect(queryService.listWorkOrderSummaryCandidates).toHaveBeenCalledWith({
      engineerAccountId: 900001,
      ownerOrganizationId: 920001,
      pagination: { page: 1, pageSize: 20, withTotal: true },
    });
  });
});

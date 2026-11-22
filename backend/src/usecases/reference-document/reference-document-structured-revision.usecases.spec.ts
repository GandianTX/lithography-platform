// src/usecases/reference-document/reference-document-structured-revision.usecases.spec.ts
// 任务 07 结构化管理修订定向测试（本轮确认需求 五）：
// 一级读取现有结构化内容→修改→保存→重新读取；全部故障字段/复位三选一/步骤三选一/
// 多步骤及关联新故障；步骤排序变化后新故障仍对应正确步骤；原始冻结版本与来源工单
// 未被修改；陈旧版本/缺原因/无权字段/非法分支/中途失败安全拒绝；二级/工程师直调拒绝；
// 普通资料不转换、历史修订继承；FAULT_CASE 保护。

/// <reference types="jest" />

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { ReferenceDocumentRevisionService } from '@src/modules/lithography/reference-document-revision.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { GetReferenceDocumentEditableContentUsecase } from './get-reference-document-editable-content.usecase';
import { OfflineReferenceDocumentUsecase } from './offline-reference-document.usecase';
import { ReviseReferenceDocumentStructuredUsecase } from './revise-reference-document-structured.usecase';
import {
  REFERENCE_DOCUMENT_STRUCTURED_CONTENT_SCHEMA_VERSION,
  readRevisionStructuredContent,
} from './reference-document-structured-content';

const TX = { transaction: 'mock' };

const firstLevelSession = {
  accountId: 900001,
  roles: ['SUPER_ADMIN', 'ENGINEER'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const secondLevelSession = {
  accountId: 900002,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const engineerSession = {
  accountId: 900003,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

/** 报告来源正式资料详情夹具（ONLINE + CONFIRMED，无管理修订；自身关联 = 机型 A） */
const makeReportSourceDetail = (overrides: Record<string, unknown> = {}) => ({
  id: 970100,
  title: '光刻机 Z 轴异常处理报告',
  documentType: 'MAINTENANCE_GUIDE',
  equipmentModelId: 94,
  equipmentModelName: 'DEV-LITHO-A',
  equipmentModelText: null,
  description: '说明',
  originalFilename: null,
  mimeType: null,
  contentText: '资料自身正文（报告来源资料应为冻结拼装文本）',
  organizationName: '甲方默认组织',
  ingestMethod: 'ADMIN_DIRECT',
  sourceKind: 'INDEPENDENT_REPORT',
  sourceReportId: 960001,
  sourceReportVersionId: 990001,
  publicationStatus: 'ONLINE',
  ownershipStatus: 'CONFIRMED',
  effectiveRevisionNo: 0,
  schemaVersion: 1,
  ownerOrganizationId: 910001,
  caseDetail: null,
  storageReference: null,
  createdByAccountId: 900003,
  createdAt: new Date('2026-01-02T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
  ...overrides,
});

/** 任务 06 冻结版本快照夹具（payload_snapshot V2 含故障面板与维修结果扩展键） */
const frozenVersionFixture = {
  id: 990001,
  versionNo: 2,
  schemaVersion: 2,
  submittedAt: new Date('2026-10-01T00:00:00.000Z'),
  payloadSnapshot: {
    schemaVersion: 2,
    sourceType: 'HISTORICAL_CASE',
    repairRequestId: null,
    title: '光刻机 Z 轴异常处理报告',
    customerFactoryName: '某晶圆厂',
    equipmentModelId: 94,
    equipmentModelText: 'DEV-LITHO-A',
    equipmentModelName: 'DEV-LITHO-A',
    maintenanceDate: '2026-09-30',
    maintenanceEngineerAccountId: 900003,
    maintenanceEngineerName: '工程师甲',
    phaseFlowVersion: 1,
    alarms: [
      {
        alarmIndex: 1,
        alarmCode: '0123',
        alarmDescription: 'Z 轴超限',
        phaseCode: 'PHASE_02',
        resetResult: 'RESET_OK',
      },
    ],
    steps: [
      {
        stepNo: 1,
        stepCode: 'step-a',
        phaseCode: 'PHASE_03',
        partName: 'Z 轴电机',
        actionText: '检查电机接线',
        errorCode: 'E-100',
        resultText: null,
        newAlarmCode: null,
        isValidNewBranch: false,
        resultCode: 'RESOLVED',
      },
      {
        stepNo: 2,
        stepCode: 'step-b',
        phaseCode: 'PHASE_05',
        partName: null,
        actionText: '更换光栅尺',
        errorCode: null,
        resultText: null,
        newAlarmCode: null,
        isValidNewBranch: true,
        resultCode: 'NEW_FAULT',
      },
    ],
    faults: [
      {
        branchKind: 'INITIAL',
        stepCode: null,
        phaseCode: 'PHASE_02',
        mainError: 'Z AXIS OVER LIMIT',
        unitError: 'Z1',
        source: 'MOTION',
        errorType: 'SERVO',
        gpibStatus: 'IDLE',
        faultStatus: 'ACTIVE',
        description: 'Z 轴超限报警',
        action: '停机检查',
      },
      {
        branchKind: 'STEP_NEW_FAULT',
        stepCode: 'step-b',
        phaseCode: 'PHASE_06',
        mainError: 'GRATING ERROR',
        unitError: null,
        source: null,
        errorType: null,
        gpibStatus: null,
        faultStatus: null,
        description: '更换光栅尺后出现新故障',
        action: '重新标定',
      },
    ],
    handlingResult: 'INTERRUPTED',
    closureReason: '备件未到货',
    resetResult: 'SAME_FAULT',
    actualCause: '接线松动',
    repairActions: null,
    verificationResult: null,
    supplementaryNote: '后续跟进',
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
  },
};

/** 合法结构化修订载荷（全部故障字段 + 复位三选一 + 步骤三选一 + 多步骤 + 关联新故障） */
const validStructuredPayload = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: REFERENCE_DOCUMENT_STRUCTURED_CONTENT_SCHEMA_VERSION,
  maintenanceDate: '2026-09-30',
  maintenanceEngineerName: '工程师甲',
  customerFactoryName: '某晶圆厂（勘误）',
  resetResult: 'SAME_FAULT',
  faults: [
    {
      branchKind: 'INITIAL',
      stepCode: null,
      phaseCode: 'PHASE_02',
      mainError: 'Z AXIS OVER LIMIT（更正）',
      unitError: 'Z1',
      source: 'MOTION',
      errorType: 'SERVO',
      gpibStatus: 'IDLE',
      faultStatus: 'ACTIVE',
      description: 'Z 轴超限报警（描述更正）',
      action: '停机检查',
    },
    {
      branchKind: 'STEP_NEW_FAULT',
      stepCode: 'step-b',
      phaseCode: 'PHASE_06',
      mainError: null,
      unitError: null,
      source: null,
      errorType: null,
      gpibStatus: null,
      faultStatus: null,
      description: '更换光栅尺后出现新故障',
      action: '重新标定',
    },
  ],
  steps: [
    {
      stepCode: 'step-a',
      phaseCode: 'PHASE_03',
      errorCode: 'E-100',
      partName: 'Z 轴电机',
      actionText: '检查电机接线（更正）',
      resultCode: 'RESOLVED',
    },
    {
      stepCode: 'step-b',
      phaseCode: 'PHASE_05',
      errorCode: null,
      partName: null,
      actionText: '更换光栅尺',
      resultCode: 'NEW_FAULT',
    },
  ],
  handlingResult: 'INTERRUPTED',
  closureReason: '备件未到货（更正）',
  actualCause: '接线松动',
  repairActions: null,
  verificationResult: '上电验证通过',
  supplementaryNote: '后续跟进',
  ...overrides,
});

const makeHarness = (
  params: {
    detail?: Record<string, unknown>;
    adminLevel?: number | null;
    currentRevisionSnapshot?: Record<string, unknown> | null;
    advanceOutcome?: string;
    /**
     * 机型字典替身条目（未覆盖的 ID 默认命中「启用型号 DEV-LITHO-{id}」；
     * missing: true 表示该 ID 在字典中不存在）
     */
    modelById?: Array<
      { id: number; modelName: string; enabled: boolean } | { id: number; missing: true }
    >;
  } = {},
) => {
  const queryService = {
    findDetail: jest.fn().mockResolvedValue(makeReportSourceDetail(params.detail)),
    findRevision: jest
      .fn()
      .mockImplementation((_documentId: number, revisionNo: number) =>
        Promise.resolve(
          params.currentRevisionSnapshot !== undefined
            ? revisionNo > 0
              ? { revisionNo, afterSnapshot: params.currentRevisionSnapshot }
              : null
            : revisionNo > 0
              ? { revisionNo, afterSnapshot: { schema_version: 1, contentText: '旧扁平正文' } }
              : null,
        ),
      ),
  };
  const maintenanceReports = { readVersionById: jest.fn().mockResolvedValue(frozenVersionFixture) };
  const revisionService = {
    insertRevision: jest.fn().mockResolvedValue(undefined),
    advanceCurrentRevision: jest.fn().mockResolvedValue(params.advanceOutcome ?? 'ADVANCED'),
  };
  const accountQueryService = {
    findAdminLevelByAccountId: jest
      .fn()
      .mockResolvedValue(params.adminLevel !== undefined ? params.adminLevel : 1),
  };
  const modelTable = new Map<number, { id: number; modelName: string; enabled: boolean } | null>(
    (params.modelById ?? []).map((entry) =>
      'missing' in entry ? [entry.id, null] : [entry.id, entry],
    ),
  );
  const equipmentModels = {
    findModelById: jest.fn().mockImplementation(({ id }: { id: number }) => {
      const hit = modelTable.get(id);
      if (hit !== undefined) return Promise.resolve(hit);
      // 默认字典：任意 ID 命中「启用型号 DEV-LITHO-{id}」（测试可按需覆盖）
      return Promise.resolve({
        id,
        modelCode: `MC-${id}`,
        modelName: `DEV-LITHO-${id}`,
        enabled: true,
      });
    }),
  };
  const transactionRunner = {
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb(TX)),
  } as unknown as TransactionRunner & { run: jest.Mock };

  const editableContent = new GetReferenceDocumentEditableContentUsecase(
    queryService as unknown as ReferenceDocumentQueryService,
    maintenanceReports as unknown as MaintenanceReportQueryService,
    accountQueryService as unknown as AccountQueryService,
  );
  const reviseStructured = new ReviseReferenceDocumentStructuredUsecase(
    queryService as unknown as ReferenceDocumentQueryService,
    maintenanceReports as unknown as MaintenanceReportQueryService,
    revisionService as unknown as ReferenceDocumentRevisionService,
    accountQueryService as unknown as AccountQueryService,
    equipmentModels as never,
    transactionRunner,
  );
  const offline = new OfflineReferenceDocumentUsecase(
    queryService as unknown as ReferenceDocumentQueryService,
    maintenanceReports as unknown as MaintenanceReportQueryService,
    revisionService as unknown as ReferenceDocumentRevisionService,
    accountQueryService as unknown as AccountQueryService,
    transactionRunner,
  );

  return {
    queryService,
    maintenanceReports,
    revisionService,
    equipmentModels,
    transactionRunner,
    editableContent,
    reviseStructured,
    offline,
  };
};

describe('GetReferenceDocumentEditableContentUsecase（编辑初值读侧）', () => {
  it('报告来源无管理修订：STRUCTURED 模式，初值来自冻结版本（故障/步骤/结果/厂家继承）', async () => {
    const h = makeHarness();

    const view = await h.editableContent.execute({
      session: firstLevelSession,
      documentId: 970100,
    });

    expect(view.mode).toBe('STRUCTURED');
    expect(view.expectedVersion).toBe(0);
    expect(view.sourceKind).toBe('INDEPENDENT_REPORT');
    expect(view.faultCaseProtected).toBe(false);
    expect(view.structured).not.toBeNull();
    expect(view.structured!.customerFactoryName).toBe('某晶圆厂');
    expect(view.structured!.equipmentModelText).toBe('DEV-LITHO-A');
    expect(view.structured!.resetResult).toBe('SAME_FAULT');
    expect(view.structured!.handlingResult).toBe('INTERRUPTED');
    // 机型关联初值来自资料自身关联（改选 Select 当前值）
    expect(view.equipmentModelId).toBe(94);
    expect(view.equipmentModelName).toBe('DEV-LITHO-A');
    expect(view.structured!.faults).toHaveLength(2);
    expect(view.structured!.faults[0]).toMatchObject({
      branchKind: 'INITIAL',
      mainError: 'Z AXIS OVER LIMIT',
      faultStatus: 'ACTIVE',
    });
    expect(view.structured!.faults[1]).toMatchObject({
      branchKind: 'STEP_NEW_FAULT',
      stepCode: 'step-b',
    });
    expect(view.structured!.steps.map((step) => step.stepCode)).toEqual(['step-a', 'step-b']);
    // 只读：冻结版本读取仅查询，无任何报告写通道
    expect(h.maintenanceReports.readVersionById).toHaveBeenCalledWith(960001, 990001);
  });

  it('普通资料：FLAT 模式，返回生效正文，不伪造结构化内容', async () => {
    const h = makeHarness({
      detail: makeReportSourceDetail({
        sourceKind: 'MATERIAL',
        sourceReportId: null,
        sourceReportVersionId: null,
        contentText: '普通资料正文',
      }),
    });

    const view = await h.editableContent.execute({
      session: firstLevelSession,
      documentId: 970100,
    });

    expect(view.mode).toBe('FLAT');
    expect(view.structured).toBeNull();
    expect(view.contentText).toBe('普通资料正文');
  });

  it('生效修订携带 structuredReport：STRUCTURED 模式读修订快照', async () => {
    const structuredSnapshot = {
      schema_version: 1,
      contentText: '结构化组合文本',
      structuredReport: {
        schemaVersion: 1,
        maintenanceDate: '2026-09-30',
        maintenanceEngineerName: '工程师甲',
        customerFactoryName: '某晶圆厂',
        equipmentModelText: 'DEV-LITHO-A',
        resetResult: 'NORMAL',
        faults: [
          { branchKind: 'INITIAL', stepCode: null, phaseCode: null, description: '初始故障描述' },
        ],
        steps: [
          {
            stepCode: 'step-a',
            stepNo: 1,
            phaseCode: null,
            actionText: '检查',
            resultCode: 'RESOLVED',
          },
        ],
        handlingResult: 'FIXED',
        closureReason: null,
        actualCause: null,
        repairActions: null,
        verificationResult: null,
        supplementaryNote: null,
      },
    };
    const h = makeHarness({
      detail: makeReportSourceDetail({ effectiveRevisionNo: 1 }),
      currentRevisionSnapshot: structuredSnapshot,
    });

    const view = await h.editableContent.execute({
      session: firstLevelSession,
      documentId: 970100,
    });

    expect(view.mode).toBe('STRUCTURED');
    expect(view.expectedVersion).toBe(1);
    expect(view.structured!.resetResult).toBe('NORMAL');
    expect(view.structured!.steps).toHaveLength(1);
  });

  it('生效修订为旧扁平快照：FLAT 模式（不伪造故障数据）', async () => {
    const h = makeHarness({
      detail: makeReportSourceDetail({ effectiveRevisionNo: 1 }),
      currentRevisionSnapshot: { schema_version: 1, contentText: '旧扁平正文' },
    });

    const view = await h.editableContent.execute({
      session: firstLevelSession,
      documentId: 970100,
    });

    expect(view.mode).toBe('FLAT');
    expect(view.structured).toBeNull();
    expect(view.contentText).toBe('旧扁平正文');
  });

  it('FAULT_CASE 资料：返回保护提示（正文改写由写侧守卫拒绝）', async () => {
    const h = makeHarness({
      detail: makeReportSourceDetail({
        sourceKind: 'MATERIAL',
        sourceReportId: null,
        sourceReportVersionId: null,
        documentType: 'FAULT_CASE',
        contentText: '案例正文',
      }),
    });

    const view = await h.editableContent.execute({
      session: firstLevelSession,
      documentId: 970100,
    });

    expect(view.faultCaseProtected).toBe(true);
    expect(view.mode).toBe('FLAT');
  });

  it('二级管理员与工程师拒绝（账号等级事实复核）', async () => {
    const h = makeHarness({ adminLevel: 2 });
    await expect(
      h.editableContent.execute({ session: secondLevelSession, documentId: 970100 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    const h2 = makeHarness({ adminLevel: null });
    await expect(
      h2.editableContent.execute({ session: engineerSession, documentId: 970100 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
  });
});

describe('ReviseReferenceDocumentStructuredUsecase（结构化管理修订写侧）', () => {
  it('一级管理员完整嵌套保存：修订行前后快照 + 条件推进派生正文；重新读取读回新内容', async () => {
    const h = makeHarness();

    const result = await h.reviseStructured.execute({
      session: firstLevelSession,
      documentId: 970100,
      expectedVersion: 0,
      reason: '勘误故障描述',
      patch: { structured: validStructuredPayload() },
    });
    expect(result).toEqual({ id: 970100, revisionNo: 1 });

    expect(h.queryService.findDetail).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 970100, scope: { kind: 'GLOBAL' }, forUpdate: true }),
    );

    const inserted = h.revisionService.insertRevision.mock.calls[0][0] as {
      beforeSnapshot: string;
      afterSnapshot: string;
      reason: string;
      actorAccountId: number;
    };
    expect(inserted.reason).toBe('勘误故障描述');
    const before = JSON.parse(inserted.beforeSnapshot);
    const after = JSON.parse(inserted.afterSnapshot);
    // before 快照携带修订前结构化内容（冻结初值）
    expect(before.structuredReport).toMatchObject({
      schemaVersion: 1,
      resetResult: 'SAME_FAULT',
      customerFactoryName: '某晶圆厂',
    });
    // after 快照携带新结构化内容 + 派生正文（厂家文本按载荷生效，机型未提交保持继承）
    expect(after.structuredReport).toMatchObject({
      schemaVersion: 1,
      maintenanceDate: '2026-09-30',
      maintenanceEngineerName: '工程师甲',
      customerFactoryName: '某晶圆厂（勘误）',
      equipmentModelText: 'DEV-LITHO-A',
      resetResult: 'SAME_FAULT',
      handlingResult: 'INTERRUPTED',
      closureReason: '备件未到货（更正）',
      verificationResult: '上电验证通过',
    });
    expect(after.structuredReport.faults).toHaveLength(2);
    expect(after.structuredReport.faults[0].mainError).toBe('Z AXIS OVER LIMIT（更正）');
    expect(typeof after.contentText).toBe('string');
    expect(after.contentText).toContain('故障现象');
    expect(after.contentText).toContain('Z AXIS OVER LIMIT（更正）');
    expect(after.contentText).toContain('复位情况：SAME_FAULT');
    expect(after.contentText).toContain('排查步骤');
    expect(after.contentText).toContain('维修结果：INTERRUPTED');

    // 读回（历史版本读取口径）：结构化内容可完整解析
    const readBack = readRevisionStructuredContent(after);
    expect(readBack).not.toBeNull();
    expect(readBack!.faults).toHaveLength(2);
    expect(readBack!.steps.map((step) => step.stepCode)).toEqual(['step-a', 'step-b']);

    expect(h.revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevisionNo: 0,
        apply: expect.objectContaining({
          contentText: after.contentText,
          updatedByAccountId: 900001,
        }),
      }),
      TX,
    );
    // 原始冻结版本只读：无任何报告写调用
    expect(h.maintenanceReports.readVersionById).toHaveBeenCalledWith(960001, 990001);
  });

  it('全部故障字段 + 复位 NEW_FAULT 三选一 + 步骤 NEW_FAULT 关联面板落快照', async () => {
    const h = makeHarness();
    const payload = validStructuredPayload({
      resetResult: 'NEW_FAULT',
      faults: [
        validStructuredPayload().faults[0],
        {
          branchKind: 'RESET_NEW_FAULT',
          stepCode: null,
          phaseCode: 'PHASE_07',
          mainError: 'NEW ALARM',
          unitError: 'U2',
          source: 'ILLUMINATION',
          errorType: 'OPTICAL',
          gpibStatus: 'BUSY',
          faultStatus: 'NEW',
          description: '复位后新故障',
          action: '重新对准',
        },
        {
          branchKind: 'STEP_NEW_FAULT',
          stepCode: 'step-b',
          phaseCode: 'PHASE_06',
          mainError: null,
          unitError: null,
          source: null,
          errorType: null,
          gpibStatus: null,
          faultStatus: null,
          description: '步骤新故障',
          action: null,
        },
      ],
    });

    await h.reviseStructured.execute({
      session: firstLevelSession,
      documentId: 970100,
      expectedVersion: 0,
      reason: '补全复位新故障',
      patch: { structured: payload },
    });

    const after = JSON.parse(
      (h.revisionService.insertRevision.mock.calls[0][0] as { afterSnapshot: string })
        .afterSnapshot,
    );
    expect(after.structuredReport.faults).toHaveLength(3);
    expect(after.structuredReport.faults.map((f: { branchKind: string }) => f.branchKind)).toEqual([
      'INITIAL',
      'RESET_NEW_FAULT',
      'STEP_NEW_FAULT',
    ]);
    expect(after.structuredReport.faults[2].stepCode).toBe('step-b');
  });

  it('步骤排序变化后新故障仍对应正确步骤（按 stepCode 稳定关联，stepNo 按新顺序重排）', async () => {
    const h = makeHarness();
    const payload = validStructuredPayload({
      steps: [
        {
          stepCode: 'step-b',
          phaseCode: 'PHASE_05',
          errorCode: null,
          partName: null,
          actionText: '更换光栅尺',
          resultCode: 'NEW_FAULT',
        },
        {
          stepCode: 'step-a',
          phaseCode: 'PHASE_03',
          errorCode: 'E-100',
          partName: 'Z 轴电机',
          actionText: '检查电机接线（更正）',
          resultCode: 'RESOLVED',
        },
      ],
      faults: [
        validStructuredPayload().faults[0],
        {
          branchKind: 'STEP_NEW_FAULT',
          stepCode: 'step-b',
          phaseCode: 'PHASE_06',
          mainError: null,
          unitError: null,
          source: null,
          errorType: null,
          gpibStatus: null,
          faultStatus: null,
          description: '步骤新故障',
          action: null,
        },
      ],
    });

    await h.reviseStructured.execute({
      session: firstLevelSession,
      documentId: 970100,
      expectedVersion: 0,
      reason: '调整步骤顺序',
      patch: { structured: payload },
    });

    const after = JSON.parse(
      (h.revisionService.insertRevision.mock.calls[0][0] as { afterSnapshot: string })
        .afterSnapshot,
    );
    const steps = after.structuredReport.steps as Array<{ stepCode: string; stepNo: number }>;
    expect(steps[0]).toMatchObject({ stepCode: 'step-b', stepNo: 1 });
    expect(steps[1]).toMatchObject({ stepCode: 'step-a', stepNo: 2 });
    // 新故障面板仍关联原步骤编码，不串到别的步骤
    const stepFault = (after.structuredReport.faults as Array<Record<string, unknown>>).find(
      (fault) => fault.branchKind === 'STEP_NEW_FAULT',
    );
    expect(stepFault!.stepCode).toBe('step-b');
  });

  it('陈旧 expected_version 拒绝（VERSION_CONFLICT）：不写修订行、不推进', async () => {
    const h = makeHarness({ detail: makeReportSourceDetail({ effectiveRevisionNo: 5 }) });

    await expect(
      h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 0,
        reason: 'r',
        patch: { structured: validStructuredPayload() },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT });
    expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('条件推进未命中（并发竞态）：VERSION_CONFLICT，修订行随事务回滚', async () => {
    const h = makeHarness({ advanceOutcome: 'VERSION_CONFLICT' });

    await expect(
      h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 0,
        reason: 'r',
        patch: { structured: validStructuredPayload() },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT });
    expect(h.revisionService.insertRevision).toHaveBeenCalledTimes(1);
    expect(h.revisionService.advanceCurrentRevision).toHaveBeenCalledTimes(1);
  });

  it('缺原因 / 空补丁 / 非法分支 / 非法枚举 / 重复步骤编码 / 关联缺失步骤均拒绝', async () => {
    const call = (
      h: ReturnType<typeof makeHarness>,
      patch: Record<string, unknown>,
      reason = 'r',
    ) =>
      h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 0,
        reason,
        patch: patch,
      });

    // 缺原因
    const h1 = makeHarness();
    await expect(call(h1, { structured: validStructuredPayload() }, '   ')).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
    });
    // 空补丁
    await expect(call(h1, {})).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
    });

    // 复位非新故障携带复位面板
    const h2 = makeHarness();
    await expect(
      call(h2, {
        structured: validStructuredPayload({
          faults: [
            ...validStructuredPayload().faults,
            { branchKind: 'RESET_NEW_FAULT', stepCode: null, description: '多余面板' },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    // 复位 NEW_FAULT 缺面板
    const h3 = makeHarness();
    await expect(
      call(h3, { structured: validStructuredPayload({ resetResult: 'NEW_FAULT' }) }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    // 步骤 RESOLVED 携带步骤面板
    const h4 = makeHarness();
    await expect(
      call(h4, {
        structured: validStructuredPayload({
          faults: [
            ...validStructuredPayload().faults,
            { branchKind: 'STEP_NEW_FAULT', stepCode: 'step-a', description: '多余面板' },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    // 步骤 NEW_FAULT 缺面板
    const h5 = makeHarness();
    await expect(
      call(h5, {
        structured: validStructuredPayload({
          faults: [validStructuredPayload().faults[0]],
        }),
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    // 重复步骤编码
    const h6 = makeHarness();
    const duplicated = validStructuredPayload();
    duplicated.steps = [...duplicated.steps];
    await expect(
      call(h6, {
        structured: validStructuredPayload({
          steps: [duplicated.steps[0], { ...duplicated.steps[1], stepCode: 'step-a' }],
        }),
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    // 非法复位取值
    const h7 = makeHarness();
    await expect(
      call(h7, { structured: validStructuredPayload({ resetResult: 'NOT_A_VALUE' }) }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    // 维修结果与中断原因互斥（非中断结果不允许带原因）
    const h8 = makeHarness();
    await expect(
      call(h8, {
        structured: validStructuredPayload({ handlingResult: 'FIXED', closureReason: '不应有' }),
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    // 中断结果缺原因
    const h9 = makeHarness();
    await expect(
      call(h9, {
        structured: validStructuredPayload({ handlingResult: 'INTERRUPTED', closureReason: null }),
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    expect(h1.revisionService.insertRevision).not.toHaveBeenCalled();
    expect(h9.revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('机型文字不信任客户端提交：载荷夹带的 equipmentModelText 被忽略，厂家文本按白名单生效', async () => {
    const h = makeHarness();
    const payload = validStructuredPayload({
      equipmentModelText: '伪造机型',
    });

    await h.reviseStructured.execute({
      session: firstLevelSession,
      documentId: 970100,
      expectedVersion: 0,
      reason: 'r',
      patch: { structured: payload },
    });

    const after = JSON.parse(
      (h.revisionService.insertRevision.mock.calls[0][0] as { afterSnapshot: string })
        .afterSnapshot,
    );
    // 机型名称只来自服务端字典或继承来源，不来自客户端载荷
    expect(after.structuredReport.equipmentModelText).toBe('DEV-LITHO-A');
    // 厂家文本在本轮白名单内，按载荷生效
    expect(after.structuredReport.customerFactoryName).toBe('某晶圆厂（勘误）');
  });

  describe('厂家与机型修改（本轮确认需求）', () => {
    it('单改厂家（机型未提交）：快照厂家更新、机型文字继承、apply 不含机型键', async () => {
      const h = makeHarness();
      const payload = validStructuredPayload({ customerFactoryName: '更名后的新厂家' });

      await h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 0,
        reason: '更正客户厂家名称',
        patch: { structured: payload },
      });

      const after = JSON.parse(
        (h.revisionService.insertRevision.mock.calls[0][0] as { afterSnapshot: string })
          .afterSnapshot,
      );
      expect(after.structuredReport.customerFactoryName).toBe('更名后的新厂家');
      expect(after.structuredReport.equipmentModelText).toBe('DEV-LITHO-A');
      expect(after.contentText).toContain('客户厂家：更名后的新厂家');
      const apply = (
        h.revisionService.advanceCurrentRevision.mock.calls[0][0] as {
          apply: Record<string, unknown>;
        }
      ).apply;
      expect(apply.equipmentModelId).toBeUndefined();
      // 未查字典（历史机型停用不阻塞只改厂家）
      expect(h.equipmentModels.findModelById).not.toHaveBeenCalled();
    });

    it('A→B 改选：apply 携带 B、快照保存 B 的选中名称、派生正文随新厂家与机型', async () => {
      const h = makeHarness({
        modelById: [{ id: 95, modelName: 'DEV-LITHO-B', enabled: true }],
      });
      const payload = validStructuredPayload({ customerFactoryName: 'B 厂客户' });

      await h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 0,
        reason: '更正机型与厂家',
        patch: { structured: payload, equipmentModelId: 95 },
      });

      const inserted = h.revisionService.insertRevision.mock.calls[0][0] as {
        beforeSnapshot: string;
        afterSnapshot: string;
      };
      const before = JSON.parse(inserted.beforeSnapshot);
      const after = JSON.parse(inserted.afterSnapshot);
      // before 保留修订前事实（机型 A / 原厂家）
      expect(before.structuredReport.equipmentModelText).toBe('DEV-LITHO-A');
      expect(before.structuredReport.customerFactoryName).toBe('某晶圆厂');
      // after 保存 B 的选中名称与修订后厂家
      expect(after.structuredReport.equipmentModelText).toBe('DEV-LITHO-B');
      expect(after.structuredReport.customerFactoryName).toBe('B 厂客户');
      expect(after.contentText).toContain('适用机型：DEV-LITHO-B');
      expect(after.contentText).toContain('客户厂家：B 厂客户');
      // 事务内按 B 的 ID 重新校验字典
      expect(h.equipmentModels.findModelById).toHaveBeenCalledWith(
        expect.objectContaining({ id: 95, transactionContext: TX }),
      );
      // 条件推进携带机型关联变更（修订服务同语句清空互斥手填文字）
      const apply = (
        h.revisionService.advanceCurrentRevision.mock.calls[0][0] as {
          apply: Record<string, unknown>;
        }
      ).apply;
      expect(apply.equipmentModelId).toBe(95);
    });

    it('未改机型（提交 ID 等于现有关联）：按未改处理，保留原名称快照，不查字典', async () => {
      const h = makeHarness();
      await h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 0,
        reason: 'r',
        patch: { structured: validStructuredPayload(), equipmentModelId: 94 },
      });

      const after = JSON.parse(
        (h.revisionService.insertRevision.mock.calls[0][0] as { afterSnapshot: string })
          .afterSnapshot,
      );
      expect(after.structuredReport.equipmentModelText).toBe('DEV-LITHO-A');
      const apply = (
        h.revisionService.advanceCurrentRevision.mock.calls[0][0] as {
          apply: Record<string, unknown>;
        }
      ).apply;
      expect(apply.equipmentModelId).toBeUndefined();
      expect(h.equipmentModels.findModelById).not.toHaveBeenCalled();
    });

    it('显式清空机型（null）：拒绝，不写修订行', async () => {
      const h = makeHarness();
      await expect(
        h.reviseStructured.execute({
          session: firstLevelSession,
          documentId: 970100,
          expectedVersion: 0,
          reason: 'r',
          patch: { structured: validStructuredPayload(), equipmentModelId: null },
        }),
      ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
      expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
    });

    it('不存在的机型：EQUIPMENT_MODEL_NOT_FOUND，不写修订行、不推进', async () => {
      const h = makeHarness({ modelById: [{ id: 95, missing: true }] });
      await expect(
        h.reviseStructured.execute({
          session: firstLevelSession,
          documentId: 970100,
          expectedVersion: 0,
          reason: 'r',
          patch: { structured: validStructuredPayload(), equipmentModelId: 95 },
        }),
      ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND });
      expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
      expect(h.revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
    });

    it('停用的机型：EQUIPMENT_MODEL_DISABLED 明确报错，不静默忽略', async () => {
      const h = makeHarness({
        modelById: [{ id: 95, modelName: 'DEV-LITHO-B', enabled: false }],
      });
      await expect(
        h.reviseStructured.execute({
          session: firstLevelSession,
          documentId: 970100,
          expectedVersion: 0,
          reason: 'r',
          patch: { structured: validStructuredPayload(), equipmentModelId: 95 },
        }),
      ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_DISABLED });
      expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
    });

    it('厂家文本为空：按报告字段规则拒绝', async () => {
      const h = makeHarness();
      await expect(
        h.reviseStructured.execute({
          session: firstLevelSession,
          documentId: 970100,
          expectedVersion: 0,
          reason: 'r',
          patch: { structured: validStructuredPayload({ customerFactoryName: '   ' }) },
        }),
      ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
      await expect(
        h.reviseStructured.execute({
          session: firstLevelSession,
          documentId: 970100,
          expectedVersion: 0,
          reason: 'r',
          patch: { structured: validStructuredPayload({ customerFactoryName: null }) },
        }),
      ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
      expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
    });
  });

  it('普通资料不得转换为结构化内容（INVALID_PARAMS）', async () => {
    const h = makeHarness({
      detail: makeReportSourceDetail({
        sourceKind: 'MATERIAL',
        sourceReportId: null,
        sourceReportVersionId: null,
        contentText: '普通资料正文',
      }),
    });

    await expect(
      h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 0,
        reason: 'r',
        patch: { structured: validStructuredPayload() },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('旧扁平修订的资料不得转换为结构化内容（不静默丢弃既有正文）', async () => {
    const h = makeHarness({
      detail: makeReportSourceDetail({ effectiveRevisionNo: 1 }),
      currentRevisionSnapshot: { schema_version: 1, contentText: '旧扁平正文' },
    });

    await expect(
      h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 1,
        reason: 'r',
        patch: { structured: validStructuredPayload() },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('FAULT_CASE 资料：结构化修订拒绝（案例更正专属通道）', async () => {
    const h = makeHarness({
      detail: makeReportSourceDetail({
        documentType: 'FAULT_CASE',
        effectiveRevisionNo: 1,
      }),
      currentRevisionSnapshot: {
        schema_version: 1,
        contentText: '案例正文',
        structuredReport: {
          schemaVersion: 1,
          maintenanceDate: '2026-09-30',
          maintenanceEngineerName: '工程师甲',
          customerFactoryName: '某晶圆厂',
          equipmentModelText: null,
          resetResult: 'NORMAL',
          faults: [],
          steps: [
            { stepCode: 's1', stepNo: 1, phaseCode: null, actionText: 'x', resultCode: 'RESOLVED' },
          ],
          handlingResult: null,
          closureReason: null,
          actualCause: null,
          repairActions: null,
          verificationResult: null,
          supplementaryNote: null,
        },
      },
    });

    await expect(
      h.reviseStructured.execute({
        session: firstLevelSession,
        documentId: 970100,
        expectedVersion: 1,
        reason: 'r',
        patch: { structured: validStructuredPayload() },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('二级管理员与工程师直调写接口拒绝', async () => {
    const h = makeHarness({ adminLevel: 2 });
    await expect(
      h.reviseStructured.execute({
        session: secondLevelSession,
        documentId: 970100,
        expectedVersion: 0,
        reason: 'r',
        patch: { structured: validStructuredPayload() },
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    const h2 = makeHarness({ adminLevel: null });
    await expect(
      h2.reviseStructured.execute({
        session: engineerSession,
        documentId: 970100,
        expectedVersion: 0,
        reason: 'r',
        patch: { structured: validStructuredPayload() },
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(h2.revisionService.insertRevision).not.toHaveBeenCalled();
  });
});

describe('结构化快照继承（状态/归属修订不回退结构化正文）', () => {
  it('下架修订：after 快照继承当前生效 structuredReport', async () => {
    const structuredSnapshot = {
      schema_version: 1,
      contentText: '结构化组合文本',
      structuredReport: {
        schemaVersion: 1,
        maintenanceDate: '2026-09-30',
        maintenanceEngineerName: '工程师甲',
        customerFactoryName: '某晶圆厂',
        equipmentModelText: 'DEV-LITHO-A',
        resetResult: 'NORMAL',
        faults: [
          { branchKind: 'INITIAL', stepCode: null, phaseCode: null, description: '初始故障描述' },
        ],
        steps: [
          {
            stepCode: 'step-a',
            stepNo: 1,
            phaseCode: null,
            actionText: '检查',
            resultCode: 'RESOLVED',
          },
        ],
        handlingResult: 'FIXED',
        closureReason: null,
        actualCause: null,
        repairActions: null,
        verificationResult: null,
        supplementaryNote: null,
      },
    };
    const h = makeHarness({
      detail: makeReportSourceDetail({ effectiveRevisionNo: 1 }),
      currentRevisionSnapshot: structuredSnapshot,
    });

    await h.offline.execute({
      session: firstLevelSession,
      documentId: 970100,
      expectedVersion: 1,
      reason: '下架',
    });

    const after = JSON.parse(
      (h.revisionService.insertRevision.mock.calls[0][0] as { afterSnapshot: string })
        .afterSnapshot,
    );
    expect(after.publicationStatus).toBe('OFFLINE');
    expect(after.structuredReport).toMatchObject({ schemaVersion: 1, resetResult: 'NORMAL' });
  });
});

describe('领域错误形态', () => {
  it('权限拒绝为 DomainError（INSUFFICIENT_PERMISSIONS）', async () => {
    const h = makeHarness({ adminLevel: 2 });
    await expect(
      h.editableContent.execute({ session: secondLevelSession, documentId: 970100 }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

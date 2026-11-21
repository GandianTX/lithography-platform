// src/features/maintenance-report/model/report-form.spec.ts
//
// 任务 06 表单模型：只验证字段适配与有效分支口径，不触达网络。

import { describe, expect, it } from 'vitest';

import type { MaintenanceReportDetail } from '../infrastructure/maintenance-report.types';

import {
  collectReportFormIssues,
  createEmptyReportForm,
  toReportDraftInput,
  toReportFormFromDetail,
} from './report-form';

const DETAIL: MaintenanceReportDetail = {
  report: {
    id: 990001,
    sourceType: 'WORK_ORDER_SUMMARY',
    repairRequestId: 955001,
    status: 'DRAFT',
    title: null,
    customerFactoryName: '某封测厂',
    equipmentModelId: 300001,
    equipmentModelText: null,
    maintenanceDate: '2026-10-02',
    engineerName: '李工',
    handlingResult: 'FIXED',
    closureReason: null,
    resetResult: 'NEW_FAULT',
    actualCause: '光源老化',
    repairActions: '更换光源',
    verificationResult: '连续运行 8 小时正常',
    supplementaryNote: '备件已入库',
    currentVersionNo: 0,
    updatedAt: '2026-10-03T00:00:00.000Z',
    aiUsage: 'NOT_USED',
    aiSourceType: null,
    aiSourceId: null,
    aiSourceVersion: null,
    aiScore: null,
    aiCorrectness: null,
    aiHelpfulness: null,
    aiNote: null,
  },
  steps: [
    {
      id: 11,
      stepNo: 1,
      stepCode: 'STEP-A',
      partName: '光源',
      actionText: '检查光源模块',
      resultCode: 'NEW_FAULT',
      errorCode: 'E001',
      resultText: null,
    },
  ],
  faults: [
    {
      id: 'f1',
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
    },
    {
      id: 'f2',
      branchKind: 'STEP_NEW_FAULT',
      stepCode: 'STEP-A',
      phaseCode: 'PHASE_02',
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
  attachments: [],
  frozenEquipmentModelName: null,
  canEdit: true,
};

describe('维修报告表单模型', () => {
  // 2026-11-21 机型冻结语义：不可编辑报告优先使用冻结快照中的机型显示名；
  // 旧快照缺键（null）回落实时解析；可编辑草稿不注入冻结名。
  it('冻结视图：注入快照冻结的机型显示名', () => {
    const form = toReportFormFromDetail({
      ...DETAIL,
      frozenEquipmentModelName: '机型A-提交当时名',
      canEdit: false,
    });
    expect(form.frozenEquipmentModelName).toBe('机型A-提交当时名');
  });

  it('旧快照缺键：冻结名回退 null，预览沿用实时解析', () => {
    const form = toReportFormFromDetail({
      ...DETAIL,
      frozenEquipmentModelName: null,
      canEdit: false,
    });
    expect(form.frozenEquipmentModelName).toBeNull();
  });

  it('可编辑草稿：不注入冻结名（预览保持实时解析）', () => {
    const form = toReportFormFromDetail({
      ...DETAIL,
      frozenEquipmentModelName: '机型A-提交当时名',
      canEdit: true,
    });
    expect(form.frozenEquipmentModelName).toBeNull();
  });

  it('新建空白报告不预填维修日期，结果与型号保持空值', () => {
    const form = createEmptyReportForm('李工');

    expect(form.editor.maintenanceDate).toBe('');
    expect(form.editor.engineerName).toBe('李工');
    expect(form.equipmentModelId).toBeNull();
    expect(form.handlingResult).toBe('');
    expect(toReportDraftInput(form).maintenanceDate).toBeNull();
  });

  it('读模型恢复：步骤稳定编码保留，步骤新故障按编码绑定回原步骤', () => {
    const form = toReportFormFromDetail(DETAIL);

    expect(form.editor.steps).toHaveLength(1);
    expect(form.editor.steps[0]?.stepCode).toBe('STEP-A');
    const stepPanel = form.editor.panels.find((panel) => panel.panelType === 'STEP_NEW_FAULT');
    expect(stepPanel?.stepKey).toBe(form.editor.steps[0]?.key);

    const draft = toReportDraftInput(form);
    expect(draft.faults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchKind: 'STEP_NEW_FAULT',
          stepNo: 1,
          description: '步骤新故障',
        }),
      ]),
    );
    expect(draft.steps?.[0]).toMatchObject({
      stepCode: 'STEP-A',
      resultCode: 'NEW_FAULT',
      errorCode: 'E001',
    });
    expect(draft.resetResult).toBe('NEW_FAULT');
  });

  it('复位结果不是新故障时，保留的复位分支不进入草稿输入', () => {
    const form = toReportFormFromDetail(DETAIL);
    const withRetainedReset = {
      ...form,
      editor: {
        ...form.editor,
        resetResult: 'NORMAL' as const,
        panels: [
          ...form.editor.panels,
          {
            key: 'reset:local',
            id: null,
            panelType: 'RESET_NEW_FAULT' as const,
            stepKey: null,
            phaseCode: 'PHASE_03' as const,
            mainError: '',
            unitError: '',
            source: '',
            errorType: '',
            gpibStatus: '',
            faultStatus: '',
            description: '切走后仍保留的复位故障',
            action: '',
          },
        ],
      },
    };

    const draft = toReportDraftInput(withRetainedReset);
    expect(draft.faults?.some((fault) => fault.branchKind === 'RESET_NEW_FAULT')).toBe(false);
  });

  it('步骤调序不改变步骤稳定编码与其新故障的指向', () => {
    const form = toReportFormFromDetail(DETAIL);
    const first = form.editor.steps[0];
    if (first === undefined) throw new Error('missing step');
    const reordered = {
      ...form,
      editor: {
        ...form.editor,
        steps: [
          { ...first, stepCode: 'STEP-A' },
          {
            ...first,
            key: 'step:local:2',
            id: null,
            stepCode: 'STEP-B',
            actionText: '第二个动作',
            resultCode: '' as const,
          },
        ],
      },
    };

    const draft = toReportDraftInput(reordered);
    expect(draft.steps?.map((step) => step.stepCode)).toEqual(['STEP-A', 'STEP-B']);
    expect(draft.faults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branchKind: 'STEP_NEW_FAULT', stepNo: 1 }),
      ]),
    );
  });

  it('手填型号只写入报告自身字段，不产生型号库写入能力', () => {
    const form = { ...createEmptyReportForm('李工'), equipmentModelText: '手填 XT-2000' };
    const draft = toReportDraftInput(form);

    expect(draft.equipmentModelText).toBe('手填 XT-2000');
    expect(draft.equipmentModelId).toBeNull();
    expect(Object.keys(draft)).not.toContain('createEquipmentModel');
  });

  it('中断/无法修复缺少原因时阻塞，其他结果携带原因也阻塞', () => {
    const interrupted = {
      ...createEmptyReportForm('李工'),
      handlingResult: 'INTERRUPTED' as const,
    };
    expect(collectReportFormIssues(interrupted).map((issue) => issue.kind)).toContain(
      'closureReasonRequired',
    );

    const fixedWithReason = {
      ...createEmptyReportForm('李工'),
      handlingResult: 'FIXED' as const,
      closureReason: '不应填写',
    };
    expect(collectReportFormIssues(fixedWithReason).map((issue) => issue.kind)).toContain(
      'closureReasonNotAllowed',
    );
  });

  it('补充说明超过 10000 字符时报告超长问题', () => {
    const form = createEmptyReportForm('李工');
    form.editor.supplementaryNote = '补'.repeat(10001);

    const issues = collectReportFormIssues(form);
    expect(issues).toEqual(
      expect.arrayContaining([{ kind: 'tooLong', field: 'supplementaryNote', limit: 10000 }]),
    );
  });

  it('无 AI 参与：草稿输入不携带 AI 使用事实，页面不要求勾选 AI 确认', () => {
    const form = createEmptyReportForm('李工');
    expect('aiUsage' in toReportDraftInput(form)).toBe(false);
  });
});

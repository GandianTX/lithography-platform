// src/features/maintenance-report/model/report-form.ts
//
// 任务 06 报告表单模型：复用任务 04 编辑器的值模型与纯函数，只做字段适配。
// 不直接调用任务 04 的工单保存接口，也不读写工单维修数据表。

import {
  createMaintenanceEditorValue,
  type MaintenanceEditorValue,
  type MaintenancePanelValue,
  toMaintenancePanelPayloads,
  toMaintenanceStepPayloads,
} from '@/shared/ui/maintenance-record-editor/model';

import type {
  MaintenanceReportDetail,
  ReportFaultBranchKind,
  ReportHandlingResult,
  ReportStepResult,
} from '../infrastructure/maintenance-report.types';
import type { DraftPayload } from '../infrastructure/maintenance-report-adapter';

export const REPORT_HANDLING_RESULTS = [
  'FIXED',
  'PART_PURCHASED',
  'PROVIDE_PLAN_SELF_EXECUTE',
  'INTERRUPTED',
  'UNREPAIRABLE',
] as const;

/** 中断/无法修复时必须填写原因，与后端库级约束同口径 */
export const CLOSURE_REASON_REQUIRED_RESULTS: readonly ReportHandlingResult[] = [
  'INTERRUPTED',
  'UNREPAIRABLE',
];

export const REPORT_TEXT_LIMITS = {
  customerFactoryName: 200,
  equipmentModelText: 100,
  actualCause: 2000,
  repairActions: 10000,
  verificationResult: 2000,
  supplementaryNote: 10000,
  closureReason: 10000,
} as const;

export type MaintenanceReportForm = {
  editor: MaintenanceEditorValue;
  customerFactoryName: string;
  equipmentModelId: number | null;
  equipmentModelText: string;
  /**
   * 机型冻结语义：冻结版本快照中的机型显示名（仅不可编辑报告由服务端
   * 冻结快照注入；可编辑草稿恒为 null，预览沿用实时解析）。
   */
  frozenEquipmentModelName: string | null;
  handlingResult: ReportHandlingResult | '';
  closureReason: string;
  actualCause: string;
  repairActions: string;
  verificationResult: string;
};

export type ReportFormIssueKind = 'closureReasonRequired' | 'closureReasonNotAllowed' | 'tooLong';

export type ReportFormIssue = {
  kind: ReportFormIssueKind;
  // AI 评价 note 长度问题待任务 05 联调接入后再加入 field 联合
  field: keyof typeof REPORT_TEXT_LIMITS | 'handlingResult';
  limit?: number;
};

/** 新建空白报告：不默认填写日期，机型与结果保持空值 */
export function createEmptyReportForm(engineerName: string): MaintenanceReportForm {
  return {
    editor: createMaintenanceEditorValue({ engineerName }),
    customerFactoryName: '',
    equipmentModelId: null,
    equipmentModelText: '',
    frozenEquipmentModelName: null,
    handlingResult: '',
    closureReason: '',
    actualCause: '',
    repairActions: '',
    verificationResult: '',
  };
}

/**
 * 从服务端读模型恢复表单：故障分支通过步骤稳定编码重新绑定到步骤。
 * 只恢复当前有效分支；历史失效分支不入库，因此不会出现。
 */
export function toReportFormFromDetail(detail: MaintenanceReportDetail): MaintenanceReportForm {
  const stepIdByCode = new Map(detail.steps.map((step) => [step.stepCode, String(step.id)]));
  const editor = createMaintenanceEditorValue({
    maintenanceDate: detail.report.maintenanceDate,
    engineerName: detail.report.engineerName,
    resetResult: detail.report.resetResult,
    supplementaryNote: detail.report.supplementaryNote,
    steps: detail.steps.map((step) => ({
      id: String(step.id),
      stepNo: step.stepNo,
      stepCode: step.stepCode,
      errorCode: step.errorCode,
      partName: step.partName,
      actionText: step.actionText,
      resultCode: step.resultCode ?? '',
    })),
    panels: detail.faults.map((fault) => ({
      id: fault.id,
      panelType: fault.branchKind,
      stepId:
        fault.branchKind === 'STEP_NEW_FAULT' && fault.stepCode !== null
          ? (stepIdByCode.get(fault.stepCode) ?? null)
          : null,
      phaseCode: fault.phaseCode,
      mainError: fault.mainError,
      unitError: fault.unitError,
      source: fault.source,
      errorType: fault.errorType,
      gpibStatus: fault.gpibStatus,
      faultStatus: fault.faultStatus,
      description: fault.description,
      action: fault.action,
    })),
    attachment: null,
  });

  return {
    editor,
    customerFactoryName: detail.report.customerFactoryName ?? '',
    equipmentModelId: detail.report.equipmentModelId,
    equipmentModelText: detail.report.equipmentModelText ?? '',
    // 机型冻结语义：不可编辑报告优先使用冻结快照中的机型显示名；
    // 旧快照缺键为 null（预览回落实时解析，如实回退）。
    frozenEquipmentModelName:
      !detail.canEdit && detail.frozenEquipmentModelName ? detail.frozenEquipmentModelName : null,
    handlingResult: detail.report.handlingResult ?? '',
    closureReason: detail.report.closureReason ?? '',
    actualCause: detail.report.actualCause ?? '',
    repairActions: detail.report.repairActions ?? '',
    verificationResult: detail.report.verificationResult ?? '',
  };
}

/**
 * 表单 → 草稿输入。
 *
 * - 步骤与故障只取编辑器当前有效分支（collectEffectivePanels 语义）；
 * - 步骤携带稳定编码，故障以步骤顺序号引用，保证调序后仍指向原步骤；
 * - 机型手填只写入报告自身的 equipmentModelText，不登记型号库。
 */
export function toReportDraftInput(form: MaintenanceReportForm): DraftPayload {
  const stepPayloads = toMaintenanceStepPayloads(form.editor);
  const panelPayloads = toMaintenancePanelPayloads(form.editor);

  return {
    customerFactoryName: normalizeNullable(form.customerFactoryName),
    equipmentModelId: form.equipmentModelId,
    equipmentModelText: normalizeNullable(form.equipmentModelText),
    maintenanceDate: normalizeNullable(form.editor.maintenanceDate),
    handlingResult: form.handlingResult === '' ? null : form.handlingResult,
    closureReason: normalizeNullable(form.closureReason),
    resetResult: form.editor.resetResult === '' ? null : form.editor.resetResult,
    actualCause: normalizeNullable(form.actualCause),
    repairActions: normalizeNullable(form.repairActions),
    verificationResult: normalizeNullable(form.verificationResult),
    supplementaryNote: normalizeNullable(form.editor.supplementaryNote),
    steps: stepPayloads.map((step, index) => ({
      stepCode: form.editor.steps[index]?.stepCode ?? null,
      partName: step.partName,
      actionText: step.actionText,
      resultCode: (step.resultCode === '' ? null : step.resultCode) as ReportStepResult | null,
      errorCode: step.errorCode,
      resultText: null,
    })),
    faults: panelPayloads.map((panel) => ({
      branchKind: panel.panelType,
      stepNo: panel.stepNo,
      phaseCode: panel.phaseCode,
      mainError: panel.mainError,
      unitError: panel.unitError,
      source: panel.source,
      errorType: panel.errorType,
      gpibStatus: panel.gpibStatus,
      faultStatus: panel.faultStatus,
      description: panel.description,
      action: panel.action,
    })),
  };
}

/** 客户端可提前发现的阻塞问题：中断原因、字段超长 */
export function collectReportFormIssues(form: MaintenanceReportForm): ReportFormIssue[] {
  const issues: ReportFormIssue[] = [];
  const reasonRequired =
    form.handlingResult !== '' && CLOSURE_REASON_REQUIRED_RESULTS.includes(form.handlingResult);
  const hasReason = form.closureReason.trim().length > 0;

  if (reasonRequired && !hasReason) {
    issues.push({ kind: 'closureReasonRequired', field: 'handlingResult' });
  }
  if (!reasonRequired && hasReason) {
    issues.push({ kind: 'closureReasonNotAllowed', field: 'closureReason' });
  }

  const textEntries: Array<[ReportFormIssue['field'], string, number]> = [
    ['customerFactoryName', form.customerFactoryName, REPORT_TEXT_LIMITS.customerFactoryName],
    ['equipmentModelText', form.equipmentModelText, REPORT_TEXT_LIMITS.equipmentModelText],
    ['actualCause', form.actualCause, REPORT_TEXT_LIMITS.actualCause],
    ['repairActions', form.repairActions, REPORT_TEXT_LIMITS.repairActions],
    ['verificationResult', form.verificationResult, REPORT_TEXT_LIMITS.verificationResult],
    ['supplementaryNote', form.editor.supplementaryNote, REPORT_TEXT_LIMITS.supplementaryNote],
  ];
  for (const [field, value, limit] of textEntries) {
    if (value.length > limit) {
      issues.push({ kind: 'tooLong', field, limit });
    }
  }
  return issues;
}

/** 表单序列化快照：用于脏检查（不依赖对象引用） */
export function serializeReportForm(form: MaintenanceReportForm): string {
  return JSON.stringify(toReportDraftInput(form));
}

/** 初始故障面板（预览与基本信息带出使用） */
export function findInitialPanel(form: MaintenanceReportForm): MaintenancePanelValue | undefined {
  return form.editor.panels.find((panel) => panel.panelType === 'INITIAL');
}

/** 分支显示名所需的键（i18n 在 UI 层解析） */
export function faultBranchLabelKey(branchKind: ReportFaultBranchKind): string {
  if (branchKind === 'INITIAL') return 'maintenance.initialFault';
  if (branchKind === 'RESET_NEW_FAULT') return 'maintenance.resetNewFault';
  return 'maintenance.stepNewFault';
}

function normalizeNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

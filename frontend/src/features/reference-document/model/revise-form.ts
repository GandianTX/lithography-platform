// src/features/reference-document/model/revise-form.ts
//
// 任务 07 管理修订表单模型（独立管理修订页）：复用任务 04 编辑器值模型与纯函数，
// 只做字段适配。不调用任务 04/06 的工单或报告保存接口，不读写工单维修数据表。
//
// - 结构化模式初值 = 当前生效结构化内容（步骤以 stepCode 为稳定 id，
//   故障面板按 stepCode 重新绑定步骤，调序不换关联）；
// - 提交载荷为全量值语义；客户厂家/机型文字不在白名单（后端恒继承生效来源）；
// - 校验与后端 normalizeStructuredRevisionContent 同口径（前端提示先行，
//   最终以后端裁决为准）。

import type { MessageKey, Translate } from '@/shared/i18n';
import {
  collectEffectivePanels,
  createMaintenanceEditorValue,
  findResetPanel,
  findStepPanel,
  hasMaintenancePanelContent,
  type MaintenanceEditorValue,
  validateMaintenanceEditorValue,
} from '@/shared/ui/maintenance-record-editor/model';

import type {
  ReferenceDocumentEditableContent,
  ReferenceDocumentStructuredContent,
  ReferenceDocumentStructuredRevisionPayload,
} from '../infrastructure/reference-document.types';

/** 中断/无法修复时必须填写原因，与任务 06 报告表单和后端口径一致 */
export const REVISE_CLOSURE_REASON_REQUIRED_RESULTS: readonly string[] = [
  'INTERRUPTED',
  'UNREPAIRABLE',
];

export const REVISE_TEXT_LIMITS = {
  actualCause: 2000,
  repairActions: 10000,
  verificationResult: 2000,
  closureReason: 10000,
  reason: 500,
} as const;

export const REVISE_HANDLING_RESULT_OPTIONS: ReadonlyArray<{
  value: string;
  messageKey: MessageKey;
}> = [
  { value: 'FIXED', messageKey: 'refDocDetail.handlingResult.FIXED' },
  { value: 'PART_PURCHASED', messageKey: 'refDocDetail.handlingResult.PART_PURCHASED' },
  {
    value: 'PROVIDE_PLAN_SELF_EXECUTE',
    messageKey: 'refDocDetail.handlingResult.PROVIDE_PLAN_SELF_EXECUTE',
  },
  { value: 'INTERRUPTED', messageKey: 'refDocDetail.handlingResult.INTERRUPTED' },
  { value: 'UNREPAIRABLE', messageKey: 'refDocDetail.handlingResult.UNREPAIRABLE' },
];

/** 结构化管理修订表单（编辑器 + 维修结果字段 + 资料形态字段 + 机型改选） */
export type ReferenceDocumentReviseForm = {
  title: string;
  description: string;
  /** 客户厂家文本（本轮确认需求：可修订，必填） */
  customerFactoryName: string;
  editor: MaintenanceEditorValue;
  handlingResult: string;
  closureReason: string;
  actualCause: string;
  repairActions: string;
  verificationResult: string;
  /** 机型关联当前值（初值 = 资料自身关联；改选后为新 ID） */
  equipmentModelId: number | null;
};

/** 扁平管理修订表单（普通资料 / 旧扁平修订） */
export type ReferenceDocumentFlatReviseForm = {
  title: string;
  description: string;
  contentText: string;
};

/**
 * 结构化初值 → 编辑器值：步骤以 stepCode 为稳定 id（服务端绑定键），
 * 故障面板按 stepCode 重新绑定步骤；失效分支面板不入库，因此不会出现。
 */
export function createReviseEditorValue(
  structured: ReferenceDocumentStructuredContent,
): MaintenanceEditorValue {
  return createMaintenanceEditorValue({
    maintenanceDate: structured.maintenanceDate,
    engineerName: structured.maintenanceEngineerName,
    resetResult: structured.resetResult,
    supplementaryNote: structured.supplementaryNote ?? '',
    steps: structured.steps.map((step) => ({
      id: step.stepCode,
      stepNo: step.stepNo,
      stepCode: step.stepCode,
      phaseCode: step.phaseCode,
      errorCode: step.errorCode,
      partName: step.partName,
      actionText: step.actionText,
      resultCode: step.resultCode,
    })),
    panels: structured.faults.map((fault) => ({
      id: `panel:${fault.branchKind}:${fault.stepCode ?? 'base'}`,
      panelType: fault.branchKind,
      stepId: fault.branchKind === 'STEP_NEW_FAULT' ? fault.stepCode : null,
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
}

export function createReviseFormFromEditableContent(
  content: ReferenceDocumentEditableContent,
): ReferenceDocumentReviseForm {
  const structured = content.structured;
  if (structured === null) {
    throw new Error('structured editable content missing');
  }
  return {
    title: content.title,
    description: content.description ?? '',
    customerFactoryName: structured.customerFactoryName,
    editor: createReviseEditorValue(structured),
    handlingResult: structured.handlingResult ?? '',
    closureReason: structured.closureReason ?? '',
    actualCause: structured.actualCause ?? '',
    repairActions: structured.repairActions ?? '',
    verificationResult: structured.verificationResult ?? '',
    // 机型关联初值取资料自身关联（冻结文字仅作展示追溯，不作为 Select 当前值）
    equipmentModelId: content.equipmentModelId,
  };
}

export function createFlatReviseFormFromEditableContent(
  content: ReferenceDocumentEditableContent,
): ReferenceDocumentFlatReviseForm {
  return {
    title: content.title,
    description: content.description ?? '',
    contentText: content.contentText ?? '',
  };
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 编辑器值 → 结构化提交载荷（全量值语义；只取当前有效分支，稳定编码关联） */
export function toStructuredRevisePayload(
  form: ReferenceDocumentReviseForm,
): ReferenceDocumentStructuredRevisionPayload {
  const { editor } = form;
  const stepCodeByKey = new Map(editor.steps.map((step) => [step.key, step.stepCode]));
  const faults = collectEffectivePanels(editor).map((panel) => ({
    branchKind: panel.panelType,
    stepCode:
      panel.panelType === 'STEP_NEW_FAULT'
        ? (stepCodeByKey.get(panel.stepKey ?? '') ?? null)
        : null,
    phaseCode: panel.phaseCode === '' ? null : panel.phaseCode,
    mainError: nullableText(panel.mainError),
    unitError: nullableText(panel.unitError),
    source: nullableText(panel.source),
    errorType: nullableText(panel.errorType),
    gpibStatus: nullableText(panel.gpibStatus),
    faultStatus: nullableText(panel.faultStatus),
    description: panel.description.trim(),
    action: nullableText(panel.action),
  }));
  const steps = editor.steps.map((step) => ({
    // 后端按数组序自动生成 stepNo（index+1），提交载荷不得携带该字段
    // （input ReferenceDocumentStructuredStepInput 无 stepNo，多传会被
    // GraphQL 变量校验以 BAD_USER_INPUT 拒绝）。
    stepCode: step.stepCode,
    phaseCode: step.phaseCode === '' ? null : step.phaseCode,
    errorCode: nullableText(step.errorCode),
    partName: nullableText(step.partName),
    actionText: step.actionText.trim(),
    resultCode: step.resultCode === '' ? 'UNRESOLVED' : step.resultCode,
  }));

  return {
    schemaVersion: 1,
    maintenanceDate: editor.maintenanceDate.trim(),
    maintenanceEngineerName: editor.engineerName.trim(),
    customerFactoryName: form.customerFactoryName.trim(),
    resetResult: editor.resetResult === '' ? 'NORMAL' : editor.resetResult,
    faults,
    steps,
    handlingResult: form.handlingResult === '' ? null : form.handlingResult,
    closureReason: nullableText(form.closureReason),
    actualCause: nullableText(form.actualCause),
    repairActions: nullableText(form.repairActions),
    verificationResult: nullableText(form.verificationResult),
    supplementaryNote: nullableText(editor.supplementaryNote),
  };
}

/**
 * 客户端可提前发现的阻塞问题（与后端严格规范化同口径，前端提示先行）：
 * 编辑器校验 + 分支完整性 + 维修结果一致性 + 字段超长 + 必填语义。
 */
export function collectReviseIssues(form: ReferenceDocumentReviseForm, t: Translate): string[] {
  const issues: string[] = [...validateMaintenanceEditorValue(form.editor, t)];

  if (form.customerFactoryName.trim() === '') {
    issues.push(t('refDocRevise.issue.factoryRequired'));
  }
  if (form.editor.maintenanceDate.trim() === '') {
    issues.push(t('refDocRevise.issue.dateRequired'));
  }
  if (form.editor.engineerName.trim() === '') {
    issues.push(t('refDocRevise.issue.engineerRequired'));
  }
  if (form.editor.resetResult === '') {
    issues.push(t('refDocRevise.issue.resetRequired'));
  }
  if (form.editor.steps.length === 0) {
    issues.push(t('refDocRevise.issue.stepRequired'));
  }

  // 分支完整性：NEW_FAULT 分支面板必须已填写（空面板不进入提交，后端会拒绝）
  for (const [index, step] of form.editor.steps.entries()) {
    if (step.resultCode !== 'NEW_FAULT') {
      continue;
    }
    const panel = findStepPanel(form.editor, step.key);
    if (panel === undefined || !hasMaintenancePanelContent(panel)) {
      issues.push(t('refDocRevise.issue.stepPanelRequired', { index: index + 1 }));
    }
  }
  if (form.editor.resetResult === 'NEW_FAULT') {
    const resetPanel = findResetPanel(form.editor);
    if (resetPanel === undefined || !hasMaintenancePanelContent(resetPanel)) {
      issues.push(t('refDocRevise.issue.resetPanelRequired'));
    }
  }

  // 维修结果一致性：中断/无法修复必须带原因；其余结果不允许带原因
  const reasonRequired =
    form.handlingResult !== '' &&
    REVISE_CLOSURE_REASON_REQUIRED_RESULTS.includes(form.handlingResult);
  const hasReason = form.closureReason.trim().length > 0;
  if (form.handlingResult === '') {
    // 与任务 06 表单一致：维修结果可空（历史资料可能未填写）
  } else if (reasonRequired && !hasReason) {
    issues.push(t('refDocRevise.issue.reasonRequiredForClosure'));
  } else if (!reasonRequired && hasReason) {
    issues.push(t('refDocRevise.issue.reasonNotAllowed'));
  }

  const textEntries: Array<[string, string, number]> = [
    [t('refDocDetail.field.actualCause'), form.actualCause, REVISE_TEXT_LIMITS.actualCause],
    [t('refDocDetail.field.repairActions'), form.repairActions, REVISE_TEXT_LIMITS.repairActions],
    [
      t('refDocDetail.field.verificationResult'),
      form.verificationResult,
      REVISE_TEXT_LIMITS.verificationResult,
    ],
    [t('refDocDetail.field.closureReason'), form.closureReason, REVISE_TEXT_LIMITS.closureReason],
  ];
  for (const [label, value, limit] of textEntries) {
    if (value.length > limit) {
      issues.push(t('refDocRevise.issue.textTooLong', { label, limit }));
    }
  }
  return issues;
}

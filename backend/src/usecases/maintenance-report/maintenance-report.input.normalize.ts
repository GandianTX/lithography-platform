// src/usecases/maintenance-report/maintenance-report.input.normalize.ts

import {
  AnalysisOutputGenerationStatus,
  MaintenanceAiCorrectness,
  MaintenanceAiUsage,
  MaintenanceAlarmResetResult,
  MaintenancePhaseCode,
  MaintenanceReportFaultBranchKind,
  MaintenanceReportResetResult,
  MaintenanceReportSourceType,
  MaintenanceReportStepResult,
} from '@app-types/models/maintenance-report.types';
import { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type {
  MaintenanceReportAlarmWriteData,
  MaintenanceReportDraftWriteData,
  MaintenanceReportFaultWriteData,
  MaintenanceReportStepWriteData,
} from '@src/modules/lithography/maintenance-report.types';
import type {
  MaintenanceReportAlarmInput,
  MaintenanceReportDraftInput,
  MaintenanceReportFaultInput,
  MaintenanceReportStepInput,
} from './maintenance-report-command.types';

/** 长度上限以页面需求 V6.5 §8.1—8.3 为准（表头 ≤200、补充 ≤10000、动作 ≤10000） */
const TITLE_MAX = 200;
const FACTORY_MAX = 200;
const MODEL_TEXT_MAX = 100;
const ACTUAL_CAUSE_MAX = 2000;
const REPAIR_ACTIONS_MAX = 10000;
const VERIFICATION_MAX = 2000;
const SUPPLEMENTARY_MAX = 10000;
const CLOSURE_REASON_MAX = 10000;
const ALARM_CODE_MAX = 100;
const ALARM_DESC_MAX = 500;
const STEP_CODE_MAX = 64;
const STEP_PART_MAX = 300;
const STEP_ACTION_MAX = 10000;
const STEP_ERROR_CODE_MAX = 300;
const STEP_RESULT_MAX = 2000;
const STEP_MAX = 100;
const FAULT_SMALL_TEXT_MAX = 300;
const FAULT_DESCRIPTION_MAX = 10000;
const FAULT_ACTION_MAX = 10000;
const AI_SOURCE_TYPE_MAX = 64;
const AI_SOURCE_ID_MAX = 128;
const AI_SOURCE_VERSION_MAX = 64;
const AI_NOTE_MAX = 2000;

const PHASE_SET = new Set<string>(Object.values(MaintenancePhaseCode));
const RESET_SET = new Set<string>(Object.values(MaintenanceAlarmResetResult));
const REPORT_RESET_SET = new Set<string>(Object.values(MaintenanceReportResetResult));
const STEP_RESULT_SET = new Set<string>(Object.values(MaintenanceReportStepResult));
const FAULT_BRANCH_SET = new Set<string>(Object.values(MaintenanceReportFaultBranchKind));
const CORRECTNESS_SET = new Set<string>(Object.values(MaintenanceAiCorrectness));
const AI_USAGE_SET = new Set<string>(Object.values(MaintenanceAiUsage));
const SOURCE_TYPE_SET = new Set<string>(Object.values(MaintenanceReportSourceType));
const HANDLING_RESULT_SET = new Set<string>(Object.values(RepairRequestHandlingResult));

/** 评分区间：库内与读取保持 1-5；帮助程度新输入收紧到 1-4，历史 5 只允许原样保留 */
const AI_RATING_MIN = 1;
const AI_SCORE_MAX = 5;
const AI_HELPFULNESS_MAX = 4;

/** 更新已有草稿时的归一化选项 */
export interface MaintenanceReportDraftNormalizeOptions {
  /**
   * 库内既有的帮助程度值：仅当本次输入未显式改写该字段时传入，
   * 用于允许 31 态历史值 5 原样保留；新输入仍只能是 1-4。
   */
  readonly preservedAiHelpfulness?: number | null;
  /**
   * 结单原因口径（2026-11-21 修复）：工单总结派生链路传 true，复用结单侧
   * （任务 04）规则——非终结结果（故障修复/购买新部件/提供方案自行执行）
   * 原因可填可不填，已有原因原样保留。缺省 false 保持独立历史记录表单
   * 既有规则：仅终结结果（中断/无法修复）可携带原因。
   */
  readonly allowNonTerminalClosureReason?: boolean;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, message, details);
}

function normalizeOptionalText(
  value: string | null | undefined,
  maxLength: number,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    invalid(`${fieldName}不能超过 ${maxLength} 个字符`, { fieldName, length: trimmed.length });
  }
  return trimmed;
}

/** 归一化必填/非空文本：去首尾空白（usecases 内禁止裸 trim 的唯一出口） */
export function trimRequiredText(value: string): string {
  return value.trim();
}

/** 归一化可空文本：去首尾空白；空白归 null */
export function trimOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeSourceType(value: string): MaintenanceReportSourceType {
  if (!SOURCE_TYPE_SET.has(value)) {
    invalid('维修报告来源无效', { sourceType: value });
  }
  return value as MaintenanceReportSourceType;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    invalid('维修日期必须为 YYYY-MM-DD 格式', { maintenanceDate: value });
  }
  const [year, month, day] = trimmed.split('-').map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    invalid('维修日期不是有效日期', { maintenanceDate: value });
  }
  return trimmed;
}

function normalizeAlarms(input: MaintenanceReportAlarmInput[] | undefined) {
  if (!input || input.length === 0) return [] as MaintenanceReportAlarmWriteData[];
  if (input.length > 8) {
    invalid('报警项最多 8 项', { count: input.length });
  }
  const indexes = new Set<number>();
  return input.map((alarm) => {
    if (!Number.isInteger(alarm.alarmIndex) || alarm.alarmIndex < 1 || alarm.alarmIndex > 8) {
      invalid('报警槽位必须为 1-8', { alarmIndex: alarm.alarmIndex });
    }
    if (indexes.has(alarm.alarmIndex)) {
      invalid('报警槽位重复', { alarmIndex: alarm.alarmIndex });
    }
    indexes.add(alarm.alarmIndex);
    const alarmCode = alarm.alarmCode?.trim() ?? '';
    if (alarmCode.length === 0 || alarmCode.length > ALARM_CODE_MAX) {
      invalid('报警代码不能为空且不能超过 100 个字符', { alarmIndex: alarm.alarmIndex });
    }
    if (!PHASE_SET.has(alarm.phaseCode)) {
      invalid('报警阶段编码无效', { phaseCode: alarm.phaseCode });
    }
    if (!RESET_SET.has(alarm.resetResult)) {
      invalid('复位结果无效', { resetResult: alarm.resetResult });
    }
    return {
      alarmIndex: alarm.alarmIndex,
      alarmCode,
      alarmDescription: normalizeOptionalText(alarm.alarmDescription, ALARM_DESC_MAX, '报警说明'),
      phaseCode: alarm.phaseCode as MaintenancePhaseCode,
      resetResult: alarm.resetResult as MaintenanceAlarmResetResult,
    };
  });
}

function normalizeSteps(
  input: MaintenanceReportStepInput[] | undefined,
  fallbackPhaseCode: string | null,
): MaintenanceReportStepWriteData[] {
  if (!input || input.length === 0) return [] as MaintenanceReportStepWriteData[];
  if (input.length > STEP_MAX) {
    invalid(`排查步骤最多 ${STEP_MAX} 条`, { count: input.length });
  }
  // V6.5 §8.3 步骤字段不含流程阶段，而库中 phase_code 非空：
  // 尚未提供时继承初始故障阶段，仍无则用 PHASE_01 兜底，避免写入空阶段。
  const phaseFallback =
    fallbackPhaseCode !== null && PHASE_SET.has(fallbackPhaseCode)
      ? (fallbackPhaseCode as MaintenancePhaseCode)
      : MaintenancePhaseCode.PHASE_01;
  const codes = new Set<string>();
  return input.map((step, index) => {
    const stepCode = step.stepCode?.trim() || `STEP-${index + 1}`;
    if (stepCode.length > STEP_CODE_MAX) {
      invalid('步骤编码不能超过 64 个字符', { stepIndex: index + 1 });
    }
    if (codes.has(stepCode)) {
      invalid('步骤编码重复', { stepCode });
    }
    codes.add(stepCode);
    if (
      step.phaseCode !== undefined &&
      step.phaseCode !== null &&
      step.phaseCode !== '' &&
      !PHASE_SET.has(step.phaseCode)
    ) {
      invalid('步骤阶段编码无效', { phaseCode: step.phaseCode });
    }
    const phaseCode =
      step.phaseCode !== undefined &&
      step.phaseCode !== null &&
      step.phaseCode !== '' &&
      PHASE_SET.has(step.phaseCode)
        ? (step.phaseCode as MaintenancePhaseCode)
        : phaseFallback;
    const actionText = step.actionText?.trim() ?? '';
    if (actionText.length === 0) {
      invalid('步骤动作不能为空', { stepIndex: index + 1 });
    }
    if (actionText.length > STEP_ACTION_MAX) {
      invalid(`步骤动作不能超过 ${STEP_ACTION_MAX} 个字符`, {
        stepCode,
        length: actionText.length,
      });
    }
    const resultCode = normalizeStepResult(step.resultCode);
    const newAlarmCode = normalizeOptionalText(step.newAlarmCode, ALARM_CODE_MAX, '新报警代码');
    const isValidNewBranch = step.isValidNewBranch === true;
    if (isValidNewBranch && newAlarmCode === null) {
      invalid('有效新故障分支必须填写新报警代码', { stepCode });
    }
    return {
      stepNo: index + 1,
      stepCode,
      phaseCode,
      partName: normalizeOptionalText(step.partName, STEP_PART_MAX, '零件/部位'),
      actionText,
      resultCode,
      errorCode: normalizeOptionalText(step.errorCode, STEP_ERROR_CODE_MAX, '步骤报错代码'),
      resultText: normalizeOptionalText(step.resultText, STEP_RESULT_MAX, '步骤结果'),
      newAlarmCode,
      isValidNewBranch,
    };
  });
}

function normalizeStepResult(value: string | null | undefined): MaintenanceReportStepResult | null {
  if (value === null || value === undefined || value === '') return null;
  if (!STEP_RESULT_SET.has(value)) {
    invalid('步骤结果取值无效', { resultCode: value });
  }
  return value as MaintenanceReportStepResult;
}

/** 报告根复位结果：未选择/草稿半填时为 null */
export function normalizeReportResetResult(
  value: string | null | undefined,
): MaintenanceReportResetResult | null {
  if (value === null || value === undefined || value === '') return null;
  if (!REPORT_RESET_SET.has(value)) {
    invalid('复位结果取值无效', { resetResult: value });
  }
  return value as MaintenanceReportResetResult;
}

/** 报告处理结果：五项固定枚举；草稿可暂不选择 */
export function normalizeReportHandlingResult(
  value: string | null | undefined,
): RepairRequestHandlingResult | null {
  if (value === null || value === undefined || value === '') return null;
  return normalizeHandlingResult(value);
}

/**
 * 报告侧结单原因归一。
 *
 * 中断/无法修复必须填写非空原因（与库级 CHECK 同口径）；非终结结果默认不得
 * 携带原因（独立历史记录表单既有规则），工单总结派生链路传 allowNonTerminal
 * 复用结单侧（任务 04）规则：原因可填可不填，已有原因原样保留、不清空不丢弃。
 */
function normalizeReportClosureReason(
  handlingResult: RepairRequestHandlingResult | null,
  value: string | null | undefined,
  allowNonTerminal: boolean,
): string | null {
  const trimmed = normalizeOptionalText(value, CLOSURE_REASON_MAX, '中断/无法修复原因');
  if (
    handlingResult === RepairRequestHandlingResult.INTERRUPTED ||
    handlingResult === RepairRequestHandlingResult.UNREPAIRABLE
  ) {
    if (trimmed === null) {
      invalid('中断或无法修复必须填写原因', { handlingResult });
    }
    return trimmed;
  }
  if (trimmed !== null && !allowNonTerminal) {
    invalid('仅中断或无法修复结果可填写原因', { handlingResult });
  }
  return trimmed;
}

function normalizeFaultPhaseCode(value: string | null | undefined): MaintenancePhaseCode | null {
  if (value === null || value === undefined || value === '') return null;
  if (!PHASE_SET.has(value)) {
    invalid('故障阶段编码无效', { phaseCode: value });
  }
  return value as MaintenancePhaseCode;
}

/**
 * 故障分支归一化。
 *
 * 只保留当前有效分支（初始故障、复位结果=新故障时的复位故障、步骤结果=新故障时的步骤故障）；
 * 失效分支由前端保留在本地草稿中供切回，但不会进入本次落库内容。
 */
function normalizeFaults(
  input: MaintenanceReportFaultInput[] | undefined,
  steps: MaintenanceReportStepWriteData[],
  resetResult: MaintenanceReportResetResult | null,
): MaintenanceReportFaultWriteData[] {
  if (!input || input.length === 0) return [];
  const stepCodeByNo = new Map(steps.map((step) => [step.stepNo, step.stepCode]));
  const newFaultStepNo = new Set(
    steps
      .filter((step) => step.resultCode === MaintenanceReportStepResult.NEW_FAULT)
      .map((s) => s.stepNo),
  );
  const seen = new Set<string>();
  const faults: MaintenanceReportFaultWriteData[] = [];

  for (const fault of input) {
    if (!FAULT_BRANCH_SET.has(fault.branchKind)) {
      invalid('故障分支类型无效', { branchKind: fault.branchKind });
    }
    const branchKind = fault.branchKind as MaintenanceReportFaultBranchKind;
    if (branchKind === MaintenanceReportFaultBranchKind.RESET_NEW_FAULT) {
      if (resetResult !== MaintenanceReportResetResult.NEW_FAULT) continue;
    }
    let stepCode: string | null = null;
    if (branchKind === MaintenanceReportFaultBranchKind.STEP_NEW_FAULT) {
      const stepNo = fault.stepNo ?? null;
      if (stepNo === null || !newFaultStepNo.has(stepNo)) continue;
      stepCode = stepCodeByNo.get(stepNo) ?? null;
      if (stepCode === null) continue;
    }
    const dedupeKey = `${branchKind}:${stepCode ?? ''}`;
    if (seen.has(dedupeKey)) {
      invalid('同一分支只能填写一份故障面板', { branchKind, stepCode });
    }
    seen.add(dedupeKey);

    const description = normalizeOptionalText(fault.description, FAULT_DESCRIPTION_MAX, '故障描述');
    if (description === null) {
      invalid('故障描述不能为空', { branchKind });
    }
    faults.push({
      branchKind,
      stepCode,
      phaseCode: normalizeFaultPhaseCode(fault.phaseCode),
      mainError: normalizeOptionalText(fault.mainError, FAULT_SMALL_TEXT_MAX, 'Main Error'),
      unitError: normalizeOptionalText(fault.unitError, FAULT_SMALL_TEXT_MAX, 'Unit Error'),
      source: normalizeOptionalText(fault.source, FAULT_SMALL_TEXT_MAX, 'Source'),
      errorType: normalizeOptionalText(fault.errorType, FAULT_SMALL_TEXT_MAX, 'Error Type'),
      gpibStatus: normalizeOptionalText(fault.gpibStatus, FAULT_SMALL_TEXT_MAX, 'GPIB Status'),
      faultStatus: normalizeOptionalText(fault.faultStatus, FAULT_SMALL_TEXT_MAX, 'Status'),
      description,
      action: normalizeOptionalText(fault.action, FAULT_ACTION_MAX, '故障处理动作'),
    });
  }
  return faults;
}

/** 初始故障阶段：步骤缺少阶段时的继承来源 */
function readInitialFaultPhaseCode(
  input: MaintenanceReportFaultInput[] | undefined,
): string | null {
  const initial = (input ?? []).find(
    (fault) => fault.branchKind === (MaintenanceReportFaultBranchKind.INITIAL as string),
  );
  return initial?.phaseCode && PHASE_SET.has(initial.phaseCode) ? initial.phaseCode : null;
}

type AiEvaluationWriteData = Pick<
  MaintenanceReportDraftWriteData,
  | 'aiUsage'
  | 'aiSourceType'
  | 'aiSourceId'
  | 'aiSourceVersion'
  | 'aiScore'
  | 'aiCorrectness'
  | 'aiHelpfulness'
  | 'aiNote'
>;

function isProvided<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function isRating(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= AI_RATING_MIN && value <= max;
}

/** 帮助程度：新输入 1-4；仅与库内既有值相同且该值本身合法时才允许保留 5 */
function isHelpfulness(value: number, preserved: number | null): boolean {
  if (isRating(value, AI_HELPFULNESS_MAX)) return true;
  return preserved !== null && value === preserved && isRating(value, AI_SCORE_MAX);
}

/** AI 使用标记：缺省视为未使用；非法值直接拒绝（先按字符串集合校验，再收窄类型） */
function normalizeAiUsageFlag(value: string | undefined): MaintenanceAiUsage {
  const usageValue = value ?? MaintenanceAiUsage.NOT_USED;
  if (!AI_USAGE_SET.has(usageValue)) {
    invalid('AI 使用标记无效', { aiUsage: usageValue });
  }
  return usageValue as MaintenanceAiUsage;
}

/** 是否填写了任何评价内容（用于“未使用 AI”时的互斥校验） */
function hasAiEvaluationInput(input: MaintenanceReportDraftInput): boolean {
  return (
    isProvided(input.aiScore) ||
    isProvided(input.aiCorrectness) ||
    isProvided(input.aiHelpfulness) ||
    (typeof input.aiNote === 'string' && input.aiNote.trim().length > 0)
  );
}

/** 已使用 AI 时的分析结果引用：来源、稳定标识、不可变版本三者缺一不可 */
function normalizeAiSourceReference(
  input: MaintenanceReportDraftInput,
): Pick<AiEvaluationWriteData, 'aiSourceType' | 'aiSourceId' | 'aiSourceVersion'> {
  const aiSourceType = normalizeOptionalText(
    input.aiSourceType,
    AI_SOURCE_TYPE_MAX,
    '分析结果来源',
  );
  const aiSourceId = normalizeOptionalText(input.aiSourceId, AI_SOURCE_ID_MAX, '分析结果标识');
  const aiSourceVersion = normalizeOptionalText(
    input.aiSourceVersion,
    AI_SOURCE_VERSION_MAX,
    '分析结果版本',
  );
  if (!aiSourceType || !aiSourceId || !aiSourceVersion) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REFERENCE_REQUIRED,
      '已使用 AI 时必须提供分析结果来源、稳定标识与不可变版本',
    );
  }
  return { aiSourceType, aiSourceId, aiSourceVersion };
}

/** 评价取值校验：评分 1-5，帮助程度新输入 1-4（历史 5 仅原样保留），正确性为枚举值 */
function validateAiEvaluationInput(
  input: MaintenanceReportDraftInput,
  preservedAiHelpfulness: number | null,
): void {
  if (isProvided(input.aiScore) && !isRating(input.aiScore, AI_SCORE_MAX)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID, 'AI 评分必须为 1-5');
  }
  if (
    isProvided(input.aiHelpfulness) &&
    !isHelpfulness(input.aiHelpfulness, preservedAiHelpfulness)
  ) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
      'AI 帮助程度新输入必须为 1-4；历史值 5 仅可原样保留',
    );
  }
  if (isProvided(input.aiCorrectness) && !CORRECTNESS_SET.has(input.aiCorrectness)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID, 'AI 正确性取值无效');
  }
}

function normalizeAiCorrectnessValue(
  value: string | null | undefined,
): MaintenanceAiCorrectness | null {
  if (!isProvided(value)) return null;
  if (!CORRECTNESS_SET.has(value)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID, 'AI 正确性取值无效');
  }
  return value as MaintenanceAiCorrectness;
}

function normalizeAiEvaluation(
  input: MaintenanceReportDraftInput,
  preservedAiHelpfulness: number | null,
): AiEvaluationWriteData {
  const usage = normalizeAiUsageFlag(input.aiUsage);

  if (usage === MaintenanceAiUsage.NOT_USED) {
    if (hasAiEvaluationInput(input)) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.AI_EVALUATION_NOT_APPLICABLE,
        '未使用 AI 时不能填写评价、评分或正确性',
      );
    }
    return {
      aiUsage: usage,
      aiSourceType: null,
      aiSourceId: null,
      aiSourceVersion: null,
      aiScore: null,
      aiCorrectness: null,
      aiHelpfulness: null,
      aiNote: null,
    };
  }

  const sourceReference = normalizeAiSourceReference(input);
  validateAiEvaluationInput(input, preservedAiHelpfulness);

  return {
    aiUsage: usage,
    ...sourceReference,
    aiScore: input.aiScore ?? null,
    aiCorrectness: normalizeAiCorrectnessValue(input.aiCorrectness),
    aiHelpfulness: input.aiHelpfulness ?? null,
    aiNote: normalizeOptionalText(input.aiNote, AI_NOTE_MAX, 'AI 评价'),
  };
}

/**
 * 归一化草稿/提交输入。
 *
 * 上传入口与内部调用共用同一套约束，长度与枚举判定在用例层执行，不依赖 GraphQL DTO。
 * 步骤顺序以输入数组顺序为准，服务端重新赋 `stepNo = index + 1`；`stepCode` 保持不变，
 * 从而重排不串值。
 */
export function normalizeMaintenanceReportDraft(
  input: MaintenanceReportDraftInput,
  updatedByAccountId: number,
  options: MaintenanceReportDraftNormalizeOptions = {},
): MaintenanceReportDraftWriteData {
  const title = normalizeOptionalText(input.title, TITLE_MAX, '标题');
  const customerFactoryName = normalizeOptionalText(
    input.customerFactoryName,
    FACTORY_MAX,
    '客户厂家',
  );
  const equipmentModelText = normalizeOptionalText(
    input.equipmentModelText,
    MODEL_TEXT_MAX,
    '型号文字',
  );
  const equipmentModelId = input.equipmentModelId ?? null;
  if (equipmentModelId !== null) {
    if (!Number.isInteger(equipmentModelId) || equipmentModelId <= 0) {
      invalid('设备型号 ID 无效', { equipmentModelId });
    }
    if (equipmentModelText !== null) {
      invalid('设备型号 ID 与型号文字不能同时填写');
    }
  }

  const handlingResult = normalizeReportHandlingResult(input.handlingResult);
  const resetResult = normalizeReportResetResult(input.resetResult);
  const steps = normalizeSteps(input.steps, readInitialFaultPhaseCode(input.faults));

  return {
    title,
    customerFactoryName,
    equipmentModelId,
    equipmentModelText,
    maintenanceDate: normalizeDate(input.maintenanceDate),
    handlingResult,
    closureReason: normalizeReportClosureReason(
      handlingResult,
      input.closureReason,
      options.allowNonTerminalClosureReason ?? false,
    ),
    resetResult,
    actualCause: normalizeOptionalText(input.actualCause, ACTUAL_CAUSE_MAX, '实际确认原因'),
    repairActions: normalizeOptionalText(input.repairActions, REPAIR_ACTIONS_MAX, '维修措施'),
    verificationResult: normalizeOptionalText(
      input.verificationResult,
      VERIFICATION_MAX,
      '复测方法与结果',
    ),
    supplementaryNote: normalizeOptionalText(
      input.supplementaryNote,
      SUPPLEMENTARY_MAX,
      '补充说明',
    ),
    alarms: normalizeAlarms(input.alarms),
    steps,
    faults: normalizeFaults(input.faults, steps, resetResult),
    ...normalizeAiEvaluation(input, options.preservedAiHelpfulness ?? null),
    updatedByAccountId,
  };
}

/** 工单处理结果：仅接受固定枚举，未知值不做透写 */
export function normalizeHandlingResult(value: string): RepairRequestHandlingResult {
  if (!HANDLING_RESULT_SET.has(value)) {
    invalid('维修处理结果无效', { handlingResult: value });
  }
  return value as RepairRequestHandlingResult;
}

/** 需要强制填写非空原因的终结类结果 */
const CLOSURE_REASON_REQUIRED = new Set<RepairRequestHandlingResult>([
  RepairRequestHandlingResult.INTERRUPTED,
  RepairRequestHandlingResult.UNREPAIRABLE,
]);

/**
 * 归一化工单处理结果回写的结单原因。
 *
 * 2026-11-21 修复：与结单侧（任务 04 core policy `normalizeClosureReason`）
 * 同一规则——INTERRUPTED/UNREPAIRABLE 要求去空白后非空；其他结果原因可选，
 * 已填写的原因原样保留（此前「其他结果不允许携带原因」与结单侧不一致，
 * 会造成回写与结单两条路径行为漂移）。历史行不在此处补造原因，库内
 * `chk_repair_request_closure_reason` 仅对 `is_historical = 1` 的旧行豁免。
 */
export function normalizeHandlingClosureReason(
  handlingResult: RepairRequestHandlingResult,
  value: string | null | undefined,
): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (CLOSURE_REASON_REQUIRED.has(handlingResult)) {
    if (trimmed.length === 0) {
      invalid('中断或无法修复必须填写非空原因', { handlingResult });
    }
    return trimmed;
  }
  return trimmed.length === 0 ? null : trimmed;
}

export function assertGeneratedAnalysisOutput(
  output: {
    generationStatus: AnalysisOutputGenerationStatus;
    ownerOrganizationId: number | null;
    repairRequestId: number | null;
  },
  expected: { ownerOrganizationId: number; repairRequestId: number | null },
): void {
  if (output.generationStatus !== AnalysisOutputGenerationStatus.GENERATED) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_NOT_SUCCESSFUL,
      '分析结果未成功生成，不能作为已使用 AI 的评价对象',
      { generationStatus: output.generationStatus },
    );
  }
  if (output.ownerOrganizationId !== expected.ownerOrganizationId) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_OWNER_MISMATCH,
      '分析结果不存在或不可访问',
    );
  }
  if (output.repairRequestId !== expected.repairRequestId) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REQUEST_MISMATCH,
      '分析结果不存在或不可访问',
    );
  }
}

/**
 * 收集输入中「客户端已显式提供」的字段名。
 *
 * 供"客户端不得重复填写服务端权威字段"类断言使用：把字段存在性的判定收敛在
 * 归一化层，用例层不再手工 filter(...length > 0) 做输入收敛。
 */
export function collectProvidedFieldNames(
  record: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => record[field] !== undefined);
}

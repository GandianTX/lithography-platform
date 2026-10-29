// src/usecases/maintenance-report/maintenance-report.input.normalize.ts

import {
  AnalysisOutputGenerationStatus,
  MaintenanceAiCorrectness,
  MaintenanceAiUsage,
  MaintenanceAlarmResetResult,
  MaintenancePhaseCode,
  MaintenanceReportSourceType,
} from '@app-types/models/maintenance-report.types';
import { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type {
  MaintenanceReportAlarmWriteData,
  MaintenanceReportDraftWriteData,
  MaintenanceReportStepWriteData,
} from '@src/modules/lithography/maintenance-report.types';
import type {
  MaintenanceReportAlarmInput,
  MaintenanceReportDraftInput,
  MaintenanceReportStepInput,
} from './maintenance-report-command.types';

const TITLE_MAX = 200;
const FACTORY_MAX = 100;
const MODEL_TEXT_MAX = 100;
const ALARM_CODE_MAX = 100;
const ALARM_DESC_MAX = 500;
const STEP_CODE_MAX = 64;
const STEP_PART_MAX = 100;
const STEP_ACTION_MAX = 2000;
const STEP_RESULT_MAX = 2000;
const STEP_MAX = 100;
const AI_SOURCE_TYPE_MAX = 64;
const AI_SOURCE_ID_MAX = 128;
const AI_SOURCE_VERSION_MAX = 64;
const AI_NOTE_MAX = 2000;

const PHASE_SET = new Set<string>(Object.values(MaintenancePhaseCode));
const RESET_SET = new Set<string>(Object.values(MaintenanceAlarmResetResult));
const CORRECTNESS_SET = new Set<string>(Object.values(MaintenanceAiCorrectness));
const AI_USAGE_SET = new Set<string>(Object.values(MaintenanceAiUsage));
const SOURCE_TYPE_SET = new Set<string>(Object.values(MaintenanceReportSourceType));
const HANDLING_RESULT_SET = new Set<string>(Object.values(RepairRequestHandlingResult));

/** 评分型评价（评分/帮助程度）统一区间 1-5 */
const AI_RATING_MIN = 1;
const AI_RATING_MAX = 5;

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

function normalizeSteps(input: MaintenanceReportStepInput[] | undefined) {
  if (!input || input.length === 0) return [] as MaintenanceReportStepWriteData[];
  if (input.length > STEP_MAX) {
    invalid(`排查步骤最多 ${STEP_MAX} 条`, { count: input.length });
  }
  const codes = new Set<string>();
  return input.map((step, index) => {
    const stepCode = step.stepCode?.trim() ?? '';
    if (stepCode.length === 0 || stepCode.length > STEP_CODE_MAX) {
      invalid('步骤编码不能为空且不能超过 64 个字符', { stepIndex: index + 1 });
    }
    if (codes.has(stepCode)) {
      invalid('步骤编码重复', { stepCode });
    }
    codes.add(stepCode);
    if (!PHASE_SET.has(step.phaseCode)) {
      invalid('步骤阶段编码无效', { phaseCode: step.phaseCode });
    }
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
    const newAlarmCode = normalizeOptionalText(step.newAlarmCode, ALARM_CODE_MAX, '新报警代码');
    const isValidNewBranch = step.isValidNewBranch === true;
    if (isValidNewBranch && newAlarmCode === null) {
      invalid('有效新故障分支必须填写新报警代码', { stepCode });
    }
    return {
      stepNo: index + 1,
      stepCode,
      phaseCode: step.phaseCode as MaintenancePhaseCode,
      partName: normalizeOptionalText(step.partName, STEP_PART_MAX, '零件/部位'),
      actionText,
      resultText: normalizeOptionalText(step.resultText, STEP_RESULT_MAX, '步骤结果'),
      newAlarmCode,
      isValidNewBranch,
    };
  });
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

function isRating(value: number): boolean {
  return Number.isInteger(value) && value >= AI_RATING_MIN && value <= AI_RATING_MAX;
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

/** 评价取值校验：评分 1-5，正确性为枚举值 */
function validateAiEvaluationInput(input: MaintenanceReportDraftInput): void {
  if (isProvided(input.aiScore) && !isRating(input.aiScore)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID, 'AI 评分必须为 1-5');
  }
  if (isProvided(input.aiHelpfulness) && !isRating(input.aiHelpfulness)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID, 'AI 帮助程度必须为 1-5');
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

function normalizeAiEvaluation(input: MaintenanceReportDraftInput): AiEvaluationWriteData {
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
  validateAiEvaluationInput(input);

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

  return {
    title,
    customerFactoryName,
    equipmentModelId,
    equipmentModelText,
    maintenanceDate: normalizeDate(input.maintenanceDate),
    alarms: normalizeAlarms(input.alarms),
    steps: normalizeSteps(input.steps),
    ...normalizeAiEvaluation(input),
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

// src/usecases/reference-document/reference-document-structured-content.ts
// 任务 07 管理修订结构化内容（报告来源正式资料）。
//
// 数据映射（本轮确认需求三.3）：
// - 修订快照（reference_document_revision.before/after_snapshot，longtext +
//   JSON_VALID CHECK）加法扩展 `structuredReport` 键，承载报告来源资料的结构化
//   内容；不新建表、不加迁移、不改任务 04/06 任何写路径与既有键。
// - structuredReport 形状与任务 06 冻结快照（payload_snapshot V2）的报告内容
//   子集同构（faults/steps/reset/result 基本信息字段同名同枚举），分支枚举沿用
//   任务 06 领域值 INITIAL/RESET_NEW_FAULT/STEP_NEW_FAULT；
// - 报告来源资料无管理修订时，编辑初值由冻结版本 payload 派生（只读白名单键）；
// - 普通资料（MATERIAL）与旧扁平修订不进入结构化通道：不伪造缺失的故障数据，
//   不把普通资料强行转换成维修报告（写侧拒绝，读侧回落扁平正文）。
//
// 读侧宽松（白名单键、缺键降级 null，历史快照差异不阻断读取）；
// 写侧严格（schema 版本、枚举、分支启用条件、稳定关联、长度上限全部失败关闭）。

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { isBlankText } from '@core/common/text/text.helper';
import { normalizeOptionalText } from '@core/common/normalize/normalize.helper';
import {
  MAINTENANCE_PHASE_CODES,
  MaintenancePhaseCode,
  MaintenanceReportFaultBranchKind,
  MaintenanceReportResetResult,
  MaintenanceReportStepResult,
} from '@app-types/models/maintenance-report.types';
import { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import type { MaintenanceReportVersionSnapshot } from '@src/modules/lithography/maintenance-report.types';
import type {
  ReferenceDocumentStructuredContentView,
  ReferenceDocumentStructuredFaultView,
  ReferenceDocumentStructuredStepView,
} from '@src/modules/lithography/lithography.types';

/** 中断/无法修复必须填写原因；其余处理结果不允许带原因（与任务 06 表单口径一致） */
const CLOSURE_REASON_REQUIRED_RESULTS: readonly string[] = [
  RepairRequestHandlingResult.INTERRUPTED,
  RepairRequestHandlingResult.UNREPAIRABLE,
];

export const REFERENCE_DOCUMENT_STRUCTURED_CONTENT_SCHEMA_VERSION = 1;

/** 结构化字段长度上限（与前端编辑器 model.ts / 任务 06 报告表单同口径） */
export const STRUCTURED_ENGINEER_NAME_MAX_LENGTH = 200;

/** 客户厂家文本上限（与任务 06 报告字段规则 FACTORY_MAX 同口径） */
export const STRUCTURED_CUSTOMER_FACTORY_MAX_LENGTH = 200;
export const STRUCTURED_STEP_TEXT_MAX_LENGTH = 300;
export const STRUCTURED_PANEL_TEXT_MAX_LENGTH = 300;
export const STRUCTURED_ACTION_MAX_LENGTH = 20_000;
export const STRUCTURED_ACTUAL_CAUSE_MAX_LENGTH = 2000;
export const STRUCTURED_REPAIR_ACTIONS_MAX_LENGTH = 10_000;
export const STRUCTURED_VERIFICATION_RESULT_MAX_LENGTH = 2000;
export const STRUCTURED_SUPPLEMENTARY_NOTE_MAX_LENGTH = 10_000;
export const STRUCTURED_CLOSURE_REASON_MAX_LENGTH = 10_000;
export const STRUCTURED_MAX_STEP_COUNT = 50;
export const STRUCTURED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 结构化内容类型 = 领域读视图（modules/lithography）的 usecase 层别名：
 * 形状与任务 06 冻结快照报告内容子集同构，避免模块层与用例层各自漂移。
 */
export type ReferenceDocumentStructuredFault = ReferenceDocumentStructuredFaultView;
export type ReferenceDocumentStructuredStep = ReferenceDocumentStructuredStepView;

/**
 * 资料结构化内容（修订快照 structuredReport 键的值）。
 * equipmentModelText 不在编辑白名单：由服务端按改选机型从字典取名称写入快照，
 * 写侧规范化不接受客户端值，避免管理员修订伪造客户厂家或机型事实。
 */
export type ReferenceDocumentStructuredContent = ReferenceDocumentStructuredContentView;

// ---- 宽松读取工具（历史快照差异不阻断读取） ----

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 裁剪文本（规范化裁剪统一复用共享工具，规范化原语不留在业务读侧文件） */
function trimmedText(value: unknown): string {
  return normalizeOptionalText(value) ?? '';
}

function asNullableText(value: unknown): string | null {
  // 宽松读取保留原始字符串（不裁剪），仅复用共享工具做空白判定
  return typeof value === 'string' && normalizeOptionalText(value) !== null ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asEnumText<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function asPhaseCode(value: unknown): MaintenancePhaseCode | null {
  return asEnumText(value, MAINTENANCE_PHASE_CODES);
}

const BRANCH_KINDS: readonly MaintenanceReportFaultBranchKind[] = [
  MaintenanceReportFaultBranchKind.INITIAL,
  MaintenanceReportFaultBranchKind.RESET_NEW_FAULT,
  MaintenanceReportFaultBranchKind.STEP_NEW_FAULT,
];

const RESET_RESULTS: readonly MaintenanceReportResetResult[] = [
  MaintenanceReportResetResult.NORMAL,
  MaintenanceReportResetResult.SAME_FAULT,
  MaintenanceReportResetResult.NEW_FAULT,
];

const STEP_RESULTS: readonly MaintenanceReportStepResult[] = [
  MaintenanceReportStepResult.RESOLVED,
  MaintenanceReportStepResult.UNRESOLVED,
  MaintenanceReportStepResult.NEW_FAULT,
];

const HANDLING_RESULTS: readonly RepairRequestHandlingResult[] = Object.values(
  RepairRequestHandlingResult,
);

/**
 * 宽松解析修订快照中的结构化内容：schema 版本不符或基本结构不齐时返回 null
 * （读侧回落扁平正文展示，不伪造）。字段值逐键白名单，未知键忽略。
 */
export function readRevisionStructuredContent(
  snapshot: Record<string, unknown>,
): ReferenceDocumentStructuredContent | null {
  const raw = snapshot.structuredReport;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = asRecord(raw);
  if (record.schemaVersion !== REFERENCE_DOCUMENT_STRUCTURED_CONTENT_SCHEMA_VERSION) {
    return null;
  }
  const steps = asArray(record.steps)
    .map((item): ReferenceDocumentStructuredStep | null => {
      const step = asRecord(item);
      const stepCode = trimmedText(step.stepCode);
      const resultCode = asEnumText(step.resultCode, STEP_RESULTS);
      if (stepCode === '' || resultCode === null) {
        return null;
      }
      return {
        stepCode,
        stepNo: typeof step.stepNo === 'number' && Number.isFinite(step.stepNo) ? step.stepNo : 0,
        phaseCode: asPhaseCode(step.phaseCode),
        errorCode: asNullableText(step.errorCode),
        partName: asNullableText(step.partName),
        actionText: asText(step.actionText),
        resultCode,
      };
    })
    .filter((step): step is ReferenceDocumentStructuredStep => step !== null);
  const faults = asArray(record.faults)
    .map((item): ReferenceDocumentStructuredFault | null => {
      const fault = asRecord(item);
      const branchKind = asEnumText(fault.branchKind, BRANCH_KINDS);
      const description = asText(fault.description);
      if (branchKind === null || isBlankText(description)) {
        return null;
      }
      return {
        branchKind,
        stepCode: asNullableText(fault.stepCode),
        phaseCode: asPhaseCode(fault.phaseCode),
        mainError: asNullableText(fault.mainError),
        unitError: asNullableText(fault.unitError),
        source: asNullableText(fault.source),
        errorType: asNullableText(fault.errorType),
        gpibStatus: asNullableText(fault.gpibStatus),
        faultStatus: asNullableText(fault.faultStatus),
        description: trimmedText(description),
        action: asNullableText(fault.action),
      };
    })
    .filter((fault): fault is ReferenceDocumentStructuredFault => fault !== null);
  const resetResult = asEnumText(record.resetResult, RESET_RESULTS);
  if (resetResult === null) {
    return null;
  }
  return {
    schemaVersion: REFERENCE_DOCUMENT_STRUCTURED_CONTENT_SCHEMA_VERSION,
    maintenanceDate: asText(record.maintenanceDate),
    maintenanceEngineerName: asText(record.maintenanceEngineerName),
    customerFactoryName: asText(record.customerFactoryName),
    equipmentModelText: asNullableText(record.equipmentModelText),
    resetResult,
    faults,
    steps,
    handlingResult: asEnumText(record.handlingResult, HANDLING_RESULTS),
    closureReason: asNullableText(record.closureReason),
    actualCause: asNullableText(record.actualCause),
    repairActions: asNullableText(record.repairActions),
    verificationResult: asNullableText(record.verificationResult),
    supplementaryNote: asNullableText(record.supplementaryNote),
  };
}

/**
 * 报告来源资料（无管理修订）的结构化编辑初值：冻结版本 payload 只读白名单键。
 * 与 parseFrozenReportVersion（展示视图）并行，读取其未覆盖的扩展键
 * （faults / handlingResult / resetResult / 维修结果类），缺键按空值降级；
 * 客户厂家与机型文字继承冻结事实，不由客户端提交。
 */
export function structuredContentFromFrozenVersion(
  version: MaintenanceReportVersionSnapshot,
): ReferenceDocumentStructuredContent {
  const payload = asRecord(version.payloadSnapshot);
  const faults = asArray(payload.faults)
    .map((item): ReferenceDocumentStructuredFault | null => {
      const fault = asRecord(item);
      const branchKind = asEnumText(fault.branchKind, BRANCH_KINDS);
      const description = asText(fault.description);
      if (branchKind === null || isBlankText(description)) {
        return null;
      }
      return {
        branchKind,
        stepCode: asNullableText(fault.stepCode),
        phaseCode: asPhaseCode(fault.phaseCode),
        mainError: asNullableText(fault.mainError),
        unitError: asNullableText(fault.unitError),
        source: asNullableText(fault.source),
        errorType: asNullableText(fault.errorType),
        gpibStatus: asNullableText(fault.gpibStatus),
        faultStatus: asNullableText(fault.faultStatus),
        description: trimmedText(description),
        action: asNullableText(fault.action),
      };
    })
    .filter((fault): fault is ReferenceDocumentStructuredFault => fault !== null);
  const steps = asArray(payload.steps)
    .map((item): ReferenceDocumentStructuredStep | null => {
      const step = asRecord(item);
      const stepCode = trimmedText(step.stepCode);
      if (stepCode === '') {
        return null;
      }
      return {
        stepCode,
        stepNo: typeof step.stepNo === 'number' && Number.isFinite(step.stepNo) ? step.stepNo : 0,
        phaseCode: asPhaseCode(step.phaseCode),
        errorCode: asNullableText(step.errorCode),
        partName: asNullableText(step.partName),
        actionText: asText(step.actionText),
        resultCode:
          asEnumText(step.resultCode, STEP_RESULTS) ?? MaintenanceReportStepResult.UNRESOLVED,
      };
    })
    .filter((step): step is ReferenceDocumentStructuredStep => step !== null);
  return {
    schemaVersion: REFERENCE_DOCUMENT_STRUCTURED_CONTENT_SCHEMA_VERSION,
    maintenanceDate: asText(payload.maintenanceDate),
    maintenanceEngineerName: asText(payload.maintenanceEngineerName),
    customerFactoryName: asText(payload.customerFactoryName),
    equipmentModelText: asNullableText(payload.equipmentModelText),
    resetResult:
      asEnumText(payload.resetResult, RESET_RESULTS) ?? MaintenanceReportResetResult.NORMAL,
    faults,
    steps,
    handlingResult: asEnumText(payload.handlingResult, HANDLING_RESULTS),
    closureReason: asNullableText(payload.closureReason),
    actualCause: asNullableText(payload.actualCause),
    repairActions: asNullableText(payload.repairActions),
    verificationResult: asNullableText(payload.verificationResult),
    supplementaryNote: asNullableText(payload.supplementaryNote),
  };
}

// ---- 写侧严格规范化（失败关闭） ----

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, message, details);
}

function normalizeText(
  value: unknown,
  fieldName: string,
  maxLength: number,
  { required = false, nullable = true }: { required?: boolean; nullable?: boolean } = {},
): string | null {
  if (typeof value !== 'string') {
    if (value === undefined || value === null) {
      if (required) invalid(`提交前必须填写${fieldName}`, { fieldName });
      return null;
    }
    invalid(`${fieldName}必须是字符串`, { fieldName });
  }
  const trimmed = normalizeOptionalText(value);
  if (trimmed === null) {
    if (required) invalid(`提交前必须填写${fieldName}`, { fieldName });
    return nullable ? null : '';
  }
  if (trimmed.length > maxLength) {
    invalid(`${fieldName}不能超过 ${maxLength} 个字符`, { fieldName, length: trimmed.length });
  }
  return trimmed;
}

function normalizePhaseCode(value: unknown): MaintenancePhaseCode | null {
  const code = asEnumText(value, MAINTENANCE_PHASE_CODES);
  if (value !== null && value !== undefined && value !== '' && code === null) {
    invalid('流程阶段编码必须是 PHASE_01—PHASE_10 中的合法值', { phaseCode: value });
  }
  return code;
}

/** 严格规范化管理修订提交的结构化内容（全量值语义）；厂家文本在白名单，机型文字不在（由字典取名称） */
export function normalizeStructuredRevisionContent(
  raw: unknown,
): ReferenceDocumentStructuredContent {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('结构化内容必须是对象');
  }
  const record = asRecord(raw);
  if (record.schemaVersion !== REFERENCE_DOCUMENT_STRUCTURED_CONTENT_SCHEMA_VERSION) {
    invalid('结构化内容 schema 版本不符，请刷新后重试', {
      schemaVersion: record.schemaVersion,
    });
  }

  // 客户厂家文本（本轮确认需求）：按任务 06 报告字段规则校验（必填、≤200 字）
  const customerFactoryName = normalizeText(
    record.customerFactoryName,
    '客户厂家',
    STRUCTURED_CUSTOMER_FACTORY_MAX_LENGTH,
    {
      required: true,
      nullable: false,
    },
  ) as string;

  const maintenanceDate = normalizeText(record.maintenanceDate, '维修日期', 10, {
    required: true,
    nullable: false,
  }) as string;
  if (!STRUCTURED_DATE_PATTERN.test(maintenanceDate)) {
    invalid('维修日期必须是 YYYY-MM-DD 格式', { maintenanceDate });
  }
  const parsedDate = new Date(`${maintenanceDate}T00:00:00Z`);
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== maintenanceDate
  ) {
    invalid('维修日期不是有效日期', { maintenanceDate });
  }
  const maintenanceEngineerName = normalizeText(
    record.maintenanceEngineerName,
    '维修工程师',
    STRUCTURED_ENGINEER_NAME_MAX_LENGTH,
    {
      required: true,
      nullable: false,
    },
  ) as string;

  const resetResult = asEnumText(record.resetResult, RESET_RESULTS);
  if (resetResult === null) {
    invalid('复位情况必须是三选一（NORMAL/SAME_FAULT/NEW_FAULT）', {
      resetResult: record.resetResult,
    });
  }

  // 步骤：动作必填、结果必选、稳定编码必填且唯一；上限与编辑器一致
  const rawSteps = asArray(record.steps);
  if (rawSteps.length === 0) {
    invalid('提交前至少需要一条排查步骤');
  }
  if (rawSteps.length > STRUCTURED_MAX_STEP_COUNT) {
    invalid(`排查步骤最多 ${STRUCTURED_MAX_STEP_COUNT} 条`, { count: rawSteps.length });
  }
  const steps: ReferenceDocumentStructuredStep[] = rawSteps.map((item, index) => {
    const step = asRecord(item);
    if (Array.isArray(item) || item === null || typeof item !== 'object') {
      invalid(`第 ${index + 1} 条排查步骤必须是对象`);
    }
    const stepCode = normalizeText(step.stepCode, `第 ${index + 1} 条步骤编码`, 200, {
      required: true,
      nullable: false,
    }) as string;
    const resultCode = asEnumText(step.resultCode, STEP_RESULTS);
    if (resultCode === null) {
      invalid(`第 ${index + 1} 条步骤结果必须三选一（RESOLVED/UNRESOLVED/NEW_FAULT）`);
    }
    return {
      stepCode,
      stepNo: index + 1,
      phaseCode: normalizePhaseCode(step.phaseCode),
      errorCode: normalizeText(
        step.errorCode,
        `第 ${index + 1} 条步骤故障部件`,
        STRUCTURED_STEP_TEXT_MAX_LENGTH,
      ),
      partName: normalizeText(
        step.partName,
        `第 ${index + 1} 条步骤部件名称`,
        STRUCTURED_STEP_TEXT_MAX_LENGTH,
      ),
      actionText: normalizeText(
        step.actionText,
        `第 ${index + 1} 条步骤操作方式`,
        STRUCTURED_STEP_TEXT_MAX_LENGTH,
        {
          required: true,
          nullable: false,
        },
      ) as string,
      resultCode,
    };
  });
  const stepCodes = new Set<string>();
  for (const step of steps) {
    if (stepCodes.has(step.stepCode)) {
      invalid('步骤稳定编码必须唯一', { stepCode: step.stepCode });
    }
    stepCodes.add(step.stepCode);
  }

  // 故障面板：分支枚举、描述必填、稳定关联
  const rawFaults = asArray(record.faults);
  if (rawFaults.length > 1 + STRUCTURED_MAX_STEP_COUNT) {
    invalid('故障面板数量超出上限', { count: rawFaults.length });
  }
  const faults: ReferenceDocumentStructuredFault[] = rawFaults.map((item, index) => {
    const fault = asRecord(item);
    if (Array.isArray(item) || item === null || typeof item !== 'object') {
      invalid(`第 ${index + 1} 个故障面板必须是对象`);
    }
    const branchKind = asEnumText(fault.branchKind, BRANCH_KINDS);
    if (branchKind === null) {
      invalid('故障面板分支类型非法', { branchKind: fault.branchKind });
    }
    const stepCode = normalizeText(fault.stepCode, '故障面板关联步骤编码', 200);
    if (branchKind === MaintenanceReportFaultBranchKind.STEP_NEW_FAULT && stepCode === null) {
      invalid('步骤新故障面板必须关联步骤编码');
    }
    if (branchKind !== MaintenanceReportFaultBranchKind.STEP_NEW_FAULT && stepCode !== null) {
      invalid('初始故障与复位新故障面板不得关联步骤', { branchKind, stepCode });
    }
    if (
      branchKind === MaintenanceReportFaultBranchKind.STEP_NEW_FAULT &&
      stepCode !== null &&
      !stepCodes.has(stepCode)
    ) {
      invalid('步骤新故障面板关联的步骤不存在', { stepCode });
    }
    return {
      branchKind,
      stepCode,
      phaseCode: normalizePhaseCode(fault.phaseCode),
      mainError: normalizeText(fault.mainError, 'Main Error', STRUCTURED_PANEL_TEXT_MAX_LENGTH),
      unitError: normalizeText(fault.unitError, 'Unit Error', STRUCTURED_PANEL_TEXT_MAX_LENGTH),
      source: normalizeText(fault.source, 'Source', STRUCTURED_PANEL_TEXT_MAX_LENGTH),
      errorType: normalizeText(fault.errorType, 'Error Type', STRUCTURED_PANEL_TEXT_MAX_LENGTH),
      gpibStatus: normalizeText(fault.gpibStatus, 'GPIB Status', STRUCTURED_PANEL_TEXT_MAX_LENGTH),
      faultStatus: normalizeText(fault.faultStatus, 'Status', STRUCTURED_PANEL_TEXT_MAX_LENGTH),
      description: normalizeText(fault.description, '故障描述', STRUCTURED_PANEL_TEXT_MAX_LENGTH, {
        required: true,
        nullable: false,
      }) as string,
      action: normalizeText(fault.action, 'Action', STRUCTURED_ACTION_MAX_LENGTH),
    };
  });

  assertBranchConsistency({ resetResult, steps, faults });

  const handlingResult = asEnumText(record.handlingResult, HANDLING_RESULTS);
  if (
    record.handlingResult !== null &&
    record.handlingResult !== undefined &&
    handlingResult === null
  ) {
    invalid('维修结果取值非法', { handlingResult: record.handlingResult });
  }
  const closureReasonRequired =
    handlingResult !== null && CLOSURE_REASON_REQUIRED_RESULTS.includes(handlingResult);
  const closureReason = normalizeText(
    record.closureReason,
    '中断/无法修复原因',
    STRUCTURED_CLOSURE_REASON_MAX_LENGTH,
  );
  if (closureReasonRequired && closureReason === null) {
    invalid('中断或无法修复时必须填写原因', { handlingResult });
  }
  if (!closureReasonRequired && closureReason !== null) {
    invalid('当前维修结果不允许填写中断/无法修复原因', { handlingResult });
  }

  return {
    schemaVersion: REFERENCE_DOCUMENT_STRUCTURED_CONTENT_SCHEMA_VERSION,
    maintenanceDate,
    maintenanceEngineerName,
    customerFactoryName,
    equipmentModelText: null,
    resetResult,
    faults,
    steps,
    handlingResult,
    closureReason,
    actualCause: normalizeText(record.actualCause, '故障根因', STRUCTURED_ACTUAL_CAUSE_MAX_LENGTH),
    repairActions: normalizeText(
      record.repairActions,
      '维修动作说明',
      STRUCTURED_REPAIR_ACTIONS_MAX_LENGTH,
    ),
    verificationResult: normalizeText(
      record.verificationResult,
      '验证结果',
      STRUCTURED_VERIFICATION_RESULT_MAX_LENGTH,
    ),
    supplementaryNote: normalizeText(
      record.supplementaryNote,
      '补充说明',
      STRUCTURED_SUPPLEMENTARY_NOTE_MAX_LENGTH,
    ),
  };
}

/**
 * 分支启用条件一致性（与编辑器联动规则一致，三.3/四.3）：
 * - 复位为 NEW_FAULT 必须恰好一个 RESET_NEW_FAULT 面板；否则不得携带；
 * - 结果为 NEW_FAULT 的步骤必须恰好一个对应 STEP_NEW_FAULT 面板；
 *   其余步骤不得携带步骤面板（不同步骤的新故障不串线）；
 * - 初始故障至多一个。
 */
export function assertBranchConsistency(params: {
  resetResult: string;
  steps: ReadonlyArray<{ stepCode: string; resultCode: string }>;
  faults: ReadonlyArray<{ branchKind: string; stepCode: string | null }>;
}): void {
  const { resetResult, steps, faults } = params;
  const initialCount = faults.filter((fault) => fault.branchKind === 'INITIAL').length;
  if (initialCount > 1) {
    invalid('初始故障面板至多一个', { count: initialCount });
  }
  const resetPanels = faults.filter((fault) => fault.branchKind === 'RESET_NEW_FAULT');
  if (resetResult === 'NEW_FAULT') {
    if (resetPanels.length !== 1) {
      invalid('复位为新故障时必须提供恰好一个复位新故障面板', { count: resetPanels.length });
    }
  } else if (faults.some((fault) => fault.branchKind === 'RESET_NEW_FAULT')) {
    invalid('复位非新故障时不得携带复位新故障面板', { count: resetPanels.length });
  }
  const stepPanelsByStep = new Map<string, number>();
  for (const fault of faults) {
    if (fault.branchKind !== 'STEP_NEW_FAULT') {
      continue;
    }
    const stepCode = fault.stepCode as string;
    stepPanelsByStep.set(stepCode, (stepPanelsByStep.get(stepCode) ?? 0) + 1);
  }
  for (const step of steps) {
    const count = stepPanelsByStep.get(step.stepCode) ?? 0;
    if (step.resultCode === 'NEW_FAULT') {
      if (count !== 1) {
        invalid('步骤结果为新故障时必须提供恰好一个对应的新故障面板', { stepCode: step.stepCode });
      }
    } else if (count > 0) {
      invalid('步骤结果非新故障时不得携带该步骤的新故障面板', { stepCode: step.stepCode });
    }
    stepPanelsByStep.delete(step.stepCode);
  }
  if (stepPanelsByStep.size > 0) {
    invalid('步骤新故障面板关联的步骤不存在', { stepCodes: [...stepPanelsByStep.keys()] });
  }
}

/**
 * 结构化内容 → 可读纯文本（生效正文 contentText 的派生值）。
 * 与 composeFrozenReportText 同风格：供文本视图、列表检索与旧读取方兼容；
 * 不包含初始报警表（报警仍以原始冻结报告为权威追溯来源展示）。
 */
export function composeStructuredContentText(content: ReferenceDocumentStructuredContent): string {
  const lines: string[] = [];
  if (content.maintenanceDate) lines.push(`维修日期：${content.maintenanceDate}`);
  if (content.maintenanceEngineerName) {
    lines.push(`维修工程师：${content.maintenanceEngineerName}`);
  }
  if (content.customerFactoryName) lines.push(`客户厂家：${content.customerFactoryName}`);
  if (content.equipmentModelText) lines.push(`适用机型：${content.equipmentModelText}`);

  if (content.faults.length > 0) {
    lines.push('', '故障现象：');
    for (const fault of content.faults) {
      const location =
        fault.branchKind === 'INITIAL'
          ? '初始故障'
          : fault.branchKind === 'RESET_NEW_FAULT'
            ? '复位后新故障'
            : `步骤新故障（${fault.stepCode ?? '—'}）`;
      const fields = [
        fault.mainError ? `Main Error：${fault.mainError}` : null,
        fault.unitError ? `Unit Error：${fault.unitError}` : null,
        fault.source ? `Source：${fault.source}` : null,
        fault.errorType ? `Error Type：${fault.errorType}` : null,
        fault.gpibStatus ? `GPIB Status：${fault.gpibStatus}` : null,
        fault.faultStatus ? `Status：${fault.faultStatus}` : null,
        fault.phaseCode ? `阶段：${fault.phaseCode}` : null,
      ].flatMap((field) => (field === null ? [] : [field]));
      lines.push(
        `- ${location}：${fault.description}${fields.length > 0 ? `（${fields.join('；')}）` : ''}`,
      );
      if (fault.action) lines.push(`  Action：${fault.action}`);
    }
  }

  lines.push('', `复位情况：${content.resetResult}`);

  if (content.steps.length > 0) {
    lines.push('', '排查步骤：');
    for (const step of content.steps) {
      const part = step.partName ? `［${step.partName}］` : '';
      const errorCode = step.errorCode ? `（故障部件代码 ${step.errorCode}）` : '';
      const phase = step.phaseCode ? `${step.phaseCode} ` : '';
      lines.push(
        `${step.stepNo}. ${phase}${part} ${step.actionText}${errorCode}；结果：${step.resultCode}`,
      );
    }
  }

  if (content.handlingResult !== null) {
    lines.push('', `维修结果：${content.handlingResult}`);
    if (content.closureReason) lines.push(`中断/无法修复原因：${content.closureReason}`);
  }
  if (content.actualCause) lines.push(`故障根因：${content.actualCause}`);
  if (content.repairActions) lines.push(`维修动作说明：${content.repairActions}`);
  if (content.verificationResult) lines.push(`验证结果：${content.verificationResult}`);
  if (content.supplementaryNote) lines.push(`补充说明：${content.supplementaryNote}`);
  return lines.join('\n');
}

/** 修订快照 structuredReport 键的写入值（含继承的客户厂家/机型文字） */
export function toStructuredSnapshotValue(
  content: ReferenceDocumentStructuredContent,
): Record<string, unknown> {
  return {
    schemaVersion: content.schemaVersion,
    maintenanceDate: content.maintenanceDate,
    maintenanceEngineerName: content.maintenanceEngineerName,
    customerFactoryName: content.customerFactoryName,
    equipmentModelText: content.equipmentModelText,
    resetResult: content.resetResult,
    faults: content.faults,
    steps: content.steps,
    handlingResult: content.handlingResult,
    closureReason: content.closureReason,
    actualCause: content.actualCause,
    repairActions: content.repairActions,
    verificationResult: content.verificationResult,
    supplementaryNote: content.supplementaryNote,
  };
}

/** 非空文本判定（供 usecase 判定扁平回退） */
export function hasNonBlankText(value: string | null | undefined): boolean {
  return !isBlankText(value ?? '');
}

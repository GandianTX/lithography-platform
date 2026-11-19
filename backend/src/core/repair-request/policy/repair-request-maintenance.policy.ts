// src/core/repair-request/policy/repair-request-maintenance.policy.ts
// 工单结构化内部维修记录的输入归一、值域与面板一致性策略（纯函数，无框架依赖）。
//
// 只负责「输入是否合法、字段如何落库」，不做权限、状态机与事务裁决；
// 权限（接单人/可信组织/是否结束）与版本条件由保存用例裁决。

import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';

/** 排查结果：已解决 / 未解决 / 出现新故障 */
export const DIAGNOSTIC_STEP_RESULT_CODES = ['RESOLVED', 'UNRESOLVED', 'NEW_FAULT'] as const;
export type DiagnosticStepResultCode = (typeof DIAGNOSTIC_STEP_RESULT_CODES)[number];

/** 故障面板类型：初始故障 / 步骤新故障 / 复位新故障 */
export const FAULT_PANEL_TYPES = ['INITIAL', 'STEP_NEW_FAULT', 'RESET_NEW_FAULT'] as const;
export type FaultPanelType = (typeof FAULT_PANEL_TYPES)[number];

/** 复位结果：正常 / 同一故障 / 新故障 */
export const MAINTENANCE_RESET_RESULTS = ['NORMAL', 'SAME_FAULT', 'NEW_FAULT'] as const;
export type MaintenanceResetResult = (typeof MAINTENANCE_RESET_RESULTS)[number];

/** 稳定阶段编码（v1 固定 10 档，仅存编码，不存展示文案） */
export const MAINTENANCE_PHASE_CODES = [
  'PHASE_01',
  'PHASE_02',
  'PHASE_03',
  'PHASE_04',
  'PHASE_05',
  'PHASE_06',
  'PHASE_07',
  'PHASE_08',
  'PHASE_09',
  'PHASE_10',
] as const;
export type MaintenancePhaseCode = (typeof MAINTENANCE_PHASE_CODES)[number];

const MAX_DATE_LENGTH = 10;
const MAX_ENGINEER_NAME_LENGTH = 200;
const MAX_STEP_TEXT_LENGTH = 300;
const MAX_PANEL_TEXT_LENGTH = 300;
const MAX_NOTE_LENGTH = 20000;
const MAX_STEP_NO = 1000000;

export type NormalizedDiagnosticStep = {
  /** 已有步骤 ID；新建步骤为 null */
  id: string | null;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: DiagnosticStepResultCode;
};

export type NormalizedFaultPanel = {
  /** 已有面板 ID；新建面板为 null */
  id: string | null;
  panelType: FaultPanelType;
  /**
   * STEP_NEW_FAULT 必填：所关联步骤在本次提交中的顺序号。
   * 使用顺序号而非临时主键，保证新建步骤与已有步骤都能被稳定引用；
   * 保存用例在步骤落库后按顺序号解析真实步骤 ID。
   */
  stepNo: number | null;
  phaseCode: MaintenancePhaseCode | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

export type NormalizedMaintenanceRecord = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: MaintenanceResetResult | null;
  supplementaryNote: string | null;
  steps: NormalizedDiagnosticStep[];
  panels: NormalizedFaultPanel[];
};

export type MaintenanceRecordRawInput = {
  maintenanceDate?: string | null;
  engineerName?: string | null;
  resetResult?: string | null;
  supplementaryNote?: string | null;
  steps: ReadonlyArray<{
    id?: string | null;
    stepNo: number;
    errorCode?: string | null;
    partName?: string | null;
    actionText: string;
    resultCode: string;
  }>;
  panels: ReadonlyArray<{
    id?: string | null;
    panelType: string;
    stepNo?: number | null;
    phaseCode?: string | null;
    mainError?: string | null;
    unitError?: string | null;
    source?: string | null;
    errorType?: string | null;
    gpibStatus?: string | null;
    faultStatus?: string | null;
    description: string;
    action?: string | null;
  }>;
};

/**
 * 归一与校验结构化维修记录。
 *
 * 规则（数据库 CHECK 之外的业务约束）：
 * - 步骤顺序号从 1 连续递增且唯一；动作必填；结果受控；
 * - 初始面板至多一份；复位新故障面板至多一份，且只有复位结果为新故障时才允许；
 * - 步骤新故障面板必须关联一个结果为新故障的步骤，一个步骤至多一个面板；
 * - 非步骤新故障面板不得携带步骤引用；面板描述必填。
 */
export function normalizeMaintenanceRecord(
  input: MaintenanceRecordRawInput,
): NormalizedMaintenanceRecord {
  const steps = normalizeSteps(input.steps);
  const panels = normalizePanels(input.panels, steps);

  const resetResult = normalizeResetResult(input.resetResult);
  assertResetPanelConsistency(resetResult, panels);
  assertStepPanelConsistency(steps, panels);

  return {
    maintenanceDate: normalizeMaintenanceDate(input.maintenanceDate),
    engineerName: normalizeOptionalText(input.engineerName, MAX_ENGINEER_NAME_LENGTH, '维修工程师'),
    resetResult,
    supplementaryNote: normalizeOptionalText(input.supplementaryNote, MAX_NOTE_LENGTH, '补充说明'),
    steps,
    panels,
  };
}

/** 维修记录是否完全为空（用于「内容无变更」判定与空态展示） */
export function isMaintenanceRecordEmpty(record: {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  steps: ReadonlyArray<unknown>;
  panels: ReadonlyArray<unknown>;
}): boolean {
  return (
    record.maintenanceDate === null &&
    record.engineerName === null &&
    record.resetResult === null &&
    record.supplementaryNote === null &&
    record.steps.length === 0 &&
    record.panels.length === 0
  );
}

function normalizeSteps(steps: MaintenanceRecordRawInput['steps']): NormalizedDiagnosticStep[] {
  if (!isArrayValue(steps)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '排查步骤格式不合法');
  }
  const seenStepNos = new Set<number>();
  const seenIds = new Set<string>();
  return steps.map((step, index) => {
    const stepNo = step.stepNo;
    if (!Number.isSafeInteger(stepNo) || stepNo < 1 || stepNo > MAX_STEP_NO) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '排查步骤顺序号不合法');
    }
    if (seenStepNos.has(stepNo)) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '排查步骤顺序号重复');
    }
    seenStepNos.add(stepNo);

    const id = normalizeOptionalId(step.id);
    if (id !== null) {
      if (seenIds.has(id)) {
        throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '排查步骤编号重复');
      }
      seenIds.add(id);
    }

    const resultCode = step.resultCode;
    if (!DIAGNOSTIC_STEP_RESULT_CODES.includes(resultCode as DiagnosticStepResultCode)) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '排查结果不合法');
    }

    return {
      id,
      stepNo,
      errorCode: normalizeOptionalText(
        step.errorCode,
        MAX_STEP_TEXT_LENGTH,
        `第 ${index + 1} 步报错代码`,
      ),
      partName: normalizeOptionalText(
        step.partName,
        MAX_STEP_TEXT_LENGTH,
        `第 ${index + 1} 步零件/部位`,
      ),
      actionText: normalizeRequiredText(
        step.actionText,
        MAX_NOTE_LENGTH,
        `第 ${index + 1} 步排查动作`,
      ),
      resultCode: resultCode as DiagnosticStepResultCode,
    };
  });
}

function normalizePanels(
  panels: MaintenanceRecordRawInput['panels'],
  steps: NormalizedDiagnosticStep[],
): NormalizedFaultPanel[] {
  if (!isArrayValue(panels)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '故障面板格式不合法');
  }
  const stepNos = new Set(steps.map((step) => step.stepNo));
  const seenPanelIds = new Set<string>();
  const seenStepNos = new Set<number>();

  return panels.map((panel, index) => {
    if (!FAULT_PANEL_TYPES.includes(panel.panelType as FaultPanelType)) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '故障面板类型不合法');
    }
    const panelType = panel.panelType as FaultPanelType;
    const id = normalizeOptionalId(panel.id);
    if (id !== null) {
      if (seenPanelIds.has(id)) {
        throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '故障面板编号重复');
      }
      seenPanelIds.add(id);
    }

    const rawStepNo =
      panel.stepNo === undefined || panel.stepNo === null ? null : Number(panel.stepNo);
    let stepNo: number | null = null;
    if (panelType === 'STEP_NEW_FAULT') {
      if (rawStepNo === null || !Number.isSafeInteger(rawStepNo) || !stepNos.has(rawStepNo)) {
        throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '故障面板关联的排查步骤不存在');
      }
      if (seenStepNos.has(rawStepNo)) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.INVALID_PARAMS,
          '同一排查步骤只能有一个新故障面板',
        );
      }
      seenStepNos.add(rawStepNo);
      stepNo = rawStepNo;
    } else if (rawStepNo !== null) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '非步骤新故障面板不能关联步骤');
    }

    const phaseCode = normalizePhaseCode(panel.phaseCode);
    return {
      id,
      panelType,
      stepNo,
      phaseCode,
      mainError: normalizeOptionalText(
        panel.mainError,
        MAX_PANEL_TEXT_LENGTH,
        `面板 ${index + 1} 主报警代码`,
      ),
      unitError: normalizeOptionalText(
        panel.unitError,
        MAX_PANEL_TEXT_LENGTH,
        `面板 ${index + 1} 单元报警代码`,
      ),
      source: normalizeOptionalText(panel.source, MAX_PANEL_TEXT_LENGTH, `面板 ${index + 1} 来源`),
      errorType: normalizeOptionalText(
        panel.errorType,
        MAX_PANEL_TEXT_LENGTH,
        `面板 ${index + 1} 错误类型`,
      ),
      gpibStatus: normalizeOptionalText(
        panel.gpibStatus,
        MAX_PANEL_TEXT_LENGTH,
        `面板 ${index + 1} GPIB 状态`,
      ),
      faultStatus: normalizeOptionalText(
        panel.faultStatus,
        MAX_PANEL_TEXT_LENGTH,
        `面板 ${index + 1} 故障状态`,
      ),
      description: normalizeRequiredText(
        panel.description,
        MAX_NOTE_LENGTH,
        `面板 ${index + 1} 描述`,
      ),
      action: normalizeOptionalText(panel.action, MAX_NOTE_LENGTH, `面板 ${index + 1} 处理动作`),
    };
  });
}

/** 运行时数组形状校验；返回 boolean 以避免 Array.isArray 把已类型化参数收窄为 any[] */
function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function normalizeResetResult(value: string | null | undefined): MaintenanceResetResult | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }
  if (!MAINTENANCE_RESET_RESULTS.includes(value as MaintenanceResetResult)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '复位结果不合法');
  }
  return value as MaintenanceResetResult;
}

function assertResetPanelConsistency(
  resetResult: MaintenanceResetResult | null,
  panels: NormalizedFaultPanel[],
): void {
  const resetPanels = panels.filter((panel) => panel.panelType === 'RESET_NEW_FAULT');
  if (resetPanels.length > 1) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '复位新故障面板只能有一份');
  }
  if (resetPanels.length === 1 && resetResult !== 'NEW_FAULT') {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      '只有复位结果为新故障时才允许填写复位新故障面板',
    );
  }
}

function assertStepPanelConsistency(
  steps: NormalizedDiagnosticStep[],
  panels: NormalizedFaultPanel[],
): void {
  const initialPanels = panels.filter((panel) => panel.panelType === 'INITIAL');
  if (initialPanels.length > 1) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '初始故障面板只能有一份');
  }
  const newFaultStepNos = new Set(
    steps.filter((step) => step.resultCode === 'NEW_FAULT').map((step) => step.stepNo),
  );
  for (const panel of panels) {
    if (panel.panelType !== 'STEP_NEW_FAULT' || panel.stepNo === null) {
      continue;
    }
    if (!newFaultStepNos.has(panel.stepNo)) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.INVALID_PARAMS,
        '只有结果为“出现新故障”的步骤才能关联故障面板',
      );
    }
  }
}

function normalizeMaintenanceDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }
  const text = value.trim();
  if (text.length !== MAX_DATE_LENGTH || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '维修日期格式应为 YYYY-MM-DD');
  }
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '维修日期不是有效日期');
  }
  return text;
}

function normalizePhaseCode(value: string | null | undefined): MaintenancePhaseCode | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }
  if (!MAINTENANCE_PHASE_CODES.includes(value as MaintenancePhaseCode)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '流程阶段编码不合法');
  }
  return value as MaintenancePhaseCode;
}

function normalizeOptionalId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }
  return value.trim();
}

export function normalizeOptionalText(
  value: string | null | undefined,
  maxLength: number,
  fieldName: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = value.trim();
  if (text === '') {
    return null;
  }
  if (text.length > maxLength) {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      `${fieldName}不能超过 ${maxLength} 个字符`,
    );
  }
  return text;
}

export function normalizeRequiredText(
  value: string | null | undefined,
  maxLength: number,
  fieldName: string,
): string {
  const text = normalizeOptionalText(value, maxLength, fieldName);
  if (text === null) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, `${fieldName}不能为空`);
  }
  return text;
}

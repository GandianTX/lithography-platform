/**
 * 结构化内部维修记录编辑器的值模型与纯函数（任务 04）。
 *
 * - 工程师端与管理员修订弹窗共用，不依赖 React / Ant Design；
 * - 分支联动规则：INITIAL 至多一份；步骤结果为 NEW_FAULT 时保留该步骤的
 *   STEP_NEW_FAULT 面板；复位结果为 NEW_FAULT 时保留 RESET_NEW_FAULT 面板；
 *   删除步骤或切走分支时同步清理对应面板，不留孤儿；
 * - 步骤使用本地稳定 key 关联面板；既有步骤保留服务端 id 与顺序，调序不换 id；
 * - 提交时按数组顺序生成从 1 连续递增的 stepNo，面板通过步骤 key 解析 stepNo。
 */

import type { MessageKey, Translate } from '@/shared/i18n';

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

export const MAINTENANCE_RESET_RESULTS = ['NORMAL', 'SAME_FAULT', 'NEW_FAULT'] as const;
export type MaintenanceResetResult = (typeof MAINTENANCE_RESET_RESULTS)[number];

export const MAINTENANCE_STEP_RESULTS = ['RESOLVED', 'UNRESOLVED', 'NEW_FAULT'] as const;
export type MaintenanceStepResult = (typeof MAINTENANCE_STEP_RESULTS)[number];

export type MaintenancePanelType = 'INITIAL' | 'STEP_NEW_FAULT' | 'RESET_NEW_FAULT';

export type MaintenanceAttachmentValue = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

export type MaintenancePanelValue = {
  /** 本地稳定 key，用于面板与步骤联动 */
  key: string;
  /** 服务端面板 ID；新建为 null */
  id: string | null;
  panelType: MaintenancePanelType;
  /** STEP_NEW_FAULT 关联的步骤本地 key */
  stepKey: string | null;
  phaseCode: MaintenancePhaseCode | '';
  mainError: string;
  unitError: string;
  source: string;
  errorType: string;
  gpibStatus: string;
  faultStatus: string;
  description: string;
  action: string;
};

export type MaintenanceStepValue = {
  /** 本地稳定 key，调序/删除期间不变 */
  key: string;
  /** 服务端步骤 ID；新建为 null */
  id: string | null;
  errorCode: string;
  partName: string;
  actionText: string;
  resultCode: MaintenanceStepResult | '';
};

export type MaintenanceEditorValue = {
  maintenanceDate: string;
  engineerName: string;
  resetResult: MaintenanceResetResult | '';
  supplementaryNote: string;
  steps: MaintenanceStepValue[];
  panels: MaintenancePanelValue[];
  /** 已绑定维修原件（服务端事实；保存时由调用方另行绑定） */
  attachment: MaintenanceAttachmentValue | null;
};

export type MaintenanceStepPayload = {
  id: string | null;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

export type MaintenancePanelPayload = {
  id: string | null;
  panelType: MaintenancePanelType;
  stepNo: number | null;
  phaseCode: string | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

export type MaintenanceEditorSource = {
  maintenanceDate?: string | null;
  engineerName?: string | null;
  resetResult?: string | null;
  supplementaryNote?: string | null;
  attachment?: MaintenanceAttachmentValue | null;
  steps?: ReadonlyArray<{
    id: string;
    stepNo: number;
    errorCode?: string | null;
    partName?: string | null;
    actionText: string;
    resultCode: string;
  }>;
  panels?: ReadonlyArray<{
    id: string;
    panelType: string;
    stepId?: string | null;
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

export const MAX_ENGINEER_NAME_LENGTH = 200;
export const MAX_STEP_TEXT_LENGTH = 300;
export const MAX_PANEL_TEXT_LENGTH = 300;
export const MAX_NOTE_LENGTH = 20000;
const MAINTENANCE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PANEL_TEXT_LIMIT_FIELDS = [
  'mainError',
  'unitError',
  'source',
  'errorType',
  'gpibStatus',
  'faultStatus',
] as const;

let localKeySequence = 0;

export function nextLocalKey(prefix: string): string {
  localKeySequence += 1;
  return `${prefix}:local:${Date.now().toString(36)}:${localKeySequence}`;
}

export const RESET_RESULT_LABEL_KEYS: Record<MaintenanceResetResult, MessageKey> = {
  NORMAL: 'maintenance.reset.NORMAL',
  SAME_FAULT: 'maintenance.reset.SAME_FAULT',
  NEW_FAULT: 'maintenance.reset.NEW_FAULT',
};

export const STEP_RESULT_LABEL_KEYS: Record<MaintenanceStepResult, MessageKey> = {
  RESOLVED: 'maintenance.stepResult.RESOLVED',
  UNRESOLVED: 'maintenance.stepResult.UNRESOLVED',
  NEW_FAULT: 'maintenance.stepResult.NEW_FAULT',
};

export const PHASE_LABEL_KEYS: Record<MaintenancePhaseCode, MessageKey> = {
  PHASE_01: 'maintenance.phase.PHASE_01',
  PHASE_02: 'maintenance.phase.PHASE_02',
  PHASE_03: 'maintenance.phase.PHASE_03',
  PHASE_04: 'maintenance.phase.PHASE_04',
  PHASE_05: 'maintenance.phase.PHASE_05',
  PHASE_06: 'maintenance.phase.PHASE_06',
  PHASE_07: 'maintenance.phase.PHASE_07',
  PHASE_08: 'maintenance.phase.PHASE_08',
  PHASE_09: 'maintenance.phase.PHASE_09',
  PHASE_10: 'maintenance.phase.PHASE_10',
};

/** 复位结果代码 → 本地化文案（管理员只读视图复用） */
export function describeResetResult(value: string | null | undefined, t: Translate): string {
  if (value !== null && value !== undefined && value in RESET_RESULT_LABEL_KEYS) {
    return t(RESET_RESULT_LABEL_KEYS[value as MaintenanceResetResult]);
  }
  return value ?? '—';
}

/** 步骤结果代码 → 本地化文案 */
export function describeStepResult(value: string | null | undefined, t: Translate): string {
  if (value !== null && value !== undefined && value in STEP_RESULT_LABEL_KEYS) {
    return t(STEP_RESULT_LABEL_KEYS[value as MaintenanceStepResult]);
  }
  return value ?? '—';
}

/** 故障阶段代码 → 本地化文案 */
export function describePhaseCode(value: string | null | undefined, t: Translate): string {
  if (value !== null && value !== undefined && value in PHASE_LABEL_KEYS) {
    return t(PHASE_LABEL_KEYS[value as MaintenancePhaseCode]);
  }
  return value ?? '—';
}

function normalizeText(value: string | null | undefined): string {
  return value ?? '';
}

function normalizeNullableText(value: string): string | null {
  const text = value.trim();
  return text === '' ? null : text;
}

function toResetResult(value: string | null | undefined): MaintenanceResetResult | '' {
  return value !== null && value !== undefined && value !== ''
    ? (MAINTENANCE_RESET_RESULTS as readonly string[]).includes(value)
      ? (value as MaintenanceResetResult)
      : ''
    : '';
}

export function toStepResult(value: string): MaintenanceStepResult | '' {
  return (MAINTENANCE_STEP_RESULTS as readonly string[]).includes(value)
    ? (value as MaintenanceStepResult)
    : '';
}

function toPhaseCode(value: string | null | undefined): MaintenancePhaseCode | '' {
  return value !== null && value !== undefined && value !== ''
    ? (MAINTENANCE_PHASE_CODES as readonly string[]).includes(value)
      ? (value as MaintenancePhaseCode)
      : ''
    : '';
}

export function createEmptyPanel(
  panelType: MaintenancePanelType,
  stepKey: string | null = null,
): MaintenancePanelValue {
  return {
    key: nextLocalKey('panel'),
    id: null,
    panelType,
    stepKey: panelType === 'STEP_NEW_FAULT' ? stepKey : null,
    phaseCode: '',
    mainError: '',
    unitError: '',
    source: '',
    errorType: '',
    gpibStatus: '',
    faultStatus: '',
    description: '',
    action: '',
  };
}

/**
 * 从服务端事实构造编辑器值：补齐当前有效分支的面板，丢弃失效分支面板。
 * 既有步骤/面板保留 id；新建步骤/面板使用本地 key。
 */
export function createMaintenanceEditorValue(
  source: MaintenanceEditorSource,
): MaintenanceEditorValue {
  const steps: MaintenanceStepValue[] = [...(source.steps ?? [])]
    .sort((left, right) => left.stepNo - right.stepNo)
    .map((step) => ({
      key: `step:${step.id}`,
      id: step.id,
      errorCode: normalizeText(step.errorCode),
      partName: normalizeText(step.partName),
      actionText: step.actionText,
      resultCode: toStepResult(step.resultCode),
    }));
  const stepKeyByServerId = new Map(
    steps.flatMap((step) => (step.id === null ? [] : [[step.id, step.key] as const])),
  );

  const sourcePanels = source.panels ?? [];
  const initialSource = sourcePanels.find((panel) => panel.panelType === 'INITIAL');
  const resetSource = sourcePanels.find((panel) => panel.panelType === 'RESET_NEW_FAULT');
  const stepPanelByKey = new Map<string, (typeof sourcePanels)[number]>();
  for (const panel of sourcePanels) {
    if (panel.panelType !== 'STEP_NEW_FAULT' || !panel.stepId) {
      continue;
    }
    const stepKey = stepKeyByServerId.get(panel.stepId);
    if (stepKey !== undefined && !stepPanelByKey.has(stepKey)) {
      stepPanelByKey.set(stepKey, panel);
    }
  }

  const toPanelValue = (
    panel: (typeof sourcePanels)[number],
    panelType: MaintenancePanelType,
    stepKey: string | null,
  ): MaintenancePanelValue => ({
    key: `panel:${panel.id}`,
    id: panel.id,
    panelType,
    stepKey: panelType === 'STEP_NEW_FAULT' ? stepKey : null,
    phaseCode: toPhaseCode(panel.phaseCode),
    mainError: normalizeText(panel.mainError),
    unitError: normalizeText(panel.unitError),
    source: normalizeText(panel.source),
    errorType: normalizeText(panel.errorType),
    gpibStatus: normalizeText(panel.gpibStatus),
    faultStatus: normalizeText(panel.faultStatus),
    description: panel.description,
    action: normalizeText(panel.action),
  });

  const panels: MaintenancePanelValue[] = [
    initialSource ? toPanelValue(initialSource, 'INITIAL', null) : createEmptyPanel('INITIAL'),
  ];

  const resetResult = toResetResult(source.resetResult);

  for (const step of steps) {
    if (step.resultCode !== 'NEW_FAULT') {
      continue;
    }
    const panel = stepPanelByKey.get(step.key);
    panels.push(
      panel
        ? toPanelValue(panel, 'STEP_NEW_FAULT', step.key)
        : createEmptyPanel('STEP_NEW_FAULT', step.key),
    );
  }

  if (resetResult === 'NEW_FAULT') {
    panels.push(
      resetSource
        ? toPanelValue(resetSource, 'RESET_NEW_FAULT', null)
        : createEmptyPanel('RESET_NEW_FAULT'),
    );
  }

  return {
    maintenanceDate: normalizeText(source.maintenanceDate),
    engineerName: normalizeText(source.engineerName),
    resetResult,
    supplementaryNote: normalizeText(source.supplementaryNote),
    steps,
    panels,
    attachment: source.attachment ?? null,
  };
}

export function findInitialPanel(value: MaintenanceEditorValue): MaintenancePanelValue | undefined {
  return value.panels.find((panel) => panel.panelType === 'INITIAL');
}

export function findResetPanel(value: MaintenanceEditorValue): MaintenancePanelValue | undefined {
  return value.panels.find((panel) => panel.panelType === 'RESET_NEW_FAULT');
}

export function findStepPanel(
  value: MaintenanceEditorValue,
  stepKey: string,
): MaintenancePanelValue | undefined {
  return value.panels.find(
    (panel) => panel.panelType === 'STEP_NEW_FAULT' && panel.stepKey === stepKey,
  );
}

function hasPanelContent(panel: MaintenancePanelValue): boolean {
  return (
    panel.phaseCode !== '' ||
    panel.mainError.trim() !== '' ||
    panel.unitError.trim() !== '' ||
    panel.source.trim() !== '' ||
    panel.errorType.trim() !== '' ||
    panel.gpibStatus.trim() !== '' ||
    panel.faultStatus.trim() !== '' ||
    panel.description.trim() !== '' ||
    panel.action.trim() !== ''
  );
}

/** 本次会随保存提交的有效面板（只含有内容的面板，避免提交空描述面板） */
export function collectEffectivePanels(value: MaintenanceEditorValue): MaintenancePanelValue[] {
  const panels: MaintenancePanelValue[] = [];
  const initial = findInitialPanel(value);
  if (initial && hasPanelContent(initial)) {
    panels.push(initial);
  }
  for (const step of value.steps) {
    if (step.resultCode !== 'NEW_FAULT') {
      continue;
    }
    const panel = findStepPanel(value, step.key);
    if (panel && hasPanelContent(panel)) {
      panels.push(panel);
    }
  }
  if (value.resetResult === 'NEW_FAULT') {
    const reset = findResetPanel(value);
    if (reset && hasPanelContent(reset)) {
      panels.push(reset);
    }
  }
  return panels;
}

export function toMaintenanceStepPayloads(value: MaintenanceEditorValue): MaintenanceStepPayload[] {
  return value.steps.map((step, index) => ({
    id: step.id,
    stepNo: index + 1,
    errorCode: normalizeNullableText(step.errorCode),
    partName: normalizeNullableText(step.partName),
    actionText: step.actionText.trim(),
    resultCode: step.resultCode,
  }));
}

export function toMaintenancePanelPayloads(
  value: MaintenanceEditorValue,
): MaintenancePanelPayload[] {
  const stepNoByKey = new Map(value.steps.map((step, index) => [step.key, index + 1]));
  return collectEffectivePanels(value).map((panel) => ({
    id: panel.id,
    panelType: panel.panelType,
    stepNo:
      panel.panelType === 'STEP_NEW_FAULT' ? (stepNoByKey.get(panel.stepKey ?? '') ?? null) : null,
    phaseCode: panel.phaseCode === '' ? null : panel.phaseCode,
    mainError: normalizeNullableText(panel.mainError),
    unitError: normalizeNullableText(panel.unitError),
    source: normalizeNullableText(panel.source),
    errorType: normalizeNullableText(panel.errorType),
    gpibStatus: normalizeNullableText(panel.gpibStatus),
    faultStatus: normalizeNullableText(panel.faultStatus),
    description: panel.description.trim(),
    action: normalizeNullableText(panel.action),
  }));
}

/** 规范化序列化：用于管理员判断「维修记录是否有变化」 */
export function serializeMaintenanceEditorValue(value: MaintenanceEditorValue): string {
  return JSON.stringify({
    maintenanceDate: value.maintenanceDate.trim(),
    engineerName: value.engineerName.trim(),
    resetResult: value.resetResult,
    supplementaryNote: value.supplementaryNote.trim(),
    steps: toMaintenanceStepPayloads(value),
    panels: toMaintenancePanelPayloads(value),
  });
}

function panelLabel(
  panel: MaintenancePanelValue,
  value: MaintenanceEditorValue,
  t: Translate,
): string {
  if (panel.panelType === 'INITIAL') {
    return t('maintenance.initialFault');
  }
  if (panel.panelType === 'RESET_NEW_FAULT') {
    return t('maintenance.resetNewFault');
  }
  const index = value.steps.findIndex((step) => step.key === panel.stepKey);
  return t('maintenance.stepNewFault', { index: index < 0 ? '?' : index + 1 });
}

/**
 * 与后端 normalizer 对齐的前端校验（提前给出可读提示，最终仍以后端裁决）：
 * - 步骤动作必填、结果必选；文本长度上限与后端一致；
 * - 本次会提交的面板描述必填；
 * - 维修日期 YYYY-MM-DD；工程师姓名/补充说明长度上限。
 */
export function validateMaintenanceEditorValue(
  value: MaintenanceEditorValue,
  t: Translate,
): string[] {
  const issues: string[] = [];
  const date = value.maintenanceDate.trim();
  if (date !== '') {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (
      !MAINTENANCE_DATE_PATTERN.test(date) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date
    ) {
      issues.push(t('maintenance.validation.dateInvalid'));
    }
  }
  if (value.engineerName.trim().length > MAX_ENGINEER_NAME_LENGTH) {
    issues.push(t('maintenance.validation.engineerNameTooLong', { max: MAX_ENGINEER_NAME_LENGTH }));
  }
  if (value.supplementaryNote.length > MAX_NOTE_LENGTH) {
    issues.push(t('maintenance.validation.noteTooLong', { max: MAX_NOTE_LENGTH }));
  }
  value.steps.forEach((step, index) => {
    if (step.actionText.trim() === '') {
      issues.push(t('maintenance.validation.stepActionRequired', { index: index + 1 }));
    }
    if (step.resultCode === '') {
      issues.push(t('maintenance.validation.stepResultRequired', { index: index + 1 }));
    }
    if (
      step.errorCode.trim().length > MAX_STEP_TEXT_LENGTH ||
      step.partName.trim().length > MAX_STEP_TEXT_LENGTH
    ) {
      issues.push(
        t('maintenance.validation.stepTextTooLong', {
          index: index + 1,
          max: MAX_STEP_TEXT_LENGTH,
        }),
      );
    }
  });
  for (const panel of collectEffectivePanels(value)) {
    const label = panelLabel(panel, value, t);
    if (panel.description.trim() === '') {
      issues.push(t('maintenance.validation.panelDescriptionRequired', { panel: label }));
    }
    for (const field of PANEL_TEXT_LIMIT_FIELDS) {
      if (panel[field].trim().length > MAX_PANEL_TEXT_LENGTH) {
        issues.push(
          t('maintenance.validation.panelTextTooLong', {
            panel: label,
            max: MAX_PANEL_TEXT_LENGTH,
          }),
        );
        break;
      }
    }
    if (panel.action.trim().length > MAX_NOTE_LENGTH) {
      issues.push(
        t('maintenance.validation.panelTextTooLong', { panel: label, max: MAX_NOTE_LENGTH }),
      );
    }
  }
  return issues;
}

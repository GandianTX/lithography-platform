// src/core/repair-request/policy/repair-request-revision.policy.ts
// 工单管理修订的字段白名单、快照格式与不可改写原始事实。
//
// 修订不是「管理员代写工单」：只允许订正已存在的正文、结果、结单原因与过程文本；
// 客户原始提交、模型输出、接单人、状态机事实与组织归属均不得通过修订改写。

/**
 * 快照格式版本；与 JSON 内 schema_version 必须一致（数据库 CHECK 约束）。
 * v2 增加结构化维修记录、排查步骤与故障面板；v1 旧快照仍可读取，
 * 但缺失维修数据时对比需显式提示不可比。
 */
export const REPAIR_REQUEST_REVISION_SCHEMA_VERSION = 2;

/** 允许通过管理修订修改的字段（唯一白名单） */
export const REPAIR_REQUEST_REVISION_EDITABLE_FIELDS = [
  'contentMd',
  'handlingResult',
  'closureReason',
  'processEntries',
  'maintenance',
] as const;

/**
 * 禁止通过修订改写的原始事实（服务端校验与文档共用）：
 * - 客户原始提交身份与设备事实；
 * - 接单人与状态机事实；
 * - 组织归属与服务公司；
 * - 模型输出、报告与未提交草稿（不属于本表，也不在本接口开放）。
 */
export const REPAIR_REQUEST_REVISION_IMMUTABLE_FACTS = [
  'requestNo',
  'customerAccountId',
  'equipmentModelId',
  'errorCode',
  'faultDescription',
  'createdAt',
  'isAccepted',
  'acceptedByEngineerAccountId',
  'acceptedAt',
  'ownerOrganizationId',
  'serviceOrganizationId',
  'closureStatus',
  'closedAt',
  'currentRevisionNo',
  'deprecated',
  'isHistorical',
] as const;

export type RepairRequestRevisionSnapshotRequest = {
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
  createdAt: Date;
  isAccepted: boolean;
  acceptedByEngineerAccountId: number | null;
  acceptedAt: Date | null;
  ownerOrganizationId: number | null;
  serviceOrganizationId: number | null;
  handlingResult: string | null;
  handlingStatus: string | null;
  handlingRecordedAt: Date | null;
  handlingRecordedByAccountId: number | null;
  handlingEndedAt: Date | null;
  closureStatus: string | null;
  closedAt: Date | null;
  closureReason: string | null;
  currentRevisionNo: number;
  // ---- 结构化维修记录（快照 v2 起）----
  maintenanceDate: string | null;
  maintenanceEngineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  maintenanceVersionNo: number;
  maintenanceAttachmentFileId: string | null;
};

export type RepairRequestRevisionSnapshotStep = {
  id: string;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

export type RepairRequestRevisionSnapshotPanel = {
  id: string;
  panelType: string;
  stepId: string | null;
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

export type RepairRequestRevisionSnapshotProcessEntry = {
  id: string;
  entryUuid: string;
  operationText: string;
  testResult: string | null;
  occurredAt: Date | null;
  timeSource: string;
  fileId: string | null;
  versionNo: number;
  createdAt: Date;
};

export type RepairRequestRevisionSnapshotResponse = {
  id: number;
  responseText: string;
  resolutionStatus: string;
  createdAt: Date;
};

/**
 * 构建修订前后快照（纯函数）。
 *
 * 快照保存工单完整已提交事实与客户回复，供审计对比；不包含未提交草稿、
 * 私有 AI 内容或其他来源原件。调用方负责传入修订前/后的值。
 */
export function buildRepairRequestRevisionSnapshot(input: {
  request: RepairRequestRevisionSnapshotRequest;
  processEntries: ReadonlyArray<RepairRequestRevisionSnapshotProcessEntry>;
  responses: ReadonlyArray<RepairRequestRevisionSnapshotResponse>;
  maintenanceSteps?: ReadonlyArray<RepairRequestRevisionSnapshotStep>;
  maintenanceFaultPanels?: ReadonlyArray<RepairRequestRevisionSnapshotPanel>;
}): Record<string, unknown> {
  return {
    schema_version: REPAIR_REQUEST_REVISION_SCHEMA_VERSION,
    request: {
      request_no: input.request.requestNo,
      customer_account_id: input.request.customerAccountId,
      equipment_model_id: input.request.equipmentModelId,
      error_code: input.request.errorCode,
      fault_description: input.request.faultDescription,
      content_md: input.request.contentMd,
      created_at: input.request.createdAt.toISOString(),
      is_accepted: input.request.isAccepted,
      accepted_by_engineer_account_id: input.request.acceptedByEngineerAccountId,
      accepted_at: input.request.acceptedAt?.toISOString() ?? null,
      owner_organization_id: input.request.ownerOrganizationId,
      service_organization_id: input.request.serviceOrganizationId,
      handling_result: input.request.handlingResult,
      handling_status: input.request.handlingStatus,
      handling_recorded_at: input.request.handlingRecordedAt?.toISOString() ?? null,
      handling_recorded_by_account_id: input.request.handlingRecordedByAccountId,
      handling_ended_at: input.request.handlingEndedAt?.toISOString() ?? null,
      closure_status: input.request.closureStatus,
      closed_at: input.request.closedAt?.toISOString() ?? null,
      closure_reason: input.request.closureReason,
      current_revision_no: input.request.currentRevisionNo,
      maintenance_date: input.request.maintenanceDate,
      maintenance_engineer_name: input.request.maintenanceEngineerName,
      reset_result: input.request.resetResult,
      supplementary_note: input.request.supplementaryNote,
      maintenance_version_no: input.request.maintenanceVersionNo,
      maintenance_attachment_file_id: input.request.maintenanceAttachmentFileId,
    },
    diagnostic_steps: (input.maintenanceSteps ?? []).map((step) => ({
      id: step.id,
      step_no: step.stepNo,
      error_code: step.errorCode,
      part_name: step.partName,
      action_text: step.actionText,
      result_code: step.resultCode,
    })),
    fault_panels: (input.maintenanceFaultPanels ?? []).map((panel) => ({
      id: panel.id,
      panel_type: panel.panelType,
      step_id: panel.stepId,
      phase_code: panel.phaseCode,
      main_error: panel.mainError,
      unit_error: panel.unitError,
      source: panel.source,
      error_type: panel.errorType,
      gpib_status: panel.gpibStatus,
      fault_status: panel.faultStatus,
      description: panel.description,
      action: panel.action,
    })),
    process_entries: input.processEntries.map((entry) => ({
      id: entry.id,
      entry_uuid: entry.entryUuid,
      operation_text: entry.operationText,
      test_result: entry.testResult,
      occurred_at: entry.occurredAt?.toISOString() ?? null,
      time_source: entry.timeSource,
      file_id: entry.fileId,
      version_no: entry.versionNo,
      created_at: entry.createdAt.toISOString(),
    })),
    responses: input.responses.map((response) => ({
      id: response.id,
      response_text: response.responseText,
      resolution_status: response.resolutionStatus,
      created_at: response.createdAt.toISOString(),
    })),
  };
}

export type ParsedRepairRequestRevisionSnapshot = {
  schemaVersion: number;
  contentMd: string;
  handlingResult: string | null;
  handlingStatus: string | null;
  closureReason: string | null;
  maintenance: {
    maintenanceDate: string | null;
    engineerName: string | null;
    resetResult: string | null;
    supplementaryNote: string | null;
    versionNo: number;
    attachmentFileId: string | null;
  };
  steps: RepairRequestRevisionSnapshotStep[];
  panels: RepairRequestRevisionSnapshotPanel[];
  /** v2 起才有维修步骤/面板；v1 旧快照为 false，对比时须提示不可比 */
  hasMaintenanceData: boolean;
};

/**
 * 解析已保存的历史快照（只读）。
 *
 * - 兼容 v1（无维修区块）与 v2；
 * - 结构损坏、非对象或缺字段时返回 null，由查询层提示「不可比」，
 *   绝不拼当前工单数据回填。
 */
export function parseRepairRequestRevisionSnapshot(
  raw: string,
): ParsedRepairRequestRevisionSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const schemaVersion = toInt(root.schema_version);
  if (schemaVersion === null || schemaVersion < 1) {
    return null;
  }
  const request = root.request;
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return null;
  }
  const requestObject = request as Record<string, unknown>;
  const contentMd = toStringOrNull(requestObject.content_md);
  if (contentMd === null) {
    return null;
  }
  const hasMaintenanceData =
    schemaVersion >= 2 && Array.isArray(root.diagnostic_steps) && Array.isArray(root.fault_panels);
  return {
    schemaVersion,
    contentMd,
    handlingResult: toStringOrNull(requestObject.handling_result),
    handlingStatus: toStringOrNull(requestObject.handling_status),
    closureReason: toStringOrNull(requestObject.closure_reason),
    maintenance: {
      maintenanceDate: toStringOrNull(requestObject.maintenance_date),
      engineerName: toStringOrNull(requestObject.maintenance_engineer_name),
      resetResult: toStringOrNull(requestObject.reset_result),
      supplementaryNote: toStringOrNull(requestObject.supplementary_note),
      versionNo: hasMaintenanceData ? (toInt(requestObject.maintenance_version_no) ?? 0) : 0,
      attachmentFileId: toStringOrNull(requestObject.maintenance_attachment_file_id),
    },
    steps: hasMaintenanceData ? parseSnapshotSteps(root.diagnostic_steps) : [],
    panels: hasMaintenanceData ? parseSnapshotPanels(root.fault_panels) : [],
    hasMaintenanceData,
  };
}

function parseSnapshotSteps(value: unknown): RepairRequestRevisionSnapshotStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: RepairRequestRevisionSnapshotStep[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const id = toStringOrNull(row.id);
    const stepNo = toInt(row.step_no);
    const actionText = toStringOrNull(row.action_text);
    const resultCode = toStringOrNull(row.result_code);
    if (id === null || stepNo === null || actionText === null || resultCode === null) {
      continue;
    }
    result.push({
      id,
      stepNo,
      errorCode: toStringOrNull(row.error_code),
      partName: toStringOrNull(row.part_name),
      actionText,
      resultCode,
    });
  }
  return result;
}

function parseSnapshotPanels(value: unknown): RepairRequestRevisionSnapshotPanel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: RepairRequestRevisionSnapshotPanel[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const id = toStringOrNull(row.id);
    const panelType = toStringOrNull(row.panel_type);
    const description = toStringOrNull(row.description);
    if (id === null || panelType === null || description === null) {
      continue;
    }
    result.push({
      id,
      panelType,
      stepId: toStringOrNull(row.step_id),
      phaseCode: toStringOrNull(row.phase_code),
      mainError: toStringOrNull(row.main_error),
      unitError: toStringOrNull(row.unit_error),
      source: toStringOrNull(row.source),
      errorType: toStringOrNull(row.error_type),
      gpibStatus: toStringOrNull(row.gpib_status),
      faultStatus: toStringOrNull(row.fault_status),
      description,
      action: toStringOrNull(row.action),
    });
  }
  return result;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

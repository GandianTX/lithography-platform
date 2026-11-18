// src/core/repair-request/policy/repair-request-revision.policy.ts
// 工单管理修订的字段白名单、快照格式与不可改写原始事实。
//
// 修订不是「管理员代写工单」：只允许订正已存在的正文、结果、结单原因与过程文本；
// 客户原始提交、模型输出、接单人、状态机事实与组织归属均不得通过修订改写。

/** 快照格式版本；与 JSON 内 schema_version 必须一致（数据库 CHECK 约束） */
export const REPAIR_REQUEST_REVISION_SCHEMA_VERSION = 1;

/** 允许通过管理修订修改的字段（唯一白名单） */
export const REPAIR_REQUEST_REVISION_EDITABLE_FIELDS = [
  'contentMd',
  'handlingResult',
  'closureReason',
  'processEntries',
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
    },
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

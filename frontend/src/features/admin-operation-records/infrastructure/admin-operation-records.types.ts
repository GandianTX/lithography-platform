// src/features/admin-operation-records/infrastructure/admin-operation-records.types.ts

/**
 * 关键操作记录读侧契约（任务 10，与 backend `managementAuditEvents` Query 对齐）。
 *
 * - `operation` 只有三类（GraphQL 枚举），凭据补发/重置等其余类型在协议层不可表达，
 *   前端不做任何兜底放行；
 * - `detail` 是后端白名单摘要（六字段），不含原 detail 文本；
 * - 操作者账号 ID 不出现在契约中（后端已剥离）。
 */

export const OPERATION_RECORD_OPERATIONS = [
  'ADMIN_DELETE_DOCUMENT',
  'CORRECT_DOCUMENT_OWNERSHIP',
  'RESTORE_LOCAL_BUSINESS',
] as const;

export type OperationRecordOperation = (typeof OPERATION_RECORD_OPERATIONS)[number];

export type OperationRecordResult = 'SUCCEEDED' | 'FAILED' | 'DENIED';

/** 后端白名单摘要：全部字段可空，由表格列按存在与否拼装说明。 */
export type OperationRecordDetail = {
  reason: string | null;
  stage: string | null;
  changedFields: string[] | null;
  attemptNo: number | null;
  beforeOrganizationName: string | null;
  afterOrganizationName: string | null;
};

export type OperationRecordItem = {
  eventId: string;
  occurredAt: string;
  actorAdminLevel: number;
  actorNickname: string;
  organizationId: number | null;
  organizationName: string | null;
  operation: OperationRecordOperation;
  targetType: string;
  targetId: string;
  result: OperationRecordResult;
  detail: OperationRecordDetail | null;
};

export type OperationRecordListPage = {
  items: OperationRecordItem[];
  total: number;
  page: number;
  pageSize: number;
};

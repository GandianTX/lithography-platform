// src/features/admin-document-database/infrastructure/admin-document-database.types.ts

/**
 * 管理员文档数据库（PR3）前端类型：字段名与后端 GraphQL DTO 逐一对齐
 * （backend/src/schema.graphql 的 Admin*DTO 组），不创建第二套语义。
 *
 * 排序说明：管理员聚合契约未暴露 sorts 入参（S1 契约冻结：服务端固定
 * 稳定排序，如消息 messageSeq ASC + id ASC、列表 createdAt DESC + id DESC），
 * 因此前端类型不含排序状态。
 */

// ---- 维修申请 ----

export type AdminRepairRequestFilter = {
  requestNo?: string;
  customerKeyword?: string;
  errorCode?: string;
  isAccepted?: boolean;
  equipmentModelId?: number;
  createdAtFrom?: string;
  createdAtTo?: string;
};

export type AdminRepairRequestListItem = {
  id: number;
  requestNo: string;
  customerNickname: string;
  companyName: string | null;
  equipmentModelId: number;
  equipmentModelCode: string;
  equipmentModelName: string;
  errorCode: string;
  isAccepted: boolean;
  acceptedAt: string | null;
  acceptedByEngineerNickname: string | null;
  latestResolutionStatus: 'PENDING' | 'RESOLVED' | null;
  createdAt: string;
};

export type AdminRepairProcessEntryFile = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

export type AdminRepairProcessEntry = {
  id: string;
  entryUuid: string;
  requestId: number;
  operationText: string;
  testResult: string | null;
  occurredAt: string | null;
  timeSource: 'SERVER' | 'MANUAL';
  fileId: string | null;
  file: AdminRepairProcessEntryFile | null;
  versionNo: number;
  createdAt: string;
};

export type AdminRepairResponse = {
  id: number;
  responseText: string;
  resolutionStatus: 'PENDING' | 'RESOLVED';
  engineerNickname: string;
  createdAt: string;
};

export type AdminRepairRevision = {
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorNickname: string;
  createdAt: string;
};

export type AdminRepairHandlingResult =
  | 'FIXED'
  | 'PART_PURCHASED'
  | 'PROVIDE_PLAN_SELF_EXECUTE'
  | 'INTERRUPTED'
  | 'UNREPAIRABLE';

export type AdminRepairHandlingStatus = 'COMPLETED' | 'IN_PROGRESS' | 'UNRESOLVED';

/** 管理员工单只读详情：仅已提交事实（不包含未提交草稿与私有 AI 内容） */
export type AdminRepairRequestSummary = {
  id: number;
  requestNo: string;
  customerNickname: string;
  companyName: string | null;
  equipmentModelId: number;
  equipmentModelCode: string;
  equipmentModelName: string;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
  isAccepted: boolean;
  acceptedAt: string | null;
  acceptedByEngineerNickname: string | null;
  latestResolutionStatus: 'PENDING' | 'RESOLVED' | null;
  createdAt: string;
  closureStatus: string | null;
  closedAt: string | null;
  closureReason: string | null;
  handlingResult: AdminRepairHandlingResult | null;
  handlingStatus: AdminRepairHandlingStatus | null;
  currentRevisionNo: number;
  processEntries: AdminRepairProcessEntry[];
  responses: AdminRepairResponse[];
  revisions: AdminRepairRevision[];
};

// ---- 管理员修订 ----

export type AdminRepairProcessRevisionInput = {
  entryId: string;
  expectedVersion: number;
  operationText: string;
  testResult?: string | null;
};

export type AdminRepairRevisionInput = {
  requestId: number;
  expectedVersion: number;
  reason: string;
  contentMd?: string | null;
  handlingResult?: AdminRepairHandlingResult | null;
  closureReason?: string | null;
  processEntries?: AdminRepairProcessRevisionInput[];
};

export type AdminRepairRevisionResult = AdminRepairRevision & {
  requestId: number;
  currentRevisionNo: number;
};

// ---- AI 会话与消息 ----

export type AdminAiConversationStatus = 'ACTIVE' | 'COMPLETED';

export type AdminAiConversationFilter = {
  requestNo?: string;
  engineerKeyword?: string;
  status?: AdminAiConversationStatus;
  createdAtFrom?: string;
  createdAtTo?: string;
};

export type AdminAiConversationListItem = {
  id: number;
  requestNo: string;
  requestId: number;
  status: AdminAiConversationStatus;
  engineerNickname: string;
  messageCount: number;
  reportCount: number;
  createdAt: string;
  completedAt: string | null;
  aiFeedback: string | null;
};

export type AdminAiMessageRole = 'ASSISTANT' | 'SYSTEM' | 'TOOL' | 'USER';

export type AdminAiMessageListItem = {
  id: number;
  conversationId: number;
  messageSeq: number;
  turnNo: number | null;
  role: AdminAiMessageRole;
  contentText: string;
  createdAt: string;
};

// ---- AI 报告 ----

export type AdminAiReportFilter = {
  requestNo?: string;
  engineerKeyword?: string;
  reportType?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
};

export type AdminAiReportListItem = {
  id: number;
  conversationId: number;
  requestId: number;
  /** 权威申请编号（以会话归属申请为准，M-04 裁定） */
  requestNo: string;
  /** 报告自身 requestId 与会话归属申请不一致的审计标记 */
  requestMismatch: boolean;
  reportType: string;
  reportTitle: string;
  engineerNickname: string;
  createdAt: string;
};

export type AdminAiReportDetail = AdminAiReportListItem & {
  contentMd: string;
};

// ---- 统计 ----

export type AdminDocumentDatabaseStats = {
  repairRequestTotal: number;
  referenceDocumentTotal: number;
  aiConversationTotal: number;
  aiReportTotal: number;
};

// ---- 分页 ----

export type AdminListPage<TItem> = {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
};

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
  /** 工单真实进度：结单事实与处理结果（旧数据可为 null） */
  closureStatus: string | null;
  closedAt: string | null;
  handlingResult: AdminRepairHandlingResult | null;
  handlingStatus: AdminRepairHandlingStatus | null;
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
  /** 服务端明确返回 false 时视为不可比（缺少可比前后快照） */
  hasComparableSnapshot?: boolean;
  schemaVersion?: number;
};

/** 管理员视图中的结构化维修记录（与工程师端同构，只读） */
export type AdminRepairMaintenanceAttachment = AdminRepairProcessEntryFile;

export type AdminRepairMaintenanceRecord = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  versionNo: number;
  attachment: AdminRepairMaintenanceAttachment | null;
};

export type AdminRepairMaintenanceStep = {
  id: string;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

export type AdminRepairMaintenanceFaultPanel = {
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

export type AdminRepairIntakeAnalysis = {
  status: string;
  generation: number;
  outputText: string | null;
  failureReason: string | null;
  finishedAt: string | null;
};

export type AdminRepairIntake = {
  intakeId: string;
  faultDescription: string | null;
  customerFile: AdminRepairProcessEntryFile | null;
  analysis: AdminRepairIntakeAnalysis | null;
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
  /** 任务 04：结构化维修记录（旧响应/夹具可缺省，UI 按空值兜底） */
  maintenanceVersionNo?: number;
  maintenance?: AdminRepairMaintenanceRecord | null;
  maintenanceSteps?: AdminRepairMaintenanceStep[];
  maintenanceFaultPanels?: AdminRepairMaintenanceFaultPanel[];
  intake?: AdminRepairIntake | null;
};

// ---- 管理员修订 ----

export type AdminRepairProcessRevisionInput = {
  entryId: string;
  expectedVersion: number;
  operationText: string;
  testResult?: string | null;
};

export type AdminMaintenanceStepInput = {
  id: string | null;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

export type AdminMaintenanceFaultPanelInput = {
  id: string | null;
  panelType: string;
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

/** 管理员修订维修区块：附件绑定不可经修订修改，input 不含附件字段 */
export type AdminMaintenanceRevisionInput = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  steps: AdminMaintenanceStepInput[];
  panels: AdminMaintenanceFaultPanelInput[];
};

export type AdminRepairRevisionInput = {
  requestId: number;
  expectedVersion: number;
  reason: string;
  contentMd?: string | null;
  handlingResult?: AdminRepairHandlingResult | null;
  closureReason?: string | null;
  processEntries?: AdminRepairProcessRevisionInput[];
  /** 同时修订维修区块时的乐观并发版本（当前 maintenanceVersionNo） */
  expectedMaintenanceVersion?: number | null;
  maintenance?: AdminMaintenanceRevisionInput | null;
};

export type AdminRepairRevisionResult = AdminRepairRevision & {
  requestId: number;
  currentRevisionNo: number;
};

/** 修订快照中的排查步骤（与维修记录同构，只读） */
export type AdminRevisionStep = {
  id: string;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

/** 修订快照中的故障面板（与维修记录同构，只读） */
export type AdminRevisionPanel = {
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

/** 修订前后快照：用于只读查看与差异对比，不拼接当前工单 */
export type AdminRepairRevisionSnapshot = {
  schemaVersion: number;
  contentMd: string;
  handlingResult: string | null;
  handlingStatus: string | null;
  closureReason: string | null;
  maintenanceDate: string | null;
  maintenanceEngineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  maintenanceVersionNo: number;
  maintenanceAttachmentFileId: string | null;
  steps: AdminRevisionStep[];
  panels: AdminRevisionPanel[];
};

export type AdminRepairRequestRevisionDetail = {
  requestId: number;
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorNickname: string;
  createdAt: string;
  comparable: boolean;
  hasMaintenanceData: boolean;
  incomparableReason: string | null;
  before: AdminRepairRevisionSnapshot | null;
  after: AdminRepairRevisionSnapshot | null;
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

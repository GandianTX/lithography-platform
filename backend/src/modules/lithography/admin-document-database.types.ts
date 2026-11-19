// src/modules/lithography/admin-document-database.types.ts

import type {
  EngineerResolutionStatus,
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import {
  AiConversationStatus,
  AiMessageAnalysisStatus,
  AiMessageRole,
} from '@app-types/models/ai-conversation.types';
import type { RepairProcessEntryView } from './lithography.types';

// ============================================================================
// PR3: 管理员 Document Database 聚合查询类型（只读）
//
// 分层口径（计划表 S2）：本文件持有管理员聚合读的稳定视图与筛选类型。
// - `*ListItemView` / `*DetailView` / `*SummaryView`：对外稳定视图（不含归属类账号 ID）；
// - `*ListItemQueryResult` / `*DetailQueryResult` / `*SummaryQueryResult`：
//   QueryService 装配结果（含账号 ID，供 usecase 跨域富集，不对外输出）；
// - 跨域展示字段（昵称/公司名）只在 View 上出现，由 usecase 经账户域
//   QueryService 批量富集；QueryService 不跨账户域读表。
// ============================================================================

/**
 * 管理员维修申请列表筛选条件（对外契约，全部可选）。
 * customerKeyword 在 usecase 层解析为账户域账号 ID 集合后转交 QueryService。
 */
export type AdminRepairRequestListFilter = {
  requestNo?: string;
  customerKeyword?: string;
  equipmentModelId?: number;
  errorCode?: string;
  isAccepted?: boolean;
  createdAtFrom?: Date;
  createdAtTo?: Date;
};

/**
 * 维修申请管理员读侧查询筛选（usecase 内部形态）。
 * 账号 ID 集合由 usecase 经账户域解析得到，QueryService 不做跨域解析。
 */
export type AdminRepairRequestQueryFilter = {
  requestNo?: string;
  customerAccountIds?: ReadonlyArray<number>;
  equipmentModelId?: number;
  errorCode?: string;
  isAccepted?: boolean;
  createdAtFrom?: Date;
  createdAtTo?: Date;
};

/** 管理员列表分页参数（仅 OFFSET；排序由契约固定，不提供客户端自定义排序） */
export type AdminListPagination = {
  page: number;
  pageSize: number;
  withTotal: boolean;
};

/** 管理员维修申请列表项装配结果（昵称富集前；账号 ID 不对外输出） */
export type AdminRepairRequestListItemQueryResult = {
  id: number;
  requestNo: string;
  customerAccountId: number;
  equipmentModel: {
    id: number;
    modelCode: string;
    modelName: string;
  };
  errorCode: string;
  createdAt: Date;
  isAccepted: boolean;
  acceptedAt: Date | null;
  acceptedByEngineerAccountId: number | null;
  latestResolutionStatus: EngineerResolutionStatus | null;
  closureStatus?: string | null;
  closedAt?: Date | null;
  handlingResult?: RepairRequestHandlingResult | null;
  handlingStatus?: RepairRequestHandlingStatus | null;
};

/** 管理员维修申请列表项稳定读视图（客户展示信息经 usecase 跨域富集） */
export type AdminRepairRequestListItemView = Omit<
  AdminRepairRequestListItemQueryResult,
  'customerAccountId' | 'acceptedByEngineerAccountId'
> & {
  customerNickname: string;
  companyName: string | null;
  acceptedByEngineerNickname: string | null;
};

/** 管理员工单客户回复装配结果（昵称富集前；账号 ID 不对外输出） */
export type AdminRepairRequestResponseQueryResult = {
  id: number;
  requestId: number;
  engineerAccountId: number;
  customerAccountId: number;
  responseText: string;
  resolutionStatus: EngineerResolutionStatus;
  createdAt: Date;
};

/** 管理员工单客户回复稳定读视图 */
export type AdminRepairRequestResponseView = Omit<
  AdminRepairRequestResponseQueryResult,
  'engineerAccountId' | 'customerAccountId'
> & {
  engineerNickname: string;
};

/** 管理员工单修订历史装配结果（修订人昵称富集前） */
export type AdminRepairRequestRevisionQueryResult = {
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorAccountId: number;
  createdAt: Date;
  /** 前后快照均可解析且为 v2 时才可做维修维度对比 */
  hasComparableSnapshot: boolean;
  /** 快照结构版本；旧快照可能为 1 */
  schemaVersion: number;
};

/** 管理员可见的维修原件元数据（不含存储引用） */
export type AdminRepairMaintenanceAttachmentView = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

/** 管理员可见的结构化维修记录 */
export type AdminRepairMaintenanceRecordView = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  versionNo: number;
  attachment: AdminRepairMaintenanceAttachmentView | null;
};

/** 管理员可见的客户原始报修与首次 AI 分析 */
export type AdminRepairIntakeSourceView = {
  intakeId: number;
  faultDescription: string;
  customerFile: AdminRepairMaintenanceAttachmentView | null;
  analysis: {
    status: string;
    generation: number;
    outputText: string | null;
    failureReason: string | null;
    finishedAt: Date | null;
  } | null;
};

/** 管理员修订快照视图（只读；不含附件二进制与存储引用） */
export type AdminRepairRequestRevisionSnapshotView = {
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
  steps: AdminRepairRequestRevisionStepView[];
  panels: AdminRepairRequestRevisionPanelView[];
};

export type AdminRepairRequestRevisionStepView = {
  id: string;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

export type AdminRepairRequestRevisionPanelView = {
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

/** 管理员修订详情（查看版本 / 对比上一版） */
export type AdminRepairRequestRevisionDetailView = {
  requestId: number;
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorNickname: string;
  createdAt: Date;
  /** 前后快照是否都可解析 */
  comparable: boolean;
  /** 是否包含 v2 维修区块（旧快照为 false） */
  hasMaintenanceData: boolean;
  /** 不可比时的明确原因；可比时为 null */
  incomparableReason: string | null;
  before: AdminRepairRequestRevisionSnapshotView | null;
  after: AdminRepairRequestRevisionSnapshotView | null;
};

/** 管理员工单修订历史稳定读视图 */
export type AdminRepairRequestRevisionView = Omit<
  AdminRepairRequestRevisionQueryResult,
  'actorAccountId'
> & {
  actorNickname: string;
};

/**
 * 管理员维修申请详情装配结果（昵称富集前；账号 ID 不对外输出）。
 *
 * 只装配工单域已提交事实：申请原文、内部过程、客户回复、结单事实与修订历史。
 * 不装配未提交草稿、私有 AI 内容或其他来源原件；原件仅经过程行的安全字段返回。
 */
export type AdminRepairRequestSummaryQueryResult = AdminRepairRequestListItemQueryResult & {
  faultDescription: string;
  contentMd: string;
  closureStatus: string | null;
  closedAt: Date | null;
  closureReason: string | null;
  handlingResult: RepairRequestHandlingResult | null;
  handlingStatus: RepairRequestHandlingStatus | null;
  currentRevisionNo: number;
  responses: AdminRepairRequestResponseQueryResult[];
  processEntries: RepairProcessEntryView[];
  revisions: AdminRepairRequestRevisionQueryResult[];
  // ---- 结构化维修记录（管理员编辑器与版本卡片使用）----
  maintenanceVersionNo: number;
  maintenance: AdminRepairMaintenanceRecordView | null;
  maintenanceSteps: AdminRepairRequestRevisionStepView[];
  maintenanceFaultPanels: AdminRepairRequestRevisionPanelView[];
  intake: AdminRepairIntakeSourceView | null;
};

/** 管理员维修申请详情稳定读视图（只读，不进入既有客户/工程师详情链路） */
export type AdminRepairRequestSummaryView = Omit<
  AdminRepairRequestSummaryQueryResult,
  'customerAccountId' | 'acceptedByEngineerAccountId' | 'responses' | 'revisions'
> & {
  customerNickname: string;
  companyName: string | null;
  acceptedByEngineerNickname: string | null;
  responses: AdminRepairRequestResponseView[];
  revisions: AdminRepairRequestRevisionView[];
};

/** 管理员维修申请列表页 */
export type AdminRepairRequestListPage = {
  items: AdminRepairRequestListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 管理员 AI 会话列表筛选条件（对外契约，全部可选）。
 * engineerKeyword 在 usecase 层解析为账户域账号 ID 集合后转交 QueryService。
 */
export type AdminAiConversationListFilter = {
  requestNo?: string;
  engineerKeyword?: string;
  status?: AiConversationStatus;
  createdAtFrom?: Date;
  createdAtTo?: Date;
};

/** AI 会话管理员读侧查询筛选（usecase 内部形态） */
export type AdminAiConversationQueryFilter = {
  requestNo?: string;
  engineerAccountIds?: ReadonlyArray<number>;
  status?: AiConversationStatus;
  createdAtFrom?: Date;
  createdAtTo?: Date;
  /**
   * 管理员组织范围（二级管理员的本公司）。
   * 为 null / 不传时按全公司读取（一级管理员）；服务端内部行为，不接受客户端传入。
   */
  organizationId?: number | null;
};

/** 管理员 AI 会话列表项装配结果（昵称富集前；账号 ID 不对外输出） */
export type AdminAiConversationListItemQueryResult = {
  id: number;
  requestId: number | null;
  requestNo: string;
  engineerAccountId: number;
  status: AiConversationStatus;
  aiFeedback: string | null;
  /** 会话内容版本（导出按此固定消息范围与截止点） */
  contentVersion: number;
  createdAt: Date;
  completedAt: Date | null;
  messageCount: number;
  reportCount: number;
};

/** 管理员 AI 会话列表项稳定读视图 */
export type AdminAiConversationListItemView = Omit<
  AdminAiConversationListItemQueryResult,
  'engineerAccountId'
> & {
  engineerNickname: string;
};

/** 管理员 AI 会话列表页 */
export type AdminAiConversationListPage = {
  items: AdminAiConversationListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/** 管理员 AI 消息列表项稳定读视图（消息正文即详情内容，按会话维度读取） */
export type AdminAiMessageListItemView = {
  id: number;
  conversationId: number;
  messageSeq: number;
  turnNo: number | null;
  role: AiMessageRole;
  contentText: string;
  /** 消息内容版本（与同轮分析、会话版本一致） */
  contentVersion: number;
  /** 所属轮次的分析状态（无分析记录时为空） */
  analysisStatus: AiMessageAnalysisStatus | null;
  /** 所属轮次的失败原因（仅失败轮次） */
  failureReason: string | null;
  createdAt: Date;
};

/** 管理员 AI 消息列表页（稳定排序：messageSeq ASC, id ASC，契约固定） */
export type AdminAiMessageListPage = {
  items: AdminAiMessageListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 管理员 AI 报告列表筛选条件（对外契约，全部可选）。
 * engineerKeyword 在 usecase 层解析为账户域账号 ID 集合后转交 QueryService。
 */
export type AdminAiReportListFilter = {
  requestNo?: string;
  engineerKeyword?: string;
  reportType?: string;
  createdAtFrom?: Date;
  createdAtTo?: Date;
};

/** AI 报告管理员读侧查询筛选（usecase 内部形态） */
export type AdminAiReportQueryFilter = {
  requestNo?: string;
  engineerAccountIds?: ReadonlyArray<number>;
  reportType?: string;
  createdAtFrom?: Date;
  createdAtTo?: Date;
};

/**
 * 管理员 AI 报告列表项稳定读视图。
 * 不携带 contentMd 大字段（仅详情返回），与「列表只投影必要字段」口径一致。
 *
 * 申请关联口径（PR3 定向 Review M-04 裁定）：
 * 会话是报告与维修申请关联的权威来源（报告由会话产出）——requestNo 取会话
 * 归属申请；报告自身 requestId 仅作数据审计展示。数据库未约束二者一致，
 * 不一致属异常历史数据：以 requestMismatch=true 显式暴露并记录审计日志，
 * 不静默改写、不改 Entity/Migration。
 */
export type AdminAiReportListItemQueryResult = {
  id: number;
  /** 报告记录自身携带的维修申请 ID（审计字段；权威归属见 requestNo/requestMismatch） */
  requestId: number;
  /** 权威申请编号（取会话归属申请；会话缺失等极端情况回落报告自身申请） */
  requestNo: string;
  /** 报告记录的申请与会话归属申请是否不一致（数据审计标记，正常数据为 false） */
  requestMismatch: boolean;
  conversationId: number;
  engineerAccountId: number;
  reportTitle: string;
  reportType: string;
  createdAt: Date;
};

/** 管理员 AI 报告列表项稳定读视图（昵称经 usecase 跨域富集） */
export type AdminAiReportListItemView = Omit<
  AdminAiReportListItemQueryResult,
  'engineerAccountId'
> & {
  engineerNickname: string;
};

/** 管理员 AI 报告列表页 */
export type AdminAiReportListPage = {
  items: AdminAiReportListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/** 管理员 AI 报告详情装配结果（昵称富集前；含正文 contentMd） */
export type AdminAiReportDetailQueryResult = AdminAiReportListItemQueryResult & {
  contentMd: string;
};

/** 管理员 AI 报告详情稳定读视图（只读正文，不提供生成/修改/删除能力） */
export type AdminAiReportDetailView = Omit<AdminAiReportDetailQueryResult, 'engineerAccountId'> & {
  engineerNickname: string;
};

/** 管理员文档数据库统计视图（口径与各标签默认列表过滤一致） */
export type AdminDocumentDatabaseStatsView = {
  repairRequestTotal: number;
  aiConversationTotal: number;
  aiReportTotal: number;
  referenceDocumentTotal: number;
};

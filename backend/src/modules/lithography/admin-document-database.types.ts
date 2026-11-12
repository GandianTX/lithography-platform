// src/modules/lithography/admin-document-database.types.ts

import type { EngineerResolutionStatus } from '@app-types/models/repair-request.types';
import { AiConversationStatus, AiMessageRole } from '@app-types/models/ai-conversation.types';

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
  /** 管理员组织范围（usecase 从可信成员关系解析；一级管理员不传表示全范围） */
  ownerOrganizationId?: number;
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

/** 管理员维修申请摘要装配结果（昵称富集前；账号 ID 不对外输出） */
export type AdminRepairRequestSummaryQueryResult = AdminRepairRequestListItemQueryResult & {
  faultDescription: string;
  contentMd: string;
};

/** 管理员维修申请摘要稳定读视图（只读摘要，不进入既有客户/工程师详情链路） */
export type AdminRepairRequestSummaryView = Omit<
  AdminRepairRequestSummaryQueryResult,
  'customerAccountId' | 'acceptedByEngineerAccountId'
> & {
  customerNickname: string;
  companyName: string | null;
  acceptedByEngineerNickname: string | null;
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
};

/** 管理员 AI 会话列表项装配结果（昵称富集前；账号 ID 不对外输出） */
export type AdminAiConversationListItemQueryResult = {
  id: number;
  requestId: number | null;
  requestNo: string;
  engineerAccountId: number;
  status: AiConversationStatus;
  aiFeedback: string | null;
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

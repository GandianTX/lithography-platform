// src/modules/lithography/ai-conversation.types.ts
// AI 对话（任务 05）模块层稳定契约：写服务输入/快照与读侧查询结果。
// 说明：
// - 只放同域稳定形态，不放 GraphQL DTO（适配层职责）与 usecase 编排结果；
// - 状态字段使用共享类型层正式枚举，避免裸字符串漂移。

import type {
  AiConversationStatus,
  AiMessageAnalysisStatus,
  AiMessageRole,
} from '@app-types/models/ai-conversation.types';

/** 会话写后快照（usecase 对外输出的最小事实） */
export interface AiConversationSnapshot {
  readonly id: number;
  readonly requestId: number | null;
  readonly ownerOrganizationId: number | null;
  readonly contentVersion: number;
  readonly engineerAccountId: number;
  readonly status: AiConversationStatus;
  readonly createdAt: Date;
}

/** 会话行锁事实：提交问题时用于串行化「校验状态 → 写入消息/分析」 */
export interface AiConversationLockSnapshot {
  readonly id: number;
  readonly requestId: number | null;
  readonly ownerOrganizationId: number | null;
  readonly contentVersion: number;
  readonly engineerAccountId: number;
  readonly status: AiConversationStatus;
}

/** 新建会话写入数据（公司、工程师、状态均由服务端事实决定） */
export interface AiConversationInsertData {
  readonly requestId: number | null;
  readonly ownerOrganizationId: number;
  readonly engineerAccountId: number;
}

/** 用户提问消息写入数据 */
export interface AiQuestionMessageInsertData {
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly messageSeq: number;
  readonly turnNo: number;
  readonly contentText: string;
  /** 本轮内容版本（与同轮分析、会话版本一致） */
  readonly contentVersion: number;
}

/** 问题消息快照（幂等判定与结果回读） */
export interface AiQuestionMessageSnapshot {
  readonly id: number;
  readonly conversationId: number;
  readonly questionUuid: string | null;
  readonly messageSeq: number;
  readonly turnNo: number | null;
  readonly contentText: string;
  readonly contentVersion: number;
  readonly createdAt: Date;
}

/** 分析记录写入数据（状态固定以 PENDING 起步，由写服务保证） */
export interface AiMessageAnalysisInsertData {
  readonly questionUuid: string;
  readonly conversationId: number;
  readonly questionMessageId: number;
  readonly contentVersion: number;
}

/** 分析记录快照 */
export interface AiMessageAnalysisSnapshot {
  readonly questionUuid: string;
  readonly conversationId: number;
  readonly questionMessageId: number;
  readonly answerMessageId: number | null;
  readonly status: AiMessageAnalysisStatus;
  readonly failureReason: string | null;
  readonly contentVersion: number;
  readonly savedAt: Date;
  readonly completedAt: Date | null;
}

/** 会话内消息快照（读侧统一结构） */
export interface AiMessageQueryResult {
  readonly id: number;
  readonly messageSeq: number;
  readonly turnNo: number | null;
  readonly role: AiMessageRole;
  readonly questionUuid: string | null;
  readonly contentText: string;
  readonly contentVersion: number;
  readonly createdAt: Date;
}

/**
 * 读侧可见性范围：
 * - `accountId`：当前会话账号（独立会话只归本人）；
 * - `organizationId`：可信公司（工单会话按本公司范围）。
 */
export interface AiConversationViewerScope {
  readonly accountId: number;
  readonly organizationId: number | null;
}

/** 列表分页（与统一分页策略对齐的 OFFSET 形态） */
export interface AiConversationListPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly withTotal: boolean;
}

/** 列表项（已装配申请编号与消息数，不含归属账号 ID） */
export interface AiConversationListItemQueryResult {
  readonly id: number;
  readonly requestId: number | null;
  readonly requestNo: string;
  readonly status: AiConversationStatus;
  readonly contentVersion: number;
  readonly messageCount: number;
  readonly lastMessageAt: Date | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface AiConversationListPage {
  readonly items: ReadonlyArray<AiConversationListItemQueryResult>;
  readonly total?: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * 关联工单的可关联性读取结果（AI 会话创建专用最小事实）。
 *
 * `trustedServiceOrganizationId` 与工单详情读侧同源：工单 `service_organization_id`
 * 与原始报修 intake 的 `service_organization_id` 一致时取该值，否则为 null。
 * 业务裁决（是否等于当前可信公司）归 usecase。
 */
export interface RepairRequestAssociationTarget {
  readonly id: number;
  readonly requestNo: string;
  readonly trustedServiceOrganizationId: number | null;
  readonly deletedAt: Date | null;
  readonly isHistorical: boolean;
}

/** 会话详情（含逐条消息与逐问题分析状态） */
export interface AiConversationDetailQueryResult {
  readonly id: number;
  readonly requestId: number | null;
  readonly requestNo: string;
  readonly status: AiConversationStatus;
  readonly contentVersion: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  /** 会话归属账号（导出展示用） */
  readonly ownerAccountId: number;
  /** 会话归属公司（导出与管理员范围核对用） */
  readonly ownerOrganizationId: number | null;
  readonly messages: ReadonlyArray<AiMessageQueryResult>;
  readonly analyses: ReadonlyArray<AiMessageAnalysisSnapshot>;
  /** 消息 ID → 轮次（分析记录经问题消息归位轮次；与管理员路径同源） */
  readonly messageTurnNos: ReadonlyMap<number, number | null>;
}

/**
 * 管理员读侧会话详情（S4）
 *
 * 与工程师可见性分离：一级管理员跨公司、二级管理员仅本公司；
 * 含归属账号与公司事实，供导出与只读详情复用同一授权边界。
 */
export interface AiConversationAdminDetailQueryResult {
  readonly id: number;
  readonly requestId: number | null;
  readonly requestNo: string;
  readonly status: AiConversationStatus;
  readonly contentVersion: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly ownerAccountId: number;
  readonly ownerOrganizationId: number | null;
  readonly messages: ReadonlyArray<AiMessageQueryResult>;
  readonly analyses: ReadonlyArray<AiMessageAnalysisSnapshot>;
  /** 消息 ID → 轮次（分析记录经问题消息归位轮次） */
  readonly messageTurnNos: ReadonlyMap<number, number | null>;
}

/** 回答消息写入数据（S2：正文与有效回答同次保存） */
export interface AiAnswerMessageInsertData {
  readonly conversationId: number;
  readonly messageSeq: number;
  readonly turnNo: number;
  readonly contentText: string;
  /** 与同轮问题消息、分析一致的内容版本 */
  readonly contentVersion: number;
}

/** 分析完成的写入数据（条件更新：仅 PENDING 且无回答时生效） */
export interface AiMessageAnalysisCompleteData {
  readonly questionUuid: string;
  readonly answerMessageId: number;
  readonly contentVersion: number;
  readonly completedAt: Date;
}

/** 工作流上下文所需的会话事实（派发时一次性快照） */
export interface AiConversationDispatchSnapshot {
  readonly conversationId: number;
  readonly requestId: number | null;
  readonly questionUuid: string;
  readonly questionText: string;
  readonly turnNo: number;
  readonly contentVersion: number;
  readonly engineerAccountId: number;
  readonly history: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly equipmentModelCode: string | null;
}

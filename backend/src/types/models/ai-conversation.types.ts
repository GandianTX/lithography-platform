// src/types/models/ai-conversation.types.ts
// AI 会话共享稳定枚举（PR3 定向 Review M-01 裁定）：
// 放共享类型层供 GraphQL adapter 注册正式枚举；Entity / Module / DTO 共用，不复制第二套，
// adapter 层不得运行时依赖 modules 实现。

/** AI 会话状态（数据库枚举值 ai_conversation.status：ACTIVE / COMPLETED） */
export enum AiConversationStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
}

/** AI 会话消息角色（数据库枚举值 ai_message.role：SYSTEM / USER / ASSISTANT / TOOL） */
export enum AiMessageRole {
  SYSTEM = 'SYSTEM',
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
  TOOL = 'TOOL',
}

/**
 * AI 问题分析状态（`ai_message_analysis.status` 的正式取值，列类型 varchar(16)）。
 *
 * - `PENDING`：问题与分析记录已同事务保存，等待派发执行；
 * - `RUNNING`：Worker 已领取并持有当前有效执行；
 * - `SUCCEEDED`：回答正文与成功状态已同次保存；
 * - `FAILED`：本轮执行失败（真实原因在 failure_reason）。
 *
 * 对外作为 GraphQL 正式枚举暴露，adapter 不得改用裸字符串。
 */
export enum AiMessageAnalysisStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

/**
 * AI 对话派发结果（S2）：描述「本次调用对派发的影响」，与轮次分析状态相互独立。
 *
 * - `QUEUED`：本次调用已把执行入队（含重试成功入队）；
 * - `DEFERRED`：已受理但本次未入队（队列不可用、已有在途执行或幂等回放）；
 * - `FAILED`：派发异常，本轮已标记为可重试失败。
 */
export enum AiConversationDispatchStatus {
  QUEUED = 'QUEUED',
  DEFERRED = 'DEFERRED',
  FAILED = 'FAILED',
}

/**
 * AI 对话回复工作流类型（Worker handler 注册名，S2）。
 *
 * 放共享类型层：ai-conversation 域（派发）与 ai-worker 域（消费 handler）
 * 共用同一注册名，避免跨域静态导入。
 */
export const AI_CONVERSATION_REPLY_WORKFLOW_TYPE = 'ai_conversation_reply';

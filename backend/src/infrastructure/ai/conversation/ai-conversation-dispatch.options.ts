// src/infrastructure/ai/conversation/ai-conversation-dispatch.options.ts
// 任务05 派发配置的 DI 契约（S2）：运行时配置读取只在 infrastructure wiring 完成，
// usecase 通过本 token 注入归一化后的选项（与 ADMIN_ACCOUNT_RESET_OPTIONS 同模式）。

export const AI_CONVERSATION_DISPATCH_OPTIONS = Symbol('AI_CONVERSATION_DISPATCH_OPTIONS');

export interface AiConversationDispatchOptions {
  /** 模型名（AI_CONVERSATION_MODEL，默认 qwen-plus） */
  readonly model: string;
  /** provider 标识（AI_CONVERSATION_PROVIDER，缺省 null 走注册表默认） */
  readonly provider: string | null;
}

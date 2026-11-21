// src/usecases/ai-conversation/ai-conversation-export-renderer.contract.ts

/**
 * AI 对话导出的渲染器端口（任务 05 · S4.2）。
 *
 * infrastructure 侧实现 PDF 渲染能力并通过该契约适配为 usecase 依赖；
 * 契约归 usecase 所有（能力决策属业务层），实现不反向依赖 usecase 实现。
 */
import type { AiExportSnapshot } from '@src/core/ai/ai-conversation-export.policy';

export interface AiConversationExportRenderer {
  renderPdf(snapshot: AiExportSnapshot): Promise<Buffer>;
}

/**
 * 渲染器端口的注入令牌。
 *
 * 端口是纯 TS 接口（运行时无值），不能直接作为 Nest 注入令牌；
 * infrastructure 侧以 `useExisting` 把适配器挂到该令牌上。
 */
export const AI_CONVERSATION_EXPORT_RENDERER = Symbol('AI_CONVERSATION_EXPORT_RENDERER');

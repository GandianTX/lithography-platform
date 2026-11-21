// src/infrastructure/ai/conversation/ai-conversation-model.types.ts
// 任务05 与模型侧的唯一接触面（S2）。
//
// 公共 RAG 诊断客户端（`RagDiagnosisClient`）已随主线合入，现由
// `RagAiConversationModelInvoker` 作为首选实现消费该公共能力；本契约保持不变，
// 只暴露「请求信封入 → 已校验正文/图形出」，替换实现不影响用例与 handler。

import type { GenerateAiContentResult } from '@src/core/ai/ai-provider.interface';

import type { AiConversationVisualization } from '@src/core/ai/ai-conversation-reply.policy';
import type { AiConversationRequestEnvelope } from '@src/core/ai/ai-conversation-request.policy';

export const AI_CONVERSATION_MODEL_INVOKER = Symbol('AI_CONVERSATION_MODEL_INVOKER');

export interface AiConversationModelInvokeInput {
  readonly request: AiConversationRequestEnvelope;
  readonly provider: string | null;
  readonly model: string;
  readonly metadata: {
    readonly workflowId: string;
    readonly workflowType: string;
    readonly traceId: string | null;
  };
}

export interface AiConversationModelInvokeResult {
  readonly text: string;
  readonly visualization: AiConversationVisualization | null;
  readonly visualizationDegraded: boolean;
  readonly provider: string;
  readonly model: string;
  readonly providerJobId: string | null;
  readonly providerRequestId: string | null;
  /** 原始 provider 调用结果（供 ai_provider_call_record 追溯）；夹具路径为 null */
  readonly generateResult: GenerateAiContentResult | null;
  /** 是否由开发夹具合成（mock 模式）；真实链路恒为 false */
  readonly devFixture: boolean;
}

export interface AiConversationModelInvoker {
  invoke(input: AiConversationModelInvokeInput): Promise<AiConversationModelInvokeResult>;
}

/**
 * 模型侧可辨识失败（不重试，由用户显式重试）。
 *
 * 只承载调用方需要诊断的短码（如公共客户端的 `TIMEOUT`／`SERVICE_UNAVAILABLE`），
 * 不携带原始响应、异常或用量；handler 据此写入 `failure_reason`。
 */
export class AiConversationModelFailureError extends Error {
  constructor(
    readonly failureCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiConversationModelFailureError';
  }
}

// src/infrastructure/ai/conversation/ai-conversation-rag.invoker.ts
// 任务05 模型调用器（S2，X01 收尾）：消费主线公共 RAG 诊断客户端。
//
// 职责：把已校验的对话请求信封映射为 `RagDiagnosisInput`，调用公共客户端一次，
// 再把结果映射回「已校验正文/图形」契约。请求构造、HTTP、解析与错误归类由公共层
// 负责（`@usecases/common/ports/rag-diagnosis-client.contract`），本文件不重复实现。
//
// 与直连 provider 路径的区别：
// - 不经过 `AiWorkerService.generate`，因此不产生 `ai_provider_call_record`；
// - 失败只上抛可辨识短码（`AiConversationModelFailureError`），不重试、不外泄原始载荷。

import { Inject, Injectable } from '@nestjs/common';

import {
  RAG_DIAGNOSIS_CLIENT,
  type RagDiagnosisClient,
  type RagDiagnosisInput,
  type RagDiagnosisVisualization,
} from '@usecases/common/ports/rag-diagnosis-client.contract';

import type { AiConversationVisualization } from '@src/core/ai/ai-conversation-reply.policy';

import {
  AiConversationModelFailureError,
  type AiConversationModelInvokeInput,
  type AiConversationModelInvokeResult,
  type AiConversationModelInvoker,
} from './ai-conversation-model.types';

/** 追溯用提供方标识：公共 RAG 诊断服务（非直连 provider） */
export const AI_CONVERSATION_RAG_PROVIDER = 'rag';

@Injectable()
export class RagAiConversationModelInvoker implements AiConversationModelInvoker {
  constructor(
    @Inject(RAG_DIAGNOSIS_CLIENT)
    private readonly client: RagDiagnosisClient,
  ) {}

  async invoke(input: AiConversationModelInvokeInput): Promise<AiConversationModelInvokeResult> {
    const result = await this.client.diagnose(toRagDiagnosisInput(input));

    if (!result.ok) {
      throw new AiConversationModelFailureError(result.code, `RAG 诊断调用失败：${result.code}`);
    }

    return {
      text: result.text,
      visualization: toConversationVisualization(result.visualization),
      // 公共契约：图形缺失或非法降级时为 null，正文仍可用
      visualizationDegraded: result.visualization === null,
      provider: AI_CONVERSATION_RAG_PROVIDER,
      model: input.model,
      providerJobId: null,
      providerRequestId: result.requestId,
      generateResult: null,
      devFixture: false,
    };
  }
}

/**
 * 信封 → 公共请求。
 *
 * 历史项字段不同：对话信封用 `content`，公共契约用 `text`；
 * requestId 保持稳定问题 UUID，供公共层回显核对。
 */
export function toRagDiagnosisInput(input: AiConversationModelInvokeInput): RagDiagnosisInput {
  return {
    requestId: input.request.requestId,
    question: input.request.question,
    history: input.request.history.map((item) => ({ role: item.role, text: item.content })),
    context: {
      mode: input.request.context.mode,
      equipmentModelCode: input.request.context.equipmentModelCode,
      stage: input.request.context.stage,
      fault: input.request.context.fault,
    },
  };
}

/** 公共图形 → 对话图形（部件白名单与展示态由公共层保证，此处只做结构复制） */
export function toConversationVisualization(
  visualization: RagDiagnosisVisualization | null,
): AiConversationVisualization | null {
  if (visualization === null) {
    return null;
  }
  return {
    sceneId: visualization.sceneId,
    stage: visualization.stage,
    parts: visualization.parts.map((part) => ({ partId: part.partId, display: part.display })),
  };
}

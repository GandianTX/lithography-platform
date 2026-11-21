// src/infrastructure/ai/conversation/ai-conversation-model.invoker.ts
// 任务05 临时模型适配器（S2）：真实 provider 路径。
//
// 职责：把请求信封序列化交给既有 `AiWorkerService.generate`，再按 03/04 样例
// 的回复信封做严格校验（正文失败关闭、图形非法只降级）。
// 局限（已在 S0 X01 登记）：03 的共用入口合入后，本文件应被其实现替换；
// 在此之前 prompt 即请求 JSON 文本，真实模型需按约定返回回复 JSON。

import { Injectable } from '@nestjs/common';

import { parseAiConversationReply } from '@src/core/ai/ai-conversation-reply.policy';
import { AiWorkerService } from '../ai-worker.service';

import type {
  AiConversationModelInvokeInput,
  AiConversationModelInvokeResult,
  AiConversationModelInvoker,
} from './ai-conversation-model.types';

@Injectable()
export class RemoteAiConversationModelInvoker implements AiConversationModelInvoker {
  constructor(private readonly aiWorkerService: AiWorkerService) {}

  async invoke(input: AiConversationModelInvokeInput): Promise<AiConversationModelInvokeResult> {
    const generateResult = await this.aiWorkerService.generate({
      provider: input.provider ?? undefined,
      model: input.model,
      prompt: JSON.stringify(input.request),
      metadata: {
        workflowId: input.metadata.workflowId,
        workflowType: input.metadata.workflowType,
        traceId: input.metadata.traceId ?? '',
      },
    });

    const parsed = parseAiConversationReply(generateResult.outputText, input.request.requestId);

    return {
      text: parsed.text,
      visualization: parsed.visualization,
      visualizationDegraded: parsed.visualizationDegraded,
      provider: generateResult.provider,
      model: generateResult.model,
      providerJobId: generateResult.providerJobId ?? null,
      providerRequestId: generateResult.providerRequestId ?? null,
      generateResult,
      devFixture: false,
    };
  }
}

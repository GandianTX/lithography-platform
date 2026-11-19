// src/infrastructure/ai/conversation/ai-conversation-model.fixture.ts
// 任务05 开发夹具适配器（仅 `AI_PROVIDER_MODE=mock` 生效）。
//
// 目的：在无真实模型端点时，让 S2 的「解析 → 保存 → 图形通道」链路可端到端验证。
// 该实现**不调用 provider**，也**不写入 provider 调用记录**；正文显式带夹具前缀，
// 避免被误认为真实模型输出。真实链路走 `RemoteAiConversationModelInvoker`。

import { Injectable, Logger } from '@nestjs/common';

import {
  AI_VISUALIZATION_DISPLAYS,
  AI_VISUALIZATION_PART_IDS,
  parseAiConversationReply,
} from '@src/core/ai/ai-conversation-reply.policy';
import { AI_CONVERSATION_SCENE_ID } from '@src/core/ai/ai-conversation-request.policy';

import type {
  AiConversationModelInvokeInput,
  AiConversationModelInvokeResult,
  AiConversationModelInvoker,
} from './ai-conversation-model.types';

const FIXTURE_PREFIX = '【开发夹具｜非真实模型输出】';
const FIXTURE_HIGHLIGHT_PART = 'reticle_arm';

@Injectable()
export class FixtureAiConversationModelInvoker implements AiConversationModelInvoker {
  private readonly logger = new Logger(FixtureAiConversationModelInvoker.name);

  invoke(input: AiConversationModelInvokeInput): Promise<AiConversationModelInvokeResult> {
    this.logger.warn(
      {
        workflowId: input.metadata.workflowId,
        requestId: input.request.requestId,
        reason: 'DEV_FIXTURE_REPLY',
      },
      'AI 对话使用开发夹具回复（mock 模式），不得作为真实模型证据',
    );

    const stage = input.request.context.stage;
    const raw = JSON.stringify({
      schemaVersion: 1,
      requestId: input.request.requestId,
      content: {
        text: [
          `${FIXTURE_PREFIX}已收到问题：${input.request.question}`,
          `上下文：模式 ${input.request.context.mode}；机型 ${
            input.request.context.equipmentModelCode ?? '未关联'
          }；阶段 ${stage ?? '未指定'}；历史 ${input.request.history.length} 条。`,
          '请按现场规程核对相关部件状态，并记录报警原文与可复现性。',
        ].join('\n'),
        ...(stage === null
          ? {}
          : {
              visualization: {
                sceneId: AI_CONVERSATION_SCENE_ID,
                stage,
                parts: AI_VISUALIZATION_PART_IDS.map((partId) => ({
                  partId,
                  display:
                    partId === FIXTURE_HIGHLIGHT_PART
                      ? AI_VISUALIZATION_DISPLAYS[2]
                      : AI_VISUALIZATION_DISPLAYS[0],
                })),
              },
            }),
      },
    });

    // 夹具同样走正式解析器，保证解析/降级路径在开发环境被执行
    const parsed = parseAiConversationReply(raw, input.request.requestId);

    return Promise.resolve({
      text: parsed.text,
      visualization: parsed.visualization,
      visualizationDegraded: parsed.visualizationDegraded,
      provider: 'mock',
      model: input.model,
      providerJobId: null,
      providerRequestId: null,
      generateResult: null,
      devFixture: true,
    });
  }
}

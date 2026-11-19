// src/modules/common/ai-worker/ai-worker.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiInfrastructureModule } from '@src/infrastructure/ai/ai-infrastructure.module';
import { AiCapabilityModule } from '../ai-capability/ai-capability.module';
import { AiWorkerService } from './ai-worker.service';
import { AI_PROVIDER_REGISTRY_OPTIONS, type AiProviderRegistryOptions } from './ai-worker.options';
import { FixtureAiConversationModelInvoker } from './conversation/ai-conversation-model.fixture';
import { RemoteAiConversationModelInvoker } from './conversation/ai-conversation-model.invoker';
import {
  AI_CONVERSATION_MODEL_INVOKER,
  type AiConversationModelInvoker,
} from './conversation/ai-conversation-model.types';
import { RagAiConversationModelInvoker } from './conversation/ai-conversation-rag.invoker';
import { AiProviderRegistry } from './providers/ai-provider-registry';

@Module({
  imports: [AiCapabilityModule, AiInfrastructureModule],
  providers: [
    {
      provide: AI_PROVIDER_REGISTRY_OPTIONS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): AiProviderRegistryOptions => ({
        providerMode: configService.get<string>('aiWorker.providerMode', 'mock'),
      }),
    },
    AiWorkerService,
    AiProviderRegistry,
    RemoteAiConversationModelInvoker,
    FixtureAiConversationModelInvoker,
    RagAiConversationModelInvoker,
    {
      // 任务05 模型入口三选一：
      // 1. `AI_PROVIDER_MODE=mock`：开发夹具（显式告警、不写 provider 调用记录）；
      // 2. `LITHO_RAG_MODE=remote` 且 URL／密钥齐全：公共 RAG 诊断客户端（X01 收尾）；
      // 3. 其余：既有直连 provider + 严格信封校验（历史真实链路与无 RAG 环境保持可用）。
      provide: AI_CONVERSATION_MODEL_INVOKER,
      inject: [
        ConfigService,
        RagAiConversationModelInvoker,
        RemoteAiConversationModelInvoker,
        FixtureAiConversationModelInvoker,
      ],
      useFactory: (
        configService: ConfigService,
        rag: RagAiConversationModelInvoker,
        remote: RemoteAiConversationModelInvoker,
        fixture: FixtureAiConversationModelInvoker,
      ): AiConversationModelInvoker =>
        selectAiConversationModelInvoker(configService, { rag, remote, fixture }),
    },
  ],
  exports: [AiWorkerService, AI_CONVERSATION_MODEL_INVOKER],
})
export class AiWorkerModule {}

/** 三种模型实现的候选集合（顺序仅用于阅读，选择由 `selectAiConversationModelInvoker` 决定） */
export type AiConversationModelInvokerCandidates = Readonly<{
  rag: AiConversationModelInvoker;
  remote: AiConversationModelInvoker;
  fixture: AiConversationModelInvoker;
}>;

/**
 * 选择对话模型入口。
 *
 * 1. `AI_PROVIDER_MODE=mock`：开发夹具；
 * 2. `LITHO_RAG_MODE=remote` 且 URL／密钥齐全：公共 RAG 诊断客户端；
 * 3. 其余：既有直连 provider。
 */
export function selectAiConversationModelInvoker(
  configService: ConfigService,
  candidates: AiConversationModelInvokerCandidates,
): AiConversationModelInvoker {
  const providerMode = configService.get<string>('aiWorker.providerMode', 'mock').toLowerCase();
  if (providerMode === 'mock') {
    return candidates.fixture;
  }
  return isRagDiagnosisEnabled(configService) ? candidates.rag : candidates.remote;
}

/**
 * 公共 RAG 客户端是否可实际调用。
 *
 * 只有显式 `LITHO_RAG_MODE=remote` 且 URL／密钥齐全才切到公共客户端；
 * 未配置或 `disabled` 时保留既有直连 provider，避免无 RAG 环境整体不可用
 * （生产环境的配置完整性由 `config.module` 的预检负责）。
 */
function isRagDiagnosisEnabled(configService: ConfigService): boolean {
  const mode = configService.get<string>('ragDiagnosis.mode', 'remote').toLowerCase();
  if (mode !== 'remote') {
    return false;
  }
  const baseUrl = configService.get<string>('ragDiagnosis.baseUrl', '');
  const apiKey = configService.get<string>('ragDiagnosis.apiKey', '');
  return baseUrl.length > 0 && apiKey.length > 0;
}

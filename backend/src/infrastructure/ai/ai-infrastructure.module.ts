import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AI_RAW_JSON_EXPORT_AUTHORIZATION } from '@src/usecases/ai-conversation/ai-conversation-export-authorization.contract';
import { RAG_DIAGNOSIS_CLIENT } from '@usecases/common/ports/rag-diagnosis-client.contract';

import {
  AI_CONVERSATION_DISPATCH_OPTIONS,
  type AiConversationDispatchOptions,
} from './conversation/ai-conversation-dispatch.options';
import { AiConversationExportAdapter } from './conversation/ai-conversation-export.adapter';
import { AI_CONVERSATION_EXPORT_RENDERER } from '@src/usecases/ai-conversation/ai-conversation-export-renderer.contract';
import { LocalMockAiProvider } from './providers/local/local-mock-ai.provider';
import { OpenAiGenerateProvider } from './providers/openai/openai-generate.provider';
import { QwenGenerateProvider } from './providers/qwen/qwen-generate.provider';
import { RagDiagnosisHttpClient } from './rag/rag-diagnosis-http.client';

const AI_CONVERSATION_DISPATCH_OPTIONS_PROVIDER = {
  provide: AI_CONVERSATION_DISPATCH_OPTIONS,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AiConversationDispatchOptions => ({
    model: config.get<string>('aiConversation.model', 'qwen-plus'),
    provider: config.get<string | null>('aiConversation.provider', null),
  }),
};

/**
 * 受控原始 JSON 导出的技术授权凭据。
 *
 * 未配置时为空字符串：受控导出按「无授权」失败关闭（不放行）。
 */
const AI_RAW_JSON_EXPORT_AUTHORIZATION_PROVIDER = {
  provide: AI_RAW_JSON_EXPORT_AUTHORIZATION,
  inject: [ConfigService],
  useFactory: (config: ConfigService): string =>
    config.get<string>('aiConversation.export.rawJsonAuthorization', ''),
};

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [
    LocalMockAiProvider,
    OpenAiGenerateProvider,
    QwenGenerateProvider,
    RagDiagnosisHttpClient,
    {
      provide: RAG_DIAGNOSIS_CLIENT,
      useExisting: RagDiagnosisHttpClient,
    },
    AI_CONVERSATION_DISPATCH_OPTIONS_PROVIDER,
    AI_RAW_JSON_EXPORT_AUTHORIZATION_PROVIDER,
    AiConversationExportAdapter,
    {
      provide: AI_CONVERSATION_EXPORT_RENDERER,
      useExisting: AiConversationExportAdapter,
    },
  ],
  exports: [
    LocalMockAiProvider,
    OpenAiGenerateProvider,
    QwenGenerateProvider,
    RAG_DIAGNOSIS_CLIENT,
    AI_CONVERSATION_DISPATCH_OPTIONS,
    AI_RAW_JSON_EXPORT_AUTHORIZATION,
    AiConversationExportAdapter,
    AI_CONVERSATION_EXPORT_RENDERER,
  ],
})
export class AiInfrastructureModule {}

import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { RAG_DIAGNOSIS_CLIENT } from '@usecases/common/ports/rag-diagnosis-client.contract';
import { LocalMockAiProvider } from './providers/local/local-mock-ai.provider';
import { OpenAiGenerateProvider } from './providers/openai/openai-generate.provider';
import { QwenGenerateProvider } from './providers/qwen/qwen-generate.provider';
import { RagDiagnosisHttpClient } from './rag/rag-diagnosis-http.client';

@Module({
  imports: [HttpModule],
  providers: [
    LocalMockAiProvider,
    OpenAiGenerateProvider,
    QwenGenerateProvider,
    RagDiagnosisHttpClient,
    {
      provide: RAG_DIAGNOSIS_CLIENT,
      useExisting: RagDiagnosisHttpClient,
    },
  ],
  exports: [
    LocalMockAiProvider,
    OpenAiGenerateProvider,
    QwenGenerateProvider,
    RAG_DIAGNOSIS_CLIENT,
  ],
})
export class AiInfrastructureModule {}

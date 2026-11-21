// src/modules/ai-workflow-context/ai-workflow-context.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AI_CONVERSATION_EXECUTION_LOOKUP } from '@src/usecases/common/ports/ai-conversation-execution.contract';
import { AiConversationExecutionLookupProvider } from './ai-conversation-execution-lookup.provider';
import { AiWorkflowContextEntity } from './ai-workflow-context.entity';
import { AiWorkflowContextService } from './ai-workflow-context.service';
import { AiWorkflowCapabilityAnchor } from './ai-workflow.capability';

@Module({
  imports: [TypeOrmModule.forFeature([AiWorkflowContextEntity])],
  providers: [
    AiWorkflowCapabilityAnchor,
    AiWorkflowContextService,
    AiConversationExecutionLookupProvider,
    {
      provide: AI_CONVERSATION_EXECUTION_LOOKUP,
      useExisting: AiConversationExecutionLookupProvider,
    },
  ],
  // F11：执行身份端口随数据 owner 一起导出，API 侧与 Worker 侧消费同一个装配边界
  exports: [TypeOrmModule, AiWorkflowContextService, AI_CONVERSATION_EXECUTION_LOOKUP],
})
export class AiWorkflowContextModule {}

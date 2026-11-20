import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { AiProviderCallRecordModule } from '@src/modules/ai-provider-call-record/ai-provider-call-record.module';
import { AiWorkflowContextModule } from '@src/modules/ai-workflow-context/ai-workflow-context.module';
import { AiWorkflowQueueModule } from '@src/modules/ai-workflow-context/queue/ai-workflow-queue.module';
import { AsyncTaskRecordModule } from '@src/modules/async-task-record/async-task-record.module';
import { AiInfrastructureModule } from '@src/infrastructure/ai/ai-infrastructure.module';
import { AiConversationVisualizationModule } from '@src/infrastructure/ai/conversation/ai-conversation-visualization.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { AiWorkerModule } from '@src/modules/common/ai-worker/ai-worker.module';
import { AiConversationReplyWorkflowHandler } from './ai-conversation-reply-workflow.handler';
import { AiWorkflowHandlerRegistry } from './ai-workflow-handler.registry';
import { AiWorkflowWorkerActivationUsecase } from './ai-workflow-worker-activation.usecase';
import { ConsumeAiWorkflowJobUsecase } from './consume-ai-workflow-job.usecase';
import { GenericTextGenerateWorkflowHandler } from './generic-text-generate-workflow.handler';

@Module({
  imports: [
    DiscoveryModule,
    AiWorkerModule,
    AccountInstallerModule,
    AiInfrastructureModule,
    AiConversationVisualizationModule,
    LithographyModule,
    AsyncTaskRecordModule,
    AiProviderCallRecordModule,
    AiWorkflowContextModule,
    AiWorkflowQueueModule,
    // F11：执行身份端口（AI_CONVERSATION_EXECUTION_LOOKUP）由 AiWorkflowContextModule 导出，
    // Worker 侧只导入数据 owner 模块，不跨域导入 ai-workflow 用例模块
  ],
  providers: [
    ConsumeAiWorkflowJobUsecase,
    AiWorkflowHandlerRegistry,
    GenericTextGenerateWorkflowHandler,
    AiConversationReplyWorkflowHandler,
    AiWorkflowWorkerActivationUsecase,
  ],
  exports: [AiWorkflowWorkerActivationUsecase, ConsumeAiWorkflowJobUsecase],
})
export class AiWorkflowWorkerUsecasesModule {}

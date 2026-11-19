// src/usecases/ai-workflow/ai-workflow-usecases.module.ts

import { Module } from '@nestjs/common';
import { AiWorkflowContextModule } from '@src/modules/ai-workflow-context/ai-workflow-context.module';
import { AiWorkflowQueueModule } from '@src/modules/ai-workflow-context/queue/ai-workflow-queue.module';
import { AsyncTaskRecordModule } from '@src/modules/async-task-record/async-task-record.module';
import { AI_CONVERSATION_EXECUTION_LOOKUP } from '@src/usecases/common/ports/ai-conversation-execution.contract';
import { AI_WORKFLOW_ADMISSION_PORT } from '@src/usecases/common/ports/ai-workflow-admission.contract';
import { AiConversationExecutionLookupAdapter } from './ai-conversation-execution-lookup.adapter';
import { AiWorkflowAdmissionAdapter } from './ai-workflow-admission.adapter';
import { CreateAndAdmitAiWorkflowUsecase } from './create-and-admit-ai-workflow.usecase';
import { RunAiWorkflowHousekeepingUsecase } from './run-ai-workflow-housekeeping.usecase';

@Module({
  imports: [AiWorkflowContextModule, AiWorkflowQueueModule, AsyncTaskRecordModule],
  providers: [
    CreateAndAdmitAiWorkflowUsecase,
    RunAiWorkflowHousekeepingUsecase,
    AiWorkflowAdmissionAdapter,
    AiConversationExecutionLookupAdapter,
    {
      provide: AI_WORKFLOW_ADMISSION_PORT,
      useExisting: AiWorkflowAdmissionAdapter,
    },
    {
      provide: AI_CONVERSATION_EXECUTION_LOOKUP,
      useExisting: AiConversationExecutionLookupAdapter,
    },
  ],
  exports: [
    CreateAndAdmitAiWorkflowUsecase,
    RunAiWorkflowHousekeepingUsecase,
    AI_WORKFLOW_ADMISSION_PORT,
    AI_CONVERSATION_EXECUTION_LOOKUP,
  ],
})
export class AiWorkflowUsecasesModule {}

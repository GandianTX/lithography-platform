// src/usecases/ai-workflow/ai-workflow-usecases.module.ts

import { Module } from '@nestjs/common';
import { AiWorkflowContextModule } from '@src/modules/ai-workflow-context/ai-workflow-context.module';
import { AiWorkflowQueueModule } from '@src/modules/ai-workflow-context/queue/ai-workflow-queue.module';
import { AsyncTaskRecordModule } from '@src/modules/async-task-record/async-task-record.module';
import { AI_WORKFLOW_ADMISSION_PORT } from '@src/usecases/common/ports/ai-workflow-admission.contract';
import { AiWorkflowAdmissionAdapter } from './ai-workflow-admission.adapter';
import { CreateAndAdmitAiWorkflowUsecase } from './create-and-admit-ai-workflow.usecase';
import { RunAiWorkflowHousekeepingUsecase } from './run-ai-workflow-housekeeping.usecase';

@Module({
  imports: [AiWorkflowContextModule, AiWorkflowQueueModule, AsyncTaskRecordModule],
  providers: [
    CreateAndAdmitAiWorkflowUsecase,
    RunAiWorkflowHousekeepingUsecase,
    AiWorkflowAdmissionAdapter,
    {
      provide: AI_WORKFLOW_ADMISSION_PORT,
      useExisting: AiWorkflowAdmissionAdapter,
    },
  ],
  // F11：执行身份端口（AI_CONVERSATION_EXECUTION_LOOKUP）由 AiWorkflowContextModule 单点提供并导出，
  // 本模块不再重复注册，避免同一端口出现两个装配来源
  exports: [
    CreateAndAdmitAiWorkflowUsecase,
    RunAiWorkflowHousekeepingUsecase,
    AI_WORKFLOW_ADMISSION_PORT,
  ],
})
export class AiWorkflowUsecasesModule {}

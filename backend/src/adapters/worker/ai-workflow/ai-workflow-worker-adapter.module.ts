import { Module } from '@nestjs/common';
import { AiConversationRecoveryModule } from '@src/usecases/ai-conversation/ai-conversation-recovery.module';
import { AiWorkflowUsecasesModule } from '@src/usecases/ai-workflow/ai-workflow-usecases.module';
import { AiWorkflowWorkerUsecasesModule } from '@src/usecases/ai-worker/ai-workflow-worker-usecases.module';
import { AiWorkflowJobHandler } from './ai-workflow-job.handler';
import { AiWorkflowJobProcessor } from './ai-workflow-job.processor';
import { AiWorkflowRecoveryScheduler } from './ai-workflow-recovery.scheduler';

@Module({
  imports: [
    AiWorkflowWorkerUsecasesModule,
    // 恢复编排：准入重投／准入超时收敛（工作流侧）
    AiWorkflowUsecasesModule,
    // 恢复编排：执行终止后的 analysis 补写（业务侧，只暴露这一个补偿服务）
    AiConversationRecoveryModule,
  ],
  providers: [AiWorkflowJobHandler, AiWorkflowJobProcessor, AiWorkflowRecoveryScheduler],
})
export class AiWorkflowWorkerAdapterModule {}

// src/bootstraps/api/api-workflow-admission.module.ts
// API 组合根装配（任务05 S2）：把 ai-workflow 域的受理适配器
// 以全局端口 `AI_WORKFLOW_ADMISSION_PORT` 暴露给所有域模块，
// 使 ai-conversation 等域无需跨域导入 ai-workflow 实现。
// 与 TypeOrmTransactionModule（TRANSACTION_RUNNER）同模式：组合根装配 + @Global。

import { Global, Module } from '@nestjs/common';

import { AI_WORKFLOW_ADMISSION_PORT } from '@src/usecases/common/ports/ai-workflow-admission.contract';
import { AiWorkflowAdmissionAdapter } from '@src/usecases/ai-workflow/ai-workflow-admission.adapter';
import { AiWorkflowUsecasesModule } from '@src/usecases/ai-workflow/ai-workflow-usecases.module';

@Global()
@Module({
  imports: [AiWorkflowUsecasesModule],
  providers: [
    AiWorkflowAdmissionAdapter,
    {
      provide: AI_WORKFLOW_ADMISSION_PORT,
      useExisting: AiWorkflowAdmissionAdapter,
    },
  ],
  exports: [AI_WORKFLOW_ADMISSION_PORT],
})
export class ApiWorkflowAdmissionModule {}

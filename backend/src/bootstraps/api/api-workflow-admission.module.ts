// src/bootstraps/api/api-workflow-admission.module.ts
// API 组合根装配（任务05 S2）：把 ai-workflow 域的受理适配器
// 以全局端口 `AI_WORKFLOW_ADMISSION_PORT` 暴露给所有域模块，
// 使 ai-conversation 等域无需跨域导入 ai-workflow 实现。
// 与 TypeOrmTransactionModule（TRANSACTION_RUNNER）同模式：组合根装配 + @Global。
//
// 同时再导出 `AiWorkflowContextModule`：执行身份端口
// `AI_CONVERSATION_EXECUTION_LOOKUP`（数据 owner 为该模块）在 API 侧仍供读取方使用。
//
// 2026-11-20 纠偏：API 侧不再有「受理后未投递自愈」——恢复已改为 Worker 生命周期
// 驱动（`AiWorkflowRecoveryScheduler`），状态查询只读。此处保留端口装配仅用于
// 只读查询，不得再在读路径上触发投递或写 analysis。

import { Global, Module } from '@nestjs/common';

import { AiWorkflowContextModule } from '@src/modules/ai-workflow-context/ai-workflow-context.module';
import { AI_WORKFLOW_ADMISSION_PORT } from '@src/usecases/common/ports/ai-workflow-admission.contract';
import { AiWorkflowAdmissionAdapter } from '@src/usecases/ai-workflow/ai-workflow-admission.adapter';
import { AiWorkflowUsecasesModule } from '@src/usecases/ai-workflow/ai-workflow-usecases.module';

@Global()
@Module({
  imports: [AiWorkflowUsecasesModule, AiWorkflowContextModule],
  providers: [
    AiWorkflowAdmissionAdapter,
    {
      provide: AI_WORKFLOW_ADMISSION_PORT,
      useExisting: AiWorkflowAdmissionAdapter,
    },
  ],
  // 端口由 AiWorkflowContextModule 导出：这里以「再导出模块」的方式传递，
  // Nest 不允许直接再导出一个仅由导入模块提供的 token（UnknownExportException）
  exports: [AI_WORKFLOW_ADMISSION_PORT, AiWorkflowContextModule],
})
export class ApiWorkflowAdmissionModule {}

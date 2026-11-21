// src/usecases/ai-conversation/ai-conversation-recovery.module.ts
// 任务05 Q01／S2.1-6 纠偏：把「执行终止后的 analysis 收敛」作为独立能力暴露给
// 正式运行入口（Worker 生命周期），而不是挂在 API 的状态查询上。
//
// 为什么单独一个模块：Worker 只需要这一个补偿服务，不应把整个 05 API 用例图
// （导出、管理员只读等）拉进 Worker 进程；依赖也只需要数据 owner 模块提供的
// 执行身份端口与连表服务。

import { Module } from '@nestjs/common';

import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { AiWorkflowContextModule } from '@src/modules/ai-workflow-context/ai-workflow-context.module';
import { AiQuestionAnalysisSettlementService } from './ai-question-analysis-settlement.service';

@Module({
  imports: [LithographyModule, AiWorkflowContextModule],
  providers: [AiQuestionAnalysisSettlementService],
  exports: [AiQuestionAnalysisSettlementService],
})
export class AiConversationRecoveryModule {}

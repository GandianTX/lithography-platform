// src/usecases/ai-conversation/ai-conversation-usecases.module.ts

import { Module } from '@nestjs/common';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { DispatchAiQuestionUsecase } from './dispatch-ai-question.usecase';
import { RetryAiQuestionUsecase } from './retry-ai-question.usecase';
import { AiInfrastructureModule } from '@src/infrastructure/ai/ai-infrastructure.module';
import { AiConversationVisualizationModule } from '@src/infrastructure/ai/conversation/ai-conversation-visualization.module';
import { CreateAiConversationUsecase } from './create-ai-conversation.usecase';
import { AiConversationSnapshotService } from './ai-conversation-snapshot.service';
import { ExportAiConversationUsecase } from './export-ai-conversation.usecase';
import { GetAiConversationEvaluationScopeUsecase } from './get-ai-conversation-evaluation-scope.usecase';
import { GetAiAdminConversationDetailUsecase } from './get-ai-admin-conversation-detail.usecase';
import { GetAiQuestionStatusUsecase } from './get-ai-question-status.usecase';
import { GetMyAiConversationDetailUsecase } from './get-my-ai-conversation-detail.usecase';
import { ListMyAiConversationsUsecase } from './list-my-ai-conversations.usecase';
import { SubmitAiQuestionUsecase } from './submit-ai-question.usecase';

/**
 * AI 对话（任务 05）工程师侧用例模块。
 *
 * S1 读写用例 + S2 派发与重试用例 + S4 导出与管理员只读用例。
 */
@Module({
  imports: [
    LithographyModule,
    AccountInstallerModule,
    AiInfrastructureModule,
    AiConversationVisualizationModule,
  ],
  providers: [
    CreateAiConversationUsecase,
    ListMyAiConversationsUsecase,
    GetMyAiConversationDetailUsecase,
    SubmitAiQuestionUsecase,
    GetAiQuestionStatusUsecase,
    DispatchAiQuestionUsecase,
    RetryAiQuestionUsecase,
    AiConversationSnapshotService,
    ExportAiConversationUsecase,
    GetAiConversationEvaluationScopeUsecase,
    GetAiAdminConversationDetailUsecase,
  ],
  exports: [
    CreateAiConversationUsecase,
    ListMyAiConversationsUsecase,
    GetMyAiConversationDetailUsecase,
    SubmitAiQuestionUsecase,
    GetAiQuestionStatusUsecase,
    DispatchAiQuestionUsecase,
    RetryAiQuestionUsecase,
    AiConversationSnapshotService,
    ExportAiConversationUsecase,
    GetAiConversationEvaluationScopeUsecase,
    GetAiAdminConversationDetailUsecase,
  ],
})
export class AiConversationUsecasesModule {}

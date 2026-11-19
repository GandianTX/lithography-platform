// src/usecases/ai-workflow/ai-conversation-execution-lookup.adapter.ts
// 跨域端口适配器（ai-workflow 域）：把通用工作流上下文的只读查询
// 适配为 `AI_CONVERSATION_EXECUTION_LOOKUP`，供 ai-conversation 判定当前执行。

import { Injectable } from '@nestjs/common';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AiWorkflowContextService } from '@src/modules/ai-workflow-context/ai-workflow-context.service';
import type { AiConversationExecutionLookupPort } from '@src/usecases/common/ports/ai-conversation-execution.contract';

@Injectable()
export class AiConversationExecutionLookupAdapter implements AiConversationExecutionLookupPort {
  constructor(private readonly workflowContextService: AiWorkflowContextService) {}

  async findLatestWorkflowIdByBizTarget(input: {
    readonly bizType: string;
    readonly bizSubKey: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<string | null> {
    return await this.workflowContextService.findLatestWorkflowIdByBizTarget(input);
  }
}

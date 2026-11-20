// src/modules/ai-workflow-context/ai-conversation-execution-lookup.provider.ts
// 任务05 F11：执行身份端口的提供方与数据 owner 放在一起。
//
// 背景：`AI_CONVERSATION_EXECUTION_LOOKUP` 的实现只依赖 `AiWorkflowContextService`，
// 由 ai-workflow 用例模块注册时，ai-worker 用例模块必须跨域导入该模块（违反用例层同域规则），
// 漏导入则 Worker 启动即抛 UnknownDependenciesException（F11 / G1）。
// 因此把提供方下沉到数据 owner 模块 `AiWorkflowContextModule`，由它导出端口 token，
// 消费方（API 侧与 Worker 侧）只导入同一个装配边界，不再跨域组合用例模块。

import { Injectable } from '@nestjs/common';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type {
  AiConversationActiveExecution,
  AiConversationExecutionLookupPort,
  AiConversationLatestExecution,
  AiConversationTerminatedExecution,
} from '@src/usecases/common/ports/ai-conversation-execution.contract';

import { AiWorkflowContextService } from './ai-workflow-context.service';

@Injectable()
export class AiConversationExecutionLookupProvider implements AiConversationExecutionLookupPort {
  constructor(private readonly workflowContextService: AiWorkflowContextService) {}

  async findActiveExecutionByBizTarget(input: {
    readonly workflowType: string;
    readonly bizType: string;
    readonly bizSubKey: string;
    readonly transactionContext?: PersistenceTransactionContext;
    readonly forUpdate?: boolean;
  }): Promise<AiConversationActiveExecution | null> {
    const context = await this.workflowContextService.findActiveByBizTarget(input);
    if (!context) {
      return null;
    }
    return toExecutionSummary(context);
  }

  async findLatestExecutionByBizTarget(input: {
    readonly workflowType: string;
    readonly bizType: string;
    readonly bizSubKey: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiConversationLatestExecution | null> {
    const context = await this.workflowContextService.findLatestByBizTarget(input);
    return context ? toExecutionSummary(context) : null;
  }

  async listTerminalExecutionsSince(input: {
    readonly workflowType: string;
    readonly updatedSince: Date;
    readonly limit: number;
  }): Promise<readonly AiConversationTerminatedExecution[]> {
    const contexts = await this.workflowContextService.listTerminalByTypeSince(input);
    return contexts.flatMap((context) =>
      context.bizSubKey === null
        ? []
        : [
            {
              workflowId: context.workflowId,
              bizSubKey: context.bizSubKey,
              status: context.status,
              updatedAt: context.updatedAt,
            },
          ],
    );
  }
}

function toExecutionSummary(context: {
  readonly workflowId: string;
  readonly status: string;
  readonly jobId: string | null;
  readonly nextEnqueueAt: Date | null;
  readonly admissionExpiresAt: Date | null;
}): AiConversationActiveExecution {
  return {
    workflowId: context.workflowId,
    status: context.status,
    jobId: context.jobId,
    nextEnqueueAt: context.nextEnqueueAt,
    admissionExpiresAt: context.admissionExpiresAt,
  };
}

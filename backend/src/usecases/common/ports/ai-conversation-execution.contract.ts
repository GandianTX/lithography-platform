// src/usecases/common/ports/ai-conversation-execution.contract.ts
// 任务05 F04：当前有效执行判定所需的窄端口。
//
// 背景：同一问题 UUID 在重试后会启动新的工作流执行；UUID 只保证问题幂等，
// 不能区分「哪次执行」。通用工作流上下文表已按业务目标（biz_type／biz_sub_key）
// 记录每次执行，因此由 ai-workflow 域提供一个只读查询，避免 05 直接读取该表。
//
// 直接调用方：`AiConversationReplyWorkflowHandler`（模型调用前与写回事务内各校验一次）。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

export const AI_CONVERSATION_EXECUTION_LOOKUP = Symbol('AI_CONVERSATION_EXECUTION_LOOKUP');

export interface AiConversationExecutionLookupPort {
  /**
   * 该业务子键（问题 UUID）最近创建的工作流执行 ID。
   *
   * @returns 无记录时返回 null（调用方按「无法证明当前执行」失败关闭）
   */
  findLatestWorkflowIdByBizTarget(input: {
    readonly bizType: string;
    readonly bizSubKey: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<string | null>;
}

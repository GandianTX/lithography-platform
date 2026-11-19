// src/usecases/ai-conversation/engineer-conversation-access.guard.ts
// 任务05 F01：工程师会话写入前的当前资源复核（提问／重试共用）。
//
// 事务内完成：当前可信公司 → 会话锁快照 → 关联工单当前事实 → 统一判定。
// 判定规则见 `@core/ai/engineer-conversation-access.policy`，与读侧 SQL 等价。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { canWriteEngineerConversation } from '@core/ai/engineer-conversation-access.policy';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import type { AiConversationLockSnapshot } from '@src/modules/lithography/ai-conversation.types';
import type { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';

/**
 * 校验工程师对会话的写权限（含当前公司与工单资源事实）。
 *
 * 不校验会话状态：`ACTIVE` 由调用方判定，以便区分「已结束」与「不可见」。
 * 拒绝口径统一为 `NOT_FOUND`，不泄露资源是否存在。
 */
export async function assertEngineerConversationWritable(params: {
  readonly conversation: AiConversationLockSnapshot;
  readonly accountId: number;
  readonly organizationId: number;
  readonly repairRequestQueryService: RepairRequestQueryService;
  readonly transactionContext: PersistenceTransactionContext;
  readonly actionLabel: string;
}): Promise<void> {
  const { conversation } = params;

  const requestFacts =
    conversation.requestId === null
      ? null
      : await params.repairRequestQueryService.findAssociationTarget({
          requestId: conversation.requestId,
          transactionContext: params.transactionContext,
        });

  const allowed = canWriteEngineerConversation({
    requestId: conversation.requestId,
    conversationOwnerAccountId: conversation.engineerAccountId,
    conversationOwnerOrganizationId: conversation.ownerOrganizationId,
    viewerAccountId: params.accountId,
    viewerOrganizationId: params.organizationId,
    requestFacts:
      requestFacts === null
        ? null
        : {
            deletedAt: requestFacts.deletedAt,
            trustedServiceOrganizationId: requestFacts.trustedServiceOrganizationId,
          },
  });

  if (!allowed) {
    throw new DomainError(
      AI_CONVERSATION_ERROR.NOT_FOUND,
      `AI 会话不存在或无权${params.actionLabel}`,
      { conversationId: conversation.id },
    );
  }
}

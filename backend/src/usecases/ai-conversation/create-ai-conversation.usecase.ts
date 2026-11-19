// src/usecases/ai-conversation/create-ai-conversation.usecase.ts

import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  CreateAiConversationCommand,
  CreateAiConversationResult,
} from './create-ai-conversation.types';
import {
  assertEngineerAiPermission,
  resolveEngineerTrustedOrganization,
} from './engineer-ai-access';

/**
 * 创建 AI 会话用例（R033）
 *
 * 流程：
 * 1. 资格断言：仅 activeRole=ENGINEER；
 * 2. 事务内解析可信公司（无归属/角色不符失败关闭）；
 * 3. 关联工单时用与工单详情同源的「可信服务公司」口径校验，
 *    外公司、已删除、历史工单一律拒绝（关联创建后固定，不允许改挂）；
 * 4. 落库：独立会话 `request_id = null`，关联会话固定来源工单。
 */
@Injectable()
export class CreateAiConversationUsecase {
  constructor(
    private readonly aiConversationService: AiConversationService,
    private readonly repairRequestQueryService: RepairRequestQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: CreateAiConversationCommand): Promise<CreateAiConversationResult> {
    assertEngineerAiPermission(command.session, '创建');

    if (
      command.requestId !== null &&
      (!Number.isInteger(command.requestId) || command.requestId <= 0)
    ) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '关联工单 ID 无效', {
        requestId: command.requestId,
      });
    }

    return this.transactionRunner.run(async (transactionContext) => {
      const organizationId = await resolveEngineerTrustedOrganization({
        organizationContextService: this.organizationContextService,
        accountId: command.session.accountId,
        transactionContext,
      });

      let requestId: number | null = null;
      let requestNo = '';
      if (command.requestId !== null) {
        const target = await this.repairRequestQueryService.findAssociationTarget({
          requestId: command.requestId,
          transactionContext,
        });
        if (
          target === null ||
          target.deletedAt !== null ||
          target.isHistorical ||
          target.trustedServiceOrganizationId === null ||
          target.trustedServiceOrganizationId !== organizationId
        ) {
          throw new DomainError(
            AI_CONVERSATION_ERROR.WORK_ORDER_NOT_ASSOCIABLE,
            '该维修申请不存在或不属于当前公司，无法关联 AI 会话',
            { requestId: command.requestId },
          );
        }
        requestId = target.id;
        requestNo = target.requestNo;
      }

      const snapshot = await this.aiConversationService.insertConversation(
        {
          requestId,
          ownerOrganizationId: organizationId,
          engineerAccountId: command.session.accountId,
        },
        transactionContext,
      );

      return {
        id: snapshot.id,
        requestId: snapshot.requestId,
        requestNo,
        status: snapshot.status,
        contentVersion: snapshot.contentVersion,
        createdAt: snapshot.createdAt,
      };
    });
  }
}

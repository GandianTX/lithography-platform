// src/usecases/ai-conversation/list-my-ai-conversations.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  applyDefaults,
  enforceMaxPageSize,
  isOffsetMode,
} from '@core/pagination/pagination.policy';
import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import type { AiConversationListPage } from '@src/modules/lithography/ai-conversation.types';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { assertEngineerAiPermission } from './engineer-ai-access';

/** 页大小上限：与 GraphQL 边界 `PaginationArgs` 的 @Max(100) 对齐 */
const MAX_PAGE_SIZE = 100;

/**
 * 工程师查询本人有权 AI 会话列表用例（R036-01）
 *
 * - 范围只来自服务端：独立会话仅本人；工单会话限本公司且工单未删除；
 * - 无可信公司时仍可查看本人独立会话，不因缺公司把列表整体拒绝；
 * - 查询无副作用：不重算模型、不改写任何消息或状态。
 */
@Injectable()
export class ListMyAiConversationsUsecase {
  constructor(
    private readonly aiConversationQueryService: AiConversationQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    pagination: PaginationParams;
  }): Promise<AiConversationListPage> {
    assertEngineerAiPermission(params.session, '查看');

    if (!isOffsetMode(params.pagination)) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, 'AI 会话列表仅支持 OFFSET 分页', {
        mode: params.pagination.mode,
      });
    }
    const { page, pageSize, withTotal } = enforceMaxPageSize(
      applyDefaults(params.pagination, {}),
      MAX_PAGE_SIZE,
    ) as OffsetParams;

    // 无有效成员关系时 organizationId 为 null：只返回本人独立会话，不伪造公司范围
    const organizationFact = await this.organizationContextService.tryResolveForAccount({
      accountId: params.session.accountId,
    });

    return this.aiConversationQueryService.listVisible({
      viewer: {
        accountId: params.session.accountId,
        organizationId: organizationFact?.organizationId ?? null,
      },
      pagination: { page, pageSize, withTotal: withTotal ?? false },
    });
  }
}

// src/usecases/admin-document-database/list-admin-ai-messages.usecase.ts

import { DomainError, ADMIN_DOCUMENT_DATABASE_ERROR } from '@core/common/errors/domain-error';
import {
  applyDefaults,
  enforceMaxPageSize,
  isOffsetMode,
} from '@core/pagination/pagination.policy';
import { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { assertAiAdminConversationReadAccess } from '@core/ai/ai-conversation-read-access.policy';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminAiMessageListPage } from '@src/modules/lithography/admin-document-database.types';
import { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import { AdminAiMessageQueryService } from '@src/modules/lithography/queries/admin-ai-message.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  resolveAdminAiConversationIdentity,
  resolveAdminAiConversationScope,
} from './admin-ai-conversation-scope';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 管理员按会话读取 AI 消息列表用例（PR3 只读聚合，会话详情入口）
 *
 * - 精确授权先行：activeRole === SUPER_ADMIN（失败关闭）
 * - 组织范围：一级跨公司、二级仅本公司；直传外公司会话 ID 按「无权访问」拒绝，
 *   不返回外公司消息（与列表过滤同一口径）
 * - 消息顺序由契约冻结：messageSeq ASC, id ASC（QueryService 固定，不接受客户端排序），
 *   支持满 100 轮会话的完整顺序读取（分页覆盖）
 * - 会话不存在时返回空页（分页语义），由页面呈现空态，不伪造会话事实
 */
@Injectable()
export class ListAdminAiMessagesUsecase {
  constructor(
    private readonly adminAiMessageQueryService: AdminAiMessageQueryService,
    private readonly adminAiConversationQueryService: AdminAiConversationQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    conversationId: number;
    pagination: PaginationParams;
  }): Promise<AdminAiMessageListPage> {
    await resolveAdminAiConversationScope({
      session: params.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    if (!Number.isInteger(params.conversationId) || params.conversationId <= 0) {
      throw new DomainError(ADMIN_DOCUMENT_DATABASE_ERROR.INVALID_PARAMS, '会话 ID 无效', {
        conversationId: params.conversationId,
      });
    }

    if (!isOffsetMode(params.pagination)) {
      throw new DomainError(
        ADMIN_DOCUMENT_DATABASE_ERROR.INVALID_PARAMS,
        '管理员文档数据库列表仅支持 OFFSET 分页',
        { mode: params.pagination.mode },
      );
    }
    const { page, pageSize, withTotal } = enforceMaxPageSize(
      applyDefaults(params.pagination, {}),
      MAX_PAGE_SIZE,
    ) as OffsetParams;

    // 会话归属校验：范围外的会话按「无权访问」拒绝（不泄露会话是否存在）
    const ownership = await this.adminAiConversationQueryService.findOwnershipFacts(
      params.conversationId,
    );
    if (ownership !== null) {
      const admin = await resolveAdminAiConversationIdentity({
        session: params.session,
        accountQueryService: this.accountQueryService,
        organizationContextService: this.organizationContextService,
      });
      assertAiAdminConversationReadAccess({
        admin,
        conversation: {
          ownerAccountId: ownership.ownerAccountId,
          ownerOrganizationId: ownership.ownerOrganizationId,
        },
      });
    }

    return this.adminAiMessageQueryService.listByConversation({
      conversationId: params.conversationId,
      pagination: { page, pageSize, withTotal: withTotal ?? false },
    });
  }
}

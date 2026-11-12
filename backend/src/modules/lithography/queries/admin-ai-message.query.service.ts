// src/modules/lithography/queries/admin-ai-message.query.service.ts

import { DomainError, ADMIN_DOCUMENT_DATABASE_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AiMessageEntity } from '../entities/ai-message.entity';
import type { AdminAiMessageListPage, AdminListPagination } from '../admin-document-database.types';

/** 消息固定排序（契约冻结）：messageSeq 升序，主键升序——会话内稳定顺序的唯一口径 */
const MESSAGE_ORDER = { messageSeq: 'ASC', id: 'ASC' } as const;

/**
 * 管理员 AI 消息读侧查询服务（PR3 只读聚合）
 *
 * 职责范围：
 * - 按会话维度读取消息列表（稳定排序 + OFFSET 分页；消息正文即详情内容）
 *
 * 不包含（计划表 S2 分层边界）：
 * - 任何写入操作，不改既有 (conversationId, messageSeq) 唯一约束；
 * - 角色准入判定（由守卫与 usecase 的管理员权限断言决策）；
 * - 跨域读取（消息表无跨域展示字段，无需富集）。
 */
@Injectable()
export class AdminAiMessageQueryService {
  constructor(
    @InjectRepository(AiMessageEntity)
    private readonly messageRepository: Repository<AiMessageEntity>,
    @InjectRepository(AiConversationEntity)
    private readonly conversationRepository: Repository<AiConversationEntity>,
  ) {}

  /**
   * 按会话读取消息列表。
   *
   * - 会话不存在：返回空页（保持既有分页语义）；
   * - 传入 ownerOrganizationId 且会话归属不同：统一 NOT_FOUND，与报告详情口径一致，
   *   不泄露其他公司会话是否存在。
   */
  async listByConversation(params: {
    conversationId: number;
    ownerOrganizationId?: number;
    pagination: AdminListPagination;
  }): Promise<AdminAiMessageListPage> {
    if (typeof params.ownerOrganizationId === 'number') {
      const conversation = await this.conversationRepository.findOne({
        where: { id: params.conversationId },
        select: { id: true, ownerOrganizationId: true },
      });
      if (conversation && conversation.ownerOrganizationId !== params.ownerOrganizationId) {
        throw new DomainError(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND, 'AI 会话不存在或不可访问', {
          conversationId: params.conversationId,
        });
      }
    }
    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);
    const where = { conversationId: params.conversationId };

    const [entities, total] = await Promise.all([
      this.messageRepository.find({
        where,
        order: MESSAGE_ORDER,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      params.pagination.withTotal
        ? this.messageRepository.count({ where })
        : Promise.resolve(undefined),
    ]);

    return {
      items: entities.map((entity) => ({
        id: entity.id,
        conversationId: entity.conversationId,
        messageSeq: entity.messageSeq,
        turnNo: entity.turnNo,
        role: entity.role,
        contentText: entity.contentText,
        createdAt: entity.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }
}

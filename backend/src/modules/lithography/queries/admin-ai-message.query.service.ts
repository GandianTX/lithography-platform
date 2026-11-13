// src/modules/lithography/queries/admin-ai-message.query.service.ts

import { DomainError, ADMIN_DOCUMENT_DATABASE_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AiMessageEntity } from '../entities/ai-message.entity';
import type { AdminAiMessageListPage, AdminListPagination } from '../admin-document-database.types';

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
   * - 传入 ownerOrganizationId（二级管理员）时，会话查找与消息查询都带同一可信组织范围：
   *   查不到（不存在或无权）一律返回相同的 NOT_FOUND，不区分“存在但无权”和“不存在”；
   * - 本公司存在但无消息的会话返回成功空页；
   * - 未传入组织范围（一级管理员）保持原有分页语义。
   */
  async listByConversation(params: {
    conversationId: number;
    ownerOrganizationId?: number;
    pagination: AdminListPagination;
  }): Promise<AdminAiMessageListPage> {
    if (typeof params.ownerOrganizationId === 'number') {
      const conversation = await this.conversationRepository.findOne({
        where: {
          id: params.conversationId,
          ownerOrganizationId: params.ownerOrganizationId,
        },
        select: { id: true },
      });
      if (!conversation) {
        throw new DomainError(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND, 'AI 会话不存在或不可访问', {
          conversationId: params.conversationId,
        });
      }
    }
    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);

    const [entities, total] = await Promise.all([
      this.buildMessageQuery(params.conversationId, params.ownerOrganizationId)
        .orderBy('message.messageSeq', 'ASC')
        .addOrderBy('message.id', 'ASC')
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .getMany(),
      params.pagination.withTotal
        ? this.buildMessageQuery(params.conversationId, params.ownerOrganizationId).getCount()
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

  /**
   * 消息查询始终限定在目标会话；二级管理员额外关联会话归属组织，
   * 使实际消息读取与前置存在性判断使用同一组织范围。
   */
  private buildMessageQuery(
    conversationId: number,
    ownerOrganizationId?: number,
  ): SelectQueryBuilder<AiMessageEntity> {
    const qb = this.messageRepository
      .createQueryBuilder('message')
      .where('message.conversationId = :conversationId', { conversationId });
    if (typeof ownerOrganizationId === 'number') {
      qb.innerJoin(
        AiConversationEntity,
        'conversation',
        'conversation.id = message.conversationId',
      ).andWhere('conversation.ownerOrganizationId = :ownerOrganizationId', {
        ownerOrganizationId,
      });
    }
    return qb;
  }
}

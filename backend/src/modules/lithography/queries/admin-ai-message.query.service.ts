// src/modules/lithography/queries/admin-ai-message.query.service.ts

import { parseAiMessageAnalysisStatus } from '@core/ai/ai-message-analysis-status.policy';
import type { AiMessageAnalysisStatus } from '@app-types/models/ai-conversation.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiMessageAnalysisEntity } from '../entities/ai-message-analysis.entity';
import { AiMessageEntity } from '../entities/ai-message.entity';
import type { AdminAiMessageListPage, AdminListPagination } from '../admin-document-database.types';

/** 消息固定排序（契约冻结）：messageSeq 升序，主键升序——会话内稳定顺序的唯一口径 */
const MESSAGE_ORDER = { messageSeq: 'ASC', id: 'ASC' } as const;

/**
 * 管理员 AI 消息读侧查询服务（PR3 只读聚合）
 *
 * 职责范围：
 * - 按会话维度读取消息列表（稳定排序 + OFFSET 分页；消息正文即详情内容）
 * - 装配消息所属轮次的分析状态与失败原因（问题消息与回答消息都归属同一轮）
 *
 * 不包含（计划表 S2 分层边界）：
 * - 任何写入操作，不改既有 (conversationId, messageSeq) 唯一约束；
 * - 角色准入判定与公司范围裁决（由守卫与 usecase 的授权策略决策）；
 * - 跨域读取（消息表无跨域展示字段，无需富集）。
 */
@Injectable()
export class AdminAiMessageQueryService {
  constructor(
    @InjectRepository(AiMessageEntity)
    private readonly messageRepository: Repository<AiMessageEntity>,
    @InjectRepository(AiMessageAnalysisEntity)
    private readonly analysisRepository: Repository<AiMessageAnalysisEntity>,
  ) {}

  /**
   * 按会话读取消息列表。会话不存在时返回空页（分页语义），由页面呈现空态。
   */
  async listByConversation(params: {
    conversationId: number;
    pagination: AdminListPagination;
  }): Promise<AdminAiMessageListPage> {
    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);
    const where = { conversationId: params.conversationId };

    const [entities, analyses, total] = await Promise.all([
      this.messageRepository.find({
        where,
        order: MESSAGE_ORDER,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.analysisRepository.find({ where: { conversationId: params.conversationId } }),
      params.pagination.withTotal
        ? this.messageRepository.count({ where })
        : Promise.resolve(undefined),
    ]);

    // 轮次状态归位：问题消息与回答消息都取同一轮的分析状态与失败原因
    const analysisByQuestionMessageId = new Map<
      number,
      { status: AiMessageAnalysisStatus; failureReason: string | null }
    >();
    const analysisByAnswerMessageId = new Map<
      number,
      { status: AiMessageAnalysisStatus; failureReason: string | null }
    >();
    for (const analysis of analyses) {
      const fact = {
        status: parseAiMessageAnalysisStatus(analysis.status),
        failureReason: analysis.failureReason,
      };
      analysisByQuestionMessageId.set(analysis.questionMessageId, fact);
      if (analysis.answerMessageId !== null) {
        analysisByAnswerMessageId.set(analysis.answerMessageId, fact);
      }
    }

    return {
      items: entities.map((entity) => {
        const analysis =
          analysisByQuestionMessageId.get(entity.id) ??
          analysisByAnswerMessageId.get(entity.id) ??
          null;
        return {
          id: entity.id,
          conversationId: entity.conversationId,
          messageSeq: entity.messageSeq,
          turnNo: entity.turnNo,
          role: entity.role,
          contentText: entity.contentText,
          contentVersion: entity.contentVersion,
          analysisStatus: analysis?.status ?? null,
          failureReason: analysis?.failureReason ?? null,
          createdAt: entity.createdAt,
        };
      }),
      total,
      page,
      pageSize,
    };
  }
}

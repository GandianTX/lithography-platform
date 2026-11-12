// src/modules/lithography/queries/admin-ai-conversation.query.service.ts

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';
import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AiMessageEntity } from '../entities/ai-message.entity';
import { AiReportEntity } from '../entities/ai-report.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import type {
  AdminAiConversationListItemQueryResult,
  AdminAiConversationListPage,
  AdminAiConversationQueryFilter,
  AdminListPagination,
} from '../admin-document-database.types';

/** LIKE 通配符转义，避免用户输入 % / _ 意外扩大匹配范围 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 管理员 AI 会话读侧查询服务（PR3 只读聚合）
 *
 * 职责范围：
 * - 全局 AI 会话列表（分页 + 编号/状态/时间范围筛选，含关联申请编号筛选）
 * - 会话维度的消息数 / 报告数批量统计（GROUP BY 聚合，不加载明细行）
 *
 * 不包含（计划表 S2 分层边界）：
 * - 任何写入操作；
 * - 角色准入判定（由守卫与 usecase 的管理员权限断言决策）；
 * - 跨账户域读取（工程师展示信息不在此富集：装配结果仅携带账号 ID，
 *   由 usecase 经账户域 QueryService 批量富集后对外输出）。
 *
 * 实现说明：requestNo 筛选经本域 repair_request 关联（AI 会话与维修申请同属
 * lithography 域，不构成跨域），全部筛选保持在 SQL 侧执行以保证分页正确性。
 */
@Injectable()
export class AdminAiConversationQueryService {
  constructor(
    @InjectRepository(AiConversationEntity)
    private readonly conversationRepository: Repository<AiConversationEntity>,
    @InjectRepository(AiMessageEntity)
    private readonly messageRepository: Repository<AiMessageEntity>,
    @InjectRepository(AiReportEntity)
    private readonly reportRepository: Repository<AiReportEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
  ) {}

  /**
   * 全局列表：固定排序，OFFSET 分页。账号 ID 集合筛选由 usecase 解析后传入；
   * 空集合在进入查询前短路，不产生空 IN 查询。
   */
  async listAll(params: {
    filter?: AdminAiConversationQueryFilter;
    pagination: AdminListPagination;
  }): Promise<
    Omit<AdminAiConversationListPage, 'items'> & { items: AdminAiConversationListItemQueryResult[] }
  > {
    const filter = params.filter;
    if (filter?.engineerAccountIds && filter.engineerAccountIds.length === 0) {
      return this.emptyPage(params.pagination);
    }

    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);

    const qb = this.conversationRepository
      .createQueryBuilder('conversation')
      .leftJoin(RepairRequestEntity, 'request', 'request.id = conversation.requestId')
      .orderBy('conversation.createdAt', 'DESC')
      .addOrderBy('conversation.id', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    this.applyFilters(qb, filter);

    const [entities, total] = await Promise.all([
      qb.getMany(),
      params.pagination.withTotal ? this.countByFilter(filter) : Promise.resolve(undefined),
    ]);

    return {
      items: await this.toListItemQueryResults(entities),
      total,
      page,
      pageSize,
    };
  }

  /** 管理员统计：AI 会话总数（传入组织时只统计该归属组织） */
  async countAll(ownerOrganizationId?: number): Promise<number> {
    if (typeof ownerOrganizationId !== 'number') {
      return this.conversationRepository.count();
    }
    return this.conversationRepository.count({ where: { ownerOrganizationId } });
  }

  private applyFilters(
    qb: SelectQueryBuilder<AiConversationEntity>,
    filter?: AdminAiConversationQueryFilter,
  ): void {
    if (!filter) {
      return;
    }
    if (filter.requestNo) {
      const pattern = `%${escapeLikePattern(filter.requestNo)}%`;
      qb.andWhere('request.requestNo LIKE :requestNoPattern', { requestNoPattern: pattern });
    }
    if (filter.engineerAccountIds) {
      qb.andWhere('conversation.engineerAccountId IN (:...engineerAccountIds)', {
        engineerAccountIds: [...filter.engineerAccountIds],
      });
    }
    if (filter.status) {
      qb.andWhere('conversation.status = :status', { status: filter.status });
    }
    if (filter.createdAtFrom || filter.createdAtTo) {
      qb.andWhere(
        new Brackets((where) => {
          where.where('conversation.createdAt >= :createdAtFrom', {
            createdAtFrom: filter.createdAtFrom ?? new Date(0),
          });
          where.andWhere('conversation.createdAt <= :createdAtTo', {
            createdAtTo: filter.createdAtTo ?? new Date(),
          });
        }),
      );
    }
  }

  private countByFilter(filter?: AdminAiConversationQueryFilter): Promise<number> {
    const qb = this.conversationRepository
      .createQueryBuilder('conversation')
      .leftJoin(RepairRequestEntity, 'request', 'request.id = conversation.requestId');
    this.applyFilters(qb, filter);
    return qb.getCount();
  }

  private emptyPage(pagination: AdminListPagination): Omit<AdminAiConversationListPage, 'items'> & {
    items: AdminAiConversationListItemQueryResult[];
  } {
    return {
      items: [],
      total: pagination.withTotal ? 0 : undefined,
      page: Math.max(pagination.page, 1),
      pageSize: Math.max(pagination.pageSize, 1),
    };
  }

  /**
   * 批量装配列表项：关联申请编号一次批量读取；消息数/报告数按会话维度
   * GROUP BY 聚合统计，不加载明细行。
   */
  private async toListItemQueryResults(
    entities: AiConversationEntity[],
  ): Promise<AdminAiConversationListItemQueryResult[]> {
    if (entities.length === 0) {
      return [];
    }

    const requestIds = [...new Set(entities.map((entity) => entity.requestId))].filter(
      (requestId): requestId is number => requestId !== null,
    );
    const conversationIds = entities.map((entity) => entity.id);

    const [requests, messageCounts, reportCounts] = await Promise.all([
      this.requestRepository.find({
        where: { id: In(requestIds) },
        select: { id: true, requestNo: true },
      }),
      this.countByConversationIds(this.messageRepository, conversationIds),
      this.countByConversationIds(this.reportRepository, conversationIds),
    ]);

    const requestNoByRequestId = new Map(
      requests.map((request) => [request.id, request.requestNo]),
    );

    return entities.map((entity) => ({
      id: entity.id,
      requestId: entity.requestId,
      requestNo:
        entity.requestId === null ? '' : (requestNoByRequestId.get(entity.requestId) ?? ''),
      engineerAccountId: entity.engineerAccountId,
      status: entity.status,
      aiFeedback: entity.aiFeedback,
      createdAt: entity.createdAt,
      completedAt: entity.completedAt,
      messageCount: messageCounts.get(entity.id) ?? 0,
      reportCount: reportCounts.get(entity.id) ?? 0,
    }));
  }

  /** 按会话维度 GROUP BY 计数（count 由驱动返回，统一收敛为 number） */
  private async countByConversationIds<T extends { conversationId: number }>(
    repository: Repository<T>,
    conversationIds: number[],
  ): Promise<Map<number, number>> {
    if (conversationIds.length === 0) {
      return new Map();
    }
    const rows: { conversationId: number | string; count: string | number }[] = await repository
      .createQueryBuilder('countEntity')
      .select('countEntity.conversationId', 'conversationId')
      .addSelect('COUNT(*)', 'count')
      .where('countEntity.conversationId IN (:...conversationIds)', { conversationIds })
      .groupBy('countEntity.conversationId')
      .getRawMany();
    const countMap = new Map<number, number>();
    for (const row of rows) {
      countMap.set(Number(row.conversationId), Number(row.count));
    }
    return countMap;
  }
}

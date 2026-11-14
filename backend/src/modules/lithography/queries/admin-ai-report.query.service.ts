// src/modules/lithography/queries/admin-ai-report.query.service.ts

import { DomainError, ADMIN_DOCUMENT_DATABASE_ERROR } from '@core/common/errors/domain-error';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';
import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AiReportEntity } from '../entities/ai-report.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import type {
  AdminAiReportDetailQueryResult,
  AdminAiReportListItemQueryResult,
  AdminAiReportListPage,
  AdminAiReportQueryFilter,
  AdminListPagination,
} from '../admin-document-database.types';

/** LIKE 通配符转义，避免用户输入 % / _ 意外扩大匹配范围 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 管理员 AI 报告读侧查询服务（PR3 只读聚合）
 *
 * 职责范围：
 * - 全局 AI 报告列表（分页 + 编号/类型/时间范围筛选；不投影正文大字段）
 * - 单条报告详情（含正文 contentMd，只读）
 * - 管理员统计总数
 *
 * 不包含（计划表 S2 分层边界）：
 * - 任何写入操作，不改既有 (conversationId, reportType) 唯一约束；
 * - 角色准入判定（由守卫与 usecase 的管理员权限断言决策）；
 * - 跨账户域读取（工程师展示信息不在此富集：装配结果仅携带账号 ID，
 *   由 usecase 经账户域 QueryService 批量富集后对外输出）。
 *
 * 实现说明：requestNo 展示与筛选均以会话归属申请为权威（PR3 定向 Review
 * M-04 裁定：报告由会话产出，报告自身 requestId 仅作审计展示），关联链为
 * report → conversation → repair_request；报告记录的申请与会话归属不一致时
 * 输出 requestMismatch 审计标记并记录警告日志，不静默改写。
 */
@Injectable()
export class AdminAiReportQueryService {
  private readonly logger = new Logger(AdminAiReportQueryService.name);

  constructor(
    @InjectRepository(AiReportEntity)
    private readonly reportRepository: Repository<AiReportEntity>,
    @InjectRepository(AiConversationEntity)
    private readonly conversationRepository: Repository<AiConversationEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
  ) {}

  /**
   * 全局列表：固定排序，OFFSET 分页；列表不投影 contentMd 大字段。
   * 账号 ID 集合筛选由 usecase 解析后传入；空集合在进入查询前短路。
   */
  async listAll(params: {
    filter?: AdminAiReportQueryFilter;
    pagination: AdminListPagination;
  }): Promise<
    Omit<AdminAiReportListPage, 'items'> & { items: AdminAiReportListItemQueryResult[] }
  > {
    const filter = params.filter;
    if (filter?.engineerAccountIds && filter.engineerAccountIds.length === 0) {
      return this.emptyPage(params.pagination);
    }

    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);

    const qb = this.reportRepository
      .createQueryBuilder('report')
      .leftJoin(AiConversationEntity, 'conversation', 'conversation.id = report.conversationId')
      .leftJoin(RepairRequestEntity, 'request', 'request.id = conversation.requestId')
      .orderBy('report.createdAt', 'DESC')
      .addOrderBy('report.id', 'DESC')
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

  /**
   * 单条报告详情（含正文）。
   * 不存在统一 NOT_FOUND（不区分「不存在」与其他不可访问原因）。
   *
   * @throws DomainError ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND（对外大类 NOT_FOUND）
   */
  async findDetailById(reportId: number): Promise<AdminAiReportDetailQueryResult> {
    const entity = await this.reportRepository.findOne({ where: { id: reportId } });
    if (!entity) {
      throw new DomainError(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND, 'AI 报告不存在或不可访问', {
        reportId,
      });
    }

    const conversation = await this.conversationRepository.findOne({
      where: { id: entity.conversationId },
      select: { id: true, requestId: true },
    });
    // 权威申请取会话归属；会话缺失等极端情况回落报告自身申请（不因关联缺失整体不可读）
    const authoritativeRequestId = conversation?.requestId ?? entity.requestId;
    const request = await this.requestRepository.findOne({
      where: { id: authoritativeRequestId },
      select: { id: true, requestNo: true },
    });

    if (conversation && conversation.requestId !== entity.requestId) {
      this.logger.warn('AI 报告与所属会话的维修申请归属不一致', {
        reportId: entity.id,
        conversationId: entity.conversationId,
        reportRequestId: entity.requestId,
        conversationRequestId: conversation.requestId,
      });
    }

    return {
      id: entity.id,
      requestId: entity.requestId,
      requestNo: request?.requestNo ?? '',
      requestMismatch: conversation ? conversation.requestId !== entity.requestId : false,
      conversationId: entity.conversationId,
      engineerAccountId: entity.engineerAccountId,
      reportTitle: entity.reportTitle,
      reportType: entity.reportType,
      contentMd: entity.contentMd,
      createdAt: entity.createdAt,
    };
  }

  /** 管理员统计：全局 AI 报告总数 */
  async countAll(): Promise<number> {
    return this.reportRepository.count();
  }

  private applyFilters(
    qb: SelectQueryBuilder<AiReportEntity>,
    filter?: AdminAiReportQueryFilter,
  ): void {
    if (!filter) {
      return;
    }
    if (filter.requestNo) {
      const pattern = `%${escapeLikePattern(filter.requestNo)}%`;
      qb.andWhere('request.requestNo LIKE :requestNoPattern', { requestNoPattern: pattern });
    }
    if (filter.engineerAccountIds) {
      qb.andWhere('report.engineerAccountId IN (:...engineerAccountIds)', {
        engineerAccountIds: [...filter.engineerAccountIds],
      });
    }
    if (filter.reportType) {
      qb.andWhere('report.reportType = :reportType', { reportType: filter.reportType });
    }
    if (filter.createdAtFrom || filter.createdAtTo) {
      qb.andWhere(
        new Brackets((where) => {
          where.where('report.createdAt >= :createdAtFrom', {
            createdAtFrom: filter.createdAtFrom ?? new Date(0),
          });
          where.andWhere('report.createdAt <= :createdAtTo', {
            createdAtTo: filter.createdAtTo ?? new Date(),
          });
        }),
      );
    }
  }

  private countByFilter(filter?: AdminAiReportQueryFilter): Promise<number> {
    const qb = this.reportRepository
      .createQueryBuilder('report')
      .leftJoin(AiConversationEntity, 'conversation', 'conversation.id = report.conversationId')
      .leftJoin(RepairRequestEntity, 'request', 'request.id = conversation.requestId');
    this.applyFilters(qb, filter);
    return qb.getCount();
  }

  private emptyPage(
    pagination: AdminListPagination,
  ): Omit<AdminAiReportListPage, 'items'> & { items: AdminAiReportListItemQueryResult[] } {
    return {
      items: [],
      total: pagination.withTotal ? 0 : undefined,
      page: Math.max(pagination.page, 1),
      pageSize: Math.max(pagination.pageSize, 1),
    };
  }

  /**
   * 批量装配列表项：权威申请编号按 report → conversation → repair_request
   * 链批量读取；关联不一致记录审计日志并以 requestMismatch 标记。
   */
  private async toListItemQueryResults(
    entities: AiReportEntity[],
  ): Promise<AdminAiReportListItemQueryResult[]> {
    if (entities.length === 0) {
      return [];
    }

    const conversationIds = [...new Set(entities.map((entity) => entity.conversationId))];
    const conversations = await this.conversationRepository.find({
      where: { id: In(conversationIds) },
      select: { id: true, requestId: true },
    });
    const conversationById = new Map(conversations.map((row) => [row.id, row]));

    const authoritativeRequestIds = [
      ...new Set(
        entities.map(
          (entity) => conversationById.get(entity.conversationId)?.requestId ?? entity.requestId,
        ),
      ),
    ];
    const requests = await this.requestRepository.find({
      where: { id: In(authoritativeRequestIds) },
      select: { id: true, requestNo: true },
    });
    const requestNoByRequestId = new Map(
      requests.map((request) => [request.id, request.requestNo]),
    );

    return entities.map((entity) => {
      const conversation = conversationById.get(entity.conversationId);
      if (conversation && conversation.requestId !== entity.requestId) {
        this.logger.warn('AI 报告与所属会话的维修申请归属不一致', {
          reportId: entity.id,
          conversationId: entity.conversationId,
          reportRequestId: entity.requestId,
          conversationRequestId: conversation.requestId,
        });
      }
      const authoritativeRequestId = conversation?.requestId ?? entity.requestId;
      return {
        id: entity.id,
        requestId: entity.requestId,
        requestNo: requestNoByRequestId.get(authoritativeRequestId) ?? '',
        requestMismatch: conversation ? conversation.requestId !== entity.requestId : false,
        conversationId: entity.conversationId,
        engineerAccountId: entity.engineerAccountId,
        reportTitle: entity.reportTitle,
        reportType: entity.reportType,
        createdAt: entity.createdAt,
      };
    });
  }
}

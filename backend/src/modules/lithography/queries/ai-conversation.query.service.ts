// src/modules/lithography/queries/ai-conversation.query.service.ts

import type { AiConversationStatus } from '@app-types/models/ai-conversation.types';
import { parseAiMessageAnalysisStatus } from '@core/ai/ai-message-analysis-status.policy';
import type { AiAdminConversationScope } from '@core/ai/ai-conversation-read-access.policy';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';
import type {
  AiConversationAdminDetailQueryResult,
  AiConversationDetailQueryResult,
  AiConversationListItemQueryResult,
  AiConversationListPage,
  AiConversationListPagination,
  AiMessageAnalysisSnapshot,
  AiMessageQueryResult,
  AiConversationViewerScope,
} from '../ai-conversation.types';
import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AiMessageAnalysisEntity } from '../entities/ai-message-analysis.entity';
import { AiMessageEntity } from '../entities/ai-message.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';

/**
 * 工程师侧 AI 会话读侧查询服务（任务 05）
 *
 * 可见性口径（R036-01／R036-02，F01 修订）：
 * - 独立会话（`request_id IS NULL`）**仅会话发起工程师本人**可见；
 * - 工单会话必须同时满足：固定归属公司 = 当前可信公司、工单未软删，
 *   且工单当前**可信服务公司**（`service_organization_id` 与 intake 一致）
 *   也等于当前可信公司；同公司互看私人会话被本条排除。
 *   该判定与 `@core/ai/engineer-conversation-access.policy` 等价，两处须同步。
 *
 * 职责范围：列表装配（申请编号、消息数、最后消息时间）、详情装配（逐条消息、
 * 逐问题分析状态）。
 *
 * 不包含：任何写入；公司归属解析与角色裁决（归 usecase）；错误口径（不可见返回
 * null／空页，由 usecase 决定是否拒绝）。
 */
@Injectable()
export class AiConversationQueryService {
  constructor(
    @InjectRepository(AiConversationEntity)
    private readonly conversationRepository: Repository<AiConversationEntity>,
    @InjectRepository(AiMessageEntity)
    private readonly messageRepository: Repository<AiMessageEntity>,
    @InjectRepository(AiMessageAnalysisEntity)
    private readonly analysisRepository: Repository<AiMessageAnalysisEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(EquipmentModelEntity)
    private readonly equipmentModelRepository: Repository<EquipmentModelEntity>,
  ) {}

  /** 可见会话列表：固定排序（创建时间倒序、主键倒序）+ OFFSET 分页 */
  async listVisible(params: {
    viewer: AiConversationViewerScope;
    pagination: AiConversationListPagination;
  }): Promise<AiConversationListPage> {
    const page = Math.max(params.pagination.page, 1);
    const pageSize = Math.max(params.pagination.pageSize, 1);

    const base = this.conversationRepository
      .createQueryBuilder('conversation')
      .leftJoin(RepairRequestEntity, 'request', 'request.id = conversation.requestId')
      .leftJoin(RepairRequestIntakeEntity, 'intake', 'intake.id = request.intakeId');
    this.applyVisibility(base, params.viewer);

    const [entities, total] = await Promise.all([
      base
        .clone()
        .orderBy('conversation.createdAt', 'DESC')
        .addOrderBy('conversation.id', 'DESC')
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .getMany(),
      params.pagination.withTotal ? base.clone().getCount() : Promise.resolve(undefined),
    ]);

    return {
      items: await this.toListItemQueryResults(entities),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 可见会话详情：不可见与不存在统一返回 null（由 usecase 映射 NOT_FOUND，
   * 不区分事实以避免探测）。
   */
  async findVisibleDetail(params: {
    conversationId: number;
    viewer: AiConversationViewerScope;
  }): Promise<AiConversationDetailQueryResult | null> {
    const qb = this.conversationRepository
      .createQueryBuilder('conversation')
      .leftJoin(RepairRequestEntity, 'request', 'request.id = conversation.requestId')
      .leftJoin(RepairRequestIntakeEntity, 'intake', 'intake.id = request.intakeId')
      .where('conversation.id = :conversationId', { conversationId: params.conversationId });
    this.applyVisibility(qb, params.viewer);
    const conversation = await qb.getOne();
    if (!conversation) {
      return null;
    }

    const [messages, analyses, requestNo] = await Promise.all([
      this.listMessages(conversation.id),
      this.listAnalyses(conversation.id),
      this.resolveRequestNo(conversation.requestId),
    ]);

    // 轮次映射：分析记录经问题消息归位轮次（导出与评价范围据此标记轮次状态，
    // 工程师路径与管理员路径必须同源，否则同一会话的有效回复会不一致）
    const messageTurnNos = new Map<number, number | null>();
    for (const message of messages) {
      messageTurnNos.set(message.id, message.turnNo);
    }

    return {
      id: conversation.id,
      requestId: conversation.requestId,
      requestNo,
      status: conversation.status,
      contentVersion: conversation.contentVersion,
      createdAt: conversation.createdAt,
      completedAt: conversation.completedAt,
      ownerAccountId: conversation.engineerAccountId,
      ownerOrganizationId: conversation.ownerOrganizationId,
      messages,
      analyses,
      messageTurnNos,
    };
  }

  /**
   * 管理员读侧会话详情（一级跨公司；二级仅本公司）。
   *
   * 与工程师可见性分离：管理员按管理范围读取已保存内容，不取得编辑或提问权。
   * 范围由 core 授权策略裁决后传入（`AiAdminConversationScope`）；二级管理员
   * 直传外公司会话 ID 时返回 null（不区分事实，避免探测）。
   */
  async findAdminDetail(params: {
    conversationId: number;
    scope: AiAdminConversationScope;
  }): Promise<AiConversationAdminDetailQueryResult | null> {
    const conversation = await this.conversationRepository.findOne({
      where: { id: params.conversationId },
    });
    if (!conversation) {
      return null;
    }
    if (params.scope.kind === 'ADMIN_ORGANIZATION') {
      // 二级管理员：仅本公司；外公司（含无归属公司）一律不可读
      if (
        conversation.ownerOrganizationId === null ||
        conversation.ownerOrganizationId !== params.scope.organizationId
      ) {
        return null;
      }
    }

    const [messages, analyses, requestNo] = await Promise.all([
      this.listMessages(conversation.id),
      this.listAnalyses(conversation.id),
      this.resolveRequestNo(conversation.requestId),
    ]);

    const messageTurnNos = new Map<number, number | null>();
    for (const message of messages) {
      messageTurnNos.set(message.id, message.turnNo);
    }

    return {
      id: conversation.id,
      requestId: conversation.requestId,
      requestNo,
      status: conversation.status,
      contentVersion: conversation.contentVersion,
      createdAt: conversation.createdAt,
      completedAt: conversation.completedAt,
      ownerAccountId: conversation.engineerAccountId,
      ownerOrganizationId: conversation.ownerOrganizationId,
      messages,
      analyses,
      messageTurnNos,
    };
  }

  /**
   * 仅读取可见会话头（本轮状态查询的最小可见性校验，不加载消息明细）。
   *
   * @returns 不可见或不存在时为 null
   */
  async findVisibleHeader(params: {
    conversationId: number;
    viewer: AiConversationViewerScope;
  }): Promise<{
    id: number;
    requestId: number | null;
    status: AiConversationStatus;
    contentVersion: number;
  } | null> {
    const qb = this.conversationRepository
      .createQueryBuilder('conversation')
      .leftJoin(RepairRequestEntity, 'request', 'request.id = conversation.requestId')
      .leftJoin(RepairRequestIntakeEntity, 'intake', 'intake.id = request.intakeId')
      .where('conversation.id = :conversationId', { conversationId: params.conversationId });
    this.applyVisibility(qb, params.viewer);
    const conversation = await qb.getOne();
    if (!conversation) {
      return null;
    }
    return {
      id: conversation.id,
      requestId: conversation.requestId,
      status: conversation.status,
      contentVersion: conversation.contentVersion,
    };
  }

  /** 按问题 UUID 读取会话内指定问题的分析事实（可见性由调用方先用详情校验） */
  async findAnalysisByQuestion(params: {
    conversationId: number;
    questionUuid: string;
  }): Promise<AiMessageAnalysisSnapshot | null> {
    const entity = await this.analysisRepository.findOne({
      where: { questionUuid: params.questionUuid, conversationId: params.conversationId },
    });
    return entity ? this.toAnalysisSnapshot(entity) : null;
  }

  /** 读取本轮问题消息（状态查询回显原文；不存在返回 null） */
  async findQuestionMessage(params: {
    conversationId: number;
    questionUuid: string;
  }): Promise<AiMessageQueryResult | null> {
    const entity = await this.messageRepository.findOne({
      where: { conversationId: params.conversationId, questionUuid: params.questionUuid },
    });
    return entity ? this.toMessageQueryResult(entity) : null;
  }

  /** 读取回答消息（分析成功后回读正文；无回答返回 null） */
  async findAnswerMessage(answerMessageId: number | null): Promise<AiMessageQueryResult | null> {
    if (answerMessageId === null) {
      return null;
    }
    const entity = await this.messageRepository.findOne({ where: { id: answerMessageId } });
    return entity ? this.toMessageQueryResult(entity) : null;
  }

  /** 会话内消息（稳定顺序：message_seq 升序、主键升序） */
  async listMessages(conversationId: number): Promise<ReadonlyArray<AiMessageQueryResult>> {
    const entities = await this.messageRepository.find({
      where: { conversationId },
      order: { messageSeq: 'ASC', id: 'ASC' },
    });
    return entities.map((entity) => this.toMessageQueryResult(entity));
  }

  /** 会话内分析记录（按保存时间升序） */
  async listAnalyses(conversationId: number): Promise<ReadonlyArray<AiMessageAnalysisSnapshot>> {
    const entities = await this.analysisRepository.find({
      where: { conversationId },
      order: { savedAt: 'ASC' },
    });
    return entities.map((entity) => this.toAnalysisSnapshot(entity));
  }

  /**
   * 关联工单的设备型号编码（模型上下文 `equipmentModelCode`）。
   *
   * 只读取脱敏编码，不读取型号名称以外的业务内容；工单或型号缺失时返回 null。
   */
  async findEquipmentModelCodeByRequestId(requestId: number | null): Promise<string | null> {
    if (requestId === null) {
      return null;
    }
    const request = await this.requestRepository.findOne({
      where: { id: requestId },
      select: { id: true, equipmentModelId: true },
    });
    if (!request) {
      return null;
    }
    const model = await this.equipmentModelRepository.findOne({
      where: { id: request.equipmentModelId },
      select: { id: true, modelCode: true },
    });
    return model?.modelCode ?? null;
  }

  /**
   * 可见性条件注入（结构由 `buildEngineerVisibilityClauses` 决定，便于单测覆盖）。
   *
   * 独立会话只归本人；工单会话限本公司、工单未删除且可信服务公司一致。
   */
  private applyVisibility(
    qb: SelectQueryBuilder<AiConversationEntity>,
    viewer: AiConversationViewerScope,
  ): void {
    const clauses = buildEngineerVisibilityClauses(viewer.organizationId);
    const [independentFirst, ...independentRest] = clauses.independent;
    const [workOrderFirst, ...workOrderRest] = clauses.workOrder ?? [];

    qb.andWhere(
      new Brackets((where) => {
        where.where(
          new Brackets((independent) => {
            let scoped = independent.where(independentFirst);
            for (const clause of independentRest) {
              scoped = scoped.andWhere(clause);
            }
          }),
        );
        if (workOrderFirst !== undefined) {
          where.orWhere(
            new Brackets((organization) => {
              let scoped = organization.where(workOrderFirst);
              for (const clause of workOrderRest) {
                scoped = scoped.andWhere(clause);
              }
            }),
          );
        }
      }),
    );
    qb.setParameters({
      viewerAccountId: viewer.accountId,
      viewerOrganizationId: viewer.organizationId ?? -1,
    });
  }

  private async resolveRequestNo(requestId: number | null): Promise<string> {
    if (requestId === null) {
      return '';
    }
    const entity = await this.requestRepository.findOne({
      where: { id: requestId },
      select: { id: true, requestNo: true },
    });
    return entity?.requestNo ?? '';
  }

  /** 批量装配列表项：申请编号一次读取，消息数与最后消息时间按会话维度聚合 */
  private async toListItemQueryResults(
    entities: AiConversationEntity[],
  ): Promise<AiConversationListItemQueryResult[]> {
    if (entities.length === 0) {
      return [];
    }
    const conversationIds = entities.map((entity) => entity.id);
    const requestIds = [
      ...new Set(
        entities
          .map((entity) => entity.requestId)
          .filter((requestId): requestId is number => requestId !== null),
      ),
    ];

    const [requests, messageStats] = await Promise.all([
      requestIds.length > 0
        ? this.requestRepository.find({
            where: { id: In(requestIds) },
            select: { id: true, requestNo: true },
          })
        : Promise.resolve([]),
      this.aggregateMessageStats(conversationIds),
    ]);

    const requestNoByRequestId = new Map(
      requests.map((request) => [request.id, request.requestNo]),
    );

    return entities.map((entity) => {
      const stats = messageStats.get(entity.id);
      return {
        id: entity.id,
        requestId: entity.requestId,
        requestNo:
          entity.requestId === null ? '' : (requestNoByRequestId.get(entity.requestId) ?? ''),
        status: entity.status,
        contentVersion: entity.contentVersion,
        messageCount: stats?.count ?? 0,
        turnCount: stats?.turnCount ?? 0,
        lastMessageAt: stats?.lastMessageAt ?? null,
        createdAt: entity.createdAt,
        completedAt: entity.completedAt,
      };
    });
  }

  private async aggregateMessageStats(
    conversationIds: number[],
  ): Promise<Map<number, { count: number; lastMessageAt: Date | null; turnCount: number }>> {
    if (conversationIds.length === 0) {
      return new Map();
    }
    const rows: Array<{
      conversationId: string | number;
      count: string | number;
      lastMessageAt: Date | string | null;
      turnCount: string | number;
    }> = await this.messageRepository
      .createQueryBuilder('message')
      .select('message.conversationId', 'conversationId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MAX(message.createdAt)', 'lastMessageAt')
      // 真实轮次：turn_no 为空的系统/工具消息不计入；失败轮只有用户消息，同样计为一轮
      .addSelect('COUNT(DISTINCT message.turnNo)', 'turnCount')
      .where('message.conversationId IN (:...conversationIds)', { conversationIds })
      .groupBy('message.conversationId')
      .getRawMany();

    const stats = new Map<
      number,
      { count: number; lastMessageAt: Date | null; turnCount: number }
    >();
    for (const row of rows) {
      const lastMessageAt =
        row.lastMessageAt === null
          ? null
          : row.lastMessageAt instanceof Date
            ? row.lastMessageAt
            : new Date(row.lastMessageAt);
      stats.set(Number(row.conversationId), {
        count: Number(row.count),
        lastMessageAt,
        turnCount: Number(row.turnCount ?? 0),
      });
    }
    return stats;
  }

  private toMessageQueryResult(entity: AiMessageEntity): AiMessageQueryResult {
    return {
      id: entity.id,
      messageSeq: entity.messageSeq,
      turnNo: entity.turnNo,
      role: entity.role,
      questionUuid: entity.questionUuid,
      contentText: entity.contentText,
      contentVersion: entity.contentVersion,
      createdAt: entity.createdAt,
    };
  }

  private toAnalysisSnapshot(entity: AiMessageAnalysisEntity): AiMessageAnalysisSnapshot {
    return {
      questionUuid: entity.questionUuid,
      conversationId: entity.conversationId,
      questionMessageId: entity.questionMessageId,
      answerMessageId: entity.answerMessageId,
      status: parseAiMessageAnalysisStatus(entity.status),
      failureReason: entity.failureReason,
      contentVersion: entity.contentVersion,
      savedAt: entity.savedAt,
      completedAt: entity.completedAt,
    };
  }
}

/**
 * 工程师会话可见性条件（F01）。
 *
 * 读侧 SQL 与 `@core/ai/engineer-conversation-access.policy` 等价：
 * - 独立会话：仅本人；
 * - 工单会话：固定归属公司、工单未软删、工单当前可信服务公司三者都等于当前可信公司；
 *   可信服务公司口径与 04 一致（工单服务公司 = intake 服务公司，缺失即不可见）。
 *
 * 查看者无公司归属时只保留独立会话分支（不生成工单分支）。
 */
export function buildEngineerVisibilityClauses(viewerOrganizationId: number | null): {
  readonly independent: readonly string[];
  readonly workOrder: readonly string[] | null;
} {
  return {
    independent: [
      'conversation.requestId IS NULL',
      'conversation.engineerAccountId = :viewerAccountId',
    ],
    workOrder:
      viewerOrganizationId === null
        ? null
        : [
            'conversation.requestId IS NOT NULL',
            'conversation.ownerOrganizationId = :viewerOrganizationId',
            'request.deletedAt IS NULL',
            'request.serviceOrganizationId = :viewerOrganizationId',
            'intake.serviceOrganizationId IS NOT NULL',
            'intake.serviceOrganizationId = request.serviceOrganizationId',
          ],
  };
}

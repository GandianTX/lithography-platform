// src/modules/lithography/ai-conversation.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  AiConversationStatus,
  AiMessageAnalysisStatus,
  AiMessageRole,
} from '@app-types/models/ai-conversation.types';
import { parseAiMessageAnalysisStatus } from '@core/ai/ai-message-analysis-status.policy';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, QueryFailedError, Repository } from 'typeorm';
import type {
  AiAnswerMessageInsertData,
  AiConversationInsertData,
  AiConversationLockSnapshot,
  AiConversationSnapshot,
  AiMessageAnalysisCompleteData,
  AiMessageAnalysisInsertData,
  AiMessageAnalysisSnapshot,
  AiPendingAnalysisCandidate,
  AiQuestionMessageInsertData,
  AiQuestionMessageSnapshot,
} from './ai-conversation.types';
import { AiConversationEntity } from './entities/ai-conversation.entity';
import { AiMessageAnalysisEntity } from './entities/ai-message-analysis.entity';
import { RestoreScopeWriteGuardService } from './restore-scope-write-guard.service';
import { AiMessageEntity } from './entities/ai-message.entity';

/**
 * AI 会话写服务（任务 05）
 *
 * 职责范围：
 * - 会话插入与行锁读取（`pessimistic_write`，串行化「校验状态 → 写消息」）
 * - 问题消息按稳定 UUID 的读取与插入
 * - 分析记录读取、插入与内容版本推进
 *
 * 不包含：
 * - 权限判定、公司归属裁决、幂等语义裁决、轮次上限判定（归 usecase）
 * - 事务开启（事务边界由 usecase 通过 TransactionRunner 持有）
 */
/** 候选批量读取上限：防御调用方传入过大值导致单次查询过重 */
const AI_PENDING_CANDIDATE_MAX_LIMIT = 500;

@Injectable()
export class AiConversationService {
  constructor(
    @InjectRepository(AiConversationEntity)
    private readonly conversationRepository: Repository<AiConversationEntity>,
    @InjectRepository(AiMessageEntity)
    private readonly messageRepository: Repository<AiMessageEntity>,
    @InjectRepository(AiMessageAnalysisEntity)
    private readonly analysisRepository: Repository<AiMessageAnalysisEntity>,
    private readonly restoreScopeWriteGuardService: RestoreScopeWriteGuardService,
  ) {}

  /** 新建会话：状态固定 ACTIVE、内容版本固定 1，均由本方法保证 */
  async insertConversation(
    data: AiConversationInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<AiConversationSnapshot> {
    // 恢复期冻结守卫：`ai_conversation` 已纳入受保护备份范围（会话按工单归属）。
    if (data.requestId !== null && data.requestId !== undefined) {
      await this.restoreScopeWriteGuardService.assertRequestScopeWritable(data.requestId);
    } else {
      await this.restoreScopeWriteGuardService.assertOrganizationScopeWritable(
        data.ownerOrganizationId ?? null,
      );
    }
    const repository = this.getConversationRepository(transactionContext);
    try {
      const saved = await repository.save(
        repository.create({
          requestId: data.requestId,
          ownerOrganizationId: data.ownerOrganizationId,
          engineerAccountId: data.engineerAccountId,
          status: AiConversationStatus.ACTIVE,
          contentVersion: 1,
        }),
      );
      return this.toConversationSnapshot(saved);
    } catch (error) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.CREATE_FAILED,
        'AI 会话创建失败，请稍后重试',
        { requestId: data.requestId },
        error,
      );
    }
  }

  /**
   * 会话行锁读取（`pessimistic_write`）：提交问题时在事务内锁定会话，
   * 使「状态/归属/轮次校验」与后续消息、分析写入串行化。
   *
   * @returns 不存在时为 null（由 usecase 决定错误口径）
   */
  async lockConversationForWrite(
    conversationId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<AiConversationLockSnapshot | null> {
    try {
      const repository = this.getConversationRepository(transactionContext);
      const entity = await repository.findOne({
        where: { id: conversationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entity) {
        return null;
      }
      return {
        id: entity.id,
        requestId: entity.requestId,
        ownerOrganizationId: entity.ownerOrganizationId,
        contentVersion: entity.contentVersion,
        engineerAccountId: entity.engineerAccountId,
        status: entity.status,
      };
    } catch (error) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.SUBMIT_FAILED,
        'AI 会话状态读取失败，请稍后重试',
        { conversationId },
        error,
      );
    }
  }

  /** 按稳定 UUID 读取问题消息（幂等判定入口） */
  async findQuestionByUuid(
    questionUuid: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<AiQuestionMessageSnapshot | null> {
    const repository = this.getMessageRepository(transactionContext);
    const entity = await repository.findOne({ where: { questionUuid } });
    if (!entity) {
      return null;
    }
    return this.toQuestionSnapshot(entity);
  }

  /** 会话内当前序号事实（最大 message_seq / 最大 turn_no） */
  async getSequenceFacts(
    conversationId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ maxMessageSeq: number; maxTurnNo: number }> {
    const repository = this.getMessageRepository(transactionContext);
    const raw: { maxSeq: string | number | null; maxTurn: string | number | null } | undefined =
      await repository
        .createQueryBuilder('message')
        .select('MAX(message.message_seq)', 'maxSeq')
        .addSelect('MAX(message.turn_no)', 'maxTurn')
        .where('message.conversation_id = :conversationId', { conversationId })
        .getRawOne();
    return {
      maxMessageSeq: raw?.maxSeq === null || raw?.maxSeq === undefined ? 0 : Number(raw.maxSeq),
      maxTurnNo: raw?.maxTurn === null || raw?.maxTurn === undefined ? 0 : Number(raw.maxTurn),
    };
  }

  /**
   * 插入用户提问消息。
   *
   * `question_uuid` 为全局唯一键：并发或重复提交撞键时统一转为
   * `QUESTION_CONFLICT`，由 usecase 回读原问题并按内容是否一致裁决
   * （一致返回既有事实，不一致拒绝）。
   */
  async insertUserMessage(
    data: AiQuestionMessageInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<AiQuestionMessageSnapshot> {
    // 恢复期冻结守卫：`ai_message`／`ai_message_analysis` 已纳入受保护备份范围。
    await this.restoreScopeWriteGuardService.assertConversationScopeWritable(data.conversationId);
    const repository = this.getMessageRepository(transactionContext);
    try {
      const saved = await repository.save(
        repository.create({
          conversationId: data.conversationId,
          questionUuid: data.questionUuid,
          messageSeq: data.messageSeq,
          turnNo: data.turnNo,
          role: AiMessageRole.USER,
          contentText: data.contentText,
          // 与同轮分析、会话版本保持一致：一轮一个版本号
          contentVersion: data.contentVersion,
        }),
      );
      return this.toQuestionSnapshot(saved);
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        throw new DomainError(
          AI_CONVERSATION_ERROR.QUESTION_CONFLICT,
          '该问题标识已被占用',
          { conversationId: data.conversationId },
          error,
        );
      }
      throw new DomainError(
        AI_CONVERSATION_ERROR.SUBMIT_FAILED,
        'AI 问题保存失败，请稍后重试',
        { conversationId: data.conversationId },
        error,
      );
    }
  }

  /** 插入分析记录：状态固定 PENDING、无回答、无完成时间 */
  async insertAnalysis(
    data: AiMessageAnalysisInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<AiMessageAnalysisSnapshot> {
    // 恢复期冻结守卫：`ai_message`／`ai_message_analysis` 已纳入受保护备份范围。
    await this.restoreScopeWriteGuardService.assertConversationScopeWritable(data.conversationId);
    const repository = this.getAnalysisRepository(transactionContext);
    try {
      const saved = await repository.save(
        repository.create({
          questionUuid: data.questionUuid,
          conversationId: data.conversationId,
          questionMessageId: data.questionMessageId,
          answerMessageId: null,
          status: AiMessageAnalysisStatus.PENDING,
          failureReason: null,
          contentVersion: data.contentVersion,
          completedAt: null,
        }),
      );
      return this.toAnalysisSnapshot(saved);
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        throw new DomainError(
          AI_CONVERSATION_ERROR.QUESTION_CONFLICT,
          '该问题标识已被占用',
          { conversationId: data.conversationId },
          error,
        );
      }
      throw new DomainError(
        AI_CONVERSATION_ERROR.SUBMIT_FAILED,
        'AI 问题受理失败，请稍后重试',
        { conversationId: data.conversationId },
        error,
      );
    }
  }

  /** 插入回答消息（S2：正文与有效回答同次保存，角色固定 ASSISTANT） */
  async insertAnswerMessage(
    data: AiAnswerMessageInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<AiQuestionMessageSnapshot> {
    // 恢复期冻结守卫：`ai_message`／`ai_message_analysis` 已纳入受保护备份范围。
    await this.restoreScopeWriteGuardService.assertConversationScopeWritable(data.conversationId);
    const repository = this.getMessageRepository(transactionContext);
    try {
      const saved = await repository.save(
        repository.create({
          conversationId: data.conversationId,
          questionUuid: null,
          messageSeq: data.messageSeq,
          turnNo: data.turnNo,
          role: AiMessageRole.ASSISTANT,
          contentText: data.contentText,
          contentVersion: data.contentVersion,
        }),
      );
      return this.toQuestionSnapshot(saved);
    } catch (error) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.REPLY_UNAVAILABLE,
        'AI 回答保存失败',
        { conversationId: data.conversationId },
        error,
      );
    }
  }

  /**
   * 分析完成（条件更新）：仅当 `status = PENDING` 且尚未关联回答时生效。
   *
   * 该条件是「迟到结果不覆盖新回答」的最后一道闸门：并发或旧执行写回时
   * affected = 0，调用方必须丢弃本次结果而不改写任何业务事实。
   */
  async completeAnalysis(
    data: AiMessageAnalysisCompleteData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<boolean> {
    // 恢复期冻结守卫：`ai_message_analysis` 已纳入受保护备份范围。
    await this.restoreScopeWriteGuardService.assertAnalysisScopeWritable(data.questionUuid);
    const repository = this.getAnalysisRepository(transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(AiMessageAnalysisEntity)
      .set({
        status: AiMessageAnalysisStatus.SUCCEEDED,
        answerMessageId: data.answerMessageId,
        contentVersion: data.contentVersion,
        failureReason: null,
        completedAt: data.completedAt,
      })
      .where('question_uuid = :questionUuid', { questionUuid: data.questionUuid })
      .andWhere('status = :status', { status: AiMessageAnalysisStatus.PENDING })
      .andWhere('answer_message_id IS NULL')
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /** 分析失败（条件更新）：仅 PENDING 时生效，保证不覆盖已完成结果 */
  async markAnalysisFailed(
    input: { readonly questionUuid: string; readonly reason: string },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<boolean> {
    // 恢复期冻结守卫：`ai_message_analysis` 已纳入受保护备份范围。
    await this.restoreScopeWriteGuardService.assertAnalysisScopeWritable(input.questionUuid);
    const repository = this.getAnalysisRepository(transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(AiMessageAnalysisEntity)
      .set({
        status: AiMessageAnalysisStatus.FAILED,
        failureReason: input.reason.slice(0, 255),
        completedAt: new Date(),
      })
      .where('question_uuid = :questionUuid', { questionUuid: input.questionUuid })
      .andWhere('status = :status', { status: AiMessageAnalysisStatus.PENDING })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /** 重试前重置：仅 FAILED 且无回答时回到 PENDING（沿用同一问题 UUID） */
  async resetAnalysisForRetry(
    input: { readonly questionUuid: string },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<boolean> {
    // 恢复期冻结守卫：`ai_message_analysis` 已纳入受保护备份范围。
    await this.restoreScopeWriteGuardService.assertAnalysisScopeWritable(input.questionUuid);
    const repository = this.getAnalysisRepository(transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(AiMessageAnalysisEntity)
      .set({
        status: AiMessageAnalysisStatus.PENDING,
        failureReason: null,
        completedAt: null,
      })
      .where('question_uuid = :questionUuid', { questionUuid: input.questionUuid })
      .andWhere('status = :status', { status: AiMessageAnalysisStatus.FAILED })
      .andWhere('answer_message_id IS NULL')
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /** 会话内本轮之前的历史消息（仅 USER/ASSISTANT，按时序升序） */
  async listHistoryBeforeSeq(
    input: { readonly conversationId: number; readonly messageSeq: number },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<ReadonlyArray<{ readonly role: string; readonly text: string }>> {
    const repository = this.getMessageRepository(transactionContext);
    const entities = await repository.find({
      where: {
        conversationId: input.conversationId,
        role: In([AiMessageRole.USER, AiMessageRole.ASSISTANT]),
      },
      order: { messageSeq: 'ASC' },
    });
    return entities
      .filter((entity) => entity.messageSeq < input.messageSeq)
      .map((entity) => ({ role: entity.role, text: entity.contentText }));
  }

  /** 按主键读取会话最小事实（重试与派发前的状态复核） */
  async findConversationById(
    conversationId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<AiConversationSnapshot | null> {
    const repository = this.getConversationRepository(transactionContext);
    const entity = await repository.findOne({ where: { id: conversationId } });
    return entity ? this.toConversationSnapshot(entity) : null;
  }

  /** 按问题 UUID 读取分析记录 */
  async findAnalysisByQuestion(
    questionUuid: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<AiMessageAnalysisSnapshot | null> {
    const repository = this.getAnalysisRepository(transactionContext);
    const entity = await repository.findOne({ where: { questionUuid } });
    if (!entity) {
      return null;
    }
    return this.toAnalysisSnapshot(entity);
  }

  /**
   * 读取待结算候选（键集分页，按分析主键 `question_uuid` 升序）。
   *
   * 只返回「分析仍为 PENDING 且尚未关联回答」的问题：
   * - 已成功／已失败的轮次不再进入候选，避免历史成功记录反复占满扫描配额；
   * - 不设终态时间窗口，停机超过回看期的未收敛轮次仍能在重启后被重新发现；
   * - `afterQuestionUuid` 为上一批末键（keyset），null 表示从头开始；
   * - 返回条数达到 `limit` 说明后面可能还有，调用方以末键推进游标。
   *
   * 该查询只读且不授权任何写入：结算前必须在事务内重新核对分析事实与执行身份。
   */
  async listPendingAnalysisCandidates(input: {
    readonly afterQuestionUuid: string | null;
    readonly limit: number;
  }): Promise<ReadonlyArray<AiPendingAnalysisCandidate>> {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit), AI_PENDING_CANDIDATE_MAX_LIMIT));
    try {
      const repository = this.analysisRepository;
      const query = repository
        .createQueryBuilder('analysis')
        .select(['analysis.questionUuid', 'analysis.conversationId', 'analysis.questionMessageId'])
        .where('analysis.status = :status', { status: AiMessageAnalysisStatus.PENDING })
        .andWhere('analysis.answerMessageId IS NULL');
      if (input.afterQuestionUuid !== null) {
        query.andWhere('analysis.questionUuid > :afterQuestionUuid', {
          afterQuestionUuid: input.afterQuestionUuid,
        });
      }
      const entities = await query.orderBy('analysis.questionUuid', 'ASC').take(limit).getMany();
      return entities.map((entity) => ({
        questionUuid: entity.questionUuid,
        conversationId: entity.conversationId,
        questionMessageId: entity.questionMessageId,
      }));
    } catch (error) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.REPLY_UNAVAILABLE,
        '读取待结算分析候选失败，请稍后重试',
        { limit },
        error,
      );
    }
  }

  /**
   * 推进会话内容版本：会话行已被 `lockConversationForWrite` 锁定时调用。
   *
   * @returns 推进后的版本号（首次提问后为 2）
   */
  async bumpContentVersion(
    conversationId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<number> {
    // 恢复期冻结守卫：`ai_conversation` 已纳入受保护备份范围。
    await this.restoreScopeWriteGuardService.assertConversationScopeWritable(conversationId);
    const repository = this.getConversationRepository(transactionContext);
    await repository.increment({ id: conversationId }, 'contentVersion', 1);
    const entity = await repository.findOne({
      where: { id: conversationId },
      select: { id: true, contentVersion: true },
    });
    return entity?.contentVersion ?? 1;
  }

  /** 唯一约束冲突判定（MySQL ER_DUP_ENTRY / 1062 / 23000） */
  private isUniqueConstraintViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = (error as unknown as Record<string, unknown>).driverError as
      Record<string, unknown> | undefined;
    if (!driverError) {
      return false;
    }
    return (
      driverError.code === 'ER_DUP_ENTRY' ||
      driverError.errno === 1062 ||
      driverError.sqlState === '23000'
    );
  }

  private getConversationRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AiConversationEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(AiConversationEntity) : this.conversationRepository;
  }

  private getMessageRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AiMessageEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(AiMessageEntity) : this.messageRepository;
  }

  private getAnalysisRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AiMessageAnalysisEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(AiMessageAnalysisEntity) : this.analysisRepository;
  }

  private toConversationSnapshot(entity: AiConversationEntity): AiConversationSnapshot {
    return {
      id: entity.id,
      requestId: entity.requestId,
      ownerOrganizationId: entity.ownerOrganizationId,
      contentVersion: entity.contentVersion,
      engineerAccountId: entity.engineerAccountId,
      status: entity.status,
      createdAt: entity.createdAt,
    };
  }

  private toQuestionSnapshot(entity: AiMessageEntity): AiQuestionMessageSnapshot {
    return {
      id: entity.id,
      conversationId: entity.conversationId,
      questionUuid: entity.questionUuid,
      messageSeq: entity.messageSeq,
      turnNo: entity.turnNo,
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

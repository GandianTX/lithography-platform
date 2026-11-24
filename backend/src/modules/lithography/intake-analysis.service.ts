// src/modules/lithography/intake-analysis.service.ts
// 首析执行侧写服务（任务 03 第二段：认领、租约过期接管、结果写回）。
//
// 归属模型：
// - 认领（短事务）在 `repair_request_intake` 行排他锁内推进状态并插入
//   `intake_analysis_attempt` RUNNING 尝试行，尝试行主键就是本次执行的唯一凭据；
// - 租约过期接管（RUNNING 且 attempt.started_at ≤ now - leaseTimeoutMs）在同一锁内
//   删除旧尝试行并插入新行：旧执行持有的 attemptId 失效，不可能抢先写回；
// - 写回（短事务）同样先锁 intake 行核验未删除 / 工单存在 / 代次匹配，
//   再条件更新「自己的尝试行」，affected = 1 才允许写终态；
//   旧执行迟到、代次已切换（0→1）、报修已删除都会被拒绝且不改任何状态。
//
// 与工单状态的关系：本服务只推进首析状态，不写 repair_request 工单行；
// 首析失败不阻挡接单（工单状态独立）。
//
// 不包含：RAG 调用、请求构造、队列投递、账本维护（归 usecase 与各自能力）。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IntakeAnalysisStatus } from '@app-types/models/repair-request.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { EquipmentModelEntity } from './entities/equipment-model.entity';
import { IntakeAnalysisAttemptEntity } from './entities/intake-analysis-attempt.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { RestoreScopeWriteGuardService } from './restore-scope-write-guard.service';
import type {
  IntakeAnalysisClaimResult,
  IntakeAnalysisFinishInput,
  IntakeAnalysisFinishResult,
  IntakeAnalysisRetryWriteFacts,
  RepairRequestIntakeSnapshot,
} from './lithography.types';

export const INTAKE_ANALYSIS_LEASE_TIMEOUT_MS = 15 * 60 * 1000;

/** 默认租约超时（与 ai-workflow 认领超时一致的保守值） */
const DEFAULT_LEASE_TIMEOUT_MS = INTAKE_ANALYSIS_LEASE_TIMEOUT_MS;

/**
 * 投递就绪度（housekeeping 补投前的只读预判，与 claimForAnalysis 同一判定口径）：
 * - deleted_or_missing：原稿不存在或已删除 → 补投无意义，账本行应取消；
 * - not_converted：原稿缺少已转换工单（convertedRequestId 为空）→ 认领必然拒绝，
 *   补投只会空转，账本行应取消（与 claimForAnalysis 的 NOT_CONVERTED 同口径）；
 * - generation_mismatch：账本行代次落后于当前代次 → stale 意图，账本行应取消；
 * - intent_succeeded / intent_failed：首析已终态 → 不补投（成功无需执行；
 *   失败只剩用户主动重试，基建补投不得推进代次）；
 * - lease_in_flight：RUNNING 且当前尝试行租约仍有效 → 有执行在跑，不抢投；
 * - attempt_inconsistent：RUNNING 而尝试行缺失或非 RUNNING → 越过状态机，
 *   失败关闭，不补投也不取消，留给人工；
 * - claimable：WAITING，或 RUNNING 且租约已过期 → 允许状态感知补投。
 */
export type IntakeAnalysisDeliveryReadiness =
  | 'deleted_or_missing'
  | 'not_converted'
  | 'generation_mismatch'
  | 'intent_succeeded'
  | 'intent_failed'
  | 'lease_in_flight'
  | 'attempt_inconsistent'
  | 'claimable';

@Injectable()
export class IntakeAnalysisService {
  constructor(
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly intakeRepository: Repository<RepairRequestIntakeEntity>,
    @InjectRepository(IntakeAnalysisAttemptEntity)
    private readonly attemptRepository: Repository<IntakeAnalysisAttemptEntity>,
    @InjectRepository(EquipmentModelEntity)
    private readonly equipmentModelRepository: Repository<EquipmentModelEntity>,
    private readonly restoreScopeWriteGuardService: RestoreScopeWriteGuardService,
  ) {}

  /**
   * 认领一次首析执行（短事务内调用）。
   *
   * 可认领条件（全部在 intake 行排他锁内判定）：
   * - 原稿存在、未删除、已关联工单（convertedRequestId 非空）；
   * - 代次与投递意图一致；
   * - 状态为 WAITING（首次）或 RUNNING 且当前尝试行租约过期（接管）。
   */
  async claimForAnalysis(params: {
    readonly intakeId: number;
    readonly generationNo: number;
    readonly now: Date;
    readonly leaseTimeoutMs?: number;
    readonly transactionContext: PersistenceTransactionContext;
  }): Promise<IntakeAnalysisClaimResult> {
    const leaseTimeoutMs = params.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
    const locked = await this.lockIntakeRow(params.intakeId, params.transactionContext);
    if (!locked) {
      return { kind: 'NOT_EXECUTABLE', intakeId: params.intakeId, reason: 'NOT_FOUND' };
    }
    // 恢复期冻结守卫（先于任何状态推进与尝试行写入）：
    // `repair_request_intake`／`intake_analysis_attempt` 已纳入受保护备份范围，
    // 恢复期间推进首析状态会污染恢复结果。
    await this.restoreScopeWriteGuardService.assertIntakeScopeWritable(locked.id, params.transactionContext);
    if (locked.deletedAt !== null) {
      return { kind: 'NOT_EXECUTABLE', intakeId: params.intakeId, reason: 'DELETED' };
    }
    if (locked.convertedRequestId === null) {
      return { kind: 'NOT_EXECUTABLE', intakeId: params.intakeId, reason: 'NOT_CONVERTED' };
    }
    if (locked.analysisGeneration !== params.generationNo) {
      return {
        kind: 'NOT_EXECUTABLE',
        intakeId: params.intakeId,
        reason: 'GENERATION_MISMATCH',
      };
    }

    const status = asIntakeStatus(locked.analysisStatus);
    switch (status) {
      case IntakeAnalysisStatus.SUCCEEDED:
        return {
          kind: 'ALREADY_SUCCEEDED',
          intakeId: params.intakeId,
          generationNo: params.generationNo,
        };
      case IntakeAnalysisStatus.FAILED:
        // 第 0 代失败后只有本人主动重试（代次 0→1）可再次执行，后台不重跑失败代次
        return {
          kind: 'ALREADY_FAILED',
          intakeId: params.intakeId,
          generationNo: params.generationNo,
        };
      case IntakeAnalysisStatus.WAITING:
        return await this.insertRunningAttempt({
          locked,
          now: params.now,
          transactionContext: params.transactionContext,
        });
      case IntakeAnalysisStatus.RUNNING:
        break;
      default:
        throw new DomainError(
          REPAIR_REQUEST_ERROR.CREATION_FAILED,
          '报修分析状态异常，请稍后重试',
          { intakeId: params.intakeId },
        );
    }

    const attemptRepository = this.getAttemptRepository(params.transactionContext);
    const currentAttempt = await attemptRepository.findOne({
      where: { intakeId: params.intakeId, generationNo: params.generationNo },
    });
    if (!currentAttempt || asIntakeStatus(currentAttempt.status) !== IntakeAnalysisStatus.RUNNING) {
      // intake RUNNING 而尝试行缺失或已终态：越过了本服务的状态机（理论上不可达），
      // 失败关闭，不自行修复，避免覆盖未知状态
      return {
        kind: 'ATTEMPT_STATE_INCONSISTENT',
        intakeId: params.intakeId,
        generationNo: params.generationNo,
      };
    }

    const leaseDeadline = new Date(params.now.getTime() - leaseTimeoutMs);
    if (currentAttempt.startedAt && currentAttempt.startedAt.getTime() > leaseDeadline.getTime()) {
      // 租约仍在有效期内：其他执行正在处理本代次，本执行不得争抢
      return { kind: 'LEASE_ACTIVE', intakeId: params.intakeId, generationNo: params.generationNo };
    }

    // 租约过期接管：删除旧尝试行（旧执行凭据失效），插入本次执行的新尝试行
    await attemptRepository.delete({ id: currentAttempt.id });
    return await this.insertRunningAttempt({
      locked,
      now: params.now,
      transactionContext: params.transactionContext,
    });
  }

  /**
   * 写回首析结果（短事务内调用）。
   *
   * 归属核验顺序（任一不满足都不产生写入）：
   * 1. intake 行锁内核验：未删除、工单存在、状态 RUNNING、代次匹配；
   * 2. 条件更新「本次执行的尝试行」（id + 仍 RUNNING）；
   * 3. 条件更新 intake 终态（未命中属防御性异常，整体回滚）。
   */
  async finishIntakeAnalysis(params: {
    readonly input: IntakeAnalysisFinishInput;
    readonly transactionContext: PersistenceTransactionContext;
  }): Promise<IntakeAnalysisFinishResult> {
    const { intakeId, generationNo, attemptId } = params.input;
    const locked = await this.lockIntakeRow(intakeId, params.transactionContext);
    if (!locked) {
      return { kind: 'REJECTED', intakeId, reason: 'NOT_FOUND' };
    }
    // 恢复期冻结守卫：写回终态前必须先确认目标公司数据区未被恢复占用。
    await this.restoreScopeWriteGuardService.assertIntakeScopeWritable(locked.id, params.transactionContext);
    if (locked.deletedAt !== null) {
      return { kind: 'REJECTED', intakeId, reason: 'DELETED' };
    }
    if (locked.convertedRequestId === null) {
      return { kind: 'REJECTED', intakeId, reason: 'NOT_CONVERTED' };
    }
    if (locked.analysisGeneration !== generationNo) {
      return { kind: 'REJECTED', intakeId, reason: 'GENERATION_MISMATCH' };
    }
    if (asIntakeStatus(locked.analysisStatus) !== IntakeAnalysisStatus.RUNNING) {
      return { kind: 'REJECTED', intakeId, reason: 'NOT_RUNNING' };
    }

    const finishedAt = new Date();
    const attemptPatch =
      params.input.outcome.kind === 'SUCCEEDED'
        ? {
            status: IntakeAnalysisStatus.SUCCEEDED,
            outputText: params.input.outcome.outputText,
            failureReason: null,
            providerCallId: params.input.outcome.providerCallId,
            finishedAt,
          }
        : {
            status: IntakeAnalysisStatus.FAILED,
            outputText: null,
            failureReason: params.input.outcome.failureReason,
            providerCallId: params.input.outcome.providerCallId,
            finishedAt,
          };

    // 归属仲裁：尝试行必须仍是本次执行插入的 RUNNING 行；
    // 租约被接管后旧行已删除、代次切换后行不存在，条件更新都不命中
    const attemptRepository = this.getAttemptRepository(params.transactionContext);
    const attemptResult = await attemptRepository
      .createQueryBuilder()
      .update(IntakeAnalysisAttemptEntity)
      .set(attemptPatch)
      .where('id = :attemptId', { attemptId })
      .andWhere('intake_id = :intakeId', { intakeId })
      .andWhere('generation_no = :generationNo', { generationNo })
      .andWhere('status = :status', { status: IntakeAnalysisStatus.RUNNING })
      .execute();
    if ((attemptResult.affected ?? 0) !== 1) {
      return { kind: 'OWNERSHIP_LOST', intakeId, generationNo };
    }

    const intakeRepository = this.getRepository(params.transactionContext);
    const intakeResult = await intakeRepository
      .createQueryBuilder()
      .update(RepairRequestIntakeEntity)
      .set({ analysisStatus: attemptPatch.status })
      .where('id = :intakeId', { intakeId })
      .andWhere('analysis_status = :running', { running: IntakeAnalysisStatus.RUNNING })
      .andWhere('analysis_generation = :generationNo', { generationNo })
      .andWhere('deleted_at IS NULL')
      .execute();
    if ((intakeResult.affected ?? 0) !== 1) {
      // 行锁内核验通过后条件更新未命中：理论上不可达，整体回滚避免尝试行与意图行不一致
      throw new DomainError(REPAIR_REQUEST_ERROR.CREATION_FAILED, '报修分析写回失败，请稍后重试', {
        intakeId,
        generationNo,
      });
    }
    return { kind: 'WRITTEN', intakeId, generationNo };
  }

  /**
   * 读取原稿快照与可信机型编码（供 Worker 在事务外构造模型请求）。
   * 只读，不含权限判断；原稿不存在时返回 null。
   */
  async getIntakeForAnalysis(params: { readonly intakeId: number }): Promise<{
    readonly intake: RepairRequestIntakeSnapshot;
    readonly modelCode: string;
  } | null> {
    const intakeEntity = await this.intakeRepository.findOne({
      where: { id: params.intakeId },
    });
    if (!intakeEntity) {
      return null;
    }
    const model = await this.equipmentModelRepository.findOne({
      where: { id: intakeEntity.equipmentModelId },
      select: { id: true, modelCode: true },
    });
    if (!model) {
      return null;
    }
    return {
      intake: {
        id: intakeEntity.id,
        recordUuid: intakeEntity.recordUuid,
        customerAccountId: intakeEntity.customerAccountId,
        customerOrganizationId: intakeEntity.customerOrganizationId,
        serviceOrganizationId: intakeEntity.serviceOrganizationId,
        equipmentModelId: intakeEntity.equipmentModelId,
        errorCode: intakeEntity.errorCode,
        faultDescription: intakeEntity.faultDescription,
        fileId: intakeEntity.fileId,
        analysisStatus: intakeEntity.analysisStatus,
        analysisGeneration: intakeEntity.analysisGeneration,
        convertedRequestId: intakeEntity.convertedRequestId,
        createdAt: intakeEntity.createdAt,
      },
      modelCode: model.modelCode,
    };
  }

  /** 原稿是否已删除或不存在（housekeeping 取消孤儿投递行的判据） */
  async isIntakeDeletedOrMissing(params: { readonly intakeId: number }): Promise<boolean> {
    const entity = await this.intakeRepository.findOne({
      where: { id: params.intakeId },
      select: { id: true, deletedAt: true },
    });
    return !entity || entity.deletedAt !== null;
  }

  /**
   * 投递就绪度只读判定（无锁、无事务；只读快照）。
   * 与 claimForAnalysis 的可认领条件同一口径，避免 housekeeping 预判与认领仲裁分叉。
   * 并发窗口（预判后状态变化）由认领侧条件更新兜底，不依赖预判的强一致。
   */
  async resolveIntakeDeliveryReadiness(params: {
    readonly intakeId: number;
    readonly generationNo: number;
    readonly now?: Date;
  }): Promise<IntakeAnalysisDeliveryReadiness> {
    const now = params.now ?? new Date();
    const intake = await this.intakeRepository.findOne({
      where: { id: params.intakeId },
    });
    if (!intake || intake.deletedAt !== null) {
      return 'deleted_or_missing';
    }
    if (intake.analysisGeneration !== params.generationNo) {
      return 'generation_mismatch';
    }
    const status = asIntakeStatus(intake.analysisStatus);
    switch (status) {
      case IntakeAnalysisStatus.SUCCEEDED:
        return 'intent_succeeded';
      case IntakeAnalysisStatus.FAILED:
        return 'intent_failed';
      case IntakeAnalysisStatus.WAITING:
      case IntakeAnalysisStatus.RUNNING:
        break;
      default:
        // 未知状态值：失败关闭，不补投也不取消
        return 'attempt_inconsistent';
    }
    if (intake.convertedRequestId === null) {
      // 与 claimForAnalysis 的 NOT_CONVERTED 同口径：没有工单就没有可写的归属对象。
      // 放在终态判定之后：已落地的真实结果永远优先于结构异常，不会被误判为取消。
      return 'not_converted';
    }
    if (status === IntakeAnalysisStatus.WAITING) {
      return 'claimable';
    }

    const attemptRepository = this.attemptRepository;
    const attempt = await attemptRepository.findOne({
      where: { intakeId: params.intakeId, generationNo: params.generationNo },
    });
    if (!attempt || asIntakeStatus(attempt.status) !== IntakeAnalysisStatus.RUNNING) {
      return 'attempt_inconsistent';
    }
    const leaseDeadline = new Date(now.getTime() - DEFAULT_LEASE_TIMEOUT_MS);
    if (attempt.startedAt && attempt.startedAt.getTime() > leaseDeadline.getTime()) {
      return 'lease_in_flight';
    }
    return 'claimable';
  }

  /**
   * 读取主动重试资格所需的写侧事实（事务内，按 intake 行排他锁）。
   *
   * 只读：不推进状态、不写尝试行、不创建账本；与 bumpAnalysisGenerationForRetry
   * 的原子条件更新配合 —— 事实读取在锁内，条件更新在锁内复核，二者不会互相覆盖。
   * 原稿行不存在时返回 null，由调用方按「无原稿」失败关闭。
   */
  async loadRetryFacts(params: {
    readonly intakeId: number;
    readonly transactionContext: PersistenceTransactionContext;
  }): Promise<IntakeAnalysisRetryWriteFacts | null> {
    const locked = await this.lockIntakeRow(params.intakeId, params.transactionContext);
    if (!locked) {
      return null;
    }
    const attemptRepository = this.getAttemptRepository(params.transactionContext);
    const attempt = await attemptRepository.findOne({
      where: { intakeId: locked.id, generationNo: locked.analysisGeneration },
    });
    return {
      intakeCustomerAccountId: locked.customerAccountId,
      intakeDeleted: locked.deletedAt !== null,
      convertedRequestId: locked.convertedRequestId,
      generation: locked.analysisGeneration,
      status: locked.analysisStatus,
      attemptGenerationNo: attempt?.generationNo ?? null,
      attemptStatus: attempt?.status ?? null,
      attemptFailureReasonRecorded: (attempt?.failureReason ?? '').trim().length > 0,
    };
  }

  /** 条件推进主动重试代次：仅「第 0 代已失败且未删除」可原子切换到第 1 代 WAITING */
  async bumpAnalysisGenerationForRetry(params: {
    readonly intakeId: number;
    readonly transactionContext: PersistenceTransactionContext;
  }): Promise<{ affected: number }> {
    const repository = this.getRepository(params.transactionContext);
    // 恢复期冻结守卫：代次推进会改写 `repair_request_intake`（备份范围内），
    // 必须在写入前确认目标公司数据区未被恢复占用。
    await this.restoreScopeWriteGuardService.assertIntakeScopeWritable(params.intakeId, params.transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(RepairRequestIntakeEntity)
      .set({
        analysisStatus: IntakeAnalysisStatus.WAITING,
        analysisGeneration: 1,
      })
      .where('id = :intakeId', { intakeId: params.intakeId })
      .andWhere('analysis_status = :failed', { failed: IntakeAnalysisStatus.FAILED })
      .andWhere('analysis_generation = 0')
      .andWhere('deleted_at IS NULL')
      .andWhere('converted_request_id IS NOT NULL')
      .execute();
    return { affected: result.affected ?? 0 };
  }

  private async insertRunningAttempt(params: {
    readonly locked: RepairRequestIntakeEntity;
    readonly now: Date;
    readonly transactionContext: PersistenceTransactionContext;
  }): Promise<IntakeAnalysisClaimResult> {
    const intakeId = params.locked.id;
    const generationNo = params.locked.analysisGeneration;

    const intakeRepository = this.getRepository(params.transactionContext);
    const statusResult = await intakeRepository
      .createQueryBuilder()
      .update(RepairRequestIntakeEntity)
      .set({ analysisStatus: IntakeAnalysisStatus.RUNNING })
      .where('id = :intakeId', { intakeId })
      .andWhere('analysis_status IN (:...fromStatuses)', {
        fromStatuses: [IntakeAnalysisStatus.WAITING, IntakeAnalysisStatus.RUNNING],
      })
      .execute();
    if ((statusResult.affected ?? 0) !== 1) {
      // 行锁内状态已核对，条件更新未命中属防御性异常：整体回滚
      throw new DomainError(REPAIR_REQUEST_ERROR.CREATION_FAILED, '报修分析认领失败，请稍后重试', {
        intakeId,
        generationNo,
      });
    }

    const attemptRepository = this.getAttemptRepository(params.transactionContext);
    const attempt = attemptRepository.create({
      intakeId,
      generationNo,
      status: IntakeAnalysisStatus.RUNNING,
      outputText: null,
      failureReason: null,
      providerCallId: null,
      startedAt: params.now,
      finishedAt: null,
    });
    const saved = await attemptRepository.save(attempt);
    return {
      kind: 'CLAIMED',
      intakeId,
      generationNo,
      attemptId: Number(saved.id),
      startedAt: params.now,
    };
  }

  private async lockIntakeRow(
    intakeId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestIntakeEntity | null> {
    const repository = this.getRepository(transactionContext);
    return await repository
      .createQueryBuilder('intake')
      .setLock('pessimistic_write')
      .where('intake.id = :intakeId', { intakeId })
      .getOne();
  }

  private getRepository(
    transactionContext: PersistenceTransactionContext,
  ): Repository<RepairRequestIntakeEntity> {
    const manager = getTypeOrmEntityManager(transactionContext);
    return manager.getRepository(RepairRequestIntakeEntity);
  }

  private getAttemptRepository(
    transactionContext: PersistenceTransactionContext,
  ): Repository<IntakeAnalysisAttemptEntity> {
    const manager = getTypeOrmEntityManager(transactionContext);
    return manager.getRepository(IntakeAnalysisAttemptEntity);
  }
}

/** 实体列以 string 承载受控值域；此处按数据库 CHECK 值域收窄 */
function asIntakeStatus(value: string): IntakeAnalysisStatus {
  return value as IntakeAnalysisStatus;
}

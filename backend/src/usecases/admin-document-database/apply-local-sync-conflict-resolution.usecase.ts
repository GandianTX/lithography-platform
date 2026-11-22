// src/usecases/admin-document-database/apply-local-sync-conflict-resolution.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import type { MaintenanceRecordRawInput } from '@core/repair-request/policy/repair-request-maintenance.policy';
import {
  planLocalConflictResolution,
  resolveLocalResolutionReplay,
} from '@core/local-runtime/policy/sync-conflict-local-resolution.policy';
import { resolveSyncConflictReadOnly } from '@core/local-runtime/policy/sync-conflict-readonly.policy';
import {
  resolveSyncConflictOutcome,
  type SyncConflictDecision,
  type SyncConflictStatus,
} from '@core/local-runtime/policy/sync-conflict-resolve.policy';
import { Inject, Injectable } from '@nestjs/common';

import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import type { SyncConflictSummary } from '@src/modules/lithography/sync.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { resolveAdminOrganizationScope } from './admin-organization-scope';
import { AppendRepairRequestRevisionUsecase } from './append-repair-request-revision.usecase';

/**
 * 「保留本地」冲突裁决（任务 09 R-03）。
 *
 * 为什么落在管理员文档库域：
 * - 保留本地＝把本地版本**作为一次受控修订写回来源业务**，写入口是任务 04 的
 *   工单受控修订入口（该入口自带管理员权限、公司范围、记录级可见性与版本条件裁决）；
 * - 本域拥有那套权限口径，跨域另写一套只会制造两套口径（R-03 原挂的③权限口径）。
 *
 * 失败关闭：缺管理员权限、公司范围不符、冲突不存在、来源记录不可用、
 * 本地快照不满足受控载荷契约——任一情形都不写任何事实。
 */
@Injectable()
export class ApplyLocalSyncConflictResolutionUsecase {
  constructor(
    private readonly syncConflictService: SyncConflictService,
    private readonly sourceRecordQueryService: SyncSourceRecordQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    private readonly appendRevisionUsecase: AppendRepairRequestRevisionUsecase,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(input: { session: UsecaseSession; conflictId: string }): Promise<{
    outcome: 'resolved' | 'existing';
    conflict: SyncConflictSummary | null;
  }> {
    // 保留本地是管理员动作：权限不足直接失败关闭，不降级
    assertAdminDocumentDatabasePermission(input.session, '裁决保留本地冲突');
    const organizationScope = await resolveAdminOrganizationScope({
      session: input.session,
      accountQueryService: this.accountQueryService,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });

    const prepared = await this.transactionRunner.run(async (transactionContext) => {
      const locked = await this.syncConflictService.lockConflictView(
        input.conflictId,
        transactionContext,
      );
      if (!locked) {
        throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
      }
      // 公司范围：与读侧同一口径（一级管理员全局，其余必须命中本公司数据区）
      if (
        organizationScope.organizationId !== null &&
        locked.organizationId !== organizationScope.organizationId
      ) {
        throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
      }

      const outcome = resolveSyncConflictOutcome(
        {
          status: locked.status as SyncConflictStatus,
          decision: locked.decision as SyncConflictDecision | null,
        },
        'LOCAL',
      );
      if (outcome.kind === 'existing') {
        return { kind: 'existing' as const };
      }

      const plan = planLocalConflictResolution({
        resourceType: locked.resourceType,
        localVersion: locked.localVersion,
        localSnapshot: locked.localSnapshot,
      });
      if (plan.kind === 'reject') {
        throw new DomainError(plan.code, plan.message);
      }

      // 来源记录事实：取不到即归属未知，不得按猜测的主键写入
      const resourceType = SYNC_SOURCE_RESOURCE_TYPES.find(
        (candidate) => candidate === locked.resourceType,
      );
      if (resourceType === undefined) {
        throw new DomainError(
          SYNC_ERROR.LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED,
          '该资源类型还没有受控版本写入入口，不能执行保留本地裁决',
        );
      }
      const facts = await this.sourceRecordQueryService.listFacts({
        organizationId: locked.organizationId,
        resourceType,
        recordUuids: [locked.recordUuid],
      });
      const fact = facts.facts.get(locked.recordUuid);
      if (fact === undefined || fact.withdrawn) {
        throw new DomainError(
          SYNC_ERROR.CONFLICT_NOT_FOUND,
          '同步冲突的来源记录不可用或已下架，不能执行保留本地裁决',
        );
      }
      // 只读守卫：已删除／下架／冻结／结单的来源不得写回内容。
      // contentState 缺失（事实不完整）同样失败关闭——读不到只读事实不等于可以写。
      if (fact !== undefined) {
        const readOnly = resolveSyncConflictReadOnly(
          fact.contentState ?? { withdrawn: false, frozen: true, closed: false },
        );
        if (readOnly.readOnly) {
          throw new DomainError(
            SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
            '来源记录已是只读内容（已删除／下架／冻结／结单），不得写回内容',
          );
        }
      }
      // 展示版本二次校验（与读侧入口策略对称）：冲突登记的本地版本必须仍是来源记录的
      // 当前版本；记录已被别处推进过时，本地版本已不是"仍新的展示版本"，不得据此写入。
      // 幂等口径（review M7）：冲突行上的幂等状态决定"这一次要不要再写正文"——
      // tx3 失败留下的 WRITING 状态 ＋ 来源版本已推进 ＝ 正文已写，重放只补冲突事实。
      const replay = resolveLocalResolutionReplay({
        resolutionState: locked.localResolutionState,
        localVersion: locked.localVersion,
        sourceCurrentVersion: fact.currentVersion,
      });
      if (replay.kind === 'reject') {
        throw new DomainError(replay.code, replay.message);
      }

      return {
        kind: 'apply' as const,
        payload: plan.payload,
        recordId: fact.recordId,
        bodyAlreadyWritten: replay.kind === 'body-already-written',
      };
    });

    if (prepared.kind === 'existing') {
      return {
        outcome: 'existing',
        conflict: await this.syncConflictService.readConflictSummaryById(input.conflictId),
      };
    }

    if (!prepared.bodyAlreadyWritten) {
      // 幂等标记先落（业务键＝conflict_id）：正文写入前把该行标成 WRITING。
      // 这样 tx3 失败后的重放能识别"正文已写"，不会重复写正文。
      const marked = await this.transactionRunner.run((transactionContext) =>
        this.syncConflictService.markLocalResolutionWriting(input.conflictId, transactionContext),
      );
      if (marked === 0) {
        throw new DomainError(
          SYNC_ERROR.LOCAL_RESOLUTION_CONCURRENTLY_RESOLVED,
          '冲突已被并发裁决为其他方向：本次保留本地未写入正文，请重新读取冲突事实后再决定',
          { conflictId: input.conflictId },
        );
      }

      // 受控写入：由来源业务既有受控入口执行（自持事务，失败即失败关闭）
      await this.appendRevisionUsecase.execute({
        session: input.session,
        requestId: prepared.recordId,
        expectedVersion: prepared.payload.expectedVersion,
        reason: `${prepared.payload.reason}（冲突 ${input.conflictId}）`,
        contentMd: prepared.payload.contentMd ?? undefined,
        handlingResult: this.parseHandlingResult(prepared.payload.handlingResult),
        closureReason: prepared.payload.closureReason ?? undefined,
        expectedMaintenanceVersion: prepared.payload.expectedMaintenanceVersion ?? undefined,
        // 结构化维修记录：形状由受控入口归一化校验（normalizeMaintenanceRecord），
        // 这里只做类型收窄，不改内容
        maintenance: (prepared.payload.maintenance ?? undefined) as
          MaintenanceRecordRawInput | undefined,
      });
    }

    // 写回冲突事实：条件更新只从 PENDING 落 RESOLVED；0 行表示并发已裁决
    const affected = await this.transactionRunner.run((transactionContext) =>
      this.syncConflictService.applyLocalResolution(
        {
          conflictId: input.conflictId,
          action: 'LOCAL',
          confirmedByAccountId: input.session.accountId,
        },
        new Date(),
        transactionContext,
      ),
    );

    if (affected === 0) {
      // 并发期间该冲突已被其他会话裁决：受控修订**已经写入**（版本条件由受控入口裁决），
      // 但冲突事实不能被覆盖。此时不能报"既有事实"——那会让调用方以为什么都没发生。
      throw new DomainError(
        SYNC_ERROR.LOCAL_RESOLUTION_CONCURRENTLY_RESOLVED,
        '冲突已被并发裁决为其他方向：本次保留本地的受控修订已写入，但冲突事实未被改写，请人工核对',
        { conflictId: input.conflictId },
      );
    }

    return {
      outcome: 'resolved',
      conflict: await this.syncConflictService.readConflictSummaryById(input.conflictId),
    };
  }

  /**
   * 处理结果必须是来源业务的真实枚举值：快照里的未知取值不猜语义，直接拒绝。
   * （受控入口自身也会校验，这里先拦一层是为了给出可定位的错误码。）
   */
  private parseHandlingResult(
    value: string | null | undefined,
  ): RepairRequestHandlingResult | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }
    const matched = (Object.values(RepairRequestHandlingResult) as string[]).find(
      (candidate) => candidate === value,
    );
    if (matched === undefined) {
      throw new DomainError(
        SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
        '本地快照里的处理结果不是受控入口认可的真实取值',
      );
    }
    return matched as RepairRequestHandlingResult;
  }
}

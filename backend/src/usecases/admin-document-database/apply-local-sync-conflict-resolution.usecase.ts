// src/usecases/admin-document-database/apply-local-sync-conflict-resolution.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { planLocalConflictResolution } from '@core/local-runtime/policy/sync-conflict-local-resolution.policy';
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
import type { LocalConflictResolutionOutcome } from '@src/usecases/common/ports/local-conflict-resolution.contract';
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

  async execute(input: {
    session: UsecaseSession;
    conflictId: string;
  }): Promise<LocalConflictResolutionOutcome> {
    // 保留本地是管理员动作：权限不足直接失败关闭，不降级
    assertAdminDocumentDatabasePermission(input.session, '裁决保留本地冲突');
    const organizationScope = await resolveAdminOrganizationScope({
      session: input.session,
      accountQueryService: this.accountQueryService,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });

    const prepared = await this.transactionRunner.run(async (transactionContext) => {
      const locked = await this.syncConflictService.lockConflict(
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

      return { kind: 'apply' as const, payload: plan.payload, recordId: fact.recordId };
    });

    if (prepared.kind === 'existing') {
      return {
        outcome: 'existing',
        conflict: await this.syncConflictService.readConflictSummaryById(input.conflictId),
      };
    }

    // 受控写入：由来源业务既有受控入口执行（自持事务，失败即失败关闭）
    await this.appendRevisionUsecase.execute({
      session: input.session,
      requestId: prepared.recordId,
      expectedVersion: prepared.payload.expectedVersion,
      reason: prepared.payload.reason,
      contentMd: prepared.payload.contentMd ?? undefined,
      handlingResult:
        prepared.payload.handlingResult === null
          ? undefined
          : (prepared.payload.handlingResult as never),
      closureReason: prepared.payload.closureReason ?? undefined,
      expectedMaintenanceVersion: prepared.payload.expectedMaintenanceVersion ?? undefined,
      maintenance: (prepared.payload.maintenance ?? undefined) as never,
    });

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

    return {
      outcome: affected === 0 ? 'existing' : 'resolved',
      conflict: await this.syncConflictService.readConflictSummaryById(input.conflictId),
    };
  }
}

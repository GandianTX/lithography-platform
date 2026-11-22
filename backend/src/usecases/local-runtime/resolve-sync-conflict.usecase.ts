// src/usecases/local-runtime/resolve-sync-conflict.usecase.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import {
  resolveSyncConflictOutcome,
  type SyncConflictDecision,
  type SyncConflictStatus,
} from '@core/local-runtime/policy/sync-conflict-resolve.policy';
import { resolveSyncConflictReadOnly } from '@core/local-runtime/policy/sync-conflict-readonly.policy';
import { resolveSyncConflictVersionFreshness } from '@core/local-runtime/policy/sync-conflict-version.policy';
import { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import type {
  ResolveSyncConflictCommand,
  SyncConflictResolveOutcomeView,
} from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { SyncConflictAccessResolver } from './sync-conflict-access.resolver';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

/**
 * 冲突裁决（任务 09 S2.2／R067–R069／R-03）。
 *
 * - 锁读在事务内完成，判定交给 core 策略，写入交给模块服务；
 * - 重复相同方向返回既有事实（`outcome='existing'`），不重复写；
 * - 稍后处理（`outcome='later'`）保持 PENDING，确认人保持为空；
 * - 使用云端（`CLOUD`）只落 decision 与确认人，不回写云端原记录；
 * - **写侧与读侧同一授权口径**：裁决前按**来源记录归属**复核记录级写权
 *   （登记公司不参与放行），避免"看不见却能改"；
 * - **写侧复核展示版本**：冲突登记的本地版本必须仍是来源记录的当前版本，
 *   否则用户裁决的是过期内容，拒绝执行；
 * - 保留本地（`LOCAL`）**不在本用例处理**：它是管理员动作，由管理员文档库域的
 *   受控修订入口执行（任务 04 的工单受控修订入口），GraphQL 层按动作分派；
 *   本用例收到 LOCAL 时显式失败，避免跨域再实现一套权限口径；
 * - 确认人取自 Session（数据库复核后的账号），不接受客户端传入；
 * - 返回体只给冲突**摘要**：裁决是一次写动作，没有必要再带两份正文快照。
 */
@Injectable()
export class ResolveSyncConflictUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly syncConflictService: SyncConflictService,
    private readonly accessResolver: SyncConflictAccessResolver,
    private readonly sourceRecordQueryService: SyncSourceRecordQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: ResolveSyncConflictCommand): Promise<SyncConflictResolveOutcomeView> {
    const scope = await this.scopeResolver.resolve(command.session);

    const prepared = await this.transactionRunner.run(async (transactionContext) => {
      const locked = await this.syncConflictService.lockConflictView(
        command.conflictId,
        transactionContext,
      );
      if (!locked) {
        throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
      }
      // 范围校验：一级管理员（organizationId=null）可见全部，其余必须命中本公司数据区
      if (scope.organizationId !== null && locked.organizationId !== scope.organizationId) {
        throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
      }

      const outcome = resolveSyncConflictOutcome(
        {
          status: locked.status as SyncConflictStatus,
          decision: locked.decision as SyncConflictDecision | null,
        },
        command.action,
      );

      if (outcome.kind === 'later') {
        return { kind: 'later' as const };
      }

      if (outcome.kind === 'existing') {
        return { kind: 'existing' as const };
      }

      if (outcome.action === 'CLOUD') {
        // 写侧授权复核：与读侧同一口径（按来源记录归属判定，登记公司不参与放行）
        const access = await this.accessResolver.resolveRowAccess({
          row: {
            recordUuid: locked.recordUuid,
            organizationId: locked.organizationId,
            resourceType: locked.resourceType,
          },
          sessionAccountId: command.session.accountId,
          scope,
        });
        if (!access.allowed) {
          // 与读侧一致：不通过存在性泄露（与"不存在"同码同文案）
          throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
        }

        // 展示版本复核：冲突登记的本地版本必须仍是来源记录的当前版本
        await this.assertFreshDisplayVersion(locked);

        const affected = await this.syncConflictService.applyCloudResolution(
          {
            conflictId: command.conflictId,
            action: 'CLOUD',
            confirmedByAccountId: command.session.accountId,
          },
          new Date(),
          transactionContext,
        );
        // 持锁情况下 0 行只可能是并发已裁决：回读既有事实，不覆盖
        return { kind: affected === 0 ? ('existing' as const) : ('resolved' as const) };
      }

      // LOCAL：保留本地是管理员动作，由管理员文档库域的受控修订入口执行；
      // 本用例只处理"使用云端"与"稍后处理"（跨域不重复实现权限口径）。
      // 载荷映射与资源类型准入见 core/local-runtime/policy/sync-conflict-local-resolution.policy.ts。
      throw new DomainError(
        SYNC_ERROR.LOCAL_RESOLUTION_REQUIRES_ADMIN_ENTRY,
        '保留本地需通过管理员受控修订入口执行',
      );
    });

    return {
      outcome: prepared.kind,
      conflict: await this.syncConflictService.readConflictSummaryById(command.conflictId),
    };
  }

  /**
   * 展示版本复核：冲突登记的本地版本必须仍是来源记录的当前版本。
   *
   * 取不到来源事实（资源类型不在白名单 / 记录已删除 / 归属已变更）时按
   * "不可核验"处理——读不到依据不等于可以写。
   */
  private async assertFreshDisplayVersion(locked: {
    recordUuid: string;
    organizationId: number;
    resourceType: string;
    localVersion: number | null;
  }): Promise<void> {
    const resourceType = SYNC_SOURCE_RESOURCE_TYPES.find(
      (candidate) => candidate === locked.resourceType,
    );
    if (resourceType === undefined) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '同步冲突的来源记录不可核验，不能按当前展示版本执行裁决',
      );
    }
    const facts = await this.sourceRecordQueryService.listFacts({
      organizationId: locked.organizationId,
      resourceType,
      recordUuids: [locked.recordUuid],
    });
    const fact = facts.facts.get(locked.recordUuid);
    // 只读守卫：已删除／下架／冻结／结单的来源不得用云端版本恢复内容。
    // contentState 缺失（事实不完整）同样失败关闭——读不到只读事实不等于可以写。
    if (fact !== undefined) {
      const readOnly = resolveSyncConflictReadOnly(
        fact.contentState ?? { withdrawn: false, frozen: true, closed: false },
      );
      if (readOnly.readOnly) {
        throw new DomainError(
          SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
          '来源记录已是只读内容（已删除／下架／冻结／结单），不得用云端版本恢复内容',
        );
      }
    }
    const freshness = resolveSyncConflictVersionFreshness({
      conflictLocalVersion: locked.localVersion,
      recordCurrentVersion: fact?.currentVersion ?? null,
      versionTrusted: fact?.versionTrusted ?? false,
    });
    if (!freshness.fresh) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '同步冲突的展示版本已不是来源记录的当前版本，请刷新后重新裁决',
      );
    }
  }
}

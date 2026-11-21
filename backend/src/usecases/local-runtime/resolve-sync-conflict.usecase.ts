// src/usecases/local-runtime/resolve-sync-conflict.usecase.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import {
  resolveSyncConflictOutcome,
  type SyncConflictDecision,
  type SyncConflictStatus,
} from '@core/local-runtime/policy/sync-conflict-resolve.policy';
import { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import type {
  ResolveSyncConflictCommand,
  SyncConflictResolveOutcomeView,
} from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
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
}

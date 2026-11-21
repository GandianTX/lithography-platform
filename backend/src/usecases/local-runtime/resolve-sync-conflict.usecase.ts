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
 * 冲突裁决（任务 09 S2.2／R067–R069）。
 *
 * - 锁读在事务内完成，判定交给 core 策略，写入交给模块服务；
 * - 重复相同方向返回既有事实（`outcome='existing'`），不重复写；
 * - 稍后处理（`outcome='later'`）保持 PENDING，确认人保持为空；
 * - 保留本地（LOCAL）需要来源业务受控版本写入入口（X04），
 *   当前由策略显式失败，不静默覆盖；
 * - 确认人取自 Session（数据库复核后的账号），不接受客户端传入。
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

    return this.transactionRunner.run(async (transactionContext) => {
      const locked = await this.syncConflictService.lockConflict(
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
        return {
          outcome: 'later' as const,
          conflict: await this.syncConflictService.readConflictById(
            command.conflictId,
            transactionContext,
          ),
        };
      }

      if (outcome.kind === 'existing') {
        return {
          outcome: 'existing' as const,
          conflict: await this.syncConflictService.readConflictById(
            command.conflictId,
            transactionContext,
          ),
        };
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
        if (affected === 0) {
          // 持锁情况下 0 行只可能是并发已裁决：回读既有事实，不覆盖
          return {
            outcome: 'existing' as const,
            conflict: await this.syncConflictService.readConflictById(
              command.conflictId,
              transactionContext,
            ),
          };
        }
        const conflict = await this.syncConflictService.readConflictById(
          command.conflictId,
          transactionContext,
        );
        if (!conflict) {
          throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '裁决后未能回读冲突事实');
        }
        return { outcome: 'resolved' as const, conflict };
      }

      // LOCAL：策略已显式拒绝，这里只做防御
      throw new DomainError(
        SYNC_ERROR.LOCAL_RESOLUTION_NOT_AVAILABLE,
        '保留本地需要来源业务的受控版本写入入口，尚未接入',
      );
    });
  }
}

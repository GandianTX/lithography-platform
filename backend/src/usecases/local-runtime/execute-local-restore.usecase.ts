// src/usecases/local-runtime/execute-local-restore.usecase.ts

/**
 * 恢复**执行**（任务 09 S5-2／S5-3）。
 *
 * - 权限口径与受理一致：**工程师无恢复权限**；二级管理员只能恢复本公司；
 *   一级管理员（全局范围）可恢复任意公司；
 * - **执行 ≠ 成功**：受理后才可执行；执行结果（成功／失败／原因）如实返回，
 *   失败时**保持冻结**（设备继续停写停传），保护副本与任务不被清理；
 * - 终态写回恢复运行（状态 ＋ 原因 ＋ 范围），页面据此显示原因、进度与结果。
 */

import { Injectable } from '@nestjs/common';

import { assertLocalRuntimeAdministrator } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';

import type { UsecaseSession } from '@app-types/auth/session.types';

import {
  LocalRestoreExecutionService,
  type LocalRestoreExecutionOutcome,
} from '@src/modules/lithography/local-restore-execution.service';

import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

export type ExecuteLocalRestoreCommand = {
  session: UsecaseSession;
  /** 稳定恢复 ID（来自受理结论） */
  restoreId: string;
};

export type ExecuteLocalRestoreResult = {
  restoreId: string;
  status: 'SUCCEEDED' | 'FAILED';
  /** 受控原因码（失败时必有） */
  reasonCode: string | null;
  /** 受控原因说明（失败时必有） */
  reason: string | null;
  /** 逐项恢复计数（成功时给出） */
  restored: { records: number; originals: number; queue: number } | null;
  /** 冻结是否已解除（成功＝true；失败＝保持冻结） */
  released: boolean;
  /** 失败时是否**保持冻结**（设备继续停写停传） */
  holdRetained: boolean;
};

@Injectable()
export class ExecuteLocalRestoreUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly restoreExecutionService: LocalRestoreExecutionService,
  ) {}

  async execute(command: ExecuteLocalRestoreCommand): Promise<ExecuteLocalRestoreResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    // 工程师无恢复权限（与预检／受理同一口径）
    assertLocalRuntimeAdministrator(scope);

    const outcome: LocalRestoreExecutionOutcome = await this.restoreExecutionService.execute({
      restoreId: command.restoreId,
      actorAccountId: command.session.accountId,
      // 公司授权范围：一级管理员为 null（全局范围）；二级管理员仅本公司。
      // 传入后由执行服务**按最新运行事实**复核（防止跨公司执行他人恢复）。
      allowedOrganizationId: scope.organizationId,
      now: new Date(),
    });

    if (outcome.status === 'FAILED') {
      return {
        restoreId: outcome.restoreId,
        status: 'FAILED',
        reasonCode: outcome.reasonCode,
        reason: outcome.reason,
        restored: null,
        released: false,
        holdRetained: outcome.holdRetained,
      };
    }

    return {
      restoreId: outcome.restoreId,
      status: 'SUCCEEDED',
      reasonCode: null,
      reason: null,
      restored: outcome.restored,
      released: outcome.released,
      // 成功但冻结未解除时也为 true：设备仍在停写停传（如实回报，不假装已解冻）
      holdRetained: outcome.holdRetained,
    };
  }
}

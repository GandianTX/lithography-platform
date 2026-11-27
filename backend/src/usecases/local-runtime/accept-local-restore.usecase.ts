// src/usecases/local-runtime/accept-local-restore.usecase.ts

/**
 * 恢复**受理**（任务 09 S5 第 1 条）：确认前再次检查权限、目标与保护副本。
 *
 * - **受理 ≠ 恢复**：受理只把"这次恢复已被授权确认"的事实写进预检记录，
 *   **不冻结写入、不恢复数据、不产生成功结论**（恢复执行链属 S5-2，另受闸门授权约束）；
 * - **工程师无恢复权限**：与预检同一口径；
 * - 二级管理员只能受理本公司；一级管理员（全局范围）可受理任意公司。
 */

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { assertLocalRuntimeAdministrator } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { BackupRestoreAcceptanceService } from '@src/modules/lithography/backup-restore-acceptance.service';

import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

export type AcceptLocalRestoreCommand = {
  session: UsecaseSession;
  /** 稳定恢复 ID（来自预检结论） */
  restoreId: string;
};

export type AcceptLocalRestoreResult = {
  restoreId: string;
  accepted: boolean;
  backupId: string | null;
  protectionBackupId: string | null;
  organizationId: number | null;
  acceptedAt: string | null;
};

@Injectable()
export class AcceptLocalRestoreUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly acceptanceService: BackupRestoreAcceptanceService,
  ) {}

  async execute(command: AcceptLocalRestoreCommand): Promise<AcceptLocalRestoreResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    assertLocalRuntimeAdministrator(scope);

    const review = await this.acceptanceService.review({
      restoreId: command.restoreId,
      acceptedByAccountId: command.session.accountId,
      // 一级管理员为全局范围（null＝任意公司）；二级管理员仅本公司
      allowedOrganizationId: scope.organizationId,
      now: new Date(),
    });

    if (!review.accepted) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.BACKUP_STATE_CONFLICT, review.reason);
    }

    return {
      restoreId: review.restoreId,
      accepted: true,
      backupId: review.backupId,
      protectionBackupId: review.protectionBackupId,
      organizationId: review.organizationId,
      acceptedAt: review.acceptedAt,
    };
  }
}

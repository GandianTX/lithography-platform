// src/usecases/local-runtime/update-local-backup-plan.usecase.ts

/**
 * 修改公司维度的本地备份计划开关（任务 09 S4）。
 *
 * 口径（与调度器同一份实现，不另立开关规则）：
 * - 只改**当前计划行**；两个开关分开控制（本地自动备份 / 云自动上云）；
 * - 改开关**不重置周期**：`next_backup_at` 不变，计划仍只由"自动成功"推进；
 * - 写入口只落开关，不触发任何备份动作（"退出页面仍可后台运行"靠后台扫描，不靠页面）。
 *
 * 准入：工程师拒绝；一级管理员可改任意公司；二级管理员只能改本公司。
 */

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { assertBackupPlanWritable } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { LocalBackupPlanService } from '@src/modules/lithography/local-backup-plan.service';

import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';

export type UpdateLocalBackupPlanCommand = {
  session: UsecaseSession;
  /** 目标公司数据区 */
  organizationId: number;
  /** 本地自动备份开关（未提供＝保持原值） */
  backupEnabled?: boolean;
  /** 云自动上云开关（未提供＝保持原值） */
  autoUploadEnabled?: boolean;
};

export type UpdateLocalBackupPlanResult = {
  organizationId: number;
  backupEnabled: boolean;
  backupIntervalHours: number;
  nextBackupAt: Date | null;
  autoUploadEnabled: boolean;
  initializedAt: Date;
};

@Injectable()
export class UpdateLocalBackupPlanUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly backupPlanService: LocalBackupPlanService,
  ) {}

  async execute(command: UpdateLocalBackupPlanCommand): Promise<UpdateLocalBackupPlanResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    assertBackupPlanWritable(scope, command.organizationId);
    // 写入冻结闸门（任务 09 S5-2）：恢复期冻结的目标公司**不改备份开关**
    await this.localWriteHoldService.assertCompanyWritable({
      organizationId: command.organizationId,
    });

    const plan = await this.backupPlanService.updateCompanyBackupPlan({
      organizationId: command.organizationId,
      backupEnabled: command.backupEnabled,
      autoUploadEnabled: command.autoUploadEnabled,
    });
    if (plan === null) {
      throw new DomainError(
        LOCAL_RUNTIME_ERROR.BACKUP_RUN_NOT_FOUND,
        '该公司尚未建立本地备份计划，无法修改开关',
      );
    }
    return {
      organizationId: plan.organizationId,
      backupEnabled: plan.backupEnabled,
      backupIntervalHours: plan.backupIntervalHours,
      nextBackupAt: plan.nextBackupAt,
      autoUploadEnabled: plan.autoUploadEnabled,
      initializedAt: plan.initializedAt,
    };
  }
}

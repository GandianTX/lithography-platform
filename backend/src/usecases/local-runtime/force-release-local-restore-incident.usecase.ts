// src/usecases/local-runtime/force-release-local-restore-incident.usecase.ts

/**
 * 恢复**故障现场**的受控解冻（管理员处置入口，任务 09 独立验收 P2-2）。
 *
 * - 权限口径与恢复链一致：**工程师无处置权限**；二级管理员只能处置本公司；
 *   一级管理员（全局范围）可处置任意公司；
 * - **解冻 ≠ 恢复成功**：本用例只解除"停写停传"，**不改判**恢复终态、
 *   不触碰恢复数据；处置结论如实返回（已解除／无需解除／被拒绝）；
 * - **默认失败关闭**：恢复仍在运行、目标不匹配、保护副本或数据一致性无法确认、
 *   冻结归属别的恢复、没有显式确认或处置原因 ⇒ 一律拒绝并保持冻结；
 * - 拒绝与失败都留下审计（阶段承载处置事实），日志只带受控码与标识。
 */

import { Injectable } from '@nestjs/common';

import {
  assertLocalRuntimeAdminLevel,
  assertLocalRuntimeAdministrator,
} from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';

import type { UsecaseSession } from '@app-types/auth/session.types';

import {
  LocalRestoreIncidentReleaseService,
  type LocalRestoreIncidentReleaseOutcome,
} from '@src/modules/lithography/local-restore-incident-release.service';

import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

export type ForceReleaseLocalRestoreIncidentCommand = {
  session: UsecaseSession;
  /** 现场对应的稳定恢复 ID（必须与该条冻结的归属一致） */
  restoreId: string;
  /** 处置原因（必填；只进审计与日志） */
  reason: string;
  /** 显式确认（必填）：调用方须已向操作者展示后果并取得确认 */
  confirmed: boolean;
};

export type ForceReleaseLocalRestoreIncidentResult = LocalRestoreIncidentReleaseOutcome;

@Injectable()
export class ForceReleaseLocalRestoreIncidentUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly incidentReleaseService: LocalRestoreIncidentReleaseService,
  ) {}

  async execute(
    command: ForceReleaseLocalRestoreIncidentCommand,
  ): Promise<ForceReleaseLocalRestoreIncidentResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    // 工程师无处置权限（与恢复链同一口径）
    assertLocalRuntimeAdministrator(scope);
    // 处置人的**实际**管理员等级：缺失或不合法即失败关闭，
    // 不缺省成一级（否则处置审计会把二级管理员的处置记成一级）。
    const actorAdminLevel = assertLocalRuntimeAdminLevel(scope);

    return await this.incidentReleaseService.release({
      restoreId: command.restoreId,
      actorAccountId: command.session.accountId,
      actorAdminLevel,
      // 公司授权范围：一级管理员为 null（全局范围）；二级管理员仅本公司
      allowedOrganizationId: scope.organizationId,
      actorIsAdministrator: scope.role !== 'ENGINEER',
      reason: command.reason,
      confirmed: command.confirmed,
      now: new Date(),
    });
  }
}

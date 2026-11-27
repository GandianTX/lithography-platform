// src/usecases/local-runtime/cleanup-local-backup-packages.usecase.ts

import {
  DomainError,
  LOCAL_RUNTIME_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { assertLocalRuntimeAdministrator } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';

import {
  LocalBackupCleanupService,
  type BackupCleanupItemResult,
  type BackupCleanupResult,
} from '@src/modules/lithography/local-backup-cleanup.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';

import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/** 清理方式：MANUAL 手动清理 / RETENTION 过期清理 */
export type LocalBackupCleanupModeCommand = 'MANUAL' | 'RETENTION';

export type CleanupLocalBackupPackagesResult = {
  mode: LocalBackupCleanupModeCommand;
  organizationId: number;
  /** 是否具备清理授权；不可用时已清理数必为 0 */
  available: boolean;
  /** 不可用原因 */
  reason: string | null;
  targetCount: number;
  cleaned: number;
  retained: number;
  /** 逐项结果（已清理／仍保留） */
  items: BackupCleanupItemResult[];
};

/**
 * 清理本机本公司的本地备份包（任务 09 S3.3）。
 *
 * 口径（R074-01～03、R083-01；验收 A09-05／A09-08）：
 * - **手动清理**的授权来源是服务端已落库的「本次手动备份」的完整云端回执，客户端不能传入回执；
 *   没有完整回执即零清理（不动任何本机包、不改任何资产状态），入口如实不可用；
 *   授权成立后清理本设备本公司范围内**全部**本地备份包，不额外要求每个旧包各自有云副本；
 * - **过期清理**按约 30 天保留窗口执行，且不开放工程师（R083：管理员过期清理）；
 * - 两种方式都只清理本机本公司的包：业务、原件、云副本与外公司哨兵不受影响；
 * - 逐项结果如实返回：已清理与仍保留分别可追踪。
 */
@Injectable()
export class CleanupLocalBackupPackagesUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly cleanupService: LocalBackupCleanupService,
    private readonly localWriteHoldService: LocalWriteHoldService,
  ) {}

  async execute(command: {
    session: UsecaseSession;
    mode: LocalBackupCleanupModeCommand;
    organizationId?: number | null;
  }): Promise<CleanupLocalBackupPackagesResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    if (command.mode === 'RETENTION') {
      // 管理员过期清理不开放工程师
      assertLocalRuntimeAdministrator(scope);
    }

    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
    }

    const organizationId = this.resolveTargetOrganization(
      scope.organizationId,
      command.organizationId ?? null,
      installation,
    );

    // 恢复期冻结：该公司数据区正在恢复时不得清理本地包（保护副本与待恢复包不能被删）
    await this.localWriteHoldService.assertCompanyWritable({ organizationId });

    if (command.mode === 'RETENTION') {
      const result = await this.cleanupService.cleanupExpiredPackages({
        organizationId,
        installationId: installation.installationId,
      });
      return this.toResult('RETENTION', organizationId, result);
    }

    // 手动清理：授权只认「本次手动备份」取得的完整云回执（服务端已落库的资产事实）
    const receiptSource = await this.cleanupService.findManualRunCloudReceipt({
      organizationId,
      installationId: installation.installationId,
    });
    const result = await this.cleanupService.cleanupManualPackages({
      organizationId,
      installationId: installation.installationId,
      cloudReceipt: receiptSource?.receipt ?? null,
    });
    return this.toResult('MANUAL', organizationId, result);
  }

  /**
   * 目标公司裁决：二级管理员与工程师只能清理本公司；一级管理员可指定，
   * 省略时取本机映射公司，未映射则失败关闭（不退化为"随便挑一个公司"）。
   */
  private resolveTargetOrganization(
    scopeOrganizationId: number | null,
    requested: number | null,
    installation: { organizationId: number | null },
  ): number {
    if (scopeOrganizationId !== null) {
      if (requested !== null && requested !== scopeOrganizationId) {
        throw new DomainError(
          PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
          '只能清理本机所属公司的本地备份包',
        );
      }
      return scopeOrganizationId;
    }

    if (requested !== null) {
      return requested;
    }
    if (installation.organizationId !== null) {
      return installation.organizationId;
    }
    throw new DomainError(
      LOCAL_RUNTIME_ERROR.INVALID_PARAMS,
      '本机未映射公司，请明确指定清理目标公司',
    );
  }

  private toResult(
    mode: LocalBackupCleanupModeCommand,
    organizationId: number,
    result: BackupCleanupResult,
  ): CleanupLocalBackupPackagesResult {
    return {
      mode,
      organizationId,
      available: result.available,
      reason: result.reason,
      targetCount: result.targetCount,
      cleaned: result.cleaned,
      retained: result.retained,
      items: result.items,
    };
  }
}

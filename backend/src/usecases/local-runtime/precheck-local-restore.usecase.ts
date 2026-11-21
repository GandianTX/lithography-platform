// src/usecases/local-runtime/precheck-local-restore.usecase.ts

import {
  DomainError,
  LOCAL_RUNTIME_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { assertLocalRuntimeAdministrator } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { Injectable } from '@nestjs/common';

import { ProtectedBackupService } from '@src/modules/lithography/protected-backup.service';
import {
  BackupRestorePrecheckService,
  type RestorePrecheckResult,
} from '@src/modules/lithography/backup-restore-precheck.service';
import { LocalBackupAssetQueryService } from '@src/modules/lithography/queries/local-backup-asset.query.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';

import type { PrecheckLocalRestoreCommand } from './local-runtime.command.types';
import { normalizeBackupId } from './local-runtime.input.normalize';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 恢复预检（R085-01／02，任务书第 12 节「恢复」）。
 *
 * 准入：
 * - 恢复不开放工程师（R083／R085），只允许管理员；
 * - 二级管理员只能预检本公司数据区的备份；一级管理员按全局范围。
 *
 * 执行：
 * - 目标核对（原设备、同公司、权限）＋包完整性逐文件核对；
 * - 生成当前范围的保护副本，并把保护副本资产 ID 绑进预检快照；
 * - 只写恢复预检事实，不写任何业务表。
 *
 * 恢复**执行**入口不在本用例：写入/同步闸门与失败回滚补偿能力尚未落地，
 * 因此执行阶段保持如实不可用（见证据记录的结构缺口说明）。
 */
@Injectable()
export class PrecheckLocalRestoreUsecase {
  constructor(
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly backupAssetQueryService: LocalBackupAssetQueryService,
    private readonly precheckService: BackupRestorePrecheckService,
    private readonly protectedBackupService: ProtectedBackupService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
  ) {}

  async execute(command: PrecheckLocalRestoreCommand): Promise<RestorePrecheckResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    assertLocalRuntimeAdministrator(scope);

    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
    }

    const backupId = normalizeBackupId(command.backupId);

    const asset = await this.backupAssetQueryService.readAssetSnapshot(backupId);
    if (asset === null) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INVALID_PARAMS, '备份记录不存在');
    }
    if (scope.organizationId !== null && asset.organizationId !== scope.organizationId) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '只能对本公司数据区的备份发起恢复预检',
      );
    }

    const now = new Date();
    const protectionPath = this.protectedBackupService.resolvePackageTargetPath(
      asset.organizationId,
      'MANUAL',
      now,
    );

    return this.precheckService.execute({
      asset,
      currentInstallationId: installation.installationId,
      allowedOrganizationId: scope.organizationId,
      startedByAccountId: command.session.accountId,
      createProtectionCopy: async (organizationId: number) => {
        const result = await this.protectedBackupService.generateProtectedBackup({
          organizationId,
          runId: null,
          targetPath: protectionPath,
        });
        return { backupId: result.backupId, packagePath: result.packagePath };
      },
      now,
    });
  }
}

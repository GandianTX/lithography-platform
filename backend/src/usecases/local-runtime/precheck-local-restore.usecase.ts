// src/usecases/local-runtime/precheck-local-restore.usecase.ts

import {
  DomainError,
  LOCAL_RUNTIME_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { assertLocalRuntimeAdministrator } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { LOCAL_BACKUP_FAILURE_REASON } from '@core/local-runtime/policy/local-backup-failure-reason';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ProtectedBackupService } from '@src/modules/lithography/protected-backup.service';
import {
  BackupRestorePrecheckService,
  type RestorePrecheckResult,
} from '@src/modules/lithography/backup-restore-precheck.service';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import { LocalBackupAssetQueryService } from '@src/modules/lithography/queries/local-backup-asset.query.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

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
    private readonly localRuntimeService: LocalRuntimeService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly logger: PinoLogger,
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
        // 保护副本是真实的一份受保护备份包：必须归属真实的本地备份运行
        // （backup_asset.run_id 是 NOT NULL 外键，不能悬空）。
        const protectionRun = await this.transactionRunner.run(async (transactionContext) =>
          this.localRuntimeService.insertBackupRun(
            {
              installationId: installation.installationId,
              organizationId,
              triggerType: 'MANUAL',
              startedAt: now,
              manifestPath: null,
              manualUploadStatus: 'PENDING',
              manualCleanupStatus: 'PENDING',
            },
            transactionContext,
          ),
        );

        try {
          const result = await this.protectedBackupService.generateProtectedBackup({
            organizationId,
            runId: protectionRun.id,
            targetPath: protectionPath,
          });

          await this.transactionRunner.run(async (transactionContext) => {
            await this.localRuntimeService.finishBackupRun(
              protectionRun.id,
              {
                status: 'SUCCEEDED',
                finishedAt: new Date(),
                manifestPath: result.packagePath,
                manifestChecksum: result.manifestChecksum,
                byteSize: result.byteSize,
                attachmentCount: null,
                schemaVersion: null,
                errorCode: null,
                errorMessage: null,
              },
              transactionContext,
            );
          });

          return { backupId: result.backupId, packagePath: result.packagePath };
        } catch (error) {
          // 原始异常只进服务端日志；落库只给受控原因码
          this.logger.error(
            { backupRunId: protectionRun.id, err: error },
            '恢复预检的保护副本生成失败',
          );
          const reason = LOCAL_BACKUP_FAILURE_REASON.PROTECTION_COPY_FAILED;
          await this.transactionRunner.run(async (transactionContext) => {
            await this.localRuntimeService.finishBackupRun(
              protectionRun.id,
              {
                status: 'FAILED',
                finishedAt: new Date(),
                manifestChecksum: null,
                byteSize: null,
                attachmentCount: null,
                schemaVersion: null,
                errorCode: 'BACKUP_GENERATION_FAILED',
                errorMessage: reason,
              },
              transactionContext,
            );
          });
          throw error;
        }
      },
      now,
    });
  }
}

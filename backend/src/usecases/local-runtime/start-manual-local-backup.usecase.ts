// src/usecases/local-runtime/start-manual-local-backup.usecase.ts

import {
  DomainError,
  LOCAL_RUNTIME_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { LOCAL_BACKUP_FAILURE_REASON } from '@core/local-runtime/policy/local-backup-failure-reason';

import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import { ProtectedBackupService } from '@src/modules/lithography/protected-backup.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import type {
  StartManualLocalBackupCommand,
  StartManualLocalBackupResult,
} from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 手动备份并清理本地备份包（R074-01～03 的「生成」阶段）。
 *
 * 范围口径：
 * - 二级管理员与工程师：目标公司只能是本公司；传入其他公司直接拒绝；
 * - 一级管理员：可指定任意公司；省略时取本机映射公司，未映射则失败关闭。
 *
 * 阶段事实（如实呈现，不假装已完成）：
 * - 生成：本用例真实执行受保护包生成，成功后返回备份 ID、清单校验值与字节数；
 * - 上云：云接收端未接入时保持 PENDING（不伪造成功、不伪造回执）；
 * - 清理：无完整云回执时不执行本地包清理，保持 PENDING。
 */
@Injectable()
export class StartManualLocalBackupUsecase {
  constructor(
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly localRuntimeService: LocalRuntimeService,
    private readonly protectedBackupService: ProtectedBackupService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly logger: PinoLogger,
  ) {}

  async execute(command: StartManualLocalBackupCommand): Promise<StartManualLocalBackupResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
    }

    const organizationId = this.resolveTargetOrganization(
      scope.organizationId,
      command,
      installation,
    );
    const now = new Date();

    // 恢复期冻结：该公司数据区正在恢复时不得再生成备份包（会把恢复中的数据出盘）
    await this.localWriteHoldService.assertCompanyWritable({ organizationId });

    const run = await this.transactionRunner.run(async (transactionContext) =>
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

    const targetPath = this.protectedBackupService.resolvePackageTargetPath(
      organizationId,
      'MANUAL',
      now,
      run.id,
    );

    try {
      const result = await this.protectedBackupService.generateProtectedBackup({
        organizationId,
        runId: run.id,
        targetPath,
      });

      await this.transactionRunner.run(async (transactionContext) => {
        await this.localRuntimeService.finishBackupRun(
          run.id,
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

      return {
        runId: run.id,
        organizationId,
        status: 'SUCCEEDED',
        backupId: result.backupId,
        manifestChecksum: result.manifestChecksum,
        byteSize: result.byteSize,
        errorCode: null,
        errorMessage: null,
        uploadStatus: 'PENDING',
        cleanupStatus: 'PENDING',
      };
    } catch (error) {
      // 原始异常（含本机绝对路径）只进服务端日志；对外与落库只给受控原因码
      this.logger.error({ runId: run.id, err: error }, '手动本地备份失败');
      const reason = LOCAL_BACKUP_FAILURE_REASON.BACKUP_GENERATION_FAILED;
      await this.transactionRunner.run(async (transactionContext) => {
        await this.localRuntimeService.finishBackupRun(
          run.id,
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

      return {
        runId: run.id,
        organizationId,
        status: 'FAILED',
        backupId: null,
        manifestChecksum: null,
        byteSize: null,
        errorCode: 'BACKUP_GENERATION_FAILED',
        errorMessage: reason,
        uploadStatus: 'NOT_REQUIRED',
        cleanupStatus: 'NOT_REQUIRED',
      };
    }
  }

  /**
   * 目标公司裁决：一级管理员可指定；其余只能是本公司。
   *
   * 一级管理员省略时取本机映射公司；本机未映射公司则失败关闭，
   * 不退化为"随便挑一个公司"。
   */
  private resolveTargetOrganization(
    scopeOrganizationId: number | null,
    command: StartManualLocalBackupCommand,
    installation: { organizationId: number | null },
  ): number {
    const requested = command.organizationId ?? null;

    if (scopeOrganizationId !== null) {
      if (requested !== null && requested !== scopeOrganizationId) {
        throw new DomainError(
          PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
          '只能对本机所属公司发起备份',
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
      '本机未映射公司，请明确指定备份目标公司',
    );
  }
}

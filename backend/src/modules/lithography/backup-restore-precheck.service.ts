// src/modules/lithography/backup-restore-precheck.service.ts

import * as nodePath from 'node:path';

import { LOCAL_BACKUP_FAILURE_REASON } from '@core/local-runtime/policy/local-backup-failure-reason';
import { parseBackupManifest } from '@core/local-runtime/policy/protected-backup.policy';
import {
  buildRestoreCheckSnapshot,
  evaluateRestoreTarget,
  resolveRestoreCheckOutcome,
  restoreCheckFindingCodeValues,
  type RestoreCheckFinding,
  type RestoreCheckOutcome,
  type RestoreCheckPackage,
  type RestoreCheckProtection,
  type RestoreCheckSnapshot,
  type RestoreCheckTarget,
} from '@core/local-runtime/policy/restore-precheck.policy';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { Repository, type QueryDeepPartialEntity } from 'typeorm';

import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';
import { sha256FileDigest } from '@core/common/digest/file-digest';

/** 逐文件流式 SHA-256 核对，不整读进内存 */

/** 被恢复的备份资产事实（只读快照，不跨层暴露 ORM 实体） */
export type RestorePrecheckAsset = {
  backupId: string;
  organizationId: number;
  installationId: string | null;
  /** 本机包目录；本地包已清理时为 null */
  localReference: string | null;
  localStatus: string;
  manifestChecksum: string | null;
};

export type RestorePrecheckInput = {
  /** 被恢复的备份资产 */
  asset: RestorePrecheckAsset;
  /** 本机安装标识 */
  currentInstallationId: string;
  /** 查看者可操作的公司范围；null 表示全局范围 */
  allowedOrganizationId: number | null;
  /** 发起人账号 ID */
  startedByAccountId: number;
  /** 保护副本生成回调（由用例层提供，避免模块层决定业务写入顺序） */
  createProtectionCopy: (organizationId: number) => Promise<{
    backupId: string;
    packagePath: string;
  }>;
  /**
   * 预检事实写入失败时的补偿回调（review M8）：回收刚生成的保护副本，
   * 不留孤儿包与孤儿资产。缺省表示不补偿（调用方没有可回收对象）。
   */
  discardProtectionCopy?: () => Promise<void>;
  now?: Date;
};

export type RestorePrecheckResult = {
  restoreId: string;
  outcome: RestoreCheckOutcome;
  snapshot: RestoreCheckSnapshot;
};

/**
 * 恢复预检执行层（任务 09 S4，R085-01／02）。
 *
 * 只做三件事：
 * 1. 目标核对：原设备、同公司、查看者权限；
 * 2. 包完整性：读清单并逐文件流式核对 SHA-256；
 * 3. 保护副本：把当前范围快照成一份新的受保护备份，并把它的资产 ID 绑进预检快照。
 *
 * 预检**不写业务表**：唯一写入是恢复预检事实（backup_restore_run，status=PENDING）。
 * 恢复执行入口不在本层：写入/同步闸门与失败回滚补偿能力尚未落地（结构缺口 P2），
 * 因此执行阶段保持如实不可用，不在这里伪造"已恢复"。
 */
@Injectable()
export class BackupRestorePrecheckService {
  constructor(
    @InjectRepository(BackupRestoreRunEntity)
    private readonly restoreRunRepository: Repository<BackupRestoreRunEntity>,
    private readonly logger: PinoLogger,
  ) {}

  async execute(input: RestorePrecheckInput): Promise<RestorePrecheckResult> {
    const now = input.now ?? new Date();
    const findings: RestoreCheckFinding[] = [];

    const target: RestoreCheckTarget = {
      backupId: input.asset.backupId,
      organizationId: input.asset.organizationId,
      installationId: input.asset.installationId,
      manifestChecksum: input.asset.manifestChecksum,
    };

    findings.push(
      ...evaluateRestoreTarget({
        targetInstallationId: input.asset.installationId,
        currentInstallationId: input.currentInstallationId,
        targetOrganizationId: input.asset.organizationId,
        allowedOrganizationId: input.allowedOrganizationId,
        localPackageRetained:
          input.asset.localStatus !== 'CLEANED' && input.asset.localReference !== null,
      }),
    );

    const packageFact = await this.verifyPackage(input.asset, findings);
    const protection = await this.createProtection(input, findings);

    const snapshot = buildRestoreCheckSnapshot({
      checkedAt: now,
      target,
      package: packageFact,
      protection,
      findings,
    });

    const outcome = resolveRestoreCheckOutcome(findings);
    const restoreId = randomUUID();
    try {
      await this.restoreRunRepository.insert({
        restoreId,
        backupId: input.asset.backupId,
        // 与快照里的保护副本一致（review M8）：不再固定写 null
        protectionBackupId: protection.backupId,
        targetInstallationId: input.currentInstallationId,
        checkStatus: outcome,
        confirmation: null,
        organizationId: input.asset.organizationId,
        startedByAccountId: input.startedByAccountId,
        status: 'PENDING',
        checkSnapshot: JSON.stringify(snapshot),
        restoredScope: null,
        resultSummary: null,
        startedAt: null,
        finishedAt: null,
      } as unknown as QueryDeepPartialEntity<BackupRestoreRunEntity>);
    } catch (error) {
      // 补偿（review M8）：预检事实没写成时，刚生成的保护副本就成了孤儿——
      // 当场回收，不留孤儿包与孤儿资产。
      if (input.discardProtectionCopy) {
        try {
          await input.discardProtectionCopy();
        } catch (discardError) {
          this.logger.error(
            { backupId: input.asset.backupId, err: discardError },
            '恢复预检事实写入失败后的保护副本回收未成功',
          );
        }
      }
      throw error;
    }

    return { restoreId, outcome, snapshot };
  }

  /** 包完整性核对：清单可读性与逐文件校验值 */
  private async verifyPackage(
    asset: RestorePrecheckAsset,
    findings: RestoreCheckFinding[],
  ): Promise<RestoreCheckPackage> {
    const empty: RestoreCheckPackage = {
      readable: false,
      fileCount: null,
      originalCount: null,
      verifiedFileCount: 0,
    };
    if (!asset.localReference) {
      return empty;
    }
    const manifestPath = nodePath.join(asset.localReference, 'manifest.json');
    if (!existsSync(manifestPath)) {
      findings.push({
        code: restoreCheckFindingCodeValues.PACKAGE_UNREADABLE,
        message: LOCAL_BACKUP_FAILURE_REASON.PACKAGE_MANIFEST_MISSING,
      });
      return empty;
    }

    let manifest;
    try {
      manifest = parseBackupManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch {
      findings.push({
        code: restoreCheckFindingCodeValues.MANIFEST_INVALID,
        message: LOCAL_BACKUP_FAILURE_REASON.PACKAGE_MANIFEST_UNPARSABLE,
      });
      return empty;
    }

    let verified = 0;
    for (const file of manifest.files) {
      const absolutePath = nodePath.join(asset.localReference, file.relative_path);
      if (!existsSync(absolutePath)) {
        findings.push({
          code: restoreCheckFindingCodeValues.FILE_MISSING,
          message: LOCAL_BACKUP_FAILURE_REASON.PACKAGE_FILE_MISSING,
        });
        continue;
      }
      if (statSync(absolutePath).size !== file.byte_size) {
        findings.push({
          code: restoreCheckFindingCodeValues.FILE_CHECKSUM_MISMATCH,
          message: LOCAL_BACKUP_FAILURE_REASON.PACKAGE_FILE_SIZE_MISMATCH,
        });
        continue;
      }
      const digest = await sha256FileDigest(absolutePath);
      if (digest !== file.sha256.toLowerCase()) {
        findings.push({
          code: restoreCheckFindingCodeValues.FILE_CHECKSUM_MISMATCH,
          message: LOCAL_BACKUP_FAILURE_REASON.PACKAGE_FILE_CHECKSUM_MISMATCH,
        });
        continue;
      }
      verified += 1;
    }

    return {
      readable: true,
      fileCount: manifest.files.length,
      originalCount: manifest.originals.length,
      verifiedFileCount: verified,
    };
  }

  /** 保护副本：把当前范围快照成一份新的受保护备份；失败时如实记录发现项 */
  private async createProtection(
    input: RestorePrecheckInput,
    findings: RestoreCheckFinding[],
  ): Promise<RestoreCheckProtection> {
    try {
      const result = await input.createProtectionCopy(input.asset.organizationId);
      return { backupId: result.backupId, created: true };
    } catch (error) {
      // 原始异常（含本机绝对路径）只进服务端日志；发现项只给受控原因码
      this.logger.error(
        { backupId: input.asset.backupId, err: error },
        '恢复预检的保护副本生成失败',
      );
      findings.push({
        code: restoreCheckFindingCodeValues.PROTECTION_COPY_FAILED,
        message: LOCAL_BACKUP_FAILURE_REASON.PROTECTION_COPY_FAILED,
      });
      return { backupId: null, created: false };
    }
  }
}

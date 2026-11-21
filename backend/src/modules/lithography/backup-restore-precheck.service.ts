// src/modules/lithography/backup-restore-precheck.service.ts

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

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
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type QueryDeepPartialEntity } from 'typeorm';

import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';

/** 逐文件流式 SHA-256 核对，不整读进内存 */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

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
    await this.restoreRunRepository.insert({
      restoreId,
      backupId: input.asset.backupId,
      protectionBackupId: null,
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
        message: '本机备份包缺少清单文件，无法核对完整性',
      });
      return empty;
    }

    let manifest;
    try {
      manifest = parseBackupManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch {
      findings.push({
        code: restoreCheckFindingCodeValues.MANIFEST_INVALID,
        message: '本机备份包的清单无法解析，无法核对完整性',
      });
      return empty;
    }

    let verified = 0;
    for (const file of manifest.files) {
      const absolutePath = nodePath.join(asset.localReference, file.relative_path);
      if (!existsSync(absolutePath)) {
        findings.push({
          code: restoreCheckFindingCodeValues.FILE_MISSING,
          message: `备份包缺少文件：${file.relative_path}`,
        });
        continue;
      }
      if (statSync(absolutePath).size !== file.byte_size) {
        findings.push({
          code: restoreCheckFindingCodeValues.FILE_CHECKSUM_MISMATCH,
          message: `备份包文件大小不符：${file.relative_path}`,
        });
        continue;
      }
      const digest = await sha256File(absolutePath);
      if (digest !== file.sha256.toLowerCase()) {
        findings.push({
          code: restoreCheckFindingCodeValues.FILE_CHECKSUM_MISMATCH,
          message: `备份包文件校验值不符：${file.relative_path}`,
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
      findings.push({
        code: restoreCheckFindingCodeValues.PROTECTION_COPY_FAILED,
        message: error instanceof Error ? error.message : '保护副本生成失败',
      });
      return { backupId: null, created: false };
    }
  }
}

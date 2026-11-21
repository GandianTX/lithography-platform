// src/modules/lithography/queries/local-backup-asset.query.service.ts

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { In, Repository } from 'typeorm';

import { parseBackupManifest } from '@core/local-runtime/policy/protected-backup.policy';

import { BackupAssetEntity } from '../entities/backup-asset.entity';
import { LocalBackupRunEntity } from '../entities/local-backup-run.entity';
import { LocalCompanySettingEntity } from '../entities/local-company-setting.entity';
import {
  LocalBackupCloudStatus,
  LocalBackupLocalStatus,
  LocalBackupRecordDetailSnapshot,
  LocalBackupRecordSnapshot,
  LocalBackupRunStatus,
  LocalBackupSettingSnapshot,
  LocalBackupTriggerType,
} from '../local-runtime.types';
import type {
  LocalRuntimeListPage,
  LocalRuntimeListPagination,
} from './local-runtime.query.service';

/** 需求固定口径：约 72 小时计划周期、约 30 天保留窗口（只读展示，不写库） */
export const BACKUP_PLAN_INTERVAL_HOURS = 72;
export const BACKUP_RETENTION_DAYS = 30;

/**
 * 备份资产只读查询服务（任务 09 S3）。
 *
 * - 列表按创建时间倒序分页；范围由调用方（usecase）按 Session 裁决后传入；
 * - 详情在列表事实之上补清单摘要，只暴露元数据（文件数、原件数、范围快照），
 *   不返回包正文、密钥材料、原件物理路径与他人草稿；
 * - 只读：不写任何表。
 */
@Injectable()
export class LocalBackupAssetQueryService {
  constructor(
    @InjectRepository(BackupAssetEntity)
    private readonly backupAssetRepository: Repository<BackupAssetEntity>,
    @InjectRepository(LocalBackupRunEntity)
    private readonly backupRunRepository: Repository<LocalBackupRunEntity>,
    @InjectRepository(LocalCompanySettingEntity)
    private readonly settingRepository: Repository<LocalCompanySettingEntity>,
  ) {}

  /** 备份记录列表（organizationId 为 null 表示全局范围） */
  async listRecords(
    organizationId: number | null,
    pagination: LocalRuntimeListPagination,
  ): Promise<LocalRuntimeListPage<LocalBackupRecordSnapshot>> {
    const where = organizationId === null ? {} : { organizationId };
    const [assets, total] = await Promise.all([
      this.backupAssetRepository.find({
        where,
        order: { createdAt: 'DESC', backupId: 'DESC' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
      pagination.withTotal
        ? this.backupAssetRepository.count({ where })
        : Promise.resolve(undefined),
    ]);

    const runs = await this.loadRuns(assets);
    return {
      items: assets.map((asset) => toRecordSnapshot(asset, runs.get(asset.runId) ?? null)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
    };
  }

  /** 备份记录详情（含清单摘要）；不存在或超出范围时返回 null */
  async readRecordDetail(
    backupId: string,
    organizationId: number | null,
  ): Promise<LocalBackupRecordDetailSnapshot | null> {
    const asset = await this.backupAssetRepository.findOne({ where: { backupId } });
    if (asset === null) {
      return null;
    }
    if (organizationId !== null && asset.organizationId !== organizationId) {
      // 范围外与不存在同码处理，不泄露其他公司的备份是否存在。
      return null;
    }

    const run =
      asset.runId === null
        ? null
        : await this.backupRunRepository.findOne({ where: { id: asset.runId } });
    const manifestSummary = this.readManifestSummary(asset);

    return {
      record: toRecordSnapshot(asset, run),
      schemaVersion: manifestSummary.schemaVersion,
      protectionKeyId: manifestSummary.protectionKeyId,
      fileCount: manifestSummary.fileCount,
      originalCount: manifestSummary.originalCount,
      scope: manifestSummary.scope,
      manifestReadable: manifestSummary.manifestReadable,
    };
  }

  /**
   * 读取单个备份资产的事实快照（供恢复预检等用例使用）。
   *
   * 只返回恢复预检需要的字段，不返回实体本身，避免 ORM 实体跨层扩散。
   */
  async readAssetSnapshot(backupId: string): Promise<{
    backupId: string;
    organizationId: number;
    installationId: string | null;
    localReference: string | null;
    localStatus: string;
    manifestChecksum: string | null;
  } | null> {
    const asset = await this.backupAssetRepository.findOne({ where: { backupId } });
    if (asset === null) {
      return null;
    }
    return {
      backupId: asset.backupId,
      organizationId: asset.organizationId,
      installationId: asset.installationId,
      localReference: asset.localReference,
      localStatus: asset.localStatus,
      manifestChecksum: asset.manifestChecksum,
    };
  }

  /** 自动备份设置（每个有权公司一行；organizationId 为 null 表示全局范围） */
  async listSettings(
    installationId: string,
    organizationId: number | null,
  ): Promise<LocalBackupSettingSnapshot[]> {
    const settings = await this.settingRepository.find({
      where:
        organizationId === null
          ? { installationId, isCurrent: true }
          : { installationId, organizationId, isCurrent: true },
      order: { organizationId: 'ASC' },
    });

    const snapshots: LocalBackupSettingSnapshot[] = [];
    for (const setting of settings) {
      const latestRun = await this.backupRunRepository.findOne({
        where: { installationId, organizationId: setting.organizationId },
        order: { startedAt: 'DESC', id: 'DESC' },
      });
      const latestAsset = await this.backupAssetRepository.findOne({
        where: { organizationId: setting.organizationId },
        order: { createdAt: 'DESC', backupId: 'DESC' },
      });

      snapshots.push({
        organizationId: setting.organizationId,
        installationId: setting.installationId,
        backupEnabled: setting.backupEnabled,
        backupIntervalHours: setting.backupIntervalHours,
        nextBackupAt: setting.nextBackupAt,
        lastAutoSuccessAt: setting.lastAutoSuccessAt,
        lastAutoFailureAt: setting.lastAutoFailureAt,
        failureReason: setting.failureReason,
        autoUploadEnabled: setting.autoUploadEnabled,
        planIntervalHours: BACKUP_PLAN_INTERVAL_HOURS,
        retentionDays: BACKUP_RETENTION_DAYS,
        lastRunStatus: (latestRun?.status as LocalBackupRunStatus | undefined) ?? null,
        lastRunStartedAt: latestRun?.startedAt ?? null,
        lastRunFinishedAt: latestRun?.finishedAt ?? null,
        lastAssetCloudStatus:
          (latestAsset?.cloudStatus as LocalBackupCloudStatus | undefined) ?? null,
        lastAssetLocalStatus:
          (latestAsset?.localStatus as LocalBackupLocalStatus | undefined) ?? null,
      });
    }
    return snapshots;
  }

  private async loadRuns(assets: BackupAssetEntity[]): Promise<Map<number, LocalBackupRunEntity>> {
    const runIds = [
      ...new Set(assets.map((asset) => asset.runId).filter((id): id is number => id !== null)),
    ];
    if (runIds.length === 0) {
      return new Map();
    }
    const runs = await this.backupRunRepository.find({ where: { id: In(runIds) } });
    return new Map(runs.map((run) => [run.id, run]));
  }

  /** 清单摘要：只读元数据，不返回包正文与原件物理路径 */
  private readManifestSummary(asset: BackupAssetEntity): {
    schemaVersion: number | null;
    protectionKeyId: string | null;
    fileCount: number | null;
    originalCount: number | null;
    scope: { table: string; rowCount: number; lastUpdatedAt: string | null }[];
    manifestReadable: boolean;
  } {
    const empty = {
      schemaVersion: null,
      protectionKeyId: asset.encryptionKeyId,
      fileCount: null,
      originalCount: null,
      scope: [],
      manifestReadable: false,
    };
    if (!asset.localReference) {
      return empty;
    }
    const manifestPath = nodePath.join(asset.localReference, 'manifest.json');
    if (!existsSync(manifestPath)) {
      return empty;
    }
    try {
      const manifest = parseBackupManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      return {
        schemaVersion: manifest.schema_version,
        protectionKeyId: manifest.encryption.key_id,
        fileCount: manifest.files.length,
        originalCount: manifest.originals.length,
        scope: manifest.scope.map((entry) => ({
          table: entry.table,
          rowCount: entry.rowCount,
          lastUpdatedAt: entry.lastUpdatedAt,
        })),
        manifestReadable: true,
      };
    } catch {
      // 清单损坏时如实标记不可读，不返回半解析事实。
      return empty;
    }
  }
}

/** 资产行 → 备份记录快照 */
function toRecordSnapshot(
  asset: BackupAssetEntity,
  run: LocalBackupRunEntity | null,
): LocalBackupRecordSnapshot {
  return {
    backupId: asset.backupId,
    organizationId: asset.organizationId,
    runId: asset.runId,
    installationId: asset.installationId,
    triggerType: (run?.triggerType as LocalBackupTriggerType | undefined) ?? null,
    runStatus: (run?.status as LocalBackupRunStatus | undefined) ?? null,
    startedAt: run?.startedAt ?? asset.createdAt,
    finishedAt: run?.finishedAt ?? null,
    createdAt: asset.createdAt,
    byteSize: asset.byteSize === null ? null : Number(asset.byteSize),
    localStatus: asset.localStatus as LocalBackupLocalStatus,
    localPackageRetained: asset.localStatus !== 'CLEANED' && asset.localReference !== null,
    cloudStatus: asset.cloudStatus as LocalBackupCloudStatus,
    cloudReceiptPresent: asset.cloudReceipt !== null,
    manifestChecksum: asset.manifestChecksum,
    verifiedAt: asset.verifiedAt,
    retentionUntil: asset.retentionUntil,
    failureReason: asset.failureReason,
    localCleanupError: asset.localCleanupError,
    attemptCount: asset.attemptCount,
    lastAttemptAt: asset.lastAttemptAt,
    deletedAt: asset.deletedAt,
  };
}

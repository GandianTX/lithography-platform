// src/modules/lithography/local-backup-cleanup.service.ts

import {
  BACKUP_RETENTION_DAYS,
  decideManualCleanupTargets,
  decideRetentionCleanupTargets,
  isBackupPackagePathInside,
  isCleanupInterrupted,
  isCompleteCloudReceipt,
  type BackupCleanupCandidate,
} from '@core/local-runtime/policy/local-backup-cleanup.policy';
import {
  LOCAL_BACKUP_FAILURE_REASON,
  toLocalCleanupSkipReasonCode,
} from '@core/local-runtime/policy/local-backup-failure-reason';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { rm } from 'node:fs/promises';
import { PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import {
  LOCAL_BACKUP_STORAGE,
  type LocalBackupStorageConfig,
} from '@src/usecases/local-runtime/protected-backup.contract';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { LocalBackupRunEntity } from './entities/local-backup-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';

/** 单个备份包的清理结果 */
export type BackupCleanupItemResult = {
  backupId: string;
  /** CLEANED 已清理 / RETAINED 仍保留 */
  outcome: 'CLEANED' | 'RETAINED';
  /** 仍保留的原因（已清理时为 null） */
  reason: string | null;
};

/** 一轮清理的汇总结果 */
export type BackupCleanupResult = {
  /** 是否具备清理授权；不可用时 cleaned 必为 0（零清理） */
  available: boolean;
  /** 不可用原因（可清理时为 null） */
  reason: string | null;
  /** 固定后的清理目标数 */
  targetCount: number;
  /** 已清理数量 */
  cleaned: number;
  /** 仍保留数量 */
  retained: number;
  /** 逐项结果 */
  items: BackupCleanupItemResult[];
};

/** 单个备份包的删除结果 */
export type PackageDeletionOutcome =
  { deleted: true; reason: null } | { deleted: false; reason: string };

/**
 * 本地备份包清理执行层（任务 09 S3.3）。
 *
 * 口径（R074-01～03；验收 A09-05／A09-08）：
 * - **手动清理**：完整云回执是唯一授权来源；回执不完整即零清理（不动任何本机包、不改任何资产状态）；
 * - **固定清单**：清理前先把「本机本公司」的包清单固定下来，再逐项删除，
 *   清理过程中新产生的包不会被误删；
 * - **逐项记结果**：已清理／仍保留（附原因）逐项落库；清理失败的包保留，不误标为已清理；
 * - **中断可辨认**：删除前先落 CLEANING，进程被中断时状态可辨认（下一轮可重试）；
 * - **只删本机备份目录内的包**：路径越界一律拒绝，业务原件与外公司哨兵不受影响；
 * - **过期清理**：约 30 天保留窗口（不强制留最近一份），只清理云端副本可证的包。
 */
@Injectable()
export class LocalBackupCleanupService {
  constructor(
    @InjectRepository(BackupAssetEntity)
    private readonly backupAssetRepository: Repository<BackupAssetEntity>,
    @Inject(LOCAL_BACKUP_STORAGE)
    private readonly backupStorage: LocalBackupStorageConfig,
    private readonly logger: PinoLogger,
    @Optional()
    @InjectRepository(LocalBackupRunEntity)
    private readonly backupRunRepository?: Repository<LocalBackupRunEntity>,
    @Optional()
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository?: Repository<LocalInstallationEntity>,
  ) {}

  /**
   * 手动清理：完整云回执 → 固定清单 → 逐项删除 → 逐项记结果。
   *
   * 回执不完整时返回 available=false 且 cleaned=0：这是"入口在回执缺失时保持不可用"的落点。
   */
  async cleanupManualPackages(input: {
    organizationId: number;
    installationId: string;
    cloudReceipt: string | null;
    now?: Date;
  }): Promise<BackupCleanupResult> {
    const now = input.now ?? new Date();
    const assets = await this.listAssets(input.organizationId, input.installationId, 'ASC');
    const decision = decideManualCleanupTargets(toCandidates(assets), input.cloudReceipt);

    if (!decision.available) {
      return {
        available: false,
        reason: decision.reason,
        targetCount: 0,
        cleaned: 0,
        retained: 0,
        items: [],
      };
    }

    const result = await this.executeCleanup(decision.targets, assets, now);
    // 逐项复核后被保留的资产也要可见（"因为是唯一副本所以没删"），
    // 否则调用方只看到一个总数，无法解释"为什么没清干净"
    return this.mergeRetainedItems(result, decision.skipped);
  }

  /** 把"未进入清理清单"的逐项原因并入结果（RETAINED + 受控原因码） */
  private mergeRetainedItems(
    result: BackupCleanupResult,
    skipped: ReadonlyArray<{ backupId: string; reason: string }>,
  ): BackupCleanupResult {
    if (skipped.length === 0) {
      return result;
    }
    const items = [
      ...result.items,
      ...skipped.map((item) => ({
        backupId: item.backupId,
        outcome: 'RETAINED' as const,
        reason: toLocalCleanupSkipReasonCode(item.reason),
      })),
    ].sort((left, right) => left.backupId.localeCompare(right.backupId));
    return {
      ...result,
      items,
      retained: items.filter((item) => item.outcome === 'RETAINED').length,
    };
  }

  /**
   * 过期清理：按约 30 天保留窗口清理本机本公司的本地包。
   *
   * 云端副本不可证的包不动（本地包是唯一副本，不能删）；不强制留最近一份。
   */
  async cleanupExpiredPackages(input: {
    organizationId: number;
    installationId: string;
    now?: Date;
    retentionDays?: number;
  }): Promise<BackupCleanupResult> {
    const now = input.now ?? new Date();
    const assets = await this.listAssets(input.organizationId, input.installationId, 'ASC');
    const decision = decideRetentionCleanupTargets(
      toCandidates(assets),
      now,
      input.retentionDays ?? BACKUP_RETENTION_DAYS,
    );

    return this.executeCleanup(
      decision.targets.map((target) => target.candidate),
      assets,
      now,
    );
  }

  /**
   * 本机全公司的过期清理（后台每日检查用）。
   *
   * 安装身份缺失时返回空结果（不猜公司、不跨设备清理）。
   */
  async cleanupAllExpiredPackages(
    input: {
      now?: Date;
      retentionDays?: number;
    } = {},
  ): Promise<BackupCleanupResult> {
    const now = input.now ?? new Date();
    const installation = await this.installationRepository?.findOne({ where: { id: 1 } });
    if (!installation) {
      return {
        available: true,
        reason: null,
        targetCount: 0,
        cleaned: 0,
        retained: 0,
        items: [],
      };
    }

    const assets = await this.backupAssetRepository.find({
      where: { installationId: installation.installationId },
      order: { createdAt: 'ASC', backupId: 'ASC' },
    });
    if (assets.length === 0) {
      return {
        available: true,
        reason: null,
        targetCount: 0,
        cleaned: 0,
        retained: 0,
        items: [],
      };
    }

    const decision = decideRetentionCleanupTargets(
      toCandidates(assets),
      now,
      input.retentionDays ?? BACKUP_RETENTION_DAYS,
    );
    const result = await this.executeCleanup(
      decision.targets.map((target) => target.candidate),
      assets,
      now,
    );
    // 过期清理同理：未到期 / 云端副本不可证而保留的项也要逐项可见
    return this.mergeRetainedItems(result, decision.skipped);
  }

  /**
   * 取本机本公司最新一份完整云回执（手动清理的授权来源）。
   *
   * 回执来自服务端已落库的资产事实，不接受客户端传入。
   */
  async findLatestCompleteCloudReceipt(input: {
    organizationId: number;
    installationId: string;
  }): Promise<{ backupId: string; receipt: string } | null> {
    const assets = await this.listAssets(input.organizationId, input.installationId, 'DESC');
    for (const asset of assets) {
      const receipt = asset.cloudReceipt;
      if (receipt === null) {
        continue;
      }
      if (isCompleteCloudReceipt(receipt).complete) {
        return { backupId: asset.backupId, receipt };
      }
    }
    return null;
  }

  /** 本机本公司的资产清单（按创建时间排序） */
  private async listAssets(
    organizationId: number,
    installationId: string,
    direction: 'ASC' | 'DESC',
  ): Promise<BackupAssetEntity[]> {
    return this.backupAssetRepository.find({
      where: { organizationId, installationId },
      order: { createdAt: direction, backupId: direction },
    });
  }

  /** 固定清单后的逐项清理 */
  private async executeCleanup(
    targets: BackupCleanupCandidate[],
    assets: BackupAssetEntity[],
    now: Date,
  ): Promise<BackupCleanupResult> {
    const assetByBackupId = new Map(assets.map((asset) => [asset.backupId, asset]));

    // 清理中断可辨认：残留的 CLEANING 超时未推进先登记为中断，下一轮继续清理
    for (const target of targets) {
      if (!isCleanupInterrupted(target, now)) {
        continue;
      }
      await this.backupAssetRepository.update(
        { backupId: target.backupId },
        { localCleanupError: LOCAL_BACKUP_FAILURE_REASON.CLEANUP_INTERRUPTED },
      );
    }

    const items: BackupCleanupItemResult[] = [];
    const itemsByRunId = new Map<number, BackupCleanupItemResult[]>();

    for (const target of targets) {
      const asset = assetByBackupId.get(target.backupId);
      if (!asset) {
        continue;
      }
      const item = await this.cleanupOne(asset, now);
      items.push(item);
      const bucket = itemsByRunId.get(asset.runId);
      if (bucket) {
        bucket.push(item);
      } else {
        itemsByRunId.set(asset.runId, [item]);
      }
    }

    await this.markRunCleanupStatus(itemsByRunId);

    return {
      available: true,
      reason: null,
      targetCount: targets.length,
      cleaned: items.filter((item) => item.outcome === 'CLEANED').length,
      retained: items.filter((item) => item.outcome === 'RETAINED').length,
      items,
    };
  }

  /** 单个包的清理：路径闸门 → CLEANING（中断可辨认）→ 删除 → 落事实 */
  private async cleanupOne(asset: BackupAssetEntity, now: Date): Promise<BackupCleanupItemResult> {
    const reference = asset.localReference;
    if (reference === null) {
      return {
        backupId: asset.backupId,
        outcome: 'RETAINED',
        reason: LOCAL_BACKUP_FAILURE_REASON.PACKAGE_REFERENCE_MISSING,
      };
    }

    if (!isBackupPackagePathInside(this.backupStorage.baseDir, reference)) {
      const reason = LOCAL_BACKUP_FAILURE_REASON.PACKAGE_PATH_OUTSIDE_ROOT;
      await this.markRetained(asset, reason);
      return { backupId: asset.backupId, outcome: 'RETAINED', reason };
    }

    // 先落 CLEANING：删除过程被中断时状态可辨认（下一轮可重试，不会误标为已清理）
    await this.backupAssetRepository.update(
      { backupId: asset.backupId },
      { localStatus: 'CLEANING', localCleanupError: null },
    );

    const deletion = await this.deletePackageDirectory(reference);
    if (!deletion.deleted) {
      await this.markRetained(asset, deletion.reason);
      return { backupId: asset.backupId, outcome: 'RETAINED', reason: deletion.reason };
    }

    await this.backupAssetRepository.update(
      { backupId: asset.backupId },
      {
        localStatus: 'CLEANED',
        localReference: null,
        deletedAt: now,
        localCleanupError: null,
      },
    );
    return { backupId: asset.backupId, outcome: 'CLEANED', reason: null };
  }

  /** 删除包目录：只删本机备份目录内的该目录本身 */
  protected async deletePackageDirectory(reference: string): Promise<PackageDeletionOutcome> {
    try {
      await this.removePackageDirectory(reference);
      return { deleted: true, reason: null };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 包目录已不存在：本地包事实上已不在，清理目标成立
        return { deleted: true, reason: null };
      }
      // 原始异常（含本机绝对路径）只进服务端日志；对外只给受控原因码
      this.logger.error({ err: error }, '本地备份包删除失败');
      return {
        deleted: false,
        reason: LOCAL_BACKUP_FAILURE_REASON.PACKAGE_DELETE_FAILED,
      };
    }
  }

  /** 底层删除动作（独立成方法，便于以受控替身覆盖失败分支） */
  protected async removePackageDirectory(reference: string): Promise<void> {
    await rm(reference, { recursive: true, force: false });
  }

  /** 仍保留：落 FAILED 并记录原因（包保留，不误标为已清理） */
  private async markRetained(asset: BackupAssetEntity, reason: string): Promise<void> {
    await this.backupAssetRepository.update(
      { backupId: asset.backupId },
      { localStatus: 'FAILED', localCleanupError: reason.slice(0, 1000) },
    );
  }

  /** 手动清理阶段状态：按运行聚合（有保留项则 FAILED） */
  private async markRunCleanupStatus(
    itemsByRunId: Map<number, BackupCleanupItemResult[]>,
  ): Promise<void> {
    const repository = this.backupRunRepository;
    if (!repository) {
      return;
    }
    for (const [runId, items] of itemsByRunId) {
      const retained = items.filter((item) => item.outcome === 'RETAINED').length;
      await repository.update(
        { id: runId },
        { manualCleanupStatus: retained > 0 ? 'FAILED' : 'SUCCEEDED' },
      );
    }
  }
}

/** 资产实体 → 清理裁决所需的最小事实 */
function toCandidates(assets: BackupAssetEntity[]): BackupCleanupCandidate[] {
  return assets.map((asset) => ({
    backupId: asset.backupId,
    localStatus: asset.localStatus,
    localReference: asset.localReference,
    cloudStatus: asset.cloudStatus,
    cloudReceipt: asset.cloudReceipt,
    retentionUntil: asset.retentionUntil,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  }));
}

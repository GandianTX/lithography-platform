// src/modules/lithography/local-backup-cleanup.service.ts

import { LocalWriteHoldService } from './local-write-hold.service';
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
import * as nodePath from 'node:path';
import { InjectRepository } from '@nestjs/typeorm';
import { readdir, rm, stat } from 'node:fs/promises';
import { PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  LOCAL_BACKUP_STORAGE,
  type LocalBackupStorageConfig,
} from '@src/usecases/common/ports/protected-backup.contract';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { LocalBackupRunEntity } from './entities/local-backup-run.entity';
import { LocalCompanySettingEntity } from './entities/local-company-setting.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';

/** 孤儿包巡检的最小存活时长（毫秒）：默认 24 小时，避免与进行中的封包竞争 */
export const ORPHAN_PACKAGE_MIN_AGE_MS = 24 * 3_600_000;

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
 * 一轮清理内使用的仓储集合。
 *
 * 生产路径下两者都取自**同一个事务**的 EntityManager ⇒ 预检与删除同事务同连接；
 * 单测可由替身整体替换（不依赖真实数据库）。
 */
export type CleanupTransactionRepositories = {
  backupAssetRepository: Repository<BackupAssetEntity>;
  backupRunRepository: Repository<LocalBackupRunEntity>;
};

/**
 * 本地备份包清理执行层（任务 09 S3.3）。
 *
 * 口径（R074-01～03、R083-01；验收 A09-05／A09-08）：
 * - **手动清理**：授权来源是**本次手动备份**取得的完整云端回执；回执不完整即零清理
 *   （不动任何本机包、不改任何资产状态）；授权成立后清理本设备本公司范围内
 *   **全部**本地备份包，**不额外要求每个旧包各自有云副本**；
 * - **固定清单**：清理前先把「本机本公司」的包清单固定下来，再逐项删除，
 *   清理过程中新产生的包不会被误删；
 * - **逐项记结果**：已清理／仍保留（附原因）逐项落库；清理失败的包保留，不误标为已清理；
 * - **中断可辨认**：删除前先落 CLEANING，进程被中断时状态可辨认（下一轮可重试）；
 * - **只删本机备份目录内的包**：路径越界一律拒绝，业务原件与外公司哨兵不受影响；
 * - **过期清理**：约 30 天保留窗口（不强制留最近一份），只清过期且本地生成成功的包；
 *   云端副本不是清理门槛（云副本保留不删）。
 */
@Injectable()
export class LocalBackupCleanupService {
  constructor(
    @InjectRepository(BackupAssetEntity)
    private readonly backupAssetRepository: Repository<BackupAssetEntity>,
    @Inject(LOCAL_BACKUP_STORAGE)
    private readonly backupStorage: LocalBackupStorageConfig,
    private readonly logger: PinoLogger,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Optional()
    @InjectRepository(LocalBackupRunEntity)
    private readonly backupRunRepository?: Repository<LocalBackupRunEntity>,
    @Optional()
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository?: Repository<LocalInstallationEntity>,
    @Optional()
    @InjectRepository(LocalCompanySettingEntity)
    private readonly companySettingRepository?: Repository<LocalCompanySettingEntity>,
    @Optional()
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner?: TransactionRunner,
  ) {}

  /**
   * 事务内的仓储集合（**受保护**：单测以受控替身覆盖，避免依赖真实数据库）。
   *
   * 生产实现：两个仓储都取自**同一个事务**的 EntityManager ⇒ 预检、逐项删除与
   * 运行汇总共享同一事务与连接。
   */
  protected resolveTransactionRepositories(
    transactionContext: PersistenceTransactionContext,
  ): CleanupTransactionRepositories {
    const manager = getTypeOrmEntityManager(transactionContext);
    return {
      backupAssetRepository: manager.getRepository(BackupAssetEntity),
      backupRunRepository: manager.getRepository(LocalBackupRunEntity),
    };
  }

  /**
   * 在**单个数据库事务**内完成一轮清理的"全量预检 + 逐项删除"。
   *
   * 为什么必须同事务（计划第 09 项第 3 条）：
   * - 预检（读范围 → 裁决目标）与删除若分属两个事务，并发下目标集合可能漂移：
   *   另一轮清理刚把某包置为 CLEANED 时，本轮仍按旧快照去删同一个目录；
   * - 同事务内对目标行加**悲观写锁**，第二个执行者会等待并在拿到锁后读到最新状态
   *   （已 CLEANED 即被裁决跳过）⇒ **多实例下的重复清理自动收敛**。
   *
   * 降级口径：拿不到事务运行器时（替身装配）沿用注入的仓储执行，
   * **行为不变但不提供跨实例互斥**——此路径只在测试替身下出现，生产必有事务运行器。
   */
  private async runInCleanupTransaction<T>(
    work: (repositories: CleanupTransactionRepositories) => Promise<T>,
  ): Promise<T> {
    const runner = this.transactionRunner;
    if (runner === undefined) {
      return await work({
        backupAssetRepository: this.backupAssetRepository,
        backupRunRepository: this.backupRunRepository as Repository<LocalBackupRunEntity>,
      });
    }
    return await runner.run(
      async (transactionContext) =>
        await work(this.resolveTransactionRepositories(transactionContext)),
    );
  }

  /**
   * 孤儿包巡检（review M8 重启补偿）。
   *
   * 进程在封包中途被杀（重启）时，磁盘上会留下**没有资产行引用**的半成品包目录：
   * 资产行是在封包成功后才登记的，中途失败或被杀都留目录不留引用。
   *
   * 回收条件（全部满足才删，缺一即留）：
   * - 目录在本机备份根目录内（越界一律跳过）；
   * - 目录 mtime 早于 `now - minAgeMs`（默认 24 小时）——避免与**进行中**的封包竞争；
   * - 目录路径没有被任何 `backup_asset.local_reference` 引用；
   * - 目录路径没有被任何 `local_backup_run.manifest_path` 引用。
   *
   * 只回收目录，不改资产与运行事实：没有引用就没有事实需要改。
   */
  async sweepOrphanPackages(input: { now?: Date; minAgeMs?: number } = {}): Promise<{
    scanned: number;
    removed: number;
  }> {
    const now = input.now ?? new Date();
    const minAgeMs = input.minAgeMs ?? ORPHAN_PACKAGE_MIN_AGE_MS;
    const runRepository = this.backupRunRepository;
    if (!runRepository) {
      // 没有运行事实可比对时不动磁盘：宁留孤儿，不可误删
      return { scanned: 0, removed: 0 };
    }

    const referenced = await this.collectReferencedPackagePaths(runRepository);
    const root = nodePath.resolve(this.backupStorage.baseDir);
    let scanned = 0;
    let removed = 0;
    for (const organizationDir of await this.listPackageDirectories(root)) {
      // 恢复期冻结：该公司的包目录**不动**（保护副本与待恢复包不能被孤儿清理删掉）
      if (
        organizationDir.organizationId !== null &&
        (await this.isCompanyFrozen(organizationDir.organizationId))
      ) {
        continue;
      }
      for (const packageDir of organizationDir.packageDirs) {
        scanned += 1;
        if (await this.removeOrphanPackage(root, packageDir, referenced, now, minAgeMs)) {
          removed += 1;
        }
      }
    }
    return { scanned, removed };
  }

  /** 收集被资产或运行事实引用的包路径（绝对路径） */
  private async collectReferencedPackagePaths(
    runRepository: Repository<LocalBackupRunEntity>,
  ): Promise<Set<string>> {
    const referenced = new Set<string>();
    const assets = await this.backupAssetRepository.find({});
    for (const asset of assets) {
      if (asset.localReference !== null) {
        referenced.add(nodePath.resolve(asset.localReference));
      }
    }
    const runs = await runRepository.find({});
    for (const run of runs) {
      if (run.manifestPath !== null && run.manifestPath !== undefined) {
        referenced.add(nodePath.resolve(run.manifestPath));
      }
    }
    return referenced;
  }

  /** 回收一个孤儿包目录；返回是否已删除 */
  private async removeOrphanPackage(
    root: string,
    packageDir: string,
    referenced: Set<string>,
    now: Date,
    minAgeMs: number,
  ): Promise<boolean> {
    const absolute = nodePath.resolve(packageDir);
    if (referenced.has(absolute)) {
      return false;
    }
    if (!isBackupPackagePathInside(root, absolute)) {
      return false;
    }
    const modifiedAt = await this.readDirectoryModifiedAt(absolute);
    if (modifiedAt === null) {
      return false;
    }
    if (now.getTime() - modifiedAt.getTime() < minAgeMs) {
      // 可能仍在生成中：不碰
      return false;
    }
    try {
      await rm(absolute, { recursive: true, force: true });
      return true;
    } catch (error) {
      this.logger.error({ packageDir: absolute, err: error }, '孤儿备份包目录回收失败');
      return false;
    }
  }

  /** 列出备份根目录下各公司目录里的包目录 */
  private async listPackageDirectories(
    root: string,
  ): Promise<{ organizationId: number | null; packageDirs: string[] }[]> {
    const result: { organizationId: number | null; packageDirs: string[] }[] = [];
    let organizationDirs: string[];
    try {
      organizationDirs = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => nodePath.join(root, entry.name));
    } catch {
      return result;
    }
    for (const organizationDir of organizationDirs) {
      let packageDirs: string[];
      try {
        packageDirs = (await readdir(organizationDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => nodePath.join(organizationDir, entry.name));
      } catch {
        continue;
      }
      const organizationId = Number.parseInt(nodePath.basename(organizationDir), 10);
      result.push({
        organizationId: Number.isInteger(organizationId) ? organizationId : null,
        packageDirs,
      });
    }
    return result;
  }

  /**
   * 写入冻结闸门：该公司数据区是否处于恢复期冻结。
   *
   * 判定失败**按"冻结"处理**（保守口径）：拿不到冻结事实时不删任何包目录
   * （孤儿包宁可留着，也不可误删恢复的保护副本）。
   */
  private async isCompanyFrozen(organizationId: number): Promise<boolean> {
    try {
      await this.localWriteHoldService.assertCompanyWritable({ organizationId });
      return false;
    } catch {
      return true;
    }
  }

  /** 目录的最后修改时间；取不到时返回 null（不据此删除） */
  private async readDirectoryModifiedAt(directory: string): Promise<Date | null> {
    try {
      const stats = await stat(directory);
      return stats.mtime;
    } catch {
      return null;
    }
  }

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
    return await this.runInCleanupTransaction(async (repositories) => {
      const assets = await this.listAssets(
        repositories.backupAssetRepository,
        input.organizationId,
        input.installationId,
        'ASC',
      );
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

      const result = await this.executeCleanup(repositories, decision.targets, assets, now);
      // 逐项复核后被保留的资产也要可见（"因为是唯一副本所以没删"），
      // 否则调用方只看到一个总数，无法解释"为什么没清干净"
      return this.mergeRetainedItems(result, decision.skipped);
    });
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
   * 云副本**不作前置**（清理按"成功本地包 ＋ 期限"判断，不看云端是否可证）；
   * 不强制保留最近一份。
   */
  async cleanupExpiredPackages(input: {
    organizationId: number;
    installationId: string;
    now?: Date;
    retentionDays?: number;
  }): Promise<BackupCleanupResult> {
    const now = input.now ?? new Date();
    return await this.runInCleanupTransaction(async (repositories) => {
      const assets = await this.listAssets(
        repositories.backupAssetRepository,
        input.organizationId,
        input.installationId,
        'ASC',
      );
      const decision = decideRetentionCleanupTargets(
        toCandidates(assets),
        now,
        input.retentionDays ?? BACKUP_RETENTION_DAYS,
      );

      const result = await this.executeCleanup(
        repositories,
        decision.targets.map((target) => target.candidate),
        assets,
        now,
      );
      return this.mergeRetainedItems(result, decision.skipped);
    });
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

    // 清理范围＝**本机安装标识 × 本机正在备份的公司**。
    //
    // 此前只按 installationId 扫描 ⇒ **外公司**的备份包也会被本机的过期清理删掉
    // （实库哨兵本应拦住的口径缺口）。公司范围取"本机当前计划里启用了本地备份"的公司集合：
    // - 本机没有启用备份计划的公司 → 不清理（外公司哨兵成立）；
    // - 读不到计划行（仓储未注入）→ 失败关闭（零清理，不猜范围）。
    const scopedOrganizationIds = await this.listBackupEnabledOrganizationIds(
      installation.installationId,
    );
    // 恢复期写入冻结：处于恢复期冻结的公司，其备份包本轮不清理（保护副本与待恢复包不能被删）
    const heldOrganizationIds = new Set<number>();
    for (const organizationId of scopedOrganizationIds ?? []) {
      try {
        await this.localWriteHoldService.assertCompanyWritable({ organizationId });
      } catch {
        heldOrganizationIds.add(organizationId);
      }
    }

    // 预检（读范围 → 裁决目标）与逐项删除在**同一事务**内完成。
    return await this.runInCleanupTransaction(async (repositories) => {
      const assets = await repositories.backupAssetRepository.find({
        where: { installationId: installation.installationId },
        order: { createdAt: 'ASC', backupId: 'ASC' },
        // 悲观写锁：并发清理的执行者在此串行，拿到锁后读到最新状态再裁决
        lock: { mode: 'pessimistic_write' },
      });
      const scopedAssets =
        scopedOrganizationIds === null
          ? []
          : assets.filter(
              (asset) =>
                scopedOrganizationIds.has(asset.organizationId) &&
                !heldOrganizationIds.has(asset.organizationId),
            );
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
        toCandidates(scopedAssets),
        now,
        input.retentionDays ?? BACKUP_RETENTION_DAYS,
      );
      const result = await this.executeCleanup(
        repositories,
        decision.targets.map((target) => target.candidate),
        scopedAssets,
        now,
      );
      // 过期清理同理：未到期 / 云端副本不可证而保留的项也要逐项可见
      return this.mergeRetainedItems(result, decision.skipped);
    });
  }

  /**
   * 本机**正在备份的公司**集合（过期清理的公司范围）。
   *
   * 口径：只清理"本机当前计划里启用了本地备份"的公司；读不到计划行时返回 `null`
   * ⇒ 调用方**零清理**（失败关闭，不猜范围、不跨公司清理）。
   */
  private async listBackupEnabledOrganizationIds(
    installationId: string,
  ): Promise<Set<number> | null> {
    if (this.companySettingRepository === undefined) {
      return null;
    }
    const settings = await this.companySettingRepository.find({
      where: { installationId, isCurrent: true },
    });
    const organizationIds = new Set<number>();
    for (const setting of settings) {
      if (setting.backupEnabled === true) {
        organizationIds.add(setting.organizationId);
      }
    }
    return organizationIds;
  }

  /**
   * 取**本次手动备份**取得的完整云回执（手动清理的授权来源）。
   *
   * 口径（R074-02／R074-03）：
   * - 清理的授权来自「本次手动流程」的成功回执：断网、上传失败或回执未确认时零清理；
   * - 因此只认**最近一条手动运行**对应的那份包的回执，不用历史上任意一份完整回执授权——
   *   否则上一次成功的旧包会被当成本次授权，与「仅本次手动流程成功云回执后清理」不符；
   * - 回执只取自服务端已落库的资产事实，不接受客户端传入。
   */
  async findManualRunCloudReceipt(input: {
    organizationId: number;
    installationId: string;
  }): Promise<{ backupId: string; receipt: string } | null> {
    const repository = this.backupRunRepository;
    if (!repository) {
      return null;
    }
    const runs = await repository.find({
      where: {
        organizationId: input.organizationId,
        installationId: input.installationId,
        triggerType: 'MANUAL',
      },
      order: { id: 'DESC' },
    });
    const latestRun = runs[0];
    if (!latestRun) {
      return null;
    }
    const assets = await this.listAssets(
      this.backupAssetRepository,
      input.organizationId,
      input.installationId,
      'DESC',
    );
    const asset = assets.find((item) => item.runId === latestRun.id);
    if (!asset || asset.cloudStatus !== 'SUCCEEDED' || asset.cloudReceipt === null) {
      return null;
    }
    if (!isCompleteCloudReceipt(asset.cloudReceipt).complete) {
      return null;
    }
    return { backupId: asset.backupId, receipt: asset.cloudReceipt };
  }

  /** 本机本公司的资产清单（按创建时间排序）；读取带悲观写锁，与删除同事务 */
  private async listAssets(
    repository: Repository<BackupAssetEntity>,
    organizationId: number,
    installationId: string,
    direction: 'ASC' | 'DESC',
  ): Promise<BackupAssetEntity[]> {
    return await repository.find({
      where: { organizationId, installationId },
      order: { createdAt: direction, backupId: direction },
      // 悲观写锁：并发清理的执行者在此串行，拿到锁后读到最新状态再裁决
      lock: { mode: 'pessimistic_write' },
    });
  }

  /** 固定清单后的逐项清理 */
  private async executeCleanup(
    repositories: CleanupTransactionRepositories,
    targets: BackupCleanupCandidate[],
    assets: BackupAssetEntity[],
    now: Date,
  ): Promise<BackupCleanupResult> {
    const assetByBackupId = new Map(assets.map((asset) => [asset.backupId, asset]));
    const assetRepository = repositories.backupAssetRepository;

    // 清理中断可辨认：残留的 CLEANING 超时未推进先登记为中断，下一轮继续清理
    for (const target of targets) {
      if (!isCleanupInterrupted(target, now)) {
        continue;
      }
      await assetRepository.update(
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
      const item = await this.cleanupOne(repositories, asset, now);
      items.push(item);
      const bucket = itemsByRunId.get(asset.runId);
      if (bucket) {
        bucket.push(item);
      } else {
        itemsByRunId.set(asset.runId, [item]);
      }
    }

    await this.markRunCleanupStatus(repositories, itemsByRunId);

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
  private async cleanupOne(
    repositories: CleanupTransactionRepositories,
    asset: BackupAssetEntity,
    now: Date,
  ): Promise<BackupCleanupItemResult> {
    const assetRepository = repositories.backupAssetRepository;
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
      await this.markRetained(assetRepository, asset, reason);
      return { backupId: asset.backupId, outcome: 'RETAINED', reason };
    }

    // 先落 CLEANING：删除过程被中断时状态可辨认（下一轮可重试，不会误标为已清理）
    await assetRepository.update(
      { backupId: asset.backupId },
      { localStatus: 'CLEANING', localCleanupError: null },
    );

    const deletion = await this.deletePackageDirectory(reference);
    if (!deletion.deleted) {
      await this.markRetained(assetRepository, asset, deletion.reason);
      return { backupId: asset.backupId, outcome: 'RETAINED', reason: deletion.reason };
    }

    await assetRepository.update(
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
  private async markRetained(
    assetRepository: Repository<BackupAssetEntity>,
    asset: BackupAssetEntity,
    reason: string,
  ): Promise<void> {
    await assetRepository.update(
      { backupId: asset.backupId },
      { localStatus: 'FAILED', localCleanupError: reason.slice(0, 1000) },
    );
  }

  /** 手动清理阶段状态：按运行聚合（有保留项则 FAILED） */
  private async markRunCleanupStatus(
    repositories: CleanupTransactionRepositories,
    itemsByRunId: Map<number, BackupCleanupItemResult[]>,
  ): Promise<void> {
    const repository = repositories.backupRunRepository;
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
    retentionUntil: asset.retentionUntil,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  }));
}

// src/modules/lithography/record-package-import.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  assertManifestSnapshotHasNoSecretMaterial,
  assertPackageCompanyAllowed,
  parseRecordPackageManifest,
  recordPackageManifestChecksum,
  resolvePackageFilePath,
  type RecordPackageItemRejection,
  type RecordPackageManifest,
} from '@core/local-runtime/policy/record-package-manifest.policy';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as nodePath from 'node:path';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { RecordPackageImportEntity } from './entities/record-package-import.entity';
import { RecordPackageItemEntity } from './entities/record-package-item.entity';
import { SyncReceiptEntity } from './entities/sync-receipt.entity';
import {
  type RecordPackageCheckCommand,
  type RecordPackageCheckResult,
  type RecordPackageImportSnapshot,
  type RecordPackageItemCheckOutcome,
  type RecordPackageItemSnapshot,
} from './record-package-import.types';
import {
  toRecordPackageImportSnapshot,
  toRecordPackageItemSnapshot,
} from './queries/record-package-import.query.service';
import { sha256FileDigest } from '@core/common/digest/file-digest';

export type RecordPackageEvaluation = {
  manifest: RecordPackageManifest;
  manifestRaw: string;
  manifestChecksum: string;
  outcomes: RecordPackageItemCheckOutcome[];
};

/**
 * 记录包检查执行层（任务 09 R071，S2.3）。
 *
 * 分两段以缩短事务：
 * 1) `evaluatePackage`：读包目录、结构校验、逐文件流式 SHA-256、重复判定——
 *    无 DB 写入，放在事务外，避免长事务持锁；
 * 2) `persistCheckOutcome`：事务内复查既有批次 → 插入 import＋item 检查事实。
 *
 * 检查**不写正式业务**：status 保持 PENDING，item.result 保持 NULL。
 * 拒绝路径：清单非法、路径逃逸、缺文件、字节/SHA-256 不符、错公司、
 * 包内重复、与 sync_receipt 已有同版本记录重复。
 * 同包重复检查返回既有批次（主键即 package_id，天然一个事实）。
 * 换包（同一 package_id 下清单校验值变化）时旧预检失效：按新内容重新落检查事实，
 * 不保留旧逐条结论，避免"旧预检结论被套用到新包内容上"。
 */
@Injectable()
export class RecordPackageImportService {
  constructor(
    @InjectRepository(RecordPackageImportEntity)
    private readonly importRepository: Repository<RecordPackageImportEntity>,
    @InjectRepository(RecordPackageItemEntity)
    private readonly itemRepository: Repository<RecordPackageItemEntity>,
    @InjectRepository(SyncReceiptEntity)
    private readonly receiptRepository: Repository<SyncReceiptEntity>,
  ) {}

  private pickImportRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RecordPackageImportEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(RecordPackageImportEntity)
      : this.importRepository;
  }

  private pickItemRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RecordPackageItemEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(RecordPackageItemEntity)
      : this.itemRepository;
  }

  private pickReceiptRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<SyncReceiptEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(SyncReceiptEntity)
      : this.receiptRepository;
  }

  private readManifestRaw(packagePath: string): { manifestPath: string; raw: string } {
    if (packagePath === '' || !nodePath.isAbsolute(packagePath) || !existsSync(packagePath)) {
      throw new DomainError(RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND, '记录包目录不存在');
    }
    const manifestPath = nodePath.join(packagePath, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new DomainError(RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND, '记录包缺少 manifest.json');
    }
    return { manifestPath, raw: readFileSync(manifestPath, 'utf8') };
  }

  private async hasDuplicateReceipt(
    organizationId: number,
    resourceType: string,
    recordUuid: string,
    versionNo: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<boolean> {
    const found = await this.pickReceiptRepository(transactionContext).findOne({
      where: { organizationId, resourceType, recordUuid, versionNo },
      select: { receiptId: true },
    });
    return found !== null;
  }

  private async checkItemFiles(
    packagePath: string,
    files: { relative_path: string; sha256: string; byte_size: number }[],
  ): Promise<{ rejection: RecordPackageItemRejection | null; message: string | null }> {
    for (const file of files) {
      let absolutePath: string;
      try {
        absolutePath = resolvePackageFilePath(packagePath, file.relative_path);
      } catch {
        return { rejection: 'PATH_ESCAPED', message: `文件路径逃逸：${file.relative_path}` };
      }
      if (!existsSync(absolutePath)) {
        return { rejection: 'FILE_MISSING', message: `缺少原件文件：${file.relative_path}` };
      }
      const size = statSync(absolutePath).size;
      if (size !== file.byte_size) {
        return {
          rejection: 'FILE_CHECKSUM_MISMATCH',
          message: `字节数不符：${file.relative_path}（清单 ${file.byte_size}，实际 ${size}）`,
        };
      }
      const digest = await sha256FileDigest(absolutePath);
      if (digest !== file.sha256.toLowerCase()) {
        return {
          rejection: 'FILE_CHECKSUM_MISMATCH',
          message: `SHA-256 不符：${file.relative_path}`,
        };
      }
    }
    return { rejection: null, message: null };
  }

  /** 第一段：包目录评估（无 DB 写入）。清单级问题直接抛错，条目级问题逐条记录。 */
  async evaluatePackage(command: RecordPackageCheckCommand): Promise<RecordPackageEvaluation> {
    const { raw } = this.readManifestRaw(command.packagePath);
    const manifest = parseRecordPackageManifest(raw);

    // 错公司先拒绝：不进入数据库，也不给其他公司包留任何处理事实
    assertPackageCompanyAllowed(command.organizationId, manifest.organization_id);

    const manifestChecksum = recordPackageManifestChecksum(raw);
    const seenKeys = new Set<string>();
    const outcomes: RecordPackageItemCheckOutcome[] = [];

    for (const item of manifest.items) {
      const key = `${item.resource_type}:${item.record_uuid}:${item.version_no}`;
      if (seenKeys.has(key)) {
        outcomes.push({
          recordUuid: item.record_uuid,
          resourceType: item.resource_type,
          versionNo: item.version_no,
          passed: false,
          rejection: 'DUPLICATE_RECORD',
          message: '包内存在同资源同版本重复条目',
        });
        continue;
      }
      seenKeys.add(key);

      try {
        assertManifestSnapshotHasNoSecretMaterial(item.content_snapshot);
      } catch (error) {
        outcomes.push({
          recordUuid: item.record_uuid,
          resourceType: item.resource_type,
          versionNo: item.version_no,
          passed: false,
          rejection: 'STRUCTURE_INVALID',
          message: error instanceof DomainError ? error.message : '条目结构非法',
        });
        continue;
      }

      const fileResult = await this.checkItemFiles(command.packagePath, item.files);
      if (fileResult.rejection !== null) {
        outcomes.push({
          recordUuid: item.record_uuid,
          resourceType: item.resource_type,
          versionNo: item.version_no,
          passed: false,
          rejection: fileResult.rejection,
          message: fileResult.message,
        });
        continue;
      }

      const duplicated = await this.hasDuplicateReceipt(
        manifest.organization_id,
        item.resource_type,
        item.record_uuid,
        item.version_no,
      );
      outcomes.push(
        duplicated
          ? {
              recordUuid: item.record_uuid,
              resourceType: item.resource_type,
              versionNo: item.version_no,
              passed: false,
              rejection: 'DUPLICATE_RECORD',
              message: '已存在同资源同版本的同步回执，导入将造成重复',
            }
          : {
              recordUuid: item.record_uuid,
              resourceType: item.resource_type,
              versionNo: item.version_no,
              passed: true,
              rejection: null,
              message: null,
            },
      );
    }

    return { manifest, manifestRaw: raw, manifestChecksum, outcomes };
  }

  /** 第二段：事务内落检查事实。并发同包检查 → 主键冲突后回读既有批次。 */
  /**
   * 读取导入批次事实（确认与执行共用）。
   *
   * 返回 null 表示该 package_id 没有本机的检查事实（未检查过或不是本机包的批次）。
   */
  async readImportFacts(
    packageId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{
    import: RecordPackageImportSnapshot;
    items: RecordPackageItemSnapshot[];
  } | null> {
    const importRepository = this.pickImportRepository(transactionContext);
    const itemRepository = this.pickItemRepository(transactionContext);
    const batch = await importRepository.findOne({ where: { packageId } });
    if (batch === null) {
      return null;
    }
    const items = await itemRepository.find({ where: { packageId } });
    return {
      import: toRecordPackageImportSnapshot(batch),
      items: items.map((item) => toRecordPackageItemSnapshot(item)),
    };
  }

  /**
   * 查找同键回执（导入登记与云端回执共用同一张表、同一把键）。
   *
   * 用于导入前的去重复核：同键已存在（云端回执或先前的导入登记）即跳过，
   * 不重复导入，也不与同步链路各算各的。
   */
  async findReceipt(key: {
    organizationId: number;
    resourceType: string;
    recordUuid: string;
    versionNo: number;
  }): Promise<{ receiptId: string } | null> {
    const repository = this.pickReceiptRepository();
    const receipt = await repository.findOne({
      where: {
        organizationId: key.organizationId,
        resourceType: key.resourceType,
        recordUuid: key.recordUuid,
        versionNo: key.versionNo,
      },
    });
    return receipt === null ? null : { receiptId: receipt.receiptId };
  }

  /** 标记批次进入执行中（幂等：已是 RUNNING 不重复推进） */
  async markImportRunning(
    packageId: string,
    importedByAccountId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.pickImportRepository(transactionContext);
    await repository.update(
      { packageId },
      { status: 'RUNNING', importedByAccountId, completedAt: null },
    );
  }

  /** 写单条导入结果 */
  async writeItemResult(
    itemId: string,
    result: {
      result: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CONFLICT';
      errorMessage: string | null;
      receiptId: string | null;
    },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.pickItemRepository(transactionContext);
    await repository.update(
      { id: itemId },
      {
        result: result.result,
        errorMessage: result.errorMessage,
        receiptId: result.receiptId,
      },
    );
  }

  /** 收敛批次终态并写成功／失败计数 */
  async finalizeImport(
    packageId: string,
    summary: { status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'; succeeded: number; failed: number },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.pickImportRepository(transactionContext);
    await repository.update(
      { packageId },
      {
        status: summary.status,
        itemSucceeded: summary.succeeded,
        itemFailed: summary.failed,
        completedAt: new Date(),
      },
    );
  }

  async persistCheckOutcome(
    evaluation: RecordPackageEvaluation,
    importedByAccountId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RecordPackageCheckResult> {
    const { manifest, manifestRaw, manifestChecksum, outcomes } = evaluation;
    const repository = this.pickImportRepository(transactionContext);

    const existing = await repository.findOne({ where: { packageId: manifest.package_id } });
    if (existing && existing.manifestChecksum === manifestChecksum) {
      return {
        outcome: 'existing',
        import: toRecordPackageImportSnapshot(existing),
        items: await this.listItems(manifest.package_id, transactionContext),
      };
    }

    const rejectedCount = outcomes.filter((outcome) => !outcome.passed).length;
    const checkStatus = rejectedCount === 0 ? 'PASSED' : 'REJECTED';

    // 换包：同一 package_id 下清单校验值变化，说明包内容已被替换。
    // 旧预检结论随之失效，必须按新内容重新落检查事实（不保留旧逐条结论）。
    if (existing) {
      const refreshed = repository.create({
        ...existing,
        organizationId: manifest.organization_id,
        importedByAccountId,
        manifestJson: manifestRaw,
        manifestChecksum,
        status: 'PENDING',
        checkStatus,
        itemTotal: outcomes.length,
        itemSucceeded: 0,
        itemFailed: rejectedCount,
        completedAt: null,
      });
      await repository.update({ packageId: manifest.package_id }, refreshed);
      await this.pickItemRepository(transactionContext).delete({ packageId: manifest.package_id });

      const refreshedItems = outcomes.map((outcome) =>
        this.pickItemRepository(transactionContext).create({
          packageId: manifest.package_id,
          recordUuid: outcome.recordUuid,
          resourceType: outcome.resourceType,
          versionNo: outcome.versionNo,
          checkResult: outcome.passed ? 'PASSED' : 'REJECTED',
          result: null,
          receiptId: null,
          errorMessage: outcome.message,
        }),
      );
      if (refreshedItems.length > 0) {
        await this.pickItemRepository(transactionContext).insert(refreshedItems);
      }

      const reloaded = await repository.findOne({ where: { packageId: manifest.package_id } });
      return {
        outcome: 'checked',
        import: toRecordPackageImportSnapshot(reloaded ?? refreshed),
        items: refreshedItems.map(toRecordPackageItemSnapshot),
      };
    }

    // 与 DB CHECK 对齐：REJECTED ⇒ status 必须保持 PENDING；检查阶段 result 一律 NULL
    const importRow = repository.create({
      packageId: manifest.package_id,
      organizationId: manifest.organization_id,
      importedByAccountId,
      manifestJson: manifestRaw,
      manifestChecksum,
      status: 'PENDING',
      checkStatus,
      itemTotal: outcomes.length,
      itemSucceeded: 0,
      itemFailed: rejectedCount,
    });

    try {
      await repository.insert(importRow);
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        const raced = await repository.findOne({ where: { packageId: manifest.package_id } });
        if (raced) {
          return {
            outcome: 'existing',
            import: toRecordPackageImportSnapshot(raced),
            items: await this.listItems(manifest.package_id, transactionContext),
          };
        }
      }
      throw error;
    }

    const itemRows = outcomes.map((outcome) =>
      this.pickItemRepository(transactionContext).create({
        packageId: manifest.package_id,
        recordUuid: outcome.recordUuid,
        resourceType: outcome.resourceType,
        versionNo: outcome.versionNo,
        checkResult: outcome.passed ? 'PASSED' : 'REJECTED',
        result: null,
        receiptId: null,
        errorMessage: outcome.message,
      }),
    );
    if (itemRows.length > 0) {
      await this.pickItemRepository(transactionContext).insert(itemRows);
    }

    return {
      outcome: 'checked',
      import: toRecordPackageImportSnapshot(importRow),
      items: itemRows.map(toRecordPackageItemSnapshot),
    };
  }

  private async listItems(
    packageId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RecordPackageItemSnapshot[]> {
    const rows = await this.pickItemRepository(transactionContext).find({
      where: { packageId },
      order: { id: 'ASC' },
    });
    return rows.map(toRecordPackageItemSnapshot);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ER_DUP_ENTRY'
    );
  }
}

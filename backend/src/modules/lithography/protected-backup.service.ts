// src/modules/lithography/protected-backup.service.ts

import {
  BACKUP_PAYLOAD_PATH,
  BACKUP_SCOPE_TABLES,
  buildProtectedBackupManifest,
  encryptBackupPayload,
  parseProtectionKey,
  type BackupManifestOriginal,
  type BackupScopeEntry,
} from '@core/local-runtime/policy/protected-backup.policy';
import { BACKUP_RETENTION_DAYS } from '@core/local-runtime/policy/local-backup-cleanup.policy';
import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { type ObjectLiteral, Repository } from 'typeorm';

import {
  REFERENCE_DOCUMENT_STORAGE,
  type ReferenceDocumentStorage,
} from '@src/usecases/reference-document/reference-document-storage.contract';
import {
  LOCAL_BACKUP_PROTECTION,
  LOCAL_BACKUP_STORAGE,
  type LocalBackupStorageConfig,
  type ProtectedBackupMaterial,
} from '@src/usecases/local-runtime/protected-backup.contract';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalUploadTaskEntity } from './entities/local-upload-task.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { StoredFileEntity } from './entities/stored-file.entity';

type PackageFileFact = { relative_path: string; sha256: string; byte_size: number };

/**
 * 受保护备份包执行层（任务 09 S3.1）。
 *
 * 按设备公司圈定一致数据范围（逐表计数＋最新更新时间）：
 * - 数据载荷（各表公司行 JSON）整体 AES-256-GCM 加密写 payload.enc；保护密钥只经配置注入，
 *   不落包、不进日志、不经 API 返回（D-7）；
 * - 公司业务原件经存储契约只读流复制进包 files/，复制时实测 SHA-256；
 * - manifest 明文记录范围快照、加密元数据（key_id/iv/auth_tag）与文件清单，
 *   落盘前经恢复预检同一结构契约自校验（与 S4 共用 D-28）；
 * - 生成成功后登记 backup_asset（cloud_status=PENDING、local_status=PENDING、verified_at）。
 */
@Injectable()
export class ProtectedBackupService {
  constructor(
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(MaintenanceReportEntity)
    private readonly maintenanceReportRepository: Repository<MaintenanceReportEntity>,
    @InjectRepository(ReferenceDocumentEntity)
    private readonly referenceDocumentRepository: Repository<ReferenceDocumentEntity>,
    @InjectRepository(StoredFileEntity)
    private readonly storedFileRepository: Repository<StoredFileEntity>,
    @InjectRepository(LocalUploadTaskEntity)
    private readonly uploadTaskRepository: Repository<LocalUploadTaskEntity>,
    @Inject(REFERENCE_DOCUMENT_STORAGE)
    private readonly fileStorage: ReferenceDocumentStorage,
    @Inject(LOCAL_BACKUP_PROTECTION)
    private readonly backupProtection: ProtectedBackupMaterial | null,
    @Inject(LOCAL_BACKUP_STORAGE)
    private readonly backupStorage: LocalBackupStorageConfig,
    @Optional()
    @InjectRepository(BackupAssetEntity)
    private readonly backupAssetRepository?: Repository<BackupAssetEntity>,
  ) {}

  /**
   * 备份包落点：`<备份目录>/<公司ID>/<触发方式>-<ISO时间戳>`。
   *
   * 与业务原件目录物理分离（D-7）；每次调用产生独立目录，避免互相覆盖。
   */
  resolvePackageTargetPath(
    organizationId: number,
    trigger: 'MANUAL' | 'SCHEDULED',
    now: Date,
  ): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    return nodePath.join(
      this.backupStorage.baseDir,
      String(organizationId),
      `${trigger.toLowerCase()}-${stamp}`,
    );
  }

  /** 执行一次公司备份：组包→自校验→登记 backup_asset */
  async generateProtectedBackup(input: {
    organizationId: number;
    runId: number | null;
    targetPath: string;
    /**
     * 本次封包时刻（可选）：保留窗口以此为锚点计算。
     * 显式传入才能让"约 30 天保留窗口"的边界在可控时钟下可核对。
     */
    now?: Date;
  }): Promise<{
    backupId: string;
    packagePath: string;
    manifestChecksum: string;
    byteSize: number;
  }> {
    // 密钥材料来自 infrastructure wiring（D-7）：未配置即失败关闭，不产出可用包
    const key = parseProtectionKey(this.backupProtection?.keyHex ?? null);
    const protectionKeyId = this.backupProtection?.keyId ?? 'unconfigured';

    const installation = await this.installationRepository.findOne({ where: { id: 1 } });
    if (!installation) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '本地安装身份未初始化');
    }

    await this.assertTargetWritable(input.targetPath);

    const scope = await this.collectScope(input.organizationId);
    const originals = await this.collectOriginals(input.organizationId);

    const payloadRows = await this.collectCompanyRows(input.organizationId);
    const payloadJson = Buffer.from(JSON.stringify(payloadRows), 'utf8');
    const encrypted = encryptBackupPayload(key, payloadJson);

    await mkdir(input.targetPath, { recursive: true });
    await writeFile(nodePath.join(input.targetPath, BACKUP_PAYLOAD_PATH), encrypted.data);

    const files: PackageFileFact[] = [
      {
        relative_path: BACKUP_PAYLOAD_PATH,
        sha256: createHash('sha256').update(encrypted.data).digest('hex'),
        byte_size: encrypted.data.byteLength,
      },
    ];
    await this.copyOriginals(input.targetPath, originals, files);

    const manifest = buildProtectedBackupManifest({
      organizationId: input.organizationId,
      installationId: installation.installationId,
      runId: input.runId,
      generatedAt: new Date(),
      encryption: { keyId: protectionKeyId, iv: encrypted.iv, authTag: encrypted.authTag },
      scope,
      files,
      originals,
    });

    // 清单最后写入：此前任何失败都只留数据残留，不存在"半个包"
    const manifestRaw = JSON.stringify(manifest, null, 2);
    await writeFile(nodePath.join(input.targetPath, 'manifest.json'), manifestRaw, 'utf8');

    const manifestChecksum = createHash('sha256').update(manifestRaw, 'utf8').digest('hex');
    const byteSize = files.reduce((sum, file) => sum + file.byte_size, 0);

    await this.recordBackupAsset({
      backupId: manifest.backup_id,
      organizationId: input.organizationId,
      runId: input.runId,
      storageReference: input.targetPath,
      manifestChecksum,
      byteSize,
      protectionKeyId,
      now: input.now ?? new Date(),
    });

    return {
      backupId: manifest.backup_id,
      packagePath: input.targetPath,
      manifestChecksum,
      byteSize,
    };
  }

  private async recordBackupAsset(input: {
    backupId: string;
    organizationId: number;
    runId: number | null;
    storageReference: string;
    manifestChecksum: string;
    byteSize: number;
    protectionKeyId: string;
    /** 封包时刻：保留窗口的锚点 */
    now: Date;
  }): Promise<void> {
    const repository = this.backupAssetRepository;
    if (!repository) {
      // 最小离线装配（单测）允许无 asset 仓储：只验证组包本身
      return;
    }
    await repository.save(
      repository.create({
        backupId: input.backupId,
        runId: input.runId ?? 0,
        organizationId: input.organizationId,
        storageReference: input.storageReference,
        fileSha256: input.manifestChecksum,
        byteSize: String(input.byteSize),
        cloudStatus: 'PENDING',
        localStatus: 'PENDING',
        manifestChecksum: input.manifestChecksum,
        localReference: input.storageReference,
        encryptionKeyId: input.protectionKeyId,
        verifiedAt: new Date(),
        // 保留窗口（需求固定口径约 30 天）：到期后由过期清理按包逐项处理。
        // 锚点是**封包时刻**（不是随后的墙上时钟），边界才可核对。
        retentionUntil: new Date(input.now.getTime() + BACKUP_RETENTION_DAYS * 86_400_000),
      }),
    );
  }

  private async assertTargetWritable(targetPath: string): Promise<void> {
    let existing: string[];
    try {
      existing = await readdir(targetPath);
    } catch {
      return; // 不存在 → 允许（组包阶段创建）
    }
    if (existing.length > 0) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.INVALID_PARAMS,
        '备份目标目录已存在且非空，拒绝覆盖',
      );
    }
  }

  /** 一致性范围快照：逐表公司行数＋最新更新时间 */
  private async collectScope(organizationId: number): Promise<BackupScopeEntry[]> {
    const scope: BackupScopeEntry[] = [];
    for (const table of BACKUP_SCOPE_TABLES) {
      if (table === 'local_backup_run') {
        // 运行事实由本表行本身体现，不进数据载荷
        scope.push({ table, rowCount: 0, lastUpdatedAt: null });
        continue;
      }
      const repository = this.repositoryForTable(table) as Repository<ObjectLiteral>;
      const where = this.scopeWhere(table, organizationId);
      // 时间列各表不同：报修与存储文件只登记 created_at，其余表为 updated_at
      const timeColumn =
        table === 'repair_request' || table === 'stored_file' ? 'createdAt' : 'updatedAt';
      const [rowCount, lastRow] = await Promise.all([
        repository.count(where as never),
        repository.findOne({
          where: where,
          order: { [timeColumn]: 'DESC' },
        }),
      ]);
      const updatedAt = lastRow?.[timeColumn] as Date | undefined;
      scope.push({ table, rowCount, lastUpdatedAt: updatedAt?.toISOString() ?? null });
    }
    return scope;
  }

  /** 各表归属列不同：任务/运行表按 organization_id，业务表按 owner_organization_id */
  /**
   * 各表归属过滤：业务表按 owner_organization_id；
   * 任务/运行事实表无公司列（S0 结构事实 G-8，裁定 D-10 不改结构），
   * 一库一设备前提下按设备全量纳入，归属一致性由来源业务表行保证。
   */
  private scopeWhere(table: string, organizationId: number): Record<string, unknown> {
    if (table === 'local_upload_task') {
      return {};
    }
    return { ownerOrganizationId: organizationId };
  }

  private repositoryForTable(table: string): Repository<ObjectLiteral> | null {
    switch (table) {
      case 'repair_request':
        return this.repairRequestRepository;
      case 'maintenance_report':
        return this.maintenanceReportRepository;
      case 'reference_document':
        return this.referenceDocumentRepository;
      case 'stored_file':
        return this.storedFileRepository;
      case 'local_upload_task':
        return this.uploadTaskRepository;
      default:
        return null;
    }
  }

  /** 公司数据行 JSON（核心业务表全行，作为可恢复载荷） */
  private async collectCompanyRows(organizationId: number): Promise<Record<string, unknown>> {
    const rows: Record<string, unknown> = {};
    // stored_file 主键为 fileId（char36），其余业务表主键为 id
    const tables: [string, Repository<ObjectLiteral>, Record<string, unknown>, string][] = [
      [
        'repair_request',
        this.repairRequestRepository,
        { ownerOrganizationId: organizationId },
        'id',
      ],
      [
        'maintenance_report',
        this.maintenanceReportRepository,
        { ownerOrganizationId: organizationId },
        'id',
      ],
      [
        'reference_document',
        this.referenceDocumentRepository,
        { ownerOrganizationId: organizationId },
        'id',
      ],
      ['stored_file', this.storedFileRepository, { ownerOrganizationId: organizationId }, 'fileId'],
    ];
    for (const [table, repository, where, orderKey] of tables) {
      rows[table] = await repository.find({
        where: where as never,
        order: { [orderKey]: 'ASC' },
      });
    }
    // 上传任务无公司列（G-8/D-10）：按设备全量纳入
    rows.local_upload_task = await this.uploadTaskRepository.find({
      order: { id: 'ASC' } as never,
    });
    return rows;
  }

  /** 公司业务原件引用清单（登记来源与校验值） */
  private async collectOriginals(organizationId: number): Promise<BackupManifestOriginal[]> {
    const originals: BackupManifestOriginal[] = [];
    const documents = await this.referenceDocumentRepository.find({
      where: { ownerOrganizationId: organizationId } as never,
    });
    for (const document of documents) {
      if (document.storageBackend === null || document.storageReference === null) {
        continue;
      }
      originals.push({
        source: `reference_document:${document.id}`,
        storage_reference: document.storageReference,
        sha256: null,
      });
    }
    const storedFiles = await this.storedFileRepository.find({
      where: { ownerOrganizationId: organizationId } as never,
    });
    for (const stored of storedFiles) {
      originals.push({
        source: `stored_file:${stored.fileId}`,
        storage_reference: stored.storageReference,
        sha256: stored.checksumSha256 ?? null,
      });
    }
    return originals;
  }

  /** 原件物理复制：可读取的进包并回填实测清单；读取失败保留引用，不中断生成 */
  private async copyOriginals(
    targetPath: string,
    originals: BackupManifestOriginal[],
    files: PackageFileFact[],
  ): Promise<void> {
    for (const original of originals) {
      let source;
      try {
        source = await this.fileStorage.open(original.storage_reference);
      } catch {
        continue;
      }
      const relativePath = `files/${original.storage_reference}`;
      const absolutePath = nodePath.join(targetPath, relativePath);
      await mkdir(nodePath.dirname(absolutePath), { recursive: true });
      const hash = createHash('sha256');
      let byteSize = 0;
      const output = createWriteStream(absolutePath);
      try {
        await new Promise<void>((resolve, reject) => {
          source.on('data', (chunk: Buffer) => {
            byteSize += chunk.byteLength;
            hash.update(chunk);
          });
          source.on('error', (error: Error) => reject(error));
          output.on('error', (error: Error) => reject(error));
          output.on('finish', () => resolve());
          source.pipe(output);
        });
        files.push({
          relative_path: relativePath,
          sha256: hash.digest('hex'),
          byte_size: byteSize,
        });
      } catch {
        output.destroy();
        // 复制失败保留引用清单（S3.4 中断核对口径），不阻断本次备份
        continue;
      }
    }
  }
}

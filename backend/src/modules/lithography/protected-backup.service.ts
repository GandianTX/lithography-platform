// src/modules/lithography/protected-backup.service.ts

import {
  BACKUP_PAYLOAD_PATH,
  BACKUP_RESTORE_TABLE_ORDER,
  BACKUP_SCOPE_TABLES,
  BACKUP_TABLE_DESCRIPTORS,
  backupManifestChecksum,
  buildProtectedBackupManifest,
  buildOrganizationScopePredicate,
  encryptBackupPayload,
  isSafeBackupRelativePath,
  parseProtectionKey,
  type BackupManifestOriginal,
  type BackupScopeEntry,
  type BackupScopeTable,
} from '@core/local-runtime/policy/protected-backup.policy';
import { isBackupPackagePathInside } from '@core/local-runtime/policy/local-backup-cleanup.policy';
import { BACKUP_RETENTION_DAYS } from '@core/local-runtime/policy/local-backup-plan.policy';
import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { In, type ObjectLiteral, Repository } from 'typeorm';

import {
  REFERENCE_DOCUMENT_STORAGE,
  type ReferenceDocumentStorage,
} from '@src/usecases/common/ports/reference-document-storage.contract';
import {
  LOCAL_BACKUP_PROTECTION,
  LOCAL_BACKUP_STORAGE,
  type LocalBackupStorageConfig,
  type ProtectedBackupMaterial,
} from '@src/usecases/common/ports/protected-backup.contract';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { AiConversationEntity } from './entities/ai-conversation.entity';
import { AiMessageAnalysisEntity } from './entities/ai-message-analysis.entity';
import { AiMessageEntity } from './entities/ai-message.entity';
import { AiReportEntity } from './entities/ai-report.entity';
import { EngineerResponseEntity } from './entities/engineer-response.entity';
import { IntakeAnalysisAttemptEntity } from './entities/intake-analysis-attempt.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalBackupRunEntity } from './entities/local-backup-run.entity';
import { LocalUploadTaskEntity } from './entities/local-upload-task.entity';
import { MaintenanceReportAlarmEntity } from './entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import { MaintenanceReportFaultEntity } from './entities/maintenance-report-fault.entity';
import { MaintenanceReportReviewEntity } from './entities/maintenance-report-review.entity';
import { MaintenanceReportStepEntity } from './entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from './entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { ReferenceDocumentCaseDetailEntity } from './entities/reference-document-case-detail.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { ReferenceDocumentRevisionEntity } from './entities/reference-document-revision.entity';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairRequestDiagnosticStepEntity } from './entities/repair-request-diagnostic-step.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestFaultPanelEntity } from './entities/repair-request-fault-panel.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { RepairRequestRevisionEntity } from './entities/repair-request-revision.entity';
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
    @InjectRepository(LocalBackupRunEntity)
    private readonly localBackupRunRepository: Repository<LocalBackupRunEntity>,
    @InjectRepository(RepairRequestRevisionEntity)
    private readonly repairRequestRevisionRepository: Repository<RepairRequestRevisionEntity>,
    @InjectRepository(MaintenanceReportVersionEntity)
    private readonly reportVersionRepository: Repository<MaintenanceReportVersionEntity>,
    @InjectRepository(MaintenanceReportAttachmentEntity)
    private readonly reportAttachmentRepository: Repository<MaintenanceReportAttachmentEntity>,
    @InjectRepository(MaintenanceReportVersionAttachmentEntity)
    private readonly reportVersionAttachmentRepository: Repository<MaintenanceReportVersionAttachmentEntity>,
    @InjectRepository(MaintenanceReportAlarmEntity)
    private readonly reportAlarmRepository: Repository<MaintenanceReportAlarmEntity>,
    @InjectRepository(MaintenanceReportStepEntity)
    private readonly reportStepRepository: Repository<MaintenanceReportStepEntity>,
    @InjectRepository(MaintenanceReportFaultEntity)
    private readonly reportFaultRepository: Repository<MaintenanceReportFaultEntity>,
    @InjectRepository(ReferenceDocumentRevisionEntity)
    private readonly documentRevisionRepository: Repository<ReferenceDocumentRevisionEntity>,
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly repairRequestIntakeRepository: Repository<RepairRequestIntakeEntity>,
    @InjectRepository(IntakeAnalysisAttemptEntity)
    private readonly intakeAnalysisAttemptRepository: Repository<IntakeAnalysisAttemptEntity>,
    @InjectRepository(RepairProcessEntryEntity)
    private readonly repairProcessEntryRepository: Repository<RepairProcessEntryEntity>,
    @InjectRepository(RepairRequestDiagnosticStepEntity)
    private readonly repairRequestDiagnosticStepRepository: Repository<RepairRequestDiagnosticStepEntity>,
    @InjectRepository(RepairRequestFaultPanelEntity)
    private readonly repairRequestFaultPanelRepository: Repository<RepairRequestFaultPanelEntity>,
    @InjectRepository(MaintenanceReportReviewEntity)
    private readonly maintenanceReportReviewRepository: Repository<MaintenanceReportReviewEntity>,
    @InjectRepository(ReferenceDocumentCaseDetailEntity)
    private readonly referenceDocumentCaseDetailRepository: Repository<ReferenceDocumentCaseDetailEntity>,
    @InjectRepository(AiConversationEntity)
    private readonly aiConversationRepository: Repository<AiConversationEntity>,
    @InjectRepository(AiMessageEntity)
    private readonly aiMessageRepository: Repository<AiMessageEntity>,
    @InjectRepository(AiMessageAnalysisEntity)
    private readonly aiMessageAnalysisRepository: Repository<AiMessageAnalysisEntity>,
    @InjectRepository(AiReportEntity)
    private readonly aiReportRepository: Repository<AiReportEntity>,
    @InjectRepository(EngineerResponseEntity)
    private readonly engineerResponseRepository: Repository<EngineerResponseEntity>,
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
   *
   * 一律返回**绝对路径**（review L5）：备份根目录允许配置成相对路径，但落库的包引用
   * 必须按写入时的 cwd 归一，否则后续按不同 cwd（Worker 与 API 进程、重启后的工作目录）
   * 解析相对引用会指向别的目录——清理时要么删错位置，要么因越界被拒。
   *
   * ── 落点唯一性（真实链路上暴露的缺陷修复）──
   * 时间戳只到**毫秒**：同一毫秒内"手动备份"与"恢复预检生成保护副本"会算出
   * **完全相同**的目录 ⇒ 保护副本会**覆盖待恢复包**，既毁掉恢复源，也让"按保护副本
   * 回滚"必然失败。因此：
   * - 传入 `runId` 时把运行号并入落点（每个备份运行天然唯一）；
   * - 再叠加一次落点存在性探测（已存在则追加序号）⇒ 每次调用都产生独立目录。
   */
  resolvePackageTargetPath(
    organizationId: number,
    trigger: 'MANUAL' | 'SCHEDULED',
    now: Date,
    runId: number | null = null,
  ): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const runSuffix = runId === null ? '' : `-r${runId}`;
    const base = nodePath.resolve(
      this.backupStorage.baseDir,
      String(organizationId),
      `${trigger.toLowerCase()}-${stamp}${runSuffix}`,
    );
    let candidate = base;
    let index = 2;
    while (existsSync(candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    return candidate;
  }

  /**
   * 丢弃失败生成留下的半成品（review M8 补偿）。
   *
   * 一次失败的封包会留下两样孤儿：
   * - 磁盘上的半成品包目录（可能只写了一部分文件）；
   * - 已经登记、但内容不完整的 `backup_asset` 行。
   *
   * 补偿口径：
   * - 只删**本机备份根目录内**的目标目录，路径越界一律拒绝（不动业务原件与外公司哨兵）；
   * - 目录不存在视为已清理（幂等）；
   * - 同时删除该运行登记的资产行，不留孤儿资产；
   * - 删除失败不掩盖原始异常：调用方按"补偿未完全成功"如实记录。
   */
  async discardIncompletePackage(input: {
    targetPath: string;
    runId?: number | null;
  }): Promise<{ packageRemoved: boolean; assetRemoved: boolean }> {
    const packageRemoved = await this.removePackageDirectory(input.targetPath);
    let assetRemoved = false;
    if (
      input.runId !== undefined &&
      input.runId !== null &&
      this.backupAssetRepository !== undefined
    ) {
      const result = await this.backupAssetRepository.delete({ runId: input.runId });
      assetRemoved = (result.affected ?? 0) > 0;
    }
    return { packageRemoved, assetRemoved };
  }

  /** 删除本机备份根目录内的包目录；越界拒绝、目录不存在视为已清理 */
  private async removePackageDirectory(targetPath: string): Promise<boolean> {
    if (!isBackupPackagePathInside(this.backupStorage.baseDir, targetPath)) {
      return false;
    }
    try {
      await rm(targetPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
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

    const scope = await this.collectScope(input.organizationId, installation.installationId);
    const originals = await this.collectOriginals(input.organizationId);

    const payloadRows = await this.collectCompanyRows(
      input.organizationId,
      installation.installationId,
    );
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

    // 清单摘要：走 core 的**唯一实现**（此前此处内联又写了一遍 sha256）
    const manifestChecksum = backupManifestChecksum(manifestRaw);
    const byteSize = files.reduce((sum, file) => sum + file.byte_size, 0);

    await this.recordBackupAsset({
      backupId: manifest.backup_id,
      organizationId: input.organizationId,
      // 安装标识必须登记：清理侧按 (company, installation) 找资产，
      // 漏写会让"有完整回执 ⇒ 手动清理"永远拿不到回执（本机包永不清理）。
      installationId: installation.installationId,
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
    installationId: string;
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
    // 落库的包引用一律归一为绝对路径（review L5）：相对引用会随读取时的 cwd 漂移
    const storageReference = nodePath.resolve(input.storageReference);
    await repository.save(
      repository.create({
        backupId: input.backupId,
        installationId: input.installationId,
        runId: input.runId ?? 0,
        organizationId: input.organizationId,
        storageReference,
        fileSha256: input.manifestChecksum,
        byteSize: String(input.byteSize),
        cloudStatus: 'PENDING',
        localStatus: 'PENDING',
        manifestChecksum: input.manifestChecksum,
        localReference: storageReference,
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
  private async collectScope(
    organizationId: number,
    installationId: string,
  ): Promise<BackupScopeEntry[]> {
    const scope: BackupScopeEntry[] = [];
    for (const table of BACKUP_SCOPE_TABLES) {
      const repository = this.repositoryForTable(table);
      if (repository === null) {
        // 运行事实表（本机备份运行记录）不进数据载荷，但范围快照仍按真实口径计数，
        // 不能写死 0——否则清单与库内事实不符，核验阶段会出现"预期 0 行"的假象。
        continue;
      }
      const descriptor = BACKUP_TABLE_DESCRIPTORS[table];
      const timeColumn = descriptor.timeColumn;
      const countQuery = repository.createQueryBuilder('t');
      this.applyScopeFilter(countQuery, table, organizationId, installationId);
      const rowCount = await countQuery.getCount();
      let updatedAt: Date | undefined;
      if (timeColumn !== null) {
        const latestQuery = repository.createQueryBuilder('t');
        this.applyScopeFilter(latestQuery, table, organizationId, installationId);
        const lastRow = await latestQuery
          .orderBy(`t.${timeColumn}`, 'DESC')
          .limit(1)
          .getRawOne<Record<string, Date> | null>();
        updatedAt = lastRow === null || lastRow === undefined ? undefined : lastRow[timeColumn];
      }
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
  private repositoryForTable(table: string): Repository<ObjectLiteral> | null {
    switch (table) {
      case 'repair_request':
        return this.repairRequestRepository;
      case 'repair_request_revision':
        return this.repairRequestRevisionRepository;
      case 'repair_request_intake':
        return this.repairRequestIntakeRepository;
      case 'intake_analysis_attempt':
        return this.intakeAnalysisAttemptRepository;
      case 'maintenance_report':
        return this.maintenanceReportRepository;
      case 'maintenance_report_version':
        return this.reportVersionRepository;
      case 'maintenance_report_attachment':
        return this.reportAttachmentRepository;
      case 'maintenance_report_version_attachment':
        return this.reportVersionAttachmentRepository;
      case 'maintenance_report_alarm':
        return this.reportAlarmRepository;
      case 'maintenance_report_step':
        return this.reportStepRepository;
      case 'maintenance_report_fault':
        return this.reportFaultRepository;
      case 'maintenance_report_review':
        return this.maintenanceReportReviewRepository;
      case 'reference_document':
        return this.referenceDocumentRepository;
      case 'reference_document_revision':
        return this.documentRevisionRepository;
      case 'reference_document_case_detail':
        return this.referenceDocumentCaseDetailRepository;
      case 'ai_conversation':
        return this.aiConversationRepository;
      case 'ai_message':
        return this.aiMessageRepository;
      case 'ai_message_analysis':
        return this.aiMessageAnalysisRepository;
      case 'ai_report':
        return this.aiReportRepository;
      case 'engineer_response':
        return this.engineerResponseRepository;
      case 'repair_process_entry':
        return this.repairProcessEntryRepository;
      case 'repair_request_diagnostic_step':
        return this.repairRequestDiagnosticStepRepository;
      case 'repair_request_fault_panel':
        return this.repairRequestFaultPanelRepository;
      case 'stored_file':
        return this.storedFileRepository;
      case 'local_upload_task':
        return this.uploadTaskRepository;
      case 'local_backup_run':
        return this.localBackupRunRepository;
      default:
        return null;
    }
  }

  /**
   * 按**逐表口径**圈定本公司数据区（根表按公司列，子表按父表公司归属）。
   *
   * 谓词由 core 的 `buildOrganizationScopePredicate` 统一生成（与恢复侧同源）：
   * 子表没有公司列，只能按父表 id 集合圈定——用子查询一次完成，
   * 不把全公司行拉到内存再过滤。
   */
  private applyScopeFilter(
    queryBuilder: ReturnType<Repository<ObjectLiteral>['createQueryBuilder']>,
    table: BackupScopeTable,
    organizationId: number,
    installationId: string,
  ): void {
    queryBuilder.where(buildOrganizationScopePredicate(table, 't'), {
      organizationId,
      installationId,
    });
  }

  /**
   * 公司数据行 JSON（可恢复载荷）。
   *
   * 逐表按**同一份口径**（`BACKUP_TABLE_DESCRIPTORS`）圈定：
   * 根表按 `owner_organization_id`，子表按父表公司归属，本机运行数据按安装 × 公司。
   * 顺序按 `BACKUP_RESTORE_TABLE_ORDER`（先父后子）写出，恢复侧据此写回时
   * 外键顺序天然成立。
   */
  private async collectCompanyRows(
    organizationId: number,
    installationId: string,
  ): Promise<Record<string, unknown>> {
    const rows: Record<string, unknown> = {};
    for (const table of BACKUP_RESTORE_TABLE_ORDER) {
      const repository = this.repositoryForTable(table);
      if (repository === null) {
        continue;
      }
      const queryBuilder = repository.createQueryBuilder('t');
      this.applyScopeFilter(queryBuilder, table, organizationId, installationId);
      // 排序列按**口径声明**取（`BACKUP_TABLE_DESCRIPTORS[table].orderColumns`）：
      // 备份范围里既有单列自增主键（id），也有 `stored_file.file_id`、
      // `reference_document_case_detail.document_id`、
      // `ai_message_analysis.question_uuid` 与
      // `maintenance_report_version_attachment` 的复合主键（version_id + attachment_id）
      // ——写死 `id` 会让受保护包生成在真实库上直接失败
      // （`Unknown column 't.id' in 'order clause'`）。
      const orderColumns = BACKUP_TABLE_DESCRIPTORS[table].orderColumns ?? ['id'];
      const orderMap: Record<string, 'ASC'> = {};
      for (const column of orderColumns) {
        orderMap[`t.${column}`] = 'ASC';
      }
      rows[table] = await queryBuilder.orderBy(orderMap).getMany();
    }
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
    // 报告附件**自带**存储引用（读侧按附件行的引用取字节，不经 stored_file）：
    // 必须一并进包并单独绑定，否则恢复后附件仍指向已被清理的旧引用。
    const reportIds = (
      await this.maintenanceReportRepository.find({
        where: { ownerOrganizationId: organizationId } as never,
        select: { id: true },
      })
    ).map((report) => report.id);
    if (reportIds.length > 0) {
      const attachments = await this.reportAttachmentRepository.find({
        where: { reportId: In(reportIds) } as never,
      });
      for (const attachment of attachments) {
        if (attachment.storageReference === null || attachment.storageReference === '') {
          continue;
        }
        originals.push({
          source: `maintenance_report_attachment:${attachment.id}`,
          storage_reference: attachment.storageReference,
          sha256: attachment.checksumSha256 ?? null,
        });
      }
    }
    return originals;
  }

  /** 原件物理复制：可读取的进包并回填实测清单；读取失败保留引用，不中断生成 */
  private async copyOriginals(
    targetPath: string,
    originals: BackupManifestOriginal[],
    files: PackageFileFact[],
  ): Promise<void> {
    // 同一存储引用可能被多个业务行登记（如 stored_file 与报告附件）：
    // 包内路径唯一，重复引用只复制一次（清单不出现重复相对路径）。
    const copied = new Set<string>();
    for (const original of originals) {
      const relativePath = `files/${original.storage_reference}`;
      if (copied.has(relativePath)) {
        continue;
      }
      // 双保险：写入侧的相对路径也必须安全（读取侧清单解析已有同样判定）
      // —— 否则一个异常的存储引用会把字节写到包目录之外。
      if (!isSafeBackupRelativePath(relativePath)) {
        continue;
      }
      let source;
      try {
        source = await this.fileStorage.open(original.storage_reference);
      } catch {
        continue;
      }
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
        copied.add(relativePath);
      } catch {
        output.destroy();
        // 复制失败保留引用清单（S3.4 中断核对口径），不阻断本次备份
        continue;
      }
    }
  }
}

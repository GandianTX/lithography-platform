// src/modules/lithography/record-package-export.service.ts

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  buildExportManifest,
  deriveRecordUuid,
  sanitizePackageFileName,
} from '@core/local-runtime/policy/record-package-export.policy';
import {
  assertManifestSnapshotHasNoSecretMaterial,
  type RecordPackageResourceType,
} from '@core/local-runtime/policy/record-package-manifest.policy';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { Repository } from 'typeorm';

import {
  REFERENCE_DOCUMENT_STORAGE,
  type ReferenceDocumentStorage,
} from '@src/usecases/reference-document/reference-document-storage.contract';

import { LocalRuntimeQueryService } from './queries/local-runtime.query.service';
import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { StoredFileEntity } from './entities/stored-file.entity';
import type {
  RecordPackageExportCommand,
  RecordPackageExportEntry,
  RecordPackageExportFileEntry,
  RecordPackageExportItemOutcome,
  RecordPackageExportResult,
} from './record-package-export.types';

/**
 * 记录包导出执行层（任务 09 R070，S2.3）。
 *
 * 从已授权数据组装目录形态记录包（manifest.json + 清单相对路径原件）：
 * - 条目身份（record_uuid）由 (resourceType, recordId) 确定性派生；
 * - 原件经存储契约只读流复制进包，复制时流式重算 SHA-256 写入清单，
 *   有登记校验值的来源先核对登记值，不一致视为源件损坏、条目拒绝；
 * - 逐条结果语义：单条失败不拖垮整包；全部失败则整包不产生；
 * - 清单最后写入，落盘前经导入侧同源结构自校验（导出的包必可被检查）。
 */
@Injectable()
export class RecordPackageExportService {
  constructor(
    @InjectRepository(ReferenceDocumentEntity)
    private readonly referenceDocumentRepository: Repository<ReferenceDocumentEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(MaintenanceReportEntity)
    private readonly maintenanceReportRepository: Repository<MaintenanceReportEntity>,
    @InjectRepository(MaintenanceReportVersionEntity)
    private readonly reportVersionRepository: Repository<MaintenanceReportVersionEntity>,
    @InjectRepository(MaintenanceReportAttachmentEntity)
    private readonly reportAttachmentRepository: Repository<MaintenanceReportAttachmentEntity>,
    @InjectRepository(StoredFileEntity)
    private readonly storedFileRepository: Repository<StoredFileEntity>,
    @Inject(REFERENCE_DOCUMENT_STORAGE)
    private readonly fileStorage: ReferenceDocumentStorage,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
  ) {}

  /** 导出主流程：收集条目 → 复制原件（逐条）→ 组装清单（自校验）→ 写清单 */
  async exportPackage(
    command: RecordPackageExportCommand,
    _exportedByAccountId: number,
  ): Promise<RecordPackageExportResult> {
    await this.assertTargetWritable(command.targetPath);
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '本地安装身份未初始化');
    }

    let packageStarted = false;
    try {
      packageStarted = true; // 条目收集阶段即可能创建目标目录（复制原件），此后失败需清理残留
      const outcomes = await this.collectOutcomes(command);
      const exported = outcomes.filter(
        (outcome): outcome is RecordPackageExportOutcomeOk => outcome.outcome === 'EXPORTED',
      );
      if (exported.length === 0) {
        // 整包不产生，但逐条拒绝原因随错误扩展返回，可逐条追踪
        throw new DomainError(
          RECORD_PACKAGE_ERROR.INVALID_PARAMS,
          `没有可导出的记录（全部 ${outcomes.length} 条被拒绝）`,
          { items: outcomes.map((outcome) => this.toDetail(outcome)) },
        );
      }

      const manifest = buildExportManifest({
        organizationId: command.organizationId,
        installationId: installation.installationId,
        generatedAt: new Date(),
        items: exported.map((entry) => ({
          recordUuid: entry.entry.recordUuid,
          resourceType: entry.entry.resourceType,
          versionNo: entry.entry.versionNo,
          contentSnapshot: entry.entry.contentSnapshot,
          files: entry.measuredFiles,
        })),
      });

      packageStarted = true;
      // 清单最后写入：此前任何失败都只留下原件文件残留，不存在"半个包"
      const manifestRaw = JSON.stringify(manifest, null, 2);
      await mkdir(command.targetPath, { recursive: true });
      await writeFile(nodePath.join(command.targetPath, 'manifest.json'), manifestRaw, 'utf8');

      return {
        packageId: manifest.package_id,
        packagePath: command.targetPath,
        organizationId: command.organizationId,
        resourceType: command.resourceType,
        manifestChecksum: createHash('sha256').update(manifestRaw, 'utf8').digest('hex'),
        itemTotal: outcomes.length,
        itemExported: exported.length,
        itemFailed: outcomes.length - exported.length,
        items: outcomes.map((outcome) => this.toDetail(outcome)),
      };
    } catch (error) {
      // 包未成立（无清单）时清理目标目录残留，不在 U 盘留垃圾
      if (packageStarted && !existsSync(nodePath.join(command.targetPath, 'manifest.json'))) {
        rmSync(command.targetPath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /** 统一收敛为逐条结论（EXPORTED 条目来自成功收集，REJECTED 条目来自拒绝明细） */
  private toDetail(outcome: RecordPackageExportOutcome): RecordPackageExportItemOutcome {
    if (outcome.outcome === 'EXPORTED') {
      return {
        recordId: outcome.entry.recordId,
        recordUuid: outcome.entry.recordUuid,
        resourceType: outcome.entry.resourceType,
        versionNo: outcome.entry.versionNo,
        outcome: 'EXPORTED',
        rejection: null,
        message: null,
      };
    }
    return outcome.detail;
  }

  /** 目标目录必须不存在或为空（防覆盖 U 盘既有数据） */
  private async assertTargetWritable(targetPath: string): Promise<void> {
    let existing: string[];
    try {
      existing = await readdir(targetPath);
    } catch {
      return; // 不存在 → 允许（复制阶段创建）
    }
    if (existing.length > 0) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.INVALID_PARAMS,
        '导出目标目录已存在且非空，拒绝覆盖',
      );
    }
  }

  /** 逐条收集＋复制：读取来源行、组装快照、复制原件并实测校验值 */
  private async collectOutcomes(
    command: RecordPackageExportCommand,
  ): Promise<RecordPackageExportOutcome[]> {
    const outcomes: RecordPackageExportOutcome[] = [];
    for (const recordId of command.recordIds) {
      const outcome = await this.collectOne(command, recordId);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async collectOne(
    command: RecordPackageExportCommand,
    recordId: number,
  ): Promise<RecordPackageExportOutcome> {
    try {
      const entry = await this.collectEntry(command.resourceType, recordId, command.organizationId);
      const measuredFiles = await this.copyEntryFiles(command.targetPath, entry);
      return { outcome: 'EXPORTED', entry, measuredFiles };
    } catch (error) {
      const normalized =
        error instanceof DomainError
          ? error
          : new DomainError(
              RECORD_PACKAGE_ERROR.INVALID_PARAMS,
              error instanceof Error ? error.message : '导出失败',
            );
      return {
        outcome: 'REJECTED',
        detail: {
          recordId,
          recordUuid: deriveRecordUuid(command.resourceType, recordId),
          resourceType: command.resourceType,
          versionNo: null,
          outcome: 'REJECTED',
          rejection: this.toRejection(normalized),
          message: normalized.message,
        },
      };
    }
  }

  private toRejection(error: DomainError): RecordPackageExportItemOutcome['rejection'] {
    switch (error.code) {
      case RECORD_PACKAGE_ERROR.FOREIGN_COMPANY:
        return 'FOREIGN_COMPANY';
      case RECORD_PACKAGE_ERROR.PATH_ESCAPED:
        return 'PATH_ESCAPED';
      case RECORD_PACKAGE_ERROR.FILE_MISSING:
        return 'FILE_MISSING';
      case RECORD_PACKAGE_ERROR.FILE_CHECKSUM_MISMATCH:
        return 'FILE_CHECKSUM_MISMATCH';
      default:
        return 'STRUCTURE_INVALID';
    }
  }

  private async collectEntry(
    resourceType: RecordPackageResourceType,
    recordId: number,
    organizationId: number,
  ): Promise<RecordPackageExportEntry> {
    const recordUuid = deriveRecordUuid(resourceType, recordId);
    switch (resourceType) {
      case 'REFERENCE_DOCUMENT':
        return this.collectReferenceDocument(recordId, organizationId, recordUuid);
      case 'REPAIR_REQUEST':
        return this.collectRepairRequest(recordId, organizationId, recordUuid);
      case 'MAINTENANCE_REPORT':
        return this.collectMaintenanceReport(recordId, organizationId, recordUuid);
      default:
        throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '资源类型不在允许清单内');
    }
  }

  /**
   * 归属断言：不存在、归属公司未知（历史 NULL）与范围外同码拒绝，
   * 不通过错误码差异探测其他公司数据区。
   */
  private assertRecordOrganization(
    ownerOrganizationId: number | null | undefined,
    organizationId: number,
    found: boolean,
  ): void {
    if (!found || ownerOrganizationId === null || ownerOrganizationId === undefined) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FOREIGN_COMPANY,
        '记录不存在、归属公司未知或不在授权范围内',
      );
    }
    if (ownerOrganizationId !== organizationId) {
      throw new DomainError(RECORD_PACKAGE_ERROR.FOREIGN_COMPANY, '记录属于其他公司数据区');
    }
  }

  private async collectReferenceDocument(
    recordId: number,
    organizationId: number,
    recordUuid: string,
  ): Promise<RecordPackageExportEntry> {
    const row = await this.referenceDocumentRepository.findOne({ where: { id: recordId } });
    this.assertRecordOrganization(row?.ownerOrganizationId ?? null, organizationId, row !== null);
    const entity = row as ReferenceDocumentEntity;
    if (entity.deprecated) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '记录已软删除，不能导出');
    }
    if (!Number.isInteger(entity.currentRevisionNo) || entity.currentRevisionNo < 1) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '记录尚无生效修订版本，不能导出');
    }

    const contentSnapshot = {
      schema_version: entity.schemaVersion ?? 1,
      record_id: entity.id,
      title: entity.title,
      document_type: entity.documentType,
      description: entity.description,
      content_text: entity.contentText,
      original_filename: entity.originalFilename,
      mime_type: entity.mimeType,
      extension: entity.extensionJson,
      current_revision_no: entity.currentRevisionNo,
      updated_at: entity.updatedAt?.toISOString() ?? null,
    };
    assertManifestSnapshotHasNoSecretMaterial(contentSnapshot);

    const files: RecordPackageExportFileEntry[] = [];
    if (entity.storageBackend !== null && entity.storageReference !== null) {
      // 资料行的 storage_backend 实际取值为小写 'local'；统一按大小写不敏感判定
      if (entity.storageBackend.toUpperCase() !== 'LOCAL') {
        throw new DomainError(
          RECORD_PACKAGE_ERROR.INVALID_PARAMS,
          `原件存储类型 ${entity.storageBackend} 不支持本机导出`,
        );
      }
      files.push({
        relativePath: this.packageFilePath(recordUuid, entity.originalFilename),
        storageReference: entity.storageReference,
        expectedSha256: null,
        expectedByteSize: null,
      });
    }
    return {
      recordId,
      recordUuid,
      resourceType: 'REFERENCE_DOCUMENT',
      versionNo: entity.currentRevisionNo,
      contentSnapshot,
      files,
    };
  }

  private async collectRepairRequest(
    recordId: number,
    organizationId: number,
    recordUuid: string,
  ): Promise<RecordPackageExportEntry> {
    const row = await this.repairRequestRepository.findOne({ where: { id: recordId } });
    this.assertRecordOrganization(row?.ownerOrganizationId ?? null, organizationId, row !== null);
    const entity = row as RepairRequestEntity;
    if (entity.deprecated) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '记录已撤回/作废，不能导出');
    }
    if (!Number.isInteger(entity.currentRevisionNo) || entity.currentRevisionNo < 1) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '记录尚无生效修订版本，不能导出');
    }

    const contentSnapshot = {
      schema_version: 1,
      record_id: entity.id,
      request_no: entity.requestNo,
      fault_description: entity.faultDescription,
      content_md: entity.contentMd,
      current_revision_no: entity.currentRevisionNo,
      maintenance_version_no: entity.maintenanceVersionNo,
      handling_result: entity.handlingResult,
      handling_status: entity.handlingStatus,
      created_at: entity.createdAt?.toISOString() ?? null,
    };
    assertManifestSnapshotHasNoSecretMaterial(contentSnapshot);

    const files: RecordPackageExportFileEntry[] = [];
    if (entity.maintenanceAttachmentFileId !== null) {
      const stored = await this.storedFileRepository.findOne({
        where: { fileId: entity.maintenanceAttachmentFileId },
      });
      if (stored === null) {
        throw new DomainError(RECORD_PACKAGE_ERROR.FILE_MISSING, '登记的维修附件原件不存在');
      }
      if (stored.ownerOrganizationId !== organizationId) {
        throw new DomainError(RECORD_PACKAGE_ERROR.FOREIGN_COMPANY, '附件原件属于其他公司数据区');
      }
      files.push({
        relativePath: this.packageFilePath(recordUuid, stored.originalFilename),
        storageReference: stored.storageReference,
        expectedSha256: stored.checksumSha256,
        expectedByteSize: Number(stored.byteSize),
      });
    }
    return {
      recordId,
      recordUuid,
      resourceType: 'REPAIR_REQUEST',
      versionNo: entity.currentRevisionNo,
      contentSnapshot,
      files,
    };
  }

  private async collectMaintenanceReport(
    recordId: number,
    organizationId: number,
    recordUuid: string,
  ): Promise<RecordPackageExportEntry> {
    const row = await this.maintenanceReportRepository.findOne({ where: { id: recordId } });
    this.assertRecordOrganization(row?.ownerOrganizationId ?? null, organizationId, row !== null);
    const entity = row as MaintenanceReportEntity;
    if (!Number.isInteger(entity.currentVersionNo) || entity.currentVersionNo < 1) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '报告尚无冻结版本，不能导出');
    }
    const versionRow = await this.reportVersionRepository.findOne({
      where: { reportId: recordId, versionNo: entity.currentVersionNo },
    });
    if (versionRow === null) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '报告当前版本登记缺失，不能导出');
    }

    const contentSnapshot = {
      schema_version: versionRow.schemaVersion,
      record_id: entity.id,
      report_version_no: versionRow.versionNo,
      change_kind: versionRow.changeKind,
      submitted_at: versionRow.submittedAt?.toISOString() ?? null,
      payload: versionRow.payloadSnapshot,
    };
    assertManifestSnapshotHasNoSecretMaterial(contentSnapshot);

    const attachments = await this.reportAttachmentRepository.find({
      where: { reportId: recordId, status: 'CURRENT' },
      order: { sortOrder: 'ASC' },
    });
    const files: RecordPackageExportFileEntry[] = [];
    for (const attachment of attachments) {
      if (attachment.storageBackend.toUpperCase() !== 'LOCAL') {
        throw new DomainError(
          RECORD_PACKAGE_ERROR.INVALID_PARAMS,
          `附件存储类型 ${attachment.storageBackend} 不支持本机导出`,
        );
      }
      files.push({
        relativePath: this.packageFilePath(recordUuid, attachment.originalFilename),
        storageReference: attachment.storageReference,
        expectedSha256: attachment.checksumSha256,
        expectedByteSize: attachment.byteSize,
      });
    }
    return {
      recordId,
      recordUuid,
      resourceType: 'MAINTENANCE_REPORT',
      versionNo: versionRow.versionNo,
      contentSnapshot,
      files,
    };
  }

  /** 包内相对路径：`files/<uuid前8>/<净化文件名>`，天然无穿越成分 */
  private packageFilePath(recordUuid: string, originalFilename: string | null): string {
    return `files/${recordUuid.slice(0, 8)}/${sanitizePackageFileName(originalFilename)}`;
  }

  /** 复制单条目的全部原件并回填实测校验值（任一文件失败即该条目拒绝） */
  private async copyEntryFiles(
    targetPath: string,
    entry: RecordPackageExportEntry,
  ): Promise<{ relative_path: string; sha256: string; byte_size: number }[]> {
    const files: { relative_path: string; sha256: string; byte_size: number }[] = [];
    for (const file of entry.files) {
      const measured = await this.copyOne(targetPath, file);
      files.push({
        relative_path: file.relativePath,
        sha256: measured.sha256,
        byte_size: measured.byteSize,
      });
    }
    return files;
  }

  /** 复制单个原件并核对登记校验值（流式，不整读内存） */
  private async copyOne(
    targetPath: string,
    file: RecordPackageExportFileEntry,
  ): Promise<{ sha256: string; byteSize: number }> {
    const absolutePath = nodePath.join(targetPath, file.relativePath);
    await mkdir(nodePath.dirname(absolutePath), { recursive: true });

    const source = await this.fileStorage.open(file.storageReference);
    const hash = createHash('sha256');
    let byteSize = 0;
    // 中途截断消息（data 回调内不可抛错，用标志位收敛到 catch 统一抛出）
    let truncatedMessage: string | null = null;

    const output = createWriteStream(absolutePath);
    source.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      byteSize += buffer.byteLength;
      hash.update(buffer);
      if (
        truncatedMessage === null &&
        file.expectedByteSize !== null &&
        byteSize > file.expectedByteSize
      ) {
        truncatedMessage = `原件字节数与登记不符：${file.relativePath}`;
        source.destroy();
        output.destroy();
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        source.on('error', (error) => reject(error));
        output.on('error', (error) => reject(error));
        output.on('finish', () => resolve());
        source.pipe(output);
      });
    } catch (error) {
      if (truncatedMessage !== null) {
        throw new DomainError(RECORD_PACKAGE_ERROR.FILE_CHECKSUM_MISMATCH, truncatedMessage);
      }
      const message = error instanceof Error ? error.message : '原件读取失败';
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FILE_MISSING,
        `原件读取失败：${file.relativePath}（${message}）`,
      );
    }

    if (file.expectedByteSize !== null && byteSize !== file.expectedByteSize) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FILE_CHECKSUM_MISMATCH,
        `原件字节数与登记不符：${file.relativePath}`,
      );
    }
    const digest = hash.digest('hex');
    if (file.expectedSha256 !== null && digest !== file.expectedSha256.toLowerCase()) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FILE_CHECKSUM_MISMATCH,
        `原件 SHA-256 与登记不符：${file.relativePath}`,
      );
    }
    return { sha256: digest, byteSize };
  }
}

type RecordPackageExportOutcomeOk = {
  outcome: 'EXPORTED';
  entry: RecordPackageExportEntry;
  measuredFiles: { relative_path: string; sha256: string; byte_size: number }[];
};

type RecordPackageExportOutcomeFailed = {
  outcome: 'REJECTED';
  detail: RecordPackageExportItemOutcome;
};

type RecordPackageExportOutcome = RecordPackageExportOutcomeOk | RecordPackageExportOutcomeFailed;

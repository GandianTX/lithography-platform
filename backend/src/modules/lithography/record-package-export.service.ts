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
import {
  describeRecordPackageExportDenial,
  resolveRecordPackageExportAuthorization,
} from '@core/local-runtime/policy/record-package-export-authorization.policy';
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
} from '@src/usecases/common/ports/reference-document-storage.contract';

import { EquipmentModelQueryService } from './queries/equipment-model.query.service';
import { LocalRuntimeQueryService } from './queries/local-runtime.query.service';
import { OrganizationQueryService } from './queries/organization.query.service';
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
 * - 条目身份（record_uuid）优先取源表持久化的稳定编号（跨端一致），
 *   历史行未持久化时回退到 (resourceType, recordId) 确定性派生值；
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
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
  ) {}

  /** 导出主流程：收集条目 → 复制原件（逐条）→ 组装清单（自校验）→ 写清单 */
  async exportPackage(command: RecordPackageExportCommand): Promise<RecordPackageExportResult> {
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
        organizationCode: await this.readOrganizationCode(command.organizationId),
        installationId: installation.installationId,
        generatedAt: new Date(),
        items: exported.map((entry) => ({
          recordUuid: entry.entry.recordUuid,
          resourceType: entry.entry.resourceType,
          versionNo: entry.entry.versionNo,
          contentSnapshot: entry.entry.contentSnapshot,
          files: entry.measuredFiles,
          // 来源账号与归属公司随条目入包（导入侧据此核验并保持原作者）
          sourceAccountId: entry.entry.sourceAccountId,
          sourceAccountUuid: entry.entry.sourceAccountUuid,
          sourceAccountLoginName: entry.entry.sourceAccountLoginName,
          sourceAccountName: entry.entry.sourceAccountName,
          ownerOrganizationId: entry.entry.ownerOrganizationId,
          relatedRecordUuid: entry.entry.relatedRecordUuid,
          relatedRecordType: entry.entry.relatedRecordType,
          sourceEquipmentModelCode: entry.entry.sourceEquipmentModelCode,
          sourceStatus: entry.entry.sourceStatus,
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
        // 汇总字段：**混合导出时为首个条目的资源类型**（逐条结论各自带自己的资源类型）
        resourceType: this.resolveExportEntries(command)[0]?.resourceType ?? command.resourceType,
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

  /** 来源公司的稳定业务编码（跨设备对齐公司身份；读不到即不带该字段） */
  private async readOrganizationCode(organizationId: number): Promise<string | null> {
    const identity = await this.organizationQueryService.findOrganizationIdentityById({
      organizationId,
    });
    return identity?.organizationCode ?? null;
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

  /**
   * 逐条收集＋复制：读取来源行、组装快照、复制原件并实测校验值。
   *
   * **混合导出**：`command.entries` 存在时按其逐条处理（每条自带资源类型）；
   * 否则按旧接口的"单一资源类型 ＋ 记录 id 列表"处理（旧接口保持兼容）。
   */
  private async collectOutcomes(
    command: RecordPackageExportCommand,
  ): Promise<RecordPackageExportOutcome[]> {
    const outcomes: RecordPackageExportOutcome[] = [];
    for (const entry of this.resolveExportEntries(command)) {
      const outcome = await this.collectOne(command, entry.resourceType, entry.recordId);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** 导出条目清单：新形态（混合类型）优先，否则回落到旧形态（单类型） */
  private resolveExportEntries(
    command: RecordPackageExportCommand,
  ): readonly { resourceType: RecordPackageResourceType; recordId: number }[] {
    if (command.entries !== undefined && command.entries.length > 0) {
      return command.entries.map((entry) => ({
        resourceType: entry.resourceType,
        recordId: entry.recordId,
      }));
    }
    return command.recordIds.map((recordId) => ({
      resourceType: command.resourceType,
      recordId,
    }));
  }

  private async collectOne(
    command: RecordPackageExportCommand,
    resourceType: RecordPackageResourceType,
    recordId: number,
  ): Promise<RecordPackageExportOutcome> {
    try {
      // ① 先授权、后读正文：授权判定只用**窄投影**（归属公司与关联账号），
      // 不加载正文与原件（与冲突读取侧「先查元数据授权再读正文」同一条纪律）。
      await this.assertRecordAuthorized(command, resourceType, recordId);
      // ② 授权通过后才读正文快照与原件
      const entry = await this.collectEntry(
        command,
        resourceType,
        recordId,
        command.organizationId,
      );
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
          recordUuid: await this.resolveRecordUuidSafely(
            resourceType,
            recordId,
            command.organizationId,
          ),
          resourceType,
          versionNo: null,
          outcome: 'REJECTED',
          rejection: this.toRejection(normalized),
          message: normalized.message,
        },
      };
    }
  }

  /**
   * 逐条**记录级授权**（任务 09 S1-3）。
   *
   * 口径来自来源域真实读取权限（见
   * `record-package-export-authorization.policy.ts`）。授权不通过 ⇒ 该条拒绝，
   * 不复制原件、不留痕迹。
   */
  private async assertRecordAuthorized(
    command: RecordPackageExportCommand,
    resourceType: RecordPackageResourceType,
    recordId: number,
  ): Promise<void> {
    const facts = await this.readRecordAuthorizationFacts(resourceType, recordId);
    if (facts === null) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FOREIGN_COMPANY,
        '记录不存在或归属未知，无法确认导出授权，该条未导出',
      );
    }
    const authorization = resolveRecordPackageExportAuthorization({
      sessionAccountId: command.exporterAccountId,
      scope: command.exporterScope,
      // 逐条按**该条自己的**资源类型判定（混合导出时不能沿用命令级的单一类型）
      resourceType,
      record: facts,
    });
    if (!authorization.allowed) {
      // 错公司与"无权"分开：错误码不同，页面展示口径也不同。
      const code =
        authorization.reason === 'DENIED_NOT_AUTHOR'
          ? RECORD_PACKAGE_ERROR.NOT_AUTHORIZED
          : RECORD_PACKAGE_ERROR.FOREIGN_COMPANY;
      throw new DomainError(code, describeRecordPackageExportDenial(authorization.reason));
    }
  }

  /**
   * 记录级授权所需的**窄投影**（归属公司 ＋ 关联账号）。
   *
   * 只取授权判定必需的列，不加载正文与原件；记录读不到时返回 `null`
   * （调用方按"不可核验"拒绝，不放行）。
   */
  private async readRecordAuthorizationFacts(
    resourceType: RecordPackageResourceType,
    recordId: number,
  ): Promise<{
    ownerOrganizationId: number | null;
    relatedAccountIds: number[];
  } | null> {
    if (resourceType === 'REFERENCE_DOCUMENT') {
      const row = await this.referenceDocumentRepository.findOne({
        where: { id: recordId },
        select: { ownerOrganizationId: true, createdByAccountId: true },
      });
      if (row === null) {
        return null;
      }
      return {
        ownerOrganizationId: row.ownerOrganizationId,
        relatedAccountIds: [row.createdByAccountId],
      };
    }
    if (resourceType === 'MAINTENANCE_REPORT') {
      const row = await this.maintenanceReportRepository.findOne({
        where: { id: recordId },
        select: {
          ownerOrganizationId: true,
          createdByAccountId: true,
          maintenanceEngineerAccountId: true,
        },
      });
      if (row === null) {
        return null;
      }
      return {
        ownerOrganizationId: row.ownerOrganizationId,
        relatedAccountIds: [row.createdByAccountId, row.maintenanceEngineerAccountId].filter(
          (value): value is number => typeof value === 'number',
        ),
      };
    }
    const row = await this.repairRequestRepository.findOne({
      where: { id: recordId },
      select: {
        ownerOrganizationId: true,
        customerAccountId: true,
        acceptedByEngineerAccountId: true,
      },
    });
    if (row === null) {
      return null;
    }
    return {
      ownerOrganizationId: row.ownerOrganizationId,
      relatedAccountIds: [row.customerAccountId, row.acceptedByEngineerAccountId].filter(
        (value): value is number => typeof value === 'number',
      ),
    };
  }

  /**
   * 来源账号的**跨端可移植身份**（任务 09 S1-2）。
   *
   * 源机的数字账号 id 在目标机可能指向另一个人，因此随包携带：
   * 稳定标识（`account_uuid`）、可移植账号名（`login_name`）、姓名快照。
   * 解析能力由 usecase 层按窄契约注入（账号域与业务域并列，模块间不得直接依赖）。
   */
  private async readPortableSourceIdentity(
    command: RecordPackageExportCommand,
    sourceAccountId: number | null,
  ): Promise<{
    accountUuid: string | null;
    loginName: string | null;
    name: string | null;
  }> {
    if (sourceAccountId === null) {
      return { accountUuid: null, loginName: null, name: null };
    }
    return command.resolveSourceIdentity(sourceAccountId);
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
      case RECORD_PACKAGE_ERROR.NOT_AUTHORIZED:
        return 'NOT_AUTHORIZED';
      default:
        return 'STRUCTURE_INVALID';
    }
  }

  private async collectEntry(
    command: RecordPackageExportCommand,
    resourceType: RecordPackageResourceType,
    recordId: number,
    organizationId: number,
  ): Promise<RecordPackageExportEntry> {
    const recordUuid = await this.resolveRecordUuid(resourceType, recordId, organizationId);
    switch (resourceType) {
      case 'REFERENCE_DOCUMENT':
        return this.collectReferenceDocument(command, recordId, organizationId, recordUuid);
      case 'REPAIR_REQUEST':
        return this.collectRepairRequest(command, recordId, organizationId, recordUuid);
      case 'MAINTENANCE_REPORT':
        return this.collectMaintenanceReport(command, recordId, organizationId, recordUuid);
      default:
        throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '资源类型不在允许清单内');
    }
  }

  /**
   * 解析条目的稳定身份。
   *
   * 优先取源表**持久化**的稳定编号（跨端一致，可随包搬运到其他设备）；
   * 历史行未持久化时回退到派生值（仅设备内有效，跨端不唯一），
   * 以保持既有派生 UUID 的历史事实不被改写。
   *
   * 身份解析**按公司过滤**：越权记录与归属未知记录一律回退派生值。
   * 否则拒绝明细会带出他公司记录的真实持久化身份，构成存在性泄露。
   */
  private async resolveRecordUuid(
    resourceType: RecordPackageResourceType,
    recordId: number,
    organizationId: number,
  ): Promise<string> {
    const persisted = await this.readPersistedRecordUuid(resourceType, recordId, organizationId);
    return persisted ?? deriveRecordUuid(resourceType, recordId);
  }

  /**
   * 拒绝分支的身份解析：读取失败时回退派生值。
   *
   * 拒绝分支本身已处于异常处理路径，此处不得再抛出（否则单条失败会拖垮整包）。
   */
  private async resolveRecordUuidSafely(
    resourceType: RecordPackageResourceType,
    recordId: number,
    organizationId: number,
  ): Promise<string> {
    try {
      return await this.resolveRecordUuid(resourceType, recordId, organizationId);
    } catch {
      return deriveRecordUuid(resourceType, recordId);
    }
  }

  private async readPersistedRecordUuid(
    resourceType: RecordPackageResourceType,
    recordId: number,
    organizationId: number,
  ): Promise<string | null> {
    if (resourceType === 'REFERENCE_DOCUMENT') {
      const row = await this.referenceDocumentRepository.findOne({
        where: { id: recordId, ownerOrganizationId: organizationId },
        select: { recordUuid: true },
      });
      return row?.recordUuid ?? null;
    }
    if (resourceType === 'REPAIR_REQUEST') {
      const row = await this.repairRequestRepository.findOne({
        where: { id: recordId, ownerOrganizationId: organizationId },
        select: { recordUuid: true },
      });
      return row?.recordUuid ?? null;
    }
    const row = await this.maintenanceReportRepository.findOne({
      where: { id: recordId, ownerOrganizationId: organizationId },
      select: { recordUuid: true },
    });
    return row?.recordUuid ?? null;
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
    command: RecordPackageExportCommand,
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
    const sourceAccountId = entity.createdByAccountId ?? null;
    const portable = await this.readPortableSourceIdentity(command, sourceAccountId);
    return {
      recordId,
      recordUuid,
      resourceType: 'REFERENCE_DOCUMENT',
      versionNo: entity.currentRevisionNo,
      contentSnapshot,
      files,
      sourceAccountId,
      sourceAccountUuid: portable.accountUuid,
      sourceAccountLoginName: portable.loginName,
      sourceAccountName: portable.name,
      ownerOrganizationId: organizationId,
      relatedRecordUuid: null,
      relatedRecordType: null,
      sourceEquipmentModelCode: null,
      sourceStatus: null,
    };
  }

  private async collectRepairRequest(
    command: RecordPackageExportCommand,
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
    const sourceAccountId = entity.customerAccountId ?? null;
    const portable = await this.readPortableSourceIdentity(command, sourceAccountId);
    return {
      recordId,
      recordUuid,
      resourceType: 'REPAIR_REQUEST',
      versionNo: entity.currentRevisionNo,
      contentSnapshot,
      files,
      sourceAccountId,
      sourceAccountUuid: portable.accountUuid,
      sourceAccountLoginName: portable.loginName,
      sourceAccountName: portable.name,
      ownerOrganizationId: organizationId,
      relatedRecordUuid: null,
      relatedRecordType: null,
      sourceEquipmentModelCode: null,
      sourceStatus: null,
    };
  }

  private async collectMaintenanceReport(
    command: RecordPackageExportCommand,
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
    const sourceAccountId = entity.createdByAccountId ?? null;
    const portable = await this.readPortableSourceIdentity(command, sourceAccountId);
    // 工单总结类报告必须携带**关联工单的跨端稳定编号**（任务 09 S1-4）：
    // 源机的数字外键在目标机无意义，按数字 id 猜会把报告挂到另一张工单上。
    const related = await this.readRelatedRepairRequest(entity.repairRequestId);
    const sourceEquipmentModelCode = await this.readEquipmentModelCode(entity.equipmentModelId);
    return {
      recordId,
      recordUuid,
      resourceType: 'MAINTENANCE_REPORT',
      versionNo: versionRow.versionNo,
      contentSnapshot,
      files,
      // 原作者＝报告创建人；责任工程师在冻结载荷内（maintenanceEngineerAccountId）
      sourceAccountId,
      sourceAccountUuid: portable.accountUuid,
      sourceAccountLoginName: portable.loginName,
      sourceAccountName: portable.name,
      ownerOrganizationId: organizationId,
      relatedRecordUuid: related?.recordUuid ?? null,
      relatedRecordType: related === null ? null : 'REPAIR_REQUEST',
      sourceEquipmentModelCode,
      // 来源业务状态：导入正式事实需要知道它是待审还是已通过结单
      sourceStatus: entity.status,
    };
  }

  /**
   * 设备机型的**稳定编码**（跨设备定位机型）。
   *
   * 机型 id 是全局型号库的自增主键，跨设备不可移植；编码（`model_code`）才是
   * 跨设备一致的标识。读不到编码即不带该字段（导入侧按"不可核验"拒绝该条）。
   */
  private async readEquipmentModelCode(equipmentModelId: number | null): Promise<string | null> {
    if (equipmentModelId === null || equipmentModelId === undefined) {
      return null;
    }
    const model = await this.equipmentModelQueryService.findModelById({
      id: equipmentModelId,
    });
    return model?.modelCode ?? null;
  }

  /** 关联工单的跨端稳定编号（工单总结导入需要据此定位工单） */
  private async readRelatedRepairRequest(
    repairRequestId: number | null,
  ): Promise<{ recordUuid: string | null } | null> {
    if (repairRequestId === null || repairRequestId === undefined) {
      return null;
    }
    const row = await this.repairRequestRepository.findOne({
      where: { id: repairRequestId },
      select: { recordUuid: true },
    });
    return row === null ? null : { recordUuid: row.recordUuid };
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

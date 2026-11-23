// src/modules/lithography/business-sync-source.service.ts
/**
 * 业务同步来源读取服务（任务 09 S2.1）。
 *
 * 职责：为「来源记录 → 待传任务」与「派发」两段提供**只读事实**：
 * - 候选记录清单（本机可同步的来源记录，含删除／下架、版本与身份可信度）；
 * - 待传素材（正文快照 + 原件清单 + 确定性摘要）。
 *
 * 口径边界：
 * - **只读**，不写任何表（写由 usecase 层的登记用例与派发链负责）；
 * - 正文快照只含**跨端稳定事实**，不含本机自增 ID 与行级时间戳，
 *   保证同一版本在任意设备上重算得到同一摘要；
 * - 原件清单使用登记校验值（stored_file／附件表的 checksum_sha256）；
 *   参考资料行没有登记校验值，按字节流实测 SHA-256 与字节数。
 */

import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';

import {
  computeBusinessSyncManifestChecksum,
  type BusinessSyncManifestOriginal,
} from '@core/local-runtime/policy/business-sync-source.policy';
import type { BusinessSyncOriginalPayload } from '@core/local-runtime/policy/business-sync-protocol.policy';
import {
  REFERENCE_DOCUMENT_STORAGE,
  type ReferenceDocumentStorage,
} from '@src/usecases/common/ports/reference-document-storage.contract';

import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { StoredFileEntity } from './entities/stored-file.entity';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  type SyncSourceResourceType,
} from './queries/sync-source-record.query.service';

/** 单次候选扫描上限（避免一次拉取整表） */
export const BUSINESS_SYNC_CANDIDATE_LIMIT = 200;

/**
 * 单件原件字节上限（32 MiB）。
 *
 * 为什么必须设上限：原件字节要**整读进内存**再以 multipart 部件送出
 * （Node 侧 multipart 实现要求可重复读取的 Buffer/Blob），
 * 没有上限就等于"一个超大文件把 Worker 内存吃光"。
 * 超过上限 ⇒ 读失败（不派发），宁可同步失败也不让本机内存失控。
 */
export const BUSINESS_SYNC_MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;

/**
 * 单次派发全部原件字节总量上限（64 MiB）。
 *
 * 单件都合法不代表整体合法：多件累加同样会把内存吃光。
 */
export const BUSINESS_SYNC_MAX_TOTAL_ORIGINAL_BYTES = 64 * 1024 * 1024;

/** 候选记录事实（准入裁决的输入） */
export type BusinessSyncSourceCandidate = {
  resourceType: SyncSourceResourceType;
  recordId: number;
  /** 源表持久化的稳定编号；历史行为 null（派生值不算可信身份） */
  recordUuid: string | null;
  ownerOrganizationId: number | null;
  /** 当前业务版本；不可核验时为 null */
  currentVersion: number | null;
  /** 当前版本是否可核验 */
  versionTrusted: boolean;
  /** 是否已删除／下架／撤回 */
  withdrawn: boolean;
  /** 稳定身份是否已持久化 */
  identityPersisted: boolean;
  /** 原账号（授权主体）账号 ID */
  authorizationSubjectAccountId: number | null;
};

/** 待传素材（正文 + 原件 + 摘要 + 原件字节） */
export type BusinessSyncSourcePayload = {
  resourceType: SyncSourceResourceType;
  recordId: number;
  recordUuid: string;
  versionNo: number;
  /** 正文快照（跨端稳定事实） */
  body: Record<string, unknown>;
  /** 原件清单（相对路径 + 校验值 + 字节数） */
  originals: BusinessSyncManifestOriginal[];
  /**
   * 原件**字节**（本机实测读取）。
   *
   * 清单只是"打算传什么"，字节才是"真的传了什么"：两者必须逐项对上。
   */
  originalPayloads: BusinessSyncOriginalPayload[];
  /** 正文 + 原件清单的确定性摘要 */
  manifestChecksum: string;
};

@Injectable()
export class BusinessSyncSourceService {
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
  ) {}

  /** 本机支持同步的来源类型（与同步状态查询口径一致） */
  listSupportedResourceTypes(): readonly SyncSourceResourceType[] {
    return SYNC_SOURCE_RESOURCE_TYPES;
  }

  /**
   * 列出候选来源记录（按最近更新排序，条数受上限约束）。
   *
   * 只列本机数据区（`owner_organization_id` = 本机映射公司）；归属未知的存量行
   * 不进入候选（归属未知即无法核对公司，不得生成待传任务）。
   */
  async listCandidates(
    organizationId: number,
    resourceType: SyncSourceResourceType,
    limit: number = BUSINESS_SYNC_CANDIDATE_LIMIT,
  ): Promise<BusinessSyncSourceCandidate[]> {
    if (resourceType === 'REFERENCE_DOCUMENT') {
      return this.listDocumentCandidates(organizationId, limit);
    }
    if (resourceType === 'REPAIR_REQUEST') {
      return this.listRepairRequestCandidates(organizationId, limit);
    }
    return this.listReportCandidates(organizationId, limit);
  }

  /** 资料记录候选：下架（停用／删除／未上架）即视为撤回 */
  private async listDocumentCandidates(
    organizationId: number,
    limit: number,
  ): Promise<BusinessSyncSourceCandidate[]> {
    const rows = await this.referenceDocumentRepository.find({
      where: { ownerOrganizationId: organizationId },
      order: { updatedAt: 'DESC' },
      take: limit,
    });
    return rows.map((row) => ({
      resourceType: 'REFERENCE_DOCUMENT',
      recordId: row.id,
      recordUuid: row.recordUuid,
      ownerOrganizationId: row.ownerOrganizationId,
      currentVersion: row.currentRevisionNo > 0 ? row.currentRevisionNo : null,
      versionTrusted: row.currentRevisionNo > 0,
      withdrawn:
        row.deprecated === true || row.deletedAt !== null || row.publicationStatus === 'OFFLINE',
      identityPersisted: row.recordUuid !== null,
      authorizationSubjectAccountId: row.createdByAccountId,
    }));
  }

  /** 工单候选：停用或删除即视为撤回 */
  private async listRepairRequestCandidates(
    organizationId: number,
    limit: number,
  ): Promise<BusinessSyncSourceCandidate[]> {
    const rows = await this.repairRequestRepository.find({
      where: { ownerOrganizationId: organizationId },
      order: { id: 'DESC' },
      take: limit,
    });
    return rows.map((row) => ({
      resourceType: 'REPAIR_REQUEST',
      recordId: row.id,
      recordUuid: row.recordUuid,
      ownerOrganizationId: row.ownerOrganizationId,
      currentVersion: row.currentRevisionNo > 0 ? row.currentRevisionNo : null,
      versionTrusted: row.currentRevisionNo > 0,
      withdrawn: row.deprecated === true || row.deletedAt !== null,
      identityPersisted: row.recordUuid !== null,
      authorizationSubjectAccountId: row.acceptedByEngineerAccountId ?? row.customerAccountId,
    }));
  }

  /** 报告候选：报告域没有软删除列，下架由业务状态表达，本层不推断 */
  private async listReportCandidates(
    organizationId: number,
    limit: number,
  ): Promise<BusinessSyncSourceCandidate[]> {
    const rows = await this.maintenanceReportRepository.find({
      where: { ownerOrganizationId: organizationId },
      order: { updatedAt: 'DESC' },
      take: limit,
    });
    return rows.map((row) => ({
      resourceType: 'MAINTENANCE_REPORT',
      recordId: row.id,
      recordUuid: row.recordUuid,
      ownerOrganizationId: row.ownerOrganizationId,
      currentVersion: row.currentVersionNo > 0 ? row.currentVersionNo : null,
      versionTrusted: row.currentVersionNo > 0,
      withdrawn: false,
      identityPersisted: row.recordUuid !== null,
      authorizationSubjectAccountId: row.createdByAccountId,
    }));
  }

  /**
   * 读取待传素材：正文快照 + 原件清单 + 摘要。
   *
   * 调用方必须已确认记录归属本公司、版本可核验；本方法只负责组装素材。
   */
  async readPayload(input: {
    resourceType: SyncSourceResourceType;
    recordId: number;
    recordUuid: string;
    versionNo: number;
  }): Promise<BusinessSyncSourcePayload> {
    const payload =
      input.resourceType === 'REFERENCE_DOCUMENT'
        ? await this.readDocumentPayload(input)
        : input.resourceType === 'REPAIR_REQUEST'
          ? await this.readRepairRequestPayload(input)
          : await this.readReportPayload(input);
    // 总量纪律：单件都合法不代表整体合法（多件累加同样会吃光内存）
    const totalBytes = payload.originalPayloads.reduce(
      (sum, item) => sum + item.bytes.byteLength,
      0,
    );
    if (totalBytes > BUSINESS_SYNC_MAX_TOTAL_ORIGINAL_BYTES) {
      throw new Error(`原件总量超过上限（${BUSINESS_SYNC_MAX_TOTAL_ORIGINAL_BYTES} 字节），不派发`);
    }
    return payload;
  }

  /** 资料记录：正文取当前修订内容，原件取本机存储文件（实测校验值） */
  private async readDocumentPayload(input: {
    recordId: number;
    recordUuid: string;
    versionNo: number;
  }): Promise<BusinessSyncSourcePayload> {
    const row = await this.referenceDocumentRepository.findOne({
      where: { id: input.recordId },
    });
    if (row === null) {
      throw new Error('来源记录不存在');
    }
    const body: Record<string, unknown> = {
      schema_version: row.schemaVersion,
      title: row.title,
      document_type: row.documentType,
      description: row.description,
      content_text: row.contentText,
      original_filename: row.originalFilename,
      mime_type: row.mimeType,
      extension: row.extensionJson,
      current_revision_no: row.currentRevisionNo,
    };

    const originals: BusinessSyncManifestOriginal[] = [];
    const originalPayloads: BusinessSyncOriginalPayload[] = [];
    if (row.storageBackend !== null && row.storageReference !== null) {
      // 原件**字节**：清单说"传什么"，字节说"真的传了什么"——两者必须逐项对上。
      // 字节只读一次并同时用于计量与送出（避免"计量一份、送出另一份"的时序错位）。
      const bytes = await this.readStoredFileBytes(row.storageReference);
      const relativePath = `originals/${sanitizeOriginalName(row.originalFilename)}`;
      originals.push({
        relativePath,
        sha256: sha256Of(bytes),
        byteSize: bytes.byteLength,
      });
      originalPayloads.push({ relativePath, bytes });
    }

    return {
      resourceType: 'REFERENCE_DOCUMENT',
      recordId: input.recordId,
      recordUuid: input.recordUuid,
      versionNo: input.versionNo,
      body,
      originals,
      originalPayloads,
      manifestChecksum: computeBusinessSyncManifestChecksum({
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: input.recordUuid,
        versionNo: input.versionNo,
        body,
        originals,
      }),
    };
  }

  /** 工单：正文取当前修订内容，原件取登记的维修附件 */
  private async readRepairRequestPayload(input: {
    recordId: number;
    recordUuid: string;
    versionNo: number;
  }): Promise<BusinessSyncSourcePayload> {
    const row = await this.repairRequestRepository.findOne({ where: { id: input.recordId } });
    if (row === null) {
      throw new Error('来源记录不存在');
    }
    const body: Record<string, unknown> = {
      schema_version: 1,
      request_no: row.requestNo,
      fault_description: row.faultDescription,
      content_md: row.contentMd,
      current_revision_no: row.currentRevisionNo,
      maintenance_version_no: row.maintenanceVersionNo,
      handling_result: row.handlingResult,
      handling_status: row.handlingStatus,
    };

    const originals: BusinessSyncManifestOriginal[] = [];
    const originalPayloads: BusinessSyncOriginalPayload[] = [];
    if (row.maintenanceAttachmentFileId !== null) {
      const stored = await this.storedFileRepository.findOne({
        where: { fileId: row.maintenanceAttachmentFileId },
      });
      if (stored === null || stored.checksumSha256 === null) {
        throw new Error('登记的维修附件原件缺少校验值');
      }
      const bytes = await this.readStoredFileBytes(stored.storageReference);
      const relativePath = `originals/${sanitizeOriginalName(stored.originalFilename)}`;
      // 清单用**登记校验值**（附件表的事实）；与实际字节是否一致由派发前的
      // "字节 vs 清单"复核判定（不一致即不派发），不在这里悄悄改写登记事实
      originals.push({
        relativePath,
        sha256: stored.checksumSha256,
        byteSize: Number(stored.byteSize),
      });
      originalPayloads.push({ relativePath, bytes });
    }

    return {
      resourceType: 'REPAIR_REQUEST',
      recordId: input.recordId,
      recordUuid: input.recordUuid,
      versionNo: input.versionNo,
      body,
      originals,
      originalPayloads,
      manifestChecksum: computeBusinessSyncManifestChecksum({
        resourceType: 'REPAIR_REQUEST',
        recordUuid: input.recordUuid,
        versionNo: input.versionNo,
        body,
        originals,
      }),
    };
  }

  /** 维修报告：正文取冻结版本快照，原件取当前附件集合 */
  private async readReportPayload(input: {
    recordId: number;
    recordUuid: string;
    versionNo: number;
  }): Promise<BusinessSyncSourcePayload> {
    const versionRow = await this.reportVersionRepository.findOne({
      where: { reportId: input.recordId, versionNo: input.versionNo },
    });
    if (versionRow === null) {
      throw new Error('报告当前版本登记缺失');
    }
    const body: Record<string, unknown> = {
      schema_version: versionRow.schemaVersion,
      report_version_no: versionRow.versionNo,
      change_kind: versionRow.changeKind,
      submitted_at: versionRow.submittedAt?.toISOString() ?? null,
      payload: versionRow.payloadSnapshot,
    };

    const attachments = await this.reportAttachmentRepository.find({
      where: { reportId: input.recordId, status: 'CURRENT' },
      order: { sortOrder: 'ASC' },
    });
    const originals: BusinessSyncManifestOriginal[] = [];
    const originalPayloads: BusinessSyncOriginalPayload[] = [];
    // 同名附件去重：两件同名附件若用同一相对路径，清单与字节就**无法逐项一一对应**
    // （逐项核对只会命中第一条），第二件的字节永不被校验 ⇒ 相对路径必须唯一
    const uniqueNames = assignUniqueOriginalNames(
      attachments.map((attachment) => sanitizeOriginalName(attachment.originalFilename)),
    );
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.checksumSha256 === null) {
        throw new Error('报告附件缺少校验值');
      }
      const relativePath = `originals/${uniqueNames[index]}`;
      originals.push({
        relativePath,
        sha256: attachment.checksumSha256,
        byteSize: attachment.byteSize,
      });
      originalPayloads.push({
        relativePath,
        bytes: await this.readStoredFileBytes(attachment.storageReference),
      });
    }

    return {
      resourceType: 'MAINTENANCE_REPORT',
      recordId: input.recordId,
      recordUuid: input.recordUuid,
      versionNo: input.versionNo,
      body,
      originals,
      originalPayloads,
      manifestChecksum: computeBusinessSyncManifestChecksum({
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: input.recordUuid,
        versionNo: input.versionNo,
        body,
        originals,
      }),
    };
  }

  /**
   * 读取存储原件的**字节**（实测）。
   *
   * 读不到即抛错：宁可本机不派发，也不送出一份"清单说有、字节其实没有"的包。
   *
   * 大小纪律：单件超过 `BUSINESS_SYNC_MAX_ORIGINAL_BYTES` 即中止读取并抛错
   * （字节要整读进内存再送 multipart，没有上限就等于一个超大文件把 Worker 内存吃光）。
   */
  private async readStoredFileBytes(storageReference: string): Promise<Uint8Array> {
    const stream = await this.fileStorage.open(storageReference);
    const chunks: Buffer[] = [];
    let byteSize = 0;
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        byteSize += buffer.byteLength;
        if (byteSize > BUSINESS_SYNC_MAX_ORIGINAL_BYTES) {
          stream.destroy();
          reject(new Error(`原件超过单件上限（${BUSINESS_SYNC_MAX_ORIGINAL_BYTES} 字节），不派发`));
          return;
        }
        chunks.push(buffer);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });
    return new Uint8Array(Buffer.concat(chunks));
  }
}

/** 原件字节 → SHA-256（十六进制小写） */
function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256')
    .update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest('hex');
}

/** 原件文件名净化：只保留字母数字、点、下划线与连字符（与记录包导出口径一致） */
function sanitizeOriginalName(originalFilename: string | null): string {
  const base = (originalFilename ?? 'file.bin').split(/[\\/]/).pop() ?? 'file.bin';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 100) : 'file.bin';
}

/**
 * 同名附件去重：同名时在扩展名前加序号（`report.pdf` → `report-2.pdf`）。
 *
 * 为什么必须唯一：清单条目与 multipart 部件都按相对路径寻址，
 * 两条相同路径会让"清单 ↔ 字节"的逐项核对失去唯一对应
 * （第二件的字节永不被校验，云端也会收到同名部件）。
 */
function assignUniqueOriginalNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (!used.has(name)) {
      used.add(name);
      result.push(name);
      continue;
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let index = 2;
    let candidate = `${stem}-${index}${extension}`;
    while (used.has(candidate)) {
      index += 1;
      candidate = `${stem}-${index}${extension}`;
    }
    used.add(candidate);
    result.push(candidate);
  }
  return result;
}

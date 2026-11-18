// src/modules/lithography/queries/repair-process-entry.query.service.ts

import {
  StoredFileBindingStatus,
  StoredFileBusinessType,
  StoredFileStatus,
} from '@app-types/models/stored-file.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RepairProcessEntryEntity } from '../entities/repair-process-entry.entity';
import { StoredFileEntity } from '../entities/stored-file.entity';
import { RepairProcessEntryStoredFileView, RepairProcessEntryView } from '../lithography.types';

/** 过程文本投影：不读取 entry.file_id，也不联接 stored_file */
const ENTRY_TEXT_SELECT: string[] = [
  'entry.id AS id',
  'entry.entry_uuid AS entryUuid',
  'entry.request_id AS requestId',
  'entry.operation_text AS operationText',
  'entry.test_result AS testResult',
  'entry.occurred_at AS occurredAt',
  'entry.time_source AS timeSource',
  'entry.version_no AS versionNo',
  'entry.created_at AS createdAt',
];

/**
 * 原件事实投影：仅在调用方已完成原件的组织/身份授权后使用。
 * 除展示字段外，同时读取任务 11 正式绑定判定所需的文件事实。
 */
const ENTRY_FILE_SELECT: string[] = [
  'entry.file_id AS fileId',
  'file.file_id AS fileFileId',
  'file.original_filename AS fileOriginalFilename',
  'file.mime_type AS fileMimeType',
  'file.byte_size AS fileByteSize',
  'file.checksum_sha256 AS fileChecksumSha256',
  'file.status AS fileStatus',
  'file.binding_status AS fileBindingStatus',
  'file.verified_at AS fileVerifiedAt',
  'file.business_id AS fileBusinessId',
  'file.business_type AS fileBusinessType',
];

type RepairProcessEntryTextRow = {
  id: string;
  entryUuid: string;
  requestId: string | number;
  operationText: string;
  testResult: string | null;
  occurredAt: Date | string | null;
  timeSource: string;
  versionNo: string | number;
  createdAt: Date | string;
};

type RepairProcessEntryFileRow = RepairProcessEntryTextRow & {
  fileId: string | null;
  fileFileId: string | null;
  fileOriginalFilename: string | null;
  fileMimeType: string | null;
  fileByteSize: string | null;
  fileChecksumSha256: string | null;
  fileStatus: string | null;
  fileBindingStatus: string | null;
  fileVerifiedAt: Date | string | null;
  fileBusinessId: string | null;
  fileBusinessType: string | null;
};

/**
 * 内部维修过程读侧查询服务。
 *
 * 职责范围：
 * - 按工单读取过程列表（created_at ASC, id ASC）
 * - 仅在调用方已授权时左连接已绑定原件，输出原件安全展示字段（不暴露存储引用）
 *
 * 读取顺序安全边界：
 * - `listByRequestTextOnly` 只读过程文本，不 select `entry.file_id`、不联接
 *   `stored_file`，供管理员组织授权失败等无权路径使用；
 * - `listByRequest` 才读取原件标识与元数据，调用方必须先完成组织/身份授权。
 *
 * 原件展示判定与任务 11 `StoredFileQueryService.canAccessBoundRepairProcess`
 * 的文件事实口径一致：用途 REPAIR_PROCESS、状态 VALID、verifiedAt 非空、
 * bindingStatus=BOUND、businessId 指向当前工单，且过程行 file_id 与真实原件一致。
 * 任一项不满足时同时隐藏 fileId 与 file，避免详情展示无效或归属不符的原件。
 * 组织范围与工单未删除仍由调用方（管理员/工程师详情）按既有口径保证。
 */
@Injectable()
export class RepairProcessEntryQueryService {
  constructor(
    @InjectRepository(RepairProcessEntryEntity)
    private readonly repository: Repository<RepairProcessEntryEntity>,
  ) {}

  /**
   * 仅过程文本投影：不读取原件标识或元数据。
   * 无权查看原件的调用方只能使用本方法；返回视图的 fileId/file 恒为 null。
   */
  async listByRequestTextOnly(requestId: number): Promise<RepairProcessEntryView[]> {
    const rows = await this.repository
      .createQueryBuilder('entry')
      .select([...ENTRY_TEXT_SELECT])
      .where('entry.request_id = :requestId', { requestId })
      .orderBy('entry.created_at', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .getRawMany<RepairProcessEntryTextRow>();

    return rows.map((row) => ({
      ...toProcessEntryBase(row),
      fileId: null,
      file: null,
    }));
  }

  /**
   * 含原件事实的过程投影：调用方必须已完成原件组织/身份授权。
   * 本方法内再按任务 11 文件事实逐件校验，异常文件仍隐藏 fileId/file。
   */
  async listByRequest(requestId: number): Promise<RepairProcessEntryView[]> {
    const rows = await this.repository
      .createQueryBuilder('entry')
      .leftJoin(
        StoredFileEntity,
        'file',
        'file.file_id = entry.file_id AND file.business_type = :businessType',
        { businessType: 'REPAIR_PROCESS' },
      )
      .select([...ENTRY_TEXT_SELECT, ...ENTRY_FILE_SELECT])
      .where('entry.request_id = :requestId', { requestId })
      .orderBy('entry.created_at', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .getRawMany<RepairProcessEntryFileRow>();

    return rows.map((row) => {
      const base = toProcessEntryBase(row);
      const canExposeFile = canExposeRepairProcessFile({
        requestId: base.requestId,
        entryFileId: row.fileId,
        fileId: row.fileFileId,
        fileBusinessType: row.fileBusinessType,
        fileStatus: row.fileStatus,
        fileVerifiedAt: row.fileVerifiedAt,
        fileBindingStatus: row.fileBindingStatus,
        fileBusinessId: row.fileBusinessId,
      });
      const file: RepairProcessEntryStoredFileView | null =
        canExposeFile && row.fileFileId !== null
          ? {
              fileId: row.fileFileId,
              originalFilename: row.fileOriginalFilename ?? '',
              mimeType: row.fileMimeType ?? '',
              byteSize: Number(row.fileByteSize ?? 0),
              checksumSha256: row.fileChecksumSha256 ?? '',
            }
          : null;
      return {
        ...base,
        // 不仅是 file 对象：原始过程行 file_id 也不得残留
        fileId: canExposeFile ? row.fileId : null,
        file,
      };
    });
  }
}

/** 过程文本字段映射：两条投影共用，保证过程文本/版本号展示一致 */
function toProcessEntryBase(
  row: RepairProcessEntryTextRow,
): Omit<RepairProcessEntryView, 'fileId' | 'file'> {
  return {
    id: String(row.id),
    entryUuid: row.entryUuid,
    requestId: Number(row.requestId),
    operationText: row.operationText,
    testResult: row.testResult,
    occurredAt: row.occurredAt === null ? null : new Date(row.occurredAt),
    timeSource: row.timeSource,
    versionNo: Number(row.versionNo),
    createdAt: new Date(row.createdAt),
  };
}

/**
 * 过程原件是否可进入详情投影（纯判定，失败关闭）。
 *
 * 与任务 11 `canAccessBoundRepairProcess` 的文件事实部分逐项对齐：
 * 1. 真实关联：过程行 file_id 必须存在且等于左连接到的 stored_file.file_id；
 * 2. 用途为 REPAIR_PROCESS；
 * 3. 文件校验状态 VALID；
 * 4. verifiedAt 非空（完整校验已完成）；
 * 5. 绑定状态 BOUND；
 * 6. businessId 可解析为安全正整数且等于当前过程行 requestId
 *    （任务 11 亦以 Number(businessId) 定位真实过程关联）。
 *
 * 工单 deprecated 与管理员/工程师组织范围不在本函数内：它们分别由
 * `findSummaryById` / `findDetail` 的工单可见性与组织判定先行失败关闭。
 */
function canExposeRepairProcessFile(input: {
  requestId: number;
  entryFileId: string | null;
  fileId: string | null;
  fileBusinessType: string | null;
  fileStatus: string | null;
  fileVerifiedAt: Date | string | null;
  fileBindingStatus: string | null;
  fileBusinessId: string | null;
}): boolean {
  if (input.entryFileId === null || input.fileId === null) {
    return false;
  }
  if (input.entryFileId !== input.fileId) {
    return false;
  }
  if (input.fileBusinessType !== StoredFileBusinessType.REPAIR_PROCESS) {
    return false;
  }
  if (input.fileStatus !== StoredFileStatus.VALID) {
    return false;
  }
  if (!input.fileVerifiedAt) {
    return false;
  }
  if (input.fileBindingStatus !== StoredFileBindingStatus.BOUND) {
    return false;
  }
  if (input.fileBusinessId === null) {
    return false;
  }
  const businessRequestId = Number(input.fileBusinessId);
  if (!Number.isSafeInteger(businessRequestId) || businessRequestId <= 0) {
    return false;
  }
  return businessRequestId === input.requestId;
}

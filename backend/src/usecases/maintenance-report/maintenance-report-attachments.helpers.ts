// src/usecases/maintenance-report/maintenance-report-attachments.helpers.ts
// 附件集合输入校验（上传元数据层）：数量、单文件/总字节、存储后端、排序槽位。

import {
  MAINTENANCE_ATTACHMENT_MAX_BYTES,
  MAINTENANCE_ATTACHMENT_MAX_COUNT,
  MAINTENANCE_ATTACHMENT_MAX_TOTAL_BYTES,
  MaintenanceAttachmentStorageBackend,
} from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportAttachmentSnapshot } from '@src/modules/lithography/maintenance-report.types';
import {
  ATTACHMENT_DESCRIPTION_MAX,
  ATTACHMENT_FILENAME_MAX,
  ATTACHMENT_MIME_MAX,
  ATTACHMENT_STORAGE_REFERENCE_MAX,
  assertAttachmentStorageBackend,
  normalizeAttachmentChecksum,
  normalizeAttachmentOptionalText,
  requireAttachmentText,
  resolveAttachmentSortOrder,
} from './maintenance-report-attachment.input.normalize';
import type { MaintenanceReportAttachmentFileInput } from './maintenance-report-command.types';

export type ValidatedAttachmentInput = {
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string | null;
  storageBackend: MaintenanceAttachmentStorageBackend;
  storageReference: string;
  description: string | null;
  sortOrder: number;
};

/**
 * 校验并归一化上传元数据。
 *
 * 文件实体由上传适配层落盘后传入存储引用；本层只接受真实引用，不生成占位值。
 * `sortOrder` 未提供时取当前集合中第一个空闲槽位（1-10）。
 */
export function validateAttachmentInput(
  file: MaintenanceReportAttachmentFileInput,
  current: readonly MaintenanceReportAttachmentSnapshot[],
): ValidatedAttachmentInput {
  const originalFilename = requireAttachmentText(
    file.originalFilename,
    ATTACHMENT_FILENAME_MAX,
    '文件名',
  );
  const mimeType = requireAttachmentText(file.mimeType, ATTACHMENT_MIME_MAX, 'MIME 类型');
  const storageReference = requireAttachmentText(
    file.storageReference,
    ATTACHMENT_STORAGE_REFERENCE_MAX,
    '存储引用',
  );
  const storageBackend = assertAttachmentStorageBackend(file.storageBackend);
  if (!Number.isInteger(file.byteSize) || file.byteSize <= 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '附件大小无效', {
      byteSize: file.byteSize,
    });
  }
  if (file.byteSize > MAINTENANCE_ATTACHMENT_MAX_BYTES) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ATTACHMENT_TOO_LARGE,
      `单个附件不能超过 ${MAINTENANCE_ATTACHMENT_MAX_BYTES} 字节`,
      { byteSize: file.byteSize },
    );
  }
  if (current.length >= MAINTENANCE_ATTACHMENT_MAX_COUNT) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED,
      `当前附件最多 ${MAINTENANCE_ATTACHMENT_MAX_COUNT} 个`,
      { count: current.length },
    );
  }
  const currentBytes = current.reduce((total, item) => total + item.byteSize, 0);
  if (currentBytes + file.byteSize > MAINTENANCE_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ATTACHMENT_TOTAL_SIZE_EXCEEDED,
      '附件总大小超出上限',
      { currentBytes, incomingBytes: file.byteSize },
    );
  }
  const sortOrder = resolveAttachmentSortOrder(file.sortOrder, current);
  const checksumSha256 = normalizeAttachmentChecksum(file.checksumSha256);
  const description = normalizeAttachmentOptionalText(
    file.description,
    ATTACHMENT_DESCRIPTION_MAX,
    '附件描述',
  );

  return {
    originalFilename,
    mimeType,
    byteSize: file.byteSize,
    checksumSha256,
    storageBackend,
    storageReference,
    description,
    sortOrder,
  };
}

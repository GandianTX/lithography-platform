// src/usecases/maintenance-report/maintenance-report-attachment.input.normalize.ts
// 附件上传元数据归一化：文本裁剪、校验和、排序槽位。
// 按项目约定，trim / Set 等输入收敛只允许出现在 *.input.normalize.ts。

import {
  MAINTENANCE_ATTACHMENT_MAX_COUNT,
  MaintenanceAttachmentStorageBackend,
} from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportAttachmentSnapshot } from '@src/modules/lithography/maintenance-report.types';

export const ATTACHMENT_FILENAME_MAX = 255;
export const ATTACHMENT_MIME_MAX = 100;
export const ATTACHMENT_STORAGE_REFERENCE_MAX = 512;
export const ATTACHMENT_DESCRIPTION_MAX = 500;
export const ATTACHMENT_SORT_ORDER_MAX = MAINTENANCE_ATTACHMENT_MAX_COUNT;

/** 必填附件文本：裁剪后非空且不超长 */
export function requireAttachmentText(value: string, maxLength: number, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, `${fieldName}不能为空`, {
      fieldName,
    });
  }
  if (trimmed.length > maxLength) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      `${fieldName}不能超过 ${maxLength} 个字符`,
      { fieldName, length: trimmed.length },
    );
  }
  return trimmed;
}

/** 可选附件文本：空白归一为 null，超长拒绝 */
export function normalizeAttachmentOptionalText(
  value: string | null | undefined,
  maxLength: number,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      `${fieldName}不能超过 ${maxLength} 个字符`,
      { fieldName, length: trimmed.length },
    );
  }
  return trimmed;
}

/** 校验和：小写 64 位十六进制，空白归一为 null */
export function normalizeAttachmentChecksum(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '校验和必须为 64 位十六进制');
  }
  return trimmed;
}

/**
 * 排序槽位：显式值必须落在 1-上限且未被占用；缺省时取第一个空闲槽位。
 * 槽位唯一性同时受库级生成列唯一键保护。
 */
export function resolveAttachmentSortOrder(
  requested: number | null | undefined,
  current: readonly MaintenanceReportAttachmentSnapshot[],
): number {
  const used = new Set<number>(current.map((item) => item.sortOrder));
  if (requested !== null && requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 1 || requested > ATTACHMENT_SORT_ORDER_MAX) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
        `附件排序号必须在 1-${ATTACHMENT_SORT_ORDER_MAX} 之间`,
        { sortOrder: requested },
      );
    }
    if (used.has(requested)) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED,
        '附件排序号已被占用',
        { sortOrder: requested },
      );
    }
    return requested;
  }
  for (let slot = 1; slot <= ATTACHMENT_SORT_ORDER_MAX; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  throw new DomainError(
    MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED,
    `当前附件最多 ${MAINTENANCE_ATTACHMENT_MAX_COUNT} 个`,
  );
}

/** 存储后端白名单校验 */
export function assertAttachmentStorageBackend(value: string): MaintenanceAttachmentStorageBackend {
  const allowed = Object.values(MaintenanceAttachmentStorageBackend) as string[];
  if (!allowed.includes(value)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '存储后端无效', {
      storageBackend: value,
    });
  }
  return value as MaintenanceAttachmentStorageBackend;
}

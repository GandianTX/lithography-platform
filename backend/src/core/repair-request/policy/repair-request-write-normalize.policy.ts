// src/core/repair-request/policy/repair-request-write-normalize.policy.ts
// 维修申请写场景共享输入收敛（纯策略）：
// 过程创建/编辑、结单与管理员修订共用同一套文本、事件时间、标识与原件入参规则，
// 避免在 usecase 内散写 trim / 空值判定 / 时间解析。

import type { RepairRequestHandlingResult } from '@app-types/models/repair-request.types';
import {
  DomainError,
  REPAIR_REQUEST_ERROR,
  STORED_FILE_ERROR,
  TIME_ERROR,
} from '@core/common/errors/domain-error';
import {
  normalizeOptionalText,
  normalizeRequiredText,
} from '@core/common/input-normalize/input-normalize.policy';
import { parseTimeInput } from '@core/common/time';
import { requiresClosureReason } from '@core/repair-request/policy/repair-process-write.policy';
import {
  normalizeStoredFileId,
  normalizeUploadContextId,
} from '@core/stored-file/policy/stored-file-input.policy';

/** 已收敛的待绑定原件（fileId / uploadContextId 均为稳定小写 UUID） */
export type NormalizedRepairProcessOriginal = {
  fileId: string;
  uploadContextId: string;
};

/** 执行操作：必填文本，trim 后不得为空（默认透传 normalize 层错误码） */
export function normalizeProcessOperationText(input: unknown): string {
  return normalizeRequiredText(input, { fieldName: '执行操作' });
}

/** 测试事实：未提供、空字符串、纯空白统一收敛为 null（不落空字符串） */
export function normalizeProcessTestResult(input: unknown): string | null {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '测试结果' });
  return normalized ?? null;
}

/**
 * 业务现场事件时间：
 * - 未提供 / 空白字符串表示使用服务端时间（返回 null）；
 * - 只接受完整的 datetime 字符串（可带时区偏移），拒绝纯日期、epoch 数字与 Date 实例；
 * - 解析层只做语法与日历校验，语义收敛保持既有 Date 口径，不改变 Entity / 迁移定义。
 */
export function normalizeProcessOccurredAt(input: unknown): Date | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (typeof input === 'string' && input.trim().length === 0) {
    return null;
  }

  const parsed = parseTimeInput(input);
  if (parsed instanceof DomainError) {
    throw parsed;
  }
  if (parsed.source !== 'string') {
    throw new DomainError(TIME_ERROR.INVALID_TIME_INPUT, '事件时间必须为字符串');
  }
  if (parsed.kind !== 'datetime') {
    throw new DomainError(TIME_ERROR.INVALID_BUSINESS_DATETIME, '事件时间必须包含日期与时分');
  }
  if (parsed.instant) {
    return parsed.instant;
  }
  // 不带时区的 datetime 字符串按既有本地时间口径构造 Date，与旧实现 `new Date(value)` 等价
  const { year, month, day, hour, minute, second, millisecond } = parsed.parts;
  return new Date(year, month - 1, day, hour, minute, second, millisecond);
}

/** 可选暂存原件：fileId 与 uploadContextId 必须同时提供且为稳定 UUID */
export function normalizeProcessOriginalFile(
  input: { fileId?: unknown; uploadContextId?: unknown } | null | undefined,
): NormalizedRepairProcessOriginal | null {
  if (input === null || input === undefined) {
    return null;
  }
  const fileId = normalizeStoredFileId(input.fileId);
  const uploadContextId = normalizeUploadContextId(input.uploadContextId);
  if (!fileId || !uploadContextId) {
    throw new DomainError(
      STORED_FILE_ERROR.INVALID_PARAMS,
      '原件编号与上传上下文必须同时提供且格式合法',
    );
  }
  return { fileId, uploadContextId };
}

/** 过程行标识：正整数文本，去空白后校验 */
export function normalizeRepairProcessEntryId(input: unknown): string {
  const normalized = normalizeRequiredText(input, { fieldName: '维修过程编号' });
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '维修过程编号格式不合法');
  }
  return normalized;
}

/** 乐观并发版本号：正整数 */
export function normalizeRepairProcessExpectedVersion(input: number): number {
  if (!Number.isSafeInteger(input) || input < 1) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '过程版本号格式不合法');
  }
  return input;
}

/** 结单原因：空白收敛为 null；中断/无法修复时必填 */
export function normalizeClosureReason(
  input: unknown,
  handlingResult: RepairRequestHandlingResult,
): string | null {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '结单原因' }) ?? null;
  if (normalized === null && requiresClosureReason(handlingResult)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '中断或无法修复时必须填写结单原因');
  }
  return normalized;
}

/** 已有结单原因的有效性判定：空白视为缺失（用于续用既有原因的校验） */
export function hasClosureReasonText(input: string | null): boolean {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '结单原因' });
  return normalized !== null && normalized !== undefined;
}

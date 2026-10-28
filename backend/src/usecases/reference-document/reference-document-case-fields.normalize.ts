// src/usecases/reference-document/reference-document-case-fields.normalize.ts

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import {
  normalizeEnumValue,
  normalizeOptionalText,
} from '@core/common/input-normalize/input-normalize.policy';
import {
  CONTENT_SUBMISSION_HANDLING_STATUSES,
  type ContentSubmissionHandlingStatus,
} from '@src/modules/lithography/content-submission.types';
import type { ReferenceDocumentCaseDetailView } from '@src/modules/lithography/lithography.types';
import type { ReferenceDocumentCaseEditablePatch } from './reference-document.types';

/**
 * 正式案例更正字段规范化与合并校验（A-PR0 §S6 专属更正）。
 *
 * 字段长度上限与投稿域（content-submission-fields.normalize.ts）保持同一口径
 * （A-PR0 §2.3：与明细表列长一致，两侧不得漂移）；错误码使用本域业务码，
 * 不跨域复用投稿错误码。可读正文格式化单一真源在
 * usecases/common/fault-case-fields.contract.ts（发布/更正共用）。
 */

/** 字段长度上限（与 reference_document / reference_document_case_detail 表列长一致） */
export const REFERENCE_DOCUMENT_CASE_TITLE_MAX_LENGTH = 255;
export const REFERENCE_DOCUMENT_CASE_MODEL_TEXT_MAX_LENGTH = 100;
export const REFERENCE_DOCUMENT_CASE_DESCRIPTION_MAX_LENGTH = 2000;
export const REFERENCE_DOCUMENT_CASE_ERROR_CODE_MAX_LENGTH = 100;
export const REFERENCE_DOCUMENT_CASE_PHENOMENON_MAX_LENGTH = 2000;
export const REFERENCE_DOCUMENT_CASE_CONDITION_MAX_LENGTH = 2000;
export const REFERENCE_DOCUMENT_CASE_REPRODUCTION_MAX_LENGTH = 10_000;
export const REFERENCE_DOCUMENT_CASE_DIAGNOSIS_MAX_LENGTH = 10_000;
export const REFERENCE_DOCUMENT_CASE_ACTION_TAKEN_MAX_LENGTH = 10_000;
export const REFERENCE_DOCUMENT_CASE_RESOLUTION_MAX_LENGTH = 2000;

/**
 * 可空业务文本规范化（更正补丁字段全部可空，部分提交语义）：
 * - undefined：保持（未提供）；
 * - null / 空白：清空为 null；
 * - 非空字符串：trim 后校验长度上限。
 */
function normalizeOptionalLimitedText(
  value: string | null | undefined,
  maxLength: number,
  fieldName: string,
): string | null | undefined {
  const normalized = normalizeOptionalText(value, 'to_null', { fieldName });
  if (typeof normalized === 'string' && normalized.length > maxLength) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      `${fieldName}不能超过 ${maxLength} 个字符`,
      { field: fieldName, length: normalized.length },
    );
  }
  return normalized;
}

/** 标题规范化（最长 255；必填语义由合并后校验承担） */
export function normalizeCaseTitle(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, REFERENCE_DOCUMENT_CASE_TITLE_MAX_LENGTH, '标题');
}

/** 机型文字规范化（最长 100；与机型 ID 互斥由合并后校验承担） */
export function normalizeCaseModelText(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_MODEL_TEXT_MAX_LENGTH,
    '机型文字',
  );
}

/** 文档说明规范化（最长 2,000；案例发布时留空，更正可补充/清空） */
export function normalizeCaseDescription(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_DESCRIPTION_MAX_LENGTH,
    '文档说明',
  );
}

/** 错误码规范化（最长 100；保留大小写与内部符号，只做空白折叠） */
export function normalizeCaseErrorCode(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_ERROR_CODE_MAX_LENGTH,
    '错误码',
  );
}

/** 故障现象规范化（最长 2,000；必填语义由合并后校验承担） */
export function normalizeCasePhenomenon(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_PHENOMENON_MAX_LENGTH,
    '故障现象',
  );
}

/** 触发条件规范化（最长 2,000） */
export function normalizeCaseConditionText(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_CONDITION_MAX_LENGTH,
    '触发条件',
  );
}

/** 复现步骤规范化（最长 10,000；保留换行；必填语义由合并后校验承担） */
export function normalizeCaseReproductionSteps(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_REPRODUCTION_MAX_LENGTH,
    '复现步骤',
  );
}

/** 排查过程规范化（最长 10,000；保留换行） */
export function normalizeCaseDiagnosis(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_DIAGNOSIS_MAX_LENGTH,
    '排查过程',
  );
}

/** 处理措施规范化（最长 10,000；保留换行） */
export function normalizeCaseActionTaken(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_ACTION_TAKEN_MAX_LENGTH,
    '处理措施',
  );
}

/** 处理结果规范化（最长 2,000；已解决必填由合并后校验承担） */
export function normalizeCaseResolution(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    REFERENCE_DOCUMENT_CASE_RESOLUTION_MAX_LENGTH,
    '处理结果',
  );
}

/**
 * 处理状态规范化：undefined 保持；null / 空白清空（置空尝试在合并后校验拒绝）；
 * 非空值必须属于受控值域。
 */
export function normalizeCaseHandlingStatus(
  value: string | null | undefined,
): ContentSubmissionHandlingStatus | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '处理状态取值非法', {
      field: '处理状态',
    });
  }
  if (value.trim().length === 0) {
    return null;
  }
  return normalizeEnumValue(value, CONTENT_SUBMISSION_HANDLING_STATUSES, {
    fieldName: '处理状态',
  });
}

/** 更正补丁整段校验：至少一个可更正字段出现（全 undefined 的无效写入拒绝） */
export function assertCasePatchHasEditableField(patch: ReferenceDocumentCaseEditablePatch): void {
  const hasField = Object.values(patch).some((value) => value !== undefined);
  if (!hasField) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正内容不能为空');
  }
}

/**
 * 案例明细合并态（合并后校验前的宽松类型）：处理状态与必填字段在更正后
 * 仍可能为空（补丁置空），由 assertCaseCorrectionPresent 拒绝。
 */
export type ReferenceDocumentCaseDetailMergedState = {
  errorCode: string | null;
  handlingStatus: ContentSubmissionHandlingStatus | null;
  phenomenon: string | null;
  conditionText: string | null;
  reproductionSteps: string | null;
  diagnosis: string | null;
  actionTaken: string | null;
  resolution: string | null;
};

/**
 * 单字段合并（更正补丁语义）：undefined 保持当前值；null/空白经 normalize 清空；
 * 新值经 normalize 覆盖（normalize 返回 null 时落 null）。
 */
function mergeOptionalField<T extends string>(
  patchValue: string | null | undefined,
  currentValue: T | null,
  normalize: (value: string | null | undefined) => T | null | undefined,
): T | null {
  if (patchValue === undefined) {
    return currentValue;
  }
  return normalize(patchValue) ?? null;
}

/**
 * 案例明细补丁合并（口径同投稿草稿：undefined 保持、null/空白清空、新值覆盖）：
 * 最终态校验（必填存在性/已解决结果）由调用方承担。
 *
 * 处理状态的当前值来自数据库读视图（受 chk_reference_document_case_detail_status
 * 受控值域约束），此处仍按受控值域复核，数据漂移时失败关闭而非静默输出非法标签。
 */
export function mergeCaseDetailPatch(
  current: ReferenceDocumentCaseDetailView,
  patch: ReferenceDocumentCaseEditablePatch,
): ReferenceDocumentCaseDetailMergedState {
  const handlingStatus =
    patch.handlingStatus !== undefined
      ? (normalizeCaseHandlingStatus(patch.handlingStatus) ?? null)
      : normalizeEnumValue(current.handlingStatus, CONTENT_SUBMISSION_HANDLING_STATUSES, {
          fieldName: '处理状态',
        });
  return {
    errorCode: mergeOptionalField(patch.errorCode, current.errorCode, normalizeCaseErrorCode),
    handlingStatus,
    phenomenon: mergeOptionalField(patch.phenomenon, current.phenomenon, normalizeCasePhenomenon),
    conditionText: mergeOptionalField(
      patch.conditionText,
      current.conditionText,
      normalizeCaseConditionText,
    ),
    reproductionSteps: mergeOptionalField(
      patch.reproductionSteps,
      current.reproductionSteps,
      normalizeCaseReproductionSteps,
    ),
    diagnosis: mergeOptionalField(patch.diagnosis, current.diagnosis, normalizeCaseDiagnosis),
    actionTaken: mergeOptionalField(
      patch.actionTaken,
      current.actionTaken,
      normalizeCaseActionTaken,
    ),
    resolution: mergeOptionalField(patch.resolution, current.resolution, normalizeCaseResolution),
  };
}

/**
 * 更正合并后必填校验（A-PR0 §S6「合并允许字段后验证」）：案例明细的现象/复现步骤/
 * 处理状态在更正后必须非空（可读正文的必填前提与发布体保持同一口径）；
 * 标题属主资料字段，由用例层单独校验。
 */
export function assertCaseCorrectionPresent(
  merged: ReferenceDocumentCaseDetailMergedState,
): asserts merged is ReferenceDocumentCaseDetailMergedState & {
  phenomenon: string;
  reproductionSteps: string;
  handlingStatus: ContentSubmissionHandlingStatus;
} {
  if (merged.phenomenon === null) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正后的案例故障现象不能为空');
  }
  if (merged.reproductionSteps === null) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正后的案例复现步骤不能为空');
  }
  if (merged.handlingStatus === null) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正后的案例处理状态不能为空');
  }
}

/**
 * 已解决必填结果校验（reference_document_case_detail
 * chk_reference_document_case_detail_resolution 同口径）。
 */
export function assertCaseResolutionWhenResolved(detail: {
  handlingStatus: ContentSubmissionHandlingStatus;
  resolution: string | null;
}): void {
  if (detail.handlingStatus === 'RESOLVED' && detail.resolution === null) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      '处理状态为已解决时必须填写处理结果',
    );
  }
}

/**
 * 机型互斥校验（chk_reference_document_model_exclusive，在合并后的最终态上判定）：
 * 机型 ID 与机型文字只能设置一个；替换机型需在同一补丁中「清空一侧 + 设置另一侧」。
 */
export function assertCaseModelExclusive(detail: {
  equipmentModelId: number | null;
  equipmentModelText: string | null;
}): void {
  if (detail.equipmentModelId !== null && detail.equipmentModelText !== null) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      '机型 ID 与机型文字只能设置一个（两者互斥）；替换机型请在同一补丁中清空另一侧',
    );
  }
}

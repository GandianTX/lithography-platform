// src/usecases/content-submission/content-submission-fields.normalize.ts

import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  normalizeEnumValue,
  normalizeOptionalText,
} from '@core/common/input-normalize/input-normalize.policy';
import {
  CONTENT_SUBMISSION_HANDLING_STATUSES,
  CONTENT_SUBMISSION_KINDS,
  CONTENT_SUBMISSION_STATUSES,
  type ContentSubmissionHandlingStatus,
  type ContentSubmissionKind,
  type ContentSubmissionStatus,
  type FaultCaseSubmissionDetailWriteData,
  type MaterialSubmissionDetailWriteData,
} from '@src/modules/lithography/content-submission.types';
import type { ContentSubmissionEditablePatch } from './content-submission.types';

/** 字段长度上限（A-PR0 §2.3，与明细表列长一致；前后端规则保持一致） */
export const CONTENT_SUBMISSION_TITLE_MAX_LENGTH = 255;
export const CONTENT_SUBMISSION_DOCUMENT_TYPE_MAX_LENGTH = 100;
export const CONTENT_SUBMISSION_MODEL_TEXT_MAX_LENGTH = 100;
export const CONTENT_SUBMISSION_DESCRIPTION_MAX_LENGTH = 2000;
export const CONTENT_SUBMISSION_CONTENT_MAX_LENGTH = 200_000;
export const CONTENT_SUBMISSION_ERROR_CODE_MAX_LENGTH = 100;
export const CONTENT_SUBMISSION_PHENOMENON_MAX_LENGTH = 2000;
export const CONTENT_SUBMISSION_CONDITION_MAX_LENGTH = 2000;
export const CONTENT_SUBMISSION_REPRODUCTION_MAX_LENGTH = 10_000;
export const CONTENT_SUBMISSION_DIAGNOSIS_MAX_LENGTH = 10_000;
export const CONTENT_SUBMISSION_ACTION_TAKEN_MAX_LENGTH = 10_000;
export const CONTENT_SUBMISSION_RESOLUTION_MAX_LENGTH = 2000;
/** 审核意见长度上限（A-PR0 §2.3「审核」行：退回理由必填；通过的意见可选） */
export const CONTENT_SUBMISSION_REVIEW_COMMENT_MAX_LENGTH = 2000;

/**
 * 正式案例保留资料类型（A-PR0 §2.3）：普通资料的资料类型不得为 FAULT_CASE
 * （案例只能由投稿审核发布进入正式库）。比较按大小写不敏感——与明细表
 * utf8mb4_0900_ai_ci 的校验口径（chk_material_submission_detail_type）对齐，
 * 避免应用层放行变体后被数据库检查拒绝成系统错误。
 */
export const CONTENT_SUBMISSION_FAULT_CASE_TYPE = 'FAULT_CASE';

/**
 * 可空业务文本规范化（草稿字段全部可空，创建与更新共用）：
 * - undefined：保持（创建时视为未提供）；
 * - null / 空白：清空为 null；
 * - 非空字符串：trim 后校验长度上限。
 * 空白判断与清空语义复用既有 normalize 规则（A-PR0 §2.3 补充口径 2）。
 */
function normalizeOptionalLimitedText(
  value: string | null | undefined,
  maxLength: number,
  fieldName: string,
): string | null | undefined {
  const normalized = normalizeOptionalText(value, 'to_null', { fieldName });
  if (typeof normalized === 'string' && normalized.length > maxLength) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
      `${fieldName}不能超过 ${maxLength} 个字符`,
      { field: fieldName, length: normalized.length },
    );
  }
  return normalized;
}

/** 标题规范化（最长 255） */
export function normalizeSubmissionTitle(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_TITLE_MAX_LENGTH, '标题');
}

/** 资料类型规范化（最长 100）；FAULT_CASE 为保留值拒绝（大小写不敏感） */
export function normalizeSubmissionDocumentType(
  value: string | null | undefined,
): string | null | undefined {
  const normalized = normalizeOptionalLimitedText(
    value,
    CONTENT_SUBMISSION_DOCUMENT_TYPE_MAX_LENGTH,
    '资料类型',
  );
  if (
    typeof normalized === 'string' &&
    normalized.toUpperCase() === CONTENT_SUBMISSION_FAULT_CASE_TYPE
  ) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
      '资料类型不能是 FAULT_CASE（案例请通过投稿审核流程发布）',
      { documentType: normalized },
    );
  }
  return normalized;
}

/** 机型文字规范化（最长 100；与机型 ID 互斥由合并后校验承担） */
export function normalizeSubmissionModelText(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_MODEL_TEXT_MAX_LENGTH, '机型文字');
}

/** 资料说明规范化（最长 2,000） */
export function normalizeSubmissionDescription(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_DESCRIPTION_MAX_LENGTH, '资料说明');
}

/** 资料正文规范化（最长 200,000；保留换行） */
export function normalizeSubmissionContentText(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_CONTENT_MAX_LENGTH, '资料正文');
}

/** 错误码规范化（最长 100；保留大小写与内部符号，只做空白折叠，不转大写） */
export function normalizeSubmissionErrorCode(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_ERROR_CODE_MAX_LENGTH, '错误码');
}

/** 故障现象规范化（最长 2,000） */
export function normalizeSubmissionPhenomenon(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_PHENOMENON_MAX_LENGTH, '故障现象');
}

/** 触发条件规范化（最长 2,000） */
export function normalizeSubmissionConditionText(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_CONDITION_MAX_LENGTH, '触发条件');
}

/** 复现步骤规范化（最长 10,000；保留换行） */
export function normalizeSubmissionReproductionSteps(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    CONTENT_SUBMISSION_REPRODUCTION_MAX_LENGTH,
    '复现步骤',
  );
}

/** 排查过程规范化（最长 10,000；保留换行） */
export function normalizeSubmissionDiagnosis(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_DIAGNOSIS_MAX_LENGTH, '排查过程');
}

/** 处理措施规范化（最长 10,000；保留换行） */
export function normalizeSubmissionActionTaken(value: string | null | undefined) {
  return normalizeOptionalLimitedText(
    value,
    CONTENT_SUBMISSION_ACTION_TAKEN_MAX_LENGTH,
    '处理措施',
  );
}

/** 处理结果规范化（最长 2,000） */
export function normalizeSubmissionResolution(value: string | null | undefined) {
  return normalizeOptionalLimitedText(value, CONTENT_SUBMISSION_RESOLUTION_MAX_LENGTH, '处理结果');
}

/**
 * 处理状态规范化：undefined 保持；null / 空白清空（草稿期可空；
 * 「处理状态必填」为送审判定，归 S4）；非空值必须属于受控值域。
 */
export function normalizeSubmissionHandlingStatus(
  value: string | null | undefined,
): ContentSubmissionHandlingStatus | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '处理状态取值非法', {
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

/** 投稿类别规范化（必填，值域校验） */
export function normalizeSubmissionKind(value: unknown): ContentSubmissionKind {
  return normalizeEnumValue(value, CONTENT_SUBMISSION_KINDS, { fieldName: '投稿类别' });
}

/**
 * 列表筛选枚举规范化：null/undefined/空白视为未提供该筛选
 * （与标题筛选「空白=无筛选」口径一致），非空值必须合法。
 */
function normalizeOptionalEnumFilter<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, `${fieldName}取值非法`, {
      field: fieldName,
    });
  }
  if (value.trim().length === 0) {
    return undefined;
  }
  return normalizeEnumValue(value, allowed, { fieldName });
}

/** 类别筛选规范化（空白视为未提供） */
export function normalizeSubmissionKindFilter(value: unknown): ContentSubmissionKind | undefined {
  return normalizeOptionalEnumFilter(value, CONTENT_SUBMISSION_KINDS, '投稿类别筛选');
}

/** 状态筛选规范化（空白视为未提供） */
export function normalizeSubmissionStatusFilter(
  value: unknown,
): ContentSubmissionStatus | undefined {
  return normalizeOptionalEnumFilter(value, CONTENT_SUBMISSION_STATUSES, '投稿状态筛选');
}

/**
 * 标题筛选词规范化：去首尾空白，空白视为未提供该筛选，防止直调空白词
 * 以字面量进入 LIKE 意外扩大匹配范围（与前端「空白搜索词=无筛选」口径一致）。
 */
export function normalizeOptionalFilterText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * v1 扩展位规范化（A-PR0 §2.3 补充口径 5）：schema_version=1 的补充字段集为
 * 空集，任何键都拒绝，不把原始任意 JSON 直接落库；合法空集（null/{}）统一落 null。
 */
export function normalizeExtensionV1(value: Record<string, unknown> | null | undefined): null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '扩展字段必须是对象');
  }
  const keys = Object.keys(value);
  if (keys.length > 0) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
      '扩展字段包含当前版本未定义的键',
      { extensionKeys: keys },
    );
  }
  return null;
}

/** 业务可编辑字段清单（不含 extension：v1 空集不构成有效编辑内容） */
const EDITABLE_BUSINESS_FIELDS: ReadonlyArray<keyof ContentSubmissionEditablePatch> = [
  'title',
  'documentType',
  'equipmentModelId',
  'equipmentModelText',
  'description',
  'contentText',
  'errorCode',
  'phenomenon',
  'conditionText',
  'reproductionSteps',
  'diagnosis',
  'actionTaken',
  'handlingStatus',
  'resolution',
];

/** 更新补丁整段校验：至少一个业务字段出现（全 undefined 的无效写入拒绝） */
export function assertPatchHasEditableField(patch: ContentSubmissionEditablePatch): void {
  const hasField = EDITABLE_BUSINESS_FIELDS.some((field) => patch[field] !== undefined);
  if (!hasField) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '编辑内容不能为空');
  }
}

/** 仅属于普通资料的字段（故障案例投稿中出现非空值即拒绝） */
const MATERIAL_ONLY_FIELDS: ReadonlyArray<keyof ContentSubmissionEditablePatch> = [
  'documentType',
  'description',
  'contentText',
];

/** 仅属于故障案例的字段（普通资料投稿中出现非空值即拒绝） */
const FAULT_CASE_ONLY_FIELDS: ReadonlyArray<keyof ContentSubmissionEditablePatch> = [
  'errorCode',
  'phenomenon',
  'conditionText',
  'reproductionSteps',
  'diagnosis',
  'actionTaken',
  'handlingStatus',
  'resolution',
];

/**
 * 类别与字段匹配防御：不属于目标类别的字段出现非空值即拒绝
 * （null/undefined 视为「未提供」，与草稿可空语义一致）。
 */
export function assertPatchMatchesKind(
  kind: ContentSubmissionKind,
  patch: ContentSubmissionEditablePatch,
): void {
  const forbiddenFields = kind === 'MATERIAL' ? FAULT_CASE_ONLY_FIELDS : MATERIAL_ONLY_FIELDS;
  for (const field of forbiddenFields) {
    const value = patch[field];
    if (value !== undefined && value !== null) {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
        `字段 ${field} 不属于投稿类别 ${kind}`,
        { field, kind },
      );
    }
  }
}

/**
 * 由创建输入组装普通资料明细写数据：创建时 undefined/null/空白统一落 null；
 * equipmentModelId 由 usecase 完成「未提供/提供」区分与正整数校验后传入。
 */
export function assembleMaterialDetailFromPatch(
  fields: ContentSubmissionEditablePatch,
  equipmentModelId: number | null,
): MaterialSubmissionDetailWriteData {
  return {
    title: normalizeSubmissionTitle(fields.title) ?? null,
    documentType: normalizeSubmissionDocumentType(fields.documentType) ?? null,
    equipmentModelId,
    equipmentModelText: normalizeSubmissionModelText(fields.equipmentModelText) ?? null,
    description: normalizeSubmissionDescription(fields.description) ?? null,
    contentText: normalizeSubmissionContentText(fields.contentText) ?? null,
  };
}

/** 由创建输入组装故障案例明细写数据（口径同上） */
export function assembleFaultCaseDetailFromPatch(
  fields: ContentSubmissionEditablePatch,
  equipmentModelId: number | null,
): FaultCaseSubmissionDetailWriteData {
  return {
    title: normalizeSubmissionTitle(fields.title) ?? null,
    equipmentModelId,
    equipmentModelText: normalizeSubmissionModelText(fields.equipmentModelText) ?? null,
    errorCode: normalizeSubmissionErrorCode(fields.errorCode) ?? null,
    phenomenon: normalizeSubmissionPhenomenon(fields.phenomenon) ?? null,
    conditionText: normalizeSubmissionConditionText(fields.conditionText) ?? null,
    reproductionSteps: normalizeSubmissionReproductionSteps(fields.reproductionSteps) ?? null,
    diagnosis: normalizeSubmissionDiagnosis(fields.diagnosis) ?? null,
    actionTaken: normalizeSubmissionActionTaken(fields.actionTaken) ?? null,
    handlingStatus: normalizeSubmissionHandlingStatus(fields.handlingStatus) ?? null,
    resolution: normalizeSubmissionResolution(fields.resolution) ?? null,
  };
}

/**
 * 单字段合并（更新补丁语义）：undefined 保持当前值；null/空白经 normalize 清空；
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
 * 普通资料明细补丁合并（undefined 保持当前值、null/空白清空、新值覆盖）；
 * equipmentModelId 由 usecase 单独解析后传入。最终态校验（互斥/已填写）由调用方承担。
 */
export function mergeMaterialDetailPatch(
  current: MaterialSubmissionDetailWriteData,
  patch: ContentSubmissionEditablePatch,
  equipmentModelId: number | null,
): MaterialSubmissionDetailWriteData {
  return {
    title: mergeOptionalField(patch.title, current.title, normalizeSubmissionTitle),
    documentType: mergeOptionalField(
      patch.documentType,
      current.documentType,
      normalizeSubmissionDocumentType,
    ),
    equipmentModelId,
    equipmentModelText: mergeOptionalField(
      patch.equipmentModelText,
      current.equipmentModelText,
      normalizeSubmissionModelText,
    ),
    description: mergeOptionalField(
      patch.description,
      current.description,
      normalizeSubmissionDescription,
    ),
    contentText: mergeOptionalField(
      patch.contentText,
      current.contentText,
      normalizeSubmissionContentText,
    ),
  };
}

/** 故障案例明细补丁合并（口径同上；RESOLVED/结果/互斥校验由调用方在合并后承担） */
export function mergeFaultCaseDetailPatch(
  current: FaultCaseSubmissionDetailWriteData,
  patch: ContentSubmissionEditablePatch,
  equipmentModelId: number | null,
): FaultCaseSubmissionDetailWriteData {
  return {
    title: mergeOptionalField(patch.title, current.title, normalizeSubmissionTitle),
    equipmentModelId,
    equipmentModelText: mergeOptionalField(
      patch.equipmentModelText,
      current.equipmentModelText,
      normalizeSubmissionModelText,
    ),
    errorCode: mergeOptionalField(patch.errorCode, current.errorCode, normalizeSubmissionErrorCode),
    phenomenon: mergeOptionalField(
      patch.phenomenon,
      current.phenomenon,
      normalizeSubmissionPhenomenon,
    ),
    conditionText: mergeOptionalField(
      patch.conditionText,
      current.conditionText,
      normalizeSubmissionConditionText,
    ),
    reproductionSteps: mergeOptionalField(
      patch.reproductionSteps,
      current.reproductionSteps,
      normalizeSubmissionReproductionSteps,
    ),
    diagnosis: mergeOptionalField(patch.diagnosis, current.diagnosis, normalizeSubmissionDiagnosis),
    actionTaken: mergeOptionalField(
      patch.actionTaken,
      current.actionTaken,
      normalizeSubmissionActionTaken,
    ),
    handlingStatus: mergeOptionalField(
      patch.handlingStatus,
      current.handlingStatus,
      normalizeSubmissionHandlingStatus,
    ),
    resolution: mergeOptionalField(
      patch.resolution,
      current.resolution,
      normalizeSubmissionResolution,
    ),
  };
}

/** 普通资料「已填写」文字字段集（A-PR0 §2.3 补充口径 1：不含机型 ID 与附件） */
const MATERIAL_FILLED_TEXT_FIELDS: ReadonlyArray<keyof MaterialSubmissionDetailWriteData> = [
  'title',
  'documentType',
  'equipmentModelText',
  'description',
  'contentText',
];

/**
 * 故障案例「已填写」文字字段集（同上：不含机型 ID、处理状态与附件——
 * 「只有默认状态不算已填写」）。
 */
const FAULT_CASE_FILLED_TEXT_FIELDS: ReadonlyArray<keyof FaultCaseSubmissionDetailWriteData> = [
  'title',
  'equipmentModelText',
  'errorCode',
  'phenomenon',
  'conditionText',
  'reproductionSteps',
  'diagnosis',
  'actionTaken',
  'resolution',
];

/**
 * 草稿「已填写」判定（A-PR0 §2.3 补充口径 1）：每次保存（创建与更新）后
 * 至少存在一个非空文字业务字段，不检查全部送审必填。
 */
export function assertMaterialDraftFilled(detail: MaterialSubmissionDetailWriteData): void {
  const hasFilledField = MATERIAL_FILLED_TEXT_FIELDS.some((field) => detail[field] !== null);
  if (!hasFilledField) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY, '草稿至少需要一个已填写的业务字段');
  }
}

/** 故障案例草稿「已填写」判定（口径同上） */
export function assertFaultCaseDraftFilled(detail: FaultCaseSubmissionDetailWriteData): void {
  const hasFilledField = FAULT_CASE_FILLED_TEXT_FIELDS.some((field) => detail[field] !== null);
  if (!hasFilledField) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY, '草稿至少需要一个已填写的业务字段');
  }
}

/**
 * 机型互斥校验（chk_material/fault_case_submission_detail_model_exclusive）：
 * 机型 ID 与机型文字只能设置一个；在合并后的最终态上判定，
 * 允许同一次补丁内「清空文字 + 设置 ID」的替换操作。
 */
export function assertModelExclusive(detail: {
  equipmentModelId: number | null;
  equipmentModelText: string | null;
}): void {
  if (detail.equipmentModelId !== null && detail.equipmentModelText !== null) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
      '机型 ID 与机型文字只能设置一个（两者互斥）',
    );
  }
}

/**
 * 已解决必填结果校验（chk_fault_case_submission_detail_resolution）：
 * 处理状态为 RESOLVED 时必须填写处理结果（草稿期即强制，与数据库检查口径一致）。
 */
export function assertResolutionWhenResolved(detail: {
  handlingStatus: ContentSubmissionHandlingStatus | null;
  resolution: string | null;
}): void {
  if (detail.handlingStatus === 'RESOLVED' && detail.resolution === null) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
      '处理状态为已解决时必须填写处理结果',
    );
  }
}

/**
 * 普通资料送审完整校验（A-PR0 §2.3「普通资料」行，与草稿期「至少一字段」宽松口径不同）：
 * 标题与资料类型必填；正文与当次有效附件至少一项——附件存在性由调用方以
 * 事务内 CURRENT 附件事实（不信任客户端声明）传入。
 */
export function assertMaterialSubmittable(
  detail: MaterialSubmissionDetailWriteData,
  hasCurrentAttachment: boolean,
): asserts detail is MaterialSubmissionDetailWriteData & {
  title: string;
  documentType: string;
} {
  if (detail.title === null) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY, '送审前请填写标题', {
      field: '标题',
    });
  }
  if (detail.documentType === null) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY, '送审前请选择资料类型', {
      field: '资料类型',
    });
  }
  if (detail.contentText === null && !hasCurrentAttachment) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY,
      '送审前请填写正文或上传当前附件（至少一项）',
      { fields: ['正文', '附件'] },
    );
  }
}

/**
 * 故障案例送审完整校验（A-PR0 §2.3「案例」行）：标题、故障现象、复现步骤、
 * 处理状态必填；已解决结果要求在草稿期与送审期均校验（数据库 CHECK 同口径）。
 */
export function assertFaultCaseSubmittable(
  detail: FaultCaseSubmissionDetailWriteData,
): asserts detail is FaultCaseSubmissionDetailWriteData & {
  title: string;
  phenomenon: string;
  reproductionSteps: string;
  handlingStatus: ContentSubmissionHandlingStatus;
} {
  if (detail.title === null) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY, '送审前请填写标题', {
      field: '标题',
    });
  }
  if (detail.phenomenon === null) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY, '送审前请填写故障现象', {
      field: '故障现象',
    });
  }
  if (detail.reproductionSteps === null) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY, '送审前请填写复现步骤', {
      field: '复现步骤',
    });
  }
  if (detail.handlingStatus === null) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY, '送审前请选择处理状态', {
      field: '处理状态',
    });
  }
}

/**
 * 审核意见规范化（A-PR0 §2.3「审核」行）：退回理由必填，空白拒绝（仅在非空值上
 * 校验长度）；通过时可选（可选语义归 S5 调用方，本函数只做必填口径）。
 */
export function normalizeReviewComment(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '退回时必须填写理由');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '退回时必须填写理由');
  }
  if (normalized.length > CONTENT_SUBMISSION_REVIEW_COMMENT_MAX_LENGTH) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
      `审核意见不能超过 ${CONTENT_SUBMISSION_REVIEW_COMMENT_MAX_LENGTH} 个字符`,
      { field: '审核意见', length: normalized.length },
    );
  }
  return normalized;
}

/**
 * 通过意见规范化（A-PR0 §2.3「审核」行：通过时意见可选）：
 * null/undefined/空白 → null（不落库空字符串）；非空值 trim 后校验长度上限；
 * 非字符串类型拒绝（与退回的必填口径分开，避免可选语义被滥用）。
 */
export function normalizeOptionalReviewComment(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '审核意见格式无效');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > CONTENT_SUBMISSION_REVIEW_COMMENT_MAX_LENGTH) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
      `审核意见不能超过 ${CONTENT_SUBMISSION_REVIEW_COMMENT_MAX_LENGTH} 个字符`,
      { field: '审核意见', length: normalized.length },
    );
  }
  return normalized;
}

/**
 * 正式案例可读正文生成：单一真源已提炼至 usecases/common/fault-case-fields.contract.ts
 * （发布与案例专属更正两条链路共用，禁止各域复制实现）；此处保持既有导出兼容。
 */
export { formatFaultCaseReferenceContent } from '@src/usecases/common/fault-case-fields.contract';

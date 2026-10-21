// src/usecases/reference-document/reference-document-fields.normalize.ts

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { normalizeRequiredText } from '@core/common/input-normalize/input-normalize.policy';
import type { ReferenceDocumentEditablePatch } from './reference-document.types';

/** 字段长度上限（与 reference_document 表列长一致；docx 验收标准：标题最长 255、类型最长 100） */
export const REFERENCE_DOCUMENT_TITLE_MAX_LENGTH = 255;
export const REFERENCE_DOCUMENT_TYPE_MAX_LENGTH = 100;
/**
 * 正式案例保留文档类型（A-PR0 §4.3）：案例只能由投稿审核发布（S5）或专属更正（S6）
 * 管理；管理员普通创建/上传与通用编辑均不得伪造或改造本类型。
 */
export const REFERENCE_DOCUMENT_FAULT_CASE_TYPE = 'FAULT_CASE';
/** 文档说明上限（DB 为 TEXT，应用层给合理上限防滥用） */
export const REFERENCE_DOCUMENT_DESCRIPTION_MAX_LENGTH = 2000;
/** 文本内容上限（DB 为 LONGTEXT，应用层给合理上限防滥用与超大 payload） */
export const REFERENCE_DOCUMENT_CONTENT_MAX_LENGTH = 200_000;

/** 标题规范化与长度校验（必填） */
export function normalizeTitle(value: unknown): string {
  const normalized = normalizeRequiredText(value, { fieldName: '标题' });
  if (normalized.length > REFERENCE_DOCUMENT_TITLE_MAX_LENGTH) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      `标题不能超过 ${REFERENCE_DOCUMENT_TITLE_MAX_LENGTH} 个字符`,
      { titleLength: normalized.length },
    );
  }
  return normalized;
}

/** 文档类型规范化与长度校验（必填） */
export function normalizeDocumentType(value: unknown): string {
  const normalized = normalizeRequiredText(value, { fieldName: '文档类型' });
  if (normalized.length > REFERENCE_DOCUMENT_TYPE_MAX_LENGTH) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      `文档类型不能超过 ${REFERENCE_DOCUMENT_TYPE_MAX_LENGTH} 个字符`,
      { documentTypeLength: normalized.length },
    );
  }
  return normalized;
}

/**
 * 案例保留类型判定（A-PR0 §4.3）：大小写不敏感——数据库列排序规则为
 * utf8mb4_0900_ai_ci 且无 CHECK 兜底，应用层比较必须与投稿域归一比对口径
 * （toUpperCase）一致，否则 'fault_case' 等变体会绕过「案例类型保留」守卫。
 */
export function isFaultCaseDocumentType(value: string): boolean {
  return value.trim().toUpperCase() === REFERENCE_DOCUMENT_FAULT_CASE_TYPE;
}

/**
 * 文档说明规范化（可空）：
 * - undefined：保持原值（编辑部分提交语义）
 * - null 或空白：清空为 NULL
 * - 非空字符串：去首尾空白后校验长度
 */
export function normalizeDescription(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '文档说明必须是字符串');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > REFERENCE_DOCUMENT_DESCRIPTION_MAX_LENGTH) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      `文档说明不能超过 ${REFERENCE_DOCUMENT_DESCRIPTION_MAX_LENGTH} 个字符`,
      { descriptionLength: normalized.length },
    );
  }
  return normalized;
}

/**
 * 文本内容规范化：
 * - 创建路径（required=true）：必填（正文为 null/undefined 的双空判定由 usecase 层完成，
 *   提供了正文但空白才在此拒绝）
 * - 编辑路径（required=false）：undefined 保持原值；null/空白返回 null（清空），
 *   是否允许清空由 usecase 的「正文/存储引用双空」防御判定（文件资料允许正文为空）
 * - 超长拒绝
 */
export function normalizeContentText(value: unknown, required: true): string;
export function normalizeContentText(
  value: string | null | undefined,
  required: false,
): string | null | undefined;
export function normalizeContentText(value: unknown, required: boolean): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    if (required) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '文本内容不能为空（正文与文件至少提供一个）',
      );
    }

    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    if (required) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '文本内容不能为空（正文与文件至少提供一个）',
      );
    }

    return null;
  }
  const normalized = value.trim();
  if (normalized.length > REFERENCE_DOCUMENT_CONTENT_MAX_LENGTH) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      `文本内容不能超过 ${REFERENCE_DOCUMENT_CONTENT_MAX_LENGTH} 个字符`,
      { contentTextLength: normalized.length },
    );
  }
  return normalized;
}

/**
 * 列表字符串筛选词规范化（可选）：去首尾空白，空白视为未提供该筛选。
 * 与前端 adapter「空白搜索词视为无筛选」口径一致，防止直调空白词
 * 以字面量进入 LIKE / 等值匹配，命中意外结果集。
 */
export function normalizeOptionalFilterText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 编辑补丁整段校验：至少要求一个可编辑字段出现（undefined 全保持原值时拒绝空补丁），
 * 防止「看起来提交了编辑实际上什么都没改」的无效写入
 */
export function assertPatchHasEditableField(patch: ReferenceDocumentEditablePatch): void {
  const hasField = Object.values(patch).some((value) => value !== undefined);
  if (!hasField) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '编辑内容不能为空');
  }
}

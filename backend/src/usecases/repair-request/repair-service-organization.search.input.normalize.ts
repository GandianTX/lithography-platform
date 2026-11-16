// src/usecases/repair-request/repair-service-organization.search.input.normalize.ts

import { DomainError, INPUT_NORMALIZE_ERROR } from '@core/common/errors';

/** 名称关键字上限：选择器检索，超长在输入层拒绝而非静默截断 */
export const SERVICE_ORGANIZATION_KEYWORD_MAX_LENGTH = 100;

/**
 * 报修服务公司检索关键字归一：去首尾空白；空白视为未填；非字符串或超长拒绝。
 *
 * 归一逻辑必须留在 normalize 层（仓库 `lint:usecase-normalize-guard` 约束），
 * 用例文件只消费归一结果。
 */
export function normalizeServiceOrganizationKeyword(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '公司名称 必须是字符串', {
      field: 'keyword',
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > SERVICE_ORGANIZATION_KEYWORD_MAX_LENGTH) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `公司名称最多 ${SERVICE_ORGANIZATION_KEYWORD_MAX_LENGTH} 个字符`,
      { field: 'keyword' },
    );
  }
  return trimmed;
}

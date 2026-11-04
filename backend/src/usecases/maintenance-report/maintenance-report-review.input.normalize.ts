// src/usecases/maintenance-report/maintenance-report-review.input.normalize.ts
// 审核输入归一化：退回原因文本、发布附件 ID 去重与合法性。
// 按项目约定，trim / Set 等输入收敛只允许出现在 *.input.normalize.ts。

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';

export const REVIEW_COMMENT_MAX = 2000;

/** 审核意见：空白归一为 null，超长拒绝；不改变已裁剪内容 */
export function normalizeReviewComment(comment: string | null | undefined): string | null {
  if (comment === null || comment === undefined) return null;
  const trimmed = comment.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > REVIEW_COMMENT_MAX) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      `审核意见不能超过 ${REVIEW_COMMENT_MAX} 个字符`,
      { length: trimmed.length },
    );
  }
  return trimmed;
}

/** 退回必须给出退回原因 */
export function requireReviewComment(comment: string | null | undefined): string {
  const normalized = normalizeReviewComment(comment);
  if (normalized === null) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '退回时必须填写退回原因');
  }
  return normalized;
}

/** 发布附件 ID：去重并校验为正整数，保持调用方顺序 */
export function normalizePublishAttachmentIds(ids: number[] | undefined): number[] {
  if (ids === undefined) return [];
  const unique = Array.from(new Set<number>(ids));
  for (const id of unique) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '发布附件 ID 无效', {
        attachmentId: id,
      });
    }
  }
  return unique;
}

// src/usecases/maintenance-report/reorder-maintenance-report-attachments.input.normalize.ts
// 附件重排输入校验：请求必须是当前集合的完整排列（不允许多、少、重复或不存在的 ID）。
// 按项目约定，Set 等输入收敛只允许出现在 *.input.normalize.ts。

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';

export function assertExactPermutation(
  requested: readonly number[],
  current: readonly number[],
): void {
  const requestedSet = new Set<number>(requested);
  if (requestedSet.size !== requested.length) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '附件排序包含重复 ID');
  }
  const currentSet = new Set<number>(current);
  const unknown = requested.filter((id) => !currentSet.has(id));
  if (unknown.length > 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND, '附件不存在或已移除', {
      attachmentIds: unknown,
    });
  }
  const missing = current.filter((id) => !requestedSet.has(id));
  if (missing.length > 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '附件排序必须包含当前全部附件', {
      attachmentIds: missing,
    });
  }
}

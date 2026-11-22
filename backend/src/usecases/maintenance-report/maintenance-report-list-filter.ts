// src/usecases/maintenance-report/maintenance-report-list-filter.ts
// 本人记录列表筛选归一化：可选值域白名单，非法值直接拒绝（不静默丢弃客户端筛选）。

import { MaintenanceReportSourceType } from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { normalizeOptionalText } from '@core/common/normalize/normalize.helper';
import type { MaintenanceReportListFilter } from '@src/modules/lithography/maintenance-report.types';

const RECORD_KINDS: readonly NonNullable<MaintenanceReportListFilter['recordKind']>[] = [
  'ALL',
  'DRAFT',
  'FORMAL',
];

/** 标题关键词上限：与 GraphQL 输入 @MaxLength 同口径，超长拒绝而非静默截断 */
const TITLE_KEYWORD_MAX_LENGTH = 100;

const SOURCE_TYPES: readonly string[] = Object.values(MaintenanceReportSourceType);

export function normalizeListFilter(
  filter: { sourceType?: string; recordKind?: string; titleKeyword?: string } | undefined,
): MaintenanceReportListFilter {
  if (filter === undefined) {
    return {};
  }
  const normalized: MaintenanceReportListFilter = {};

  if (filter.sourceType !== undefined) {
    if (!SOURCE_TYPES.includes(filter.sourceType)) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '报告来源类型无效', {
        sourceType: filter.sourceType,
      });
    }
    normalized.sourceType = filter.sourceType;
  }

  if (filter.recordKind !== undefined) {
    const recordKind = filter.recordKind;
    if (
      !RECORD_KINDS.includes(recordKind as NonNullable<MaintenanceReportListFilter['recordKind']>)
    ) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '记录状态筛选无效', {
        recordKind,
      });
    }
    normalized.recordKind = recordKind as NonNullable<MaintenanceReportListFilter['recordKind']>;
  }

  if (filter.titleKeyword !== undefined) {
    const titleKeyword = normalizeOptionalText(filter.titleKeyword);
    // 空白关键词等价于未提供（不生成恒真 LIKE 条件）
    if (titleKeyword === null) {
      // 空白：保持未提供语义
    } else if (titleKeyword.length > TITLE_KEYWORD_MAX_LENGTH) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '标题关键词过长', {
        titleKeywordLength: titleKeyword.length,
      });
    } else {
      normalized.titleKeyword = titleKeyword;
    }
  }

  return normalized;
}

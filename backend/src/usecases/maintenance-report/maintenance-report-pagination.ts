// src/usecases/maintenance-report/maintenance-report-pagination.ts
// 列表分页统一归一化：默认第 1 页、每页 20，上限 100，避免无界读取。

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportPagination } from './maintenance-report-command.types';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function normalizePagination(
  pagination: MaintenanceReportPagination | undefined,
): Required<MaintenanceReportPagination> {
  const page = pagination?.page ?? DEFAULT_PAGE;
  const pageSize = pagination?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '页码必须为正整数', { page });
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      `每页条数必须在 1-${MAX_PAGE_SIZE} 之间`,
      { pageSize },
    );
  }
  return { page, pageSize, withTotal: pagination?.withTotal ?? true };
}

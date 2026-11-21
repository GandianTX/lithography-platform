// src/features/maintenance-report/ui/report-status-label.ts
//
// 报告状态的唯一展示映射：列表与编辑页共用，不重复维护文案分支。

import type { MessageKey } from '@/shared/i18n';

import type { MaintenanceReportStatus } from '../infrastructure/maintenance-report.types';

export function reportStatusLabelKey(status: MaintenanceReportStatus): MessageKey {
  if (status === 'DRAFT') return 'maintenanceReport.status.DRAFT';
  if (status === 'SUBMITTED') return 'maintenanceReport.status.SUBMITTED';
  if (status === 'RETURNED') return 'maintenanceReport.status.RETURNED';
  if (status === 'APPROVED') return 'maintenanceReport.status.APPROVED';
  return 'maintenanceReport.status.PENDING_REVIEW';
}

// src/usecases/maintenance-report/maintenance-report-review.helpers.ts
// 审核（退回/通过）共用前置：同组织管理员 → 报告行锁 → PENDING_REVIEW → 当前冻结版本。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { MaintenanceReportStatus } from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  MaintenanceReportSnapshot,
  MaintenanceReportVersionSnapshot,
} from '@src/modules/lithography/maintenance-report.types';
import { lockReportForReview } from './maintenance-report-write-guard';

// 审核输入归一化统一由 input.normalize 文件承载；此处仅对外保持既有导入路径
export {
  normalizeReviewComment,
  requireReviewComment,
} from './maintenance-report-review.input.normalize';

export type ReviewableReport = {
  report: MaintenanceReportSnapshot;
  version: MaintenanceReportVersionSnapshot;
  organizationId: number;
};

export async function lockReviewableReport(params: {
  maintenanceReportService: MaintenanceReportService;
  maintenanceReportQueryService: MaintenanceReportQueryService;
  organizationContextService: TrustedOrganizationContextQueryService;
  accountId: number;
  reportId: number;
  transactionContext: PersistenceTransactionContext;
}): Promise<ReviewableReport> {
  const lock = await lockReportForReview({
    maintenanceReportService: params.maintenanceReportService,
    organizationContextService: params.organizationContextService,
    accountId: params.accountId,
    reportId: params.reportId,
    transactionContext: params.transactionContext,
  });
  if (lock.report.status !== MaintenanceReportStatus.PENDING_REVIEW) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.STATE_NOT_REVIEWABLE,
      '当前状态下的维修报告不可审核',
      { reportId: params.reportId, status: lock.report.status },
    );
  }
  const version = await params.maintenanceReportQueryService.readVersion(
    params.reportId,
    lock.report.currentVersionNo,
    params.transactionContext,
  );
  if (!version) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.REVIEW_FAILED, '待审核版本的冻结快照缺失', {
      reportId: params.reportId,
      versionNo: lock.report.currentVersionNo,
    });
  }
  return { report: lock.report, version, organizationId: lock.organizationId };
}

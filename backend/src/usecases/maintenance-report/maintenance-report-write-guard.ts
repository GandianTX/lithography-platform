// src/usecases/maintenance-report/maintenance-report-write-guard.ts
// 维修报告状态敏感写动作的统一入口守卫：报告行锁 → 组织解析 → 归属裁决 → 可编辑状态裁决。
//
// 行锁必须先于任何普通读执行：MySQL REPEATABLE READ 的读视图由事务内第一次普通读建立，
// 若先解析组织（普通读）再取行锁，加锁后的普通读仍返回旧快照，会读到过期草稿/附件/版本。
// 锁定读始终返回最新已提交版本，因此以行锁作为事务内第一次读取即可获得锁后的稳定视图。
//
// 不存在 / 他人报告 / 跨组织统一 NOT_FOUND（不泄露存在性）；
// 组织与账号一律取自可信来源，不接受客户端自报归属。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { MaintenanceReportSnapshot } from '@src/modules/lithography/maintenance-report.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { MaintenanceReportStatus } from '@app-types/models/maintenance-report.types';

const EDITABLE_STATUSES: readonly MaintenanceReportStatus[] = [
  MaintenanceReportStatus.DRAFT,
  MaintenanceReportStatus.RETURNED,
];

export type MaintenanceReportLockContext = {
  report: MaintenanceReportSnapshot;
  organizationId: number;
};

/**
 * 作者写动作守卫（草稿更新、提交、附件增删排序）：
 * 仅本组织、报告负责人的 DRAFT/RETURNED 报告可写。
 */
export async function lockEditableReportForAuthor(params: {
  maintenanceReportService: MaintenanceReportService;
  organizationContextService: TrustedOrganizationContextQueryService;
  accountId: number;
  reportId: number;
  transactionContext: PersistenceTransactionContext;
}): Promise<MaintenanceReportLockContext> {
  const lock = await lockOwnedReport(params);
  if (!EDITABLE_STATUSES.includes(lock.report.status)) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.STATE_NOT_EDITABLE,
      '当前状态下的维修报告不可编辑',
      { reportId: params.reportId, status: lock.report.status },
    );
  }
  return lock;
}

/**
 * 作者只读入口守卫（本人详情）：同组织且报告负责人本人。
 */
export async function lockOwnedReport(params: {
  maintenanceReportService: MaintenanceReportService;
  organizationContextService: TrustedOrganizationContextQueryService;
  accountId: number;
  reportId: number;
  transactionContext: PersistenceTransactionContext;
}): Promise<MaintenanceReportLockContext> {
  const report = await params.maintenanceReportService.lockReportForWrite(
    params.reportId,
    params.transactionContext,
  );
  if (report === null) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
      reportId: params.reportId,
    });
  }
  const organizationId = await resolveAuthorOrganization(params);
  if (
    report.maintenanceEngineerAccountId !== params.accountId ||
    report.ownerOrganizationId !== organizationId
  ) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
      reportId: params.reportId,
    });
  }
  return { report, organizationId };
}

/**
 * 审核入口守卫：同组织管理员；状态裁决由调用方在行锁内继续执行。
 */
export async function lockReportForReview(params: {
  maintenanceReportService: MaintenanceReportService;
  organizationContextService: TrustedOrganizationContextQueryService;
  accountId: number;
  reportId: number;
  transactionContext: PersistenceTransactionContext;
}): Promise<MaintenanceReportLockContext> {
  const report = await params.maintenanceReportService.lockReportForWrite(
    params.reportId,
    params.transactionContext,
  );
  if (report === null) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
      reportId: params.reportId,
    });
  }
  const organizationId = await resolveAuthorOrganization(params);
  if (report.ownerOrganizationId !== organizationId) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
      reportId: params.reportId,
    });
  }
  return { report, organizationId };
}

async function resolveAuthorOrganization(params: {
  organizationContextService: TrustedOrganizationContextQueryService;
  accountId: number;
  transactionContext: PersistenceTransactionContext;
}): Promise<number> {
  const membership = await params.organizationContextService.resolveForAccount({
    accountId: params.accountId,
    transactionContext: params.transactionContext,
  });
  return membership.organizationId;
}

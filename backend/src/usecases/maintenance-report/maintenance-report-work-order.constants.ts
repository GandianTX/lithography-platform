// src/usecases/maintenance-report/maintenance-report-work-order.constants.ts
// 工单维修总结入口的稳定事实口径：只有本人接单且已结单的工单可以填写/续填总结。

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import type { RepairRequestWriteContext } from '@src/modules/lithography/maintenance-report.types';

/** 工单结单状态值（与 repair_request.closure_status 的 CLOSED 一致） */
export const WORK_ORDER_CLOSED_STATUS = 'CLOSED';

/** 工单是否处于可填写维修总结的结单态 */
export function isWorkOrderClosed(closureStatus: string | null): boolean {
  return closureStatus === WORK_ORDER_CLOSED_STATUS;
}

/**
 * 工单总结前置事实：工单存在、未撤回、已接单且已结单、接单人为本组织本人。
 * 建稿与正式提交共用同一裁决，避免两条入口各自漂移。
 */
export function assertWorkOrderSummaryPreconditions(params: {
  request: RepairRequestWriteContext | null;
  repairRequestId: number;
  accountId: number;
  organizationId: number;
}): void {
  const { request, repairRequestId, accountId, organizationId } = params;
  if (request === null || request.deprecated) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '工单不存在或已撤回', {
      repairRequestId,
    });
  }
  if (!request.isAccepted || request.acceptedEngineerAccountId === null) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.WORK_ORDER_NOT_ACCEPTED,
      '工单尚未由工程师接单，不能创建维修总结',
      { repairRequestId },
    );
  }
  if (!isWorkOrderClosed(request.closureStatus)) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.WORK_ORDER_NOT_CLOSED,
      '工单尚未结单，不能创建维修总结',
      { repairRequestId },
    );
  }
  if (request.acceptedEngineerAccountId !== accountId) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH,
      '工单不存在或不可访问',
      { repairRequestId },
    );
  }
  if (request.ownerOrganizationId !== organizationId) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH,
      '工单不存在或不可访问',
      { repairRequestId },
    );
  }
}

// src/usecases/maintenance-report/record-repair-request-handling-result.usecase.ts

import {
  DomainError,
  MAINTENANCE_REPORT_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors/domain-error';
import { RepairRequestHandlingStatus } from '@app-types/models/repair-request.types';
import {
  isTerminalHandlingStatus,
  resolveRepairRequestHandlingStatus,
} from '@core/repair-request/policy/repair-request-handling.policy';
import { Inject, Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  RecordRepairRequestHandlingCommand,
  RecordRepairRequestHandlingResult,
} from './maintenance-report-command.types';
import { assertMaintenanceReportAuthorRole } from './maintenance-report-roles';
import { normalizeHandlingResult } from './maintenance-report.input.normalize';

/**
 * 接单工程师回写工单维修处理结果。
 *
 * - 仅接单工程师本人、同组织、未撤回且已接单的工单可写；
 * - 五类结果映射 COMPLETED / IN_PROGRESS / UNRESOLVED 三态；
 * - 终结时间由服务端在终结结果时写入，进行中保持 NULL；
 * - 已终结（COMPLETED / UNRESOLVED）的事实不可改写，重复/变更写入一律冲突；
 * - 工单行锁与归属校验同事务，跨组织/他人工单一律 NOT_FOUND。
 */
@Injectable()
export class RecordRepairRequestHandlingResultUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: RecordRepairRequestHandlingCommand,
  ): Promise<RecordRepairRequestHandlingResult> {
    assertMaintenanceReportAuthorRole(command.session);
    const handlingResult = normalizeHandlingResult(command.handlingResult);
    if (!Number.isInteger(command.repairRequestId) || command.repairRequestId <= 0) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '工单 ID 无效', {
        repairRequestId: command.repairRequestId,
      });
    }
    return this.transactionRunner.run(async (transactionContext) => {
      // 行锁必须先于任何普通读：先锁工单，再解析组织，锁后的普通读才是最新已提交视图
      const request = await this.maintenanceReportService.readRepairRequestWriteContext(
        command.repairRequestId,
        transactionContext,
      );
      const membership = await this.organizationContextService.resolveForAccount({
        accountId: command.session.accountId,
        transactionContext,
      });
      if (
        request === null ||
        request.deprecated ||
        !request.isAccepted ||
        request.acceptedEngineerAccountId !== command.session.accountId ||
        request.ownerOrganizationId !== membership.organizationId
      ) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.NOT_FOUND,
          '工单不存在或不可由当前账号回写处理结果',
          { repairRequestId: command.repairRequestId },
        );
      }
      const handlingStatus = resolveRepairRequestHandlingStatus(handlingResult);
      // 终结事实不可改写：再次回写（含相同值）会让“终结时间/终结人”与已发布事实漂移
      if (
        request.handlingStatus === RepairRequestHandlingStatus.COMPLETED ||
        request.handlingStatus === RepairRequestHandlingStatus.UNRESOLVED
      ) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.HANDLING_STATE_CONFLICT,
          '工单处理结果已终结，不可改写',
          { repairRequestId: command.repairRequestId, handlingStatus: request.handlingStatus },
        );
      }
      const recordedAt = new Date();
      const endedAt = isTerminalHandlingStatus(handlingStatus) ? recordedAt : null;
      await this.maintenanceReportService.updateRepairRequestHandling(
        command.repairRequestId,
        {
          handlingResult,
          handlingStatus,
          handlingRecordedAt: recordedAt,
          handlingRecordedByAccountId: command.session.accountId,
          handlingEndedAt: endedAt,
        },
        {
          ownerOrganizationId: membership.organizationId,
          acceptedEngineerAccountId: command.session.accountId,
        },
        transactionContext,
      );
      return {
        repairRequestId: command.repairRequestId,
        handlingResult,
        handlingStatus,
        handlingRecordedAt: recordedAt,
        handlingEndedAt: endedAt,
      };
    });
  }
}

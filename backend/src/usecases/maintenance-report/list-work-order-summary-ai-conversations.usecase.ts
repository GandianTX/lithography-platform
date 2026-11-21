// src/usecases/maintenance-report/list-work-order-summary-ai-conversations.usecase.ts

import { Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

import type { ListWorkOrderSummaryAiConversationsCommand } from './maintenance-report-command.types';
import {
  listWorkOrderSummaryAiConversations,
  type WorkOrderSummaryAiConversationCandidate,
} from './maintenance-report-ai-evaluation.helpers';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { assertWorkOrderSummaryPreconditions } from './maintenance-report-work-order.constants';

/**
 * 工单总结 AI 评价候选会话读取（任务 06 适配任务 05 真实读侧）。
 *
 * - 只在本人接单且已结单的工单上读取，工单前置与建稿/提交同一裁决；
 * - 会话可见性、跨公司隔离由任务 05 查询服务裁决，本用例不复制其规则；
 * - 只返回所选版本内已有有效回复的会话；返回空列表表示「确认没有符合条件的会话」，
 *   读取失败会抛错，调用方不得把失败当成无会话；
 * - 任务 03 客户首析存放在 intake_analysis_attempt，不在此表，不会被当成评价来源。
 */
@Injectable()
export class ListWorkOrderSummaryAiConversationsUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly aiConversationQueryService: AiConversationQueryService,
  ) {}

  async execute(
    command: ListWorkOrderSummaryAiConversationsCommand,
  ): Promise<WorkOrderSummaryAiConversationCandidate[]> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.repairRequestId);

    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    const workOrder = await this.maintenanceReportService.findRepairRequestWriteContext(
      command.repairRequestId,
    );
    assertWorkOrderSummaryPreconditions({
      request: workOrder,
      repairRequestId: command.repairRequestId,
      accountId: command.session.accountId,
      organizationId: membership.organizationId,
    });

    const candidates = await listWorkOrderSummaryAiConversations({
      viewerAccountId: command.session.accountId,
      viewerOrganizationId: membership.organizationId,
      repairRequestId: command.repairRequestId,
      aiConversationQueryService: this.aiConversationQueryService,
    });
    return candidates;
  }
}

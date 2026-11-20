// src/usecases/repair-request/get-my-repair-request-detail.usecase.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { resolveIntakeAnalysisRetryDecision } from '@core/repair-request/policy/intake-analysis-retry.policy';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AsyncTaskRecordQueryService } from '@src/modules/async-task-record/queries/async-task-record.query.service';
import {
  RepairRequestDetailQueryResult,
  RepairRequestDetailView,
  RepairRequestIntakeAnalysisCustomerView,
} from '@src/modules/lithography/lithography.types';
import { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import { enrichRepairRequestDetailNicknames } from './enrich-repair-request-nicknames';
import { readIntakeAnalysisLedgerIntentPresent } from './intake-analysis-retry-ledger';

/**
 * 客户查询自己的维修申请详情用例（客户详情入口，含回复时间线）
 *
 * - 数据范围按客户身份判定（仅本人且未删除）；细粒度权限在 QueryService 内
 * - 回复中的工程师昵称跨域经账号域 QueryService 实时关联（不存快照）
 * - 首析展示状态与自助重试资格由服务端判定：QueryService 提供持久化事实，
 *   本用例补投递账本事实后走 core 策略，前端不再自行组合 FAILED + generation
 * - 账号仅取自 JWT/Session；角色准入（CUSTOMER，SUPER_ADMIN 按继承规则同准入）
 *   由 adapter 层守卫决策
 */
@Injectable()
export class GetMyRepairRequestDetailUsecase {
  constructor(
    private readonly repairRequestQueryService: RepairRequestQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly asyncTaskRecordQueryService: AsyncTaskRecordQueryService,
  ) {}

  async execute(params: {
    requestId: number;
    session: UsecaseSession;
  }): Promise<RepairRequestDetailView> {
    const result = await this.repairRequestQueryService.findDetail({
      requestId: params.requestId,
      session: params.session,
      scope: 'CUSTOMER',
    });
    const intakeAnalysis = await this.resolveIntakeAnalysisView(result, params.session);
    return enrichRepairRequestDetailNicknames(this.accountQueryService, result, intakeAnalysis);
  }

  /**
   * 首析展示状态与重试资格装配（失败关闭）。
   * 账本事实按当前代次的确定性 jobId 跨模块只读核对；读取失败视为不可信。
   */
  private async resolveIntakeAnalysisView(
    result: RepairRequestDetailQueryResult,
    session: UsecaseSession,
  ): Promise<RepairRequestIntakeAnalysisCustomerView | null> {
    const base = result.intakeAnalysis;
    const facts = result.intakeAnalysisRetryFacts;
    if (!base || !facts) {
      return null;
    }
    const ledgerIntentPresent = await readIntakeAnalysisLedgerIntentPresent(
      this.asyncTaskRecordQueryService,
      { intakeId: facts.intakeId, generationNo: facts.generation },
    );
    const decision = resolveIntakeAnalysisRetryDecision({
      requestId: facts.requestId,
      viewerCustomerAccountId: session.accountId,
      requestCustomerAccountId: facts.requestCustomerAccountId,
      intakeExists: facts.intakeExists,
      intakeCustomerAccountId: facts.intakeCustomerAccountId,
      intakeDeleted: facts.intakeDeleted,
      convertedRequestId: facts.convertedRequestId,
      generation: facts.generation,
      status: facts.status,
      attemptGenerationNo: facts.attemptGenerationNo,
      attemptStatus: facts.attemptStatus,
      attemptFailureReasonRecorded: facts.attemptFailureReasonRecorded,
      ledgerIntentPresent,
    });
    return {
      ...base,
      displayState: decision.displayState,
      retryEligibility: { eligible: decision.eligible, reason: decision.reason },
    };
  }
}

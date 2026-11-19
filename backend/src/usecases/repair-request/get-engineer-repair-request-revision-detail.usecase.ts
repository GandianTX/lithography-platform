// src/usecases/repair-request/get-engineer-repair-request-revision-detail.usecase.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EngineerRepairRevisionDetailView } from '@src/modules/lithography/lithography.types';
import { EngineerRepairRevisionQueryService } from '@src/modules/lithography/queries/engineer-repair-revision.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

const ENGINEER_NICKNAME_FALLBACK = '工程师';

/**
 * 接单工程师查询单个修订详情用例（只读，不含附件与管理员完整快照）。
 *
 * 读取授权在 QueryService 内完成；跨工单修订号按不存在处理。
 */
@Injectable()
export class GetEngineerRepairRequestRevisionDetailUsecase {
  constructor(
    private readonly revisionQueryService: EngineerRepairRevisionQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    requestId: number;
    revisionNo: number;
    session: UsecaseSession;
  }): Promise<EngineerRepairRevisionDetailView> {
    const organizationFact = await this.organizationContextQueryService.tryResolveForAccount({
      accountId: params.session.accountId,
    });
    const result = await this.revisionQueryService.findRevisionForAcceptingEngineer({
      requestId: params.requestId,
      revisionNo: params.revisionNo,
      session: params.session,
      viewerOrganizationId: organizationFact?.organizationId ?? null,
    });
    const nicknames = await this.accountQueryService.findNicknamesByAccountIds([
      result.actorAccountId,
    ]);
    return {
      requestId: result.requestId,
      revisionNo: result.revisionNo,
      previousVersion: result.previousVersion,
      reason: result.reason,
      createdAt: result.createdAt,
      hasComparableSnapshot: result.hasComparableSnapshot,
      hasVisibleMaintenanceChange: result.hasVisibleMaintenanceChange,
      compareUnavailableReason: result.compareUnavailableReason,
      before: result.before,
      after: result.after,
      actorNickname: nicknames.get(result.actorAccountId) ?? ENGINEER_NICKNAME_FALLBACK,
    };
  }
}

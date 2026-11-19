// src/usecases/repair-request/get-engineer-repair-request-revision-history.usecase.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import {
  EngineerRepairRevisionHistoryItemView,
  EngineerRepairRevisionHistoryItemQueryResult,
} from '@src/modules/lithography/lithography.types';
import { EngineerRepairRevisionQueryService } from '@src/modules/lithography/queries/engineer-repair-revision.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

const ENGINEER_NICKNAME_FALLBACK = '工程师';

/**
 * 接单工程师查询工单修订历史用例。
 *
 * 读取授权在 QueryService 内完成（接单人 + 可信服务厂家 + 未删除）；
 * 修订人昵称跨域经账号域批量读取，账号 ID 不进入对外视图。
 */
@Injectable()
export class GetEngineerRepairRequestRevisionHistoryUsecase {
  constructor(
    private readonly revisionQueryService: EngineerRepairRevisionQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    requestId: number;
    session: UsecaseSession;
  }): Promise<EngineerRepairRevisionHistoryItemView[]> {
    const organizationFact = await this.organizationContextQueryService.tryResolveForAccount({
      accountId: params.session.accountId,
    });
    const results = await this.revisionQueryService.listForAcceptingEngineer({
      requestId: params.requestId,
      session: params.session,
      viewerOrganizationId: organizationFact?.organizationId ?? null,
    });
    if (results.length === 0) {
      return [];
    }
    const nicknames = await this.accountQueryService.findNicknamesByAccountIds(
      results.map((item) => item.actorAccountId),
    );
    return results.map((item) => toView(item, nicknames.get(item.actorAccountId)));
  }
}

function toView(
  item: EngineerRepairRevisionHistoryItemQueryResult,
  nickname: string | undefined,
): EngineerRepairRevisionHistoryItemView {
  return {
    revisionNo: item.revisionNo,
    previousVersion: item.previousVersion,
    reason: item.reason,
    createdAt: item.createdAt,
    hasComparableSnapshot: item.hasComparableSnapshot,
    hasVisibleMaintenanceChange: item.hasVisibleMaintenanceChange,
    compareUnavailableReason: item.compareUnavailableReason,
    actorNickname: nickname ?? ENGINEER_NICKNAME_FALLBACK,
  };
}

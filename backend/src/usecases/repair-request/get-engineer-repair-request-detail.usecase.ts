// src/usecases/repair-request/get-engineer-repair-request-detail.usecase.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { RepairRequestEngineerDetailView } from '@src/modules/lithography/lithography.types';
import { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { enrichEngineerRepairRequestDetail } from './enrich-repair-request-nicknames';

/**
 * 工程师查询维修申请详情用例（工程师详情入口，含回复时间线）
 *
 * - 数据范围按工程师身份判定：任意未删除申请可读（AVAILABLE / MINE / TAKEN_BY_OTHER）；
 *   细粒度权限在 QueryService 内，写侧权限仍由各写用例独立失败关闭
 * - 回复工程师昵称、客户/接单工程师展示资料跨域经账号域 QueryService 实时关联（不存快照），
 *   并计算当前会话视角状态；归属类账号 ID 不进入对外视图
 * - 账号仅取自 JWT/Session；角色准入（ENGINEER，SUPER_ADMIN 按继承规则同准入）
 *   由 adapter 层守卫决策
 */
@Injectable()
export class GetEngineerRepairRequestDetailUsecase {
  constructor(
    private readonly repairRequestQueryService: RepairRequestQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    requestId: number;
    session: UsecaseSession;
  }): Promise<RepairRequestEngineerDetailView> {
    const organizationFact = await this.organizationContextQueryService.tryResolveForAccount({
      accountId: params.session.accountId,
    });
    const result = await this.repairRequestQueryService.findDetail({
      requestId: params.requestId,
      session: params.session,
      scope: 'ENGINEER',
      viewerOrganizationId: organizationFact?.organizationId ?? null,
    });
    return enrichEngineerRepairRequestDetail(
      this.accountQueryService,
      result,
      params.session.accountId,
    );
  }
}

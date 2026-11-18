// src/usecases/organization/get-admin-company-admin-binding.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { resolveLevelOneAdminScope } from '@core/account/policy/admin-scope.policy';
import { DomainError, ORGANIZATION_MANAGEMENT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { normalizeOrganizationId } from './admin-organization.input.normalize';
import {
  assembleAdminBindingFacts,
  collectActiveMembershipAccountIds,
  toCompanyAdminBindingView,
} from './company-admin-binding.support';
import type { CompanyAdminBindingView } from './company-admin-binding.types';

export type GetAdminCompanyAdminBindingCommand = {
  readonly session: UsecaseSession;
  readonly organizationId: unknown;
};

/**
 * 一级管理员按公司 ID 查询当前二级管理员绑定（S3）。
 *
 * 授权：仅一级管理员。二级管理员即使知道公司 ID 也不得查询绑定事实。
 *
 * 输出口径：
 * - 公司不存在 → `TARGET_NOT_FOUND`（对外 `NOT_FOUND`），与档案详情一致；
 * - 非受管公司 → `UNCONFIGURED` + `isManagedCompany=false` 安全状态；
 * - 已绑定但账号停用 → `BOUND` + `accountDisabled=true`；
 * - 冲突 / 公司停用 → 只给状态、原因与脱敏候选，不输出完整登录名或凭据。
 *
 * 本用例只读：不开启事务、不锁行、不写审计。
 */
@Injectable()
export class GetAdminCompanyAdminBindingUsecase {
  constructor(
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
  ) {}

  async execute(command: GetAdminCompanyAdminBindingCommand): Promise<CompanyAdminBindingView> {
    resolveLevelOneAdminScope(command.session, '查看二级管理员绑定');

    const organizationId = normalizeOrganizationId(command.organizationId);
    const organization = await this.organizationQueryService.findAdminOrganizationView({
      organizationId,
    });
    if (organization === null) {
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.TARGET_NOT_FOUND,
        '公司不存在或已被删除',
        { organizationId },
      );
    }

    // 非受管公司不是绑定判定对象：策略会抛错，这里直接返回安全状态。
    if (!organization.isManagedCompany) {
      return {
        organizationId: organization.id,
        organizationCode: organization.organizationCode,
        companyName: organization.name,
        isManagedCompany: false,
        companyStatus: organization.status,
        status: 'UNCONFIGURED',
        reason: null,
        boundAccountId: null,
        boundLoginNameMasked: null,
        candidateCount: 0,
        accountDisabled: false,
      };
    }

    const memberships = await this.organizationMembershipQueryService.listMembershipsByOrganization(
      {
        organizationId,
      },
    );
    const accountFacts = await this.adminUserQueryService.findAdminBindingCandidateFacts({
      accountIds: collectActiveMembershipAccountIds(memberships),
    });

    const facts = assembleAdminBindingFacts({
      organizationId: organization.id,
      organizationCode: organization.organizationCode,
      companyStatus: organization.status,
      isManagedCompany: organization.isManagedCompany,
      memberships,
      accountFacts,
    });

    return toCompanyAdminBindingView(organization, facts);
  }
}

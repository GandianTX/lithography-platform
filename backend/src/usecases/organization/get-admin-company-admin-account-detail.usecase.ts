// src/usecases/organization/get-admin-company-admin-account-detail.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { evaluateAdminBinding } from '@core/account/policy/admin-binding.policy';
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
} from './company-admin-binding.support';
import type { CompanyAdminAccountDetailView } from './company-admin-binding.types';

export type GetAdminCompanyAdminAccountDetailCommand = {
  readonly session: UsecaseSession;
  readonly organizationId: unknown;
};

/**
 * 一级管理员按公司 ID 读取二级管理员账号详情（D 组按需窄查询）。
 *
 * 与绑定摘要（`adminCompanyAdminBinding`）分开：
 * - 只有 `BOUND` 且唯一合法绑定时返回完整登录名、昵称与 `mustChangePassword`；
 * - 冲突 / 未绑 / 公司停用只返回状态、原因与候选数量，账号字段一律 null；
 * - 非受管公司返回 `UNCONFIGURED` 安全态。
 *
 * 本用例只读：不开启事务、不锁行、不写审计、不输出任何凭据。
 * 补发资格仍由 `reissue-level-two-credential` 在锁内独立复核。
 */
@Injectable()
export class GetAdminCompanyAdminAccountDetailUsecase {
  constructor(
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
  ) {}

  async execute(
    command: GetAdminCompanyAdminAccountDetailCommand,
  ): Promise<CompanyAdminAccountDetailView> {
    resolveLevelOneAdminScope(command.session, '查看二级管理员账号');

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

    if (!organization.isManagedCompany) {
      return {
        organizationId: organization.id,
        organizationCode: organization.organizationCode,
        companyName: organization.name,
        isManagedCompany: false,
        companyStatus: organization.status,
        status: 'UNCONFIGURED',
        reason: null,
        accountId: null,
        loginName: null,
        nickname: null,
        mustChangePassword: null,
        accountDisabled: false,
        candidateCount: 0,
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
    const evaluation = evaluateAdminBinding(facts);

    const base = {
      organizationId: organization.id,
      organizationCode: organization.organizationCode,
      companyName: organization.name,
      isManagedCompany: organization.isManagedCompany,
      companyStatus: organization.status,
      status: evaluation.status,
      reason: evaluation.reason,
      accountDisabled: evaluation.accountDisabled,
      candidateCount: evaluation.candidateCount,
    } as const;

    if (evaluation.status !== 'BOUND' || evaluation.boundAccountId === null) {
      return {
        ...base,
        accountId: null,
        loginName: null,
        nickname: null,
        mustChangePassword: null,
      };
    }

    const boundFacts = accountFacts.get(evaluation.boundAccountId);
    const opening = await this.adminUserQueryService.findAccountOpeningStatus({
      accountId: evaluation.boundAccountId,
    });

    return {
      ...base,
      accountId: evaluation.boundAccountId,
      loginName: evaluation.boundLoginName,
      nickname: boundFacts?.nickname ?? null,
      mustChangePassword: opening?.mustChangePassword ?? null,
    };
  }
}

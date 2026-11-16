// src/usecases/organization/get-admin-organization-detail.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { resolveLevelOneAdminScope } from '@core/account/policy/admin-scope.policy';
import { DomainError, ORGANIZATION_MANAGEMENT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import { normalizeOrganizationId } from './admin-organization.input.normalize';

export type GetAdminOrganizationDetailCommand = {
  readonly session: UsecaseSession;
  readonly organizationId: unknown;
};

/**
 * 一级管理员公司档案详情（任务 08.2）。
 *
 * 授权：仅一级管理员。详情不过滤状态——停用公司仍可查看，便于编辑启用状态。
 * 目标不存在统一 `TARGET_NOT_FOUND`（对外 `NOT_FOUND`）。
 */
@Injectable()
export class GetAdminOrganizationDetailUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(command: GetAdminOrganizationDetailCommand): Promise<AdminOrganizationView> {
    resolveLevelOneAdminScope(command.session, '查看公司档案详情');

    const organizationId = normalizeOrganizationId(command.organizationId);
    const view = await this.organizationQueryService.findAdminOrganizationView({ organizationId });

    if (view === null) {
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.TARGET_NOT_FOUND,
        '公司不存在或已被删除',
        { organizationId },
      );
    }
    return view;
  }
}

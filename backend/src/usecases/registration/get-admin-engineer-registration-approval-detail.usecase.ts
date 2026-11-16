// src/usecases/registration/get-admin-engineer-registration-approval-detail.usecase.ts

import {
  ADMIN_USER_ERROR,
  DomainError,
  ENGINEER_REGISTRATION_ERROR,
  isDomainError,
} from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type {
  AdminEngineerRegistrationDetailItem,
  GetAdminEngineerRegistrationDetailCommand,
} from './admin-engineer-registration.types';
import { GetAdminEngineerRegistrationDetailUsecase } from './get-admin-engineer-registration-detail.usecase';

/**
 * 审批详情读入口：申请事实 + 申请人详情资料（含真实姓名）+ 目标公司展示名。
 *
 * 可见范围完全复用既有详情入口的裁决（一级任意公司、二级仅本公司，统一
 * `APPLICATION_NOT_FOUND`），不在此处另写一份权限口径；真实姓名只在本入口返回，
 * 既有 `adminEngineerRegistrationDetail` 继续保持 `AdminUserDTO` 字段面。
 *
 * 只读：不开启事务、不写库、不加锁。
 */
@Injectable()
export class GetAdminEngineerRegistrationApprovalDetailUsecase {
  constructor(
    private readonly detailReader: GetAdminEngineerRegistrationDetailUsecase,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
  ) {}

  async execute(
    command: GetAdminEngineerRegistrationDetailCommand,
  ): Promise<AdminEngineerRegistrationDetailItem> {
    const application = await this.detailReader.resolveVisibleApplication(command);

    try {
      const applicant = await this.adminUserQueryService.findAdminUserDetailViewById({
        accountId: application.accountId,
      });
      if (applicant === null) {
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '申请人账号资料读取失败，请稍后重试',
          undefined,
          { diagnostic: 'APPLICANT_VIEW_NOT_READABLE', accountId: application.accountId },
        );
      }

      const organizationName = await this.organizationQueryService.findOrganizationNameById({
        organizationId: application.organizationId,
      });

      return { application, applicant, organizationName };
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.READ_FAILED,
        '注册申请读取失败，请稍后重试',
        undefined,
        error,
      );
    }
  }
}

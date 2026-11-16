// src/usecases/registration/get-admin-engineer-registration-detail.usecase.ts

import {
  ADMIN_USER_ERROR,
  DomainError,
  ENGINEER_REGISTRATION_ERROR,
  isDomainError,
} from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  AdminEngineerRegistrationItem,
  GetAdminEngineerRegistrationDetailCommand,
} from './admin-engineer-registration.types';
import { normalizeEngineerRegistrationApplicationId } from './registration-input.normalize';
import {
  assertEngineerRegistrationReviewPermission,
  isApplicationInAdminScope,
} from './engineer-registration-review-permission';

/**
 * 管理员查看单条工程师注册申请（既有契约入口）。
 *
 * 可见范围由可信管理员作用域限定：一级任意公司，二级仅本公司。
 * 申请不存在、跨公司或已不可见时统一返回 `APPLICATION_NOT_FOUND`（对外 NOT_FOUND），
 * 不区分「不存在」与「跨公司」，避免通过错误差异探测其他公司的申请主键。
 *
 * 返回申请人公开资料（`AdminUserView`），不含真实姓名；审批决策所需的真实姓名
 * 由专用的审批详情入口提供，二者字段面分开。
 *
 * 只读：不开启事务、不写库、不加锁。
 */
@Injectable()
export class GetAdminEngineerRegistrationDetailUsecase {
  constructor(
    private readonly engineerRegistrationQueryService: EngineerRegistrationQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationContext: TrustedOrganizationContextQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
  ) {}

  /**
   * 解析当前会话可见的申请事实（含存在性、作用域裁决与统一 NOT_FOUND 口径）。
   *
   * 供本用例与审批详情用例共用，避免两个入口各自实现权限与可见性判断。
   */
  async resolveVisibleApplication(
    command: GetAdminEngineerRegistrationDetailCommand,
  ): Promise<EngineerRegistrationApplicationSnapshot> {
    const scope = await assertEngineerRegistrationReviewPermission({
      session: command.session,
      actionLabel: '查看',
      organizationContext: this.organizationContext,
    });
    const applicationId = normalizeEngineerRegistrationApplicationId(command.applicationId);

    try {
      const application = await this.engineerRegistrationQueryService.findById(applicationId);
      if (application === null || !isApplicationInAdminScope(scope, application.organizationId)) {
        throw new DomainError(ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND, '注册申请不存在');
      }

      return application;
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

  async execute(
    command: GetAdminEngineerRegistrationDetailCommand,
  ): Promise<AdminEngineerRegistrationItem> {
    const application = await this.resolveVisibleApplication(command);

    try {
      const applicant = await this.adminUserQueryService.findAdminUserViewById({
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

// src/usecases/registration/get-admin-engineer-registration-detail.usecase.ts

import {
  ADMIN_USER_ERROR,
  DomainError,
  ENGINEER_REGISTRATION_ERROR,
  isDomainError,
} from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  AdminEngineerRegistrationItem,
  GetAdminEngineerRegistrationDetailCommand,
} from './admin-engineer-registration.types';
import { normalizeEngineerRegistrationApplicationId } from './registration-input.normalize';
import { assertEngineerRegistrationReviewPermission } from './engineer-registration-review-permission';

/**
 * 所属组织管理员查看单条工程师注册申请。
 *
 * 可见范围由可信组织解析限定：申请不存在或不属于该组织时统一返回
 * `APPLICATION_NOT_FOUND`（对外 NOT_FOUND），不区分「不存在」与「跨组织」，
 * 避免通过错误差异探测其他组织的申请主键。
 *
 * 只读：不开启事务、不写库、不加锁。
 */
@Injectable()
export class GetAdminEngineerRegistrationDetailUsecase {
  constructor(
    private readonly engineerRegistrationQueryService: EngineerRegistrationQueryService,
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationContext: TrustedOrganizationContextQueryService,
  ) {}

  async execute(
    command: GetAdminEngineerRegistrationDetailCommand,
  ): Promise<AdminEngineerRegistrationItem> {
    const organization = await assertEngineerRegistrationReviewPermission({
      session: command.session,
      actionLabel: '查看',
      organizationContext: this.organizationContext,
    });
    const applicationId = normalizeEngineerRegistrationApplicationId(command.applicationId);

    try {
      const application = await this.engineerRegistrationQueryService.findById(applicationId);
      if (application === null || application.organizationId !== organization.organizationId) {
        throw new DomainError(ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND, '注册申请不存在');
      }

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

      return { application, applicant };
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

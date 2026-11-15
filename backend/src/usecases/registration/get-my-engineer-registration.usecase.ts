// src/usecases/registration/get-my-engineer-registration.usecase.ts

import { ENGINEER_REGISTRATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type {
  GetMyEngineerRegistrationCommand,
  MyEngineerRegistrationResult,
} from './engineer-registration.types';

/**
 * 受限会话读取「本人最新一份工程师申请」。
 *
 * 与凭据式 `myEngineerRegistrationStatus` 的分工：
 * - 本用例走已认证会话（`JwtAuthGuard` + `MustChangePasswordGuard`），账号主键只来自
 *   Session，**不接收任何账号 / 申请 ID 参数**，结构上没有读取他人申请的入口；
 * - 供 `/restricted` 页在「工程师待审 / 已拒绝 / 资格未生效」时展示申请公司与审核意见；
 * - 不签发 Token、不改写任何状态、不开启事务。
 *
 * 目标公司名称按主键直读（不过滤组织状态）：公司后来被停用不应让申请人看不到
 * 自己申请的对象；组织行缺失时名称为 null，其余事实照常返回。
 */
@Injectable()
export class GetMyEngineerRegistrationUsecase {
  constructor(
    private readonly engineerRegistrationQueryService: EngineerRegistrationQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
  ) {}

  async execute(command: GetMyEngineerRegistrationCommand): Promise<MyEngineerRegistrationResult> {
    const accountId = command.session.accountId;
    const latest = await this.engineerRegistrationQueryService.findLatestByAccountId(accountId);
    if (latest === null) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND,
        '没有工程师注册申请',
      );
    }

    const organizationName = await this.organizationQueryService.findOrganizationNameById({
      organizationId: latest.organizationId,
    });

    return {
      applicationId: latest.id,
      organizationId: latest.organizationId,
      organizationName,
      status: latest.status,
      applicationNote: latest.applicationNote,
      submittedAt: latest.submittedAt,
      reviewedAt: latest.reviewedAt,
      reviewComment: latest.reviewComment,
    };
  }
}

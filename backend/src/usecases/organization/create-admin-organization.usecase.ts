// src/usecases/organization/create-admin-organization.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { Injectable } from '@nestjs/common';
import type { AdminOrganizationCreationResult } from './company-provisioning.types';
import { ProvisionCompanyWithAdminUsecase } from './provision-company-with-admin.usecase';

export type CreateAdminOrganizationCommand = {
  readonly session: UsecaseSession;
  /**
   * 提交标识（可选）：提供时原样透传给开通用例（此时具备幂等）；
   * 缺省表示旧合同调用方无法提供标识，走无幂等路径且不写提交行。
   */
  readonly submissionKey?: unknown;
  readonly name: unknown;
  readonly contactPhone: unknown;
  readonly shortName?: unknown;
  readonly contactName?: unknown;
  readonly contactEmail?: unknown;
  readonly address?: unknown;
  readonly remark?: unknown;
  readonly status?: unknown;
  readonly isServiceProvider?: unknown;
};

/**
 * 一级管理员新增公司档案（任务 08.2，S2 起升级为同事务开通）。
 *
 * 该入口只保留旧合同形状与错误口径，实际写入完全委托给
 * `ProvisionCompanyWithAdminUsecase`：公司、二级管理员账号、资料、角色与成员关系
 * 在同一事务内完成，**任何兼容入口都不得绕过同事务开通**。
 *
 * - 未提供 `submissionKey`：无幂等路径（重复调用会重复建公司与账号），不写提交行；
 * - 提供 `submissionKey`：与正式入口完全一致的幂等与回放语义；
 * - 返回值不含首次临时密码（旧合同没有该字段面）。
 */
@Injectable()
export class CreateAdminOrganizationUsecase {
  constructor(
    private readonly provisionCompanyWithAdminUsecase: ProvisionCompanyWithAdminUsecase,
  ) {}

  async execute(command: CreateAdminOrganizationCommand): Promise<AdminOrganizationCreationResult> {
    const result = await this.provisionCompanyWithAdminUsecase.execute({
      session: command.session,
      submissionKey: command.submissionKey,
      name: command.name,
      contactPhone: command.contactPhone,
      shortName: command.shortName,
      contactName: command.contactName,
      contactEmail: command.contactEmail,
      address: command.address,
      remark: command.remark,
      status: command.status,
      isServiceProvider: command.isServiceProvider,
    });

    return { organization: result.organization, admin: result.admin };
  }
}

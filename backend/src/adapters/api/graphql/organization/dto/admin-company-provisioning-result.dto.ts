// src/adapters/api/graphql/organization/dto/admin-company-provisioning-result.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import type { CompanyProvisioningResult } from '@src/usecases/organization/company-provisioning.types';
import {
  AdminOrganizationDTO,
  ProvisionedAdminDTO,
  toAdminOrganizationDTO,
  toProvisionedAdminDTO,
} from './admin-organization.dto';

/** 提交标识结果：`replayed=true` 表示返回既有提交，未新建。 */
@ObjectType({ description: '提交标识结果（幂等回放标识）' })
export class ProvisioningSubmissionDTO {
  @Field(() => Int, {
    nullable: true,
    description: '提交行主键；旧入口无幂等路径时为 null',
  })
  submissionId!: number | null;

  @Field(() => Boolean, { description: '是否为既有提交的回放' })
  replayed!: boolean;
}

/** 新开通结果：公司 + 管理员 + 提交标识 + 一次性临时密码。 */
@ObjectType({ description: '新增公司并开通二级管理员结果' })
export class AdminCompanyProvisioningResultDTO {
  @Field(() => AdminOrganizationDTO, { description: '新公司档案' })
  organization!: AdminOrganizationDTO;

  @Field(() => ProvisionedAdminDTO, { description: '已开通的二级管理员' })
  provisionedAdmin!: ProvisionedAdminDTO;

  @Field(() => ProvisioningSubmissionDTO, { description: '提交标识结果' })
  submission!: ProvisioningSubmissionDTO;

  @Field(() => String, {
    nullable: true,
    description: '一次性临时密码；仅首次成功返回，回放恒为 null',
  })
  temporaryPassword!: string | null;
}

export function toAdminCompanyProvisioningResultDTO(
  result: CompanyProvisioningResult,
): AdminCompanyProvisioningResultDTO {
  return {
    organization: toAdminOrganizationDTO(result.organization, result.admin),
    provisionedAdmin: toProvisionedAdminDTO(result.admin),
    submission: {
      submissionId: result.submission.submissionId,
      replayed: result.submission.replayed,
    },
    temporaryPassword: result.temporaryPassword,
  };
}

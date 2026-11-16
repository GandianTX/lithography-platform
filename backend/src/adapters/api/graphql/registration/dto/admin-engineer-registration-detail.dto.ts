// src/adapters/api/graphql/registration/dto/admin-engineer-registration-detail.dto.ts

import type { AdminEngineerRegistrationDetailItem } from '@src/usecases/registration/admin-engineer-registration.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';
import {
  EngineerRegistrationApplicationDTO,
  toEngineerRegistrationApplicationDTO,
} from './engineer-registration-application.dto';

/**
 * 审批详情申请人 DTO：只承载审批决策所需资料，含真实姓名。
 *
 * 刻意不复用 `AdminUserDTO`：后者是账号管理列表 / 写后读的字段面（含角色、状态、
 * 公司、时间戳），审批详情不需要且不应扩大暴露面。`realName` 可为空（旧数据未填），
 * 前端必须显式按空展示，不得用 `nickname` 冒充。
 */
@ObjectType({ description: '审批详情申请人资料（真实姓名与昵称分开）' })
export class AdminEngineerRegistrationApplicantDTO {
  @Field(() => Int, { description: '账号 ID' })
  id!: number;

  @Field(() => String, { description: '登录名', nullable: true })
  loginName!: string | null;

  @Field(() => String, { description: '昵称' })
  nickname!: string;

  @Field(() => String, { description: '真实姓名（旧数据可能为空）', nullable: true })
  realName!: string | null;

  @Field(() => String, { description: '电话', nullable: true })
  phone!: string | null;

  @Field(() => String, { description: '联系邮箱（非登录凭据）', nullable: true })
  contactEmail!: string | null;
}

/** 审批详情 DTO：申请事实 + 申请人详情资料 + 目标公司展示名 */
@ObjectType({ description: '工程师注册申请详情（申请 + 申请人详情）' })
export class AdminEngineerRegistrationDetailDTO {
  @Field(() => EngineerRegistrationApplicationDTO, { description: '申请记录' })
  application!: EngineerRegistrationApplicationDTO;

  @Field(() => AdminEngineerRegistrationApplicantDTO, { description: '申请人详情资料' })
  applicant!: AdminEngineerRegistrationApplicantDTO;

  @Field(() => String, { description: '申请目标公司展示名称（公司行缺失时为空）', nullable: true })
  organizationName!: string | null;
}

/** 审批详情 View → DTO 薄映射 */
export function toAdminEngineerRegistrationDetailDTO(
  item: AdminEngineerRegistrationDetailItem,
): AdminEngineerRegistrationDetailDTO {
  return {
    application: toEngineerRegistrationApplicationDTO(item.application),
    applicant: {
      id: item.applicant.id,
      loginName: item.applicant.loginName,
      nickname: item.applicant.nickname,
      realName: item.applicant.realName,
      phone: item.applicant.phone,
      contactEmail: item.applicant.contactEmail,
    },
    organizationName: item.organizationName,
  };
}

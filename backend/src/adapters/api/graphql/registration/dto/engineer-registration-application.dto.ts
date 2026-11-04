// src/adapters/api/graphql/registration/dto/engineer-registration-application.dto.ts

import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * 工程师注册申请记录 DTO（本人查询与组织审核共用同一形态）。
 *
 * 只暴露申请事实：目标组织、状态、申请说明、提交时间与审核结论；
 * 不含登录凭据、角色摘要或其他账号资料。
 */
@ObjectType({ description: '工程师自助注册申请记录' })
export class EngineerRegistrationApplicationDTO {
  @Field(() => Int, { description: '申请 ID' })
  id!: number;

  @Field(() => Int, { description: '申请人账号 ID' })
  accountId!: number;

  @Field(() => Int, { description: '申请目标组织 ID' })
  organizationId!: number;

  @Field(() => EngineerRegistrationApplicationStatus, { description: '申请状态' })
  status!: EngineerRegistrationApplicationStatus;

  @Field(() => String, { description: '申请说明', nullable: true })
  applicationNote!: string | null;

  @Field(() => Date, { description: '提交时间' })
  submittedAt!: Date;

  @Field(() => Int, { description: '审核管理员账号 ID（待审为空）', nullable: true })
  reviewedByAccountId!: number | null;

  @Field(() => Date, { description: '审核时间（待审为空）', nullable: true })
  reviewedAt!: Date | null;

  @Field(() => String, { description: '审核意见（拒绝时必填）', nullable: true })
  reviewComment!: string | null;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Date, { description: '最近变更时间' })
  updatedAt!: Date;
}

/** 申请记录 View → DTO 薄映射（字段直通，不做业务判断） */
export function toEngineerRegistrationApplicationDTO(
  view: EngineerRegistrationApplicationSnapshot,
): EngineerRegistrationApplicationDTO {
  return {
    id: view.id,
    accountId: view.accountId,
    organizationId: view.organizationId,
    status: view.status,
    applicationNote: view.applicationNote,
    submittedAt: view.submittedAt,
    reviewedByAccountId: view.reviewedByAccountId,
    reviewedAt: view.reviewedAt,
    reviewComment: view.reviewComment,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

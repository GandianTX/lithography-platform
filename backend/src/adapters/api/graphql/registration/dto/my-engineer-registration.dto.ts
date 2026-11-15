// src/adapters/api/graphql/registration/dto/my-engineer-registration.dto.ts

import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import type { MyEngineerRegistrationResult } from '@src/usecases/registration/engineer-registration.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * 受限会话可读的「本人最新一份工程师申请」。
 *
 * 刻意不含 `accountId` / `reviewedByAccountId`：调用者只可能是申请人本人，
 * 不需要也不应看到自己或审核人的账号主键。
 */
@ObjectType({ description: '本人最新工程师注册申请（受限会话）' })
export class MyEngineerRegistrationDTO {
  @Field(() => Int, { description: '申请 ID' })
  applicationId!: number;

  @Field(() => Int, { description: '申请目标公司 ID（仅展示，不授予权限）' })
  organizationId!: number;

  @Field(() => String, { description: '申请目标公司名称；组织已删除时为 null', nullable: true })
  organizationName!: string | null;

  @Field(() => EngineerRegistrationApplicationStatus, { description: '申请状态' })
  status!: EngineerRegistrationApplicationStatus;

  @Field(() => String, { description: '申请说明', nullable: true })
  applicationNote!: string | null;

  @Field(() => Date, { description: '提交时间' })
  submittedAt!: Date;

  @Field(() => Date, { description: '审核时间（待审为空）', nullable: true })
  reviewedAt!: Date | null;

  @Field(() => String, { description: '审核意见（拒绝时必填）', nullable: true })
  reviewComment!: string | null;
}

/** View → DTO 薄映射（字段直通，不做业务判断） */
export function toMyEngineerRegistrationDTO(
  view: MyEngineerRegistrationResult,
): MyEngineerRegistrationDTO {
  return {
    applicationId: view.applicationId,
    organizationId: view.organizationId,
    organizationName: view.organizationName,
    status: view.status,
    applicationNote: view.applicationNote,
    submittedAt: view.submittedAt,
    reviewedAt: view.reviewedAt,
    reviewComment: view.reviewComment,
  };
}

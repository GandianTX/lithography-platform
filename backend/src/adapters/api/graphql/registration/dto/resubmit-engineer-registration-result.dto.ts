// src/adapters/api/graphql/registration/dto/resubmit-engineer-registration-result.dto.ts

import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';

/** 重提结果：新 PENDING 申请的最小事实（不返回被覆盖的历史记录） */
@ObjectType({ description: '工程师注册申请重提结果' })
export class ResubmitEngineerRegistrationResultDTO {
  @Field(() => Int, { description: '新申请 ID' })
  applicationId!: number;

  @Field(() => Int, { description: '新申请目标组织 ID' })
  organizationId!: number;

  @Field(() => EngineerRegistrationApplicationStatus, {
    description: '新申请状态（恒为 PENDING）',
  })
  status!: EngineerRegistrationApplicationStatus;

  @Field(() => Date, { description: '提交时间' })
  submittedAt!: Date;
}

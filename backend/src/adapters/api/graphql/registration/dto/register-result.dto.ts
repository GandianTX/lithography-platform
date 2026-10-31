// src/adapters/api/graphql/registration/dto/register-result.dto.ts

import { RegistrationOutcomeStatus } from '@app-types/models/registration.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * 用户注册结果
 *
 * `registrationStatus` 区分「已开通」与「待组织管理员审核」：
 * 客户注册（含第三方入口）恒为 `REGISTERED`；工程师注册恒为 `PENDING_REVIEW`，
 * 此时账号与资料保持待审、不能登录，`applicationId` 指向新建的待审申请。
 */
@ObjectType({ description: '用户注册结果' })
export class RegisterResult {
  @Field(() => Boolean, { description: '注册是否成功' })
  success!: boolean;

  @Field(() => String, { description: '注册结果消息' })
  message!: string;

  @Field(() => Int, { description: '创建的账户 ID', nullable: true })
  accountId?: number;

  @Field(() => RegistrationOutcomeStatus, {
    description: '注册即时结果：REGISTERED=已开通；PENDING_REVIEW=待组织管理员审核',
  })
  registrationStatus!: RegistrationOutcomeStatus;

  @Field(() => Int, {
    description: '工程师待审申请 ID（客户注册为空）',
    nullable: true,
  })
  applicationId?: number | null;
}

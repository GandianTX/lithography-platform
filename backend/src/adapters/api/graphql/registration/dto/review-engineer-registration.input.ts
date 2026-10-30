// src/adapters/api/graphql/registration/dto/review-engineer-registration.input.ts

import { EngineerRegistrationReviewAction } from '@app-types/models/registration.types';
import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * 组织管理员一次性终态审核输入。
 *
 * `applicationId` 只选目标申请；可见范围由服务端按可信组织复核，
 * 跨组织或不存在的申请统一按 NOT_FOUND 拒绝。`REJECT` 时 `reviewComment` 必填，
 * 该规则由用例统一裁决（本输入只做形态校验）。
 */
@InputType({ description: '组织管理员审核工程师注册申请' })
export class ReviewEngineerRegistrationInput {
  @Field(() => Int, { description: '申请 ID' })
  @IsInt({ message: '申请 ID 必须是整数' })
  @Min(1, { message: '申请 ID 必须大于等于 1' })
  applicationId!: number;

  @Field(() => EngineerRegistrationReviewAction, { description: '审核动作（APPROVE / REJECT）' })
  @IsEnum(EngineerRegistrationReviewAction, { message: '审核动作无效' })
  action!: EngineerRegistrationReviewAction;

  @Field(() => String, { description: '审核意见（拒绝时必填）', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '审核意见必须是字符串' })
  @MaxLength(2000, { message: '审核意见最多 2000 个字符' })
  reviewComment?: string | null;
}

// src/adapters/api/graphql/registration/dto/resubmit-engineer-registration.input.ts

import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { EngineerRegistrationCredentialInput } from './engineer-registration-credential.input';

/** 拒绝后重提输入：本人凭据 + 新的目标组织 + 可选的申请说明 */
@InputType({ description: '拒绝后重新提交工程师注册申请' })
export class ResubmitEngineerRegistrationInput extends EngineerRegistrationCredentialInput {
  @Field(() => Int, { description: '新申请的目标组织主键（事务内复核有效）' })
  @IsInt({ message: '组织主键必须是整数' })
  @Min(1, { message: '组织主键必须大于等于 1' })
  organizationId!: number;

  @Field(() => String, { description: '申请说明（可选，最多 2000 字符）', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '申请说明必须是字符串' })
  @MaxLength(2000, { message: '申请说明最多 2000 个字符' })
  applicationNote?: string | null;
}

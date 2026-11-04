// src/adapters/api/graphql/registration/dto/engineer-registration-credential.input.ts

import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 本人凭据证明输入（本人申请状态查询与拒绝后重提共用）。
 *
 * 待审账号尚未获得登录态，因此不能依赖 JWT：本输入只证明调用者掌握该账号的
 * 登录凭据，服务端验证后按已证明的账号主键限定可见范围，**不签发令牌、不放行登录**。
 * 密码刻意不做 trim 变换（trim 会静默改写秘密），纯空白由用例按凭据不匹配处理。
 */
@InputType({ description: '本人凭据证明（登录名或登录邮箱 + 密码）' })
export class EngineerRegistrationCredentialInput {
  @Field(() => String, { description: '登录名或登录邮箱' })
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '登录名或登录邮箱必须是字符串' })
  @IsNotEmpty({ message: '登录名或登录邮箱不能为空' })
  @MaxLength(254, { message: '登录名或登录邮箱长度不能超过 254 个字符' })
  accountIdentifier!: string;

  @Field(() => String, { description: '登录密码（服务端不 trim）' })
  @IsString({ message: '密码必须是字符串' })
  @IsNotEmpty({ message: '密码不能为空' })
  @MaxLength(200, { message: '密码长度不能超过 200 个字符' })
  password!: string;
}

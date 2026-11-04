// src/adapters/api/graphql/registration/dto/register.input.ts

import { RegisterTypeEnum } from '@app-types/services/register.types';
import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsValidPassword } from '@adapters/api/graphql/common/password-validation.decorator';

/**
 * 用户注册输入参数
 */
@InputType()
export class RegisterInput {
  @Field(() => String, { description: '登录名', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '登录名必须是字符串' })
  @MinLength(4, { message: '登录名至少 4 个字符' })
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: '登录名只能包含英文字母、数字、下划线和短横线',
  })
  loginName?: string | null;

  @Field(() => String, { description: '登录邮箱' })
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsNotEmpty({ message: '邮箱不能为空' })
  @MaxLength(254, { message: '邮箱长度不能超过 254 个字符' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  loginEmail!: string;

  @Field(() => String, { description: '登录密码' })
  @IsString({ message: '密码必须是字符串' })
  @IsNotEmpty({ message: '密码不能为空' })
  @MinLength(6, { message: '密码至少 6 个字符' })
  @IsValidPassword({ message: '密码不符合安全要求' })
  loginPassword!: string;

  @Field(() => String, { description: '昵称', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '昵称必须是字符串' })
  nickname?: string | null;

  @Field(() => RegisterTypeEnum, {
    description: '注册类型',
    defaultValue: RegisterTypeEnum.CUSTOMER,
  })
  @IsEnum(RegisterTypeEnum, { message: '注册类型无效' })
  type: RegisterTypeEnum = RegisterTypeEnum.CUSTOMER;

  @Field(() => Int, { description: '所选有效组织主键；客户与工程师均必填' })
  @IsInt({ message: '组织主键必须是整数' })
  @Min(1, { message: '组织主键必须大于等于 1' })
  organizationId!: number;

  @Field(() => String, { description: '工程师申请说明（仅工程师注册使用）', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '申请说明必须是字符串' })
  @MaxLength(2000, { message: '申请说明最多 2000 个字符' })
  applicationNote?: string | null;

  @Field(() => String, { description: '邀请令牌', nullable: true })
  @IsOptional()
  @IsString({ message: '邀请令牌必须是字符串' })
  inviteToken?: string;
}

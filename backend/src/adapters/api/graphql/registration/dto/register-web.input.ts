// src/adapters/api/graphql/registration/dto/register-web.input.ts

import { IsValidPassword } from '@adapters/api/graphql/common/password-validation.decorator';
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

/**
 * V44 Web 注册输入参数（`registerWeb`）。
 *
 * 与旧 `register` 的请求形状差异：
 * - 工程师必须提交 `realName` 与 `phone`；
 * - 客户在「选择名单内公司（`organizationId`）/ 手填自家公司（`organizationName`）」中
 *   二选一，二者互斥；工程师只允许选择名单内公司；
 * - 公司资格由服务端事务内复核为 `ACTIVE + 受管`。
 *
 * 旧客户端继续使用 `register`（`RegisterInput`），两者共用同一注册事务。
 */
@InputType()
export class RegisterWebInput {
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
  @MinLength(8, { message: '密码至少 8 个字符' })
  @MaxLength(128, { message: '密码最多 128 个字符' })
  @IsValidPassword({ message: '密码不符合安全要求' })
  loginPassword!: string;

  @Field(() => String, { description: '昵称', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '昵称必须是字符串' })
  nickname?: string | null;

  @Field(() => String, { description: '真实姓名（工程师注册必填）', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '姓名必须是字符串' })
  @MaxLength(200, { message: '姓名最多 200 个字符' })
  realName?: string | null;

  @Field(() => String, { description: '联系电话（工程师注册必填）', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '联系电话必须是字符串' })
  @MaxLength(20, { message: '联系电话最多 20 个字符' })
  phone?: string | null;

  @Field(() => RegisterTypeEnum, {
    description: '注册类型',
    defaultValue: RegisterTypeEnum.CUSTOMER,
  })
  @IsEnum(RegisterTypeEnum, { message: '注册类型无效' })
  type: RegisterTypeEnum = RegisterTypeEnum.CUSTOMER;

  @Field(() => Int, {
    description: '所选有效组织主键；选择名单公司时必填，与 organizationName 互斥',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: '组织主键必须是整数' })
  @Min(1, { message: '组织主键必须大于等于 1' })
  organizationId?: number | null;

  @Field(() => String, {
    description: '手填自家公司名称；未选择名单公司时必填，与 organizationId 互斥',
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '公司名称必须是字符串' })
  @MaxLength(200, { message: '公司名称最多 200 个字符' })
  organizationName?: string | null;

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

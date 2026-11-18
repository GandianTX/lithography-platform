// src/adapters/api/graphql/account/dto/update-my-account-settings.input.ts

import {
  LOGIN_NAME_MAX_LENGTH,
  LOGIN_NAME_MIN_LENGTH,
  LOGIN_NAME_PATTERN,
} from '@core/account/policy/login-name.policy';
import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * 当前用户账号设置更新输入（P2）。
 *
 * 协议级 class-validator 只负责 shape 与最基础格式；值收敛（trim / NFKC / 长度上限 /
 * 三态语义 / 凭据「至少保留一个」组合约束）由 `UpdateMyAccountSettingsUsecase` 及其
 * normalize 层统一裁决，本 Input 不预设字段已合法。
 *
 * - 刻意不含 `accountId` / `userId`、角色、状态与密码字段：目标账号只能来自已认证
 *   Session，结构上杜绝「修改他人设置」与「借设置入口写角色 / 状态 /
 *   密码」的入口；
 * - `loginName` / `loginEmail` 严格三态：不传 = 不修改，`null` = 清空，字符串 = 设置；
 *   合并当前值后「至少保留一个登录方式」由 Usecase 在锁内裁决；
 * - `nickname` 不传 = 不修改，字符串 = 设置；显式 `null` / 空字符串 / 纯空白均拒绝
 *   （昵称必填且允许重复，无唯一性检查）；
 * - 其余三个可选资料字段三态：不传 = 不修改，`null` = 清空；
 * - 空字符串 / 纯空白的逐字段语义（与 `AdminUpdateUserProfileInput` 1:1 同构的系统级
 *   既有口径，非本 Input 特有规则）：格式受限字段（`loginName` / `loginEmail` /
 *   `contactEmail`）的空串在 DTO 校验层即被 `@MinLength` / `@IsEmail` 拒绝，走不到
 *   normalize；自由文本 `companyName` / `phone` 的空串 / 纯空白经 `trimTextPure`
 *   原样保留，由 normalize 收敛为 `null` → 清空该列；`nickname` 的空串 / 纯空白被
 *   `@IsNotEmpty` 拒绝（必填字段无「清空」语义）；
 * - `contactEmail` 是联系邮箱（`base_user_info.email`），与登录凭据 `loginEmail`
 *   是两个不同字段，不得互相代替。
 */
@InputType({ description: '当前用户账号设置更新输入' })
export class UpdateMyAccountSettingsInput {
  @Field(() => String, {
    description: '登录名（不传 = 不修改，null = 清空，字符串 = 设置）',
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '登录名必须是字符串' })
  @MinLength(LOGIN_NAME_MIN_LENGTH, { message: '登录名至少 4 个字符' })
  @MaxLength(LOGIN_NAME_MAX_LENGTH, { message: '登录名最多 30 个字符' })
  @Matches(LOGIN_NAME_PATTERN, {
    message: '登录名只能包含英文字母、数字、下划线和短横线',
  })
  loginName?: string | null;

  @Field(() => String, {
    description: '登录邮箱（不传 = 不修改，null = 清空，字符串 = 设置）',
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '登录邮箱必须是字符串' })
  @MaxLength(254, { message: '登录邮箱长度不能超过 254 个字符' })
  @IsEmail({}, { message: '登录邮箱格式不正确' })
  loginEmail?: string | null;

  @Field(() => String, {
    description: '昵称（不传 = 不修改；字符串 = 设置；null / 空字符串 / 纯空白均拒绝）',
    nullable: true,
  })
  @ValidateIf((input: UpdateMyAccountSettingsInput) => input.nickname !== undefined)
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '昵称必须是字符串' })
  @IsNotEmpty({ message: '昵称不能为空' })
  nickname?: string;

  @Field(() => String, {
    description: '真实姓名（不传 = 不修改，null / 空白 = 清空，字符串 = 设置）',
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '真实姓名必须是字符串' })
  @MaxLength(200, { message: '真实姓名长度不能超过 200 个字符' })
  realName?: string | null;

  @Field(() => String, { description: '公司名称（不传 = 不修改，null = 清空）', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '公司名称必须是字符串' })
  companyName?: string | null;

  @Field(() => String, { description: '电话（不传 = 不修改，null = 清空）', nullable: true })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '电话必须是字符串' })
  phone?: string | null;

  @Field(() => String, {
    description: '联系邮箱（非登录凭据；不传 = 不修改，null = 清空）',
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '联系邮箱必须是字符串' })
  @MaxLength(254, { message: '联系邮箱长度不能超过 254 个字符' })
  @IsEmail({}, { message: '联系邮箱格式不正确' })
  contactEmail?: string | null;
}

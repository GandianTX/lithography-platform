// src/adapters/api/graphql/account/dto/update-my-account-profile.input.ts

import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Web 正式资料页的窄写输入（任务 02 F5）。
 *
 * 只含 `nickname` / `realName` / `phone` / `contactEmail` 四个资料字段；结构上不存在
 * `loginName` / `loginEmail` / `companyName`（旧广协议兼容入口保留在
 * `UpdateMyAccountSettingsInput`），也不存在 `accountId` / 角色 / 状态 / 等级 /
 * `customerOrganizationId` 等身份或归属字段。目标账号只能来自已认证 Session。
 *
 * 三态语义与旧入口逐字段一致：不传 = 不修改；`realName` / `phone` / `contactEmail`
 * 显式 `null` = 清空；`nickname` 必填且不接受空值与 `null`。
 *
 * 受限会话（待审 / 已拒绝 / 资格未生效）只能写 `nickname` / `phone` / `contactEmail`，
 * 混传 `realName` 仍由 Usecase 的既有白名单整体拒绝（`FORBIDDEN`），本 Input 不复制该裁决。
 */
@InputType({ description: '当前用户资料窄写输入（昵称、真实姓名、电话、联系邮箱）' })
export class UpdateMyAccountProfileInput {
  @Field(() => String, {
    description: '昵称（不传 = 不修改；字符串 = 设置；null / 空字符串 / 纯空白均拒绝）',
    nullable: true,
  })
  @ValidateIf((input: UpdateMyAccountProfileInput) => input.nickname !== undefined)
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

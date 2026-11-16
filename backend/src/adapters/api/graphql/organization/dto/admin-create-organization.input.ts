// src/adapters/api/graphql/organization/dto/admin-create-organization.input.ts

import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  organizationStatusValues,
  type OrganizationStatus,
} from '@src/modules/lithography/organization.types';

/**
 * 一级管理员新增公司档案输入（任务 08.2）。
 *
 * 协议级只校验 shape 与基础格式；trim、空串收敛与长度上限的唯一真源在
 * `normalizeAdminOrganizationCreateInput`，本 Input 不预设字段已合法。
 *
 * 编号、类别与受管归类不接受输入：新增固定 `kind = CLIENT`、`isManagedCompany = true`，
 * 编号由服务端生成；`status` 缺省为 `ACTIVE`，可与维修资格独立提交。
 */
@InputType({ description: '管理员新增公司档案输入' })
export class AdminCreateOrganizationInput {
  @Field(() => String, { description: '公司全称' })
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '公司全称必须是字符串' })
  @IsNotEmpty({ message: '公司全称不能为空' })
  @MaxLength(200, { message: '公司全称最多 200 个字符' })
  name!: string;

  @Field(() => String, { description: '联系电话' })
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '联系电话必须是字符串' })
  @IsNotEmpty({ message: '联系电话不能为空' })
  @MaxLength(100, { message: '联系电话最多 100 个字符' })
  contactPhone!: string;

  @Field(() => String, { nullable: true, description: '公司简称' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '公司简称必须是字符串' })
  @MaxLength(100, { message: '公司简称最多 100 个字符' })
  shortName?: string | null;

  @Field(() => String, { nullable: true, description: '联系人姓名' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '联系人姓名必须是字符串' })
  @MaxLength(200, { message: '联系人姓名最多 200 个字符' })
  contactName?: string | null;

  @Field(() => String, { nullable: true, description: '公司邮箱' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '公司邮箱必须是字符串' })
  @MaxLength(254, { message: '公司邮箱最多 254 个字符' })
  @IsEmail({}, { message: '公司邮箱格式不正确' })
  contactEmail?: string | null;

  @Field(() => String, { nullable: true, description: '地址' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '地址必须是字符串' })
  @MaxLength(1000, { message: '地址最多 1000 个字符' })
  address?: string | null;

  @Field(() => String, { nullable: true, description: '备注' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '备注必须是字符串' })
  @MaxLength(2000, { message: '备注最多 2000 个字符' })
  remark?: string | null;

  @Field(() => organizationStatusValues, {
    nullable: true,
    description: '公司状态；缺省为 ACTIVE（启用）',
  })
  @IsOptional()
  @IsEnum(organizationStatusValues, { message: '公司状态无效' })
  status?: OrganizationStatus | null;

  @Field(() => Boolean, { nullable: true, description: '是否提供维修服务；缺省为 false' })
  @IsOptional()
  @IsBoolean({ message: '提供维修服务必须是布尔值' })
  isServiceProvider?: boolean | null;
}

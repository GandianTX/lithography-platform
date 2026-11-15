// src/adapters/api/graphql/organization/dto/admin-update-organization.input.ts

import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  organizationStatusValues,
  type OrganizationStatus,
} from '@src/modules/lithography/organization.types';

/**
 * 一级管理员编辑公司档案输入（任务 08.2）。
 *
 * 语义：键缺省 = 不修改；可选文本显式 `null` / 纯空白 = 清空；
 * 全称与联系电话若提供则 trim 后不得为空（由归一化层裁决）。
 *
 * 编号、受管归类、类别与创建时间不在输入内，任何请求都无法改写；
 * `status` / `isServiceProvider` 与其余字段同入口，分别更新启停与维修资格。
 */
@InputType({ description: '管理员编辑公司档案输入' })
export class AdminUpdateOrganizationInput {
  @Field(() => Int, { description: '公司主键' })
  @IsInt({ message: '公司 ID 必须是整数' })
  @Min(1, { message: '公司 ID 必须大于等于 1' })
  organizationId!: number;

  @Field(() => String, { nullable: true, description: '公司全称（不传表示不修改）' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '公司全称必须是字符串' })
  @MaxLength(200, { message: '公司全称最多 200 个字符' })
  name?: string | null;

  @Field(() => String, { nullable: true, description: '联系电话（不传表示不修改）' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '联系电话必须是字符串' })
  @MaxLength(100, { message: '联系电话最多 100 个字符' })
  contactPhone?: string | null;

  @Field(() => String, { nullable: true, description: '公司简称（null 或空白表示清空）' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '公司简称必须是字符串' })
  @MaxLength(100, { message: '公司简称最多 100 个字符' })
  shortName?: string | null;

  @Field(() => String, { nullable: true, description: '联系人姓名（null 或空白表示清空）' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '联系人姓名必须是字符串' })
  @MaxLength(200, { message: '联系人姓名最多 200 个字符' })
  contactName?: string | null;

  @Field(() => String, { nullable: true, description: '公司邮箱（null 或空白表示清空）' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '公司邮箱必须是字符串' })
  @MaxLength(254, { message: '公司邮箱最多 254 个字符' })
  @IsEmail({}, { message: '公司邮箱格式不正确' })
  contactEmail?: string | null;

  @Field(() => String, { nullable: true, description: '地址（null 或空白表示清空）' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '地址必须是字符串' })
  @MaxLength(1000, { message: '地址最多 1000 个字符' })
  address?: string | null;

  @Field(() => String, { nullable: true, description: '备注（null 或空白表示清空）' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '备注必须是字符串' })
  @MaxLength(2000, { message: '备注最多 2000 个字符' })
  remark?: string | null;

  @Field(() => organizationStatusValues, {
    nullable: true,
    description: '公司状态（不传表示不修改）',
  })
  @IsOptional()
  @IsEnum(organizationStatusValues, { message: '公司状态无效' })
  status?: OrganizationStatus | null;

  @Field(() => Boolean, { nullable: true, description: '是否提供维修服务（不传表示不修改）' })
  @IsOptional()
  @IsBoolean({ message: '提供维修服务必须是布尔值' })
  isServiceProvider?: boolean | null;
}

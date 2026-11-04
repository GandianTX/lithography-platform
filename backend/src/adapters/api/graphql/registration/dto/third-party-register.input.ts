// src/adapters/api/graphql/registration/dto/third-party-register.input.ts

import { AudienceTypeEnum, ThirdPartyProviderEnum } from '@app-types/models/account.types';
import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform, TransformFnParams, Type } from 'class-transformer';
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * 微信小程序扩展数据输入
 */
@InputType()
export class WeAppExtensionInput {
  @Field({ nullable: true, description: '微信小程序获取手机号的动态令牌' })
  @IsOptional()
  @IsString({ message: '手机号码必须是字符串' })
  @MaxLength(100, { message: '手机号码长度不能超过 100 个字符' })
  phoneCode?: string;
}

/**
 * 第三方注册输入参数
 */
@InputType()
export class ThirdPartyRegisterInput {
  @Field(() => ThirdPartyProviderEnum, { description: '第三方平台类型' })
  @IsEnum(ThirdPartyProviderEnum, { message: '第三方平台类型无效' })
  provider!: ThirdPartyProviderEnum;

  @Field({ description: '第三方平台返回的登录凭证，如授权码 code 或访问令牌 token' })
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @IsString({ message: '授权凭证必须是字符串' })
  @IsNotEmpty({ message: '授权凭证不能为空' })
  @MaxLength(2048, { message: '授权凭证长度不能超过 2048 个字符' }) // 兼容 Google/Apple id_token
  @Matches(/^\S+$/, { message: '授权凭证不能包含空白字符' })
  authCredential!: string;

  // @Field({ description: '用户昵称', nullable: true })
  // @Transform(({ value }: TransformFnParams) => normalizeText(value))
  // @IsString({ message: '昵称必须是字符串' })
  // @IsOptional()
  // @MinLength(2, { message: '昵称至少 2 个字符' })
  // @MaxLength(20, { message: '昵称最多 20 个字符' })
  // @Matches(/^(?![\p{Script=Han}]{8,})[\p{Script=Han}A-Za-z0-9 _\-\u00B7\u30FB.]{2,20}$/u, {
  //   message:
  //     '昵称长度限制：中文最多 7 个汉字，整体长度 2 到 20 个字符；允许中文、英文、数字、空格、下划线 _、短横线 -、中点 ·/・、点 .；不支持 Emoji',
  // })
  // nickname?: string;

  @Field({ nullable: true, description: '用户邮箱（可选）' })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @MaxLength(254, { message: '邮箱长度不能超过 254 个字符' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;

  @Field(() => AudienceTypeEnum, { description: '客户端类型' })
  @IsEnum(AudienceTypeEnum, { message: '客户端类型无效' })
  audience!: AudienceTypeEnum;

  @Field(() => Int, { description: '所选有效组织主键；第三方注册仅开通客户并绑定为成员' })
  @IsInt({ message: '组织主键必须是整数' })
  @Min(1, { message: '组织主键必须大于等于 1' })
  organizationId!: number;

  // 平台特定字段
  @Field(() => WeAppExtensionInput, { nullable: true, description: '微信小程序特定数据' })
  @IsOptional()
  @ValidateIf((obj: ThirdPartyRegisterInput) => obj.provider === ThirdPartyProviderEnum.WEAPP)
  @ValidateNested()
  @Type(() => WeAppExtensionInput)
  weAppData?: WeAppExtensionInput;
}

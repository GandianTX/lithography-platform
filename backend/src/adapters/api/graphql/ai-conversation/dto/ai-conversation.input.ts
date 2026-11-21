// src/adapters/api/graphql/ai-conversation/dto/ai-conversation.input.ts

import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

/** 创建会话入参：`requestId` 为空即独立会话；公司/工程师不接受客户端传入 */
@InputType()
export class CreateAiConversationInput {
  @Field(() => Int, { nullable: true, description: '关联维修申请 ID（独立会话不传）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '关联维修申请 ID 必须是整数' })
  @Min(1, { message: '关联维修申请 ID 必须大于 0' })
  requestId?: number | null;
}

/**
 * 提交问题入参。
 *
 * `questionUuid` 由前端生成的稳定 UUID v4：网络重试沿用同一值，
 * 服务端据此保证「不重复新增用户问题」。
 */
@InputType()
export class SubmitAiQuestionInput {
  @Field(() => Int, { description: '会话 ID' })
  @Type(() => Number)
  @IsInt({ message: '会话 ID 必须是整数' })
  @Min(1, { message: '会话 ID 必须大于 0' })
  conversationId!: number;

  @Field(() => ID, { description: '问题稳定标识（UUID v4，重试须沿用）' })
  @IsString({ message: '问题标识必须是字符串' })
  @IsUUID('4', { message: '问题标识必须是 UUID v4' })
  questionUuid!: string;

  @Field({ description: '问题正文（去首尾空白后 1–2000 字）' })
  @IsString({ message: '问题正文必须是字符串' })
  @Length(1, 2000, { message: '问题正文长度必须在 1–2000 字之间' })
  question!: string;

  @Field(() => Int, {
    nullable: true,
    description: '本轮阶段（1–10 或不传）；S2 起随工作流上下文快照持久化，重试由客户端重新传入',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '阶段必须是整数' })
  @Min(1, { message: '阶段必须在 1–10 之间' })
  @Max(10, { message: '阶段必须在 1–10 之间' })
  stage?: number | null;
}

/** 重试入参：沿用同一问题 UUID，不新增用户问题 */
@InputType()
export class RetryAiQuestionInput {
  @Field(() => Int, { description: '会话 ID' })
  @Type(() => Number)
  @IsInt({ message: '会话 ID 必须是整数' })
  @Min(1, { message: '会话 ID 必须大于 0' })
  conversationId!: number;

  @Field(() => ID, { description: '问题稳定标识（UUID v4，重试须沿用）' })
  @IsString({ message: '问题标识必须是字符串' })
  @IsUUID('4', { message: '问题标识必须是 UUID v4' })
  questionUuid!: string;

  @Field(() => Int, { nullable: true, description: '本轮阶段（1–10 或不传）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '阶段必须是整数' })
  @Min(1, { message: '阶段必须在 1–10 之间' })
  @Max(10, { message: '阶段必须在 1–10 之间' })
  stage?: number | null;
}

/** 本轮状态查询入参 */
@InputType()
export class AiQuestionStatusInput {
  @Field(() => Int, { description: '会话 ID' })
  @Type(() => Number)
  @IsInt({ message: '会话 ID 必须是整数' })
  @Min(1, { message: '会话 ID 必须大于 0' })
  conversationId!: number;

  @Field(() => ID, { description: '问题稳定标识' })
  @IsString({ message: '问题标识必须是字符串' })
  @IsUUID('4', { message: '问题标识必须是 UUID v4' })
  questionUuid!: string;
}

/** 会话详情入参（直接传 ID，可见性由服务端裁决） */
@InputType()
export class AiConversationIdInput {
  @Field(() => Int, { description: '会话 ID' })
  @Type(() => Number)
  @IsInt({ message: '会话 ID 必须是整数' })
  @Min(1, { message: '会话 ID 必须大于 0' })
  @Max(2147483647, { message: '会话 ID 超出范围' })
  conversationId!: number;
}

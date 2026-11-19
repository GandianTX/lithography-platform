// src/adapters/api/graphql/ai-conversation/dto/ai-conversation-export.dto.ts

import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { AiConversationMessageDTO } from './ai-conversation-read.dto';

/** 导出格式（PDF 为正式页面入口；RAW_JSON 属受控技术操作） */
export enum AiConversationExportFormat {
  PDF = 'PDF',
  RAW_JSON = 'RAW_JSON',
}

/** 导出入参：会话 + 固定内容版本 */
@InputType()
export class ExportAiConversationInput {
  @Field(() => Int)
  @IsInt({ message: '会话 ID 必须是整数' })
  @Min(1, { message: '会话 ID 必须是正整数' })
  conversationId!: number;

  /** 选定内容版本（导出固定本次消息范围与版本） */
  @Field(() => Int)
  @IsInt({ message: '内容版本必须是整数' })
  @Min(1, { message: '内容版本必须是正整数' })
  contentVersion!: number;

  @Field(() => AiConversationExportFormat)
  @IsEnum(AiConversationExportFormat, { message: '导出格式无效' })
  format!: AiConversationExportFormat;

  /** 受控技术授权凭据（仅 RAW_JSON 需要；普通页面不提供该入口） */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString({ message: '技术授权凭据必须是字符串' })
  @MaxLength(200, { message: '技术授权凭据过长' })
  technicalAuthorization?: string | null;
}

/** 导出结果：文件内容与固定范围声明 */
@ObjectType()
export class ExportAiConversationPayloadDTO {
  @Field(() => String)
  format!: string;

  @Field(() => String)
  filename!: string;

  @Field(() => String)
  mimeType!: string;

  /** 固定的内容版本 */
  @Field(() => Int)
  contentVersion!: number;

  /** 固定范围内的最后消息序号 */
  @Field(() => Int)
  lastMessageSeq!: number;

  /** 字节数（真实产物长度，失败时不会出现 0） */
  @Field(() => Int)
  byteSize!: number;

  /** Base64 文件内容（下载由前端落地；服务端不外露存储引用） */
  @Field(() => String)
  contentBase64!: string;
}

/** 管理员只读会话详情入参 */
@InputType()
export class AiAdminConversationIdInput {
  @Field(() => Int)
  @IsInt({ message: '会话 ID 必须是整数' })
  @Min(1, { message: '会话 ID 必须是正整数' })
  conversationId!: number;
}

/** 管理员只读单轮（问题 / 回答 / 状态与失败原因） */
@ObjectType()
export class AiAdminConversationTurnDTO {
  @Field(() => String)
  questionUuid!: string;

  @Field(() => Int, { nullable: true })
  turnNo!: number | null;

  @Field(() => String, { nullable: true })
  analysisStatus!: string | null;

  @Field(() => String, { nullable: true })
  failureReason!: string | null;

  @Field(() => Int, { nullable: true })
  analysisContentVersion!: number | null;

  @Field(() => AiConversationMessageDTO, { nullable: true })
  question!: AiConversationMessageDTO | null;

  @Field(() => AiConversationMessageDTO, { nullable: true })
  answer!: AiConversationMessageDTO | null;
}

/** 管理员只读会话详情（一级跨公司；二级本公司；直传外公司 ID 拒绝） */
@ObjectType()
export class AiAdminConversationDetailDTO {
  @Field(() => Int)
  conversationId!: number;

  @Field(() => Int, { nullable: true })
  requestId!: number | null;

  @Field(() => String)
  requestNo!: string;

  @Field(() => String)
  status!: string;

  @Field(() => Int)
  contentVersion!: number;

  @Field(() => String)
  engineerNickname!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => [AiAdminConversationTurnDTO])
  turns!: AiAdminConversationTurnDTO[];
}

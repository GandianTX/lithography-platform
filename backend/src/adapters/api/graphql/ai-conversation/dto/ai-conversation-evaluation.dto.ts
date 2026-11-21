// src/adapters/api/graphql/ai-conversation/dto/ai-conversation-evaluation.dto.ts

import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsInt, Min } from 'class-validator';

/** 固定评价范围入参：会话 + 显式选定的内容版本 */
@InputType()
export class AiConversationEvaluationScopeInput {
  @Field(() => Int)
  @IsInt({ message: '会话 ID 必须是整数' })
  @Min(1, { message: '会话 ID 必须是正整数' })
  conversationId!: number;

  /** 选定内容版本（固定本次消息范围与截止点；不随后续追加消息漂移） */
  @Field(() => Int)
  @IsInt({ message: '内容版本必须是整数' })
  @Min(1, { message: '内容版本必须是正整数' })
  contentVersion!: number;
}

/** 固定评价范围内的一条有效回复 */
@ObjectType()
export class AiConversationEvaluationReplyDTO {
  @Field(() => Int)
  messageId!: number;

  @Field(() => Int)
  messageSeq!: number;

  @Field(() => Int, { nullable: true })
  turnNo!: number | null;

  @Field(() => Int)
  contentVersion!: number;

  @Field(() => String, { description: '该轮分析状态（固定范围内如实标记）' })
  analysisStatus!: string;

  @Field(() => String, { description: '回答正文' })
  text!: string;

  @Field(() => Date)
  createdAt!: Date;
}

/**
 * 关联会话的固定评价范围（交付 06 评价链）
 *
 * - `contentVersion` 与 `lastMessageSeq` 共同固定消息截止点与版本；
 * - `replies` 只含范围内已成功保存的回答；失败与未完成轮次不计入有效回复。
 */
@ObjectType()
export class AiConversationEvaluationScopeDTO {
  @Field(() => Int)
  conversationId!: number;

  @Field(() => Int, { nullable: true })
  requestId!: number | null;

  @Field(() => String, { nullable: true })
  requestNo!: string | null;

  @Field(() => Int, { description: '固定的内容版本' })
  contentVersion!: number;

  @Field(() => Int, { description: '固定范围内的最后消息序号（消息截止点）' })
  lastMessageSeq!: number;

  @Field(() => [AiConversationEvaluationReplyDTO])
  replies!: AiConversationEvaluationReplyDTO[];
}

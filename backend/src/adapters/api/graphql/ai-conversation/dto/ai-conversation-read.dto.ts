// src/adapters/api/graphql/ai-conversation/dto/ai-conversation-read.dto.ts

import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import {
  AiConversationDispatchStatus,
  AiConversationStatus,
  AiMessageAnalysisStatus,
  AiMessageRole,
} from '@app-types/models/ai-conversation.types';

/** 会话列表项（不含归属账号/公司字段，避免通过前端自证范围） */
@ObjectType('AiConversationListItem')
export class AiConversationListItemDTO {
  @Field(() => Int, { description: '会话 ID' })
  id!: number;

  @Field(() => Int, { nullable: true, description: '关联维修申请 ID（独立会话为空）' })
  requestId?: number | null;

  @Field({ description: '关联申请编号（独立会话为空字符串）' })
  requestNo!: string;

  @Field(() => AiConversationStatus, { description: '会话状态' })
  status!: AiConversationStatus;

  @Field(() => Int, { description: '会话内容版本' })
  contentVersion!: number;

  @Field(() => Int, { description: '已保存消息条数' })
  messageCount!: number;

  @Field(() => Int, { description: '真实轮次（按 turn_no 去重计数，含失败轮）' })
  turnCount!: number;

  @Field(() => Date, { nullable: true, description: '最后一条消息时间' })
  lastMessageAt?: Date | null;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Date, { nullable: true, description: '完成时间' })
  completedAt?: Date | null;
}

@ObjectType('AiConversationListPage')
export class AiConversationListPageDTO {
  @Field(() => [AiConversationListItemDTO], { description: '会话列表' })
  items!: AiConversationListItemDTO[];

  @Field(() => Int, { nullable: true, description: '总条数（未请求时为 null）' })
  total?: number | null;

  @Field(() => Int, { description: '当前页码' })
  page!: number;

  @Field(() => Int, { description: '每页条数' })
  pageSize!: number;
}

/** 单条消息（正文、序号、版本与归属轮次） */
@ObjectType('AiConversationMessage')
export class AiConversationMessageDTO {
  @Field(() => Int, { description: '消息 ID' })
  messageId!: number;

  @Field(() => Int, { description: '会话内消息序号' })
  messageSeq!: number;

  @Field(() => Int, { nullable: true, description: '所属轮次' })
  turnNo?: number | null;

  @Field(() => AiMessageRole, { description: '消息角色' })
  role!: AiMessageRole;

  @Field(() => ID, { nullable: true, description: '问题稳定标识（用户消息）' })
  questionUuid?: string | null;

  @Field({ description: '消息正文' })
  text!: string;

  @Field(() => Int, { description: '内容版本' })
  contentVersion!: number;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;
}

/** 单轮问答（问题 / 回答 / 分析状态按 question_uuid 对齐） */
@ObjectType('AiConversationTurn')
export class AiConversationTurnDTO {
  @Field(() => ID, { description: '问题稳定标识' })
  questionUuid!: string;

  @Field(() => Int, { nullable: true, description: '轮次序号' })
  turnNo?: number | null;

  @Field(() => AiConversationMessageDTO, { nullable: true, description: '问题消息' })
  question?: AiConversationMessageDTO | null;

  @Field(() => AiConversationMessageDTO, {
    nullable: true,
    description: '已保存回答（未成功为空）',
  })
  answer?: AiConversationMessageDTO | null;

  @Field(() => AiMessageAnalysisStatus, { nullable: true, description: '分析状态' })
  analysisStatus?: AiMessageAnalysisStatus | null;

  @Field(() => String, { nullable: true, description: '失败原因（仅失败轮次）' })
  failureReason?: string | null;

  @Field(() => Int, { nullable: true, description: '分析内容版本' })
  analysisContentVersion?: number | null;

  @Field(() => Date, { nullable: true, description: '完成时间' })
  completedAt?: Date | null;
}

@ObjectType('AiConversationDetail')
export class AiConversationDetailDTO {
  @Field(() => Int, { description: '会话 ID' })
  id!: number;

  @Field(() => Int, { nullable: true, description: '关联维修申请 ID' })
  requestId?: number | null;

  @Field({ description: '关联申请编号' })
  requestNo!: string;

  @Field(() => AiConversationStatus, { description: '会话状态' })
  status!: AiConversationStatus;

  @Field(() => Int, { description: '会话内容版本' })
  contentVersion!: number;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Date, { nullable: true, description: '完成时间' })
  completedAt?: Date | null;

  @Field(() => [AiConversationMessageDTO], { description: '全部消息（按序号升序）' })
  messages!: AiConversationMessageDTO[];

  @Field(() => [AiConversationTurnDTO], { description: '逐轮问答' })
  turns!: AiConversationTurnDTO[];
}

/** 本轮状态（查询原问题，不触发模型） */
@ObjectType('AiQuestionStatus')
export class AiQuestionStatusDTO {
  @Field(() => Int, { description: '会话 ID' })
  conversationId!: number;

  @Field(() => ID, { description: '问题稳定标识' })
  questionUuid!: string;

  @Field(() => AiMessageAnalysisStatus, { description: '分析状态' })
  status!: AiMessageAnalysisStatus;

  @Field(() => String, { nullable: true, description: '失败原因' })
  failureReason?: string | null;

  @Field(() => Int, { description: '内容版本' })
  contentVersion!: number;

  @Field(() => Int, { nullable: true, description: '轮次序号' })
  turnNo?: number | null;

  @Field({ description: '问题正文（回显已保存版本）' })
  questionText!: string;

  @Field(() => AiConversationMessageDTO, { nullable: true, description: '已保存回答' })
  answer?: AiConversationMessageDTO | null;

  @Field(() => GraphQLJSON, {
    nullable: true,
    description: '短时图形（仅成功轮且临时通道仍有效时返回；过期/缺失为 null，正文照常）',
  })
  visualization?: unknown;
}

@ObjectType('CreateAiConversationPayload')
export class CreateAiConversationPayloadDTO {
  @Field(() => Int, { description: '会话 ID' })
  id!: number;

  @Field(() => Int, { nullable: true, description: '关联维修申请 ID' })
  requestId?: number | null;

  @Field({ description: '关联申请编号' })
  requestNo!: string;

  @Field(() => AiConversationStatus, { description: '会话状态' })
  status!: AiConversationStatus;

  @Field(() => Int, { description: '会话内容版本' })
  contentVersion!: number;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;
}

@ObjectType('SubmitAiQuestionPayload')
export class SubmitAiQuestionPayloadDTO {
  @Field(() => Int, { description: '会话 ID' })
  conversationId!: number;

  @Field(() => ID, { description: '问题稳定标识' })
  questionUuid!: string;

  @Field(() => AiMessageAnalysisStatus, { description: '受理状态' })
  status!: AiMessageAnalysisStatus;

  @Field(() => Int, { description: '轮次序号' })
  turnNo!: number;

  @Field(() => Int, { description: '消息序号' })
  messageSeq!: number;

  @Field(() => Int, { description: '内容版本' })
  contentVersion!: number;

  @Field({ description: '是否为同 UUID 同内容的幂等回放（未新增消息）' })
  replayed!: boolean;

  @Field(() => AiConversationDispatchStatus, {
    description: '派发结果：QUEUED 已入队 / DEFERRED 延后受理或幂等回放 / FAILED 派发失败',
  })
  dispatchStatus!: AiConversationDispatchStatus;
}

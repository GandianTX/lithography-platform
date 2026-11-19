// src/adapters/api/graphql/ai-conversation/ai-conversation.resolver.ts

import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CreateAiConversationUsecase } from '@src/usecases/ai-conversation/create-ai-conversation.usecase';
import { GetAiQuestionStatusUsecase } from '@src/usecases/ai-conversation/get-ai-question-status.usecase';
import { RetryAiQuestionUsecase } from '@src/usecases/ai-conversation/retry-ai-question.usecase';
import { GetMyAiConversationDetailUsecase } from '@src/usecases/ai-conversation/get-my-ai-conversation-detail.usecase';
import { ListMyAiConversationsUsecase } from '@src/usecases/ai-conversation/list-my-ai-conversations.usecase';
import { SubmitAiQuestionUsecase } from '@src/usecases/ai-conversation/submit-ai-question.usecase';
import type {
  AiConversationMessageResult,
  AiConversationTurnResult,
  MyAiConversationDetailResult,
  AiQuestionStatusResult,
} from '@src/usecases/ai-conversation/ai-conversation-read.types';
import {
  AiQuestionStatusInput,
  AiConversationIdInput,
  CreateAiConversationInput,
  RetryAiQuestionInput,
  SubmitAiQuestionInput,
} from './dto/ai-conversation.input';
import {
  AiConversationDetailDTO,
  AiConversationListPageDTO,
  AiConversationListItemDTO,
  AiConversationMessageDTO,
  AiConversationTurnDTO,
  AiQuestionStatusDTO,
  CreateAiConversationPayloadDTO,
  SubmitAiQuestionPayloadDTO,
} from './dto/ai-conversation-read.dto';

/**
 * 工程师侧 AI 对话入口（任务 05 · S1）
 *
 * 准入：`@Roles(ENGINEER, SUPER_ADMIN)` 做粗粒度路由准入（沿用仓库「管理员继承
 * 工程师路由」约定）；「仅 true-ENGINEER 可建会话/提问」由用例按可信 JWT
 * `activeRole` 精确复核，管理员不会因此获得提问身份。
 *
 * 本类只做协议映射：入参结构校验 → 调用 usecase → 输出 DTO。
 * 业务异常不在此捕获，交全局过滤器映射为 GraphQL 错误契约。
 */
@Resolver(() => AiConversationListItemDTO)
export class AiConversationResolver {
  constructor(
    private readonly createAiConversationUsecase: CreateAiConversationUsecase,
    private readonly listMyAiConversationsUsecase: ListMyAiConversationsUsecase,
    private readonly getMyAiConversationDetailUsecase: GetMyAiConversationDetailUsecase,
    private readonly submitAiQuestionUsecase: SubmitAiQuestionUsecase,
    private readonly getAiQuestionStatusUsecase: GetAiQuestionStatusUsecase,
    private readonly retryAiQuestionUsecase: RetryAiQuestionUsecase,
  ) {}

  /** 工程师查询本人有权会话（独立会话仅本人；工单会话限本公司） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AiConversationListPageDTO, {
    name: 'myAiConversations',
    description: '工程师查询本人有权查看的 AI 会话（OFFSET 分页，按创建时间倒序）',
  })
  @ValidateInput()
  async myAiConversations(
    @Args('pagination', { description: '分页参数（仅 OFFSET）' }) pagination: PaginationArgs,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AiConversationListPageDTO> {
    const page = await this.listMyAiConversationsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
    });
    return {
      items: page.items.map((item) => ({
        id: item.id,
        requestId: item.requestId,
        requestNo: item.requestNo,
        status: item.status,
        contentVersion: item.contentVersion,
        messageCount: item.messageCount,
        lastMessageAt: item.lastMessageAt,
        createdAt: item.createdAt,
        completedAt: item.completedAt,
      })),
      total: page.total ?? null,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /** 工程师查询单个会话详情（不可见与不存在统一 NOT_FOUND） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AiConversationDetailDTO, {
    name: 'myAiConversation',
    description: '工程师查询单个 AI 会话详情（逐条消息 + 逐轮分析状态）',
  })
  @ValidateInput()
  async myAiConversation(
    @Args('input', { description: '会话 ID' }) input: AiConversationIdInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AiConversationDetailDTO> {
    const detail = await this.getMyAiConversationDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      conversationId: input.conversationId,
    });
    return this.toDetailDTO(detail);
  }

  /** 查询单轮问题受理状态（结果未知先查原问题） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AiQuestionStatusDTO, {
    name: 'aiQuestionStatus',
    description: '查询单轮问题的受理状态、失败原因或已保存正文（不触发模型）',
  })
  @ValidateInput()
  async aiQuestionStatus(
    @Args('input') input: AiQuestionStatusInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AiQuestionStatusDTO> {
    const status = await this.getAiQuestionStatusUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      conversationId: input.conversationId,
      questionUuid: input.questionUuid,
    });
    return this.toQuestionStatusDTO(status);
  }

  /** 创建 AI 会话（独立会话或关联本公司可读工单） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => CreateAiConversationPayloadDTO, {
    name: 'createAiConversation',
    description: '创建 AI 会话：不传 requestId 为独立会话，传则必须为本公司可读工单',
  })
  @ValidateInput()
  async createAiConversation(
    @Args('input') input: CreateAiConversationInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<CreateAiConversationPayloadDTO> {
    const created = await this.createAiConversationUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      requestId: input.requestId ?? null,
    });
    return {
      id: created.id,
      requestId: created.requestId,
      requestNo: created.requestNo,
      status: created.status,
      contentVersion: created.contentVersion,
      createdAt: created.createdAt,
    };
  }

  /** 提交问题（同事务保存问题与分析；同 UUID 同内容幂等） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => SubmitAiQuestionPayloadDTO, {
    name: 'submitAiQuestion',
    description: '提交 AI 问题：同事务保存问题与分析记录，同 UUID 同内容返回既有受理结果',
  })
  @ValidateInput()
  async submitAiQuestion(
    @Args('input') input: SubmitAiQuestionInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<SubmitAiQuestionPayloadDTO> {
    const result = await this.submitAiQuestionUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      conversationId: input.conversationId,
      questionUuid: input.questionUuid,
      question: input.question,
      stage: input.stage ?? null,
    });
    return {
      conversationId: result.conversationId,
      questionUuid: result.questionUuid,
      status: result.status,
      turnNo: result.turnNo,
      messageSeq: result.messageSeq,
      contentVersion: result.contentVersion,
      replayed: result.replayed,
      dispatchStatus: result.dispatchStatus,
    };
  }

  /** 重试失败轮次（沿用同一问题 UUID，不新增用户问题） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => SubmitAiQuestionPayloadDTO, {
    name: 'retryAiQuestion',
    description: '重试失败的 AI 问题：沿用同一问题 UUID 启动新的有效执行',
  })
  @ValidateInput()
  async retryAiQuestion(
    @Args('input') input: RetryAiQuestionInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<SubmitAiQuestionPayloadDTO> {
    const result = await this.retryAiQuestionUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      conversationId: input.conversationId,
      questionUuid: input.questionUuid,
      stage: input.stage ?? null,
    });
    return {
      conversationId: result.conversationId,
      questionUuid: result.questionUuid,
      status: result.status,
      turnNo: result.turnNo,
      messageSeq: result.messageSeq,
      contentVersion: result.contentVersion,
      replayed: result.replayed,
      dispatchStatus: result.dispatchStatus,
    };
  }

  private toDetailDTO(detail: MyAiConversationDetailResult): AiConversationDetailDTO {
    return {
      id: detail.id,
      requestId: detail.requestId,
      requestNo: detail.requestNo,
      status: detail.status,
      contentVersion: detail.contentVersion,
      createdAt: detail.createdAt,
      completedAt: detail.completedAt,
      messages: detail.messages.map((message) => this.toMessageDTO(message)),
      turns: detail.turns.map((turn) => this.toTurnDTO(turn)),
    };
  }

  private toTurnDTO(turn: AiConversationTurnResult): AiConversationTurnDTO {
    return {
      questionUuid: turn.questionUuid,
      turnNo: turn.turnNo,
      question: turn.question ? this.toMessageDTO(turn.question) : null,
      answer: turn.answer ? this.toMessageDTO(turn.answer) : null,
      analysisStatus: turn.analysisStatus,
      failureReason: turn.failureReason,
      analysisContentVersion: turn.analysisContentVersion,
      completedAt: turn.completedAt,
    };
  }

  private toMessageDTO(message: AiConversationMessageResult): AiConversationMessageDTO {
    return {
      messageId: message.messageId,
      messageSeq: message.messageSeq,
      turnNo: message.turnNo,
      role: message.role,
      questionUuid: message.questionUuid,
      text: message.text,
      contentVersion: message.contentVersion,
      createdAt: message.createdAt,
    };
  }

  private toQuestionStatusDTO(status: AiQuestionStatusResult): AiQuestionStatusDTO {
    return {
      conversationId: status.conversationId,
      questionUuid: status.questionUuid,
      status: status.status,
      failureReason: status.failureReason,
      contentVersion: status.contentVersion,
      turnNo: status.turnNo,
      questionText: status.questionText,
      answer: status.answer ? this.toMessageDTO(status.answer) : null,
      visualization: status.visualization ?? null,
    };
  }
}

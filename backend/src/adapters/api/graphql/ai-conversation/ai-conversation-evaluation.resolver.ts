// src/adapters/api/graphql/ai-conversation/ai-conversation-evaluation.resolver.ts

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { GetAiConversationEvaluationScopeUsecase } from '@src/usecases/ai-conversation/get-ai-conversation-evaluation-scope.usecase';

import {
  AiConversationEvaluationScopeDTO,
  AiConversationEvaluationScopeInput,
} from './dto/ai-conversation-evaluation.dto';

/**
 * 关联会话固定评价范围入口（任务 05 · S4.3）
 *
 * 交付 06 评价链读取契约：
 * - 调用方显式选定内容版本，本次读取的消息截止点与版本固定，后续追加消息不影响；
 * - 有效回复只含范围内已成功保存的回答；失败与未完成轮次如实排除；
 * - 读取权与导出、管理员只读详情同一边界（直传外公司会话 ID 拒绝）。
 */
@Resolver(() => AiConversationEvaluationScopeDTO)
export class AiConversationEvaluationResolver {
  constructor(
    private readonly getAiConversationEvaluationScopeUsecase: GetAiConversationEvaluationScopeUsecase,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @ValidateInput()
  @Query(() => AiConversationEvaluationScopeDTO, {
    name: 'aiConversationEvaluationScope',
  })
  async aiConversationEvaluationScope(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('input') input: AiConversationEvaluationScopeInput,
  ): Promise<AiConversationEvaluationScopeDTO> {
    const view = await this.getAiConversationEvaluationScopeUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      conversationId: input.conversationId,
      contentVersion: input.contentVersion,
    });
    return {
      contentVersion: view.contentVersion,
      conversationId: view.conversationId,
      lastMessageSeq: view.lastMessageSeq,
      replies: view.replies.map((reply) => ({
        analysisStatus: reply.analysisStatus,
        contentVersion: reply.contentVersion,
        createdAt: new Date(reply.createdAt),
        messageId: reply.messageId,
        messageSeq: reply.messageSeq,
        text: reply.text,
        turnNo: reply.turnNo,
      })),
      requestId: view.requestId,
      requestNo: view.requestNo,
    };
  }
}

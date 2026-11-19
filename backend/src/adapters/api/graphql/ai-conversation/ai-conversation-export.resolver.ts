// src/adapters/api/graphql/ai-conversation/ai-conversation-export.resolver.ts

import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { ExportAiConversationUsecase } from '@src/usecases/ai-conversation/export-ai-conversation.usecase';
import { GetAiAdminConversationDetailUsecase } from '@src/usecases/ai-conversation/get-ai-admin-conversation-detail.usecase';

import {
  AiAdminConversationDetailDTO,
  AiAdminConversationIdInput,
  AiAdminConversationTurnDTO,
  ExportAiConversationInput,
  ExportAiConversationPayloadDTO,
} from './dto/ai-conversation-export.dto';

/**
 * AI 对话导出与管理员只读入口（任务 05 · S4）
 *
 * - 导出：固定内容版本与消息范围 → 复核读取权 → 生成产物；失败不返回空文件；
 * - 原始 JSON 为受控技术操作：需技术授权凭据，不做普通用户页面；
 * - 管理员只读：一级跨公司、二级本公司；直传外公司 ID 拒绝；无提问入口。
 */
@Resolver(() => ExportAiConversationPayloadDTO)
export class AiConversationExportResolver {
  constructor(
    private readonly exportAiConversationUsecase: ExportAiConversationUsecase,
    private readonly getAiAdminConversationDetailUsecase: GetAiAdminConversationDetailUsecase,
  ) {}

  /** 导出 AI 诊断 PDF（工程师本人／工单权限；管理员按级别范围） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @ValidateInput()
  @Mutation(() => ExportAiConversationPayloadDTO, {
    name: 'exportAiConversation',
  })
  async exportAiConversation(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('input') input: ExportAiConversationInput,
  ): Promise<ExportAiConversationPayloadDTO> {
    const result = await this.exportAiConversationUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      conversationId: input.conversationId,
      contentVersion: input.contentVersion,
      format: input.format,
      technicalAuthorization: input.technicalAuthorization ?? undefined,
    });
    return {
      byteSize: result.content.length,
      contentBase64: result.content.toString('base64'),
      contentVersion: result.contentVersion,
      filename: result.filename,
      format: result.format,
      lastMessageSeq: result.lastMessageSeq,
      mimeType: result.mimeType,
    };
  }

  /** 管理员只读会话问答（一级跨公司；二级本公司；直传外公司 ID 拒绝） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @ValidateInput()
  @Query(() => AiAdminConversationDetailDTO, {
    name: 'aiAdminConversationDetail',
  })
  async aiAdminConversationDetail(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('input') input: AiAdminConversationIdInput,
  ): Promise<AiAdminConversationDetailDTO> {
    const view = await this.getAiAdminConversationDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      conversationId: input.conversationId,
    });
    return {
      contentVersion: view.contentVersion,
      conversationId: view.conversationId,
      createdAt: view.createdAt,
      engineerNickname: view.engineerNickname,
      requestId: view.requestId,
      requestNo: view.requestNo,
      status: view.status,
      turns: view.turns.map((turn) => ({
        analysisContentVersion: turn.analysisContentVersion,
        analysisStatus: turn.analysisStatus,
        failureReason: turn.failureReason,
        question: turn.question,
        answer: turn.answer,
        questionUuid: turn.questionUuid,
        turnNo: turn.turnNo,
      })),
    };
  }
}

/** 仅供类型引用，避免未使用告警 */
export type AiAdminConversationTurnDtoRef = AiAdminConversationTurnDTO;

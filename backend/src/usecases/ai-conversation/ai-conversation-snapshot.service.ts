// src/usecases/ai-conversation/ai-conversation-snapshot.service.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { assertAiAdminConversationReadAccess } from '@core/ai/ai-conversation-read-access.policy';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  resolveAiExportCutoffSeq,
  selectAiExportMessages,
  type AiExportSnapshot,
  type AiExportTurnState,
} from '@src/core/ai/ai-conversation-export.policy';
import { Injectable } from '@nestjs/common';

import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

import {
  resolveAiAdminConversationIdentity,
  resolveAiAdminConversationScope,
} from './admin-ai-conversation-access';
import { assertEngineerAiPermission } from './engineer-ai-access';

/** 工程师昵称缺失回落（与管理员读侧同口径） */
const ENGINEER_NICKNAME_FALLBACK = '工程师';

/**
 * 会话固定范围快照服务（任务 05 · S4.2 / S4.3）
 *
 * 所有「按内容版本读取会话内容」的能力（导出、评价范围契约）共用本服务：
 * - 读取权边界单一真源：工程师（本人／本公司工单）、管理员（一级跨公司、二级本公司）；
 * - 固定内容版本：只取 `contentVersion ≤ 选定版本` 的消息，导出期间新消息不混入；
 * - 不重算模型；失败与未完成轮次如实标记；
 * - 会话不存在与无权访问同口径（不暴露会话是否存在）。
 */
@Injectable()
export class AiConversationSnapshotService {
  constructor(
    private readonly aiConversationQueryService: AiConversationQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly accountQueryService: AccountQueryService,
  ) {}

  /** 读取会话在指定内容版本下的固定范围快照 */
  async resolveReadableSnapshot(params: {
    session: UsecaseSession;
    conversationId: number;
    contentVersion: number;
    /** 动作标签（用于工程师侧拒绝文案） */
    actionLabel?: string;
  }): Promise<AiExportSnapshot> {
    const isAdmin =
      params.session.roles.includes(IdentityTypeEnum.SUPER_ADMIN) &&
      params.session.activeRole === IdentityTypeEnum.SUPER_ADMIN;

    if (!isAdmin) {
      // 工程师：本人／工单权限（与列表详情同一可见性边界）
      assertEngineerAiPermission(params.session, params.actionLabel ?? '读取会话');
      const organizationFact = await this.organizationContextService.tryResolveForAccount({
        accountId: params.session.accountId,
      });
      const detail = await this.aiConversationQueryService.findVisibleDetail({
        conversationId: params.conversationId,
        viewer: {
          accountId: params.session.accountId,
          organizationId: organizationFact?.organizationId ?? null,
        },
      });
      if (detail === null) {
        throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, '会话不存在或无权访问', {
          conversationId: params.conversationId,
        });
      }
      return this.toSnapshot(
        detail,
        params.contentVersion,
        await this.resolveEngineerNickname(detail),
      );
    }

    // 管理员：一级跨公司、二级本公司（外公司直调一律拒绝）
    const deps = {
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    };
    const scope = await resolveAiAdminConversationScope({ session: params.session, deps });
    const admin = await resolveAiAdminConversationIdentity({ session: params.session, deps });
    const detail = await this.aiConversationQueryService.findAdminDetail({
      conversationId: params.conversationId,
      scope,
    });
    if (detail === null) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, '会话不存在或无权访问', {
        conversationId: params.conversationId,
      });
    }
    // 权威读取权复核（core 策略）：与只读详情、导出同一授权边界
    assertAiAdminConversationReadAccess({
      admin,
      conversation: {
        ownerAccountId: detail.ownerAccountId,
        ownerOrganizationId: detail.ownerOrganizationId,
      },
    });
    return this.toSnapshot(
      detail,
      params.contentVersion,
      await this.resolveEngineerNickname(detail),
    );
  }

  /** 会话内容 → 固定范围快照（版本截断 + 轮次状态如实标记） */
  private toSnapshot(
    detail: {
      id: number;
      requestId: number | null;
      requestNo: string;
      contentVersion: number;
      createdAt: Date;
      messages: ReadonlyArray<{
        id: number;
        messageSeq: number;
        turnNo: number | null;
        role: string;
        contentText: string;
        contentVersion: number;
        createdAt: Date;
      }>;
      analyses: ReadonlyArray<{
        questionMessageId: number;
        status: string;
        failureReason: string | null;
      }>;
      /** 消息 ID → 轮次（分析记录经问题消息关联轮次） */
      messageTurnNos?: ReadonlyMap<number, number | null>;
    },
    contentVersion: number,
    engineerNickname: string,
  ): AiExportSnapshot {
    // F05：选定版本必须是「已达成」的版本；高于当前版本说明调用方数据过期，
    // 必须显式拒绝，不能静默降级成当前版本（否则不同调用方拿到不同范围却同名文件）。
    if (contentVersion > detail.contentVersion) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.INVALID_PARAMS,
        '指定的内容版本尚不存在，请刷新后重试',
        {
          conversationId: detail.id,
          requestedContentVersion: contentVersion,
          currentContentVersion: detail.contentVersion,
        },
      );
    }
    const selectedVersion = contentVersion;
    // 轮次状态：分析记录经问题消息的 turn_no 归位（如实标记失败/未完成）
    const messageTurnNos = detail.messageTurnNos ?? new Map<number, number | null>();
    const turnStates = new Map<number, AiExportTurnState>();
    for (const analysis of detail.analyses) {
      const turnNo = messageTurnNos.get(analysis.questionMessageId);
      if (turnNo === undefined || turnNo === null) {
        continue;
      }
      turnStates.set(turnNo, toTurnState(analysis.status));
    }
    const messages = selectAiExportMessages({
      messages: detail.messages.map((message) => ({
        messageId: message.id,
        messageSeq: message.messageSeq,
        turnNo: message.turnNo,
        role: message.role,
        text: message.contentText,
        contentVersion: message.contentVersion,
        createdAt: message.createdAt.toISOString(),
      })),
      contentVersion: selectedVersion,
      turnStates,
    });
    return {
      conversationId: detail.id,
      contentVersion: selectedVersion,
      lastMessageSeq: resolveAiExportCutoffSeq(messages),
      requestId: detail.requestId,
      requestNo: detail.requestNo.length > 0 ? detail.requestNo : null,
      engineerNickname,
      messages,
      createdAt: detail.createdAt.toISOString(),
    };
  }

  /** 归属工程师昵称（缺失时回落「工程师」） */
  private async resolveEngineerNickname(detail: { ownerAccountId?: number }): Promise<string> {
    if (detail.ownerAccountId === undefined) {
      return ENGINEER_NICKNAME_FALLBACK;
    }
    const nicknames = await this.accountQueryService.findNicknamesByAccountIds([
      detail.ownerAccountId,
    ]);
    return nicknames.get(detail.ownerAccountId) ?? ENGINEER_NICKNAME_FALLBACK;
  }
}

/** 分析状态映射为导出轮次状态（如实标记，不美化） */
function toTurnState(status: string): AiExportTurnState {
  if (status === 'SUCCEEDED') {
    return 'SUCCEEDED';
  }
  if (status === 'FAILED') {
    return 'FAILED';
  }
  if (status === 'PENDING') {
    return 'PENDING';
  }
  if (status === 'RUNNING') {
    return 'RUNNING';
  }
  return 'UNKNOWN';
}

// src/usecases/ai-conversation/export-ai-conversation.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';

import {
  buildAiExportFileName,
  buildAiExportRawJson,
  isAiExportContentVersionValid,
} from '@src/core/ai/ai-conversation-export.policy';
import { AI_RAW_JSON_EXPORT_AUTHORIZATION } from './ai-conversation-export-authorization.contract';
import {
  AI_CONVERSATION_EXPORT_RENDERER,
  type AiConversationExportRenderer,
} from './ai-conversation-export-renderer.contract';
import { AiConversationSnapshotService } from './ai-conversation-snapshot.service';

/** 导出格式 */
export type AiConversationExportFormat = 'PDF' | 'RAW_JSON';

/** 导出结果视图 */
export interface AiConversationExportResult {
  readonly format: AiConversationExportFormat;
  readonly filename: string;
  readonly mimeType: string;
  /** 固定的内容版本 */
  readonly contentVersion: number;
  /** 固定范围内的最后消息序号 */
  readonly lastMessageSeq: number;
  /** 文件字节（PDF / JSON） */
  readonly content: Buffer;
}

/** 渲染器端口（infrastructure 实现，避免 usecase 直接依赖渲染实现） */
export type { AiConversationExportRenderer } from './ai-conversation-export-renderer.contract';

/**
 * AI 诊断导出用例（R039-01 / R040-01，任务 05 · S4.2）
 *
 * - 固定本次消息范围和版本 → 校验读取权 → 生成产物；
 * - 版本由调用方显式选定（content_version），服务端不再改写；
 * - 导出期间新消息不混入（只取 contentVersion ≤ 选定版本的消息）；
 * - 不重算模型；未完成或失败轮次如实标记；
 * - 生成失败不返回空文件；
 * - 受控原始 JSON：仅在调用方通过技术授权校验时提供，不做普通用户页面。
 */
@Injectable()
export class ExportAiConversationUsecase {
  constructor(
    private readonly snapshotService: AiConversationSnapshotService,
    @Inject(AI_CONVERSATION_EXPORT_RENDERER)
    private readonly renderer: AiConversationExportRenderer,
    @Inject(AI_RAW_JSON_EXPORT_AUTHORIZATION)
    private readonly rawJsonExportAuthorization: string,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    conversationId: number;
    contentVersion: number;
    format: AiConversationExportFormat;
    /** 受控 JSON 的技术授权凭据（仅 RAW_JSON 需要） */
    technicalAuthorization?: string;
  }): Promise<AiConversationExportResult> {
    if (!Number.isInteger(params.conversationId) || params.conversationId <= 0) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '会话标识必须是正整数', {
        conversationId: params.conversationId,
      });
    }
    if (!isAiExportContentVersionValid(params.contentVersion)) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '内容版本必须是正整数', {
        contentVersion: params.contentVersion,
      });
    }

    const snapshot = await this.snapshotService.resolveReadableSnapshot({
      session: params.session,
      conversationId: params.conversationId,
      contentVersion: params.contentVersion,
      actionLabel: '导出',
    });
    const filename = buildAiExportFileName({
      conversationId: snapshot.conversationId,
      contentVersion: snapshot.contentVersion,
      format: params.format,
    });

    if (params.format === 'RAW_JSON') {
      // 受控技术操作：必须携带与配置一致的技术授权凭据，且不新增业务角色
      this.assertTechnicalAuthorization(params.session, params.technicalAuthorization);
      const content = Buffer.from(JSON.stringify(buildAiExportRawJson(snapshot), null, 2), 'utf-8');
      if (content.length === 0) {
        throw new DomainError(AI_CONVERSATION_ERROR.EXPORT_FAILED, '导出内容为空，请稍后重试');
      }
      return {
        format: params.format,
        filename,
        mimeType: 'application/json',
        contentVersion: snapshot.contentVersion,
        lastMessageSeq: snapshot.lastMessageSeq,
        content,
      };
    }

    const content = await this.renderer.renderPdf(snapshot);
    if (content.length === 0) {
      throw new DomainError(AI_CONVERSATION_ERROR.EXPORT_FAILED, 'PDF 生成失败，请稍后重试');
    }
    return {
      format: params.format,
      filename,
      mimeType: 'application/pdf',
      contentVersion: snapshot.contentVersion,
      lastMessageSeq: snapshot.lastMessageSeq,
      content,
    };
  }

  /** 受控技术授权：需为管理员身份且携带与运行时配置一致的授权凭据 */
  private assertTechnicalAuthorization(
    session: UsecaseSession,
    technicalAuthorization: string | undefined,
  ): void {
    const expected = this.rawJsonExportAuthorization;
    if (
      expected === undefined ||
      expected.length === 0 ||
      technicalAuthorization === undefined ||
      technicalAuthorization !== expected
    ) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.EXPORT_NOT_ALLOWED,
        '原始数据导出需要明确的技术授权',
      );
    }
    const isAdmin =
      session.roles.includes(IdentityTypeEnum.SUPER_ADMIN) &&
      session.activeRole === IdentityTypeEnum.SUPER_ADMIN;
    if (!isAdmin) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.EXPORT_NOT_ALLOWED,
        '原始数据导出仅限受控技术处理',
      );
    }
  }
}

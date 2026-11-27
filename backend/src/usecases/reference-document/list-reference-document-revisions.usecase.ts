// src/usecases/reference-document/list-reference-document-revisions.usecase.ts

import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { resolveReferenceDocumentReadScope } from './reference-document-read-scope';
import { assertDocumentIdValid } from './reference-document-roles';
import {
  ListReferenceDocumentRevisionsCommand,
  ListReferenceDocumentRevisionsResult,
} from './reference-document.types';

/** 修订人昵称缺失时的安全回落展示（与创建人昵称同口径） */
const ACTOR_NICKNAME_FALLBACK = '未知用户';

/**
 * 历史维修记录的修订版本读取（列表 / 详情 / 下载同一可见范围）。
 *
 * - 先经详情读取校验可见性：不存在、下架、归属未确认、软删、跨范围统一 NOT_FOUND；
 * - 返回修订摘要与该版本生效正文（after_snapshot 内容键）：授权追溯可查看旧
 *   管理修订版本的具体内容，而非仅版本号；完整 before/after 快照 JSON 不外发；
 * - 原始冻结报告版本以 `sourceReportVersionId` 表达，由任务 06 冻结版本自身维护版本号。
 */
@Injectable()
export class ListReferenceDocumentRevisionsUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(
    command: ListReferenceDocumentRevisionsCommand,
  ): Promise<ListReferenceDocumentRevisionsResult> {
    assertDocumentIdValid(command.documentId);

    const scope = await resolveReferenceDocumentReadScope({
      session: command.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    const detail = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope,
    });
    const revisions = await this.referenceDocumentQueryService.listRevisions(detail.id);
    // 修订数量有限且重复 ID 由 QueryService 批量查询兜底，不做手工去重
    const actorIds = revisions.map((revision) => revision.actorAccountId);
    const nicknames =
      actorIds.length > 0
        ? await this.accountQueryService.findNicknamesByAccountIds(actorIds)
        : new Map<number, string>();

    return {
      documentId: detail.id,
      currentRevisionNo: detail.effectiveRevisionNo,
      sourceKind: detail.sourceKind,
      sourceReportVersionId: detail.sourceReportVersionId,
      revisions: revisions.map((revision) => ({
        revisionNo: revision.revisionNo,
        reason: revision.reason,
        actorNickname: nicknames.get(revision.actorAccountId) ?? ACTOR_NICKNAME_FALLBACK,
        createdAt: revision.createdAt,
        contentText: revision.contentText,
      })),
    };
  }
}

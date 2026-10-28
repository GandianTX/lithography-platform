// src/usecases/content-submission/list-my-content-submissions.usecase.ts

import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { applyDefaults, enforceMaxPageSize } from '@core/pagination/pagination.policy';
import type { OffsetParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  normalizeOptionalFilterText,
  normalizeSubmissionKindFilter,
  normalizeSubmissionStatusFilter,
} from './content-submission-fields.normalize';
import { assertContentSubmissionAuthorRole } from './content-submission-roles';
import {
  ListMyContentSubmissionsCommand,
  ListMyContentSubmissionsResult,
} from './content-submission.types';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 本人投稿列表用例（A-PR0 §4.1 `myContentSubmissions`）
 *
 * - 仅真实 ENGINEER（精确匹配 activeRole）；
 * - 组织范围经可信组织上下文解析（A-PR0 §2.1）：不取客户端自报，无有效成员
 *   关系/多关系歧义时由 TrustedOrganizationContextQueryService 拒绝；
 * - 仅返回 `submitted_by_account_id + owner_organization_id` 双过滤的本人记录，
 *   无他人记录（读侧不区分「不存在」「他人投稿」「跨组织」的场景由详情接口承担）；
 * - 标题关键字 / 类别 / 状态筛选；空白筛选词视为无筛选；OFFSET 分页，
 *   服务端上限 100；排序口径固定 updated_at DESC, id DESC（口径 7）
 */
@Injectable()
export class ListMyContentSubmissionsUsecase {
  constructor(
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(command: ListMyContentSubmissionsCommand): Promise<ListMyContentSubmissionsResult> {
    assertContentSubmissionAuthorRole(command.session);

    if (command.pagination.mode !== 'OFFSET') {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
        '本人投稿列表第一版仅支持 OFFSET 分页',
        { mode: command.pagination.mode },
      );
    }
    const { page, pageSize, withTotal } = enforceMaxPageSize(
      applyDefaults(command.pagination, {}),
      MAX_PAGE_SIZE,
    ) as OffsetParams;

    // 组织范围先解析：无有效成员关系/多关系歧义在此拒绝，不进入任何投稿查询
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });

    return this.contentSubmissionQueryService.listMine({
      submittedByAccountId: command.session.accountId,
      ownerOrganizationId: membership.organizationId,
      filter: {
        // 空白筛选词先规范化（与前端「空白搜索词=无筛选」口径一致）
        title: normalizeOptionalFilterText(command.filter?.title),
        submissionKind: normalizeSubmissionKindFilter(command.filter?.submissionKind),
        status: normalizeSubmissionStatusFilter(command.filter?.status),
      },
      pagination: { page, pageSize, withTotal: withTotal ?? false },
    });
  }
}

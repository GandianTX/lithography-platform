// src/usecases/content-submission/list-review-queue.usecase.ts

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
import { assertContentSubmissionReviewRole } from './content-submission-roles';
import { ListReviewQueueCommand, ListReviewQueueResult } from './content-submission.types';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 审核队列列表用例（A-PR0 §4.1 `reviewContentSubmissions`）
 *
 * - 仅真实 SUPER_ADMIN（精确匹配 activeRole，ENGINEER 不自动继承审核入口）；
 * - 组织范围经可信组织上下文解析（A-PR0 §2.1）：不取客户端自报，无有效成员
 *   关系/多关系歧义时由 TrustedOrganizationContextQueryService 拒绝；
 * - 仅返回本组织记录（owner_organization_id 单过滤，审核员可见本组织全部投稿）；
 * - 默认待审：status 缺省/空白时按 PENDING_REVIEW（口径 7），可显式筛选其他
 *   状态；标题关键字 / 类别筛选口径与本人列表一致；
 * - 排序口径固定 last_submitted_at DESC, id DESC（口径 7，按最近送审时间）；OFFSET 分页，
 *   服务端上限 100
 */
@Injectable()
export class ListReviewQueueUsecase {
  constructor(
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(command: ListReviewQueueCommand): Promise<ListReviewQueueResult> {
    assertContentSubmissionReviewRole(command.session);

    if (command.pagination.mode !== 'OFFSET') {
      throw new DomainError(
        CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
        '审核队列第一版仅支持 OFFSET 分页',
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

    return this.contentSubmissionQueryService.listReviewQueue({
      ownerOrganizationId: membership.organizationId,
      filter: {
        // 空白筛选词先规范化（与前端「空白搜索词=无筛选」口径一致）
        title: normalizeOptionalFilterText(command.filter?.title),
        submissionKind: normalizeSubmissionKindFilter(command.filter?.submissionKind),
        // 默认待审：未提供/空白视为「待审」筛选，非法值仍按 INVALID_PARAMS 拒绝
        status: normalizeSubmissionStatusFilter(command.filter?.status) ?? 'PENDING_REVIEW',
      },
      pagination: { page, pageSize, withTotal: withTotal ?? false },
    });
  }
}

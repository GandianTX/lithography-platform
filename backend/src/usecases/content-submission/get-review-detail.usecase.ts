// src/usecases/content-submission/get-review-detail.usecase.ts

import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  assertContentSubmissionReviewRole,
  assertSubmissionIdValid,
} from './content-submission-roles';
import { GetReviewDetailCommand, GetReviewDetailResult } from './content-submission.types';

/**
 * 审核详情用例（A-PR0 §4.1 `reviewContentSubmission`）
 *
 * - 仅真实 SUPER_ADMIN（精确匹配 activeRole）；
 * - 组织范围经可信组织上下文解析：本组织外的投稿统一 NOT_FOUND，
 *   不区分「不存在」「跨组织」（不泄露他组织投稿存在性）；
 * - 返回当前待审版本（无版本时为 null）、私有附件安全元数据、完整字段
 *   与历史审核（新在前）；不含存储引用与审核人账号 ID。
 */
@Injectable()
export class GetReviewDetailUsecase {
  constructor(
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(command: GetReviewDetailCommand): Promise<GetReviewDetailResult> {
    assertContentSubmissionReviewRole(command.session);
    assertSubmissionIdValid(command.submissionId);

    // 组织范围先解析：无有效成员关系/多关系歧义在此拒绝，不进入任何投稿查询
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });

    const facts = await this.contentSubmissionQueryService.findSubmissionAccessFacts({
      submissionId: command.submissionId,
    });
    if (facts === null || facts.ownerOrganizationId !== membership.organizationId) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿不存在或不可审核', {
        id: command.submissionId,
      });
    }

    const detail = await this.contentSubmissionQueryService.findReviewDetail({
      submissionId: command.submissionId,
    });
    if (detail === null) {
      // 访问事实已读到而详情缺失：并发删除与读取交错的防御分支，口径与上面一致
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿不存在或不可审核', {
        id: command.submissionId,
      });
    }
    return detail;
  }
}

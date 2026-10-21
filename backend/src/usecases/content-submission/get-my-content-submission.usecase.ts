// src/usecases/content-submission/get-my-content-submission.usecase.ts

import { Injectable } from '@nestjs/common';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  assertContentSubmissionAuthorRole,
  assertSubmissionIdValid,
} from './content-submission-roles';
import {
  GetMyContentSubmissionCommand,
  GetMyContentSubmissionResult,
} from './content-submission.types';

/**
 * 本人投稿详情用例（A-PR0 §4.1 `myContentSubmission`）
 *
 * - 仅真实 ENGINEER（精确匹配 activeRole）；
 * - 组织范围经可信组织上下文解析：不取客户端自报；
 * - 双过滤（投稿人 + 组织）读不到统一 NOT_FOUND，不区分「不存在」「他人投稿」
 *   「跨组织」——同组织其他工程师的投稿也不是公开数据（QueryService 口径）；
 * - 返回当前稿（按类别）、当前状态、最近审核、本人版本入口
 *   （currentRevisionNo + lastSubmittedAt）、已发布正式资料 ID 与可用性；
 *   不含存储引用与审核人账号 ID。
 */
@Injectable()
export class GetMyContentSubmissionUsecase {
  constructor(
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(command: GetMyContentSubmissionCommand): Promise<GetMyContentSubmissionResult> {
    assertContentSubmissionAuthorRole(command.session);
    assertSubmissionIdValid(command.submissionId);

    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });

    return this.contentSubmissionQueryService.findMineDetail({
      submissionId: command.submissionId,
      submittedByAccountId: command.session.accountId,
      ownerOrganizationId: membership.organizationId,
    });
  }
}

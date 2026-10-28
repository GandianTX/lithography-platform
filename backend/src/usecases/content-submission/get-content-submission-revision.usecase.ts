// src/usecases/content-submission/get-content-submission-revision.usecase.ts

import { DomainError, CONTENT_SUBMISSION_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  assertContentSubmissionRevisionReadRole,
  assertRevisionNoValid,
  assertSubmissionIdValid,
  isActiveSuperAdmin,
} from './content-submission-roles';
import {
  GetContentSubmissionRevisionCommand,
  GetContentSubmissionRevisionResult,
} from './content-submission.types';

/**
 * 冻结版本读取用例（A-PR0 §4.1 `contentSubmissionRevision`；S4）
 *
 * - 角色粗筛（ENGINEER / SUPER_ADMIN，hasRole 层级展开）+ 归属精确裁决：
 *   仅「本人 + 本组织」或「本组织管理员」可读；「本组织管理员」判定与审核
 *   链路同口径（activeRole 精确 SUPER_ADMIN），管理员兼工程师账号以工程师
 *   身份操作时不放行他人投稿；同组织其他工程师、跨组织、
 *   不存在目标统一 NOT_FOUND，不区分原因（不能因共用读取方法变成
 *   知道 ID 即可读取）；
 * - 组织范围经可信组织上下文解析，不取客户端自报；
 * - 版本不存在同样收敛 NOT_FOUND（不泄露版本存在性）；
 * - 返回完整内容快照、附件安全元数据（无存储引用/服务器路径）与版本审核记录
 *   （至多一条）；RETURNED 后旧版与当前稿并存，本用例只读冻结版本
 *   （当前稿读取走 myContentSubmission）。
 */
@Injectable()
export class GetContentSubmissionRevisionUsecase {
  constructor(
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(
    command: GetContentSubmissionRevisionCommand,
  ): Promise<GetContentSubmissionRevisionResult> {
    assertContentSubmissionRevisionReadRole(command.session);
    assertSubmissionIdValid(command.submissionId);
    assertRevisionNoValid(command.revisionNo);

    // 组织范围先解析：无有效成员关系/多关系歧义在此拒绝，不进入任何投稿查询
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });

    // 不存在/跨组织/非本人或非本组织管理员统一 NOT_FOUND，不区分原因
    const facts = await this.contentSubmissionQueryService.findSubmissionAccessFacts({
      submissionId: command.submissionId,
    });
    const isSameOrganization =
      facts !== null && facts.ownerOrganizationId === membership.organizationId;
    const isSubmitter = facts !== null && facts.submittedByAccountId === command.session.accountId;
    const isSuperAdmin = isActiveSuperAdmin(command.session);
    if (!isSameOrganization || !(isSubmitter || isSuperAdmin)) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿版本不存在或不可访问', {
        submissionId: command.submissionId,
      });
    }

    // 归属裁决通过后才读版本；版本缺失同样 NOT_FOUND（不泄露存在性）
    const revision = await this.contentSubmissionQueryService.findRevisionView({
      submissionId: command.submissionId,
      revisionNo: command.revisionNo,
    });
    if (!revision) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿版本不存在或不可访问', {
        submissionId: command.submissionId,
        revisionNo: command.revisionNo,
      });
    }
    return revision;
  }
}

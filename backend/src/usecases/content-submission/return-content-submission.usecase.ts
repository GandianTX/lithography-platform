// src/usecases/content-submission/return-content-submission.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Inject, Injectable } from '@nestjs/common';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import { normalizeReviewComment } from './content-submission-fields.normalize';
import { lockReviewableSubmissionAndAssertRevision } from './content-submission-review-guard';
import {
  assertContentSubmissionReviewRole,
  assertRevisionIdValid,
  assertSubmissionIdValid,
} from './content-submission-roles';
import {
  ContentSubmissionReviewDecisionResult,
  ReturnContentSubmissionCommand,
} from './content-submission.types';

/**
 * 退回待审投稿用例（A-PR0 §4.1 `reviewContentSubmissionDecision` 的 RETURN 分支；S4）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 SUPER_ADMIN（精确匹配 activeRole；ENGINEER/CUSTOMER
 *    拒绝，管理员不自动继承投稿写入口，投稿人也不可审核）
 * 2. 输入决策：退回理由必填、trim 后 1-2000 字符（§2.3「审核」行）
 * 3. 事务内持投稿行锁后裁决（审核统一守卫）：不存在/跨组织统一 NOT_FOUND；
 *    仅 PENDING_REVIEW 可退回；revisionId 必须属于该投稿且等于当前待审版本
 *    （不匹配统一 STATE_NOT_EDITABLE，不泄露版本存在性）
 * 4. 审核记录（decision=RETURN、publishAttachment=false、理由落库）与主状态
 *    流转 RETURNED 同事务：current_revision_no / last_submitted_at / published_at
 *    均不回写——旧版快照保留供历史读取，重提将由送审用例新建下一版本；
 *    当前稿（明细/附件）恢复可编辑
 * 5. 回读真实落库状态返回；退回不产生正式资料，documentId 恒为 null
 */
@Injectable()
export class ReturnContentSubmissionUsecase {
  constructor(
    private readonly contentSubmissionService: ContentSubmissionService,
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: ReturnContentSubmissionCommand,
  ): Promise<ContentSubmissionReviewDecisionResult> {
    assertContentSubmissionReviewRole(command.session);
    assertSubmissionIdValid(command.submissionId);
    assertRevisionIdValid(command.revisionId);
    const comment = normalizeReviewComment(command.comment);

    return this.transactionRunner.run((transactionContext) =>
      this.doReturn(command, comment, transactionContext),
    );
  }

  /** 事务内执行：行锁 + 版本核对 → 审核记录 → 状态流转 → 回读 */
  private async doReturn(
    command: ReturnContentSubmissionCommand,
    comment: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ContentSubmissionReviewDecisionResult> {
    await lockReviewableSubmissionAndAssertRevision({
      contentSubmissionService: this.contentSubmissionService,
      contentSubmissionQueryService: this.contentSubmissionQueryService,
      organizationContextService: this.organizationContextService,
      accountId: command.session.accountId,
      submissionId: command.submissionId,
      revisionId: command.revisionId,
      transactionContext,
    });

    await this.contentSubmissionService.insertReview(
      {
        submissionId: command.submissionId,
        revisionId: command.revisionId,
        decision: 'RETURN',
        reviewedByAccountId: command.session.accountId,
        comment,
        publishAttachment: false,
      },
      transactionContext,
    );

    await this.contentSubmissionService.markSubmissionReturned({
      submissionId: command.submissionId,
      transactionContext,
    });

    const status = await this.contentSubmissionQueryService.readStatusSnapshot({
      submissionId: command.submissionId,
      transactionContext,
    });

    return {
      submissionId: command.submissionId,
      status: status.status,
      documentId: null,
    };
  }
}

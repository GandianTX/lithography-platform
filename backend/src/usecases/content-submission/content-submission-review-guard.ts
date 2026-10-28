// src/usecases/content-submission/content-submission-review-guard.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import type { ContentSubmissionLockSnapshot } from '@src/modules/lithography/content-submission.types';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * 审核动作（退回/通过）的统一入口守卫：
 * 组织解析 → 投稿行锁读取 → 本组织归属裁决 → 待审状态裁决 → 目标版本核对。
 *
 * - 调用方须先行完成角色精确断言（仅真实 SUPER_ADMIN）；本守卫只做组织与
 *   资源归属裁决，角色断言不因共用而放宽；
 * - 不存在/跨组织统一 NOT_FOUND（不泄露存在性；第二组织管理员即使持有
 *   SUPER_ADMIN 角色也不能读取/审核甲方数据）；
 * - 仅 PENDING_REVIEW 可审核（DRAFT/RETURNED/PUBLISHED 统一
 *   STATE_NOT_EDITABLE）；
 * - revisionId 必须属于该投稿且等于当前版本号（不匹配统一 STATE_NOT_EDITABLE——
 *   不区分「版本不存在/旧版本/他人版本」，避免泄露版本存在性与并发窗口细节）；
 * - 行锁把「重核状态 + 核对版本」与后续审核写入串行化（A-PR0 §3.3）：
 *   并发审核同一版本最多一次成功，后来者在锁内看到已流转的状态被拒绝；
 * - 必须与审核写入使用同一 transactionContext，否则行锁立即释放、串行化失效。
 */
export async function lockReviewableSubmissionAndAssertRevision(params: {
  contentSubmissionService: ContentSubmissionService;
  contentSubmissionQueryService: ContentSubmissionQueryService;
  organizationContextService: TrustedOrganizationContextQueryService;
  accountId: number;
  submissionId: number;
  revisionId: number;
  transactionContext: PersistenceTransactionContext;
}): Promise<{ lock: ContentSubmissionLockSnapshot; revisionNo: number }> {
  const membership = await params.organizationContextService.resolveForAccount({
    accountId: params.accountId,
    transactionContext: params.transactionContext,
  });

  const lock = await params.contentSubmissionService.lockSubmissionForWrite(
    params.submissionId,
    params.transactionContext,
  );
  if (lock === null || lock.ownerOrganizationId !== membership.organizationId) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿不存在或不可审核', {
      id: params.submissionId,
    });
  }
  if (lock.status !== 'PENDING_REVIEW') {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE, '当前状态的投稿不可审核', {
      id: params.submissionId,
      status: lock.status,
    });
  }

  const identity = await params.contentSubmissionQueryService.findRevisionIdentity({
    submissionId: params.submissionId,
    revisionId: params.revisionId,
    transactionContext: params.transactionContext,
  });
  if (identity === null || identity.revisionNo !== lock.currentRevisionNo) {
    throw new DomainError(
      CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
      '目标版本不是当前待审版本，不能审核',
      { id: params.submissionId, revisionId: params.revisionId },
    );
  }
  return { lock, revisionNo: identity.revisionNo };
}

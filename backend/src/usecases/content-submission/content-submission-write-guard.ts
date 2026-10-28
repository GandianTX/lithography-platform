// src/usecases/content-submission/content-submission-write-guard.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  CONTENT_SUBMISSION_EDITABLE_STATUSES,
  type ContentSubmissionLockSnapshot,
} from '@src/modules/lithography/content-submission.types';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * 状态敏感写动作的统一入口守卫（草稿更新、附件上传/替换、附件移除共用）：
 * 组织解析 → 投稿行锁读取 → 归属裁决 → 可编辑状态裁决。
 *
 * - 不存在 / 他人投稿 / 跨组织统一 NOT_FOUND（不泄露存在性，
 *   同组织其他工程师的投稿也不是可写数据）；
 * - 仅 DRAFT / RETURNED 可编辑，PENDING_REVIEW 只读、PUBLISHED 不可改稿
 *   （STATE_NOT_EDITABLE）——行锁把「校验当前状态」与「后续写入」串行化
 *   （A-PR0 §3.3），并发送审后仍写草稿/附件不会穿透；
 * - 组织与账号均取自可信来源：组织经成员事实解析、账号取自 Session，
 *   不接受客户端自报归属。
 *
 * 返回行锁快照供调用方继续裁决（如类别与字段匹配、附件与投稿绑定）；
 * 函数必须在 TransactionRunner 事务内、且后续写入使用同一 transactionContext
 * 调用，否则行锁立即释放、串行化失效。
 */
export async function lockEditableSubmissionForAuthor(params: {
  contentSubmissionService: ContentSubmissionService;
  organizationContextService: TrustedOrganizationContextQueryService;
  accountId: number;
  submissionId: number;
  transactionContext: PersistenceTransactionContext;
}): Promise<ContentSubmissionLockSnapshot> {
  const membership = await params.organizationContextService.resolveForAccount({
    accountId: params.accountId,
    transactionContext: params.transactionContext,
  });

  const lock = await params.contentSubmissionService.lockSubmissionForWrite(
    params.submissionId,
    params.transactionContext,
  );
  if (
    lock === null ||
    lock.submittedByAccountId !== params.accountId ||
    lock.ownerOrganizationId !== membership.organizationId
  ) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿不存在或不可访问', {
      id: params.submissionId,
    });
  }
  if (!CONTENT_SUBMISSION_EDITABLE_STATUSES.includes(lock.status)) {
    throw new DomainError(CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE, '当前状态的投稿不可编辑', {
      id: params.submissionId,
      status: lock.status,
    });
  }
  return lock;
}

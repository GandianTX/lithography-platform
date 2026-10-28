// src/usecases/content-submission/remove-content-submission-attachment.usecase.ts

import { Inject, Injectable } from '@nestjs/common';

import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import {
  assertContentSubmissionAuthorRole,
  assertSubmissionIdValid,
} from './content-submission-roles';
import { lockEditableSubmissionForAuthor } from './content-submission-write-guard';
import { RemoveContentSubmissionAttachmentCommand } from './content-submission.types';

/**
 * 移除投稿当前附件用例（A-PR0 §4.2 `DELETE /api/content-submissions/:id/attachment`）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 ENGINEER（精确匹配 activeRole，与草稿链路同一断言）
 * 2. 事务内持投稿行锁后裁决：不存在/他人投稿/跨组织统一 NOT_FOUND；
 *    仅 DRAFT/RETURNED 可移除（STATE_NOT_EDITABLE）——锁把状态检查与
 *    退役动作串行化，并发送审后移除不会穿透
 * 3. 退役当前附件（先退役语义归写服务）：只改变数据库标记与退役时间，
 *    不删除存储文件——历史冻结版本引用的原件保留（A-PR0 §3.3）；
 *    无 CURRENT 附件时幂等成功（重复请求/双击不报错）
 */
@Injectable()
export class RemoveContentSubmissionAttachmentUsecase {
  constructor(
    private readonly contentSubmissionService: ContentSubmissionService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: RemoveContentSubmissionAttachmentCommand): Promise<void> {
    assertContentSubmissionAuthorRole(command.session);
    assertSubmissionIdValid(command.submissionId);

    await this.transactionRunner.run(async (transactionContext) => {
      await lockEditableSubmissionForAuthor({
        contentSubmissionService: this.contentSubmissionService,
        organizationContextService: this.organizationContextService,
        accountId: command.session.accountId,
        submissionId: command.submissionId,
        transactionContext,
      });

      await this.contentSubmissionService.retireCurrentAttachment({
        submissionId: command.submissionId,
        transactionContext,
      });
    });
  }
}

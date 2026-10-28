// src/usecases/content-submission/submit-content-submission.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import {
  assertFaultCaseSubmittable,
  assertMaterialSubmittable,
  assertResolutionWhenResolved,
} from './content-submission-fields.normalize';
import {
  assertContentSubmissionAuthorRole,
  assertSubmissionIdValid,
} from './content-submission-roles';
import { lockEditableSubmissionForAuthor } from './content-submission-write-guard';
import {
  CONTENT_SUBMISSION_LIBRARY_NOTICE_VERSION,
  ContentSubmissionSubmitResult,
  SubmitContentSubmissionCommand,
} from './content-submission.types';

/** 冻结快照中间产物：业务字段完整快照 + 标题快照（均不含存储引用与服务器路径） */
type SubmissionSnapshot = {
  titleSnapshot: string;
  payloadSnapshot: Record<string, unknown>;
};

/**
 * 送审/重提用例（A-PR0 §4.1 `submitContentSubmission`；S4）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 ENGINEER（精确匹配 activeRole，与草稿链路同一断言）
 * 2. 输入决策：投稿 ID 正整数；入库告知未确认为 true 拒绝送审
 *    （告知版本由服务端固定，不接受客户端传入）
 * 3. 事务内持投稿行锁后裁决（与草稿/附件写路径共用统一守卫）：
 *    不存在/他人投稿/跨组织统一 NOT_FOUND；仅 DRAFT/RETURNED 可送审
 *    （PENDING_REVIEW 重复送审、并发重复送审的后来者在行锁内一律
 *    STATE_NOT_EDITABLE——不会在待审状态继续生成新版本，最多一次成功）
 * 4. 版本号在锁内裁决：revisionNo = currentRevisionNo + 1
 *    （首次送审 1；退回后重提新建下一版，旧版保留）
 * 5. 读事务内明细事实与当次真实 CURRENT 附件，在最终态上做送审完整校验
 *    （§2.3：资料标题/类型必填且正文与附件至少一项；案例标题/现象/复现步骤/
 *    处理状态必填、已解决必须有结果），快照附件 ID 来自真实附件事实，
 *    客户端不能自报附件/版本/审核状态；
 * 6. 冻结新版本（payload 完整快照 + 标题快照 + 告知版本/确认人/确认时间
 *    服务端落库）→ 主状态流转 PENDING_REVIEW（revision_no / last_submitted_at
 *    同事务更新）→ 回读真实落库状态返回
 */
@Injectable()
export class SubmitContentSubmissionUsecase {
  constructor(
    private readonly contentSubmissionService: ContentSubmissionService,
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: SubmitContentSubmissionCommand): Promise<ContentSubmissionSubmitResult> {
    assertContentSubmissionAuthorRole(command.session);
    assertSubmissionIdValid(command.submissionId);
    if (command.libraryNoticeConfirmed !== true) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.INVALID_PARAMS, '送审前请确认入库告知');
    }

    return this.transactionRunner.run((transactionContext) =>
      this.doSubmit(command, transactionContext),
    );
  }

  /** 事务内执行：行锁裁决 → 版本号 → 校验与快照 → 冻结 → 状态流转 → 回读 */
  private async doSubmit(
    command: SubmitContentSubmissionCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ContentSubmissionSubmitResult> {
    const lock = await lockEditableSubmissionForAuthor({
      contentSubmissionService: this.contentSubmissionService,
      organizationContextService: this.organizationContextService,
      accountId: command.session.accountId,
      submissionId: command.submissionId,
      transactionContext,
    });

    const revisionNo = lock.currentRevisionNo + 1;

    // 快照附件事实：两类均按「当次真实 CURRENT 附件」冻结（无则为 null）；
    // 资料品类的「正文或附件至少一项」依赖该事实而非客户端声明
    const currentAttachment =
      await this.contentSubmissionQueryService.readCurrentAttachmentsForSubmit({
        submissionId: command.submissionId,
        transactionContext,
      });

    const snapshot =
      lock.submissionKind === 'MATERIAL'
        ? await this.buildMaterialSnapshot(
            command.submissionId,
            currentAttachment !== null,
            transactionContext,
          )
        : await this.buildFaultCaseSnapshot(command.submissionId, transactionContext);

    const { revisionId } = await this.contentSubmissionService.insertRevision(
      {
        submissionId: command.submissionId,
        revisionNo,
        payloadSnapshot: snapshot.payloadSnapshot,
        schemaVersion: 1,
        titleSnapshot: snapshot.titleSnapshot,
        attachmentId: currentAttachment === null ? null : currentAttachment.attachmentId,
        noticeVersion: CONTENT_SUBMISSION_LIBRARY_NOTICE_VERSION,
        confirmedByAccountId: command.session.accountId,
      },
      transactionContext,
    );

    await this.contentSubmissionService.markSubmissionPendingReview({
      submissionId: command.submissionId,
      revisionNo,
      transactionContext,
    });

    const status = await this.contentSubmissionQueryService.readStatusSnapshot({
      submissionId: command.submissionId,
      transactionContext,
    });

    return {
      submissionId: command.submissionId,
      revisionId,
      revisionNo,
      status: status.status,
    };
  }

  /** 普通资料：送审完整校验 → 6 字段完整快照（显式列举，不混入内部列） */
  private async buildMaterialSnapshot(
    submissionId: number,
    hasCurrentAttachment: boolean,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SubmissionSnapshot> {
    const detail = await this.contentSubmissionQueryService.readMaterialDetailForWrite({
      submissionId,
      transactionContext,
    });
    assertMaterialSubmittable(detail, hasCurrentAttachment);
    return {
      titleSnapshot: detail.title,
      payloadSnapshot: {
        title: detail.title,
        documentType: detail.documentType,
        equipmentModelId: detail.equipmentModelId,
        equipmentModelText: detail.equipmentModelText,
        description: detail.description,
        contentText: detail.contentText,
      },
    };
  }

  /** 故障案例：送审完整校验 → 11 字段完整快照（显式列举，不混入内部列） */
  private async buildFaultCaseSnapshot(
    submissionId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SubmissionSnapshot> {
    const detail = await this.contentSubmissionQueryService.readFaultCaseDetailForWrite({
      submissionId,
      transactionContext,
    });
    assertFaultCaseSubmittable(detail);
    assertResolutionWhenResolved(detail);
    return {
      titleSnapshot: detail.title,
      payloadSnapshot: {
        title: detail.title,
        equipmentModelId: detail.equipmentModelId,
        equipmentModelText: detail.equipmentModelText,
        errorCode: detail.errorCode,
        phenomenon: detail.phenomenon,
        conditionText: detail.conditionText,
        reproductionSteps: detail.reproductionSteps,
        diagnosis: detail.diagnosis,
        actionTaken: detail.actionTaken,
        handlingStatus: detail.handlingStatus,
        resolution: detail.resolution,
      },
    };
  }
}

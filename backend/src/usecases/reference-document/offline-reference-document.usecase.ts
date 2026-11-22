// src/usecases/reference-document/offline-reference-document.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { ReferenceDocumentRevisionService } from '@src/modules/lithography/reference-document-revision.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  assertDocumentIdValid,
  assertReferenceDocumentFirstLevelAdmin,
} from './reference-document-roles';
import {
  assertExpectedRevisionNo,
  buildRevisionSnapshots,
  resolveEffectiveContentText,
  resolveEffectiveStructuredContent,
  structuredSnapshotValueOrNull,
} from './reference-document-management.helpers';
import {
  assertExpectedVersionInput,
  type OfflineReferenceDocumentCommand,
  type ReferenceDocumentManagedMutationResult,
} from './reference-document.types';
import { assertManagementReason } from './reference-document-fields.normalize';

/**
 * 下架正式资料用例（任务 07 R059，页面 §9.3）。
 *
 * 业务流程：
 * 1. 角色决策：仅一级管理员；二级管理员与工程师一律权限拒绝。
 * 2. 资源决策：事务内 GLOBAL 范围 + FOR UPDATE 锁定读，仅 ONLINE + CONFIRMED +
 *    未软删的正式资料可下架（已下架对普通口径不可见，统一 NOT_FOUND，不泄露状态）；
 *    版本核对 expected_version，过期拒绝。
 * 3. 事务内原子提交：追加修订行（业务历史，快照继承当前生效正文）→ 条件推进
 *    current_revision_no 并置 publication_status = OFFLINE。
 *
 * 与删除的关键区别（页面 §9.3）：下架不写三类关键操作记录、不清来源或有效原件，
 * 只保留业务历史；恢复口径由后续任务另行处理，本入口不提供恢复。
 */
@Injectable()
export class OfflineReferenceDocumentUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly revisionService: ReferenceDocumentRevisionService,
    private readonly accountQueryService: AccountQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: OfflineReferenceDocumentCommand,
  ): Promise<ReferenceDocumentManagedMutationResult> {
    await assertReferenceDocumentFirstLevelAdmin({
      session: command.session,
      accountQueryService: this.accountQueryService,
    });
    assertDocumentIdValid(command.documentId);
    assertExpectedVersionInput(command.expectedVersion);
    const reason = assertManagementReason(command.reason);

    return this.transactionRunner.run((transactionContext) =>
      this.doOffline(command, reason, transactionContext),
    );
  }

  private async doOffline(
    command: OfflineReferenceDocumentCommand,
    reason: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentManagedMutationResult> {
    const current = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope: { kind: 'GLOBAL' },
      transactionContext,
      forUpdate: true,
    });
    assertExpectedRevisionNo(current, command.expectedVersion);

    // 业务历史快照继承当时生效正文：之后读取（CURRENT_REVISION）不回退原报告
    const effectiveText = await resolveEffectiveContentText(current, {
      referenceDocumentQueryService: this.referenceDocumentQueryService,
      maintenanceReportQueryService: this.maintenanceReportQueryService,
    });
    const effectiveStructured = await resolveEffectiveStructuredContent(current, {
      referenceDocumentQueryService: this.referenceDocumentQueryService,
      maintenanceReportQueryService: this.maintenanceReportQueryService,
    });
    const { beforeSnapshot, afterSnapshot } = buildRevisionSnapshots({
      detail: current,
      beforeContentText: effectiveText,
      afterContentText: effectiveText,
      beforeStructuredReport: structuredSnapshotValueOrNull(effectiveStructured),
      afterStructuredReport: structuredSnapshotValueOrNull(effectiveStructured),
      overrides: { publicationStatus: 'OFFLINE' },
    });

    const nextRevisionNo = command.expectedVersion + 1;
    await this.revisionService.insertRevision(
      {
        documentId: command.documentId,
        revisionNo: nextRevisionNo,
        beforeSnapshot,
        afterSnapshot,
        actorAccountId: command.session.accountId,
        reason,
      },
      transactionContext,
    );

    const outcome = await this.revisionService.advanceCurrentRevision(
      {
        documentId: command.documentId,
        expectedRevisionNo: command.expectedVersion,
        apply: {
          publicationStatus: 'OFFLINE',
          updatedByAccountId: command.session.accountId,
        },
      },
      transactionContext,
    );
    if (outcome !== 'ADVANCED') {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT,
        '参考资料版本已更新，请重新读取当前版本后重试',
        { id: command.documentId },
      );
    }

    return { id: command.documentId, revisionNo: nextRevisionNo };
  }
}

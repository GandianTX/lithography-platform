// src/usecases/reference-document/admin-delete-reference-document.usecase.ts

import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
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
  type AdminDeleteReferenceDocumentCommand,
  type ReferenceDocumentManagedMutationResult,
} from './reference-document.types';
import { assertManagementReason } from './reference-document-fields.normalize';

/**
 * 管理删除正式资料用例（任务 07 R060，页面 §9.3）。
 *
 * 业务流程：
 * 1. 角色决策：仅一级管理员；不为二级增加删除他人资料权限（页面 §9.3 限制）。
 * 2. 资源决策：事务内 GLOBAL 范围 + FOR UPDATE 锁定读，写路径谓词（未软删），
 *    下架资料仍可删除；版本核对 expected_version，过期拒绝。
 * 3. 事务内原子提交：追加修订行（快照记录删除前生效正文）→ 条件推进
 *    current_revision_no 并同语句写入 deprecated + deleted_at + OFFLINE
 *    （满足删除一致性 CHECK）→ 同事务写 ADMIN_DELETE_DOCUMENT 关键审计。
 *    审计插入失败由事务整体回滚，不返回成功。
 *
 * 边界（页面 §9.3 / R060）：不物理 DELETE 来源工单、报告、历史或仍被有效业务
 * 引用的原件；不新增回收站；删除后普通列表、旧地址与资料下载统一拒绝。
 */
@Injectable()
export class AdminDeleteReferenceDocumentUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly revisionService: ReferenceDocumentRevisionService,
    private readonly managementAuditService: ManagementAuditService,
    private readonly accountQueryService: AccountQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: AdminDeleteReferenceDocumentCommand,
  ): Promise<ReferenceDocumentManagedMutationResult> {
    await assertReferenceDocumentFirstLevelAdmin({
      session: command.session,
      accountQueryService: this.accountQueryService,
    });
    assertDocumentIdValid(command.documentId);
    assertExpectedVersionInput(command.expectedVersion);
    const reason = assertManagementReason(command.reason);

    return this.transactionRunner.run((transactionContext) =>
      this.doDelete(command, reason, transactionContext),
    );
  }

  private async doDelete(
    command: AdminDeleteReferenceDocumentCommand,
    reason: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentManagedMutationResult> {
    const current = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope: { kind: 'GLOBAL' },
      transactionContext,
      forUpdate: true,
      includeUnpublished: true,
    });
    assertExpectedRevisionNo(current, command.expectedVersion);
    // 恢复期写入冻结：资料归属公司数据区正在恢复时不得管理删除
    await this.localWriteHoldService.assertBusinessWritable({
      organizationId: current.ownerOrganizationId,
    });

    // 删除前生效正文进入快照：授权的历史追溯仍可读回删除前内容
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
      overrides: { publicationStatus: 'OFFLINE', deleted: true },
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
          markDeleted: true,
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

    // 关键审计与业务变更同事务：ADMIN_DELETE_DOCUMENT（任务 10 消费）
    await this.managementAuditService.appendDocumentEvent({
      actorAccountId: command.session.accountId,
      actorAdminLevel: 1,
      organizationId: current.ownerOrganizationId,
      operation: 'ADMIN_DELETE_DOCUMENT',
      targetDocumentId: command.documentId,
      transactionContext,
      reason,
    });

    return { id: command.documentId, revisionNo: nextRevisionNo };
  }
}

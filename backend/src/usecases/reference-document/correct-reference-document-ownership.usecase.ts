// src/usecases/reference-document/correct-reference-document-ownership.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
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
  type CorrectReferenceDocumentOwnershipCommand,
  type ReferenceDocumentManagedMutationResult,
} from './reference-document.types';
import { assertManagementReason } from './reference-document-fields.normalize';

/**
 * 保存资料归属更正用例（任务 07 R061-02，页面 §9.4）。
 *
 * 业务流程：
 * 1. 角色决策：仅一级管理员可查看和修正待确认归属，二级无权（R061 权限结论）。
 * 2. 输入决策：核实原因必填；created_by_account_id / owner_organization_id
 *    仅提交需要更正的字段，两个字段都未提交时拒绝。
 * 3. 事实校验：更正目标账号必须真实存在；更正公司必须真实存在；
 *    更换上传者不自动采用其当前公司（R061 异常边界）。
 * 4. 资源决策：事务内 GLOBAL 范围 + FOR UPDATE 锁定读，写路径谓词（未软删），
 *    归属待核实（PENDING）条目同样可更正；版本核对 expected_version。
 * 5. 事务内原子提交：仅 UPDATE 显式更正字段（其他值保留）→ 追加修订行
 *    （前后值、操作者、核实原因）→ 条件推进 current_revision_no →
 *    同事务写 CORRECT_DOCUMENT_OWNERSHIP 关键审计（含字段级前后值摘要）。
 *
 * 归属核实状态（R061）：ownership_status 只依据核实证据更新——上传者与
 * 上传时公司两项均被显式更正时才置 CONFIRMED；单项更正保留原状态，
 * 未核实项不因表单默认值变成已确认。
 */
@Injectable()
export class CorrectReferenceDocumentOwnershipUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly revisionService: ReferenceDocumentRevisionService,
    private readonly managementAuditService: ManagementAuditService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: CorrectReferenceDocumentOwnershipCommand,
  ): Promise<ReferenceDocumentManagedMutationResult> {
    await assertReferenceDocumentFirstLevelAdmin({
      session: command.session,
      accountQueryService: this.accountQueryService,
    });
    assertDocumentIdValid(command.documentId);
    assertExpectedVersionInput(command.expectedVersion);
    const reason = assertManagementReason(command.verificationReason);
    assertCorrectionHasField(command);

    return this.transactionRunner.run((transactionContext) =>
      this.doCorrect(command, reason, transactionContext),
    );
  }

  private async doCorrect(
    command: CorrectReferenceDocumentOwnershipCommand,
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

    const correctUploader = command.createdByAccountId !== undefined;
    const correctOrganization = command.ownerOrganizationId !== undefined;

    if (correctUploader) {
      const account = await this.accountQueryService.findAccountSnapshotById({
        accountId: command.createdByAccountId as number,
        transactionContext,
      });
      if (account === null) {
        throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正目标上传者账号不存在', {
          createdByAccountId: command.createdByAccountId,
        });
      }
    }
    if (correctOrganization) {
      const organization = await this.organizationQueryService.findOrganizationNameById({
        organizationId: command.ownerOrganizationId as number,
        transactionContext,
      });
      if (organization === null) {
        throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正目标公司不存在', {
          ownerOrganizationId: command.ownerOrganizationId,
        });
      }
    }

    // 核实证据完整（两项均显式更正）才允许确认归属；单项更正保留原核实状态
    const nextOwnershipStatus =
      correctUploader && correctOrganization ? ('CONFIRMED' as const) : undefined;

    // 快照继承当时生效正文：归属修订不让正文回退原报告或旧版
    const effectiveText = await resolveEffectiveContentText(current, {
      referenceDocumentQueryService: this.referenceDocumentQueryService,
      maintenanceReportQueryService: this.maintenanceReportQueryService,
    });
    const overrides: Record<string, unknown> = {};
    if (correctUploader) overrides.createdByAccountId = command.createdByAccountId;
    if (correctOrganization) overrides.ownerOrganizationId = command.ownerOrganizationId;
    if (nextOwnershipStatus !== undefined) overrides.ownershipStatus = nextOwnershipStatus;

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
      overrides,
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
          ...(correctUploader ? { createdByAccountId: command.createdByAccountId } : {}),
          ...(correctOrganization ? { ownerOrganizationId: command.ownerOrganizationId } : {}),
          ...(nextOwnershipStatus !== undefined ? { ownershipStatus: nextOwnershipStatus } : {}),
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

    // 关键审计与业务变更同事务：字段级前后值摘要（仅标量 ID/状态，不含正文）
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (correctUploader) {
      changes.createdByAccountId = {
        from: current.createdByAccountId,
        to: command.createdByAccountId,
      };
    }
    if (correctOrganization) {
      changes.ownerOrganizationId = {
        from: current.ownerOrganizationId,
        to: command.ownerOrganizationId,
      };
    }
    if (nextOwnershipStatus !== undefined) {
      changes.ownershipStatus = { from: current.ownershipStatus, to: nextOwnershipStatus };
    }

    await this.managementAuditService.appendDocumentEvent({
      actorAccountId: command.session.accountId,
      actorAdminLevel: 1,
      organizationId: command.ownerOrganizationId ?? current.ownerOrganizationId,
      operation: 'CORRECT_DOCUMENT_OWNERSHIP',
      targetDocumentId: command.documentId,
      transactionContext,
      reason,
      changes,
    });

    return { id: command.documentId, revisionNo: nextRevisionNo };
  }
}

function assertCorrectionHasField(command: CorrectReferenceDocumentOwnershipCommand): void {
  const hasUploader = command.createdByAccountId !== undefined;
  const hasOrganization = command.ownerOrganizationId !== undefined;
  if (!hasUploader && !hasOrganization) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      '归属更正至少需要更正上传者或上传时公司其中一项',
    );
  }
  if (
    hasUploader &&
    (!Number.isInteger(command.createdByAccountId) || (command.createdByAccountId as number) <= 0)
  ) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正上传者账号 ID 无效', {
      createdByAccountId: command.createdByAccountId,
    });
  }
  if (
    hasOrganization &&
    (!Number.isInteger(command.ownerOrganizationId) || (command.ownerOrganizationId as number) <= 0)
  ) {
    throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正公司 ID 无效', {
      ownerOrganizationId: command.ownerOrganizationId,
    });
  }
}

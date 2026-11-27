// src/usecases/reference-document/soft-delete-reference-document.usecase.ts

import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { IdentityTypeEnum } from '@app-types/models/account.types';
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
  assertReferenceDocumentAuthorDeleteRole,
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
  type ReferenceDocumentMutationResult,
  type SoftDeleteReferenceDocumentCommand,
} from './reference-document.types';

/**
 * 原作者删除本人正式资料用例（任务 07 R053，页面 §9.2）。
 *
 * 任务 07 改造说明：旧「SUPER_ADMIN 本组织即可删」权限不再沿用（计划 §3.3）。
 * 新口径：
 * 1. 角色决策：工程师或管理员（作为原作者）可删除；CUSTOMER 拒绝。
 * 2. 归属决策：AUTHOR 范围（createdByAccountId = 会话账号）——原作者只删自己
 *    条目，不编辑正式正文、不删他人；他人条目（含管理员看他人）统一 NOT_FOUND。
 *    归属更正可能把条目迁到其他公司，作者身份不随组织变化，故不按组织收敛。
 * 3. 版本决策：expected_version 必须与 current_revision_no 一致，过期拒绝。
 * 4. 事务内原子提交：追加修订行（快照保留删除前生效正文与删除事实）→ 条件推进
 *    current_revision_no 并同语句写入 deprecated + deleted_at + OFFLINE
 *    （满足删除一致性 CHECK）→ 不物理 DELETE 来源工单、报告或有效原件。
 * 5. 审计决策（R089 / 页面 §9.2）：管理员作为原作者删除时，同事务补写
 *    ADMIN_DELETE_DOCUMENT 关键记录（等级取账号当前事实）；普通作者保留
 *    删除业务历史（修订行），不写关键审计。
 *
 * 不存在与已软删统一 NOT_FOUND，不泄露删除状态（既有验收口径不变）。
 */
@Injectable()
export class SoftDeleteReferenceDocumentUsecase {
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
    command: SoftDeleteReferenceDocumentCommand,
  ): Promise<ReferenceDocumentMutationResult> {
    assertReferenceDocumentAuthorDeleteRole(
      command.session.roles,
      command.session.activeRole ?? '',
    );
    assertDocumentIdValid(command.documentId);
    assertExpectedVersionInput(command.expectedVersion);

    return this.transactionRunner.run((transactionContext) =>
      this.doDelete(command, transactionContext),
    );
  }

  private async doDelete(
    command: SoftDeleteReferenceDocumentCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentMutationResult> {
    // AUTHOR 范围：跨作者目标与不存在/已软删统一 NOT_FOUND，不泄露存在性
    const current = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope: { kind: 'AUTHOR', accountId: command.session.accountId },
      transactionContext,
      forUpdate: true,
      includeUnpublished: true,
    });
    assertExpectedRevisionNo(current, command.expectedVersion);
    // 恢复期写入冻结：资料归属公司数据区正在恢复时不得删除
    await this.localWriteHoldService.assertBusinessWritableInTransaction({
      organizationId: current.ownerOrganizationId,
      transactionContext,
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
        reason: '原作者删除本人正式资料',
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
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可删除', {
        id: command.documentId,
      });
    }

    // 管理员作为原作者删除：同事务补写关键记录（等级取账号当前事实，缺失失败关闭）
    if (command.session.activeRole === IdentityTypeEnum.SUPER_ADMIN) {
      const adminLevel = await this.accountQueryService.findAdminLevelByAccountId(
        command.session.accountId,
      );
      if (adminLevel === null) {
        throw new DomainError(
          REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
          '历史维修记录删除失败，请稍后重试',
          { id: command.documentId },
        );
      }
      await this.managementAuditService.appendDocumentEvent({
        actorAccountId: command.session.accountId,
        actorAdminLevel: adminLevel,
        organizationId: current.ownerOrganizationId,
        operation: 'ADMIN_DELETE_DOCUMENT',
        targetDocumentId: command.documentId,
        transactionContext,
        reason: '管理员以原作者身份删除本人正式资料',
      });
    }

    return { id: command.documentId };
  }
}

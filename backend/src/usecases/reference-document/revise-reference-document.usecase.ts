// src/usecases/reference-document/revise-reference-document.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { ReferenceDocumentDetailQueryResult } from '@src/modules/lithography/lithography.types';
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
  type ReferenceDocumentManagedMutationResult,
  type ReviseReferenceDocumentCommand,
} from './reference-document.types';
import {
  assertManagementReason,
  isFaultCaseDocumentType,
  normalizeContentText,
  normalizeTitle,
} from './reference-document-fields.normalize';

/**
 * 管理修订正式资料用例（任务 07 R058，页面 §9.3）。
 *
 * 业务流程：
 * 1. 角色决策：仅一级管理员（可信 activeRole + 账号当前事实 admin_level = 1）；
 *    二级管理员与工程师一律权限拒绝（页面 §9.3「2级及工程师不能下架」同源约束）。
 * 2. 输入决策：expected_version 必须为非负整数（无管理修订时当前版本即 0）；
 *    原因必填；补丁至少一个可编辑字段。
 * 3. 资源决策：事务内 GLOBAL 范围 + FOR UPDATE 锁定读，仅 ONLINE + CONFIRMED +
 *    未软删的正式资料可修订（下架/归属待核实/已软删统一 NOT_FOUND）；
 *    版本核对 expected_version = current_revision_no，过期拒绝（VERSION_CONFLICT）。
 * 4. 案例保护（A-PR0 §4.3 / §S6）：FAULT_CASE 的正文不得经本入口修改（明细强耦合，
 *    必须走专属案例更正）；普通资料也不能借此转为案例类型。
 * 5. 事务内原子提交：追加修订行（前后快照）→ 条件推进 current_revision_no 并应用
 *    白名单字段；条件更新未命中统一拒绝，无半写。
 *
 * 版本语义（页面 §9.3）：保存成功后详情必须显示新值与新生效版本；
 * 原作者冻结内容及旧管理版本经 revisions 保留供授权追溯；
 * 后续只改归属或状态时快照继承当前生效正文，不回退原报告。
 */
@Injectable()
export class ReviseReferenceDocumentUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly revisionService: ReferenceDocumentRevisionService,
    private readonly accountQueryService: AccountQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: ReviseReferenceDocumentCommand,
  ): Promise<ReferenceDocumentManagedMutationResult> {
    await assertReferenceDocumentFirstLevelAdmin({
      session: command.session,
      accountQueryService: this.accountQueryService,
    });
    assertDocumentIdValid(command.documentId);
    assertExpectedVersionInput(command.expectedVersion);
    const reason = assertManagementReason(command.reason);
    assertRevisionPatchHasField(command.patch);

    return this.transactionRunner.run((transactionContext) =>
      this.doRevise(command, reason, transactionContext),
    );
  }

  private async doRevise(
    command: ReviseReferenceDocumentCommand,
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
    this.assertCaseEditProtection(current, command.patch);

    // 当前生效结构化内容（任务 07 管理修订）：报告来源正式资料或已结构化修订的
    // 资料，正文不得经扁平入口改写——否则 contentText 与 structuredReport 分叉；
    // 标题/说明仍可经本入口修订（快照继承结构化内容，不回退正文）。
    const effectiveStructured = await resolveEffectiveStructuredContent(current, {
      referenceDocumentQueryService: this.referenceDocumentQueryService,
      maintenanceReportQueryService: this.maintenanceReportQueryService,
    });
    if (effectiveStructured !== null && command.patch.contentText !== undefined) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '结构化正式资料正文须走结构化管理修订入口，本入口仅支持标题与说明',
        { id: current.id },
      );
    }

    // 合并后的最终态校验：正文清空仅在已有存储引用时放行（双空防御）
    const nextContentText = normalizeContentText(command.patch.contentText, false);
    const hasStorageReference = current.storageReference !== null;
    if (nextContentText !== undefined && nextContentText === null && !hasStorageReference) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.CONTENT_SOURCE_EMPTY,
        '文本内容与文件至少需要一个',
      );
    }

    // 当前生效正文（状态/归属修订口径一致）：修订后 after 快照携带新生效正文
    const currentEffectiveText = await resolveEffectiveContentText(current, {
      referenceDocumentQueryService: this.referenceDocumentQueryService,
      maintenanceReportQueryService: this.maintenanceReportQueryService,
    });

    const nextTitle =
      command.patch.title !== undefined ? normalizeTitle(command.patch.title) : undefined;

    const beforeContentText = currentEffectiveText;
    const afterContentText =
      nextContentText !== undefined ? (nextContentText ?? null) : beforeContentText;

    const { beforeSnapshot, afterSnapshot } = buildRevisionSnapshots({
      detail: current,
      beforeContentText,
      afterContentText,
      beforeStructuredReport: structuredSnapshotValueOrNull(effectiveStructured),
      afterStructuredReport: structuredSnapshotValueOrNull(effectiveStructured),
      overrides: {
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        ...(command.patch.description !== undefined
          ? { description: command.patch.description }
          : {}),
      },
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
          ...(nextTitle !== undefined ? { title: nextTitle } : {}),
          ...(command.patch.description !== undefined
            ? { description: command.patch.description }
            : {}),
          ...(nextContentText !== undefined ? { contentText: nextContentText } : {}),
          updatedByAccountId: command.session.accountId,
        },
      },
      transactionContext,
    );
    if (outcome !== 'ADVANCED') {
      // 未命中：行事实已被并发操作改变；修订行插入随事务整体回滚，无半写
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT,
        '参考资料版本已更新，请重新读取当前版本后重试',
        { id: command.documentId },
      );
    }

    return { id: command.documentId, revisionNo: nextRevisionNo };
  }

  /** 案例保护：FAULT_CASE 正文与案例明细强耦合，不得经通用管理修订拆开改造 */
  private assertCaseEditProtection(
    current: ReferenceDocumentDetailQueryResult,
    patch: ReviseReferenceDocumentCommand['patch'],
  ): void {
    if (!isFaultCaseDocumentType(current.documentType)) {
      return;
    }
    if (patch.contentText !== undefined) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '案例资料正文不可通过管理修订修改，请使用案例更正接口',
        { id: current.id },
      );
    }
  }
}

function assertRevisionPatchHasField(patch: ReviseReferenceDocumentCommand['patch']): void {
  if (
    patch.title === undefined &&
    patch.description === undefined &&
    patch.contentText === undefined
  ) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      '管理修订至少需要一个可编辑字段',
    );
  }
}

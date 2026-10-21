// src/usecases/content-submission/update-content-submission-draft.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  assertFaultCaseDraftFilled,
  assertMaterialDraftFilled,
  assertModelExclusive,
  assertPatchHasEditableField,
  assertPatchMatchesKind,
  assertResolutionWhenResolved,
  mergeFaultCaseDetailPatch,
  mergeMaterialDetailPatch,
  normalizeExtensionV1,
} from './content-submission-fields.normalize';
import {
  assertContentSubmissionAuthorRole,
  assertEquipmentModelIdValid,
  assertSubmissionIdValid,
} from './content-submission-roles';
import { lockEditableSubmissionForAuthor } from './content-submission-write-guard';
import {
  ContentSubmissionDraftMutationResult,
  ContentSubmissionEditablePatch,
  UpdateContentSubmissionDraftCommand,
} from './content-submission.types';

/**
 * 修改投稿草稿用例（A-PR0 §4.1 `updateContentSubmissionDraft`）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 ENGINEER（精确匹配 activeRole）
 * 2. 输入决策：补丁至少一个业务字段；v1 扩展位任何键拒绝；
 *    不属于目标类别的字段出现非空值即拒绝
 * 3. 事务内持投稿行锁（pessimistic_write）后裁决：
 *    - 不存在 / 他人投稿 / 跨组织统一 NOT_FOUND（不泄露存在性，
 *      同组织其他工程师的投稿也不是可写数据）
 *    - 仅 DRAFT / RETURNED 可编辑，PENDING_REVIEW 只读、PUBLISHED 不可改稿
 *      （STATE_NOT_EDITABLE，锁把「校验当前状态」与「后续写入」串行化，
 *      并发送审后仍写草稿不会穿透）
 * 4. 读取明细当前值合并补丁（undefined 保持、null/空白清空），在合并后的
 *    最终态上校验：机型互斥、至少一个已填写字段、RESOLVED 必须有结果、
 *    资料类型不能是 FAULT_CASE；补丁新提供的机型 ID 校验型号存在
 * 5. 明细全量覆盖更新 + 主表 updated_at 触碰（列表排序口径依赖），
 *    并回读真实落库状态返回（类别不变、状态不变）
 */
@Injectable()
export class UpdateContentSubmissionDraftUsecase {
  constructor(
    private readonly contentSubmissionService: ContentSubmissionService,
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: UpdateContentSubmissionDraftCommand,
  ): Promise<ContentSubmissionDraftMutationResult> {
    assertContentSubmissionAuthorRole(command.session);
    assertSubmissionIdValid(command.submissionId);
    assertPatchHasEditableField(command.patch);
    normalizeExtensionV1(command.patch.extension);

    return this.transactionRunner.run((transactionContext) =>
      this.doUpdate(command, transactionContext),
    );
  }

  /** 事务内执行：行锁与归属/状态裁决（统一守卫）→ 合并校验 → 全量覆盖 → 回读 */
  private async doUpdate(
    command: UpdateContentSubmissionDraftCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ContentSubmissionDraftMutationResult> {
    const lock = await lockEditableSubmissionForAuthor({
      contentSubmissionService: this.contentSubmissionService,
      organizationContextService: this.organizationContextService,
      accountId: command.session.accountId,
      submissionId: command.submissionId,
      transactionContext,
    });

    const patch = command.patch;
    assertPatchMatchesKind(lock.submissionKind, patch);

    if (lock.submissionKind === 'MATERIAL') {
      await this.updateMaterialDraft(command, patch, transactionContext);
    } else {
      await this.updateFaultCaseDraft(command, patch, transactionContext);
    }

    return this.contentSubmissionQueryService.readStatusSnapshot({
      submissionId: command.submissionId,
      transactionContext,
    });
  }

  /** 普通资料草稿：读当前值 → 合并补丁 → 最终态校验 → 全量覆盖更新 */
  private async updateMaterialDraft(
    command: UpdateContentSubmissionDraftCommand,
    patch: ContentSubmissionEditablePatch,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const current = await this.contentSubmissionQueryService.readMaterialDetailForWrite({
      submissionId: command.submissionId,
      transactionContext,
    });
    const merged = mergeMaterialDetailPatch(
      current,
      patch,
      await this.resolveEquipmentModelId(patch, current.equipmentModelId, transactionContext),
    );
    assertModelExclusive(merged);
    assertMaterialDraftFilled(merged);
    await this.contentSubmissionService.updateMaterialSubmissionDetail({
      submissionId: command.submissionId,
      detail: merged,
      transactionContext,
    });
  }

  /** 故障案例草稿：读当前值 → 合并补丁 → 最终态校验 → 全量覆盖更新 */
  private async updateFaultCaseDraft(
    command: UpdateContentSubmissionDraftCommand,
    patch: ContentSubmissionEditablePatch,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const current = await this.contentSubmissionQueryService.readFaultCaseDetailForWrite({
      submissionId: command.submissionId,
      transactionContext,
    });
    const merged = mergeFaultCaseDetailPatch(
      current,
      patch,
      await this.resolveEquipmentModelId(patch, current.equipmentModelId, transactionContext),
    );
    assertModelExclusive(merged);
    assertFaultCaseDraftFilled(merged);
    assertResolutionWhenResolved(merged);
    await this.contentSubmissionService.updateFaultCaseSubmissionDetail({
      submissionId: command.submissionId,
      detail: merged,
      transactionContext,
    });
  }

  /**
   * 机型 ID 补丁合并（两类明细共用）：undefined 保持原值；null 清空；
   * 非空值校验正整数，且仅在变更时校验型号存在（未变更的现值是历史已校验的
   * 受外键保护的引用，不重复查询）。
   */
  private async resolveEquipmentModelId(
    patch: ContentSubmissionEditablePatch,
    currentId: number | null,
    transactionContext: PersistenceTransactionContext,
  ): Promise<number | null> {
    if (patch.equipmentModelId === undefined) {
      return currentId;
    }
    if (patch.equipmentModelId === null) {
      return null;
    }
    assertEquipmentModelIdValid(patch.equipmentModelId);
    if (patch.equipmentModelId !== currentId) {
      const model = await this.equipmentModelQueryService.findModelById({
        id: patch.equipmentModelId,
        transactionContext,
      });
      if (!model) {
        throw new DomainError(
          CONTENT_SUBMISSION_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
          '设备型号不存在',
          { equipmentModelId: patch.equipmentModelId },
        );
      }
    }
    return patch.equipmentModelId;
  }
}

// src/usecases/content-submission/create-content-submission-draft.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import type {
  FaultCaseSubmissionDetailWriteData,
  MaterialSubmissionDetailWriteData,
} from '@src/modules/lithography/content-submission.types';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  assembleFaultCaseDetailFromPatch,
  assembleMaterialDetailFromPatch,
  assertFaultCaseDraftFilled,
  assertMaterialDraftFilled,
  assertModelExclusive,
  assertPatchMatchesKind,
  assertResolutionWhenResolved,
  normalizeExtensionV1,
  normalizeSubmissionKind,
} from './content-submission-fields.normalize';
import {
  assertContentSubmissionAuthorRole,
  assertEquipmentModelIdValid,
} from './content-submission-roles';
import {
  ContentSubmissionDraftMutationResult,
  CreateContentSubmissionDraftCommand,
} from './content-submission.types';

/** 草稿创建载荷（组织/创建人在事务内由可信来源补齐） */
type DraftInsertData = {
  submissionKind: 'MATERIAL' | 'FAULT_CASE';
  material: MaterialSubmissionDetailWriteData | null;
  faultCase: FaultCaseSubmissionDetailWriteData | null;
};

/**
 * 新建投稿草稿用例（A-PR0 §4.1 `createContentSubmissionDraft`）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 ENGINEER 可创建（精确匹配 activeRole，管理员不自动继承）
 * 2. 输入决策：kind 值域校验；不匹配类别的字段出现非空值即拒绝；
 *    草稿字段全部可空，但保存后必须至少一个非空文字业务字段（口径 1）；
 *    机型 ID 与文字互斥、RESOLVED 必须有结果（与数据库 CHECK 口径一致）；
 *    v1 扩展位任何键拒绝（口径 5）；资料类型不能是 FAULT_CASE
 * 3. 组织决策：事务内经可信组织上下文解析本组织并落 ownerOrganizationId +
 *    创建人取自可信 Session；两者均不取客户端自报
 * 4. 事务内校验设备型号存在（应用层预检给友好错误，不依赖 RESTRICT 外键裸报错）
 * 5. 主表 + 明细同事务落库（status=DRAFT、current_revision_no=0），
 *    并回读真实落库状态返回（ID/类别/状态/更新时间）
 */
@Injectable()
export class CreateContentSubmissionDraftUsecase {
  constructor(
    private readonly contentSubmissionService: ContentSubmissionService,
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: CreateContentSubmissionDraftCommand,
  ): Promise<ContentSubmissionDraftMutationResult> {
    assertContentSubmissionAuthorRole(command.session);

    const kind = normalizeSubmissionKind(command.kind);
    const fields = command.fields;
    assertPatchMatchesKind(kind, fields);
    // v1 扩展位：任何未定义键拒绝（空集统一丢弃，不落原始 JSON）
    normalizeExtensionV1(fields.extension);

    let equipmentModelId: number | null = null;
    if (fields.equipmentModelId !== undefined && fields.equipmentModelId !== null) {
      assertEquipmentModelIdValid(fields.equipmentModelId);
      equipmentModelId = fields.equipmentModelId;
    }

    if (kind === 'MATERIAL') {
      const material = assembleMaterialDetailFromPatch(fields, equipmentModelId);
      assertModelExclusive(material);
      assertMaterialDraftFilled(material);
      return this.transactionRunner.run((transactionContext) =>
        this.doCreate(
          command,
          { submissionKind: kind, material, faultCase: null },
          equipmentModelId,
          transactionContext,
        ),
      );
    }

    const faultCase = assembleFaultCaseDetailFromPatch(fields, equipmentModelId);
    assertModelExclusive(faultCase);
    assertFaultCaseDraftFilled(faultCase);
    assertResolutionWhenResolved(faultCase);
    return this.transactionRunner.run((transactionContext) =>
      this.doCreate(
        command,
        { submissionKind: kind, material: null, faultCase },
        equipmentModelId,
        transactionContext,
      ),
    );
  }

  /** 事务内执行：组织解析 → 型号存在性校验 → 主表 + 明细落库 → 真实状态回读 */
  private async doCreate(
    command: CreateContentSubmissionDraftCommand,
    draft: DraftInsertData,
    equipmentModelId: number | null,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ContentSubmissionDraftMutationResult> {
    // 组织范围在事务内解析：与落库同快照的成员事实，「无有效成员关系/多关系歧义」
    // 在此拒绝，失败不进入任何写路径（归属绝不取客户端自报）
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
      transactionContext,
    });

    if (equipmentModelId !== null) {
      // 型号预检仅验存在性（禁用型号的历史知识仍可挂载，草稿语义与资料库一致）
      const model = await this.equipmentModelQueryService.findModelById({
        id: equipmentModelId,
        transactionContext,
      });
      if (!model) {
        throw new DomainError(
          CONTENT_SUBMISSION_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
          '设备型号不存在',
          { equipmentModelId },
        );
      }
    }

    const { submissionId } = await this.contentSubmissionService.insertSubmission(
      {
        submissionKind: draft.submissionKind,
        ownerOrganizationId: membership.organizationId,
        submittedByAccountId: command.session.accountId,
        material: draft.material,
        faultCase: draft.faultCase,
      },
      transactionContext,
    );

    return this.contentSubmissionQueryService.readStatusSnapshot({
      submissionId,
      transactionContext,
    });
  }
}

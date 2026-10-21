// src/usecases/reference-document/update-reference-document-case.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { ReferenceDocumentDetailQueryResult } from '@src/modules/lithography/lithography.types';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { ReferenceDocumentCaseDetailService } from '@src/modules/lithography/reference-document-case-detail.service';
import { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import { formatFaultCaseReferenceContent } from '@src/usecases/common/fault-case-fields.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  assertCaseCorrectionPresent,
  assertCaseModelExclusive,
  assertCasePatchHasEditableField,
  assertCaseResolutionWhenResolved,
  mergeCaseDetailPatch,
  normalizeCaseDescription,
  normalizeCaseModelText,
  normalizeCaseTitle,
} from './reference-document-case-fields.normalize';
import { isFaultCaseDocumentType } from './reference-document-fields.normalize';
import {
  assertDocumentIdValid,
  assertEquipmentModelIdValid,
  assertReferenceDocumentWriteRole,
} from './reference-document-roles';
import {
  ReferenceDocumentCaseMutationResult,
  UpdateReferenceDocumentCaseCommand,
} from './reference-document.types';

/**
 * 正式案例专属更正用例（A-PR0 §S6 / §4.1 `updateReferenceDocumentCase`）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 SUPER_ADMIN（精确匹配，工程师一律拒绝）
 * 2. 输入决策：补丁至少一个可更正字段（undefined=保持原值；可读正文为派生字段，
 *    不在补丁中）
 * 3. 事务内组织决策：本组织范围内读取当前值（不存在/已软删/跨组织统一 NOT_FOUND）；
 *    类型门禁：仅 FAULT_CASE 资料可走专属更正（普通资料仍用通用编辑接口）
 * 4. 案例明细存在性（类型与明细一一对应，缺失=定式破坏，失败关闭）
 * 5. 合并允许字段后验证：标题/现象/复现步骤/处理状态非空；RESOLVED 必须有结果；
 *    机型 ID 与机型文字互斥（合并后最终态判定）
 * 6. 可读正文由合并后明细重新生成（与 S5 发布链路同一格式化真源，正文与明细不脱节）
 * 7. 同一事务：更新主资料（标题/机型/说明/可读正文/修改人/时间；类型、归属组织、
 *    来源投稿/版本与原附件不改）+ 全量覆盖案例明细；回读真实落库状态返回 ID/更新时间
 */
@Injectable()
export class UpdateReferenceDocumentCaseUsecase {
  constructor(
    private readonly referenceDocumentService: ReferenceDocumentService,
    private readonly referenceDocumentCaseDetailService: ReferenceDocumentCaseDetailService,
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: UpdateReferenceDocumentCaseCommand,
  ): Promise<ReferenceDocumentCaseMutationResult> {
    assertReferenceDocumentWriteRole(command.session.roles);
    assertDocumentIdValid(command.documentId);
    assertCasePatchHasEditableField(command.patch);

    return this.transactionRunner.run((transactionContext) =>
      this.doUpdate(command, transactionContext),
    );
  }

  /**
   * 事务内执行：组织解析 → 读当前值 → 类型门禁 → 明细存在性 → 合并与最终态校验
   * → 派生正文 → 主资料与明细同事务更新 → 回读真实状态
   */
  private async doUpdate(
    command: UpdateReferenceDocumentCaseCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentCaseMutationResult> {
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
      transactionContext,
    });

    // 当前值读取（G2/F01 锁定读）：不存在/已软删/跨组织统一 NOT_FOUND；forUpdate 对
    // 主资料行与案例明细行依次加行锁（当前读，不受本事务 REPEATABLE READ 旧快照影响），
    // 与通用编辑共享同一资源互斥，避免并发更正「快照交错 + 全量覆盖」丢失不同字段的补丁
    const current = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      organizationId: membership.organizationId,
      transactionContext,
      forUpdate: true,
    });

    // 类型门禁（A-PR0 §4.1）：仅 FAULT_CASE 可走专属更正；判定复用保留类型
    // 单一判定函数（大小写不敏感，与 create/update 守卫同口径）
    if (!isFaultCaseDocumentType(current.documentType)) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '仅故障案例资料可以使用案例更正接口',
        { documentId: command.documentId, documentType: current.documentType },
      );
    }

    // 案例类型与明细一一对应（A-PR0 §3.3）：明细缺失属定式破坏，失败关闭而非静默容忍
    if (!current.caseDetail) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED, '案例明细缺失，无法完成更正', {
        documentId: command.documentId,
      });
    }

    const patch = command.patch;

    // 主资料字段合并（undefined 保持原值；标题为必填，置空在合并后拒绝）
    const title =
      patch.title !== undefined ? (normalizeCaseTitle(patch.title) ?? null) : current.title;
    if (title === null) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, '更正后的案例标题不能为空', {
        documentId: command.documentId,
      });
    }
    const description =
      patch.description !== undefined
        ? (normalizeCaseDescription(patch.description) ?? null)
        : current.description;

    // 机型合并：两个列独立合并（口径同投稿草稿补丁）；合并后互斥校验给友好错误
    const equipmentModelId = await this.resolveCaseEquipmentModelId(
      current,
      patch,
      command.documentId,
      transactionContext,
    );
    const equipmentModelText =
      patch.equipmentModelText !== undefined
        ? (normalizeCaseModelText(patch.equipmentModelText) ?? null)
        : current.equipmentModelText;
    assertCaseModelExclusive({ equipmentModelId, equipmentModelText });

    // 案例明细合并与最终态校验（必填存在性 → 已解决必填结果，与数据库 CHECK 同口径）
    const merged = mergeCaseDetailPatch(current.caseDetail, patch);
    assertCaseCorrectionPresent(merged);
    assertCaseResolutionWhenResolved(merged);

    // 可读正文由合并后明细重新生成（单一格式化真源，禁止与明细脱节直改）
    const contentText = formatFaultCaseReferenceContent(merged);

    await this.referenceDocumentService.updateDocument(
      {
        documentId: command.documentId,
        title,
        // 类型不变（仅案例走本接口且案例类型只能来自发布/更正）；owner、source、
        // 存储四列与原附件不在更新数据中，保持原值
        documentType: current.documentType,
        equipmentModelId,
        equipmentModelText,
        description,
        contentText,
        updatedByAccountId: command.session.accountId,
      },
      transactionContext,
    );

    await this.referenceDocumentCaseDetailService.updateCaseDetail(
      {
        documentId: command.documentId,
        errorCode: merged.errorCode,
        handlingStatus: merged.handlingStatus,
        phenomenon: merged.phenomenon,
        conditionText: merged.conditionText,
        reproductionSteps: merged.reproductionSteps,
        diagnosis: merged.diagnosis,
        actionTaken: merged.actionTaken,
        resolution: merged.resolution,
      },
      transactionContext,
    );

    // 回读真实落库状态（updated_at 由数据库列自动推进；同事务内可见本事务写入），
    // 不重复加锁（锁已在合并读建立，保持到本事务结束）
    const updated = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      organizationId: membership.organizationId,
      transactionContext,
    });
    return { id: updated.id, updatedAt: updated.updatedAt };
  }

  /**
   * 机型 ID 合并：undefined 保持原值；显式 null 清空；非空值校验正整数，
   * 且仅在变更时校验型号存在（未变更的现值受外键保护，不重复查询）。
   */
  private async resolveCaseEquipmentModelId(
    current: ReferenceDocumentDetailQueryResult,
    patch: UpdateReferenceDocumentCaseCommand['patch'],
    documentId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<number | null> {
    if (patch.equipmentModelId === undefined) {
      return current.equipmentModelId;
    }
    if (patch.equipmentModelId === null) {
      return null;
    }
    assertEquipmentModelIdValid(patch.equipmentModelId);
    if (patch.equipmentModelId !== current.equipmentModelId) {
      const model = await this.equipmentModelQueryService.findModelById({
        id: patch.equipmentModelId,
        transactionContext,
      });
      if (!model) {
        throw new DomainError(
          REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
          '设备型号不存在',
          {
            documentId,
            equipmentModelId: patch.equipmentModelId,
          },
        );
      }
    }
    return patch.equipmentModelId;
  }
}

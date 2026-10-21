// src/usecases/reference-document/update-reference-document.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { ReferenceDocumentDetailQueryResult } from '@src/modules/lithography/lithography.types';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  assertPatchHasEditableField,
  isFaultCaseDocumentType,
  normalizeContentText,
  normalizeDescription,
  normalizeDocumentType,
  normalizeTitle,
} from './reference-document-fields.normalize';
import {
  assertEquipmentModelIdValid,
  assertDocumentIdValid,
  assertReferenceDocumentWriteRole,
} from './reference-document-roles';
import {
  ReferenceDocumentMutationResult,
  UpdateReferenceDocumentCommand,
} from './reference-document.types';

/**
 * 编辑参考资料用例（仅 SUPER_ADMIN，本组织范围）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 SUPER_ADMIN 可编辑（精确匹配，工程师一律拒绝）
 * 2. 输入决策：补丁至少一个可编辑字段；undefined=保持原值，
 *    equipmentModelId/description 显式 null=清空；contentText null/空白=清空，
 *    仅当目标资料已有存储引用时放行（双空防御，chk_reference_document_content_source 兜底）
 * 3. 案例保护（A-PR0 §4.3 / §S6）：目标是 FAULT_CASE 时拒绝通用正文/类型修改
 *    （正文与明细、类型与明细不得拆开，必须走专属案例更正）；普通资料也不能
 *    借此转为 FAULT_CASE；机型文字与机型 ID 互斥由本层预检给友好错误
 * 4. 组织决策：事务内经可信组织上下文解析本组织，跨组织与不存在/已软删统一 NOT_FOUND
 * 5. 读取当前值（G2/F01 锁定读：主资料行 FOR UPDATE 当前读，与专属更正共享
 *    同一资源互斥）合并补丁后全量校验（必填字段合并后仍必须满足）
 * 6. 事务内校验新设备型号存在 → 条件更新（deprecated=0 才可编辑，已软删不可编辑穿透）
 *
 * 编辑字段范围（0907.docx）：标题/文档类型/适用设备型号/描述/文本内容；
 * 不提供替换二进制文件——需要替换时新增一份资料再软删除旧资料。
 */
@Injectable()
export class UpdateReferenceDocumentUsecase {
  constructor(
    private readonly referenceDocumentService: ReferenceDocumentService,
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: UpdateReferenceDocumentCommand): Promise<ReferenceDocumentMutationResult> {
    assertReferenceDocumentWriteRole(command.session.roles);
    assertDocumentIdValid(command.documentId);
    assertPatchHasEditableField(command.patch);

    return this.transactionRunner.run((transactionContext) =>
      this.doUpdate(command, transactionContext),
    );
  }

  /** 事务内执行：组织解析 → 读当前值 → 案例保护 → 合并补丁 → 校验 → 型号校验 → 条件更新 */
  private async doUpdate(
    command: UpdateReferenceDocumentCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentMutationResult> {
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
      transactionContext,
    });

    // 当前值读取（G2/F01 锁定读）：不存在/已软删/跨组织统一 NOT_FOUND（QueryService 口径），
    // 不泄露存在性；forUpdate 对主资料行加行锁（当前读，不受本事务 REPEATABLE READ 旧快照
    // 影响），与专属更正共享同一资源互斥，避免两个写入口互相覆盖
    const current = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      organizationId: membership.organizationId,
      transactionContext,
      forUpdate: true,
    });
    const patch = command.patch;

    // 案例保护（A-PR0 §4.3 / §S6）：FAULT_CASE 的正文/类型与案例明细强耦合，
    // 通用编辑不得单独改造（必须走专属案例更正）
    this.assertCaseEditProtection(current, patch, command.documentId);

    // 补丁类型语义：null 仅允许出现在可清空字段（equipmentModelId/description）；
    // 必填字段显式 null 直接拒绝本模块业务码，不落到输入规范化的实现细节错误码
    if (patch.title === null || patch.documentType === null) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '标题与文档类型为必填字段，不允许置空',
        { documentId: command.documentId },
      );
    }

    // 合并补丁：undefined 保持原值
    const title = patch.title !== undefined ? normalizeTitle(patch.title) : current.title;
    const documentType =
      patch.documentType !== undefined
        ? normalizeDocumentType(patch.documentType)
        : current.documentType;
    // 普通资料也不能借此转为 FAULT_CASE（类型保留值只能来自投稿发布；§4.3）；
    // 大小写不敏感判定与数据库列排序规则 utf8mb4_0900_ai_ci 及投稿域口径一致，
    // 防止 'fault_case' 等变体绕过
    if (isFaultCaseDocumentType(documentType) && !isFaultCaseDocumentType(current.documentType)) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '不能通过通用编辑把普通资料改为案例资料，请通过投稿审核流程发布',
        { documentId: command.documentId },
      );
    }
    const description =
      patch.description !== undefined
        ? normalizeDescription(patch.description)
        : current.description;
    const contentText =
      patch.contentText !== undefined
        ? (normalizeContentText(patch.contentText, false) ?? null)
        : current.contentText;
    if (contentText === null && (current.storageReference ?? null) === null) {
      // 内容来源双空拒绝（正文 + 已有存储引用至少一个）；仅文件资料编辑时
      // contentText 保持 null 合法，不得误拦（chk_reference_document_content_source 兜底）
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.CONTENT_SOURCE_EMPTY,
        '文本内容与文件至少需要一个',
      );
    }

    const equipmentModelId = await this.resolveEquipmentModelId(
      current,
      patch,
      command.documentId,
      transactionContext,
    );

    return this.referenceDocumentService.updateDocument(
      {
        documentId: command.documentId,
        title,
        documentType,
        equipmentModelId,
        description: description ?? null,
        contentText,
      },
      transactionContext,
    );
  }

  /**
   * 案例保护（A-PR0 §4.3 / §S6）：目标是 FAULT_CASE 时拒绝通用正文/类型修改。
   *
   * 案例正文与案例明细强耦合，类型与明细同样强耦合，通用编辑不得拆开改造，
   * 必须走专属案例更正；普通资料转为 FAULT_CASE 的路径由合并后校验拒绝。
   * 保留类型判定大小写不敏感（数据库列排序规则 utf8mb4_0900_ai_ci 口径），
   * 'fault_case' 等变体同样受保护。
   */
  private assertCaseEditProtection(
    current: ReferenceDocumentDetailQueryResult,
    patch: UpdateReferenceDocumentCommand['patch'],
    documentId: number,
  ): void {
    if (!isFaultCaseDocumentType(current.documentType)) {
      return;
    }
    if (patch.documentType !== undefined) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '案例资料类型不可通过通用编辑修改，请使用案例更正接口',
        { documentId },
      );
    }
    if (patch.contentText !== undefined) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '案例资料正文不可通过通用编辑修改，请使用案例更正接口',
        { documentId },
      );
    }
  }

  /**
   * 型号合并：undefined 保持原值；显式 null 清空为通用资料；数字需存在且与机型文字互斥。
   */
  private async resolveEquipmentModelId(
    current: ReferenceDocumentDetailQueryResult,
    patch: UpdateReferenceDocumentCommand['patch'],
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
    // 机型文字与机型 ID 互斥（chk_reference_document_model_exclusive）：
    // 资料已有机型文字时直接设置 ID 会被数据库检查拒绝，在此预检给友好业务错误
    if (current.equipmentModelText !== null) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '该资料已有机型文字，不能直接设置机型 ID（两者互斥）',
        { documentId },
      );
    }
    const model = await this.equipmentModelQueryService.findModelById({
      id: patch.equipmentModelId,
      transactionContext,
    });
    if (!model) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND, '设备型号不存在', {
        equipmentModelId: patch.equipmentModelId,
      });
    }
    return model.id;
  }
}

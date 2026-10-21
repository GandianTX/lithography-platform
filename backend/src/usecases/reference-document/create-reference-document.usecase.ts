// src/usecases/reference-document/create-reference-document.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  isFaultCaseDocumentType,
  normalizeContentText,
  normalizeDescription,
  normalizeDocumentType,
  normalizeTitle,
} from './reference-document-fields.normalize';
import {
  assertEquipmentModelIdValid,
  assertReferenceDocumentWriteRole,
} from './reference-document-roles';
import {
  CreateReferenceDocumentCommand,
  ReferenceDocumentMutationResult,
} from './reference-document.types';

/**
 * 规范化后的创建数据（execute 与事务内委托入口共享同一份校验产物，避免两套规则）
 */
type NormalizedCreateData = {
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  description: string | null;
  contentText: string | null;
  file: CreateReferenceDocumentCommand['file'];
};

/**
 * 创建参考资料用例（仅 SUPER_ADMIN）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 SUPER_ADMIN 可创建（精确匹配，工程师一律拒绝，兜底守卫误放）
 * 2. 输入决策：标题/文档类型必填且限长；内容来源为正文或文件至少一个——
 *    双空创建必须失败（REFERENCE_DOCUMENT_ERROR.CONTENT_SOURCE_EMPTY，落库层
 *    chk_reference_document_content_source 兜底）；文档说明可空；
 *    拒绝 documentType = FAULT_CASE（案例只能由投稿审核发布/专属更正管理，
 *    A-PR0 §4.3：管理员直建不可伪造案例）
 * 3. 组织决策：事务内经可信组织上下文解析本组织并落 ownerOrganizationId +
 *    ingestMethod = ADMIN_DIRECT；来源/组织不取客户端自报
 * 4. 事务内校验设备型号存在（应用层预检给友好错误，不依赖 RESTRICT 外键裸报错）
 * 5. 事务内落库；创建人取自会话，客户端不可传入；文件来源的存储引用由
 *    存储契约在事务外生成（先存后落库），本用例只负责把载荷写入四列
 * 6. 同域一跳入口 executeWithOrganizationInTransaction（G1）：供带文件创建用例
 *    在既有事务内复用全部业务校验与落库映射——组织事实由调用方在同一事务内
 *    经可信解析后传入（不二次解析、不接受客户端自报）
 */
@Injectable()
export class CreateReferenceDocumentUsecase {
  constructor(
    private readonly referenceDocumentService: ReferenceDocumentService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: CreateReferenceDocumentCommand): Promise<ReferenceDocumentMutationResult> {
    const data = this.normalizeCreateData(command);

    return this.transactionRunner.run(async (transactionContext) => {
      // 组织范围在事务内解析：与落库同快照的成员事实，“无有效成员关系/多关系歧义”在此拒绝，
      // 失败不进入任何写路径（归属绝不取客户端自报）
      const membership = await this.organizationContextService.resolveForAccount({
        accountId: command.session.accountId,
        transactionContext,
      });
      return this.doCreate(data, command, transactionContext, membership.organizationId);
    });
  }

  /**
   * 同域一跳（G1）：在调用方已有的可信事务内复用全部业务校验与落库映射。
   *
   * 供带文件创建用例（先写存储后落库的编排）使用：组织事实由调用方在同一事务内
   * 经 TrustedOrganizationContextQueryService 解析后传入（不取客户端自报，
   * 也不二次解析产生第二份事实）；角色与输入校验随 normalizeCreateData 复跑，
   * 保持单一真源。
   */
  async executeWithOrganizationInTransaction(
    command: CreateReferenceDocumentCommand,
    transactionContext: PersistenceTransactionContext,
    ownerOrganizationId: number,
  ): Promise<ReferenceDocumentMutationResult> {
    const data = this.normalizeCreateData(command);
    return this.doCreate(data, command, transactionContext, ownerOrganizationId);
  }

  /** 规范化与输入决策（execute 与 executeWithOrganizationInTransaction 共享，单一真源） */
  private normalizeCreateData(command: CreateReferenceDocumentCommand): NormalizedCreateData {
    assertReferenceDocumentWriteRole(command.session.roles);

    const title = normalizeTitle(command.title);
    const documentType = normalizeDocumentType(command.documentType);
    // A-PR0 §4.3：普通创建接口不得伪造正式案例（类型保留值，大小写不敏感判定），
    // 案例只从投稿审核发布进入正式库
    if (isFaultCaseDocumentType(documentType)) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '案例资料不能通过普通创建接口建立，请通过投稿审核流程发布',
      );
    }
    const description = normalizeDescription(command.description) ?? null;
    // 内容来源：正文可为 null（仅文件创建），提供了正文则仍走规范化（空串/超长拒绝）
    const contentText =
      command.contentText === undefined || command.contentText === null
        ? null
        : normalizeContentText(command.contentText, true);
    const file = command.file ?? null;

    // 双空拒绝：文件与正文同时缺失时不允许创建（docx 口径，CONTENT_SOURCE_EMPTY 优于
    // 通用 INVALID_PARAMS，与落库层 chk_reference_document_content_source 语义一一对应）
    if (!file && contentText === null) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.CONTENT_SOURCE_EMPTY,
        '文件与正文内容至少提供一个',
      );
    }

    let equipmentModelId: number | null = null;
    if (command.equipmentModelId !== undefined && command.equipmentModelId !== null) {
      assertEquipmentModelIdValid(command.equipmentModelId);
      equipmentModelId = command.equipmentModelId;
    }

    return { title, documentType, equipmentModelId, description, contentText, file };
  }

  /** 事务内执行（型号存在性校验 → 落库；创建人仅取自会话；组织事实由调用方传入） */
  private async doCreate(
    data: NormalizedCreateData,
    command: CreateReferenceDocumentCommand,
    transactionContext: PersistenceTransactionContext,
    ownerOrganizationId: number,
  ): Promise<ReferenceDocumentMutationResult> {
    if (data.equipmentModelId !== null) {
      // 型号预检仅验存在性，不校验 enabled：资料库无申请流转语义，
      // 禁用型号的历史知识仍可挂载（docx 未要求禁用型号拦截，区别于维修申请）
      const model = await this.equipmentModelQueryService.findModelById({
        id: data.equipmentModelId,
        transactionContext,
      });
      if (!model) {
        throw new DomainError(
          REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
          '设备型号不存在',
          { equipmentModelId: data.equipmentModelId },
        );
      }
    }

    return this.referenceDocumentService.insertDocument(
      {
        title: data.title,
        documentType: data.documentType,
        equipmentModelId: data.equipmentModelId,
        description: data.description,
        contentText: data.contentText,
        originalFilename: data.file?.originalFilename ?? null,
        mimeType: data.file?.mimeType ?? null,
        // 存储后端标识随实现固定；存储引用已由存储契约生成（服务端随机、无路径语义）
        storageBackend: data.file ? 'local' : null,
        storageReference: data.file?.storageReference ?? null,
        // 创建人仅取自可信 Session，客户端不可传入
        createdByAccountId: command.session.accountId,
        // 组织归属来自同事务可信组织上下文解析（execute：事务内解析；委托入口：调用方传入），
        // 入库方式固定管理员直建
        ownerOrganizationId,
        ingestMethod: 'ADMIN_DIRECT',
      },
      transactionContext,
    );
  }
}

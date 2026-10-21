// src/usecases/reference-document/soft-delete-reference-document.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  assertDocumentIdValid,
  assertReferenceDocumentWriteRole,
} from './reference-document-roles';
import {
  ReferenceDocumentMutationResult,
  SoftDeleteReferenceDocumentCommand,
} from './reference-document.types';

/**
 * 软删除参考资料用例（仅 SUPER_ADMIN，本组织范围）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 SUPER_ADMIN 可删除（精确匹配，工程师一律拒绝）
 * 2. 输入决策：documentId 必须为正整数
 * 3. 组织决策：事务内经可信组织上下文解析本组织；跨组织目标与不存在/已软删统一
 *    NOT_FOUND（不泄露存在性与删除状态）
 * 4. 事务内原子条件软删除（deprecated 与 deleted_at 同语句写入，满足删除一致性 CHECK；
 *    不执行物理 DELETE，原始文件不物理删除）
 * 5. 结果映射（负责人 docx 验收标准）：不存在与已软删统一 NOT_FOUND，
 *    不泄露删除状态；不沿用维修申请的幂等成功裁定
 */
@Injectable()
export class SoftDeleteReferenceDocumentUsecase {
  constructor(
    private readonly referenceDocumentService: ReferenceDocumentService,
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: SoftDeleteReferenceDocumentCommand,
  ): Promise<ReferenceDocumentMutationResult> {
    assertReferenceDocumentWriteRole(command.session.roles);
    assertDocumentIdValid(command.documentId);

    return this.transactionRunner.run((transactionContext) =>
      this.doDelete(command, transactionContext),
    );
  }

  /** 事务内执行：组织解析 → 组织核验 → 原子条件软删除 → 按状态事实映射结果 */
  private async doDelete(
    command: SoftDeleteReferenceDocumentCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentMutationResult> {
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
      transactionContext,
    });

    // 组织核验（A-PR0 §4.3：软删除保持原行为 + 组织范围）：跨组织目标与
    // 不存在/已软删统一 NOT_FOUND，不泄露跨组织资源的存在性
    await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      organizationId: membership.organizationId,
      transactionContext,
    });

    const outcome = await this.referenceDocumentService.softDeleteDocument(
      { documentId: command.documentId },
      transactionContext,
    );

    switch (outcome.kind) {
      case 'DELETED':
        return { id: outcome.id };
      case 'NOT_FOUND':
        // 不存在与已软删统一拒绝，不泄露删除状态（docx 验收标准）
        throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可删除', {
          id: outcome.id,
        });
    }
  }
}

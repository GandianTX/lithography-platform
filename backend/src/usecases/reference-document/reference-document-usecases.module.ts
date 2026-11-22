// src/usecases/reference-document/reference-document-usecases.module.ts

import { Module } from '@nestjs/common';

import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { AdminDeleteReferenceDocumentUsecase } from './admin-delete-reference-document.usecase';
import { CorrectReferenceDocumentOwnershipUsecase } from './correct-reference-document-ownership.usecase';
import { GetReferenceDocumentDetailUsecase } from './get-reference-document-detail.usecase';
import { GetReferenceDocumentEditableContentUsecase } from './get-reference-document-editable-content.usecase';
import { GetReferenceDocumentFileUsecase } from './get-reference-document-file.usecase';
import { ReviseReferenceDocumentStructuredUsecase } from './revise-reference-document-structured.usecase';
import { GetPendingOwnershipReferenceDocumentDetailUsecase } from './get-pending-ownership-reference-document-detail.usecase';
import { ListReferenceDocumentRevisionsUsecase } from './list-reference-document-revisions.usecase';
import { ListReferenceDocumentsUsecase } from './list-reference-documents.usecase';
import { ListPendingOwnershipReferenceDocumentsUsecase } from './list-pending-ownership-reference-documents.usecase';
import { OfflineReferenceDocumentUsecase } from './offline-reference-document.usecase';
import { ReviseReferenceDocumentUsecase } from './revise-reference-document.usecase';
import { SoftDeleteReferenceDocumentUsecase } from './soft-delete-reference-document.usecase';
import { UpdateReferenceDocumentCaseUsecase } from './update-reference-document-case.usecase';

/**
 * 参考资料用例装配（任务 07）。
 *
 * 组织范围（A-PR0 §2.1）由 LithographyModule 导出的可信组织上下文查询服务提供
 * （同域读侧校验，usecase 不依赖客户端自报组织）；修订写服务与审计服务由
 * LithographyModule 导出，管理操作在同一事务内编排。
 *
 * 任务 07 确认需求收口：旧普通新增（CreateReferenceDocumentUsecase /
 * CreateReferenceDocumentWithFileUsecase）与通用编辑（UpdateReferenceDocumentUsecase）
 * 写用例已移除——本期普通资料新增与资料审核取消，服务端同步关闭，
 * 历史资料照常授权读取；管理动作（R053/R058–R061）按新权限与版本规则拆分。
 */
@Module({
  imports: [LithographyModule, AccountInstallerModule],
  providers: [
    AdminDeleteReferenceDocumentUsecase,
    CorrectReferenceDocumentOwnershipUsecase,
    GetReferenceDocumentDetailUsecase,
    GetReferenceDocumentEditableContentUsecase,
    GetPendingOwnershipReferenceDocumentDetailUsecase,
    GetReferenceDocumentFileUsecase,
    ListReferenceDocumentRevisionsUsecase,
    ListReferenceDocumentsUsecase,
    ListPendingOwnershipReferenceDocumentsUsecase,
    OfflineReferenceDocumentUsecase,
    ReviseReferenceDocumentUsecase,
    ReviseReferenceDocumentStructuredUsecase,
    SoftDeleteReferenceDocumentUsecase,
    UpdateReferenceDocumentCaseUsecase,
  ],
  exports: [
    AdminDeleteReferenceDocumentUsecase,
    CorrectReferenceDocumentOwnershipUsecase,
    GetReferenceDocumentDetailUsecase,
    GetReferenceDocumentEditableContentUsecase,
    GetPendingOwnershipReferenceDocumentDetailUsecase,
    GetReferenceDocumentFileUsecase,
    ListReferenceDocumentRevisionsUsecase,
    ListReferenceDocumentsUsecase,
    ListPendingOwnershipReferenceDocumentsUsecase,
    OfflineReferenceDocumentUsecase,
    ReviseReferenceDocumentUsecase,
    ReviseReferenceDocumentStructuredUsecase,
    SoftDeleteReferenceDocumentUsecase,
    UpdateReferenceDocumentCaseUsecase,
  ],
})
export class ReferenceDocumentUsecasesModule {}

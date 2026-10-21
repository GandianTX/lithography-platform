// src/usecases/reference-document/reference-document-usecases.module.ts

import { Module } from '@nestjs/common';

import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { CreateReferenceDocumentUsecase } from './create-reference-document.usecase';
import { CreateReferenceDocumentWithFileUsecase } from './create-reference-document-with-file.usecase';
import { GetReferenceDocumentDetailUsecase } from './get-reference-document-detail.usecase';
import { GetReferenceDocumentFileUsecase } from './get-reference-document-file.usecase';
import { ListReferenceDocumentsUsecase } from './list-reference-documents.usecase';
import { SoftDeleteReferenceDocumentUsecase } from './soft-delete-reference-document.usecase';
import { UpdateReferenceDocumentCaseUsecase } from './update-reference-document-case.usecase';
import { UpdateReferenceDocumentUsecase } from './update-reference-document.usecase';

/**
 * 参考资料用例装配。
 *
 * 上传大小上限与 MIME 白名单由全局的 LocalReferenceDocumentStorageModule 注入
 * （infrastructure wiring，架构规则），本模块的带文件创建用例将其作为业务规则
 * 单一真源消费（负责人 0910 架构要求）。
 *
 * 组织范围（A-PR0 §2.1）由 LithographyModule 导出的可信组织上下文查询服务提供
 * （同域读侧校验，usecase 不依赖客户端自报组织）。
 */
@Module({
  imports: [LithographyModule, AccountInstallerModule],
  providers: [
    CreateReferenceDocumentUsecase,
    CreateReferenceDocumentWithFileUsecase,
    GetReferenceDocumentDetailUsecase,
    GetReferenceDocumentFileUsecase,
    ListReferenceDocumentsUsecase,
    SoftDeleteReferenceDocumentUsecase,
    UpdateReferenceDocumentCaseUsecase,
    UpdateReferenceDocumentUsecase,
  ],
  exports: [
    CreateReferenceDocumentUsecase,
    CreateReferenceDocumentWithFileUsecase,
    GetReferenceDocumentDetailUsecase,
    GetReferenceDocumentFileUsecase,
    ListReferenceDocumentsUsecase,
    SoftDeleteReferenceDocumentUsecase,
    UpdateReferenceDocumentCaseUsecase,
    UpdateReferenceDocumentUsecase,
  ],
})
export class ReferenceDocumentUsecasesModule {}

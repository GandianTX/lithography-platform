// src/usecases/reference-document/get-reference-document-file.usecase.ts

import { Inject, Injectable } from '@nestjs/common';

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

import {
  GetReferenceDocumentFileCommand,
  ReferenceDocumentFilePayload,
  ReferenceDocumentStorage,
} from './reference-document.types';
import {
  assertDocumentIdValid,
  assertReferenceDocumentDownloadRole,
} from './reference-document-roles';
import { REFERENCE_DOCUMENT_STORAGE } from './reference-document-storage.contract';

/**
 * 获取参考资料下载文件用例（ENGINEER + SUPER_ADMIN，负责人 0910 裁定收窄，与 GraphQL 读口径一致）。
 *
 * - 组织范围经可信组织上下文解析（A-PR0 §4.3：下载加同组织事实核验）：
 *   跨组织目标与不存在/已软删统一 NOT_FOUND，不泄露存在性；
 * - 复用统一 NOT_FOUND 口径：不存在 / 已软删一致拒绝，不泄露删除状态；
 * - 无存储引用（纯文本资料）或存储对象缺失/引用非法：统一 FILE_NOT_AVAILABLE 受控错误，
 *   不泄露服务器路径、存储引用与存储后端类型（负责人 0909 第二轮下载要求）；
 * - 返回的 content 为存储契约 open() 的只读内容流，仅供 adapter 组装响应；
 *   本用例不依赖 node:fs，不感知服务器绝对路径（负责人 0910 要求）。
 */
@Injectable()
export class GetReferenceDocumentFileUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(REFERENCE_DOCUMENT_STORAGE)
    private readonly storage: ReferenceDocumentStorage,
  ) {}

  async execute(command: GetReferenceDocumentFileCommand): Promise<ReferenceDocumentFilePayload> {
    assertReferenceDocumentDownloadRole(command.session.roles);
    assertDocumentIdValid(command.documentId);

    // 组织范围先解析：无有效成员关系/多关系歧义在此拒绝，不进入任何资料查询
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });

    // 不存在/已软删/跨组织由 QueryService 统一 NOT_FOUND，不区分原因
    const detail = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      organizationId: membership.organizationId,
    });

    if (
      detail.storageReference === null ||
      detail.mimeType === null ||
      detail.originalFilename === null
    ) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE, '该资料没有可下载的文件', {
        documentId: command.documentId,
      });
    }

    // 引用格式/越界与存储对象存在性校验由存储契约 open() 内部完成（先于读取）；
    // 任何存储侧失败都收敛为受控错误，不暴露实现细节
    let content: ReferenceDocumentFilePayload['content'];

    try {
      content = await this.storage.open(detail.storageReference);
    } catch {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE, '该资料没有可下载的文件', {
        documentId: command.documentId,
      });
    }

    return {
      documentId: detail.id,
      originalFilename: detail.originalFilename,
      mimeType: detail.mimeType,
      content,
    };
  }
}

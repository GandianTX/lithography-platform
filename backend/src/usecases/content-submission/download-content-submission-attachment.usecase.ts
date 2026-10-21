// src/usecases/content-submission/download-content-submission-attachment.usecase.ts

import type { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';

import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

import {
  CONTENT_SUBMISSION_ATTACHMENT_STORAGE,
  type ContentSubmissionAttachmentStorage,
} from './content-submission-attachment-storage.contract';
import {
  assertAttachmentIdValid,
  assertContentSubmissionAttachmentDownloadRole,
  assertSubmissionIdValid,
  isActiveSuperAdmin,
} from './content-submission-roles';
import {
  ContentSubmissionAttachmentFilePayload,
  DownloadContentSubmissionAttachmentCommand,
} from './content-submission.types';

/**
 * 下载投稿指定原件用例（A-PR0 §4.2 `GET /api/content-submissions/:id/attachments/:attachmentId/download`）
 *
 * - 角色粗筛（ENGINEER / SUPER_ADMIN）+ 归属精确裁决：仅「本人 + 本组织」
 *   或「本组织管理员」可下载；「本组织管理员」判定与审核链路同口径
 *   （activeRole 精确 SUPER_ADMIN），管理员兼工程师账号以工程师身份操作时
 *   不放行他人投稿附件；同组织其他工程师、跨组织、客户与不存在目标
 *   统一 NOT_FOUND，不泄露存在性（同组织其他工程师的投稿附件也不是公开数据）；
 * - 必须校验附件属于该投稿（id + submission_id 双过滤）：历史 RETIRED 原件
 *   经授权同样可下载，不只下载「当前文件」；
 * - 授权先于文件 I/O：全部校验通过后才调用存储 open()；
 *   存储对象缺失/引用不可用统一 FILE_NOT_AVAILABLE 受控错误，
 *   不泄露服务器路径、存储引用与存储后端类型（与参考资料下载口径一致）。
 */
@Injectable()
export class DownloadContentSubmissionAttachmentUsecase {
  constructor(
    private readonly contentSubmissionQueryService: ContentSubmissionQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(CONTENT_SUBMISSION_ATTACHMENT_STORAGE)
    private readonly storage: ContentSubmissionAttachmentStorage,
  ) {}

  async execute(
    command: DownloadContentSubmissionAttachmentCommand,
  ): Promise<ContentSubmissionAttachmentFilePayload> {
    assertContentSubmissionAttachmentDownloadRole(command.session);
    assertSubmissionIdValid(command.submissionId);
    assertAttachmentIdValid(command.attachmentId);

    // 组织范围先解析：无有效成员关系/多关系歧义在此拒绝，不进入任何投稿查询
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });

    // 不存在/跨组织/非本人或非本组织管理员统一 NOT_FOUND，不区分原因
    const facts = await this.contentSubmissionQueryService.findSubmissionAccessFacts({
      submissionId: command.submissionId,
    });
    const isSameOrganization =
      facts !== null && facts.ownerOrganizationId === membership.organizationId;
    const isSubmitter = facts !== null && facts.submittedByAccountId === command.session.accountId;
    const isSuperAdmin = isActiveSuperAdmin(command.session);
    if (!isSameOrganization || !(isSubmitter || isSuperAdmin)) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿附件不存在或不可访问', {
        submissionId: command.submissionId,
      });
    }

    // 附件必须属于该投稿（T10：外组织/他人的附件 ID 不可绑定到本投稿）
    const attachment = await this.contentSubmissionQueryService.findAttachmentForDownload({
      submissionId: command.submissionId,
      attachmentId: command.attachmentId,
    });
    if (!attachment) {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿附件不存在或不可访问', {
        submissionId: command.submissionId,
        attachmentId: command.attachmentId,
      });
    }

    // 引用格式/越界与存储对象存在性校验由存储契约 open() 内部完成（先于读取）；
    // 任何存储侧失败都收敛为受控错误，不暴露实现细节
    let content: Readable;
    try {
      content = await this.storage.open(attachment.storageReference);
    } catch {
      throw new DomainError(CONTENT_SUBMISSION_ERROR.FILE_NOT_AVAILABLE, '该附件没有可下载的文件', {
        attachmentId: command.attachmentId,
      });
    }

    return {
      attachmentId: attachment.id,
      originalFilename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      content,
    };
  }
}

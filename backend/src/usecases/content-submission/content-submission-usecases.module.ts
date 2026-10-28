// src/usecases/content-submission/content-submission-usecases.module.ts

import { Module } from '@nestjs/common';

import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { ApproveContentSubmissionUsecase } from './approve-content-submission.usecase';
import { CreateContentSubmissionDraftUsecase } from './create-content-submission-draft.usecase';
import { DownloadContentSubmissionAttachmentUsecase } from './download-content-submission-attachment.usecase';
import { GetContentSubmissionRevisionUsecase } from './get-content-submission-revision.usecase';
import { GetMyContentSubmissionUsecase } from './get-my-content-submission.usecase';
import { GetReviewDetailUsecase } from './get-review-detail.usecase';
import { ListMyContentSubmissionsUsecase } from './list-my-content-submissions.usecase';
import { ListReviewQueueUsecase } from './list-review-queue.usecase';
import { RemoveContentSubmissionAttachmentUsecase } from './remove-content-submission-attachment.usecase';
import { ReturnContentSubmissionUsecase } from './return-content-submission.usecase';
import { SubmitContentSubmissionUsecase } from './submit-content-submission.usecase';
import { UpdateContentSubmissionDraftUsecase } from './update-content-submission-draft.usecase';
import { UploadContentSubmissionAttachmentUsecase } from './upload-content-submission-attachment.usecase';

/**
 * 投稿用例装配（A-PR0 S3 草稿、本人查询与单附件；S4 送审/版本/退回；
 * S5 审核队列/详情与审核通过发布）。
 *
 * 组织范围（A-PR0 §2.1）由 LithographyModule 导出的可信组织上下文查询服务提供
 * （同域读侧校验，usecase 不依赖客户端自报组织）；事务边界由全局的
 * TypeOrmTransactionModule 提供的 TRANSACTION_RUNNER 注入；附件存储与上传策略
 * token 由全局的 LocalReferenceDocumentStorageModule 注入（与管理员上传同源配置）。
 * 正式案例更正（S6）在后续阶段加入本模块。
 */
@Module({
  imports: [LithographyModule],
  providers: [
    CreateContentSubmissionDraftUsecase,
    UpdateContentSubmissionDraftUsecase,
    ListMyContentSubmissionsUsecase,
    GetMyContentSubmissionUsecase,
    UploadContentSubmissionAttachmentUsecase,
    RemoveContentSubmissionAttachmentUsecase,
    DownloadContentSubmissionAttachmentUsecase,
    SubmitContentSubmissionUsecase,
    GetContentSubmissionRevisionUsecase,
    ReturnContentSubmissionUsecase,
    ListReviewQueueUsecase,
    GetReviewDetailUsecase,
    ApproveContentSubmissionUsecase,
  ],
  exports: [
    CreateContentSubmissionDraftUsecase,
    UpdateContentSubmissionDraftUsecase,
    ListMyContentSubmissionsUsecase,
    GetMyContentSubmissionUsecase,
    UploadContentSubmissionAttachmentUsecase,
    RemoveContentSubmissionAttachmentUsecase,
    DownloadContentSubmissionAttachmentUsecase,
    SubmitContentSubmissionUsecase,
    GetContentSubmissionRevisionUsecase,
    ReturnContentSubmissionUsecase,
    ListReviewQueueUsecase,
    GetReviewDetailUsecase,
    ApproveContentSubmissionUsecase,
  ],
})
export class ContentSubmissionUsecasesModule {}

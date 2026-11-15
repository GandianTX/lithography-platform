// src/usecases/stored-file/stored-file-usecases.module.ts

import { Module } from '@nestjs/common';

import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { DownloadStoredFileUsecase } from './download-stored-file.usecase';
import { GetStoredFileMetadataUsecase } from './get-stored-file-metadata.usecase';
import { UploadStoredFileUsecase } from './upload-stored-file.usecase';

/**
 * 共用业务原件用例装配（任务 11：上传暂存 / 元数据 / 授权下载）。
 *
 * - 业务绑定能力在 RepairRequestUsecasesModule（任务 04 保存用例同域调用）；
 * - 事务由全局 TypeOrmTransactionModule 的 TRANSACTION_RUNNER 提供；
 * - 私有存储与 MIME 白名单由全局 LocalReferenceDocumentStorageModule 注入
 *   （与参考资料/投稿附件同一存储实现与配置源，安全边界不复制）。
 */
@Module({
  imports: [LithographyModule, AccountInstallerModule],
  providers: [UploadStoredFileUsecase, GetStoredFileMetadataUsecase, DownloadStoredFileUsecase],
  exports: [UploadStoredFileUsecase, GetStoredFileMetadataUsecase, DownloadStoredFileUsecase],
})
export class StoredFileUsecasesModule {}

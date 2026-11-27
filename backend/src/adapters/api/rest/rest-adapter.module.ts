// src/adapters/api/rest/rest-adapter.module.ts

import { Module } from '@nestjs/common';

import { ContentSubmissionUsecasesModule } from '@src/usecases/content-submission/content-submission-usecases.module';
import { ReferenceDocumentUsecasesModule } from '@src/usecases/reference-document/reference-document-usecases.module';
import { StoredFileUsecasesModule } from '@src/usecases/stored-file/stored-file-usecases.module';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';

import { ContentSubmissionRestController } from './content-submission/content-submission-rest.controller';
import { ReferenceDocumentRestController } from './reference-document/reference-document-rest.controller';
import { StoredFileRestController } from './stored-file/stored-file-rest.controller';
import { LocalBackupCloudPackageRestController } from './local-runtime/local-backup-cloud-package-rest.controller';

/**
 * REST 边界装配（文件上传/下载等多部分端点；GraphQL 继续负责查询与其他操作）。
 * 上传大小/白名单运行时配置已随业务规则迁移至 usecase 层单一真源
 * （reference-document-usecases.module.ts wiring，负责人 0910 架构要求）。
 */
@Module({
  imports: [
    ReferenceDocumentUsecasesModule,
    ContentSubmissionUsecasesModule,
    StoredFileUsecasesModule,
    // 云端备份包授权下载（任务 09 S4／A09-07）：包字节走 REST 字节流，避免大包进 GraphQL
    LocalRuntimeUsecasesModule,
  ],
  controllers: [
    ReferenceDocumentRestController,
    ContentSubmissionRestController,
    StoredFileRestController,
    LocalBackupCloudPackageRestController,
  ],
})
export class RestAdapterModule {}

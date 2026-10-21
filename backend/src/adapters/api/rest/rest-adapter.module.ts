// src/adapters/api/rest/rest-adapter.module.ts

import { Module } from '@nestjs/common';

import { ContentSubmissionUsecasesModule } from '@src/usecases/content-submission/content-submission-usecases.module';
import { ReferenceDocumentUsecasesModule } from '@src/usecases/reference-document/reference-document-usecases.module';

import { ContentSubmissionRestController } from './content-submission/content-submission-rest.controller';
import { ReferenceDocumentRestController } from './reference-document/reference-document-rest.controller';

/**
 * REST 边界装配（文件上传/下载等多部分端点；GraphQL 继续负责查询与其他操作）。
 * 上传大小/白名单运行时配置已随业务规则迁移至 usecase 层单一真源
 * （reference-document-usecases.module.ts wiring，负责人 0910 架构要求）。
 */
@Module({
  imports: [ReferenceDocumentUsecasesModule, ContentSubmissionUsecasesModule],
  controllers: [ReferenceDocumentRestController, ContentSubmissionRestController],
})
export class RestAdapterModule {}

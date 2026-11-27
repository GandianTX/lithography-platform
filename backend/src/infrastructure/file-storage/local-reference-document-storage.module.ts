// src/infrastructure/file-storage/local-reference-document-storage.module.ts

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CONTENT_SUBMISSION_ATTACHMENT_STORAGE } from '@src/usecases/content-submission/content-submission-attachment-storage.contract';
import {
  CONTENT_SUBMISSION_ATTACHMENT_ALLOWED_MIME_TYPES,
  CONTENT_SUBMISSION_ATTACHMENT_UPLOAD_MAX_BYTES,
} from '@src/usecases/content-submission/content-submission-attachment-upload.contract';
import {
  REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES,
  REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES,
} from '@src/usecases/common/ports/reference-document-upload.contract';
import { REFERENCE_DOCUMENT_STORAGE } from '@src/usecases/common/ports/reference-document-storage.contract';
import { STORED_FILE_STORAGE } from '@src/usecases/common/ports/stored-file-storage.contract';
import { STORED_FILE_ALLOWED_MIME_TYPES } from '@src/usecases/stored-file/stored-file-upload.contract';

import { LocalReferenceDocumentStorage } from './local-reference-document-storage';
import { LocalStoredFileStorage } from './local-stored-file-storage';

/**
 * 历史维修记录与投稿附件文件存储/上传策略 token 装配（与 TypeOrmTransactionModule 同模式：全局 + useExisting）。
 * 运行时配置读取归 infrastructure wiring（架构规则）；上传大小/MIME 白名单由本模块注入，
 * usecase 层作为业务规则单一真源消费（负责人 0910 架构要求）。
 *
 * 投稿附件（A-PR0 §2.3 口径 6）复用同一本地存储实例与同一 ConfigService 配置源
 * （referenceDocumentStorage.*）——默认限制与管理员上传保持一致、配置可收窄，
 * 不另设第二套上限/白名单来源。
 */
@Global()
@Module({
  providers: [
    LocalReferenceDocumentStorage,
    { provide: REFERENCE_DOCUMENT_STORAGE, useExisting: LocalReferenceDocumentStorage },
    // 投稿附件与历史维修记录共用同一存储实例（同一存储根、同一安全实现）
    {
      provide: CONTENT_SUBMISSION_ATTACHMENT_STORAGE,
      useExisting: LocalReferenceDocumentStorage,
    },
    {
      provide: REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES,
      useFactory: (configService: ConfigService) =>
        configService.get<number>('referenceDocumentStorage.uploadMaxBytes', 20 * 1024 * 1024),
      inject: [ConfigService],
    },
    {
      provide: REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES,
      useFactory: (configService: ConfigService) =>
        configService.get<string[]>('referenceDocumentStorage.allowedMimeTypes', []),
      inject: [ConfigService],
    },
    // 投稿附件上传策略：与管理员上传读同一配置 key（env 收窄同时作用于两条链路）
    {
      provide: CONTENT_SUBMISSION_ATTACHMENT_UPLOAD_MAX_BYTES,
      useFactory: (configService: ConfigService) =>
        configService.get<number>('referenceDocumentStorage.uploadMaxBytes', 20 * 1024 * 1024),
      inject: [ConfigService],
    },
    {
      provide: CONTENT_SUBMISSION_ATTACHMENT_ALLOWED_MIME_TYPES,
      useFactory: (configService: ConfigService) =>
        configService.get<string[]>('referenceDocumentStorage.allowedMimeTypes', []),
      inject: [ConfigService],
    },
    // 共用业务原件（任务 11）：复用同一本地存储实现与同一配置 key；
    // 同一实现实例同时满足历史维修记录/投稿/原件三个契约，安全边界不复制
    LocalStoredFileStorage,
    { provide: STORED_FILE_STORAGE, useExisting: LocalStoredFileStorage },
    {
      provide: STORED_FILE_ALLOWED_MIME_TYPES,
      useFactory: (configService: ConfigService) =>
        configService.get<string[]>('referenceDocumentStorage.allowedMimeTypes', []),
      inject: [ConfigService],
    },
  ],
  exports: [
    REFERENCE_DOCUMENT_STORAGE,
    REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES,
    REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES,
    CONTENT_SUBMISSION_ATTACHMENT_STORAGE,
    CONTENT_SUBMISSION_ATTACHMENT_UPLOAD_MAX_BYTES,
    CONTENT_SUBMISSION_ATTACHMENT_ALLOWED_MIME_TYPES,
    STORED_FILE_STORAGE,
    STORED_FILE_ALLOWED_MIME_TYPES,
  ],
})
export class LocalReferenceDocumentStorageModule {}

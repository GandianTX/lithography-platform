// src/usecases/stored-file/stored-file.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { Readable } from 'node:stream';
import type { StoredFileMetadataView } from '@src/modules/lithography/lithography.types';

/** 上传暂存命令：业务用途由服务端白名单裁决，组织与账号全部来自可信会话 */
export type UploadStoredFileCommand = {
  session: UsecaseSession;
  businessType: string;
  file: {
    buffer: Buffer;
    originalFilename: string;
  };
};

/** 上传结果：含服务端生成的 uploadContextId，供后续暂存读取/绑定使用 */
export type UploadedStoredFileView = StoredFileMetadataView;

/** 元数据查询命令 */
export type GetStoredFileMetadataQuery = {
  session: UsecaseSession;
  fileId: string;
  /** 暂存读取必填；正式业务读取忽略 */
  uploadContextId?: string | null;
};

/** 下载命令 */
export type DownloadStoredFileQuery = {
  session: UsecaseSession;
  fileId: string;
  /** 暂存读取必填；正式业务读取忽略 */
  uploadContextId?: string | null;
};

/** 下载结果：文件流与原始文件名，不包含存储引用 */
export type StoredFileDownloadResult = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  content: Readable;
};

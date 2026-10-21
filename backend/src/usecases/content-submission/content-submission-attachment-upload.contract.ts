// src/usecases/content-submission/content-submission-attachment-upload.contract.ts

/**
 * 投稿附件上传策略 token（A-PR0 §2.3 补充口径 6：每投稿最多一个当前附件、
 * 默认 20 MiB；沿用现有管理员上传白名单与服务端配置，配置可收窄）。
 *
 * 运行时配置由 LocalReferenceDocumentStorageModule 读取参考资料的同一
 * ConfigService 配置源后注入——管理员上传与投稿附件共享同一服务端
 * 大小上限与 MIME 白名单，不另设第二套来源；
 * 扩展名 → MIME 映射单一真源在 usecases/common/file-upload.contract.ts。
 *
 * REST 边界的 multer 硬上限属于传输层防御，不属于本契约（见 REST controller）。
 */

/** 附件上传业务大小上限（默认 20 MiB，与管理员上传同源） */
export const CONTENT_SUBMISSION_ATTACHMENT_UPLOAD_MAX_BYTES = Symbol(
  'CONTENT_SUBMISSION_ATTACHMENT_UPLOAD_MAX_BYTES',
);

/** 附件上传 MIME 白名单（默认与管理员上传同白名单，env 可收窄） */
export const CONTENT_SUBMISSION_ATTACHMENT_ALLOWED_MIME_TYPES = Symbol(
  'CONTENT_SUBMISSION_ATTACHMENT_ALLOWED_MIME_TYPES',
);

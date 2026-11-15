// src/usecases/stored-file/stored-file-upload.contract.ts

/**
 * 共用业务原件上传策略。
 *
 * 大小上限以已接受迁移 `chk_stored_file_size`（1..20,000,000）为准：
 * 配置只能收窄、不能放大，避免超出数据库 CHECK 造成半成功。
 * MIME 白名单复用参考资料上传的同一配置 key（env 可收窄），
 * 扩展名 → MIME 映射单一真源在 usecases/common/file-upload.contract.ts。
 */

/** 数据库 CHECK 允许的精确上限（字节） */
export const STORED_FILE_UPLOAD_MAX_BYTES = 20_000_000;

/** 上传 MIME 白名单（与参考资料上传读同一配置 key） */
export const STORED_FILE_ALLOWED_MIME_TYPES = Symbol('STORED_FILE_ALLOWED_MIME_TYPES');

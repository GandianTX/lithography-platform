// src/usecases/reference-document/reference-document-upload.contract.ts

/**
 * 带文件创建的上传策略单一真源（负责人 0910 要求：文件类型、大小等业务规则
 * 唯一后端真源，不得在 Controller 与 Usecase 两处漂移）。
 *
 * - 运行时配置 token 由相邻 reference-document-usecases.module.ts wiring 读取后注入；
 * - 扩展名 → 规范 MIME 映射与 config.module 默认白名单同源维护，以扩展名为主判定、
 *   以映射结果写入数据库 MIME，不信任客户端 Content-Type（负责人 0909 第二轮口径）；
 * - REST 边界的 multer 硬上限属于传输层防御，不属于本契约（见 REST controller）。
 */

/** 上传业务大小上限 */
export const REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES = Symbol('REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES');

/** 上传 MIME 白名单（env 可收窄内置映射，不可凭空放行映射外的 MIME） */
export const REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES = Symbol(
  'REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES',
);

/**
 * 扩展名 → 规范 MIME 映射（单一真源已提炼至 usecases/common/file-upload.contract.ts，
 * 管理员上传与投稿附件共用）：本文件 re-export 保持既有导入兼容。
 * 白名单外扩展名（含无扩展名）一律 UPLOAD_FILE_TYPE_NOT_ALLOWED。
 */
export { EXTENSION_TO_MIME } from '@src/usecases/common/file-upload.contract';

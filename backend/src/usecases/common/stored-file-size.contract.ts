// src/usecases/common/stored-file-size.contract.ts

/**
 * 共用业务原件登记大小上限（跨 usecase 边界契约）。
 *
 * 大小上限以已接受迁移 `chk_stored_file_size`（1..20,000,000）为准：
 * 配置只能收窄、不能放大，避免超出数据库 CHECK 造成半成功。
 * 单一真源定义于此（usecases/common 边界契约，任务 07 P2 来源报告
 * 原件下载链路复用同一上限做登记完整性校验）；
 * `usecases/stored-file/stored-file-upload.contract` 原样 re-export 保持既有导入。
 */

/** 数据库 CHECK 允许的精确上限（字节） */
export const STORED_FILE_UPLOAD_MAX_BYTES = 20_000_000;

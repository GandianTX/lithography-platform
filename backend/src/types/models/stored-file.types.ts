// src/types/models/stored-file.types.ts
// 共用业务原件的稳定共享枚举（Entity / modules / usecases / adapter 共用，不复制第二套）。

/**
 * 业务引用类型。
 *
 * 任务 11 只落地当前唯一真实消费者（任务 04 内部维修过程）；
 * 任务 03 报修原件、任务 06 报告原件在各自任务中扩展本枚举，
 * 不提前放开无真实接入方的用途。
 */
export enum StoredFileBusinessType {
  REPAIR_PROCESS = 'REPAIR_PROCESS',
}

/** 原件校验状态（数据库 chk_stored_file_status 真源：STAGING/VALID/FAILED） */
export enum StoredFileStatus {
  STAGING = 'STAGING',
  VALID = 'VALID',
  FAILED = 'FAILED',
}

/** 原件绑定状态（数据库 chk_stored_file_binding_status 真源：TEMPORARY/BOUND） */
export enum StoredFileBindingStatus {
  TEMPORARY = 'TEMPORARY',
  BOUND = 'BOUND',
}

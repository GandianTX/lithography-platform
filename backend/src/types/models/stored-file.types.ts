// src/types/models/stored-file.types.ts
// 共用业务原件的稳定共享枚举（Entity / modules / usecases / adapter 共用，不复制第二套）。

/**
 * 业务引用类型。
 *
 * 任务 11 落地内部维修过程（任务 04）；任务 03 追加客户报修原件。
 * 任务 06 报告原件在各自任务中扩展本枚举，不提前放开无真实接入方的用途。
 *
 * 说明：`REPAIR_REQUEST` 的绑定业务标识是报修原始输入主键
 * （`repair_request_intake.id`），不是维修工单主键；两类用途的
 * business_id 语义互不复用。
 */
export enum StoredFileBusinessType {
  REPAIR_PROCESS = 'REPAIR_PROCESS',
  REPAIR_REQUEST = 'REPAIR_REQUEST',
  /** 任务 06 维修报告原件（独立历史记录与工单总结共用一份报告附件集合） */
  MAINTENANCE_REPORT = 'MAINTENANCE_REPORT',
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

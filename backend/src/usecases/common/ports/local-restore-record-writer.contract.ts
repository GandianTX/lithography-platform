// src/usecases/common/ports/local-restore-record-writer.contract.ts

/**
 * 恢复执行的**业务数据受控写入**契约（任务 09 S5-2）。
 *
 * 为什么要中立端口：恢复要把备份载荷里的**业务行**写回本机，
 * 但**不得**由恢复编排直接写业务表（与记录包导入同一条纪律：
 * "实现方不得绕过来源域的受控入口直接写业务表"）。
 * 因此由**来源域**注册实现，任务 09 在调用期按令牌查找，未注册即逐项失败关闭。
 */
export const LOCAL_RESTORE_RECORD_WRITER = Symbol('LOCAL_RESTORE_RECORD_WRITER');

/** 可恢复的业务表（受控枚举；与备份范围表一致，去掉本机运行数据） */
export const LOCAL_RESTORE_RECORD_TABLES = [
  'repair_request',
  'maintenance_report',
  'reference_document',
  'stored_file',
] as const;

export type LocalRestoreRecordTable = (typeof LOCAL_RESTORE_RECORD_TABLES)[number];

export type LocalRestoreRecordWriteRequest = {
  /** 恢复目标公司数据区 */
  organizationId: number;
  /** 恢复运行 ID（写入事实可追溯） */
  restoreId: string;
  /** 目标表 */
  table: LocalRestoreRecordTable;
  /** 待写回的业务行（来自备份载荷；调用方已解密） */
  rows: readonly Record<string, unknown>[];
};

export type LocalRestoreRecordWriteOutcome = {
  status: 'WRITTEN' | 'SKIPPED' | 'FAILED';
  /** 实际写入行数 */
  written: number;
  /** 受控原因（失败时必有；不含敏感材料） */
  reason: string | null;
};

export interface LocalRestoreRecordWriter {
  /** 本实现支持的表；不支持的表必须由调用方判为失败关闭 */
  readonly supportedTables: readonly LocalRestoreRecordTable[];
  write(request: LocalRestoreRecordWriteRequest): Promise<LocalRestoreRecordWriteOutcome>;
  /**
   * 核验：该表当前在该公司的行数。
   *
   * 由**来源域**按真实事实给出（恢复编排不直接查业务表，避免口径漂移）。
   */
  count(input: { organizationId: number; table: LocalRestoreRecordTable }): Promise<number>;
}

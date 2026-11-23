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

/**
 * 可恢复的业务表（受控枚举；与备份范围表一致，去掉本机运行事实表）。
 *
 * 顺序即**外键顺序**（先父后子）：清空时按其逆序，写回时按此序。
 */
export const LOCAL_RESTORE_RECORD_TABLES = [
  'stored_file',
  'repair_request',
  'repair_request_revision',
  'maintenance_report',
  'maintenance_report_alarm',
  'maintenance_report_step',
  'maintenance_report_fault',
  'maintenance_report_version',
  'maintenance_report_attachment',
  'maintenance_report_version_attachment',
  'reference_document',
  'reference_document_revision',
  'local_upload_task',
] as const;

export type LocalRestoreRecordTable = (typeof LOCAL_RESTORE_RECORD_TABLES)[number];

/** 单表的待写回行 */
export type LocalRestoreRecordTablePayload = {
  table: LocalRestoreRecordTable;
  /** 待写回的业务行（来自备份载荷；调用方已解密） */
  rows: readonly Record<string, unknown>[];
};

export type LocalRestoreRecordWriteRequest = {
  /** 恢复目标公司数据区 */
  organizationId: number;
  /** 恢复运行 ID（写入事实可追溯） */
  restoreId: string;
  /**
   * 全部业务表的待写回行。
   *
   * 为什么是**整体**而不是逐表：清空＋写回必须在**同一事务**内完成
   * （否则中途失败会留下"部分表已替换、部分表还是旧值"的自相矛盾状态）。
   */
  tables: readonly LocalRestoreRecordTablePayload[];
};

export type LocalRestoreRecordWriteOutcome = {
  status: 'WRITTEN' | 'SKIPPED' | 'FAILED';
  /** 实际写入行数 */
  written: number;
  /** 逐表写入行数 */
  counts: Record<string, number>;
  /** 受控原因（失败时必有；不含敏感材料） */
  reason: string | null;
};

/** 清单里的原件事实（与备份清单同源） */
export type LocalRestoreOriginalFact = {
  /** 原件来源标记：`stored_file:<fileId>` / `reference_document:<id>` */
  readonly source: string;
  /** 原件在来源存储中的引用 */
  readonly storage_reference: string;
  /** 登记校验值（可空） */
  readonly sha256: string | null;
};

/** 清单里的包内文件事实（用于核对字节与摘要） */
export type LocalRestorePackageFileFact = {
  readonly relative_path: string;
  readonly sha256: string;
  readonly byte_size: number;
};

export interface LocalRestoreRecordWriter {
  /** 本实现支持的表；不支持的表必须由调用方判为失败关闭 */
  readonly supportedTables: readonly LocalRestoreRecordTable[];
  write(request: LocalRestoreRecordWriteRequest): Promise<LocalRestoreRecordWriteOutcome>;
  /**
   * 还原**原件字节**（任务 09 S2-3）。
   *
   * 业务表恢复只还原"原件的登记事实"（存储引用、校验值、字节数）；
   * 真正的字节在备份包里（`files/`），必须由来源域按包内清单核对后写回本地存储，
   * 并把行上的存储引用指向新写入的字节——恢复编排不直接改业务行。
   *
   * 实现方必须：
   * - 只按包内**相对路径**读文件，并逐个核对字节数与 SHA-256（不符即该原件失败）；
   * - 本机已有同引用且可读、字节一致时不重复写入（避免留下孤儿副本）；
   * - 失败时给出受控原因，不静默跳过。
   */
  restoreOriginals(input: {
    organizationId: number;
    restoreId: string;
    /** 包根目录（本机绝对路径；由编排层校验后传入） */
    packageRoot: string;
    /** 清单原件事实 */
    originals: readonly LocalRestoreOriginalFact[];
    /** 清单包内文件事实 */
    files: readonly LocalRestorePackageFileFact[];
  }): Promise<{ restored: number; failed: number; reason: string | null }>;
  /**
   * 核验：该表当前在该公司的行数。
   *
   * 由**来源域**按真实事实给出（恢复编排不直接查业务表，避免口径漂移）。
   */
  count(input: { organizationId: number; table: LocalRestoreRecordTable }): Promise<number>;
}

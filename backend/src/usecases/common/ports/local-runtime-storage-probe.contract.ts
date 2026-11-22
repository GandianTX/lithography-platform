// src/usecases/common/ports/local-runtime-storage-probe.contract.ts

/**
 * 本机存储位置探测 boundary contract（usecase 层拥有，infrastructure 实现）。
 *
 * 目的：让「本地设置」只读页展示部署配置中的**真实**保存位置与可用状态，
 * 而不是前端拼接或猜测的路径（R064）。
 *
 * 约束：
 * - 只读取部署配置给出的目录，**不得遍历或扫描文件系统**，也不得创建目录；
 * - 返回的是配置值本身（可为相对路径），服务器绝对路径属实现私有细节；
 * - 目录不存在或不可写时返回 `false`，不抛错——"未就绪"是合法状态而非异常。
 */
export const LOCAL_RUNTIME_STORAGE_PROBE = Symbol('LOCAL_RUNTIME_STORAGE_PROBE');

export type LocalRuntimeStorageProbeResult = {
  /** 业务原件目录（部署配置值） */
  readonly businessFileDirectory: string;
  readonly businessFileDirectoryWritable: boolean;
  /** 备份包目录（部署配置值，与业务原件目录物理分离） */
  readonly backupDirectory: string;
  readonly backupDirectoryWritable: boolean;
};

export interface LocalRuntimeStorageProbe {
  probe(): Promise<LocalRuntimeStorageProbeResult>;
}

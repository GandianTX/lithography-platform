// src/usecases/common/ports/sync-conflict-local-resolution-writer.contract.ts

/**
 * 冲突裁决的**保留本地受控写入**契约（任务 09 第 05 项 · P1-5／G10）。
 *
 * 为什么要中立端口：「保留本地」要把**本地快照**作为一次受控修订写回**来源业务行**，
 * 这属于来源域的写语义。与「使用云端」的本地视图对齐同一条纪律：
 * 冲突编排不得直接写业务表，必须由**来源域**注册实现，编排侧按令牌查找；
 * 未注册即失败关闭（不静默降级为"只改冲突事实"）。
 *
 * 与本地视图对齐端口的区别：
 * - 对齐端口写的是**云端内容**（把本地视图推向云端）；
 * - 本端口写的是**本地内容**（把本地版本作为受控版本留痕并保留），
 *   并且允许"内容与当前一致"的**留痕型修订**——保留本地的对象本来就是本地当前内容，
 *   业务上必须有可追溯的修订历史行，不能因为"值没变"就把裁决留痕丢掉。
 */
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { LocalResolutionReferenceDocumentPayload } from '@core/local-runtime/policy/sync-conflict-local-resolution.policy';

export const SYNC_CONFLICT_LOCAL_RESOLUTION_WRITER = Symbol(
  'SYNC_CONFLICT_LOCAL_RESOLUTION_WRITER',
);

export type SyncConflictLocalResolutionWriteCommand = {
  /** 来源记录的本机主键 */
  recordId: number;
  /** 版本条件：必须等于来源记录当前版本（并发裁决的唯一依据） */
  expectedVersion: number;
  /** 受控载荷（已按来源域白名单裁剪；字段含义由 core 策略决定） */
  payload: LocalResolutionReferenceDocumentPayload;
  /** 裁决人账号（写进修订历史行，可追溯） */
  actorAccountId: number;
  /** 修订原因（进修订历史行；调用方可补冲突 ID 以便回溯） */
  reason: string;
};

export type SyncConflictLocalResolutionWriteOutcome = {
  /** 是否产生了新的本地业务版本（留痕型修订恒为 true） */
  written: boolean;
  /** 写入后的来源记录版本号 */
  writtenVersion: number;
};

export interface SyncConflictLocalResolutionWriter {
  /** 本实现支持的来源资源类型；不支持的必须由调用方判为失败关闭 */
  readonly supportedResourceTypes: readonly string[];
  /**
   * 把本地快照作为一次受控修订写回来源记录。
   *
   * 实现方必须：
   * - 按 `expectedVersion` 做**版本条件**更新（命中 0 行即版本冲突，不得覆盖）；
   * - **只写受控白名单字段**（资料：标题／说明；正文不反写）；
   * - 拒绝只读来源（已删除／下架／归属待确认）与不可用来源；
   * - 写一条**新的修订历史行**（前后快照＋修改人＋原因），历史只追加不覆盖；
   * - 允许"内容与当前一致"的留痕型修订（保留本地要留下裁决留痕）。
   */
  writeLocalVersion(
    command: SyncConflictLocalResolutionWriteCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SyncConflictLocalResolutionWriteOutcome>;
}

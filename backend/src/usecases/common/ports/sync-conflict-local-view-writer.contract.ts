// src/usecases/common/ports/sync-conflict-local-view-writer.contract.ts

/**
 * 冲突裁决的**本地视图受控写入**契约（任务 09 R068）。
 *
 * 为什么要中立端口：「使用云端」要把云端快照对齐成**本地的当前有权视图**
 * （R068 明写"UPDATE 本地当前视图"），这要写**来源业务行**。
 * 与恢复链同一条纪律：**任务 09 的冲突编排不得直接写业务表**
 * （"实现方不得绕过来源域的受控入口直接写业务表"），
 * 因此由**来源域**注册实现，任务 09 在调用期按令牌查找；
 * 未注册即失败关闭（不静默降级为"只改冲突事实"）。
 *
 * 与恢复链端口的区别：恢复端口是**整表写回**（批量、按表），
 * 本端口是**单记录的一次受控视图对齐**（按来源记录、带版本条件）。
 */
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { SyncConflictCloudAlignmentPayload } from '@core/local-runtime/policy/sync-conflict-cloud-alignment.policy';

export const SYNC_CONFLICT_LOCAL_VIEW_WRITER = Symbol('SYNC_CONFLICT_LOCAL_VIEW_WRITER');

export type SyncConflictLocalViewWriteCommand = {
  /** 冲突登记的公司数据区 */
  organizationId: number;
  /** 来源记录的本机主键 */
  recordId: number;
  /** 受控对齐载荷（由 core 策略按来源类型给出；字段含义已裁剪） */
  payload: SyncConflictCloudAlignmentPayload;
  /** 采用者账号（写进修订历史行，可追溯） */
  actorAccountId: number;
  /** 修订原因（进修订历史行；调用方可补冲突 ID 以便回溯） */
  reason: string;
};

export type SyncConflictLocalViewWriteOutcome = {
  /** 是否真的产生了新的本地业务版本（内容已一致时为 false ⇒ 不产生多余版本） */
  aligned: boolean;
  /** 对齐后的本地版本号（未产生新版本时为来源记录原版本） */
  alignedVersion: number;
};

export interface SyncConflictLocalViewWriter {
  /** 本实现支持的来源资源类型；不支持的必须由调用方判为失败关闭 */
  readonly supportedResourceTypes: readonly string[];
  /**
   * 把云端快照对齐为本地当前视图。
   *
   * 实现方必须：
   * - 按 `expectedVersion` 做**版本条件**更新（命中 0 行即版本冲突，不得覆盖）；
   * - **只写受控白名单字段**，不改客户原始提交、接单事实、组织归属与状态机事实；
   * - 写一次**新的业务版本**（历史只追加，不覆盖），并留下修改人与原因；
   * - 内容已经与云端一致时**不产生新版本**（重复确认不产生多余业务版本）。
   */
  alignLocalViewToCloud(
    command: SyncConflictLocalViewWriteCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SyncConflictLocalViewWriteOutcome>;
}

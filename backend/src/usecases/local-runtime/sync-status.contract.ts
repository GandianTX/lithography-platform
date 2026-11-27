// src/usecases/local-runtime/sync-status.contract.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type {
  SyncStatus,
  SyncStatusReasonCode,
} from '@core/local-runtime/policy/sync-status.policy';

/**
 * 业务同步状态查询的内部契约（任务 09 后续S1；任务 07 装配方调用）。
 *
 * 定位：这是**任务 09 与任务 07 之间的窄边界**，不是浏览器 API。
 * - 任务 07 在装配前用默认适配器返回 `NOT_CONNECTED`（不查同步表、不触发上传）；
 * - 任务 09 提供本接口的真实实现（读本机事实，不产生副作用）；
 * - 列表页与详情页**共用同一份实现**，因此两处展示语义必然一致。
 *
 * 授权口径：调用方传会话与请求键；公司、类型、稳定键与当前版本都以**服务端事实**为准，
 * 客户端传入的公司与版本不参与裁决（客户端版本仅用于回显核对）。
 */
export const SYNC_STATUS_QUERY = Symbol('SYNC_STATUS_QUERY');

/** 单次批量查询的条数上限（对齐记录包导出的批量上限口径） */
export const SYNC_STATUS_QUERY_MAX_BATCH = 50;

export type SyncStatusQueryRequest = {
  /** 调用方认定的公司；仅用于与来源事实核对，不参与裁决 */
  organizationId: number;
  /** 来源资源类型：REFERENCE_DOCUMENT／REPAIR_REQUEST／MAINTENANCE_REPORT */
  resourceType: string;
  /** 业务稳定键 */
  recordUuid: string;
  /** 调用方看到的版本；本实现不信任，仅回显核对 */
  sourceVersion: number | null;
};

export type SyncStatusQueryItem = {
  /** 服务端事实：公司取来源记录归属，取不到归属时不返回条目 */
  organizationId: number;
  /** 服务端事实：资源类型取来源记录类型 */
  resourceType: string;
  recordUuid: string;
  /** 服务端认定的当前版本；不可核验时为 null */
  sourceVersion: number | null;
  /**
   * 该稳定键是否为源表**持久化**的跨端稳定编号。
   *
   * - true：身份已持久化，可随记录包搬运到其他设备，跨端唯一；
   * - false：历史行仅由本机自增 ID 派生，**仅设备内唯一**，跨端唯一性不成立。
   */
  identityPersisted: boolean;
  /** 调用方传入的版本（原样回显，便于调用方发现版本不一致） */
  requestedVersion: number | null;
  /** 调用方版本与服务端版本是否一致；调用方未提供版本时为 null */
  versionAligned: boolean | null;
  status: SyncStatus;
  /** 安全原因码（可本地化，不含正文与快照） */
  reasonCode: SyncStatusReasonCode | null;
  /** 当前版本的待处理冲突标识；不可读时为 null */
  conflictId: string | null;
  /**
   * 是否具备处理该冲突的权限。
   *
   * 成立条件（三条同时满足，缺一不给入口）：
   * 1. 记录级授权通过（可读）；
   * 2. 写权成立——与 `resolve-sync-conflict.usecase.ts` 的实际准入一致
   *    （一级管理员全局授权范围；工程师／二级管理员限本公司数据区）；
   * 3. **当前展示版本二次校验**——调用方传入的版本与服务端认定的当前版本一致，
   *    且该版本落在冲突固化的版本集合内。
   *
   * 入口只表示"可以进入冲突处理"；具体处理方向（采用云端／稍后处理）由裁决
   * 入口决定，"保留本地"方向当前由裁决入口显式拒绝（尚未接入受控版本写入）。
   */
  canResolveConflict: boolean;
};

export interface SyncStatusQueryPort {
  /**
   * 批量查询同步状态。
   *
   * - 只返回**通过记录级授权**的记录；越权或无法核对归属的记录不返回任何条目，
   *   调用方据此不展示该条的同步列（不泄露该记录是否存在）；
   * - 同一稳定键重复出现时按完整键去重；
   * - 本实现不产生任何副作用（不触发上传、不写回执、不改状态）。
   */
  queryStatuses(params: {
    session: UsecaseSession;
    requests: readonly SyncStatusQueryRequest[];
  }): Promise<readonly SyncStatusQueryItem[]>;
}

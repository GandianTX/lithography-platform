// src/modules/lithography/sync.types.ts

import type { SyncConflictDiffResult } from '@core/local-runtime/policy/sync-conflict-diff.policy';
import type {
  SyncConflictAction,
  SyncConflictDecision,
} from '@core/local-runtime/policy/sync-conflict-resolve.policy';

/**
 * 本地业务同步读模型契约（任务 09 S2，R065–R069）。
 *
 * - `sync_conflict` 没有 `installation_id` 列：同一台设备只有一个安装，
 *   公司数据区就是隔离边界（`organization_id`）；
 * - 快照在库中是 JSON 文本，读模型原样搬运，不在这里做字段级解释；
 * - `confirmedByAccountId`／`confirmedAt` 只在 RESOLVED／IGNORED 时非空
 *   （DB CHECK 强制），读模型不做二次加工。
 */
export type SyncConflictSnapshot = {
  conflictId: string;
  recordUuid: string;
  organizationId: number;
  resourceType: string;
  versionNo: number;
  localVersion: number | null;
  cloudVersion: number | null;
  displayedCloudVersion: number | null;
  decision: SyncConflictDecision | null;
  status: 'PENDING' | 'RESOLVED' | 'IGNORED';
  /** 本地快照 JSON 原文（含正文与原件引用） */
  localSnapshot: string;
  /** 云端快照 JSON 原文 */
  cloudSnapshot: string;
  /** 可展示的冲突原因 */
  conflictReason: string;
  /**
   * 字段级差异（任务 09 S2.3）：由本地快照与云端快照摊平比较得出。
   * 摘要视图不含差异（无快照可比），故为可选。
   */
  diff?: SyncConflictDiffResult | null;
  /**
   * 来源记录的**本机** ID（任务 09 S2.3）：页面据此跳回来源页入口。
   * 取不到时为 null（页面据此不提供来源页跳转，不猜路径）。
   */
  sourceRecordId?: number | null;
  /** 来源内容是否只读（已删除／下架／冻结／结单）：只读内容不得恢复或覆盖 */
  sourceReadOnly?: boolean;
  /** 只读受控原因码 */
  sourceReadOnlyReason?: string | null;
  /**
   * 是否允许采用云端视图（R066）。
   *
   * 已结单（结单后只读）允许**只读采用**；已删除／下架／冻结一律不允许。
   */
  canAdoptCloud?: boolean;
  /**
   * 是否为**只读采用**（来源已结单）：只呈现云端视图，不写业务记录、不获得写入权。
   */
  adoptionReadOnly?: boolean;
  confirmedByAccountId: number | null;
  confirmedAt: Date | null;
  createdAt: Date;
};

/**
 * 冲突摘要（**不含正文快照**）。
 *
 * 用途：裁决结果的返回体。裁决是一次写动作，返回体没有必要再带两份正文快照
 * （本地快照与云端快照都含正文与原件引用）；摘要只给冲突元数据与裁决事实。
 */
export type SyncConflictSummary = Omit<
  SyncConflictSnapshot,
  'localSnapshot' | 'cloudSnapshot' | 'diff'
>;

/**
 * 裁决用的冲突视图（**不含正文快照**）：裁决路径只需要元数据与本地快照。
 * 由服务层返回，usecase 层不消费 ORM 实体。
 */
export type SyncConflictResolutionView = {
  conflictId: string;
  recordUuid: string;
  organizationId: number;
  resourceType: string;
  status: string;
  decision: string | null;
  localVersion: number | null;
  /**
   * 云端数据版本；null 表示没有可信版本（历史行）。
   * 裁决时用它复核客户端**实际看到**的云端版本（R067）。
   */
  cloudVersion: number | null;
  /**
   * 保留本地裁决幂等状态（review M7）：
   * `WRITING`=正文写入已开始但冲突事实未改写；`WRITTEN`=正文与事实都已写回；
   * `null`=从未走过本地裁决（历史行保持 NULL，不回填）。
   */
  localResolutionState: string | null;
  /** 本地快照 JSON 原文（保留本地裁决要映射的载荷来源） */
  localSnapshot: string;
  /**
   * 云端快照 JSON 原文（**使用云端**裁决要映射的载荷来源）。
   *
   * 为什么裁决视图要带它：R068 要求"对齐本地当前有权视图"，
   * 而对齐用的受控字段来自云端快照；不读它就只能在冲突事实上打勾，
   * 本地视图仍旧是旧内容。
   */
  cloudSnapshot: string;
};

export type SyncConflictListPagination = {
  page: number;
  pageSize: number;
  withTotal?: boolean;
};

export type SyncConflictListPage = {
  items: SyncConflictSnapshot[];
  total?: number;
  page: number;
  pageSize: number;
  /** 候选超过扫描上限：可见集合是下界，如实标记，不静默丢条目 */
  truncated?: boolean;
};

export type SyncConflictListFilters = {
  /** 只看待处理；缺省返回全部状态 */
  statusOnlyPending?: boolean;
};

export type SyncConflictResolveCommand = {
  conflictId: string;
  action: SyncConflictAction;
  confirmedByAccountId: number;
  /**
   * 客户端**实际看到**的云端版本（R067：服务端必须复核，不能信前端快照）。
   * 与冲突登记的 `cloud_version` 不一致 ⇒ 云端已变化，返回刷新重确认。
   */
  displayedCloudVersion?: number | null;
  /**
   * 采用云端后本地视图对齐到的版本（=云端版本）。
   * 用于把 `local_version` 推进到云端版本，表达"本地视图已对齐"。
   */
  alignedLocalVersion?: number | null;
};

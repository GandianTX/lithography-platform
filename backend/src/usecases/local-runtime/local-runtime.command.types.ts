// src/usecases/local-runtime/local-runtime.command.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { SyncConflictAction } from '@core/local-runtime/policy/sync-conflict-resolve.policy';
import type { SyncConflictSummary } from '@src/modules/lithography/sync.types';
import type {
  LocalBackupTriggerType,
  LocalUploadTaskKind,
  LocalUploadTaskStatus,
} from '@src/modules/lithography/local-runtime.types';

export type LocalRuntimeSettingsInput = {
  localSiteName?: string | null;
  autoUploadEnabled?: boolean;
  backupIntervalDays?: number;
};

export type GetLocalRuntimeSettingsCommand = {
  session: UsecaseSession;
};

export type GetLocalRuntimeStatusCommand = {
  session: UsecaseSession;
};

export type UpdateLocalRuntimeSettingsCommand = {
  session: UsecaseSession;
  settings: LocalRuntimeSettingsInput;
};

export type LocalRuntimePagination = {
  page: number;
  pageSize: number;
  withTotal?: boolean;
};

export type EnqueueLocalUploadCommand = {
  entityType: string;
  entityLocalId: number;
  entityVersion: string;
  idempotencyKey: string;
  /**
   * 业务同步身份事实（S2 第 1 条）：
   * - recordUuid：跨端稳定业务编号（业务同步任务必填；备份类任务可空）；
   * - sourceVersion：业务版本（与来源事实核对）；
   * - manifestChecksum：正文与原件清单 SHA-256（回执完整性核对依据）；
   * - taskKind：任务种类；缺省按调用方用途登记，**不得**把备份包上云
   *   记为业务同步（读侧据此排除备份任务）。
   */
  recordUuid?: string | null;
  sourceVersion?: number | null;
  manifestChecksum?: string | null;
  taskKind?: LocalUploadTaskKind | null;
  /**
   * 公司数据区：任务归属的公司（派发与授权核对按公司范围执行）。
   * 业务同步任务必填；历史任务与备份类任务可空。
   */
  organizationId?: number | null;
  /**
   * 原账号（授权主体）账号ID：任务只能由该账号的有效授权派发，
   * 换账号／换公司不得接管原任务（R090）。
   */
  accountId?: number | null;
};

export type EnqueueLocalUploadResult = {
  taskId: number;
  status: LocalUploadTaskStatus;
  created: boolean;
};

// ---- 任务09 S2：来源记录 → 业务同步待传任务 ----

export type EnqueueSourceRecordSyncCommand = {
  /** 来源资源类型：REFERENCE_DOCUMENT／REPAIR_REQUEST／MAINTENANCE_REPORT */
  resourceType: string;
  /** 业务稳定编号（已持久化的跨端身份） */
  recordUuid: string;
};

export type EnqueueSourceRecordSyncResult = {
  taskId: number;
  status: LocalUploadTaskStatus;
  /** false 表示命中既有任务（重复提交未新建） */
  created: boolean;
  recordUuid: string;
  resourceType: string;
  /** 登记的业务版本 */
  sourceVersion: number;
  /** 正文与原件清单摘要 */
  manifestChecksum: string;
};

// ---- 任务09 S2：业务同步派发 ----

export type DispatchBusinessSyncTasksCommand = {
  /** 单轮派发任务上限 */
  limit?: number;
};

/** 单条派发的归类计数键 */
export type DispatchBusinessSyncTasksOutcome =
  'succeeded' | 'conflicted' | 'rejected' | 'retryable' | 'skipped' | 'receiverMissing';

export type DispatchBusinessSyncTasksResult = {
  /** 本轮扫描到的待传任务数 */
  scanned: number;
  /** 核对通过并落回执的任务数 */
  succeeded: number;
  /** 判定为冲突的任务数 */
  conflicted: number;
  /** 被云端或本机拒绝的任务数 */
  rejected: number;
  /** 调用异常、退回待传可续传的任务数 */
  retryable: number;
  /** 因绑定／授权／来源事实不成立而跳过的任务数 */
  skipped: number;
  /** 生产接收端缺失、任务留在待传的任务数 */
  receiverMissing: number;
};

// ---- 任务09 S2：业务同步待办对账 ----

export type ReconcileBusinessSyncTasksCommand = {
  /** 每个来源类型单轮扫描上限（缺省按服务层默认） */
  limit?: number;
};

export type ReconcileBusinessSyncTasksResult = {
  /** 本轮扫描到的来源记录条数 */
  scanned: number;
  /** 本轮新建的待传任务数 */
  created: number;
  /** 命中既有任务（重复对账未新建）的条数 */
  existing: number;
  /** 准入拒绝的条数 */
  rejected: number;
  /** 因下架／撤回而取消的待办数 */
  cancelled: number;
  /** 拒绝原因码 → 次数 */
  rejections: Record<string, number>;
};

export type LocalUploadTaskCommand = {
  taskId: number;
};

export type CompleteLocalUploadCommand = {
  taskId: number;
  remoteId: string | null;
  remoteReceipt: string | null;
};

export type FailLocalUploadCommand = {
  taskId: number;
  errorCode: string;
  errorMessage: string;
};

export type StartLocalBackupCommand = {
  triggerType: string;
  manifestPath?: string | null;
};

export type FinishLocalBackupCommand = {
  runId: number;
  status: string;
  manifestPath?: string | null;
  manifestChecksum?: string | null;
  byteSize?: number | null;
  attachmentCount?: number | null;
  schemaVersion?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type ListLocalUploadTasksCommand = {
  session: UsecaseSession;
  status?: string;
  pagination?: LocalRuntimePagination;
};

export type ListLocalBackupRunsCommand = {
  session: UsecaseSession;
  pagination?: LocalRuntimePagination;
};

export type LocalBackupTriggerTypeInput = LocalBackupTriggerType;

// ---- 任务09 S2：同步冲突读取与裁决（R066–R069）----

export type ListSyncConflictsCommand = {
  session: UsecaseSession;
  /** 只看待处理（冲突页默认入口） */
  statusOnlyPending?: boolean;
  pagination?: LocalRuntimePagination;
};

export type GetSyncConflictCommand = {
  session: UsecaseSession;
  conflictId: string;
};

export type ResolveSyncConflictCommand = {
  session: UsecaseSession;
  conflictId: string;
  action: SyncConflictAction;
  /**
   * 客户端**实际看到**的云端版本（R067）。
   *
   * 服务端必须与冲突登记的云端版本逐一对齐：缺失或不一致都拒绝裁决
   * （云端已变化 ⇒ 刷新重确认），不信任前端带来的版本或快照。
   */
  displayedCloudVersion?: number | null;
};

/** 裁决结果视图：'existing' 表示重复请求返回既有事实，'later' 保持待处理 */
export type SyncConflictResolveOutcomeView = {
  outcome: 'existing' | 'later' | 'resolved';
  /** 裁决后的冲突摘要（**不含正文快照**）：裁决返回体不携带两份正文 */
  conflict: SyncConflictSummary | null;
};

// ---- 任务09 S2：本人同公司授权续期（R065，补验 S1.3）----

export type RenewMyLocalAuthorizationCommand = {
  session: UsecaseSession;
  /** 签名凭据材料；禁止包含密码/密钥/令牌原文键（core 策略校验） */
  signedClaims: unknown;
  /** 签名权限版本，>=1（对齐 DB CHECK） */
  permissionVersion: number;
};

export type RenewMyLocalAuthorizationResult = {
  renewedAuthorizationId: string;
};

// ---- 任务09 S2.3：记录包检查与处理结果（R071／R073）----

export type CheckRecordPackageCommand = {
  session: UsecaseSession;
  /** 包目录（U盘挂载点或本机目录），内含 manifest.json 与清单引用文件 */
  packagePath: string;
};

export type GetRecordPackageResultCommand = {
  session: UsecaseSession;
  packageId: string;
};

export type ExportRecordPackageCommand = {
  session: UsecaseSession;
  /** 导出目标目录（本机绝对路径；必须不存在或为空目录） */
  targetPath: string;
  /**
   * 导出的公司数据区（一级管理员可指定任意公司，其余必须为本公司）。
   *
   * **可省略**：来源页导出入口（如「我的资料记录」的导出按钮）由服务端按**可信
   * session 范围**取本公司，不让用户手抄公司 ID；省略时若会话本身没有公司范围
   * （一级管理员全局范围）则必须显式指定。
   */
  organizationId?: number;
  /** 单一资源类型（**旧接口**，保留兼容） */
  resourceType: string;
  recordIds: number[];
  /**
   * 导出条目清单（**新形态**：可**混合多种资源类型**）。
   *
   * 提供时以它为准（`resourceType`／`recordIds` 被忽略）；不提供时按旧形态处理。
   * 与旧接口并存 ⇒ 旧客户端不受影响。
   */
  entries?: readonly { resourceType: string; recordId: number }[];
};

// ---- 任务09 S3：备份记录、自动备份设置与手动备份触发 ----

export type ListLocalBackupRecordsCommand = {
  session: UsecaseSession;
  pagination?: LocalRuntimePagination;
};

export type GetLocalBackupRecordCommand = {
  session: UsecaseSession;
  backupId: string;
};

export type GetLocalBackupSettingsCommand = {
  session: UsecaseSession;
};

/** 恢复预检命令（管理员专属；工程师不开放） */
export type PrecheckLocalRestoreCommand = {
  session: UsecaseSession;
  /** 被恢复的备份资产 ID */
  backupId: string;
};

/**
 * 手动备份触发命令。
 *
 * - 二级管理员与工程师：目标公司只能是本公司（organizationId 省略或必须等于本公司）；
 * - 一级管理员：可指定任意公司；省略时取本机映射公司，未映射则失败关闭。
 */
export type StartManualLocalBackupCommand = {
  session: UsecaseSession;
  organizationId?: number | null;
};

/** 手动三阶段（生成→上云→清理）的阶段状态；未发生的阶段如实标记 */
export type LocalBackupManualPhaseStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NOT_REQUIRED';

export type StartManualLocalBackupResult = {
  runId: number;
  organizationId: number;
  status: 'SUCCEEDED' | 'FAILED';
  backupId: string | null;
  manifestChecksum: string | null;
  byteSize: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** 上云阶段真实状态；云接收端未接入时保持 PENDING */
  uploadStatus: LocalBackupManualPhaseStatus;
  /** 清理阶段真实状态；无完整云回执时为 NOT_EXECUTED */
  cleanupStatus: LocalBackupManualPhaseStatus;
};

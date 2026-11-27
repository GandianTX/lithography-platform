// src/modules/lithography/local-runtime.types.ts
// 本地运行数据（安装身份/设置、上传任务、备份清单）的模块级契约。
// 只承载部署身份、上传意图/回执与备份清单，不复制云端业务主键。

export type LocalEntityType = 'REPORT_VERSION' | 'ATTACHMENT' | 'BACKUP_MANIFEST';

/**
 * 上传任务种类（`local_upload_task.task_kind`）：
 * - BUSINESS_SYNC：业务记录同步（读侧按正文类任务 + 完整回执判定同步成功）；
 * - BACKUP_UPLOAD：本地备份包上云（**不得**计入业务同步判定）。
 */
export type LocalUploadTaskKind = 'BUSINESS_SYNC' | 'BACKUP_UPLOAD';
export type LocalUploadTaskStatus = 'PENDING' | 'UPLOADING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type LocalBackupTriggerType = 'SCHEDULED' | 'MANUAL' | 'AUTO' | 'RETRY' | 'USB_EXPORT';
export type LocalBackupRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';

export type LocalInstallationSnapshot = {
  id: number;
  installationId: string;
  organizationId: number | null;
  organizationCodeSnapshot: string | null;
  localSiteName: string | null;
  autoUploadEnabled: boolean;
  backupIntervalDays: number;
  lastBackupCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalInstallationSettingsWriteData = {
  localSiteName: string | null;
  autoUploadEnabled: boolean;
  backupIntervalDays: number;
};

export type LocalUploadTaskSnapshot = {
  id: number;
  installationId: string;
  entityType: LocalEntityType;
  entityLocalId: number;
  entityVersion: string;
  idempotencyKey: string;
  /** 跨端稳定业务编号；备份类任务为 null */
  recordUuid: string | null;
  /** 业务版本；不可核验时为 null */
  sourceVersion: number | null;
  /** 正文与原件清单 SHA-256；缺失时为 null */
  manifestChecksum: string | null;
  /** 任务种类；历史行为 null */
  taskKind: LocalUploadTaskKind | null;
  /** 公司数据区；历史行为 null（无法归属公司） */
  organizationId: number | null;
  /** 原账号（授权主体）账号ID；历史行为 null */
  accountId: number | null;
  status: LocalUploadTaskStatus;
  attemptCount: number;
  lastAttemptAt: Date | null;
  remoteId: string | null;
  remoteReceipt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalUploadTaskInsertData = {
  installationId: string;
  entityType: LocalEntityType;
  entityLocalId: number;
  entityVersion: string;
  idempotencyKey: string;
  /**
   * 跨端稳定业务编号（`record_uuid`）：业务同步任务的记录键。
   * 备份类任务无业务稳定键 → null（读侧据此判"无稳定键"，不回填派生值）。
   */
  recordUuid?: string | null;
  /** 业务版本（`source_version`）：读侧按"任务登记版本"与来源事实核对 */
  sourceVersion?: number | null;
  /** 正文与原件清单 SHA-256（`manifest_checksum`）：回执完整性核对依据 */
  manifestChecksum?: string | null;
  /** 任务种类（`task_kind`）：BUSINESS_SYNC／BACKUP_UPLOAD */
  taskKind?: LocalUploadTaskKind | null;
  /**
   * 公司数据区（`organization_id`）：任务归属的公司。
   * 派发与授权核对按公司范围执行；历史行为 null（无法归属公司）。
   */
  organizationId?: number | null;
  /**
   * 原账号（`account_id`）：来源记录的授权主体账号。
   * 任务只能由该账号的有效授权派发；换账号／换公司不得接管原任务。
   */
  accountId?: number | null;
};

export type LocalUploadSuccessData = {
  remoteId: string | null;
  remoteReceipt: string | null;
};

export type LocalUploadFailureData = {
  errorCode: string;
  errorMessage: string;
};

export type LocalBackupRunSnapshot = {
  id: number;
  installationId: string;
  triggerType: LocalBackupTriggerType;
  status: LocalBackupRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  manifestPath: string | null;
  manifestChecksum: string | null;
  byteSize: number | null;
  attachmentCount: number | null;
  schemaVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalBackupRunStartData = {
  installationId: string;
  /** 公司数据区（V13 列）；计划触发的备份按公司建运行 */
  organizationId?: number | null;
  triggerType: LocalBackupTriggerType;
  startedAt: Date;
  manifestPath: string | null;
  /**
   * 手动三阶段（生成→上云→清理）的阶段状态。
   *
   * 取值与数据库 CHECK `chk_local_backup_run_manual_status` 一致：
   * PENDING／RUNNING／SUCCEEDED／FAILED／NOT_REQUIRED。
   */
  manualUploadStatus?: LocalBackupManualPhaseStatus | null;
  manualCleanupStatus?: LocalBackupManualPhaseStatus | null;
};

/**
 * 手动三阶段（生成→上云→清理）的阶段状态。
 *
 * 与数据库 CHECK `chk_local_backup_run_manual_status` 一致：
 * PENDING／RUNNING／SUCCEEDED／FAILED／NOT_REQUIRED。
 */
export type LocalBackupManualPhaseStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NOT_REQUIRED';

export type LocalBackupRunFinishData = {
  status: Exclude<LocalBackupRunStatus, 'RUNNING'>;
  finishedAt: Date;
  /**
   * 清单路径：仅当调用方显式提供时才覆盖。
   * undefined 表示本轮未产出清单（如失败/中断），不得把开始时的路径清空。
   */
  manifestPath?: string | null;
  manifestChecksum: string | null;
  byteSize: number | null;
  attachmentCount: number | null;
  schemaVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

/** 同机多公司配置值域：与数据库 CHECK `chk_local_company_setting_source` 一致 */
export const localCompanySettingSourceValues = {
  LOCAL_MANUAL: 'LOCAL_MANUAL',
  CLOUD_MAPPING: 'CLOUD_MAPPING',
} as const;
export type LocalCompanySettingSource =
  (typeof localCompanySettingSourceValues)[keyof typeof localCompanySettingSourceValues];

/**
 * 同机多公司配置安全快照。
 *
 * 只承载备份计划与云开关事实；不含任何云端凭据或密钥引用。
 */
export type LocalCompanySettingSnapshot = {
  id: string;
  installationId: string;
  organizationId: number;
  settingSource: LocalCompanySettingSource;
  isCurrent: boolean;
  initializedAt: Date;
  backupIntervalHours: number;
  backupEnabled: boolean;
  nextBackupAt: Date | null;
  lastAutoSuccessAt: Date | null;
  lastAutoFailureAt: Date | null;
  failureReason: string | null;
  autoUploadEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 本机某公司的授权事实汇总（只读，不含任何凭据材料）。
 *
 * 口径（任务 09 R065／R063）：
 * - 本表承载**云端业务同步**的本地授权事实（按账号＋公司）；
 * - 自动备份的云端凭据不复用本表，S3 另以独立引用记录，避免"同一凭据既做同步
 *   又做归档"导致撤权边界不清；
 * - `signedClaims` / `credential` 一类材料**永不**进入任何读模型或日志。
 */
export type LocalAuthorizationSummary = {
  organizationId: number;
  /** ACTIVE 状态记录数 */
  activeCount: number;
  /** REVOKED 状态记录数 */
  revokedCount: number;
  /** 当前范围内最近一次签名校验成功时间 */
  lastVerifiedAt: Date | null;
  /**
   * 该组织**实际持有**的凭据用途（取自云端签名声明；空＝用途不可核验）。
   * 对外不再硬编码单一用途（S4）。
   */
  credentialPurposes: string[];
};

/**
 * 本机后台任务状态汇总（按安装标识统计，不含公司正文）。
 *
 * 用途：本地设置页展示"业务与队列已落库"的真实事实，并为 S1.3 的重启恢复
 * 与 S3 的计划调度提供同一读数口径。
 */
export type LocalTaskStatusSummary = {
  pendingUploadCount: number;
  uploadingUploadCount: number;
  failedUploadCount: number;
  succeededUploadCount: number;
  runningBackupCount: number;
  lastBackupStartedAt: Date | null;
  lastBackupFinishedAt: Date | null;
};

/** 备份资产的云端状态（与数据库 CHECK `chk_backup_asset_cloud_status` 一致） */
export type LocalBackupCloudStatus = 'PENDING' | 'UPLOADING' | 'SUCCEEDED' | 'FAILED';

/** 备份资产的本地包状态（与数据库 CHECK `chk_backup_asset_local_status` 一致） */
export type LocalBackupLocalStatus = 'PENDING' | 'CLEANING' | 'CLEANED' | 'FAILED';

/**
 * 备份记录读模型（任务 09 S3 §12「备份记录」列表行）。
 *
 * 只承载"本机包／云副本／校验"三类事实，不含包正文、密钥材料与他人草稿。
 */
export type LocalBackupRecordSnapshot = {
  backupId: string;
  organizationId: number;
  runId: number | null;
  installationId: string | null;
  /** 触发方式：计划／手动；运行行缺失时为 null（历史未知） */
  triggerType: LocalBackupTriggerType | null;
  /** 运行状态；运行行缺失时为 null */
  runStatus: LocalBackupRunStatus | null;
  /** 运行开始时间；运行行缺失时回退到资产创建时间 */
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  /** 包总字节数 */
  byteSize: number | null;
  /** 本地包状态 */
  localStatus: LocalBackupLocalStatus;
  /** 本地包是否仍在本机保留 */
  localPackageRetained: boolean;
  /** 云端状态 */
  cloudStatus: LocalBackupCloudStatus;
  /** 是否已取得完整云端回执 */
  cloudReceiptPresent: boolean;
  /** 清单 SHA-256 */
  manifestChecksum: string | null;
  /** 最近校验成功时间 */
  verifiedAt: Date | null;
  /** 保留截止时间（过期清理窗口） */
  retentionUntil: Date | null;
  /** 最近失败原因 */
  failureReason: string | null;
  /** 本地清理失败原因 */
  localCleanupError: string | null;
  /** 上传尝试次数 */
  attemptCount: number;
  /** 最近上传尝试时间 */
  lastAttemptAt: Date | null;
  /** 本地包清理事实时间 */
  deletedAt: Date | null;
};

/**
 * 备份记录详情读模型：在列表事实之上补清单摘要。
 *
 * 只暴露"包内有几个文件、覆盖哪些表、各表多少行、原件引用多少条"这类元数据；
 * 不返回包正文、密钥材料、原件物理路径与他人草稿。
 */
export type LocalBackupRecordDetailSnapshot = {
  record: LocalBackupRecordSnapshot;
  /** 清单结构版本 */
  schemaVersion: number | null;
  /** 保护密钥标识（仅标识，不含密钥） */
  protectionKeyId: string | null;
  /** 包内文件数（payload.enc ＋ 已复制原件） */
  fileCount: number | null;
  /** 原件引用条目数 */
  originalCount: number | null;
  /** 一致性范围快照（表名＋行数＋最近更新时间） */
  scope: { table: string; rowCount: number; lastUpdatedAt: string | null }[];
  /** 清单是否可读（false 表示包已不在本机或清单损坏） */
  manifestReadable: boolean;
};

/**
 * 自动备份设置读模型（任务 09 S3 §12「自动备份设置」）。
 *
 * 约 72 小时计划周期与约 30 天保留窗口是需求固定口径，只读展示，不写库。
 */
export type LocalBackupSettingSnapshot = {
  organizationId: number;
  installationId: string;
  /** 本机是否启用自动备份 */
  backupEnabled: boolean;
  /** 计划间隔小时数（当前配置值，默认 72） */
  backupIntervalHours: number;
  /** 下次计划备份时间 */
  nextBackupAt: Date | null;
  lastAutoSuccessAt: Date | null;
  lastAutoFailureAt: Date | null;
  failureReason: string | null;
  /** 自动上云开关（只控制新的自动上云，不影响业务同步） */
  autoUploadEnabled: boolean;
  /** 需求固定：约 72 小时计划周期（只读） */
  planIntervalHours: number;
  /** 需求固定：约 30 天保留窗口（只读） */
  retentionDays: number;
  /** 最近一次备份运行状态 */
  lastRunStatus: LocalBackupRunStatus | null;
  lastRunStartedAt: Date | null;
  lastRunFinishedAt: Date | null;
  /** 最近一次备份资产的云端状态 */
  lastAssetCloudStatus: LocalBackupCloudStatus | null;
  /** 最近一次备份资产的本地包状态 */
  lastAssetLocalStatus: LocalBackupLocalStatus | null;
};

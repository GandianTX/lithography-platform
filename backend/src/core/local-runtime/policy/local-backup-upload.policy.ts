// src/core/local-runtime/policy/local-backup-upload.policy.ts
// 自动上云的重试与退避策略（任务 09 S3.2）。
//
// 事实口径（R074-01～03／R075～R080）：
// - 自动上云只针对**已经生成的备份资产**（backup_asset），重试绝不重新生成备份包；
// - 检测周期约 5 分钟，失败退避逐级拉长，最长约 1 小时；
// - 云开关只控制"是否继续新的自动上云"，关闭后不再产生新的上传尝试，
//   已产生的资产状态保留，不回退、不删除；
// - 授权失效等价于"本轮不尝试"，资产保持待上传事实并记录原因。

import { isTerminalCloudUploadFailure } from '@core/local-runtime/policy/local-backup-cloud-upload.policy';

/** 自动上云检测周期（分钟，约 5 分钟） */
export const BACKUP_UPLOAD_DETECT_INTERVAL_MINUTES = 5;
/** 失败退避起始值（分钟） */
export const BACKUP_UPLOAD_BASE_BACKOFF_MINUTES = 5;

/** 失败退避上限（分钟，约 1 小时） */
export const BACKUP_UPLOAD_MAX_BACKOFF_MINUTES = 60;

/** 云端状态取值（与数据库 CHECK `chk_backup_asset_cloud_status` 一致） */
export const backupUploadCloudStatusValues = {
  PENDING: 'PENDING',
  UPLOADING: 'UPLOADING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export type BackupUploadCloudStatus =
  (typeof backupUploadCloudStatusValues)[keyof typeof backupUploadCloudStatusValues];

/**
 * 允许发起上传尝试的云端状态。
 *
 * 只有 PENDING（从未尝试或待重试）与 FAILED（上次失败待重试）可再次尝试；
 * UPLOADING 说明已有一轮在途，SUCCEEDED 说明已取得完整回执。
 */
export function isBackupUploadAttemptAllowed(cloudStatus: string): boolean {
  return (
    cloudStatus === backupUploadCloudStatusValues.PENDING ||
    cloudStatus === backupUploadCloudStatusValues.FAILED
  );
}

/**
 * 失败退避时长（分钟）：5 → 10 → 20 → 40 → 60（封顶）。
 *
 * 第 n 次失败（n 从 1 起）后的等待时长为 min(base × 2^(n-1), max)。
 */
export function computeUploadBackoffMinutes(attemptCount: number): number {
  // 非有限值（NaN／Infinity）会让退避算出 NaN ⇒ nextAttemptAt 变成 Invalid Date
  // ⇒ 到期判定恒为 false（资产永远卡在"等待"）。此类输入按"第一次失败"处理。
  const failures = Number.isFinite(attemptCount) ? Math.max(1, Math.floor(attemptCount)) : 1;
  const exponent = Math.min(failures - 1, 16); // 防止位移溢出
  const minutes = BACKUP_UPLOAD_BASE_BACKOFF_MINUTES * 2 ** exponent;
  return Math.min(minutes, BACKUP_UPLOAD_MAX_BACKOFF_MINUTES);
}

/**
 * 下次可尝试时间。
 *
 * - 从未尝试过（attemptCount = 0）：立即可尝试；
 * - 已失败过：以最近一次尝试时间为基准叠加退避；没有最近尝试时间时以当前时间为基准。
 */
export function computeNextUploadAttemptAt(
  attemptCount: number,
  lastAttemptAt: Date | null,
  now: Date,
): Date {
  if (attemptCount <= 0) {
    return new Date(now.getTime());
  }
  const base = lastAttemptAt ?? now;
  return new Date(base.getTime() + computeUploadBackoffMinutes(attemptCount) * 60_000);
}

/** 到期判定：now 达到或超过 nextAttemptAt */
export function isUploadAttemptDue(nextAttemptAt: Date | null, now: Date): boolean {
  if (nextAttemptAt === null) {
    return true;
  }
  return nextAttemptAt.getTime() <= now.getTime();
}

/**
 * 资产是否处于"可重试但不重复生成"的稳定定位状态。
 *
 * 重试只读取既有 backup_asset 行：同一 backupId 在重试过程中不产生新的
 * backup_asset，也不产生新的 local_backup_run。此断言用于守住"自动重试原包不生新包"。
 */
export function isSameAssetRetry(backupId: string, retryBackupId: string): boolean {
  return backupId === retryBackupId && backupId.length > 0;
}

/** 上传尝试的判定结果（模块层据此决定是否推进资产行） */
export type BackupUploadAttemptDecision =
  | { action: 'RETRY'; reason: 'BACKOFF_ELAPSED' }
  | { action: 'WAIT'; reason: 'BACKOFF_PENDING'; nextAttemptAt: Date }
  | { action: 'SKIP'; reason: 'CLOUD_UPLOAD_DISABLED' }
  | { action: 'SKIP'; reason: 'AUTHORIZATION_INVALID' }
  | { action: 'SKIP'; reason: 'NOT_RETRYABLE' }
  | { action: 'SKIP'; reason: 'ALREADY_SUCCEEDED' }
  /**
   * **终态失败，不再重试**（任务 09 第 10 项 L2）。
   *
   * 本机包结构性失败（清单不可读／清单与字节不一致／超出大小上限）重试多少次
   * 都是同一个结果，继续按退避周期重试只会无限消耗且永不收敛。
   */
  | { action: 'SKIP'; reason: 'TERMINAL_PACKAGE_INVALID' };

export type BackupUploadDecisionInput = {
  cloudStatus: string;
  attemptCount: number;
  lastAttemptAt: Date | null;
  autoUploadEnabled: boolean;
  authorizationValid: boolean;
  /** 上一次失败的受控原因码（用于终态判定；null 表示尚无失败事实） */
  failureReason?: string | null;
  now: Date;
};

/**
 * 自动上云尝试裁决（纯函数，便于以可控时钟验证）。
 *
 * 顺序固定：开关关闭 → 授权失效 → 不可重试 → 已成功 → **终态失败** → 退避到期。
 */
export function decideBackupUploadAttempt(
  input: BackupUploadDecisionInput,
): BackupUploadAttemptDecision {
  if (!input.autoUploadEnabled) {
    return { action: 'SKIP', reason: 'CLOUD_UPLOAD_DISABLED' };
  }
  if (!input.authorizationValid) {
    return { action: 'SKIP', reason: 'AUTHORIZATION_INVALID' };
  }
  if (input.cloudStatus === backupUploadCloudStatusValues.SUCCEEDED) {
    return { action: 'SKIP', reason: 'ALREADY_SUCCEEDED' };
  }
  if (!isBackupUploadAttemptAllowed(input.cloudStatus)) {
    return { action: 'SKIP', reason: 'NOT_RETRYABLE' };
  }
  // 终态失败：本机包结构性失败，重试无用 ⇒ 直接跳过，不再进入退避重试
  if (isTerminalCloudUploadFailure(input.failureReason)) {
    return { action: 'SKIP', reason: 'TERMINAL_PACKAGE_INVALID' };
  }
  const nextAttemptAt = computeNextUploadAttemptAt(
    input.attemptCount,
    input.lastAttemptAt,
    input.now,
  );
  if (!isUploadAttemptDue(nextAttemptAt, input.now)) {
    return { action: 'WAIT', reason: 'BACKOFF_PENDING', nextAttemptAt };
  }
  return { action: 'RETRY', reason: 'BACKOFF_ELAPSED' };
}

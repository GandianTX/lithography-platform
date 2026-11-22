// src/core/local-runtime/policy/local-backup-cleanup.policy.ts
// 本地备份包清理裁决（任务 09 S3.3）。
//
// 事实口径（R074-01～03、R083-01；验收 A09-05 手动清理、A09-08 过期清理）：
// - 手动清理的前置是**本次手动备份取得的完整云回执**：回执不完整即零清理——不动任何本机包、
//   不改任何资产状态；
// - 取得完整回执后清理**本设备本公司固定范围内的全部本地备份包**：
//   **不额外要求每个旧包各自有云副本**（任务书 R074-03 明确「不是逐个旧包均须有云副本的新前提」）；
// - 清理前先固定「本机本公司」包清单，再逐项删除：清理过程中新产生的包不被误删；
// - 逐项记结果：已清理／仍保留（附原因）；清理失败的包保留，不误标为已清理；
// - 过期清理按约 30 天保留窗口（不强制留最近一份），**只清过期且本地生成成功的包**：
//   云副本不是清理门槛（任务书 R083-01「只清过期成功本地包」，云副本保留）；
// - 只允许删除备份根目录内的包目录：路径越界一律拒绝（业务原件与外公司哨兵不受影响）。

import * as nodePath from 'node:path';

/** 本地包保留窗口（天）：需求固定口径约 30 天 */
export const BACKUP_RETENTION_DAYS = 30;

/** 清理中断可辨认时限（分钟）：CLEANING 超过该时长视为进程中断残留 */
export const BACKUP_CLEANUP_INTERRUPT_MINUTES = 10;

/** 云回执不完整的判定原因 */
export type CloudReceiptIncompleteReason =
  'CLOUD_RECEIPT_MISSING' | 'CLOUD_RECEIPT_UNPARSEABLE' | 'CLOUD_RECEIPT_NOT_SUCCESS';

/** 云回执完整性裁决 */
export type CloudReceiptVerdict =
  { complete: true } | { complete: false; reason: CloudReceiptIncompleteReason };

/** 回执中出现这些状态即视为云端已确认接收 */
const CLOUD_RECEIPT_SUCCESS_STATUSES = ['SUCCEEDED', 'SUCCESS', 'OK', 'RECEIVED', 'ACCEPTED'];

/**
 * 完整云回执判定。
 *
 * 完整回执 = 非空 + 可解析为 JSON 对象 + 无失败语义 + 明确的成功语义
 * （`received === true` 或 `status` 命中成功状态）。
 *
 * 口径从严：宁可判为不完整（零清理），也不把半截回执当作可删本地包的授权。
 */
export function isCompleteCloudReceipt(receipt: string | null | undefined): CloudReceiptVerdict {
  const raw = (receipt ?? '').trim();
  if (raw.length === 0) {
    return { complete: false, reason: 'CLOUD_RECEIPT_MISSING' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { complete: false, reason: 'CLOUD_RECEIPT_UNPARSEABLE' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { complete: false, reason: 'CLOUD_RECEIPT_UNPARSEABLE' };
  }

  const record = parsed as Record<string, unknown>;
  const failure = record['error'] ?? record['failure'] ?? record['rejected'];
  if (failure !== undefined && failure !== null && failure !== false) {
    return { complete: false, reason: 'CLOUD_RECEIPT_NOT_SUCCESS' };
  }
  if (record['received'] === true) {
    return { complete: true };
  }
  const status = record['status'];
  if (typeof status === 'string' && CLOUD_RECEIPT_SUCCESS_STATUSES.includes(status.toUpperCase())) {
    return { complete: true };
  }
  return { complete: false, reason: 'CLOUD_RECEIPT_NOT_SUCCESS' };
}

/** 清理裁决所需的最小资产事实（只读） */
export type BackupCleanupCandidate = {
  backupId: string;
  /** PENDING 待处理 / CLEANING 清理中 / CLEANED 已清理 / FAILED 清理失败 */
  localStatus: string;
  /** 本地包引用；已清理后为空 */
  localReference: string | null;
  /** 保留截止时间；历史行为空 */
  retentionUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 跳过清理的原因（逐项可追踪） */
export type BackupCleanupSkipReason =
  'PACKAGE_ALREADY_CLEANED' | 'PACKAGE_REFERENCE_MISSING' | 'RETENTION_NOT_EXPIRED';

/** 资产是否仍有本地包需要处理 */
export function hasLocalPackage(candidate: BackupCleanupCandidate): boolean {
  return candidate.localStatus !== 'CLEANED' && candidate.localReference !== null;
}

/** 手动清理裁决：回执不完整即零清理 */
export type ManualCleanupDecision = {
  /** 是否具备清理授权 */
  available: boolean;
  /** 不可用原因（可清理时为 null） */
  reason: CloudReceiptIncompleteReason | null;
  /** 固定后的清理清单（**逐项**已核验云端副本） */
  targets: BackupCleanupCandidate[];
  /** 未进入清理清单的原因（逐项可追踪） */
  skipped: Array<{ backupId: string; reason: BackupCleanupSkipReason }>;
};

/**
 * 手动清理裁决。
 *
 * 两层判定，口径不同：
 * - **授权层**：`cloudReceipt` 是**本次手动备份**取得的完整云回执，回答"能不能进入清理流程"；
 *   不完整即零清理（清单为空，调用方不得触碰任何本机包）。
 * - **逐项层**：授权成立后，本设备本公司范围内**所有仍有本地包的资产**都进入清理清单。
 *
 * 为什么逐项不再复核"该资产自己有没有云副本"（任务书 R074-03）：
 * 需求明确「仅本次手动流程成功云回执后清理；**不是逐个旧包均须有云副本的新前提**」，
 * 且清理范围是「仅当前有权公司在本设备的**全部**本地备份包」。
 * 逐项再要求各自云副本会把"本次已取得完整回执"的授权降级为"每个旧包都要单独上云"，
 * 与需求相反；云副本的安全网由**授权层的完整回执**与「云端副本保留不删」共同承担。
 */
export function decideManualCleanupTargets(
  candidates: readonly BackupCleanupCandidate[],
  cloudReceipt: string | null,
): ManualCleanupDecision {
  const verdict = isCompleteCloudReceipt(cloudReceipt);
  if (!verdict.complete) {
    // 零清理：清单为空，调用方不得触碰任何本机包
    return { available: false, reason: verdict.reason, targets: [], skipped: [] };
  }

  const targets: BackupCleanupCandidate[] = [];
  const skipped: Array<{ backupId: string; reason: BackupCleanupSkipReason }> = [];
  for (const candidate of candidates) {
    if (!hasLocalPackage(candidate)) {
      // 已清理 / 无本地包：不在清理范围内，无需逐项报告
      continue;
    }
    targets.push(candidate);
  }

  return { available: true, reason: null, targets, skipped };
}

/** 过期清理裁决 */
export type RetentionCleanupDecision = {
  /** 到期且云端副本可证的清理目标 */
  targets: Array<{ candidate: BackupCleanupCandidate; retentionUntil: Date }>;
  /** 未进入清理的原因（逐项可追踪） */
  skipped: Array<{ backupId: string; reason: BackupCleanupSkipReason }>;
};

/**
 * 过期清理裁决（保留窗口约 30 天）。
 *
 * - 保留窗口未到：不动；
 * - 已清理／无本地包引用：不动（无可清理对象）；
 * - 其余到期包进入清理清单：不强制留最近一份。
 *
 * 「本地备份成功」的判据：**存在 backup_asset 行**（资产行只在封包成功后登记，
 * 生成失败的包根本没有资产行，天然不在清单里）＋ 本地包引用仍在 ＋ 未被清理。
 *
 * 为什么**不再要求云端副本可证**（任务书 R083-01）：
 * 需求口径是「管理员按 30 天清成功本地包」「**不额外要求保留最近一份本地包**」，
 * 并明确「云副本、业务、报告和原件保留」——即云副本是**被保留的对象**，不是清理门槛。
 * 把云副本可证当作前置，会让"未上云的本地包"永久滞留，偏离需求。
 */
export function decideRetentionCleanupTargets(
  candidates: readonly BackupCleanupCandidate[],
  now: Date,
  retentionDays: number = BACKUP_RETENTION_DAYS,
): RetentionCleanupDecision {
  const targets: Array<{ candidate: BackupCleanupCandidate; retentionUntil: Date }> = [];
  const skipped: Array<{ backupId: string; reason: BackupCleanupSkipReason }> = [];

  for (const candidate of candidates) {
    if (candidate.localStatus === 'CLEANED') {
      skipped.push({ backupId: candidate.backupId, reason: 'PACKAGE_ALREADY_CLEANED' });
      continue;
    }
    if (candidate.localReference === null) {
      skipped.push({ backupId: candidate.backupId, reason: 'PACKAGE_REFERENCE_MISSING' });
      continue;
    }

    const retentionUntil =
      candidate.retentionUntil ??
      new Date(candidate.createdAt.getTime() + retentionDays * 86_400_000);
    if (retentionUntil.getTime() > now.getTime()) {
      skipped.push({ backupId: candidate.backupId, reason: 'RETENTION_NOT_EXPIRED' });
      continue;
    }

    targets.push({ candidate, retentionUntil });
  }

  return { targets, skipped };
}

/**
 * 备份包路径是否落在备份根目录内。
 *
 * 只接受根目录的**严格子路径**：根目录本身、越界路径与相对路径都拒绝。
 * 这是"业务原件与外公司哨兵不被删除"的最后一道闸门。
 */
export function isBackupPackagePathInside(root: string, target: string): boolean {
  if (root.length === 0 || target.length === 0) {
    return false;
  }
  const resolvedRoot = nodePath.resolve(root);
  const resolvedTarget = nodePath.resolve(target);
  if (resolvedTarget === resolvedRoot) {
    return false;
  }
  const relative = nodePath.relative(resolvedRoot, resolvedTarget);
  if (relative.length === 0 || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
    return false;
  }
  return true;
}

/**
 * 清理中断是否可辨认。
 *
 * CLEANING 且超过中断时限未推进 → 视为进程中断残留，可被下一轮重试识别。
 */
export function isCleanupInterrupted(
  candidate: { localStatus: string; updatedAt: Date },
  now: Date,
  interruptMinutes: number = BACKUP_CLEANUP_INTERRUPT_MINUTES,
): boolean {
  if (candidate.localStatus !== 'CLEANING') {
    return false;
  }
  return candidate.updatedAt.getTime() <= now.getTime() - interruptMinutes * 60_000;
}

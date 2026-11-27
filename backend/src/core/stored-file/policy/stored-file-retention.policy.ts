// src/core/stored-file/policy/stored-file-retention.policy.ts

/**
 * 暂存原件的**保留窗口与过期清理**裁决（任务 09 P3-3 跨资源失败补偿）。
 *
 * 为什么需要这一层：
 * - 任务 11 的 `stored_file` 没有删除接口，暂存行一旦登记就长期存在；
 *   "暂存成功但绑定／业务写失败"（导入链）会留下**永远不会被绑定**的孤儿行；
 * - 清理必须有**单一口径**且可单测：什么算"可清理"、什么必须**保留**，
 *   不能散落在调度器与服务的条件表达式里（避免两处判定漂移）。
 *
 * 口径（与 `docs/database/v13-deployment/data-contracts.md` §4.1 的清理口径一致）：
 * - 只清理**超时**且**未被任何业务引用**的暂存／失效行；
 * - **已被业务引用的一律保留**（含"退役但仍持外键"的附件行——历史读取权要保留）；
 * - **已绑定（BOUND）的原件一律保留**（那是活着的业务原件，不是孤儿）；
 * - DB 行**不物理删**（保留可追踪事实），只把"活着但永远不会被绑定"的行标记为失效；
 *   字节回收由执行层处理（先过引用守卫）。
 *
 * 本函数是纯函数：确定性、无 I/O、无 DI、无 ORM、无日志、不修改入参。
 */

/** 暂存原件保留窗口（天）：到期且未被引用的暂存行才进入清理候选 */
export const STORED_FILE_TEMPORARY_RETENTION_DAYS = 30;

/** 清理候选（本机当前事实，由执行层组装） */
export type StoredFileRetentionCandidate = {
  readonly fileId: string;
  /** 可信文件归属公司 */
  readonly ownerOrganizationId: number;
  /** `STAGING` / `VALID` / `FAILED` */
  readonly status: string;
  /** `TEMPORARY` / `BOUND` */
  readonly bindingStatus: string;
  /** 绑定的业务真实 id；未绑定为空 */
  readonly businessId: string | null;
  /** 登记时间（保留窗口以登记时间为准） */
  readonly createdAt: Date;
  /** 是否仍被业务入边引用（附件行／报修 intakes／处理过程条目／工单附件） */
  readonly referenced: boolean;
};

/** 可清理目标及其原因 */
export type StoredFileRetentionTarget = {
  readonly candidate: StoredFileRetentionCandidate;
  /** `EXPIRED_TEMPORARY`＝超时未被引用的暂存行；`DEAD_STATUS`＝已失效且超时的行 */
  readonly reason: 'EXPIRED_TEMPORARY' | 'DEAD_STATUS';
};

/** 保留项及其原因（逐项可追踪，不静默丢弃） */
export type StoredFileRetentionSkip = {
  readonly candidate: StoredFileRetentionCandidate;
  /** `BUSINESS_REFERENCED`＝仍被引用；`BOUND`＝已绑定活件；`NOT_EXPIRED`＝未到保留窗口 */
  readonly reason: 'BUSINESS_REFERENCED' | 'BOUND' | 'NOT_EXPIRED';
};

export type StoredFileRetentionDecision = {
  readonly targets: readonly StoredFileRetentionTarget[];
  readonly skipped: readonly StoredFileRetentionSkip[];
};

/** 保留窗口是否已到期（登记时间早于"现在 − 窗口"即到期） */
export function isStoredFileRetentionExpired(
  createdAt: Date,
  now: Date,
  retentionDays: number,
): boolean {
  const deadline = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return createdAt.getTime() < deadline;
}

/**
 * 裁决可清理的暂存原件与必须保留的原件。
 *
 * 顺序（先保留后清理，**保留优先**）：
 * 1. 仍被业务引用 → 保留（`BUSINESS_REFERENCED`）；
 * 2. 已绑定（BOUND）→ 保留（`BOUND`）；
 * 3. 未到保留窗口 → 保留（`NOT_EXPIRED`）；
 * 4. 到期且状态已失效（`STAGING`／`FAILED`）→ 清理（`DEAD_STATUS`）；
 * 5. 到期且仍是"活着但未绑定"的暂存行（`VALID` + `TEMPORARY` + 无业务 id）
 *    → 清理（`EXPIRED_TEMPORARY`，执行层先释放再回收字节）。
 */
export function decideStoredFileRetentionTargets(
  candidates: readonly StoredFileRetentionCandidate[],
  now: Date,
  retentionDays: number = STORED_FILE_TEMPORARY_RETENTION_DAYS,
): StoredFileRetentionDecision {
  const targets: StoredFileRetentionTarget[] = [];
  const skipped: StoredFileRetentionSkip[] = [];

  for (const candidate of candidates) {
    if (candidate.referenced) {
      skipped.push({ candidate, reason: 'BUSINESS_REFERENCED' });
      continue;
    }
    if (candidate.bindingStatus === 'BOUND' || candidate.businessId !== null) {
      skipped.push({ candidate, reason: 'BOUND' });
      continue;
    }
    if (!isStoredFileRetentionExpired(candidate.createdAt, now, retentionDays)) {
      skipped.push({ candidate, reason: 'NOT_EXPIRED' });
      continue;
    }
    if (candidate.status === 'STAGING' || candidate.status === 'FAILED') {
      targets.push({ candidate, reason: 'DEAD_STATUS' });
      continue;
    }
    targets.push({ candidate, reason: 'EXPIRED_TEMPORARY' });
  }

  return { targets, skipped };
}

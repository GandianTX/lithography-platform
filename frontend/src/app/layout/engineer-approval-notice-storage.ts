// src/app/layout/engineer-approval-notice-storage.ts

/**
 * 工程师申请批准提示的一次性标记（localStorage，按 accountId 隔离）。
 *
 * 只记录「该账号在本浏览器上曾处于工程师受限状态」，用于资格生效后跨标签刷新与
 * 退出重登仍能提示一次。标记**不是授权凭证**：是否展示还要求服务端每请求复核后的
 * `restriction === 'NONE'`。
 *
 * 存储不可用（隐私模式 / 配额 / 损坏 JSON）时一律静默：读取视为无标记，写入忽略。
 */

const STORAGE_KEY = 'lithography.engineer-approval-pending.v1';

type PendingApprovalMap = Record<string, true>;

function isStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readMap(): PendingApprovalMap {
  if (!isStorageAvailable()) {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);
    if (rawValue === null) {
      return {};
    }

    const parsed: unknown = JSON.parse(rawValue);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    const next: PendingApprovalMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      const accountId = Number(key);
      // 只接受正整数账号键与 true，脏数据一律忽略
      if (value === true && Number.isInteger(accountId) && accountId > 0) {
        next[String(accountId)] = true;
      }
    }

    return next;
  } catch {
    return {};
  }
}

function writeMap(map: PendingApprovalMap): void {
  if (!isStorageAvailable()) {
    return;
  }

  try {
    if (Object.keys(map).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 存储不可写只影响跨刷新的一次性提示，不影响任何授权判断
  }
}

export function markEngineerApprovalPending(accountId: number): void {
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return;
  }

  const map = readMap();
  if (map[String(accountId)] === true) {
    return;
  }

  writeMap({ ...map, [String(accountId)]: true });
}

export function hasPendingEngineerApproval(accountId: number): boolean {
  return readMap()[String(accountId)] === true;
}

export function clearPendingEngineerApproval(accountId: number): void {
  const map = readMap();
  if (map[String(accountId)] !== true) {
    return;
  }

  const next = { ...map };
  delete next[String(accountId)];
  writeMap(next);
}

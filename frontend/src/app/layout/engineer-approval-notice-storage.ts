// src/app/layout/engineer-approval-notice-storage.ts

/**
 * 工程师批准结果「已确认」的一次性展示偏好（localStorage，按账号 + 申请隔离）。
 *
 * 只记录「本浏览器上该账号的这份批准结果已经被用户确认并进入工作台」，用于避免
 * 每次刷新 / 页面跳转都重复展示结果页。它**不是授权凭证、也不是批准事实来源**：
 * 是否展示结果由服务端 `mySessionIdentity` + `myEngineerRegistration` 决定，
 * 标记缺失只会让结果多展示一次，标记存在也从不会放行任何访问。
 *
 * 存储不可用（隐私模式 / 配额 / 损坏 JSON / 属性访问被浏览器策略拒绝）时一律静默：
 * 读取视为未确认，写入忽略。
 */

const STORAGE_KEY = 'lithography.engineer-approval-acknowledged.v1';

const ACKNOWLEDGEMENT_KEY_PATTERN = /^[1-9]\d*:[1-9]\d*$/;

type AcknowledgedApprovalMap = Record<string, true>;

function isStorageAvailable(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  // 浏览器策略可能在**读取 `window.localStorage` 属性本身**时抛 SecurityError
  // （禁用站点数据 / 沙箱 iframe），可用性探测必须与后续读写同在容错边界内。
  try {
    return typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function toAcknowledgementKey(accountId: number, applicationId: number): string | null {
  if (
    !Number.isInteger(accountId) ||
    accountId <= 0 ||
    !Number.isInteger(applicationId) ||
    applicationId <= 0
  ) {
    return null;
  }

  return `${accountId}:${applicationId}`;
}

function readMap(): AcknowledgedApprovalMap {
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

    const next: AcknowledgedApprovalMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受「账号:申请」正整数键与 true，脏数据一律忽略
      if (value === true && ACKNOWLEDGEMENT_KEY_PATTERN.test(key)) {
        next[key] = true;
      }
    }

    return next;
  } catch {
    return {};
  }
}

function writeMap(map: AcknowledgedApprovalMap): void {
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
    // 存储不可写只影响一次性展示偏好，不影响任何授权判断
  }
}

export function hasAcknowledgedEngineerApproval(accountId: number, applicationId: number): boolean {
  const key = toAcknowledgementKey(accountId, applicationId);

  return key !== null && readMap()[key] === true;
}

export function acknowledgeEngineerApproval(accountId: number, applicationId: number): void {
  const key = toAcknowledgementKey(accountId, applicationId);

  if (key === null) {
    return;
  }

  const map = readMap();
  if (map[key] === true) {
    return;
  }

  writeMap({ ...map, [key]: true });
}

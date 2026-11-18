// src/features/admin-company-management/application/admin-company-submission-key.ts

/**
 * 「新增公司并开通二级管理员」的提交标识（幂等键）生命周期。
 *
 * 语义（与后端 `ADMIN_CREATE_ORGANIZATION` 提交标识对齐）：
 * - 标识按**实际发起账号**归属存储，跨账号互不可见、不可清除；
 * - 首次发送前生成并持久化；双击、超时、刷新恢复、关闭弹窗、响应丢失时继续复用同一标识，
 *   **不按等待时长换键**（等待本身不代表用户另起一次业务）；
 * - 首次发送前的内容作为恢复草稿一并保存：同标识重试改内容被服务端拒绝后，
 *   仍可回到首次内容，用原标识恢复同一次开通；
 * - 只有用户明确「另起新提交」才生成新标识并丢弃草稿；
 * - 清除必须同时匹配账号与提交标识，迟到回包不能清掉新一次提交的标识。
 *
 * 旧的全局存储记录（`lithography.admin-company.create-submission`，无账号信息）
 * 只作为「来源未知」提示读取，不静默黏给任何账号。
 *
 * 只用 `sessionStorage`（页面会话级）；不可用时按存储对象退化为模块内内存，
 * 同一次页面生命周期内语义等价，且不向调用方抛错。
 */

import type { AdminCompanyCreateDraft } from './admin-company-management.types';

const STORAGE_PREFIX = 'lithography.admin-company.create-submission.v2:';
const LEGACY_STORAGE_KEY = 'lithography.admin-company.create-submission';

export type PendingSubmissionRecord = {
  accountId: number;
  key: string;
  createdAt: number;
  /** 首次发送前的内容；冲突恢复与刷新回填只用它，不随后续编辑覆盖 */
  draft: AdminCompanyCreateDraft | null;
};

/** `sessionStorage` 不可用时的退化载体：按存储对象隔离，避免跨页面实例串号。 */
const memoryByStorage = new WeakMap<Storage, Map<number, PendingSubmissionRecord>>();
const legacyMemoryByStorage = new WeakMap<Storage, string>();

function storageKeyFor(accountId: number): string {
  return `${STORAGE_PREFIX}${accountId}`;
}

function memoryMap(storage: Storage): Map<number, PendingSubmissionRecord> {
  let map = memoryByStorage.get(storage);

  if (map === undefined) {
    map = new Map<number, PendingSubmissionRecord>();
    memoryByStorage.set(storage, map);
  }

  return map;
}

function isDraft(value: unknown): value is AdminCompanyCreateDraft {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const draft = value as Partial<AdminCompanyCreateDraft>;

  return (
    typeof draft.name === 'string' &&
    typeof draft.shortName === 'string' &&
    typeof draft.contactName === 'string' &&
    typeof draft.contactPhone === 'string' &&
    typeof draft.contactEmail === 'string' &&
    typeof draft.address === 'string' &&
    typeof draft.remark === 'string' &&
    (draft.status === 'ACTIVE' || draft.status === 'DISABLED') &&
    typeof draft.isServiceProvider === 'boolean'
  );
}

function parseRecord(raw: string | null, accountId: number): PendingSubmissionRecord | null {
  if (raw === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const {
      accountId: storedAccountId,
      key,
      createdAt,
      draft,
    } = parsed as Partial<PendingSubmissionRecord & { draft: unknown }>;

    if (
      storedAccountId !== accountId ||
      typeof key !== 'string' ||
      key === '' ||
      typeof createdAt !== 'number'
    ) {
      return null;
    }

    return {
      accountId,
      key,
      createdAt,
      draft: draft === null || draft === undefined ? null : isDraft(draft) ? draft : null,
    };
  } catch {
    return null;
  }
}

function readRecord(storage: Storage, accountId: number): PendingSubmissionRecord | null {
  const storageKey = storageKeyFor(accountId);
  let raw: string | null;

  try {
    raw = storage.getItem(storageKey);
  } catch {
    return memoryMap(storage).get(accountId) ?? null;
  }

  const record = parseRecord(raw, accountId);

  if (raw !== null && record === null) {
    // 记录损坏：按缺失处理并清理，避免同一条坏数据长期黏住该账号。
    try {
      storage.removeItem(storageKey);
    } catch {
      // 存储不可用：内存侧本就没有该账号记录
    }
  }

  return record;
}

function writeRecord(storage: Storage, record: PendingSubmissionRecord): void {
  memoryMap(storage).set(record.accountId, record);

  try {
    storage.setItem(storageKeyFor(record.accountId), JSON.stringify(record));
  } catch {
    // 存储不可用：内存侧已写入，同一次页面生命周期内语义等价
  }
}

/** 生成 UUID v4 形状字符串：优先原生实现，其次安全随机源，最后时间戳兜底。 */
function createSubmissionKey(): string {
  const cryptoApi = globalThis.crypto;

  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);

  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 只读当前账号的提交记录；缺失或损坏返回 null，不生成新记录。 */
export function readSubmissionRecord(
  accountId: number,
  storage: Storage,
): PendingSubmissionRecord | null {
  return readRecord(storage, accountId);
}

/**
 * 读取当前账号未定案的提交记录；缺失或损坏时生成新记录。
 * 不按时间换键：等待、刷新或超时都会继续复用同一次提交。
 */
export function loadOrCreateSubmissionRecord(
  accountId: number,
  now: number,
  storage: Storage,
): PendingSubmissionRecord {
  const existing = readRecord(storage, accountId);

  if (existing !== null) {
    return existing;
  }

  const record: PendingSubmissionRecord = {
    accountId,
    key: createSubmissionKey(),
    createdAt: now,
    draft: null,
  };
  writeRecord(storage, record);

  return record;
}

/**
 * 记住**首次**发送前的内容，供冲突恢复与刷新回填。
 *
 * 仅当存储记录的提交标识仍是本次标识、且尚未保存过草稿时写入：
 * 重试时修改了内容不会覆盖原始内容，用户才能用原标识恢复同一次开通。
 */
export function rememberSubmissionDraft(
  accountId: number,
  key: string,
  draft: AdminCompanyCreateDraft,
  storage: Storage,
): void {
  const existing = readRecord(storage, accountId);

  if (existing === null || existing.key !== key || existing.draft !== null) {
    return;
  }

  writeRecord(storage, { ...existing, draft });
}

/**
 * 仅在存储记录仍是本次提交标识时清除，返回是否实际清除。
 *
 * 迟到回包、换号或用户已明确另起时，key 已变化，此处必须是无操作。
 */
export function clearSubmissionIfMatches(
  accountId: number,
  key: string,
  storage: Storage,
): boolean {
  const existing = readRecord(storage, accountId);

  if (existing === null || existing.key !== key) {
    return false;
  }

  memoryMap(storage).delete(accountId);

  try {
    storage.removeItem(storageKeyFor(accountId));
  } catch {
    // 存储不可用：内存侧已清，语义等价
  }

  return true;
}

/** 用户明确「另起新提交」：生成新标识并丢弃旧草稿。 */
export function startNewSubmission(
  accountId: number,
  now: number,
  storage: Storage,
): PendingSubmissionRecord {
  const record: PendingSubmissionRecord = {
    accountId,
    key: createSubmissionKey(),
    createdAt: now,
    draft: null,
  };
  writeRecord(storage, record);

  return record;
}

/**
 * 读取旧版全局记录中的提交标识（无账号归属）。
 *
 * 只用于向用户提示「存在来源账号未知的上次提交」，不自动归属当前账号。
 */
export function readLegacySubmissionKey(storage: Storage): string | null {
  let raw: string | null;

  try {
    raw = storage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return legacyMemoryByStorage.get(storage) ?? null;
  }

  if (raw === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const { key } = parsed as { key?: unknown };

    return typeof key === 'string' && key !== '' ? key : null;
  } catch {
    return null;
  }
}

export function clearLegacySubmissionKey(storage: Storage): void {
  legacyMemoryByStorage.delete(storage);

  try {
    storage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 存储不可用：无残留可清
  }
}

/** 用户明确「沿用上次标识」：把来源未知的旧标识落到当前账号下。 */
export function adoptLegacySubmissionKey(
  accountId: number,
  key: string,
  now: number,
  storage: Storage,
): PendingSubmissionRecord {
  const record: PendingSubmissionRecord = {
    accountId,
    key,
    createdAt: now,
    draft: null,
  };
  writeRecord(storage, record);
  clearLegacySubmissionKey(storage);

  return record;
}

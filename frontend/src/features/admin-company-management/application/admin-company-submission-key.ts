// src/features/admin-company-management/application/admin-company-submission-key.ts

/**
 * 「新增公司并开通二级管理员」的提交标识（幂等键）生命周期。
 *
 * 语义（与后端 `ADMIN_CREATE_ORGANIZATION` 提交标识对齐）：
 * - 首次发送前生成并持久化；双击、超时、刷新恢复、响应丢失时**继续复用同一标识**；
 * - 成功或服务端已明确「零提交」的失败由调用方清除，下次新增生成新标识；
 * - 网络不确定 / `save-failed` 时**保留**标识，重试仍落在同一次提交上；
 * - 不按内容指纹轮换标识：内容变更由服务端返回 `SUBMISSION_CONFLICT` 显式暴露。
 *
 * 只用 `sessionStorage`（页面会话级）；不可用时退化为模块内存变量，
 * 同一次页面生命周期内仍可复用，且不向调用方抛错。
 */

const STORAGE_KEY = 'lithography.admin-company.create-submission';

/** 标识有效期：30 分钟。过期视为放弃上一次提交，生成新标识。 */
const TTL_MS = 30 * 60 * 1000;

type PersistedSubmissionKey = {
  key: string;
  createdAt: number;
};

/** `sessionStorage` 不可用时的退化载体（同一次页面生命周期内有效）。 */
let memoryRecord: PersistedSubmissionKey | null = null;

function parseRecord(raw: string | null): PersistedSubmissionKey | null {
  if (raw === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const { key, createdAt } = parsed as Partial<PersistedSubmissionKey>;
    if (typeof key !== 'string' || key === '' || typeof createdAt !== 'number') {
      return null;
    }

    return { key, createdAt };
  } catch {
    return null;
  }
}

function readRecord(storage: Storage): PersistedSubmissionKey | null {
  try {
    return parseRecord(storage.getItem(STORAGE_KEY));
  } catch {
    return memoryRecord;
  }
}

function writeRecord(storage: Storage, record: PersistedSubmissionKey): void {
  memoryRecord = record;

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // 存储不可用：仅模块内存有效，不阻断提交
  }
}

function isFresh(record: PersistedSubmissionKey, now: number): boolean {
  return now - record.createdAt < TTL_MS;
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

/**
 * 读取未过期的既有标识；缺失、损坏或过期时生成并持久化新标识。
 */
export function loadOrCreateSubmissionKey(now: number, storage: Storage): string {
  const existing = readRecord(storage);

  if (existing !== null && isFresh(existing, now)) {
    return existing.key;
  }

  const key = createSubmissionKey();
  writeRecord(storage, { key, createdAt: now });

  return key;
}

/** 清除当前标识（成功或服务端已明确零提交之后调用）。 */
export function clearSubmissionKey(storage: Storage): void {
  memoryRecord = null;

  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // 存储不可用：内存已清，语义等价
  }
}

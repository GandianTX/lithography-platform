// src/features/admin-company-management/application/admin-company-submission-key.spec.ts

import { describe, expect, it } from 'vitest';

import type { AdminCompanyCreateDraft } from './admin-company-management.types';
import {
  adoptLegacySubmissionKey,
  clearLegacySubmissionKey,
  clearSubmissionIfMatches,
  loadOrCreateSubmissionRecord,
  readLegacySubmissionKey,
  rememberSubmissionDraft,
  startNewSubmission,
} from './admin-company-submission-key';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORAGE_PREFIX = 'lithography.admin-company.create-submission.v2:';
const LEGACY_STORAGE_KEY = 'lithography.admin-company.create-submission';
const ACCOUNT_A = 101;
const ACCOUNT_B = 202;
const NOW = Date.UTC(2026, 10, 17, 10, 0, 0);

const draft = (overrides: Partial<AdminCompanyCreateDraft> = {}): AdminCompanyCreateDraft => ({
  name: '光刻设备（上海）有限公司',
  shortName: '光刻上海',
  contactName: '张三',
  contactPhone: '021-12345678',
  contactEmail: 'contact@example.com',
  address: '上海市浦东新区',
  remark: '初始提交',
  status: 'ACTIVE',
  isServiceProvider: false,
  ...overrides,
});

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

/** 所有操作都抛错的存储：模拟 sessionStorage 被禁用 / 隐私模式限额。 */
function createBrokenStorage(): Storage {
  const fail = () => {
    throw new Error('storage unavailable');
  };

  return {
    get length() {
      fail();
      return 0;
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  } as unknown as Storage;
}

function readRaw(storage: Storage, accountId: number): Record<string, unknown> | null {
  return JSON.parse(storage.getItem(`${STORAGE_PREFIX}${accountId}`) ?? 'null') as Record<
    string,
    unknown
  > | null;
}

describe('admin-company-submission-key', () => {
  it('首次调用生成 UUID v4 标识并按账号持久化，草稿为空', () => {
    const storage = createMemoryStorage();

    const record = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);

    expect(record.key).toMatch(UUID_V4_PATTERN);
    expect(record.accountId).toBe(ACCOUNT_A);
    expect(record.draft).toBeNull();
    expect(readRaw(storage, ACCOUNT_A)).toEqual({
      accountId: ACCOUNT_A,
      key: record.key,
      createdAt: NOW,
      draft: null,
    });
    expect(storage.getItem(`${STORAGE_PREFIX}${ACCOUNT_B}`)).toBeNull();
  });

  it('等待超过 30 分钟仍复用同一标识（不按时间换键）', () => {
    const storage = createMemoryStorage();
    const first = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);
    const afterThirtyOneMinutes = loadOrCreateSubmissionRecord(
      ACCOUNT_A,
      NOW + 31 * 60 * 1000,
      storage,
    );
    const afterTwoHours = loadOrCreateSubmissionRecord(
      ACCOUNT_A,
      NOW + 2 * 60 * 60 * 1000,
      storage,
    );

    expect(afterThirtyOneMinutes.key).toBe(first.key);
    expect(afterTwoHours.key).toBe(first.key);
    expect(afterTwoHours.createdAt).toBe(NOW);
  });

  it('按账号隔离：一个账号的标识与草稿不会被另一个账号读取或清除', () => {
    const storage = createMemoryStorage();
    const recordA = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);
    rememberSubmissionDraft(ACCOUNT_A, recordA.key, draft(), storage);

    const recordB = loadOrCreateSubmissionRecord(ACCOUNT_B, NOW, storage);

    expect(recordB.key).not.toBe(recordA.key);
    expect(recordB.draft).toBeNull();
    expect(clearSubmissionIfMatches(ACCOUNT_B, recordA.key, storage)).toBe(false);
    expect(loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage)).toEqual({
      ...recordA,
      draft: draft(),
    });
  });

  it('草稿只保留首次发送前的内容，重试改内容不覆盖', () => {
    const storage = createMemoryStorage();
    const record = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);

    rememberSubmissionDraft(ACCOUNT_A, record.key, draft(), storage);
    rememberSubmissionDraft(ACCOUNT_A, record.key, draft({ name: '改过的公司' }), storage);

    expect(loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage).draft).toEqual(draft());
  });

  it('草稿写入要求标识一致：换键后的迟到草稿不落到新记录', () => {
    const storage = createMemoryStorage();
    const first = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);
    const second = startNewSubmission(ACCOUNT_A, NOW, storage);

    rememberSubmissionDraft(ACCOUNT_A, first.key, draft(), storage);

    const current = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);

    expect(second.key).not.toBe(first.key);
    expect(current.key).toBe(second.key);
    expect(current.draft).toBeNull();
  });

  it('清除仅在标识一致时生效：不匹配的迟到回包无操作', () => {
    const storage = createMemoryStorage();
    const record = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);

    expect(clearSubmissionIfMatches(ACCOUNT_A, 'another-key', storage)).toBe(false);
    expect(loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage).key).toBe(record.key);

    expect(clearSubmissionIfMatches(ACCOUNT_A, record.key, storage)).toBe(true);
    expect(storage.getItem(`${STORAGE_PREFIX}${ACCOUNT_A}`)).toBeNull();
  });

  it('用户明确另起：生成新标识并丢弃旧草稿，旧标识的迟到清除无效', () => {
    const storage = createMemoryStorage();
    const first = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);
    rememberSubmissionDraft(ACCOUNT_A, first.key, draft(), storage);

    const second = startNewSubmission(ACCOUNT_A, NOW + 1000, storage);

    expect(second.key).not.toBe(first.key);
    expect(second.draft).toBeNull();
    expect(clearSubmissionIfMatches(ACCOUNT_A, first.key, storage)).toBe(false);
    expect(loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage).key).toBe(second.key);
  });

  it('损坏或账号不符的记录失败关闭并重建，不抛错', () => {
    const storage = createMemoryStorage();
    storage.setItem(`${STORAGE_PREFIX}${ACCOUNT_A}`, '{not-json');
    const rebuilt = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);
    expect(rebuilt.key).toMatch(UUID_V4_PATTERN);

    storage.setItem(
      `${STORAGE_PREFIX}${ACCOUNT_A}`,
      JSON.stringify({ accountId: ACCOUNT_B, key: 'foreign', createdAt: NOW, draft: null }),
    );
    const isolated = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);
    expect(isolated.key).toMatch(UUID_V4_PATTERN);
    expect(isolated.key).not.toBe('foreign');
  });

  it('草稿字段损坏时只丢草稿，保留同一次提交标识', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      `${STORAGE_PREFIX}${ACCOUNT_A}`,
      JSON.stringify({ accountId: ACCOUNT_A, key: 'kept-key', createdAt: NOW, draft: { name: 1 } }),
    );

    const record = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage);

    expect(record.key).toBe('kept-key');
    expect(record.draft).toBeNull();
  });

  it('旧全局记录只读识别为来源未知，显式沿用时才归属当前账号', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ key: 'legacy-key', createdAt: NOW - 24 * 60 * 60 * 1000 }),
    );

    expect(readLegacySubmissionKey(storage)).toBe('legacy-key');
    // 未显式沿用前，当前账号仍是新记录，不会静默黏上旧标识。
    expect(loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage).key).not.toBe('legacy-key');

    const adopted = adoptLegacySubmissionKey(ACCOUNT_A, 'legacy-key', NOW, storage);

    expect(adopted.key).toBe('legacy-key');
    expect(adopted.draft).toBeNull();
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, storage).key).toBe('legacy-key');
    expect(clearLegacySubmissionKey(storage)).toBeUndefined();
  });

  it('旧全局记录内容损坏时视为不存在', () => {
    const storage = createMemoryStorage();
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ key: '' }));

    expect(readLegacySubmissionKey(storage)).toBeNull();
  });

  it('sessionStorage 不可用时按存储对象退化为内存，同一页面生命周期内稳定', () => {
    const broken = createBrokenStorage();
    const otherBroken = createBrokenStorage();

    const first = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, broken);
    const second = loadOrCreateSubmissionRecord(ACCOUNT_A, NOW + 60 * 60 * 1000, broken);

    expect(first.key).toMatch(UUID_V4_PATTERN);
    expect(second.key).toBe(first.key);
    expect(clearSubmissionIfMatches(ACCOUNT_A, first.key, broken)).toBe(true);
    expect(loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, broken).key).not.toBe(first.key);
    // 不同存储实例（不同页面生命周期）互不共享内存记录。
    expect(loadOrCreateSubmissionRecord(ACCOUNT_A, NOW, otherBroken).key).not.toBe(first.key);
  });
});

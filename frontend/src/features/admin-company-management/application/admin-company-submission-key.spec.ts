// src/features/admin-company-management/application/admin-company-submission-key.spec.ts

import { beforeEach, describe, expect, it } from 'vitest';

import { clearSubmissionKey, loadOrCreateSubmissionKey } from './admin-company-submission-key';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORAGE_KEY = 'lithography.admin-company.create-submission';
const NOW = Date.UTC(2026, 10, 17, 10, 0, 0);

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

let storage: Storage;

beforeEach(() => {
  storage = createMemoryStorage();
  clearSubmissionKey(storage);
});

describe('loadOrCreateSubmissionKey', () => {
  it('首次调用生成 UUID v4 形状标识并持久化', () => {
    const key = loadOrCreateSubmissionKey(NOW, storage);

    expect(key).toMatch(UUID_V4_PATTERN);
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ key, createdAt: NOW });
  });

  it('有效期内重复调用复用同一标识（双击 / 超时重试 / 刷新恢复）', () => {
    const first = loadOrCreateSubmissionKey(NOW, storage);
    const second = loadOrCreateSubmissionKey(NOW + 5 * 60 * 1000, storage);

    expect(second).toBe(first);
  });

  it('超过有效期后重建新标识', () => {
    const first = loadOrCreateSubmissionKey(NOW, storage);
    const second = loadOrCreateSubmissionKey(NOW + 30 * 60 * 1000 + 1, storage);

    expect(second).toMatch(UUID_V4_PATTERN);
    expect(second).not.toBe(first);
  });

  it('清除后再次调用生成新标识', () => {
    const first = loadOrCreateSubmissionKey(NOW, storage);
    clearSubmissionKey(storage);
    const second = loadOrCreateSubmissionKey(NOW, storage);

    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('存储内容损坏时失败关闭并重建，不抛错', () => {
    storage.setItem(STORAGE_KEY, '{not-json');

    const key = loadOrCreateSubmissionKey(NOW, storage);

    expect(key).toMatch(UUID_V4_PATTERN);
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ key, createdAt: NOW });
  });

  it('sessionStorage 不可用时退化为内存复用，同一页面生命周期内稳定', () => {
    const broken = createBrokenStorage();

    const first = loadOrCreateSubmissionKey(NOW, broken);
    const second = loadOrCreateSubmissionKey(NOW + 60 * 1000, broken);

    expect(first).toMatch(UUID_V4_PATTERN);
    expect(second).toBe(first);
  });
});

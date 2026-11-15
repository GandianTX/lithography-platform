// src/app/layout/engineer-approval-notice-storage.spec.ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPendingEngineerApproval,
  hasPendingEngineerApproval,
  markEngineerApprovalPending,
} from './engineer-approval-notice-storage';

const STORAGE_KEY = 'lithography.engineer-approval-pending.v1';

describe('engineer-approval-notice-storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('按账号隔离写入与读取', () => {
    markEngineerApprovalPending(101);
    markEngineerApprovalPending(202);

    expect(hasPendingEngineerApproval(101)).toBe(true);
    expect(hasPendingEngineerApproval(202)).toBe(true);
    expect(hasPendingEngineerApproval(303)).toBe(false);
  });

  it('重复写入不产生重复状态，清理只影响目标账号', () => {
    markEngineerApprovalPending(101);
    markEngineerApprovalPending(101);
    markEngineerApprovalPending(202);

    clearPendingEngineerApproval(101);

    expect(hasPendingEngineerApproval(101)).toBe(false);
    expect(hasPendingEngineerApproval(202)).toBe(true);
  });

  it('清理最后一个账号后移除存储键', () => {
    markEngineerApprovalPending(101);
    clearPendingEngineerApproval(101);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('非法 JSON 与脏数据按无标记处理，不抛错', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not-json');
    expect(hasPendingEngineerApproval(101)).toBe(false);

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(hasPendingEngineerApproval(101)).toBe(false);

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ '101': 'yes', '-2': true, abc: true, '202': true }),
    );
    expect(hasPendingEngineerApproval(101)).toBe(false);
    expect(hasPendingEngineerApproval(202)).toBe(true);
  });

  it('非法账号不写入', () => {
    markEngineerApprovalPending(0);
    markEngineerApprovalPending(-1);
    markEngineerApprovalPending(1.5);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('存储不可读/不可写时静默降级', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(hasPendingEngineerApproval(101)).toBe(false);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => markEngineerApprovalPending(101)).not.toThrow();
  });
});

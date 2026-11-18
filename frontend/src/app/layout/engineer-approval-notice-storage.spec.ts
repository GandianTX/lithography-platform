// src/app/layout/engineer-approval-notice-storage.spec.ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeEngineerApproval,
  hasAcknowledgedEngineerApproval,
} from './engineer-approval-notice-storage';

const STORAGE_KEY = 'lithography.engineer-approval-acknowledged.v1';

describe('engineer-approval-notice-storage（一次性展示偏好）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('按账号 + 申请隔离写入与读取', () => {
    acknowledgeEngineerApproval(101, 9001);
    acknowledgeEngineerApproval(202, 9001);

    expect(hasAcknowledgedEngineerApproval(101, 9001)).toBe(true);
    expect(hasAcknowledgedEngineerApproval(202, 9001)).toBe(true);
    expect(hasAcknowledgedEngineerApproval(101, 9002)).toBe(false);
    expect(hasAcknowledgedEngineerApproval(303, 9001)).toBe(false);
  });

  it('重复写入幂等，且不覆盖同一账号的其他申请', () => {
    acknowledgeEngineerApproval(101, 9001);
    acknowledgeEngineerApproval(101, 9002);
    acknowledgeEngineerApproval(101, 9001);

    expect(hasAcknowledgedEngineerApproval(101, 9001)).toBe(true);
    expect(hasAcknowledgedEngineerApproval(101, 9002)).toBe(true);
  });

  it('非法 JSON 与脏数据按未确认处理，不抛错', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not-json');
    expect(hasAcknowledgedEngineerApproval(101, 9001)).toBe(false);

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(hasAcknowledgedEngineerApproval(101, 9001)).toBe(false);

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        '101:9001': 'yes',
        '-2:9001': true,
        '101:0': true,
        abc: true,
        '202:9001': true,
      }),
    );
    expect(hasAcknowledgedEngineerApproval(101, 9001)).toBe(false);
    expect(hasAcknowledgedEngineerApproval(202, 9001)).toBe(true);
  });

  it('非法账号或申请主键不写入', () => {
    acknowledgeEngineerApproval(0, 9001);
    acknowledgeEngineerApproval(101, 0);
    acknowledgeEngineerApproval(-1, 9001);
    acknowledgeEngineerApproval(1.5, 9001);
    acknowledgeEngineerApproval(101, 1.5);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(hasAcknowledgedEngineerApproval(101, 9001)).toBe(false);
  });

  it('存储不可读/不可写时静默降级', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(hasAcknowledgedEngineerApproval(101, 9001)).toBe(false);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => acknowledgeEngineerApproval(101, 9001)).not.toThrow();
  });
});

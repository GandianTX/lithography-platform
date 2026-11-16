// src/features/admin-company-management/application/use-admin-company-name-check.spec.ts
// @vitest-environment jsdom

/**
 * 一级管理员精确同名提示 hook：
 * - 归一化口径与后端一致（去首尾空白、合并连续空白、统一小写）；
 * - 防抖后按「归一化名称 + 排除主键」请求，编辑排除自身、新增不下发排除键；
 * - 改名、清空、关闭弹窗或卸载后，晚到的旧响应不得写回；
 * - 查询失败按未命中处理，不影响提交。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn() }));

vi.mock('../infrastructure/admin-company-adapter', () => ({
  checkAdminCompanyNameExists: checkMock,
}));

import {
  ADMIN_COMPANY_NAME_CHECK_DEBOUNCE_MS,
  normalizeAdminCompanyNameForComparison,
  useAdminCompanyNameCheck,
} from './use-admin-company-name-check';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

type Props = {
  enabled: boolean;
  excludeOrganizationId?: number | null;
  name?: string | null;
};

function renderNameCheck(initial: Props) {
  return renderHook((props: Props) => useAdminCompanyNameCheck(props), { initialProps: initial });
}

describe('useAdminCompanyNameCheck（一级同名提示）', () => {
  beforeEach(() => {
    checkMock.mockReset();
    checkMock.mockResolvedValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('归一化口径与后端一致', () => {
    expect(normalizeAdminCompanyNameForComparison('  上海  光刻\t技术  ')).toBe('上海 光刻 技术');
    expect(normalizeAdminCompanyNameForComparison('ACME Corp')).toBe('acme corp');
    expect(normalizeAdminCompanyNameForComparison('   ')).toBe('');
  });

  it('防抖后按归一化名称请求，新增不下发排除主键', async () => {
    const { result } = renderNameCheck({ enabled: true, name: '  同名公司  ' });

    expect(result.current).toBe(false);
    expect(checkMock).not.toHaveBeenCalled();

    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(checkMock).toHaveBeenCalledWith({ name: '同名公司', excludeOrganizationId: null });
  });

  it('编辑场景把自身主键作为排除键一并下发', async () => {
    checkMock.mockResolvedValue(true);
    const { result } = renderNameCheck({
      enabled: true,
      excludeOrganizationId: 501,
      name: '甲公司',
    });

    await waitFor(() => expect(result.current).toBe(true));
    expect(checkMock).toHaveBeenCalledWith({ name: '甲公司', excludeOrganizationId: 501 });
  });

  it('连续改名只发起最后一次请求', async () => {
    const { rerender } = renderNameCheck({ enabled: true, name: '甲' });

    rerender({ enabled: true, name: '乙' });
    rerender({ enabled: true, name: '丙' });

    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(checkMock).toHaveBeenCalledWith({ name: '丙', excludeOrganizationId: null });
  });

  it('A 命中、B 未命中且 A 响应晚于 B：旧响应不覆盖当前结果', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    checkMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderNameCheck({ enabled: true, name: 'A公司' });
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));

    rerender({ enabled: true, name: 'B公司' });
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(false);
      await second.promise;
    });
    expect(result.current).toBe(false);

    await act(async () => {
      first.resolve(true);
      await first.promise;
    });
    expect(result.current).toBe(false);
  });

  it('排除主键变化后旧结果立即失效', async () => {
    checkMock.mockResolvedValue(true);
    const { result, rerender } = renderNameCheck({
      enabled: true,
      excludeOrganizationId: 501,
      name: '甲公司',
    });
    await waitFor(() => expect(result.current).toBe(true));

    checkMock.mockResolvedValue(false);
    rerender({ enabled: true, excludeOrganizationId: 502, name: '甲公司' });

    await waitFor(() => expect(result.current).toBe(false));
    await waitFor(() =>
      expect(checkMock).toHaveBeenLastCalledWith({ name: '甲公司', excludeOrganizationId: 502 }),
    );
  });

  it('清空名称立即清除提示，且不发起空名称查询', async () => {
    checkMock.mockResolvedValue(true);
    const { result, rerender } = renderNameCheck({ enabled: true, name: '同名公司' });
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ enabled: true, name: '' });

    await waitFor(() => expect(result.current).toBe(false));
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it('弹窗关闭后立即清除提示且不请求', async () => {
    checkMock.mockResolvedValue(true);
    const { result, rerender } = renderNameCheck({ enabled: true, name: '同名公司' });
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ enabled: false, name: '同名公司' });

    await waitFor(() => expect(result.current).toBe(false));
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it('空白名称不发起请求', async () => {
    const { result } = renderNameCheck({ enabled: true, name: '   ' });

    await new Promise((resolve) => setTimeout(resolve, ADMIN_COMPANY_NAME_CHECK_DEBOUNCE_MS + 100));

    expect(result.current).toBe(false);
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('查询失败按未命中处理', async () => {
    checkMock.mockRejectedValue(new Error('network down'));
    const { result } = renderNameCheck({ enabled: true, name: '同名公司' });

    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);
  });

  it('防抖窗口内卸载不再发起请求', async () => {
    const { unmount } = renderNameCheck({ enabled: true, name: '同名公司' });

    unmount();

    await new Promise((resolve) => setTimeout(resolve, ADMIN_COMPANY_NAME_CHECK_DEBOUNCE_MS + 100));
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('在途请求返回前卸载：晚到响应作废，不写回也不报错', async () => {
    const pending = deferred<boolean>();
    checkMock.mockReturnValueOnce(pending.promise);
    const { unmount } = renderNameCheck({ enabled: true, name: '同名公司' });

    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });

    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
  });
});

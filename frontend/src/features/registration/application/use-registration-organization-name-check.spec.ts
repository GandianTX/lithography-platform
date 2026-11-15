// src/features/registration/application/use-registration-organization-name-check.spec.ts
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn() }));

vi.mock('../infrastructure/registration-organization-adapter', () => ({
  checkRegistrationOrganizationNameExists: checkMock,
}));

import {
  normalizeRegistrationOrganizationName,
  REGISTRATION_ORGANIZATION_NAME_CHECK_DEBOUNCE_MS,
  useRegistrationOrganizationNameCheck,
} from './use-registration-organization-name-check';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function renderNameCheck(initial: { enabled: boolean; name?: string | null }) {
  return renderHook(
    (props: { enabled: boolean; name?: string | null }) =>
      useRegistrationOrganizationNameCheck(props),
    { initialProps: initial },
  );
}

describe('useRegistrationOrganizationNameCheck（手填公司名精确同名提示）', () => {
  beforeEach(() => {
    checkMock.mockReset();
    checkMock.mockResolvedValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('归一化口径与后端一致：去首尾空白、合并连续空白、统一小写', () => {
    expect(normalizeRegistrationOrganizationName('  上海  光刻\t技术  ')).toBe('上海 光刻 技术');
    expect(normalizeRegistrationOrganizationName('ACME Corp')).toBe('acme corp');
    expect(normalizeRegistrationOrganizationName('   ')).toBe('');
  });

  it('防抖后只按归一化名称请求一次', async () => {
    const { result } = renderNameCheck({ enabled: true, name: '  同名公司  ' });

    expect(result.current).toBe(false);
    expect(checkMock).not.toHaveBeenCalled();

    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(checkMock).toHaveBeenCalledWith('同名公司');
  });

  it('连续改名只发起最后一次请求', async () => {
    const { rerender } = renderNameCheck({ enabled: true, name: '甲' });

    rerender({ enabled: true, name: '乙' });
    rerender({ enabled: true, name: '丙' });

    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(checkMock).toHaveBeenCalledWith('丙');
  });

  it('命中时返回 true', async () => {
    checkMock.mockResolvedValue(true);
    const { result } = renderNameCheck({ enabled: true, name: '同名公司' });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('A 有同名、B 无同名且 A 响应晚于 B：只保留当前 B 的状态', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    checkMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderNameCheck({ enabled: true, name: 'A公司' });
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(checkMock).toHaveBeenNthCalledWith(1, 'a公司');

    rerender({ enabled: true, name: 'B公司' });
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(2));
    expect(checkMock).toHaveBeenNthCalledWith(2, 'b公司');

    // 后发的 B 先返回（无同名）
    await act(async () => {
      second.resolve(false);
      await second.promise;
    });
    expect(result.current).toBe(false);

    // 先发的 A 迟到（有同名），不得覆盖 B
    await act(async () => {
      first.resolve(true);
      await first.promise;
    });
    expect(result.current).toBe(false);
  });

  it('清空名称立即清除提示，且不发起空名称查询', async () => {
    checkMock.mockResolvedValue(true);
    const { result, rerender } = renderNameCheck({ enabled: true, name: '同名公司' });
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ enabled: true, name: '' });

    await waitFor(() => expect(result.current).toBe(false));
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it('改选名单公司（enabled=false）立即清除提示且不请求', async () => {
    checkMock.mockResolvedValue(true);
    const { result, rerender } = renderNameCheck({ enabled: true, name: '同名公司' });
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ enabled: false, name: '同名公司' });

    await waitFor(() => expect(result.current).toBe(false));
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it('空白名称不发起请求', async () => {
    const { result } = renderNameCheck({ enabled: true, name: '   ' });

    await new Promise((resolve) =>
      setTimeout(resolve, REGISTRATION_ORGANIZATION_NAME_CHECK_DEBOUNCE_MS + 100),
    );

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

    await new Promise((resolve) =>
      setTimeout(resolve, REGISTRATION_ORGANIZATION_NAME_CHECK_DEBOUNCE_MS + 100),
    );
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

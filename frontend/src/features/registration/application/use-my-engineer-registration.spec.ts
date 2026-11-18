// src/features/registration/application/use-my-engineer-registration.spec.ts
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../infrastructure/my-engineer-registration-adapter', () => ({
  fetchMyEngineerRegistration: fetchMock,
}));

import type { MyEngineerRegistrationView } from './registration.types';
import { useMyEngineerRegistration } from './use-my-engineer-registration';

const APPLICATION: MyEngineerRegistrationView = {
  applicationId: 77,
  organizationId: 21,
  organizationName: '示例光刻科技',
  status: 'PENDING',
  applicationNote: null,
  submittedAt: '2026-02-01T00:00:00.000Z',
  reviewedAt: null,
  reviewComment: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('useMyEngineerRegistration（受限页本人申请加载）', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即加载并暴露申请事实', async () => {
    fetchMock.mockResolvedValue(APPLICATION);

    const { result } = renderHook(() => useMyEngineerRegistration());

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toEqual({ application: APPLICATION, status: 'ready' });
  });

  it('没有申请记录是正常态（application 为 null）', async () => {
    fetchMock.mockResolvedValue(null);

    const { result } = renderHook(() => useMyEngineerRegistration());

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toEqual({ application: null, status: 'ready' });
  });

  it('失败进入 failed，retry 重新加载并恢复 ready', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() => useMyEngineerRegistration());

    await waitFor(() => expect(result.current.state.status).toBe('failed'));

    fetchMock.mockResolvedValueOnce(APPLICATION);
    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toEqual({ application: APPLICATION, status: 'ready' });
  });

  it('ready 态 refresh 保留当前数据，直到新结果返回', async () => {
    fetchMock.mockResolvedValueOnce(APPLICATION);

    const { result } = renderHook(() => useMyEngineerRegistration());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const next = deferred<MyEngineerRegistrationView | null>();
    fetchMock.mockReturnValueOnce(next.promise);

    act(() => {
      result.current.refresh();
    });

    // 刷新期间不把已有申请打成 loading，避免卡片闪断
    expect(result.current.state).toEqual({ application: APPLICATION, status: 'ready' });

    const approved: MyEngineerRegistrationView = { ...APPLICATION, status: 'APPROVED' };
    next.resolve(approved);

    await waitFor(() =>
      expect(result.current.state).toEqual({ application: approved, status: 'ready' }),
    );
  });

  it('refresh 失败进入 failed，可再次 retry 恢复', async () => {
    fetchMock.mockResolvedValueOnce(APPLICATION);

    const { result } = renderHook(() => useMyEngineerRegistration());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    fetchMock.mockRejectedValueOnce(new Error('network'));
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.state.status).toBe('failed'));

    fetchMock.mockResolvedValueOnce(APPLICATION);
    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
  });

  it('连续刷新时较早请求的迟到结果不覆盖最新结果', async () => {
    fetchMock.mockResolvedValueOnce(APPLICATION);

    const { result } = renderHook(() => useMyEngineerRegistration());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const older = deferred<MyEngineerRegistrationView | null>();
    fetchMock.mockReturnValueOnce(older.promise);

    const approved: MyEngineerRegistrationView = { ...APPLICATION, status: 'APPROVED' };
    act(() => {
      result.current.refresh();
    });

    fetchMock.mockResolvedValueOnce(approved);
    act(() => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({ application: approved, status: 'ready' }),
    );

    older.resolve(APPLICATION);
    await waitFor(() =>
      expect(result.current.state).toEqual({ application: approved, status: 'ready' }),
    );
  });

  it('重试后旧请求的迟到失败不覆盖新结果', async () => {
    const first = deferred<MyEngineerRegistrationView | null>();
    fetchMock.mockReturnValueOnce(first.promise);

    const { result } = renderHook(() => useMyEngineerRegistration());

    fetchMock.mockResolvedValueOnce(APPLICATION);
    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    first.reject(new Error('late failure'));
    await waitFor(() =>
      expect(result.current.state).toEqual({ application: APPLICATION, status: 'ready' }),
    );
  });
});

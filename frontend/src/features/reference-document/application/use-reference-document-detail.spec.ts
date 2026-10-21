// src/features/reference-document/application/use-reference-document-detail.spec.ts
// @vitest-environment jsdom

/**
 * 参考资料详情 query 状态机单测（负责人 0909 阻塞项 2）。
 *
 * 用两个可控 Promise 模拟「请求 A 在途时切换 B、B 先返回、A 后返回」的竞态：
 * 无论旧请求成功、not-found 还是抛错，都不得覆盖当前 ID 的状态；
 * 非法参数（id=null）不发起请求，直接进入统一 not-found 口径。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReferenceDocumentDetail } from '../infrastructure/reference-document.types';
import * as referenceDocumentAdapter from '../infrastructure/reference-document-adapter';

import { useReferenceDocumentDetail } from './use-reference-document-detail';

vi.mock('../infrastructure/reference-document-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceDocumentAdapter>();

  return {
    ...actual,
    fetchReferenceDocument: vi.fn(),
  };
});

const fetchDetailMock = vi.mocked(referenceDocumentAdapter.fetchReferenceDocument);

function buildDetail(id: number): ReferenceDocumentDetail {
  return {
    id,
    title: `资料 ${id}`,
    documentType: 'MAINTENANCE_GUIDE',
    equipmentModelId: null,
    equipmentModelName: null,
    equipmentModelText: null,
    description: null,
    originalFilename: null,
    mimeType: null,
    hasFile: false,
    contentText: `内容 ${id}`,
    organizationName: '甲方默认组织',
    ingestMethod: 'ADMIN_DIRECT',
    caseDetail: null,
    creatorNickname: '系统管理员',
    createdAt: '2026-08-02T09:30:00.000Z',
    updatedAt: '2026-08-05T14:00:00.000Z',
  };
}

/** 可控 Promise：手动决定 resolve/reject 时机，模拟响应乱序 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

beforeEach(() => {
  fetchDetailMock.mockReset();
});

describe('useReferenceDocumentDetail 竞态保护', () => {
  it('A 在途时切换 B、B 先返回 A 后返回：最终始终显示 B', async () => {
    const promiseA = deferred<{ ok: true; detail: ReferenceDocumentDetail }>();
    const promiseB = deferred<{ ok: true; detail: ReferenceDocumentDetail }>();

    fetchDetailMock.mockImplementation((id) =>
      id === 970001 ? (promiseA.promise as never) : (promiseB.promise as never),
    );

    const { result, rerender } = renderHook(({ id }) => useReferenceDocumentDetail(id), {
      initialProps: { id: 970001 as number | null },
    });

    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledWith(970001));

    // 请求 A 在途时切换到 B
    rerender({ id: 970002 });
    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledWith(970002));

    // B 先返回 → ready(B)
    await act(async () => {
      promiseB.resolve({ ok: true, detail: buildDetail(970002) });
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state.status === 'ready' ? result.current.state.detail.id : null).toBe(
      970002,
    );

    // A 后返回 → 不得覆盖 B
    await act(async () => {
      promiseA.resolve({ ok: true, detail: buildDetail(970001) });
    });
    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.status === 'ready' ? result.current.state.detail.id : null).toBe(
      970002,
    );
  });

  it('旧请求后返回 not-found 或抛错，均不能覆盖新请求的成功状态', async () => {
    const promiseA = deferred<{ ok: false; reason: string; message: string }>();
    const promiseB = deferred<{ ok: true; detail: ReferenceDocumentDetail }>();

    fetchDetailMock.mockImplementation((id) =>
      id === 970001 ? (promiseA.promise as never) : (promiseB.promise as never),
    );

    const { result, rerender } = renderHook(({ id }) => useReferenceDocumentDetail(id), {
      initialProps: { id: 970001 as number | null },
    });

    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledWith(970001));

    rerender({ id: 970002 });
    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledWith(970002));

    await act(async () => {
      promiseB.resolve({ ok: true, detail: buildDetail(970002) });
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    // 旧请求 A 的 not-found 不得覆盖
    await act(async () => {
      promiseA.resolve({ ok: false, reason: 'not-found', message: '参考资料不存在或不可查看。' });
    });
    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.status === 'ready' ? result.current.state.detail.id : null).toBe(
      970002,
    );
  });

  it('非法参数（id=null）不发起请求，直接进入统一 not-found；恢复合法 ID 后正常加载', async () => {
    const { result, rerender } = renderHook(({ id }) => useReferenceDocumentDetail(id), {
      initialProps: { id: null as number | null },
    });

    await waitFor(() => expect(result.current.state.status).toBe('not-found'));
    expect(fetchDetailMock).not.toHaveBeenCalled();
    expect(result.current.state.status === 'not-found' ? result.current.state.message : null).toBe(
      '参考资料不存在或不可查看。',
    );

    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(970002) });

    rerender({ id: 970002 });

    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledWith(970002));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
  });

  it('reload 基于当前 ID 发起新请求（新请求序号），成功后刷新详情', async () => {
    fetchDetailMock
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(970002) })
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(970002) });

    const { result } = renderHook(() => useReferenceDocumentDetail(970002));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.reload();
    });

    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));
    expect(fetchDetailMock).toHaveBeenLastCalledWith(970002);
  });

  // 负责人 0909 第二轮阻塞项 2：有效 ID → null（无效路由）时旧请求不得覆盖。
  // null 分支同样递增序号使在途 A 请求过期；以下三例分别钉住 success / not-found / failure。
  describe('A 在途时切换到 null（无效路由）', () => {
    function arrangeInFlightToNull() {
      const promiseA = deferred<
        | { ok: true; detail: ReferenceDocumentDetail }
        | { ok: false; reason: string; message: string }
      >();

      fetchDetailMock.mockImplementation((id) =>
        id === 970001 ? (promiseA.promise as never) : (Promise.resolve() as never),
      );

      const rendered = renderHook(({ id }) => useReferenceDocumentDetail(id), {
        initialProps: { id: 970001 as number | null },
      });

      return { promiseA, rendered };
    }

    async function switchToNullAndWait(
      rendered: ReturnType<typeof arrangeInFlightToNull>['rendered'],
    ) {
      rendered.rerender({ id: null });
      await waitFor(() => expect(rendered.result.current.state.status).toBe('not-found'));
    }

    it('A 后返回成功：不得覆盖当前无效路由的 not-found', async () => {
      const { promiseA, rendered } = arrangeInFlightToNull();

      await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledWith(970001));
      await switchToNullAndWait(rendered);

      await act(async () => {
        promiseA.resolve({ ok: true, detail: buildDetail(970001) });
      });

      expect(rendered.result.current.state.status).toBe('not-found');
      expect(
        rendered.result.current.state.status === 'not-found'
          ? rendered.result.current.state.message
          : null,
      ).toBe('参考资料不存在或不可查看。');
    });

    it('A 后返回 not-found：不重复覆盖（状态与文案保持稳定）', async () => {
      const { promiseA, rendered } = arrangeInFlightToNull();

      await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledWith(970001));
      await switchToNullAndWait(rendered);

      await act(async () => {
        promiseA.resolve({
          ok: false,
          reason: 'not-found',
          message: 'A 请求的未找到结果。',
        });
      });

      expect(rendered.result.current.state.status).toBe('not-found');
      expect(
        rendered.result.current.state.status === 'not-found'
          ? rendered.result.current.state.message
          : null,
      ).toBe('参考资料不存在或不可查看。');
    });

    it('A 后返回失败（抛错）：不得覆盖当前无效路由的 not-found', async () => {
      const { promiseA, rendered } = arrangeInFlightToNull();

      await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledWith(970001));
      await switchToNullAndWait(rendered);

      await act(async () => {
        promiseA.reject(new Error('A 请求失败'));
      });

      expect(rendered.result.current.state.status).toBe('not-found');
      expect(
        rendered.result.current.state.status === 'not-found'
          ? rendered.result.current.state.message
          : null,
      ).toBe('参考资料不存在或不可查看。');
    });
  });
});

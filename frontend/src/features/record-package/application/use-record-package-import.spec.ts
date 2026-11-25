// src/features/record-package/application/use-record-package-import.spec.ts

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  RecordPackageCheckResult,
  RecordPackageProcessResult,
} from '../infrastructure/record-package.types';
import { checkRecordPackage, importRecordPackage } from '../infrastructure/record-package-adapter';

import { useRecordPackageImport } from './use-record-package-import';

/**
 * 记录包导入流程的竞态防护与确认绑定（任务 09 第 06 项 · P2-1／G36）。
 *
 * 覆盖：
 * - 预检成功如实落地；
 * - **A 先发后到、B 先返回** ⇒ 旧预检结论不覆盖新包（路径与摘要都跟着新包）；
 * - `reset`（换包）后在途响应不回写；
 * - **双击确认只发一次导入请求**（同步闸门，不依赖渲染快照）；
 * - 确认绑定那一轮预检的包 ID／路径／清单摘要；
 * - 导入失败如实落到失败态；
 * - 清单级 GraphQL BAD_USER_INPUT 按稳定分类码展示受控提示，不误导重试。
 */

vi.mock('../infrastructure/record-package-adapter', () => ({
  checkRecordPackage: vi.fn(),
  importRecordPackage: vi.fn(),
}));

const makeCheck = (packageId: string): RecordPackageCheckResult => ({
  outcome: 'checked',
  import: {
    packageId,
    organizationId: 1,
    importedByAccountId: 1,
    manifestChecksum: `checksum-${packageId}`,
    status: 'PENDING',
    checkStatus: 'PASSED',
    itemTotal: 1,
    itemSucceeded: 0,
    itemFailed: 0,
    createdAt: '2026-11-24T00:00:00.000Z',
    completedAt: null,
  },
  items: [],
});

const makeProcess = (packageId: string): RecordPackageProcessResult => ({
  import: {
    ...makeCheck(packageId).import,
    status: 'SUCCEEDED',
    itemSucceeded: 1,
    completedAt: '2026-11-24T00:01:00.000Z',
  },
  items: [],
});

describe('useRecordPackageImport', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('预检成功：状态与包事实如实落地', async () => {
    vi.mocked(checkRecordPackage).mockResolvedValue(makeCheck('pkg-1'));

    const { result } = renderHook(() => useRecordPackageImport());
    await act(async () => {
      await result.current.check('/media/usb/pkg-1');
    });

    expect(result.current.state.status).toBe('checked');
    expect(result.current.state).toMatchObject({ packagePath: '/media/usb/pkg-1' });
  });

  it('清单级 GraphQL 错误只返回稳定翻译键，文案交给 UI 当前语言', async () => {
    vi.mocked(checkRecordPackage).mockRejectedValue(
      new GraphQLIngressError({
        type: 'graphql',
        message: 'GraphQL error',
        graphqlErrors: [
          {
            message: 'GraphQL error',
            extensions: { code: 'BAD_USER_INPUT', errorCode: 'RECORD_PACKAGE_INVALID_MANIFEST' },
          },
        ],
      }),
    );

    const { result } = renderHook(() => useRecordPackageImport());
    await act(async () => {
      await result.current.check('/media/usb/pkg-1');
    });

    expect(result.current.state.status).toBe('failed');
    expect(result.current.state).toMatchObject({
      message: '记录包检查失败，请稍后重试。',
      messageKey: 'recordPackage.import.error.badUserInput',
    });
  });

  it('A 先发后到、B 先返回：旧预检结论不覆盖新包', async () => {
    let resolveA: (value: RecordPackageCheckResult) => void = () => {};
    vi.mocked(checkRecordPackage)
      .mockImplementationOnce(
        () =>
          new Promise<RecordPackageCheckResult>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValueOnce(makeCheck('pkg-B'));

    const { result } = renderHook(() => useRecordPackageImport());
    act(() => {
      void result.current.check('/media/usb/a');
    });
    await act(async () => {
      await result.current.check('/media/usb/b');
    });
    expect(result.current.state).toMatchObject({
      status: 'checked',
      packagePath: '/media/usb/b',
    });

    await act(async () => {
      resolveA(makeCheck('pkg-A'));
      await Promise.resolve();
    });
    expect(result.current.state).toMatchObject({
      status: 'checked',
      packagePath: '/media/usb/b',
    });
  });

  it('reset 后在途响应不回写：换包后旧结论不复活', async () => {
    let resolveCheck: (value: RecordPackageCheckResult) => void = () => {};
    vi.mocked(checkRecordPackage).mockImplementation(
      () =>
        new Promise<RecordPackageCheckResult>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const { result } = renderHook(() => useRecordPackageImport());
    act(() => {
      void result.current.check('/media/usb/a');
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.state.status).toBe('idle');

    await act(async () => {
      resolveCheck(makeCheck('pkg-A'));
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe('idle');
  });

  it('双击确认只发一次导入请求', async () => {
    vi.mocked(checkRecordPackage).mockResolvedValue(makeCheck('pkg-1'));
    let resolveImport: (value: RecordPackageProcessResult) => void = () => {};
    vi.mocked(importRecordPackage).mockImplementation(
      () =>
        new Promise<RecordPackageProcessResult>((resolve) => {
          resolveImport = resolve;
        }),
    );

    const { result } = renderHook(() => useRecordPackageImport());
    await act(async () => {
      await result.current.check('/media/usb/pkg-1');
    });

    // 同一批次内连续两次确认（模拟双击）：第二次必须被同步闸门拦下
    act(() => {
      void result.current.confirmImport();
      void result.current.confirmImport();
    });
    expect(importRecordPackage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveImport(makeProcess('pkg-1'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.state.status).toBe('imported');
  });

  it('确认绑定那一轮预检的包 ID／路径／清单摘要', async () => {
    vi.mocked(checkRecordPackage).mockResolvedValue(makeCheck('pkg-1'));
    vi.mocked(importRecordPackage).mockResolvedValue(makeProcess('pkg-1'));

    const { result } = renderHook(() => useRecordPackageImport());
    await act(async () => {
      await result.current.check('/media/usb/pkg-1');
    });
    await act(async () => {
      await result.current.confirmImport();
    });

    expect(importRecordPackage).toHaveBeenCalledWith({
      packageId: 'pkg-1',
      packagePath: '/media/usb/pkg-1',
      manifestChecksum: 'checksum-pkg-1',
    });
  });

  it('导入失败如实落到失败态', async () => {
    vi.mocked(checkRecordPackage).mockResolvedValue(makeCheck('pkg-1'));
    vi.mocked(importRecordPackage).mockRejectedValue(new Error('导入失败'));

    const { result } = renderHook(() => useRecordPackageImport());
    await act(async () => {
      await result.current.check('/media/usb/pkg-1');
    });
    await act(async () => {
      await result.current.confirmImport();
    });

    expect(result.current.state.status).toBe('failed');
  });

  it('导入中重置：在途导入成功响应不写回（已重置的界面不"复活"）', async () => {
    vi.mocked(checkRecordPackage).mockResolvedValue(makeCheck('pkg-1'));
    let resolveImport: (value: RecordPackageProcessResult) => void = () => {};
    vi.mocked(importRecordPackage).mockImplementation(
      () =>
        new Promise<RecordPackageProcessResult>((resolve) => {
          resolveImport = resolve;
        }),
    );

    const { result } = renderHook(() => useRecordPackageImport());
    await act(async () => {
      await result.current.check('/media/usb/pkg-1');
    });

    act(() => {
      void result.current.confirmImport();
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.state.status).toBe('idle');

    await act(async () => {
      resolveImport(makeProcess('pkg-1'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.state.status).toBe('idle');
  });
});

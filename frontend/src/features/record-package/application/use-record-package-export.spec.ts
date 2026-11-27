// src/features/record-package/application/use-record-package-export.spec.ts

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecordPackageExportResult } from '../infrastructure/record-package.types';
import { exportRecordPackage } from '../infrastructure/record-package-adapter';

import { useRecordPackageExport } from './use-record-package-export';

/**
 * 记录包导出流程的竞态防护（任务 09 第 06 项 · P2-1／G36）。
 *
 * 覆盖：
 * - 导出成功如实落地；
 * - **A 先发后到、B 先返回** ⇒ 晚到的 A 不覆盖 B 的结果；
 * - `reset`（关闭对话框）后在途响应不回写（状态不"复活"）；
 * - 旧响应的失败不覆盖新响应的成功。
 */

vi.mock('../infrastructure/record-package-adapter', () => ({
  exportRecordPackage: vi.fn(),
}));

const makeResult = (packageId: string): RecordPackageExportResult => ({
  packageId,
  packagePath: `/media/usb/${packageId}`,
  organizationId: 1,
  resourceType: 'REPAIR_REQUEST',
  manifestChecksum: `checksum-${packageId}`,
  itemTotal: 1,
  itemExported: 1,
  itemFailed: 0,
  items: [],
});

describe('useRecordPackageExport', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('导出成功：状态与结果如实落地', async () => {
    vi.mocked(exportRecordPackage).mockResolvedValue(makeResult('pkg-1'));

    const { result } = renderHook(() => useRecordPackageExport());
    await act(async () => {
      await result.current.run({
        targetPath: '/media/usb/pkg',
        resourceType: 'REPAIR_REQUEST',
        recordIds: [1],
      });
    });

    expect(result.current.state.status).toBe('succeeded');
    expect(result.current.state).toMatchObject({ result: { packageId: 'pkg-1' } });
  });

  it('A 先发后到、B 先返回：晚到的 A 不覆盖 B 的结果', async () => {
    let resolveA: (value: RecordPackageExportResult) => void = () => {};
    vi.mocked(exportRecordPackage)
      .mockImplementationOnce(
        () =>
          new Promise<RecordPackageExportResult>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValueOnce(makeResult('pkg-B'));

    const { result } = renderHook(() => useRecordPackageExport());

    // A（慢）：先发出
    act(() => {
      void result.current.run({
        targetPath: '/media/usb/a',
        resourceType: 'REPAIR_REQUEST',
        recordIds: [1],
      });
    });
    // B（快）：后发出并先返回
    await act(async () => {
      await result.current.run({
        targetPath: '/media/usb/b',
        resourceType: 'REPAIR_REQUEST',
        recordIds: [2],
      });
    });
    expect(result.current.state).toMatchObject({
      status: 'succeeded',
      result: { packageId: 'pkg-B' },
    });

    // A 迟到：必须被丢弃
    await act(async () => {
      resolveA(makeResult('pkg-A'));
      await Promise.resolve();
    });
    expect(result.current.state).toMatchObject({
      status: 'succeeded',
      result: { packageId: 'pkg-B' },
    });
  });

  it('reset 后在途响应不回写：关闭对话框后旧结果不复活', async () => {
    let resolveExport: (value: RecordPackageExportResult) => void = () => {};
    vi.mocked(exportRecordPackage).mockImplementation(
      () =>
        new Promise<RecordPackageExportResult>((resolve) => {
          resolveExport = resolve;
        }),
    );

    const { result } = renderHook(() => useRecordPackageExport());
    act(() => {
      void result.current.run({
        targetPath: '/media/usb/pkg',
        resourceType: 'REPAIR_REQUEST',
        recordIds: [1],
      });
    });

    act(() => {
      result.current.reset();
    });
    expect(result.current.state.status).toBe('idle');

    await act(async () => {
      resolveExport(makeResult('pkg-late'));
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe('idle');
  });

  it('旧响应的失败不覆盖新响应的成功', async () => {
    let rejectA: (reason: Error) => void = () => {};
    vi.mocked(exportRecordPackage)
      .mockImplementationOnce(
        () =>
          new Promise<RecordPackageExportResult>((_resolve, reject) => {
            rejectA = reject;
          }),
      )
      .mockResolvedValueOnce(makeResult('pkg-B'));

    const { result } = renderHook(() => useRecordPackageExport());
    act(() => {
      void result.current.run({
        targetPath: '/media/usb/a',
        resourceType: 'REPAIR_REQUEST',
        recordIds: [1],
      });
    });
    await act(async () => {
      await result.current.run({
        targetPath: '/media/usb/b',
        resourceType: 'REPAIR_REQUEST',
        recordIds: [2],
      });
    });

    await act(async () => {
      rejectA(new Error('旧请求失败'));
      await Promise.resolve();
    });
    expect(result.current.state).toMatchObject({
      status: 'succeeded',
      result: { packageId: 'pkg-B' },
    });
  });

  it('切账号：在途响应对旧账号作废（不写进新账号的界面）', async () => {
    let resolveExport: (value: RecordPackageExportResult) => void = () => {};
    vi.mocked(exportRecordPackage).mockImplementation(
      () =>
        new Promise<RecordPackageExportResult>((resolve) => {
          resolveExport = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ sessionKey }: { sessionKey: number | null }) => useRecordPackageExport(sessionKey),
      { initialProps: { sessionKey: 900101 } },
    );

    act(() => {
      void result.current.run({
        targetPath: '/media/usb/pkg',
        resourceType: 'REPAIR_REQUEST',
        recordIds: [1],
      });
    });

    // 切账号
    rerender({ sessionKey: 900202 });
    await waitFor(() => expect(result.current.state.status).toBe('idle'));

    // 旧账号的响应到达：必须被丢弃
    await act(async () => {
      resolveExport(makeResult('pkg-old-account'));
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe('idle');
  });
});

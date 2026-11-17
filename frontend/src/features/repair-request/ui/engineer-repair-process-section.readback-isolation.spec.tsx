// src/features/repair-request/ui/engineer-repair-process-section.readback-isolation.spec.tsx
// @vitest-environment jsdom

/**
 * 写后回读窗口跨实例隔离（真实 detail hook + 真实 workbench hook + 真实 section）。
 * 用可控 Promise 推进 mutation / reload，不使用 sleep；只 mock 外部 adapter。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEngineerRepairRequestDetail } from '../application/use-engineer-repair-request-detail';
import type {
  EngineerRepairProcessEntry,
  EngineerRepairRequestDetail,
  RepairProcessWriteResult,
} from '../infrastructure/engineer-repair-request.types';
import * as adapter from '../infrastructure/engineer-repair-request-adapter';

import { EngineerRepairProcessSection } from './engineer-repair-process-section';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof adapter>();
  return {
    ...actual,
    fetchEngineerRepairRequestDetail: vi.fn(),
    uploadRepairProcessFile: vi.fn(),
    createRepairProcessEntry: vi.fn(),
    updateRepairProcessEntry: vi.fn(),
    downloadRepairProcessFile: vi.fn(),
    closeRepairRequest: vi.fn(),
  };
});

const fetchMock = vi.mocked(adapter.fetchEngineerRepairRequestDetail);
const updateMock = vi.mocked(adapter.updateRepairProcessEntry);

const ENTRY_A: EngineerRepairProcessEntry = {
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: 21,
  operationText: 'A 原过程',
  testResult: null,
  occurredAt: null,
  timeSource: 'SERVER',
  fileId: null,
  file: null,
  versionNo: 1,
  createdAt: '2026-11-14T03:00:00.000Z',
};

const ENTRY_B: EngineerRepairProcessEntry = {
  ...ENTRY_A,
  id: '102',
  entryUuid: '5f0c5f6a-2222-4222-8222-222222222222',
  operationText: 'B 原过程',
};

const PROCESS_OK: RepairProcessWriteResult = { ok: true, entry: ENTRY_B };

function makeDetail(
  requestId: number,
  processEntries: EngineerRepairProcessEntry[],
): EngineerRepairRequestDetail {
  return {
    id: requestId,
    requestNo: `R-${requestId}`,
    errorCode: 'E',
    faultDescription: '故障',
    contentMd: '',
    createdAt: '2026-11-14T02:00:00.000Z',
    isAccepted: true,
    acceptedAt: '2026-11-14T02:30:00.000Z',
    latestResolutionStatus: null,
    equipmentModel: { id: 1, modelName: 'M' },
    responses: [],
    customerNickname: null,
    customerCompanyName: null,
    acceptanceViewStatus: null,
    acceptedEngineerNickname: '工程师',
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: null,
    processEntries,
  } as unknown as EngineerRepairRequestDetail;
}

function Harness({ requestId }: { requestId: number }) {
  const detail = useEngineerRepairRequestDetail(requestId);

  if (detail.state.status === 'loading') {
    return <div>共享详情加载中</div>;
  }
  if (detail.state.status === 'failed') {
    return <div>共享详情失败：{detail.state.message}</div>;
  }

  return (
    <div>
      <div data-testid="shared-fingerprint">
        {detail.state.detail.processEntries.map((entry) => entry.operationText).join('|')}
      </div>
      <EngineerRepairProcessSection
        canWrite
        processEntries={detail.state.detail.processEntries}
        readOnly={false}
        reload={detail.reload}
        requestId={requestId}
      />
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  fetchMock.mockReset();
  updateMock.mockReset();
  updateMock.mockResolvedValue(PROCESS_OK);
});

describe('保存 → mutation → reload 回读窗口', () => {
  it('A mutation 成功、A reload 在途 → 切 B 输入 → A reload 成功：B 详情/输入/loading/反馈不受影响', async () => {
    const reloadDeferred = deferred<{ ok: true; detail: EngineerRepairRequestDetail }>();
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: makeDetail(21, [ENTRY_A, ENTRY_B]) })
      .mockReturnValueOnce(reloadDeferred.promise);
    const mutation = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(mutation.promise);

    render(<Harness requestId={21} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(2));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.change(screen.getByPlaceholderText('记录实际执行的操作…'), {
      target: { value: 'A 的新操作' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    mutation.resolve(PROCESS_OK);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // 回读在途时详情不得切回 loading，B 仍可进入编辑
    expect(screen.queryByText('共享详情加载中')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
    const textarea = screen.getByPlaceholderText('记录实际执行的操作…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'B 的输入' } });

    reloadDeferred.resolve({
      ok: true,
      detail: makeDetail(21, [{ ...ENTRY_A, operationText: 'A-RELOAD-SENTINEL' }]),
    });
    await waitFor(() =>
      expect(screen.getByTestId('shared-fingerprint').textContent).not.toContain(
        'A-RELOAD-SENTINEL',
      ),
    );

    expect(textarea.value).toBe('B 的输入');
    expect(screen.getByText('编辑维修过程')).toBeTruthy();
    expect(screen.queryByText('内部维修过程已保存。')).toBeNull();
    expect(screen.queryByText('共享详情加载中')).toBeNull();
  });

  it('相同交错但 A reload 失败：不向 B 写错误、不关闭 B', async () => {
    const reloadDeferred = deferred<{
      ok: false;
      reason: 'load-failed';
      message: string;
    }>();
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: makeDetail(21, [ENTRY_A, ENTRY_B]) })
      .mockReturnValueOnce(reloadDeferred.promise);
    const mutation = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(mutation.promise);

    render(<Harness requestId={21} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(2));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    mutation.resolve(PROCESS_OK);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
    const textarea = screen.getByPlaceholderText('记录实际执行的操作…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'B 的输入不受失败影响' } });

    reloadDeferred.resolve({
      ok: false,
      reason: 'load-failed',
      message: 'A 回读失败-SENTINEL',
    });
    await waitFor(() => expect(screen.queryByText(/A 回读失败-SENTINEL/)).toBeNull());

    expect(screen.queryByText(/共享详情失败/)).toBeNull();
    expect(screen.getByTestId('shared-fingerprint').textContent).toContain('A 原过程');
    expect(textarea.value).toBe('B 的输入不受失败影响');
    expect(screen.getByText('编辑维修过程')).toBeTruthy();
  });

  it('A→B→A：旧实例的 reload 成功不得写入重新打开的 A', async () => {
    const reloadDeferred = deferred<{ ok: true; detail: EngineerRepairRequestDetail }>();
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: makeDetail(21, [ENTRY_A, ENTRY_B]) })
      .mockReturnValueOnce(reloadDeferred.promise);
    const mutation = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(mutation.promise);

    render(<Harness requestId={21} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(2));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    mutation.resolve(PROCESS_OK);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);

    reloadDeferred.resolve({
      ok: true,
      detail: makeDetail(21, [{ ...ENTRY_A, operationText: 'A-RELOAD-SENTINEL' }]),
    });
    await waitFor(() =>
      expect(screen.getByTestId('shared-fingerprint').textContent).not.toContain(
        'A-RELOAD-SENTINEL',
      ),
    );

    expect(screen.getByText('编辑维修过程')).toBeTruthy();
    expect(screen.queryByText('内部维修过程已保存。')).toBeNull();
  });

  it('关闭后重新打开同一 A：旧 reload 成功/失败均不得作用于新实例', async () => {
    const reloadDeferred = deferred<{
      ok: false;
      reason: 'load-failed';
      message: string;
    }>();
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: makeDetail(21, [ENTRY_A, ENTRY_B]) })
      .mockReturnValueOnce(reloadDeferred.promise);
    const mutation = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(mutation.promise);

    render(<Harness requestId={21} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(2));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    mutation.resolve(PROCESS_OK);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);

    reloadDeferred.resolve({
      ok: false,
      reason: 'load-failed',
      message: 'A 回读失败-SENTINEL',
    });
    await waitFor(() => expect(screen.queryByText(/A 回读失败-SENTINEL/)).toBeNull());

    expect(screen.queryByText(/共享详情失败/)).toBeNull();
    expect(screen.getByText('编辑维修过程')).toBeTruthy();
  });

  it('切工单且过程 ID 相同：旧工单的 reload 不得写入新工单共享详情', async () => {
    const reloadDeferred = deferred<{ ok: true; detail: EngineerRepairRequestDetail }>();
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: makeDetail(21, [ENTRY_A, ENTRY_B]) })
      .mockReturnValueOnce(reloadDeferred.promise)
      .mockResolvedValueOnce({
        ok: true,
        detail: makeDetail(22, [{ ...ENTRY_A, requestId: 22, operationText: 'B 工单过程' }]),
      });
    const mutation = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(mutation.promise);

    const { rerender } = render(<Harness requestId={21} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(2));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    mutation.resolve(PROCESS_OK);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    rerender(<Harness requestId={22} />);
    await waitFor(() =>
      expect(screen.getByTestId('shared-fingerprint').textContent).toContain('B 工单过程'),
    );

    reloadDeferred.resolve({
      ok: true,
      detail: makeDetail(21, [{ ...ENTRY_A, operationText: 'A-RELOAD-SENTINEL' }]),
    });
    await waitFor(() =>
      expect(screen.getByTestId('shared-fingerprint').textContent).not.toContain(
        'A-RELOAD-SENTINEL',
      ),
    );

    expect(screen.getByTestId('shared-fingerprint').textContent).toContain('B 工单过程');
  });
});

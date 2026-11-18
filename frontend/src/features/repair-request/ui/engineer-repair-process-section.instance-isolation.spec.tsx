// src/features/repair-request/ui/engineer-repair-process-section.instance-isolation.spec.tsx
// @vitest-environment jsdom

/**
 * 编辑实例隔离回归（真实 UI + 真实 workbench hook + 明确标注的 API 替身）：
 * 只 mock 外部 adapter，所有状态机与代次判断都走真实实现。
 * 用可控 Promise 推进 A/B 两次编辑，不使用 sleep。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  EngineerRepairProcessEntry,
  RepairProcessWriteResult,
  StagedRepairProcessFile,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { EngineerRepairProcessSection } from './engineer-repair-process-section';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    uploadRepairProcessFile: vi.fn(),
    createRepairProcessEntry: vi.fn(),
    updateRepairProcessEntry: vi.fn(),
    downloadRepairProcessFile: vi.fn(),
    closeRepairRequest: vi.fn(),
  };
});

const uploadMock = vi.mocked(engineerRepairRequestAdapter.uploadRepairProcessFile);
const createMock = vi.mocked(engineerRepairRequestAdapter.createRepairProcessEntry);
const updateMock = vi.mocked(engineerRepairRequestAdapter.updateRepairProcessEntry);

const STAGED_A: StagedRepairProcessFile = {
  fileId: 'file-a',
  uploadContextId: 'context-a',
  originalFilename: 'a.pdf',
  mimeType: 'application/pdf',
  byteSize: 100,
  checksumSha256: 'sha-a',
};

const ENTRY_A: EngineerRepairProcessEntry = {
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: 21,
  operationText: 'A 的操作',
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
  operationText: 'B 的操作',
  versionNo: 1,
};

const PROCESS_OK: RepairProcessWriteResult = { ok: true, entry: ENTRY_B };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const reload = vi.fn().mockResolvedValue(undefined);

function renderSection() {
  return render(
    <EngineerRepairProcessSection
      canWrite
      processEntries={[ENTRY_A, ENTRY_B]}
      readOnly={false}
      reload={reload}
      requestId={21}
    />,
  );
}

function uploadAFile(container: HTMLElement, filename: string) {
  const input = container.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, {
    target: { files: [new File(['demo'], filename)] },
  });
}

beforeEach(() => {
  uploadMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  reload.mockClear();
  updateMock.mockResolvedValue(PROCESS_OK);
});

describe(`${EngineerRepairProcessSection.name} 编辑实例隔离`, () => {
  it('A 上传完成后切到 B：保存 B 不携带 A 的暂存文件，A 文件不绑定到 B', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_A });
    const { container } = renderSection();

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    uploadAFile(container, 'a.pdf');
    await waitFor(() => expect(screen.getByText('已上传暂存')).toBeTruthy());
    expect(screen.getByText('a.pdf')).toBeTruthy();

    // 切到同一工单的 B：A 的暂存不得带入 B
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
    await waitFor(() => expect(screen.queryByText('已上传暂存')).toBeNull());
    expect(screen.getByText(/未随保存提交/)).toBeTruthy();
    expect(screen.getByText(/服务端暂存文件未被删除/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('记录实际执行的操作…'), {
      target: { value: 'B 的操作内容' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      requestId: 21,
      entryId: '102',
      file: null,
    });
  });

  it('A 保存中切到 B 并输入：A 迟到成功不关闭 B、不清空 B 输入、不刷新当前详情', async () => {
    const saveA = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(saveA.promise);
    renderSection();

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.change(screen.getByPlaceholderText('记录实际执行的操作…'), {
      target: { value: 'A 的输入' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));

    // A 保存未完成时切到 B 并输入
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
    const textarea = screen.getByPlaceholderText('记录实际执行的操作…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'B 的输入' } });

    // A 迟到成功：B 的编辑与输入必须原样保留
    saveA.resolve(PROCESS_OK);
    await waitFor(() => expect(reload).not.toHaveBeenCalled());

    expect(screen.getByText('编辑维修过程')).toBeTruthy();
    expect(textarea.value).toBe('B 的输入');
    expect(screen.queryByText('内部维修过程已保存。')).toBeNull();
  });

  it('A 保存中切到 B：A 迟到失败不覆盖 B 的输入、loading 或错误提示', async () => {
    const saveA = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(saveA.promise);
    renderSection();

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.change(screen.getByPlaceholderText('记录实际执行的操作…'), {
      target: { value: 'A 的输入' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);
    const textarea = screen.getByPlaceholderText('记录实际执行的操作…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'B 的输入仍需保留' } });

    saveA.resolve({
      ok: false,
      reason: 'conflict',
      message: 'A 的版本冲突',
    });
    await waitFor(() => expect(screen.queryByText('A 的版本冲突')).toBeNull());

    expect(textarea.value).toBe('B 的输入仍需保留');
    expect(screen.getByRole('button', { name: /保存修改/ })).toBeTruthy();
  });
});

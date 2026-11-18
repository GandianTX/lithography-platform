// src/features/repair-request/application/use-engineer-repair-process-workbench.spec.ts

/**
 * 内部维修过程编排单测：走真实 hook，只 mock 外部 adapter。
 * 覆盖暂存 → 保存 → 回读、编辑 expectedVersion、结单回读三条主链。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CloseRepairRequestResult,
  EngineerRepairProcessEntry,
  EngineerRepairRequestDetail,
  RepairProcessWriteResult,
  StagedRepairProcessFile,
  UploadRepairProcessFileResult,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { useEngineerRepairProcessWorkbench } from './use-engineer-repair-process-workbench';
import type { EngineerRepairRequestDetailLoadOutcome } from './use-engineer-repair-request-detail';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    uploadRepairProcessFile: vi.fn(),
    createRepairProcessEntry: vi.fn(),
    updateRepairProcessEntry: vi.fn(),
    closeRepairRequest: vi.fn(),
  };
});

const uploadMock = vi.mocked(engineerRepairRequestAdapter.uploadRepairProcessFile);
const createMock = vi.mocked(engineerRepairRequestAdapter.createRepairProcessEntry);
const updateMock = vi.mocked(engineerRepairRequestAdapter.updateRepairProcessEntry);
const closeMock = vi.mocked(engineerRepairRequestAdapter.closeRepairRequest);

const STAGED_FILE: StagedRepairProcessFile = {
  fileId: 'file-1',
  uploadContextId: 'context-1',
  originalFilename: 'report.pdf',
  mimeType: 'application/pdf',
  byteSize: 128,
  checksumSha256: 'abc123',
};

const ENTRY: EngineerRepairProcessEntry = {
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: 21,
  operationText: '更换干涉仪镜片',
  testResult: null,
  occurredAt: null,
  timeSource: 'SERVER',
  fileId: 'file-1',
  file: null,
  versionNo: 2,
  createdAt: '2026-11-14T03:00:00.000Z',
};

const ENTRY_WITHOUT_FILE: EngineerRepairProcessEntry = {
  ...ENTRY,
  id: '102',
  entryUuid: '5f0c5f6a-2222-4222-8222-222222222222',
  fileId: null,
  file: null,
  versionNo: 1,
};

const PROCESS_OK: RepairProcessWriteResult = { ok: true, entry: ENTRY };

const CLOSE_OK: CloseRepairRequestResult = {
  ok: true,
  closure: {
    requestId: 21,
    closureStatus: 'CLOSED',
    closedAt: '2026-11-14T04:00:00.000Z',
    closureReason: null,
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    handlingEndedAt: '2026-11-14T03:30:00.000Z',
  },
};

beforeEach(() => {
  uploadMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  closeMock.mockReset();
});

describe(useEngineerRepairProcessWorkbench.name, () => {
  it('上传只产生暂存；保存把暂存原件带入创建入参，成功后清空暂存并回读详情', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    createMock.mockResolvedValue(PROCESS_OK);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'report.pdf'));
    });
    expect(result.current.stagedFile).toEqual(STAGED_FILE);
    // 暂存阶段不触发业务回读
    expect(reload).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.saveProcess(
        { operationText: '更换干涉仪镜片', testResult: null, occurredAt: null },
        null,
      );
    });

    expect(createMock).toHaveBeenCalledWith({
      requestId: 21,
      operationText: '更换干涉仪镜片',
      testResult: null,
      occurredAt: null,
      file: { fileId: 'file-1', uploadContextId: 'context-1' },
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.stagedFile).toBeNull();
    expect(result.current.lastProcessResult).toEqual(PROCESS_OK);
  });

  it('编辑已有原件提交 entryId 与 expectedVersion，不携带暂存原件', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    updateMock.mockResolvedValue(PROCESS_OK);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'report.pdf'));
    });
    await act(async () => {
      await result.current.saveProcess(
        { operationText: '复核镜片', testResult: '精度合格', occurredAt: null },
        ENTRY,
      );
    });

    expect(updateMock).toHaveBeenCalledWith({
      requestId: 21,
      entryId: '101',
      expectedVersion: 2,
      operationText: '复核镜片',
      testResult: '精度合格',
      occurredAt: null,
      file: null,
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('结单成功后清空暂存并回读详情', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    closeMock.mockResolvedValue(CLOSE_OK);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'report.pdf'));
    });
    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });

    expect(closeMock).toHaveBeenCalledWith({
      requestId: 21,
      handlingResult: 'FIXED',
      closureReason: null,
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.stagedFile).toBeNull();
    expect(result.current.lastCloseResult).toEqual(CLOSE_OK);
  });

  it('上传失败清空暂存且不保留旧文件', async () => {
    uploadMock.mockResolvedValueOnce({ ok: true, file: STAGED_FILE }).mockResolvedValueOnce({
      ok: false,
      reason: 'file-too-large',
      message: '原件超过大小限制',
    } satisfies UploadRepairProcessFileResult);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'a.pdf'));
    });
    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'big.bin'));
    });

    expect(result.current.stagedFile).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('编辑无原件过程时把暂存原件带入更新入参，成功后清空暂存并回读', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    updateMock.mockResolvedValue({ ok: true, entry: ENTRY_WITHOUT_FILE });
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'report.pdf'));
    });
    await act(async () => {
      await result.current.saveProcess(
        { operationText: '补记录并附图', testResult: null, occurredAt: null },
        ENTRY_WITHOUT_FILE,
      );
    });

    expect(updateMock).toHaveBeenCalledWith({
      requestId: 21,
      entryId: '102',
      expectedVersion: 1,
      operationText: '补记录并附图',
      testResult: null,
      occurredAt: null,
      file: { fileId: 'file-1', uploadContextId: 'context-1' },
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.stagedFile).toBeNull();
  });

  it('编辑已有原件过程时不携带原件且保留暂存，避免静默丢弃', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    updateMock.mockResolvedValue(PROCESS_OK);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'report.pdf'));
    });
    await act(async () => {
      await result.current.saveProcess(
        { operationText: '复核镜片', testResult: null, occurredAt: null },
        ENTRY,
      );
    });

    expect(updateMock).toHaveBeenCalledWith({
      requestId: 21,
      entryId: '101',
      expectedVersion: 2,
      operationText: '复核镜片',
      testResult: null,
      occurredAt: null,
      file: null,
    });
    // 已有原件不可被暂存文件替换；暂存保留给用户另行新建过程
    expect(result.current.stagedFile).toEqual(STAGED_FILE);
  });

  it('编辑版本冲突时保留暂存原件且不触发回读，等待用户重试', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    const conflict: RepairProcessWriteResult = {
      ok: false,
      reason: 'conflict',
      message: '维修过程已被修改，请刷新后重试',
    };
    updateMock.mockResolvedValue(conflict);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'report.pdf'));
    });
    await act(async () => {
      await result.current.saveProcess(
        { operationText: '补记录并附图', testResult: null, occurredAt: null },
        ENTRY_WITHOUT_FILE,
      );
    });

    expect(result.current.lastProcessResult).toEqual(conflict);
    expect(result.current.stagedFile).toEqual(STAGED_FILE);
    expect(reload).not.toHaveBeenCalled();
  });

  it('切换编辑上下文后迟到的上传响应被丢弃，不污染当前编辑', async () => {
    let resolveUpload!: (value: UploadRepairProcessFileResult) => void;
    uploadMock.mockImplementation(
      () =>
        new Promise<UploadRepairProcessFileResult>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    let pending: Promise<UploadRepairProcessFileResult | null> | null = null;
    act(() => {
      pending = result.current.uploadFile(new File(['demo'], 'report.pdf'));
    });
    act(() => {
      result.current.beginEditScope('102');
    });
    await act(async () => {
      resolveUpload({ ok: true, file: STAGED_FILE });
      await pending;
    });

    expect(result.current.stagedFile).toBeNull();
  });

  it('A 上传完成后切到 B，保存 B 不携带 A 的 fileId/uploadContextId', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    updateMock.mockResolvedValue({ ok: true, entry: ENTRY_WITHOUT_FILE });
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'a.pdf'));
    });
    expect(result.current.stagedFile).toEqual(STAGED_FILE);

    act(() => {
      result.current.beginEditScope('102');
    });
    expect(result.current.stagedFile).toBeNull();
    expect(result.current.stagedDiscardNotice).toContain('未随保存提交');
    expect(result.current.stagedDiscardNotice).toContain('未被删除');

    await act(async () => {
      await result.current.saveProcess(
        { operationText: 'B 的操作', testResult: null, occurredAt: null },
        ENTRY_WITHOUT_FILE,
      );
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0][0];
    expect(payload.entryId).toBe('102');
    expect(payload.file).toBeNull();
  });

  it('A 上传中切到 B：A 迟到成功不写 B 暂存、loading 或完成状态', async () => {
    const uploadA = deferred<UploadRepairProcessFileResult>();
    const uploadB = deferred<UploadRepairProcessFileResult>();
    uploadMock.mockReturnValueOnce(uploadA.promise).mockReturnValueOnce(uploadB.promise);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    let pendingA: Promise<UploadRepairProcessFileResult | null> | null = null;
    act(() => {
      pendingA = result.current.uploadFile(new File(['demo'], 'a.pdf'));
    });
    act(() => {
      result.current.beginEditScope('102');
    });
    let pendingB: Promise<UploadRepairProcessFileResult | null> | null = null;
    act(() => {
      pendingB = result.current.uploadFile(new File(['demo'], 'b.pdf'));
    });
    expect(result.current.uploading).toBe(true);

    await act(async () => {
      uploadA.resolve({ ok: true, file: STAGED_FILE });
      await pendingA;
    });

    // A 的迟到成功不能替换 B 的暂存，也不能提前结束 B 的上传 loading
    expect(result.current.stagedFile).toBeNull();
    expect(result.current.uploading).toBe(true);

    await act(async () => {
      uploadB.resolve({
        ok: true,
        file: { ...STAGED_FILE, fileId: 'file-b', uploadContextId: 'context-b' },
      });
      await pendingB;
    });
    expect(result.current.stagedFile).toEqual({
      ...STAGED_FILE,
      fileId: 'file-b',
      uploadContextId: 'context-b',
    });
    expect(result.current.uploading).toBe(false);
  });

  it('A 上传中切到 B：A 迟到失败不写 B 暂存、loading 或错误状态', async () => {
    const uploadA = deferred<UploadRepairProcessFileResult>();
    const uploadB = deferred<UploadRepairProcessFileResult>();
    uploadMock.mockReturnValueOnce(uploadA.promise).mockReturnValueOnce(uploadB.promise);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    let pendingA: Promise<UploadRepairProcessFileResult | null> | null = null;
    act(() => {
      pendingA = result.current.uploadFile(new File(['demo'], 'a.pdf'));
    });
    act(() => {
      result.current.beginEditScope('102');
    });
    let pendingB: Promise<UploadRepairProcessFileResult | null> | null = null;
    act(() => {
      pendingB = result.current.uploadFile(new File(['demo'], 'b.pdf'));
    });

    let staleResult: UploadRepairProcessFileResult | null = null;
    await act(async () => {
      uploadA.resolve({ ok: false, reason: 'file-too-large', message: 'A 上传失败' });
      staleResult = await pendingA;
    });

    expect(staleResult).toBeNull();
    expect(result.current.stagedFile).toBeNull();
    expect(result.current.uploading).toBe(true);

    await act(async () => {
      uploadB.resolve({ ok: false, reason: 'file-too-large', message: 'B 上传失败' });
      await pendingB;
    });
    expect(result.current.uploading).toBe(false);
  });

  it('A 保存中切到 B 并输入：A 迟到成功不关闭/刷新 B，也不清空 B 暂存与结果', async () => {
    const saveA = deferred<RepairProcessWriteResult>();
    const saveB = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(saveA.promise).mockReturnValueOnce(saveB.promise);
    uploadMock.mockResolvedValue({
      ok: true,
      file: { ...STAGED_FILE, fileId: 'file-b', uploadContextId: 'context-b' },
    });
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    let pendingA: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pendingA = result.current.saveProcess(
        { operationText: 'A 的操作', testResult: null, occurredAt: null },
        ENTRY,
      );
    });

    act(() => {
      result.current.beginEditScope('102');
    });
    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'b.pdf'));
    });
    let pendingB: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pendingB = result.current.saveProcess(
        { operationText: 'B 的操作', testResult: null, occurredAt: null },
        ENTRY_WITHOUT_FILE,
      );
    });

    await act(async () => {
      saveA.resolve(PROCESS_OK);
      await pendingA;
    });

    // A 的服务端成功不被前端取消，但旧响应不得刷新/关闭当前 B 编辑
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.lastProcessResult).toBeNull();
    expect(result.current.saving).toBe(true);
    expect(result.current.stagedFile).toEqual({
      ...STAGED_FILE,
      fileId: 'file-b',
      uploadContextId: 'context-b',
    });

    await act(async () => {
      saveB.resolve(PROCESS_OK);
      await pendingB;
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.lastProcessResult).toEqual(PROCESS_OK);
    expect(result.current.saving).toBe(false);
    expect(result.current.stagedFile).toBeNull();
  });

  it('A 保存中切到 B：A 迟到失败不覆盖 B 的错误、输入、loading 或编辑状态', async () => {
    const saveA = deferred<RepairProcessWriteResult>();
    const saveB = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(saveA.promise).mockReturnValueOnce(saveB.promise);
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    let pendingA: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pendingA = result.current.saveProcess(
        { operationText: 'A 的操作', testResult: null, occurredAt: null },
        ENTRY,
      );
    });

    act(() => {
      result.current.beginEditScope('102');
    });
    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'b.pdf'));
    });
    let pendingB: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pendingB = result.current.saveProcess(
        { operationText: 'B 的操作', testResult: null, occurredAt: null },
        ENTRY_WITHOUT_FILE,
      );
    });

    await act(async () => {
      saveA.resolve({
        ok: false,
        reason: 'conflict',
        message: 'A 的版本冲突',
      });
      await pendingA;
    });

    expect(result.current.lastProcessResult).toBeNull();
    expect(result.current.saving).toBe(true);
    expect(result.current.stagedFile).toEqual(STAGED_FILE);

    await act(async () => {
      saveB.resolve({ ok: false, reason: 'conflict', message: 'B 的版本冲突' });
      await pendingB;
    });
    expect(result.current.lastProcessResult).toEqual({
      ok: false,
      reason: 'conflict',
      message: 'B 的版本冲突',
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.stagedFile).toEqual(STAGED_FILE);
  });

  it('关闭编辑时旧暂存不带入新过程，并明确提示服务端暂存未删除', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'a.pdf'));
    });
    expect(result.current.stagedFile).toEqual(STAGED_FILE);

    // 取消编辑回到新增过程：旧暂存不得带入
    act(() => {
      result.current.beginEditScope('new');
    });

    expect(result.current.stagedFile).toBeNull();
    expect(result.current.stagedDiscardNotice).toContain('未被删除');
  });

  it('保存未完成时切换：提示只能说明本地引用未带入且上一请求结果待确认（迟到成功）', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    const saveA = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(saveA.promise);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'a.pdf'));
    });
    let pending: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pending = result.current.saveProcess(
        { operationText: 'A 的操作', testResult: null, occurredAt: null },
        ENTRY_WITHOUT_FILE,
      );
    });

    act(() => {
      result.current.beginEditScope('103');
    });
    expect(result.current.stagedDiscardNotice).toContain('结果尚待确认');
    expect(result.current.stagedDiscardNotice).toContain('本地引用未带入');
    expect(result.current.stagedDiscardNotice).not.toContain('未绑定');
    expect(result.current.stagedDiscardNotice).not.toContain('已取消');
    expect(result.current.stagedDiscardNotice).not.toContain('已回滚');

    await act(async () => {
      saveA.resolve(PROCESS_OK);
      await pending;
    });

    expect(result.current.lastProcessResult).toBeNull();
    expect(result.current.stagedFile).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('保存未完成时切换：提示只说明结果待确认（迟到失败也不改口为未绑定/已回滚）', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED_FILE });
    const saveA = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(saveA.promise);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'a.pdf'));
    });
    let pending: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pending = result.current.saveProcess(
        { operationText: 'A 的操作', testResult: null, occurredAt: null },
        ENTRY_WITHOUT_FILE,
      );
    });

    act(() => {
      result.current.beginEditScope('103');
    });
    const noticeBefore = result.current.stagedDiscardNotice;

    await act(async () => {
      saveA.resolve({ ok: false, reason: 'conflict', message: 'A 的版本冲突' });
      await pending;
    });

    expect(result.current.stagedDiscardNotice).toBe(noticeBefore);
    expect(result.current.stagedDiscardNotice).toContain('结果尚待确认');
    expect(result.current.stagedDiscardNotice).not.toContain('未绑定');
    expect(result.current.stagedDiscardNotice).not.toContain('已取消');
    expect(result.current.stagedDiscardNotice).not.toContain('已回滚');
    expect(result.current.lastProcessResult).toBeNull();
    expect(result.current.stagedFile).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('A→B→A 重新打开同一过程：旧实例的迟到上传不得写入新实例', async () => {
    const uploadA = deferred<UploadRepairProcessFileResult>();
    uploadMock.mockReturnValueOnce(uploadA.promise);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    let pendingA: Promise<UploadRepairProcessFileResult | null> | null = null;
    act(() => {
      pendingA = result.current.uploadFile(new File(['demo'], 'a.pdf'));
    });
    act(() => {
      result.current.beginEditScope('102');
    });
    act(() => {
      result.current.beginEditScope('101');
    });

    await act(async () => {
      uploadA.resolve({ ok: true, file: STAGED_FILE });
      await pendingA;
    });

    // 过程 ID 相同，但实例代次已变，旧响应不得被误认为当前实例
    expect(result.current.stagedFile).toBeNull();
  });

  it('关闭后重新打开同一 A：旧保存响应不得写入新实例', async () => {
    const saveA = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(saveA.promise);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    let pending: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pending = result.current.saveProcess(
        { operationText: 'A 的操作', testResult: null, occurredAt: null },
        ENTRY,
      );
    });
    act(() => {
      result.current.beginEditScope('new');
    });
    act(() => {
      result.current.beginEditScope('101');
    });

    await act(async () => {
      saveA.resolve(PROCESS_OK);
      await pending;
    });

    expect(reload).not.toHaveBeenCalled();
    expect(result.current.lastProcessResult).toBeNull();
  });

  it('切换工单但过程 ID 相同：旧工单的迟到保存不得写入当前工单', async () => {
    const saveA = deferred<RepairProcessWriteResult>();
    updateMock.mockReturnValueOnce(saveA.promise);
    const reload = vi.fn().mockResolvedValue(undefined);

    const { result, rerender } = renderHook(
      ({ requestId }: { requestId: number }) =>
        useEngineerRepairProcessWorkbench(requestId, reload),
      { initialProps: { requestId: 21 } },
    );

    act(() => {
      result.current.beginEditScope('101');
    });
    let pending: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pending = result.current.saveProcess(
        { operationText: '工单 21 的操作', testResult: null, occurredAt: null },
        ENTRY,
      );
    });

    rerender({ requestId: 22 });

    await act(async () => {
      saveA.resolve(PROCESS_OK);
      await pending;
    });

    expect(reload).not.toHaveBeenCalled();
    expect(result.current.lastProcessResult).toBeNull();
  });
});

describe('写后回读失败的反馈与屏障', () => {
  const READBACK_FAILED: EngineerRepairRequestDetailLoadOutcome = {
    ok: false,
    reason: null,
    message: '网络连接异常，请稍后重试。',
  };
  const ENDED_DETAIL: EngineerRepairRequestDetail = {
    id: 21,
    requestNo: 'RR-20261116-001',
    errorCode: 'E-0001',
    faultDescription: '光刻机对准模块异常。',
    contentMd: '',
    createdAt: '2026-11-16T01:00:00.000Z',
    isAccepted: true,
    acceptedAt: '2026-11-16T02:00:00.000Z',
    latestResolutionStatus: null,
    equipmentModel: { id: 1, modelCode: 'LITHO-100', modelName: '样例光刻机' },
    customerNickname: '林客户',
    customerCompanyName: '林氏精密制造',
    acceptanceViewStatus: 'MINE',
    acceptedEngineerNickname: '陈工',
    closureStatus: 'CLOSED',
    closedAt: '2026-11-16T04:00:00.000Z',
    closureReason: null,
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    processEntries: [],
    responses: [],
  };
  const UNENDED_DETAIL: EngineerRepairRequestDetail = {
    ...ENDED_DETAIL,
    closureStatus: null,
    closedAt: null,
    handlingResult: null,
    handlingStatus: 'IN_PROGRESS',
  };
  const READBACK_OK: EngineerRepairRequestDetailLoadOutcome = {
    ok: true,
    detail: ENDED_DETAIL,
  };
  const READBACK_UNENDED: EngineerRepairRequestDetailLoadOutcome = {
    ok: true,
    detail: UNENDED_DETAIL,
  };

  /** 模拟详情 hook 真正采用回读结果时的 onApplied 通知 */
  function reloadApplying(outcome: EngineerRepairRequestDetailLoadOutcome) {
    return vi
      .fn()
      .mockImplementation(async (options?: { onApplied?: (detail: unknown) => void }) => {
        if (outcome.ok) {
          options?.onApplied?.(outcome.detail);
        }
        return outcome;
      });
  }

  it('结单成功但回读失败：结单结果保持成功，建立只读屏障后再回读并标记刷新失败', async () => {
    closeMock.mockResolvedValue(CLOSE_OK);
    const readback = deferred<EngineerRepairRequestDetailLoadOutcome>();
    const reload = vi.fn().mockReturnValue(readback.promise);
    const onCloseSucceeded = vi.fn();
    const onCloseReadbackSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, {
        onCloseSucceeded,
        onCloseReadbackSucceeded,
      }),
    );

    let pending: Promise<CloseRepairRequestResult | null> | null = null;
    act(() => {
      pending = result.current.closeRequest('FIXED', null);
    });

    // mutation 成功即通知页面进入只读，此时回读仍未返回
    await waitFor(() => expect(onCloseSucceeded).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.lastCloseResult).toEqual(CLOSE_OK);
    expect(result.current.closeReadbackFailed).toBe(false);

    await act(async () => {
      readback.resolve(READBACK_FAILED);
      await pending;
    });

    expect(result.current.lastCloseResult).toEqual(CLOSE_OK);
    expect(result.current.closeReadbackFailed).toBe(true);
    expect(onCloseReadbackSucceeded).not.toHaveBeenCalled();
  });

  it('结单 mutation 失败：不建立只读屏障，不发起回读，保留原有失败反馈', async () => {
    const failed: CloseRepairRequestResult = {
      ok: false,
      reason: 'close-failed',
      message: '结单失败，请稍后重试。',
    };
    closeMock.mockResolvedValue(failed);
    const reload = vi.fn().mockResolvedValue(READBACK_OK);
    const onCloseSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { onCloseSucceeded }),
    );

    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });

    expect(result.current.lastCloseResult).toEqual(failed);
    expect(result.current.closeReadbackFailed).toBe(false);
    expect(onCloseSucceeded).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('结单回读重试成功：清除刷新失败标记并通知页面由服务端事实接管', async () => {
    closeMock.mockResolvedValue(CLOSE_OK);
    const reload = vi
      .fn()
      .mockResolvedValueOnce(READBACK_FAILED)
      .mockImplementationOnce(async (options?: { onApplied?: (detail: unknown) => void }) => {
        options?.onApplied?.(ENDED_DETAIL);
        return READBACK_OK;
      });
    const onCloseReadbackSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { onCloseReadbackSucceeded }),
    );

    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });
    expect(result.current.closeReadbackFailed).toBe(true);

    await act(async () => {
      await result.current.retryCloseReadback();
    });

    expect(result.current.closeReadbackFailed).toBe(false);
    expect(onCloseReadbackSucceeded).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('结单回读成功但详情仍未结束：不通知页面接管，并标记详情尚未确认', async () => {
    closeMock.mockResolvedValue(CLOSE_OK);
    const reload = reloadApplying(READBACK_UNENDED);
    const onCloseReadbackSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { onCloseReadbackSucceeded }),
    );

    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });

    expect(result.current.lastCloseResult).toEqual(CLOSE_OK);
    expect(result.current.closeReadbackFailed).toBe(true);
    expect(onCloseReadbackSucceeded).not.toHaveBeenCalled();
  });

  it('结单回读返回已结束但未被共享详情采用：不通知页面接管', async () => {
    closeMock.mockResolvedValue(CLOSE_OK);
    // 仅请求成功，但没有 onApplied（被其他请求/实例守卫丢弃）
    const reload = vi.fn().mockResolvedValue(READBACK_OK);
    const onCloseReadbackSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { onCloseReadbackSucceeded }),
    );

    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });

    expect(result.current.closeReadbackFailed).toBe(true);
    expect(onCloseReadbackSucceeded).not.toHaveBeenCalled();
  });

  it('结单回读返回并实际采用已结束详情：通知页面由服务端状态接管', async () => {
    closeMock.mockResolvedValue(CLOSE_OK);
    const reload = reloadApplying(READBACK_OK);
    const onCloseReadbackSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { onCloseReadbackSucceeded }),
    );

    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });

    expect(result.current.closeReadbackFailed).toBe(false);
    expect(onCloseReadbackSucceeded).toHaveBeenCalledTimes(1);
  });

  it('结单回读期间实例失效：迟到的已结束结果不通知页面接管', async () => {
    closeMock.mockResolvedValue(CLOSE_OK);
    const gate = deferred<void>();
    const reload = vi
      .fn()
      .mockImplementation(async (options?: { onApplied?: (detail: unknown) => void }) => {
        await gate.promise;
        options?.onApplied?.(ENDED_DETAIL);
        return READBACK_OK;
      });
    const onCloseReadbackSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { onCloseReadbackSucceeded }),
    );

    let pending: Promise<CloseRepairRequestResult | null> | null = null;
    act(() => {
      pending = result.current.closeRequest('FIXED', null);
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.beginEditScope('101');
    });
    await act(async () => {
      gate.resolve(undefined);
      await pending;
    });

    expect(onCloseReadbackSucceeded).not.toHaveBeenCalled();
    expect(result.current.closeReadbackFailed).toBe(false);
  });

  it('结单回读重试返回未结束详情：仍标记未确认且不通知页面接管', async () => {
    closeMock.mockResolvedValue(CLOSE_OK);
    const reload = vi
      .fn()
      .mockResolvedValueOnce(READBACK_FAILED)
      .mockImplementationOnce(async (options?: { onApplied?: (detail: unknown) => void }) => {
        options?.onApplied?.(UNENDED_DETAIL);
        return READBACK_UNENDED;
      });
    const onCloseReadbackSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { onCloseReadbackSucceeded }),
    );

    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });
    expect(result.current.closeReadbackFailed).toBe(true);

    await act(async () => {
      await result.current.retryCloseReadback();
    });

    expect(result.current.closeReadbackFailed).toBe(true);
    expect(onCloseReadbackSucceeded).not.toHaveBeenCalled();
  });

  it('结单回读重试返回已结束但未被采用：仍标记未确认且不通知页面接管', async () => {
    closeMock.mockResolvedValue(CLOSE_OK);
    const reload = vi
      .fn()
      .mockResolvedValueOnce(READBACK_FAILED)
      .mockResolvedValueOnce(READBACK_OK);
    const onCloseReadbackSucceeded = vi.fn();

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { onCloseReadbackSucceeded }),
    );

    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });
    expect(result.current.closeReadbackFailed).toBe(true);

    await act(async () => {
      await result.current.retryCloseReadback();
    });

    expect(result.current.closeReadbackFailed).toBe(true);
    expect(onCloseReadbackSucceeded).not.toHaveBeenCalled();
  });

  it('过程保存成功但回读失败：保留保存成功结果并标记刷新失败', async () => {
    createMock.mockResolvedValue(PROCESS_OK);
    const reload = vi.fn().mockResolvedValue(READBACK_FAILED);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.saveProcess(
        { operationText: '更换干涉仪镜片', testResult: null, occurredAt: null },
        null,
      );
    });

    expect(result.current.lastProcessResult).toEqual(PROCESS_OK);
    expect(result.current.processReadbackFailed).toBe(true);
  });

  it('过程保存回读失败后重试成功：清除刷新失败标记', async () => {
    createMock.mockResolvedValue(PROCESS_OK);
    const reload = vi
      .fn()
      .mockResolvedValueOnce(READBACK_FAILED)
      .mockResolvedValueOnce(READBACK_OK);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    await act(async () => {
      await result.current.saveProcess(
        { operationText: '更换干涉仪镜片', testResult: null, occurredAt: null },
        null,
      );
    });
    expect(result.current.processReadbackFailed).toBe(true);

    await act(async () => {
      await result.current.retryProcessReadback();
    });

    expect(result.current.processReadbackFailed).toBe(false);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('A 保存回读中切到 B：A 的迟到回读失败不标记 B 的刷新失败', async () => {
    updateMock.mockResolvedValue(PROCESS_OK);
    const readback = deferred<EngineerRepairRequestDetailLoadOutcome>();
    const reload = vi.fn().mockReturnValueOnce(readback.promise);

    const { result } = renderHook(() => useEngineerRepairProcessWorkbench(21, reload));

    act(() => {
      result.current.beginEditScope('101');
    });
    let pending: Promise<RepairProcessWriteResult | null> | null = null;
    act(() => {
      pending = result.current.saveProcess(
        { operationText: 'A 的操作', testResult: null, occurredAt: null },
        ENTRY,
      );
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.beginEditScope('102');
    });

    await act(async () => {
      readback.resolve(READBACK_FAILED);
      await pending;
    });

    expect(result.current.processReadbackFailed).toBe(false);
  });

  it('结单屏障生效后拒绝过程上传、保存与再次结单', async () => {
    const reload = vi.fn().mockResolvedValue(READBACK_OK);

    const { result } = renderHook(() =>
      useEngineerRepairProcessWorkbench(21, reload, { writeBlocked: true }),
    );

    await act(async () => {
      await result.current.uploadFile(new File(['demo'], 'report.pdf'));
    });
    await act(async () => {
      await result.current.saveProcess(
        { operationText: '不应写入', testResult: null, occurredAt: null },
        null,
      );
    });
    await act(async () => {
      await result.current.closeRequest('FIXED', null);
    });

    expect(uploadMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

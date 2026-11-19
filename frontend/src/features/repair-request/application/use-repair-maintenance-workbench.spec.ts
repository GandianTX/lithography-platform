// src/features/repair-request/application/use-repair-maintenance-workbench.spec.ts

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RepairMaintenanceWriteResult,
  StagedRepairProcessFile,
} from '../infrastructure/engineer-repair-request.types';

vi.mock('../infrastructure/engineer-repair-request-adapter', () => ({
  uploadRepairProcessFile: vi.fn(),
  saveRepairRequestMaintenance: vi.fn(),
}));

import {
  saveRepairRequestMaintenance,
  uploadRepairProcessFile,
} from '../infrastructure/engineer-repair-request-adapter';

import { useRepairMaintenanceWorkbench } from './use-repair-maintenance-workbench';

const uploadMock = vi.mocked(uploadRepairProcessFile);
const saveMock = vi.mocked(saveRepairRequestMaintenance);

const STAGED: StagedRepairProcessFile = {
  fileId: '11111111-1111-4111-8111-111111111111',
  uploadContextId: '22222222-2222-4222-8222-222222222222',
  originalFilename: '合成原件.pdf',
  mimeType: 'application/pdf',
  byteSize: 1024,
  checksumSha256: 'a'.repeat(64),
};

const SAVE_OK: RepairMaintenanceWriteResult = {
  ok: true,
  record: {
    maintenanceDate: '2026-11-18',
    engineerName: '李工',
    resetResult: null,
    supplementaryNote: null,
    versionNo: 1,
    attachment: null,
  },
};

const FORM = {
  maintenanceDate: '2026-11-18',
  engineerName: '李工',
  resetResult: null,
  supplementaryNote: null,
  steps: [],
  panels: [],
};

describe('useRepairMaintenanceWorkbench（保存回执与读回）', () => {
  beforeEach(() => {
    uploadMock.mockReset();
    saveMock.mockReset();
  });

  it('首次保存绑定原件成功、随后详情刷新失败：保留成功回执、清除暂存并标记刷新失败', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED });
    saveMock.mockResolvedValue(SAVE_OK);
    const reload = vi.fn().mockRejectedValue(new Error('readback failed'));

    const { result } = renderHook(() => useRepairMaintenanceWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadAttachment(
        new File(['demo'], 'x.pdf', { type: 'application/pdf' }),
      );
    });
    expect(result.current.stagedFile).toEqual(STAGED);

    let saved: RepairMaintenanceWriteResult | null = null;
    await act(async () => {
      saved = await result.current.saveMaintenance(FORM, 0);
    });

    expect(saved).toEqual(SAVE_OK);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 21,
        expectedVersion: 0,
        attachment: {
          fileId: STAGED.fileId,
          uploadContextId: STAGED.uploadContextId,
        },
      }),
    );
    // 保存已成功：暂存文件已消费，不再允许携带旧暂存重复提交
    expect(result.current.stagedFile).toBeNull();
    expect(result.current.lastResult).toEqual(SAVE_OK);
    expect(result.current.readbackFailed).toBe(true);
  });

  it('回读失败后点重试只发详情查询，不重发保存 mutation', async () => {
    uploadMock.mockResolvedValue({ ok: true, file: STAGED });
    saveMock.mockResolvedValue(SAVE_OK);
    const reload = vi
      .fn()
      .mockRejectedValueOnce(new Error('readback failed'))
      .mockImplementationOnce(async (options?: { onApplied?: () => void }) => {
        options?.onApplied?.();
      });

    const { result } = renderHook(() => useRepairMaintenanceWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadAttachment(
        new File(['demo'], 'x.pdf', { type: 'application/pdf' }),
      );
      await result.current.saveMaintenance(FORM, 0);
    });
    expect(result.current.readbackFailed).toBe(true);

    reload.mockClear();
    await act(async () => {
      await result.current.retryReadback();
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(result.current.readbackFailed).toBe(false);
    expect(result.current.lastResult).toEqual(SAVE_OK);
  });

  it('真正的保存失败：保留暂存与输入，不触发读回也不显示「已保存」', async () => {
    const failed: RepairMaintenanceWriteResult = {
      ok: false,
      reason: 'conflict',
      message: '维修记录已被更新或工单已结单，请刷新后重试。',
    };
    uploadMock.mockResolvedValue({ ok: true, file: STAGED });
    saveMock.mockResolvedValue(failed);
    const reload = vi.fn();

    const { result } = renderHook(() => useRepairMaintenanceWorkbench(21, reload));

    await act(async () => {
      await result.current.uploadAttachment(
        new File(['demo'], 'x.pdf', { type: 'application/pdf' }),
      );
      await result.current.saveMaintenance(FORM, 0);
    });

    expect(result.current.lastResult).toEqual(failed);
    expect(result.current.stagedFile).toEqual(STAGED);
    expect(result.current.readbackFailed).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

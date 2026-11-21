// @vitest-environment jsdom
// src/features/maintenance-report/application/use-maintenance-report-editor.spec.ts
//
// 任务 06 编辑会话：打开/切换不建报告，只有显式保存才写库；
// 首次保存创建草稿，后续保存复用同一 reportId 走更新。

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyReportForm } from '../model/report-form';

import { useMaintenanceReportEditor } from './use-maintenance-report-editor';

const createDraftMock = vi.fn();
const updateDraftMock = vi.fn();

vi.mock('../infrastructure/maintenance-report-adapter', () => ({
  createMaintenanceReportDraft: (...args: unknown[]) => createDraftMock(...args),
  updateMaintenanceReportDraft: (...args: unknown[]) => updateDraftMock(...args),
}));

describe('useMaintenanceReportEditor', () => {
  beforeEach(() => {
    createDraftMock.mockReset();
    updateDraftMock.mockReset();
    createDraftMock.mockResolvedValue({
      reportId: 9,
      status: 'DRAFT',
      currentVersionNo: 0,
      updatedAt: '2026-10-03T00:00:00.000Z',
    });
    updateDraftMock.mockResolvedValue({
      reportId: 9,
      status: 'DRAFT',
      currentVersionNo: 0,
      updatedAt: '2026-10-03T00:00:00.000Z',
    });
  });

  const setup = () =>
    renderHook(() =>
      useMaintenanceReportEditor({
        fallbackSaveError: 'save failed',
        fallbackSubmitError: 'submit failed',
        initialForm: createEmptyReportForm('李工'),
        repairRequestId: null,
        reportId: null,
        sourceType: 'HISTORICAL_CASE',
      }),
    );

  it('打开报告不会自动创建草稿，初始为未修改状态', () => {
    const { result } = setup();

    expect(createDraftMock).not.toHaveBeenCalled();
    expect(updateDraftMock).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(false);
  });

  it('首次保存创建草稿，之后保存复用同一 reportId 走更新', async () => {
    const { result } = setup();

    act(() => {
      result.current.setForm({
        ...result.current.form,
        equipmentModelText: '手填型号',
      });
    });
    expect(result.current.dirty).toBe(true);

    let outcome: Awaited<ReturnType<typeof result.current.saveDraft>> | undefined;
    await act(async () => {
      outcome = await result.current.saveDraft();
    });

    expect(outcome).toEqual({ kind: 'saved', reportId: 9, created: true });
    expect(createDraftMock).toHaveBeenCalledTimes(1);
    expect(createDraftMock.mock.calls[0][0]).toMatchObject({
      sourceType: 'HISTORICAL_CASE',
      repairRequestId: null,
    });
    expect(result.current.dirty).toBe(false);
    expect(result.current.reportId).toBe(9);

    await act(async () => {
      outcome = await result.current.saveDraft();
    });

    expect(updateDraftMock).toHaveBeenCalledTimes(1);
    expect(updateDraftMock.mock.calls[0][0]).toMatchObject({ reportId: 9 });
    expect(createDraftMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: 'saved', created: false });
  });

  it('校验阻塞时不发任何写请求', async () => {
    const { result } = setup();

    act(() => {
      result.current.setForm({ ...result.current.form, handlingResult: 'INTERRUPTED' });
    });

    let outcome: Awaited<ReturnType<typeof result.current.saveDraft>> | undefined;
    await act(async () => {
      outcome = await result.current.saveDraft();
    });

    expect(outcome).toMatchObject({ kind: 'blocked' });
    expect(createDraftMock).not.toHaveBeenCalled();
    expect(updateDraftMock).not.toHaveBeenCalled();
  });

  it('保存失败时透传可读错误且保留脏状态', async () => {
    createDraftMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = setup();

    act(() => {
      result.current.setForm({ ...result.current.form, customerFactoryName: '某封测厂' });
    });

    let outcome: Awaited<ReturnType<typeof result.current.saveDraft>> | undefined;
    await act(async () => {
      outcome = await result.current.saveDraft();
    });

    expect(outcome).toEqual({ kind: 'failed', message: 'boom' });
    expect(result.current.dirty).toBe(true);
  });

  it('R050-01/R050-02 首存与续填均可携带附件（续填携带即更换，服务端同事务裁决）', async () => {
    const { result } = setup();

    act(() => {
      result.current.setForm({
        ...result.current.form,
        customerFactoryName: '某封测厂',
      });
    });

    const attachment = { fileId: 'file-1', uploadContextId: 'ctx-1' };
    let outcome: Awaited<ReturnType<typeof result.current.saveDraft>> | undefined;
    await act(async () => {
      outcome = await result.current.saveDraft({ attachment });
    });

    expect(outcome).toMatchObject({ kind: 'saved', created: true });
    expect(createDraftMock.mock.calls[0][0]).toMatchObject({ attachment });
    expect(updateDraftMock).not.toHaveBeenCalled();

    const replacement = { fileId: 'file-2', uploadContextId: 'ctx-2' };
    await act(async () => {
      outcome = await result.current.saveDraft({ attachment: replacement });
    });
    expect(createDraftMock).toHaveBeenCalledTimes(1);
    expect(updateDraftMock.mock.calls[0][0]).toMatchObject({
      reportId: 9,
      attachment: replacement,
    });

    await act(async () => {
      outcome = await result.current.saveDraft();
    });
    expect(updateDraftMock.mock.calls[1][0]).toMatchObject({ attachment: null });
  });
});

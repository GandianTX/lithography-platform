// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminRepairRequestSummary } from '../infrastructure/admin-document-database.types';
import { appendAdminRepairRequestRevision } from '../infrastructure/admin-document-database-adapter';

import { AdminRepairRequestRevisionModal } from './admin-repair-request-revision-modal';

vi.mock('../infrastructure/admin-document-database-adapter', async (importOriginal) => {
  type Adapter = typeof import('../infrastructure/admin-document-database-adapter');
  const actual = await importOriginal<Adapter>();
  return { ...actual, appendAdminRepairRequestRevision: vi.fn() };
});

const appendMock = vi.mocked(appendAdminRepairRequestRevision);

function buildDetail(): AdminRepairRequestSummary {
  return {
    id: 880001,
    requestNo: 'RR-20260901-001',
    customerNickname: '客户甲',
    companyName: '甲公司',
    equipmentModelId: 930001,
    equipmentModelCode: 'EQ-1',
    equipmentModelName: '型号一',
    errorCode: 'E-001',
    faultDescription: '曝光光路异常',
    contentMd: '# 原始正文',
    isAccepted: true,
    acceptedAt: '2026-09-01T09:00:00.000Z',
    acceptedByEngineerNickname: '工程师甲',
    latestResolutionStatus: 'PENDING',
    createdAt: '2026-09-01T08:00:00.000Z',
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: null,
    currentRevisionNo: 2,
    processEntries: [
      {
        id: '11',
        entryUuid: '11111111-1111-4111-8111-111111111111',
        requestId: 880001,
        operationText: '原始操作',
        testResult: null,
        occurredAt: '2026-09-01T10:00:00.000Z',
        timeSource: 'SERVER',
        fileId: null,
        file: null,
        versionNo: 1,
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    ],
    responses: [],
    revisions: [],
  };
}

describe('AdminRepairRequestRevisionModal', () => {
  beforeEach(() => {
    appendMock.mockReset();
    // antd 静态 message 会挂一个全局 React root 并注册自动关闭计时器，
    // 该计时器会活过本文件的 jsdom 销毁并触发 React 调度回调；测试中改断言调用参数。
    vi.spyOn(message, 'success')
      .mockImplementation(() => undefined as never)
      .mockClear();
    vi.spyOn(message, 'warning')
      .mockImplementation(() => undefined as never)
      .mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('未填修订原因时不发请求', async () => {
    render(
      <AdminRepairRequestRevisionModal
        detail={buildDetail()}
        onClose={vi.fn()}
        onDownloadAttachment={vi.fn().mockResolvedValue({ ok: true })}
        onSaved={vi.fn()}
        open
      />,
    );

    const content = screen.getByDisplayValue('# 原始正文');
    fireEvent.change(content, { target: { value: '# 订正正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));

    expect(await screen.findByText('请填写修订原因。')).toBeInTheDocument();
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('只提交发生变化的字段，并携带工单与过程版本号', async () => {
    appendMock.mockResolvedValue({
      ok: true,
      result: {
        requestId: 880001,
        revisionNo: 3,
        previousVersion: 2,
        currentRevisionNo: 3,
        reason: '订正正文',
        actorNickname: '管理员甲',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
    });
    const onSaved = vi.fn();

    render(
      <AdminRepairRequestRevisionModal
        detail={buildDetail()}
        onClose={vi.fn()}
        onDownloadAttachment={vi.fn().mockResolvedValue({ ok: true })}
        onSaved={onSaved}
        open
      />,
    );

    fireEvent.change(screen.getByDisplayValue('# 原始正文'), {
      target: { value: '# 订正正文' },
    });
    fireEvent.change(screen.getByDisplayValue('原始操作'), {
      target: { value: '订正操作' },
    });
    fireEvent.change(screen.getByPlaceholderText('说明本次修订的原因与依据'), {
      target: { value: '订正已提交事实' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));

    await waitFor(() => expect(appendMock).toHaveBeenCalledTimes(1));
    expect(appendMock).toHaveBeenCalledWith({
      requestId: 880001,
      expectedVersion: 2,
      reason: '订正已提交事实',
      contentMd: '# 订正正文',
      processEntries: [
        { entryId: '11', expectedVersion: 1, operationText: '订正操作', testResult: null },
      ],
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(message.success).toHaveBeenCalledWith('工单修订已保存。');
    expect(message.warning).not.toHaveBeenCalled();
  });

  it('修订已成功但详情刷新失败：同时提示成功与刷新失败，绝不提示保存失败', async () => {
    appendMock.mockResolvedValue({
      ok: true,
      result: {
        requestId: 880001,
        revisionNo: 3,
        previousVersion: 2,
        currentRevisionNo: 3,
        reason: '订正正文',
        actorNickname: '管理员甲',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
    });
    const onSaved = vi.fn().mockResolvedValue(false);

    render(
      <AdminRepairRequestRevisionModal
        detail={buildDetail()}
        onClose={vi.fn()}
        onDownloadAttachment={vi.fn().mockResolvedValue({ ok: true })}
        onSaved={onSaved}
        open
      />,
    );

    fireEvent.change(screen.getByDisplayValue('# 原始正文'), {
      target: { value: '# 订正正文' },
    });
    fireEvent.change(screen.getByPlaceholderText('说明本次修订的原因与依据'), {
      target: { value: '订正已提交事实' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(message.success).toHaveBeenCalledWith('工单修订已保存。');
    await waitFor(() =>
      expect(message.warning).toHaveBeenCalledWith(
        '修订已保存，但详情刷新失败，请刷新页面后查看最新版本。',
      ),
    );
    expect(screen.queryByText('修订保存失败，请稍后重试。')).not.toBeInTheDocument();
    // 不自动重试 mutation：一次操作只提交一次
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('刷新详情抛错时仍按「已保存 + 刷新失败」提示，不误报保存失败', async () => {
    appendMock.mockResolvedValue({
      ok: true,
      result: {
        requestId: 880001,
        revisionNo: 3,
        previousVersion: 2,
        currentRevisionNo: 3,
        reason: '订正正文',
        actorNickname: '管理员甲',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
    });
    const onSaved = vi.fn().mockRejectedValue(new Error('refresh failed'));

    render(
      <AdminRepairRequestRevisionModal
        detail={buildDetail()}
        onClose={vi.fn()}
        onDownloadAttachment={vi.fn().mockResolvedValue({ ok: true })}
        onSaved={onSaved}
        open
      />,
    );

    fireEvent.change(screen.getByDisplayValue('# 原始正文'), {
      target: { value: '# 订正正文' },
    });
    fireEvent.change(screen.getByPlaceholderText('说明本次修订的原因与依据'), {
      target: { value: '订正已提交事实' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));

    await waitFor(() =>
      expect(message.warning).toHaveBeenCalledWith(
        '修订已保存，但详情刷新失败，请刷新页面后查看最新版本。',
      ),
    );
    expect(message.success).toHaveBeenCalledWith('工单修订已保存。');
    expect(screen.queryByText('修订保存失败，请稍后重试。')).not.toBeInTheDocument();
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('版本冲突时保留弹窗、显示服务端消息且不触发 onSaved', async () => {
    appendMock.mockResolvedValue({ ok: false, message: '工单已被其他修订更新，请刷新后重试' });
    const onSaved = vi.fn();

    render(
      <AdminRepairRequestRevisionModal
        detail={buildDetail()}
        onClose={vi.fn()}
        onDownloadAttachment={vi.fn().mockResolvedValue({ ok: true })}
        onSaved={onSaved}
        open
      />,
    );

    fireEvent.change(screen.getByDisplayValue('# 原始正文'), {
      target: { value: '# 订正正文' },
    });
    fireEvent.change(screen.getByPlaceholderText('说明本次修订的原因与依据'), {
      target: { value: '订正已提交事实' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));

    expect(await screen.findByText('工单已被其他修订更新，请刷新后重试')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

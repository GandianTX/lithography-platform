// @vitest-environment jsdom
// src/features/maintenance-report/ui/work-order-summary-list.spec.tsx
//
// 2026-11-21 需求调整：
// - 动作按钮文案改为「核对工单与评价」（草稿行仍为「继续核对」）；
// - 每行新增「来源工单」按钮：跳任务 04 工程师工单详情页，
//   必须使用 repairRequestId（工单 ID）而非 reportId（报告 ID）；
// - 列表数据行为不变：仍调用既有候选查询，不做写请求。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkOrderSummaryCandidatePage } from '../infrastructure/maintenance-report.types';

const navigateMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const { fetchCandidatesMock } = vi.hoisted(() => ({
  fetchCandidatesMock: vi.fn(),
}));

vi.mock('../infrastructure/maintenance-report-adapter', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../infrastructure/maintenance-report-adapter')>();
  return {
    ...actual,
    fetchMyWorkOrderSummaryCandidates: fetchCandidatesMock,
  };
});

import { WORK_ORDER_SUMMARIES_PATH } from './maintenance-report-editor-page';
import { WorkOrderSummaryList } from './work-order-summary-list';

const candidatePage: WorkOrderSummaryCandidatePage = {
  page: 1,
  pageSize: 20,
  total: 2,
  items: [
    {
      // 工单 ID 与报告 ID 故意取不同值：验证跳转使用工单 ID
      repairRequestId: 55,
      requestNo: 'DEV-RR-A-103',
      equipmentModelCode: 'DEV-LITHO-A',
      equipmentModelName: '机型 A',
      closedAt: '2026-11-01T00:00:00.000Z',
      handlingResult: 'FIXED',
      intakeFaultDescription: '定位台回到基准位置时偶发重复告警。',
      reportId: null,
      reportStatus: null,
      reportUpdatedAt: null,
    },
    {
      repairRequestId: 66,
      requestNo: 'DEV-RR-B-103',
      equipmentModelCode: 'DEV-LITHO-B',
      equipmentModelName: '机型 B',
      closedAt: '2026-11-02T00:00:00.000Z',
      handlingResult: null,
      intakeFaultDescription: null,
      reportId: 77,
      reportStatus: 'DRAFT',
      reportUpdatedAt: '2026-11-03T00:00:00.000Z',
    },
  ],
};

describe('WorkOrderSummaryList（2026-11-21 调整）', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    fetchCandidatesMock.mockReset();
    fetchCandidatesMock.mockResolvedValue(candidatePage);
  });

  afterEach(() => {
    cleanup();
  });

  it('未开始行按钮文案为「核对工单与评价」，点击进入该工单的核对页（使用工单 ID）', async () => {
    render(
      <WorkOrderSummaryList
        resolveSourceWorkOrderPath={(id) => `/engineer/repair-requests/${id}`}
      />,
    );
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '核对工单与评价' })).toBeTruthy();
      },
      { timeout: 12000 },
    );

    fireEvent.click(screen.getByRole('button', { name: '核对工单与评价' }));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(`${WORK_ORDER_SUMMARIES_PATH}/55`);
    expect(navigateMock).not.toHaveBeenCalledWith(expect.stringContaining('/77'));
  }, 15000);

  it('草稿行按钮仍为「继续核对」，进入同一工单的核对页续填', async () => {
    render(
      <WorkOrderSummaryList
        resolveSourceWorkOrderPath={(id) => `/engineer/repair-requests/${id}`}
      />,
    );
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '继续核对' })).toBeTruthy();
      },
      { timeout: 12000 },
    );

    fireEvent.click(screen.getByRole('button', { name: '继续核对' }));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(`${WORK_ORDER_SUMMARIES_PATH}/66`);
  }, 15000);

  it('每行「来源工单」按钮携带该行的工单 ID（非报告 ID）跳工单详情', async () => {
    render(
      <WorkOrderSummaryList
        resolveSourceWorkOrderPath={(id) => `/engineer/repair-requests/${id}`}
      />,
    );
    await waitFor(
      () => {
        expect(screen.getAllByRole('button', { name: '来源工单' }).length).toBe(2);
      },
      { timeout: 12000 },
    );

    const sourceButtons = screen.getAllByRole('button', { name: '来源工单' });
    fireEvent.click(sourceButtons[0]);

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/engineer/repair-requests/55');

    fireEvent.click(sourceButtons[1]);

    expect(navigateMock).toHaveBeenCalledTimes(2);
    expect(navigateMock).toHaveBeenLastCalledWith('/engineer/repair-requests/66');
    // 报告 ID 77 不得出现在任何跳转里
    expect(navigateMock).not.toHaveBeenCalledWith(expect.stringContaining('/77'));
  }, 15000);

  it('列表对齐 Demo：显示故障现象列（无 intake 显示占位），不再显示处理结果列', async () => {
    render(
      <WorkOrderSummaryList
        resolveSourceWorkOrderPath={(id) => `/engineer/repair-requests/${id}`}
      />,
    );
    await waitFor(
      () => {
        expect(screen.getByText('定位台回到基准位置时偶发重复告警。')).toBeTruthy();
      },
      { timeout: 12000 },
    );

    // 无 intake 的行故障现象显示占位符，不显示空串
    const cells = screen.getAllByRole('cell');
    expect(cells.some((cell) => cell.textContent === '—')).toBe(true);
    // 处理结果列已移出列表（处理结果仍在只读核对页可见）
    expect(screen.queryByText('故障修复')).toBeNull();
  }, 15000);

  it('列表仍只调用既有候选查询，不发任何写请求', async () => {
    render(
      <WorkOrderSummaryList
        resolveSourceWorkOrderPath={(id) => `/engineer/repair-requests/${id}`}
      />,
    );
    await waitFor(() => {
      expect(fetchCandidatesMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchCandidatesMock).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });
});

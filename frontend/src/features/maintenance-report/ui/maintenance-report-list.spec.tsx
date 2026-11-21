// @vitest-environment jsdom
// src/features/maintenance-report/ui/maintenance-report-list.spec.tsx
//
// 2026-11-21 需求调整回归：历史记录列表保留——入口改为直达新建页后，
// 列表仍可从新建页「我的历史记录」进入；草稿行「继续核对」续填进入
// 既有详情路由 /engineer/maintenance-records/:reportId（URL 兼容不变）。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaintenanceReportPage } from '../infrastructure/maintenance-report.types';

const navigateMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const { fetchReportsMock, exportReportMock } = vi.hoisted(() => ({
  fetchReportsMock: vi.fn(),
  exportReportMock: vi.fn(),
}));

vi.mock('../infrastructure/maintenance-report-adapter', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../infrastructure/maintenance-report-adapter')>();
  return {
    ...actual,
    fetchMyMaintenanceReports: fetchReportsMock,
    exportMaintenanceReport: exportReportMock,
  };
});

import { MAINTENANCE_RECORDS_PATH } from './maintenance-report-editor-page';
import { MaintenanceReportList } from './maintenance-report-list';

const listPage: MaintenanceReportPage = {
  page: 1,
  pageSize: 20,
  total: 1,
  items: [
    {
      id: 321,
      sourceType: 'HISTORICAL_CASE',
      repairRequestId: null,
      status: 'DRAFT',
      title: null,
      currentVersionNo: 0,
      maintenanceDate: null,
      updatedAt: '2026-11-03T00:00:00.000Z',
    },
  ],
};

describe('MaintenanceReportList（2026-11-21 入口调整回归）', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    fetchReportsMock.mockReset();
    exportReportMock.mockReset();
    fetchReportsMock.mockResolvedValue(listPage);
  });

  afterEach(() => {
    cleanup();
  });

  it('草稿行「继续核对」仍进入既有详情路由续填（URL 兼容）', async () => {
    render(<MaintenanceReportList />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '继续核对' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '继续核对' }));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(`${MAINTENANCE_RECORDS_PATH}/321`);
  });

  it('列表保留「新建历史记录」入口，进入新建页', async () => {
    render(<MaintenanceReportList />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建历史记录' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '新建历史记录' }));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(`${MAINTENANCE_RECORDS_PATH}/new`);
  });
});

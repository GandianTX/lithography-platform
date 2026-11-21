// src/pages/admin-operation-records/index.spec.tsx
// @vitest-environment jsdom

/**
 * 关键操作记录页装配层单测（任务 10 S3，V44 页面细则 2026-11-20）。
 *
 * 锁定五件事：
 * - 副标题按管理员等级分档（一级全公司／二级本公司）；
 * - 单张「操作记录」卡片承载全部形态（加载保留卡片结构、卡内错误与重试、卡内空态）；
 * - 权限尚未确认或已失权时不得显示既有账号的数据；
 * - 只读边界：页面除「重试」外没有任何动作按钮；
 * - 分页数据来自后端，不在前端做筛选/排序。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  OperationRecordItem,
  OperationRecordListPage,
} from '@/features/admin-operation-records';

import { AdminOperationRecordsPage } from './index';

const useAuthSessionMock = vi.fn();
const fetchOperationRecordsMock =
  vi.fn<(page: number, pageSize: number) => Promise<OperationRecordListPage>>();

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return {
    ...actual,
    useAuthSession: () => useAuthSessionMock(),
  };
});

vi.mock('@/features/admin-operation-records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/admin-operation-records')>();

  return {
    ...actual,
    fetchOperationRecords: (page: number, pageSize: number) =>
      fetchOperationRecordsMock(page, pageSize),
  };
});

function adminSession(adminLevel: number | null, adminOrganizationId: number | null) {
  return {
    session: {
      accessToken: 'token',
      accountId: 900307,
      adminLevel,
      adminOrganizationId,
      customerOrganizationId: null,
      engineerOrganizationId: null,
      registrationOrganizationId: null,
      restriction: 'NONE',
      role: 'SUPER_ADMIN',
      userInfo: { accessGroup: ['SUPER_ADMIN'], avatarUrl: null, nickname: '管理员' },
    },
    status: 'authenticated',
  } as const;
}

const sampleItem: OperationRecordItem = {
  eventId: 'event-1',
  occurredAt: '2026-11-19T10:00:00.000Z',
  actorAdminLevel: 1,
  actorNickname: '管理员甲',
  organizationId: 2,
  organizationName: '开发联调公司 A',
  operation: 'ADMIN_DELETE_DOCUMENT',
  targetType: 'REFERENCE_DOCUMENT',
  targetId: 'doc-1001',
  result: 'SUCCEEDED',
  detail: null,
};

function renderPage() {
  return render(<AdminOperationRecordsPage />);
}

afterEach(() => {
  cleanup();
  useAuthSessionMock.mockReset();
  fetchOperationRecordsMock.mockReset();
});

describe('AdminOperationRecordsPage（V44 页面细则）', () => {
  it('一级管理员看到全公司副标题与「操作记录」卡片标题', async () => {
    useAuthSessionMock.mockReturnValue(adminSession(1, 910003));
    fetchOperationRecordsMock.mockResolvedValue({
      items: [sampleItem],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    expect(screen.getByText('查看全部公司的关键操作。')).toBeInTheDocument();
    expect(screen.getByText('操作记录')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('doc-1001')).toBeInTheDocument());
  });

  it('二级管理员看到本公司副标题', async () => {
    useAuthSessionMock.mockReturnValue(adminSession(2, 910004));
    fetchOperationRecordsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });

    renderPage();

    expect(screen.getByText('查看本公司的关键操作。')).toBeInTheDocument();
    expect(screen.queryByText('查看全部公司的关键操作。')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('暂无关键操作记录')).toBeInTheDocument());
  });

  it('加载期保留卡片结构，不渲染表格', () => {
    useAuthSessionMock.mockReturnValue(adminSession(1, 910003));
    fetchOperationRecordsMock.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByText('操作记录')).toBeInTheDocument();
    expect(screen.queryByText('暂无关键操作记录')).not.toBeInTheDocument();
  });

  it('零记录显示原型空态文案', async () => {
    useAuthSessionMock.mockReturnValue(adminSession(1, 910003));
    fetchOperationRecordsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });

    renderPage();

    await waitFor(() => expect(screen.getByText('暂无关键操作记录')).toBeInTheDocument());
  });

  it('加载失败在卡内提示并提供只读重试，重试后恢复列表', async () => {
    useAuthSessionMock.mockReturnValue(adminSession(1, 910003));
    fetchOperationRecordsMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        items: [sampleItem],
        total: 1,
        page: 1,
        pageSize: 10,
      });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('关键操作记录加载失败，请稍后重试。')).toBeInTheDocument(),
    );

    // AntD 对两字中文按钮自动插空格，可访问名为「重 试」。
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await waitFor(() => expect(screen.getByText('doc-1001')).toBeInTheDocument());
    expect(fetchOperationRecordsMock).toHaveBeenCalledTimes(2);
  });

  it('失权账号显示无权限提示且不取数，也不显示任何既有记录', async () => {
    useAuthSessionMock.mockReturnValue(adminSession(null, null));
    fetchOperationRecordsMock.mockResolvedValue({
      items: [sampleItem],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    expect(screen.getByText('关键操作记录仅供管理员查看。')).toBeInTheDocument();
    expect(screen.queryByText('doc-1001')).not.toBeInTheDocument();
    expect(fetchOperationRecordsMock).not.toHaveBeenCalled();
  });

  it('无管理范围时不显示一级/二级范围副标题（避免误导无权账号）', async () => {
    useAuthSessionMock.mockReturnValue(adminSession(null, null));
    fetchOperationRecordsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });

    renderPage();

    expect(screen.queryByText('查看全部公司的关键操作。')).not.toBeInTheDocument();
    expect(screen.queryByText('查看本公司的关键操作。')).not.toBeInTheDocument();
  });

  it('同一账号的管理员等级变化（范围变化）触发回第 1 页重新取数', async () => {
    // 二级：公司 A；随后同一账号升为一级且公司不变——数据范围由「本公司」变为「全公司」，
    // 必须重新取数，否则页面会停留在旧范围的记录上。
    useAuthSessionMock.mockReturnValue(adminSession(2, 910004));
    fetchOperationRecordsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });

    const { rerender } = renderPage();
    await waitFor(() => expect(fetchOperationRecordsMock).toHaveBeenCalledTimes(1));

    useAuthSessionMock.mockReturnValue(adminSession(1, 910004));
    rerender(<AdminOperationRecordsPage />);

    await waitFor(() => expect(fetchOperationRecordsMock).toHaveBeenCalledTimes(2));
    expect(fetchOperationRecordsMock).toHaveBeenLastCalledWith(1, 10);
    expect(screen.getByText('查看全部公司的关键操作。')).toBeInTheDocument();
  });

  it('会话尚未就绪时不显示数据（权限未确认）', () => {
    useAuthSessionMock.mockReturnValue({ session: null, status: 'anonymous' });
    fetchOperationRecordsMock.mockResolvedValue({
      items: [sampleItem],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    expect(screen.queryByText('doc-1001')).not.toBeInTheDocument();
    expect(screen.queryByText('关键操作记录仅供管理员查看。')).not.toBeInTheDocument();
    expect(fetchOperationRecordsMock).not.toHaveBeenCalled();
  });

  it('列表态渲染七列并保持只读：除重试外无任何动作按钮', async () => {
    useAuthSessionMock.mockReturnValue(adminSession(1, 910003));
    fetchOperationRecordsMock.mockResolvedValue({
      items: [sampleItem],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('doc-1001')).toBeInTheDocument());

    for (const header of [
      '时间',
      '操作者',
      '所属公司',
      '操作类型',
      '目标',
      '实际结果',
      '必要说明',
    ]) {
      expect(screen.getAllByText(header).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('共 1 条')).toBeInTheDocument();
  });
});

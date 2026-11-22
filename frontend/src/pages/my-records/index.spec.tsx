// src/pages/my-records/index.spec.tsx
// @vitest-environment jsdom

/**
 * 我的资料记录页面装配单测（任务 07，Demo V44 V24MyRecords 布局对齐）。
 *
 * 页头 extra 的「记录历史故障经验」新建入口按角色渲染：仅工程师可见并指向
 * 任务 06 新建页真实路由；管理员与角色未知不渲染（前端隐藏不替代后端写权限）。
 * 列表/统计的行为已在 feature 层 spec 覆盖，这里只 mock adapter 避免真实请求。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyRecordListPage } from '@/features/my-records';

import { MyRecordsPage } from './index';

const navigateMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

let mockRole: string | undefined = 'ENGINEER';

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return {
    ...actual,
    useAuthSession: () => ({ session: mockRole === undefined ? undefined : { role: mockRole } }),
  };
});

vi.mock('@/features/my-records/infrastructure/my-records-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/my-records')>();

  return { ...actual, fetchMyRecords: vi.fn() };
});

const fetchMyRecordsMock = vi.mocked(
  (await import('@/features/my-records/infrastructure/my-records-adapter')).fetchMyRecords,
);

beforeEach(() => {
  fetchMyRecordsMock.mockReset();
  navigateMock.mockReset();
  mockRole = 'ENGINEER';
  fetchMyRecordsMock.mockImplementation((query) =>
    Promise.resolve({
      items: [],
      total: 0,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 10,
    } satisfies MyRecordListPage),
  );
});

describe('MyRecordsPage', () => {
  it('工程师：页头提供「记录历史故障经验」入口并指向任务 06 新建路由', async () => {
    render(<MyRecordsPage />);

    expect(await screen.findByText('暂无资料记录。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '记录历史故障经验' }));
    expect(navigateMock).toHaveBeenCalledWith('/engineer/maintenance-records/new');
  });

  it('管理员：页头不提供新建入口（2026-11-21 口径，前端隐藏不替代后端写权限）', async () => {
    mockRole = 'SUPER_ADMIN';
    render(<MyRecordsPage />);

    await waitFor(() => {
      expect(screen.getByText('暂无资料记录。')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /记录历史故障经验|新建/ })).toBeNull();
  });

  it('角色未知（会话快照未就绪）：不显示新建入口，避免管理员会话闪现入口', async () => {
    mockRole = undefined;
    render(<MyRecordsPage />);

    await waitFor(() => {
      expect(screen.getByText('暂无资料记录。')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: '记录历史故障经验' })).toBeNull();
  });
});

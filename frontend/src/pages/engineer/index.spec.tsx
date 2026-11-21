// src/pages/engineer/index.spec.tsx
// @vitest-environment jsdom

/**
 * 工程师首页装配单测。
 *
 * 工作台数据逻辑由其自身 spec 覆盖；本测试只验证页面装配：
 * - 快捷入口独立成区、只连接真实路由（含「我的接单」以查询参数恢复 MINE 范围）；
 * - AI 故障诊断没有正式路由，不得出现任何入口或占位文案；
 * - 底部工程师信息条：左身份栏 + 右侧真实字段分栏，卡片内只保留「账号设置」入口，
 *   数据全部来自 Auth Session 公开模型，不与快捷入口混排，也不承担退出登录
 *   （由公共侧栏负责）；头像按「有 URL → 图片 / 为空或加载失败 → 昵称首字」回落。
 * - 工作台组件被真实挂载。
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ENGINEER_REPAIR_REQUEST_LIST_PATH } from '@/features/repair-request';

import { EngineerPage } from './index';

const navigateMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

const sessionFixture = {
  accountId: 900101,
  role: 'ENGINEER',
  userInfo: { accessGroup: ['ENGINEER'], avatarUrl: null, nickname: '陈工' },
};

const { useAuthSessionMock, WorkbenchStub } = vi.hoisted(() => ({
  useAuthSessionMock: vi.fn(),
  WorkbenchStub: vi.fn(),
}));

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return {
    ...actual,
    useAuthSession: () => useAuthSessionMock(),
  };
});

vi.mock('@/features/repair-request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/repair-request')>();

  return {
    ...actual,
    // 工作台数据行为由其自身 spec 覆盖，这里以桩验证页面确实挂载了它；
    // Provider 直接透传子节点（真实 Provider 会发起工作台查询，不在本测试范围）；
    // 页头统计胶囊依赖工作台读模型，同样以桩替代。
    EngineerRepairWorkbench: WorkbenchStub,
    EngineerRepairWorkbenchProvider: ({ children }: { children: ReactNode }) => children,
    EngineerWorkbenchHeaderStats: () => null,
  };
});

beforeEach(() => {
  navigateMock.mockReset();
  useAuthSessionMock.mockReset();
  WorkbenchStub.mockReset().mockReturnValue(<div>工作台桩</div>);
  useAuthSessionMock.mockReturnValue({ session: sessionFixture });
});

describe('EngineerPage', () => {
  it('挂载工作台并展示快捷入口四项与个人信息条', () => {
    render(<EngineerPage />);

    expect(screen.getByText('工作台桩')).toBeTruthy();
    expect(screen.getByText('全部维修申请')).toBeTruthy();
    expect(screen.getByText('我的接单')).toBeTruthy();
    expect(screen.getByText('参考资料库')).toBeTruthy();
    expect(screen.getByText('账号设置')).toBeTruthy();
    // 个人信息条来自 session 公开模型：右侧按「标签 + 值」分栏展示
    expect(screen.getByText('陈工')).toBeTruthy();
    expect(screen.getByText('ENGINEER')).toBeTruthy();
    expect(screen.getByText('账号 ID')).toBeTruthy();
    expect(screen.getByText('900101')).toBeTruthy();
  });

  it('快捷入口独立成区，不与底部个人信息条混排', () => {
    render(<EngineerPage />);

    expect(screen.getByText('快捷入口')).toBeTruthy();

    const infoCard = screen.getByText('陈工').closest('section.data-card');
    expect(infoCard).not.toBeNull();
    // 个人信息条内不得出现快捷入口；唯一动作入口是账号设置
    expect(within(infoCard as HTMLElement).queryByText('全部维修申请')).toBeNull();
    expect(within(infoCard as HTMLElement).getAllByRole('button')).toEqual([
      screen.getByRole('button', { name: '账号设置' }),
    ]);
    // 退出登录由公共侧栏承担，页内不重复提供
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull();
  });

  it.each([
    ['全部维修申请', ENGINEER_REPAIR_REQUEST_LIST_PATH],
    ['我的接单', `${ENGINEER_REPAIR_REQUEST_LIST_PATH}?scope=MINE`],
    // 任务 06 两个入口：历史维修记录（2026-11-21 起直达新建页）/ 工单维修总结
    ['历史维修记录', '/engineer/maintenance-records/new'],
    ['工单维修总结', '/engineer/work-order-summaries'],
    ['参考资料库', '/reference-documents'],
    ['账号设置', '/account/settings'],
  ])('点击快捷入口「%s」前往真实路由', (label, path) => {
    render(<EngineerPage />);

    fireEvent.click(screen.getByText(label));

    expect(navigateMock).toHaveBeenCalledWith(path);
  });

  it('不提供 AI 故障诊断入口或任何占位文案', () => {
    render(<EngineerPage />);

    expect(screen.queryByText(/AI 故障诊断/i)).toBeNull();
    expect(screen.queryByText(/AI/i)).toBeNull();
    // 快捷入口卡片恰好六项（任务 06 新增两个真实入口），无额外占位入口
    const quickEntryCard = screen.getByText('快捷入口').closest('section.data-card');
    expect(within(quickEntryCard as HTMLElement).getAllByRole('button')).toHaveLength(6);
  });

  it('会话缺失时资料条优雅降级，不展示角色与账号 ID', () => {
    useAuthSessionMock.mockReturnValue({ session: null });

    render(<EngineerPage />);

    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('ENGINEER')).toBeNull();
    expect(screen.queryByText(/账号 ID/)).toBeNull();
  });

  it('信息条头像：会话有真实 avatarUrl 时渲染图片，沿用公共 40×40 档', () => {
    useAuthSessionMock.mockReturnValue({
      session: {
        ...sessionFixture,
        userInfo: { ...sessionFixture.userInfo, avatarUrl: 'https://example.test/avatar/chen.png' },
      },
    });

    const { container } = render(<EngineerPage />);
    const image = container.querySelector('img');

    expect(image).not.toBeNull();
    expect(image).toHaveAttribute('src', 'https://example.test/avatar/chen.png');
    // 与导航栏头像同一视觉配方，尺寸取工程师信息条的 40×40 档
    expect(image).toHaveClass('user-avatar', 'user-avatar--lg');
  });

  it('信息条头像：avatarUrl 为空（Mock 现状）时回落昵称首字，不使用固定示例头像', () => {
    render(<EngineerPage />);

    const initial = screen.getByText('陈');

    expect(initial).toHaveClass('user-avatar', 'user-avatar--lg');
    expect(initial).toHaveAttribute('aria-hidden', 'true');
  });

  it('信息条头像：图片加载失败时回落昵称首字', () => {
    useAuthSessionMock.mockReturnValue({
      session: {
        ...sessionFixture,
        userInfo: { ...sessionFixture.userInfo, avatarUrl: 'https://example.test/avatar/chen.png' },
      },
    });

    const { container } = render(<EngineerPage />);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();

    fireEvent.error(image as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('陈')).toHaveClass('user-avatar', 'user-avatar--lg');
  });

  it('信息条设置入口位于同一卡片内，点击前往账号设置', () => {
    render(<EngineerPage />);

    const settingsEntry = screen.getByRole('button', { name: '账号设置' });
    expect(settingsEntry.closest('section.data-card')).toBe(
      screen.getByText('陈工').closest('section.data-card'),
    );

    fireEvent.click(settingsEntry);
    expect(navigateMock).toHaveBeenCalledWith('/account/settings');
  });

  it('信息条右侧只展示有正式契约的真实字段，不出现原型虚构字段', () => {
    render(<EngineerPage />);

    expect(screen.getByText('账号 ID')).toBeTruthy();
    expect(screen.getByText('900101')).toBeTruthy();
    // 原型 .engineer-strip 的虚构资料栏不得以角色/所在地/通用标签冒充
    for (const fakeField of ['职位', '权限级别', '服务区域', '专业方向', '高级现场工程师']) {
      expect(screen.queryByText(fakeField)).toBeNull();
    }
  });
});

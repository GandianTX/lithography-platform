// src/pages/local-settings/index.spec.tsx
// @vitest-environment jsdom

/**
 * 本地设置页（/local-settings）页面级单测（任务 09 R064、S4-1 开关写入口）。
 *
 * 页面职责边界：页头 + 组合 feature 公开 UI（LocalRuntimeSettingsPanel），只读；
 * 不发起任何写请求，也不提供公司/设备切换入口。面板内部渲染与数据访问由面板自身
 * spec 覆盖，本文件固定「页面装配 + 只读入口面 + 开关可写性下传」这一层契约。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalSettingsPage } from './index';

const panelProps = vi.hoisted(() => ({ current: { writable: null as boolean | null } }));

vi.mock('@/features/local-runtime', () => ({
  LocalRuntimeSettingsPanel: (props: { writable: boolean }) => {
    panelProps.current.writable = props.writable;
    return <div data-testid="local-runtime-panel" />;
  },
}));

vi.mock('@/features/auth-session', () => ({
  useAuthSession: () => ({ session: null, status: 'anonymous' }),
}));

afterEach(() => {
  cleanup();
  panelProps.current.writable = null;
});

describe('本地设置页：装配与只读入口面', () => {
  it('页头标题与描述齐备，并装配本地运行面板', () => {
    render(<LocalSettingsPage />);

    expect(screen.getByRole('heading', { name: '本地设置' })).toBeTruthy();
    expect(screen.getByTestId('local-runtime-panel')).toBeTruthy();
  });

  it('页面本身不提供写入口：除只读面板外没有可点按钮', () => {
    render(<LocalSettingsPage />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('会话未认证时把开关可写性判为只读并下传给面板', () => {
    render(<LocalSettingsPage />);

    expect(panelProps.current.writable).toBe(false);
  });
});

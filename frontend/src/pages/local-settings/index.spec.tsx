// src/pages/local-settings/index.spec.tsx
// @vitest-environment jsdom

/**
 * 本地设置页（/local-settings）页面级单测（任务 09 R064）。
 *
 * 页面职责边界：页头 + 组合 feature 公开 UI（LocalRuntimeSettingsPanel），只读；
 * 不发起任何写请求，也不提供公司/设备切换入口。面板内部渲染与数据访问由面板自身
 * spec 覆盖，本文件只固定「页面装配 + 只读入口面」这一层契约。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalSettingsPage } from './index';

vi.mock('@/features/local-runtime', () => ({
  LocalRuntimeSettingsPanel: () => <div data-testid="local-runtime-panel" />,
}));

afterEach(() => {
  cleanup();
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
});

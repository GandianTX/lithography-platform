// src/pages/local-backup/index.spec.tsx
// @vitest-environment jsdom

/**
 * 备份与恢复页（/local-backup）页面级单测（任务 09 S3／S4）。
 *
 * 页面职责边界：页头 + 组合 feature 公开 UI（LocalBackupPanel），并按会话角色决定
 * **是否展示**恢复预检入口；公司/设备范围由服务端按 Session 裁决，前端不传公司参数。
 * 面板内部渲染与数据访问由面板自身 spec 覆盖，本文件只固定「页面装配 + 预检入口可见性」
 * 这一层契约；会话与面板均以模块桩替换，避免复制实现细节。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalBackupPage } from './index';

const authSession = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/features/auth-session', () => ({
  useAuthSession: () => authSession.current,
}));

vi.mock('@/features/local-backup', () => ({
  LocalBackupPanel: ({ canPrecheck }: { canPrecheck: boolean }) => (
    <div data-testid="local-backup-panel" data-can-precheck={String(canPrecheck)} />
  ),
}));

const ADMIN_SESSION = {
  status: 'authenticated',
  session: {
    accountId: 900101,
    role: 'SUPER_ADMIN',
    restriction: 'NONE',
    adminLevel: 1,
    adminOrganizationId: 5,
    customerOrganizationId: null,
    engineerOrganizationId: null,
    registrationOrganizationId: null,
    userInfo: null,
  },
};

const ENGINEER_SESSION = {
  status: 'authenticated',
  session: {
    ...ADMIN_SESSION.session,
    accountId: 900102,
    role: 'ENGINEER',
    adminLevel: null,
    adminOrganizationId: null,
  },
};

const ANONYMOUS_SESSION = { status: 'anonymous', session: null };

function panelCanPrecheck(): boolean {
  return screen.getByTestId('local-backup-panel').getAttribute('data-can-precheck') === 'true';
}

afterEach(() => {
  cleanup();
  authSession.current = null;
});

describe('备份与恢复页：装配与预检入口可见性', () => {
  it('页头标题与描述齐备，并装配备份面板', () => {
    authSession.current = ADMIN_SESSION;

    render(<LocalBackupPage />);

    expect(screen.getByRole('heading', { name: '备份与恢复' })).toBeTruthy();
    expect(screen.getByTestId('local-backup-panel')).toBeTruthy();
  });

  it('一级管理员：展示恢复预检入口', () => {
    authSession.current = ADMIN_SESSION;

    render(<LocalBackupPage />);

    expect(panelCanPrecheck()).toBe(true);
  });

  it('工程师：不展示恢复预检入口（服务端一级管理员动作）', () => {
    authSession.current = ENGINEER_SESSION;

    render(<LocalBackupPage />);

    expect(panelCanPrecheck()).toBe(false);
  });

  it('未登录：不展示恢复预检入口', () => {
    authSession.current = ANONYMOUS_SESSION;

    render(<LocalBackupPage />);

    expect(panelCanPrecheck()).toBe(false);
  });
});

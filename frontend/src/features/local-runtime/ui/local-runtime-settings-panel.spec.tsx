// src/features/local-runtime/ui/local-runtime-settings-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 本地设置只读面板 UI 单测（任务 09 R064）。
 *
 * 面板只展示服务端返回的真实事实，不提供编辑/切换公司/立即备份入口。
 * 这里走真实组件与真实 antd 渲染，数据访问层以受控替身注入，锁定四态：
 * 加载态、就绪态（只读事实 + 无写入口）、权限不足态、失败态（可重试）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type { LocalRuntimeStatus } from '../infrastructure/local-runtime.types';

const adapters = vi.hoisted(() => ({
  fetchLocalRuntimeStatus: vi.fn(),
}));

vi.mock('../infrastructure/local-runtime-graphql-adapter', () => adapters);

import { LocalRuntimeSettingsPanel } from './local-runtime-settings-panel';

const STATUS: LocalRuntimeStatus = {
  installationId: 'inst-local-1',
  localSiteName: '苏州客户现场',
  mappedOrganizationId: 4,
  mappedOrganizationCode: 'ORG-004',
  viewerRole: 'ADMIN_LEVEL_1',
  scopeOrganizationId: null,
  service: {
    apiStatus: 'UP',
    databaseStatus: 'UP',
    taskFactSource: 'DATABASE',
    taskRecovery: 'RESTORE_FROM_BACKUP',
  },
  storage: {
    businessFileDirectory: '/data/business-files',
    businessFileDirectoryWritable: true,
    backupDirectory: '/data/backup-packages',
    backupDirectoryWritable: false,
  },
  tasks: {
    pendingUploadCount: 1,
    uploadingUploadCount: 2,
    failedUploadCount: 3,
    succeededUploadCount: 4,
    runningBackupCount: 5,
    lastBackupStartedAt: '2026-11-22T01:00:00.000Z',
    lastBackupFinishedAt: '2026-11-22T01:05:00.000Z',
  },
  companies: [
    {
      organizationId: 4,
      backupEnabled: true,
      backupIntervalHours: 72,
      nextBackupAt: '2026-11-24T00:00:00.000Z',
      lastAutoSuccessAt: '2026-11-21T00:00:00.000Z',
      lastAutoFailureAt: '2026-11-20T00:00:00.000Z',
      failureReason: 'LOCAL_UPLOAD_FAILED',
      autoUploadEnabled: false,
      initializedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  authorizations: [
    {
      organizationId: 4,
      activeCount: 1,
      revokedCount: 2,
      lastVerifiedAt: '2026-11-21T00:00:00.000Z',
      credentialPurpose: 'BUSINESS_SYNC',
    },
  ],
  generatedAt: '2026-11-22T02:00:00.000Z',
};

beforeEach(() => {
  adapters.fetchLocalRuntimeStatus.mockReset();
  adapters.fetchLocalRuntimeStatus.mockResolvedValue(STATUS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('本地设置只读面板', () => {
  it('加载态展示读取提示，不伪造任何运行事实', () => {
    adapters.fetchLocalRuntimeStatus.mockReturnValue(new Promise(() => undefined));

    render(<LocalRuntimeSettingsPanel />);

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('正在读取本机状态…')).toBeTruthy();
    expect(screen.queryByText('本机身份')).toBeNull();
  });

  it('就绪态展示身份、服务、保存位置、任务、授权与公司备份计划事实', async () => {
    render(<LocalRuntimeSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('本机身份')).toBeTruthy();
    });

    expect(screen.getByText('服务状态')).toBeTruthy();
    expect(screen.getByText('保存位置')).toBeTruthy();
    expect(screen.getByText('后台任务')).toBeTruthy();
    expect(screen.getByText('本设备公司同步授权')).toBeTruthy();
    expect(screen.getByText('本设备公司备份计划')).toBeTruthy();

    // 真实事实：安装标识、目录路径、角色与范围
    expect(screen.getByText('inst-local-1')).toBeTruthy();
    expect(screen.getByText('苏州客户现场')).toBeTruthy();
    expect(screen.getByText('/data/business-files')).toBeTruthy();
    expect(screen.getByText('/data/backup-packages')).toBeTruthy();
    expect(screen.getByText('一级管理员')).toBeTruthy();
    expect(screen.getByText('全局授权范围（全部公司）')).toBeTruthy();

    // 目录可写状态如实区分
    expect(screen.getByText('可写')).toBeTruthy();
    expect(screen.getByText('不可写')).toBeTruthy();

    // 失败原因是受控原因码：按码映射文案，不回显机器码
    expect(screen.getByText('云端上传失败')).toBeTruthy();
    expect(screen.queryByText('LOCAL_UPLOAD_FAILED')).toBeNull();
  });

  it('只读页不提供写入口：没有编辑、切换公司或立即备份按钮', async () => {
    render(<LocalRuntimeSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('本机身份')).toBeTruthy();
    });

    expect(screen.getByText(/本页为只读说明页/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('任务计数不可见时如实说明，不展示跨公司数量', async () => {
    adapters.fetchLocalRuntimeStatus.mockResolvedValue({ ...STATUS, tasks: null });

    render(<LocalRuntimeSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/全设备计数仅对一级管理员展示/)).toBeTruthy();
    });
    expect(screen.queryByText('待上传')).toBeNull();
  });

  it('权限不足时如实提示并可重新读取', async () => {
    adapters.fetchLocalRuntimeStatus.mockRejectedValue(
      new GraphQLIngressError({
        type: 'graphql',
        message: 'FORBIDDEN',
        graphqlErrors: [{ message: 'FORBIDDEN', extensions: { code: 'FORBIDDEN' } }],
      }),
    );

    render(<LocalRuntimeSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('本机状态读取失败')).toBeTruthy();
    });
    expect(screen.getByText('当前账号没有该操作的权限，请联系管理员。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy();
  });

  it('读取失败时给出可重试的失败态，点击后重新拉取', async () => {
    adapters.fetchLocalRuntimeStatus.mockRejectedValue(new Error('boom'));

    render(<LocalRuntimeSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('本机状态读取失败')).toBeTruthy();
    });
    expect(screen.getByText('本机状态读取失败，请稍后重试。')).toBeTruthy();

    adapters.fetchLocalRuntimeStatus.mockResolvedValue(STATUS);
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));

    await waitFor(() => {
      expect(screen.getByText('本机身份')).toBeTruthy();
    });
    expect(adapters.fetchLocalRuntimeStatus).toHaveBeenCalledTimes(2);
  });

  it('键盘可达：失败态的重试入口是原生可聚焦按钮且有可访问名称', async () => {
    adapters.fetchLocalRuntimeStatus.mockRejectedValue(new Error('boom'));

    render(<LocalRuntimeSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('本机状态读取失败')).toBeTruthy();
    });

    // 只读页唯一的交互入口是失败态的重试按钮：必须是原生 button（可 Tab 聚焦）且有可访问名称
    const retry = screen.getByRole('button', { name: '重新读取' }) as HTMLButtonElement;

    expect(retry.tagName).toBe('BUTTON');
    expect(retry.disabled).toBe(false);

    const interactive = Array.from(
      document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]'),
    );

    // 有交互元素才谈得上可达（避免空跑通过）
    expect(interactive.length).toBeGreaterThan(0);
    for (const element of interactive) {
      const node = element as HTMLElement;

      // 不允许 div 伪按钮：必须可 Tab 聚焦
      expect(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']).toContain(node.tagName);
      const accessibleName = node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '';

      expect(accessibleName.length).toBeGreaterThan(0);
    }
  });
});

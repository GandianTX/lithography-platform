// src/features/local-backup/ui/local-backup-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 备份与恢复面板 UI 单测（任务 09 S3／S4）。
 *
 * 走真实组件与真实 antd 渲染，数据访问层以受控替身注入：
 * 验证加载→就绪→失败三态、手动备份的真实阶段结果、恢复执行能力不可用时的如实呈现，
 * 以及恢复预检结果与发现项的展示。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  LocalBackupRecord,
  LocalBackupSetting,
  LocalRestoreCapability,
} from '../infrastructure/local-backup.types';

const adapters = vi.hoisted(() => ({
  fetchLocalBackupRecords: vi.fn(),
  fetchLocalBackupRecord: vi.fn(),
  fetchLocalBackupSettings: vi.fn(),
  startManualLocalBackup: vi.fn(),
  cleanupLocalBackupPackages: vi.fn(),
  precheckLocalRestore: vi.fn(),
  acceptLocalRestore: vi.fn(),
  fetchLocalRestoreCapability: vi.fn(),
}));

vi.mock('../infrastructure/local-backup-graphql-adapter', () => adapters);

import { LocalBackupPanel } from './local-backup-panel';

const RECORD: LocalBackupRecord = {
  backupId: '11111111-2222-4333-8444-555555555555',
  organizationId: 4,
  runId: 10,
  installationId: 'inst-1',
  triggerType: 'MANUAL',
  runStatus: 'SUCCEEDED',
  startedAt: '2026-11-21T00:00:00.000Z',
  finishedAt: '2026-11-21T00:05:00.000Z',
  createdAt: '2026-11-21T00:00:00.000Z',
  byteSize: 2048,
  localStatus: 'PENDING',
  localPackageRetained: true,
  cloudStatus: 'PENDING',
  cloudReceiptPresent: false,
  manifestChecksum: 'a'.repeat(64),
  verifiedAt: null,
  retentionUntil: null,
  failureReason: null,
  localCleanupError: null,
  attemptCount: 0,
  lastAttemptAt: null,
  deletedAt: null,
};

const SETTING: LocalBackupSetting = {
  organizationId: 4,
  installationId: 'inst-1',
  backupEnabled: true,
  backupIntervalHours: 72,
  nextBackupAt: '2026-11-24T00:00:00.000Z',
  lastAutoSuccessAt: '2026-11-18T00:00:00.000Z',
  lastAutoFailureAt: null,
  failureReason: null,
  autoUploadEnabled: false,
  planIntervalHours: 72,
  retentionDays: 30,
  lastRunStatus: 'SUCCEEDED',
  lastRunStartedAt: '2026-11-21T00:00:00.000Z',
  lastRunFinishedAt: '2026-11-21T00:05:00.000Z',
  lastAssetCloudStatus: 'PENDING',
  lastAssetLocalStatus: 'PENDING',
};

const CAPABILITY: LocalRestoreCapability = {
  executionAvailable: false,
  // 后端只回受控原因码，前端按码映射文案
  reason: 'RESTORE_WRITE_GATE_UNAVAILABLE',
};

beforeEach(() => {
  adapters.fetchLocalBackupRecords.mockResolvedValue({
    items: [RECORD],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  adapters.fetchLocalBackupSettings.mockResolvedValue([SETTING]);
  adapters.fetchLocalRestoreCapability.mockResolvedValue(CAPABILITY);
  adapters.startManualLocalBackup.mockResolvedValue({
    runId: 11,
    organizationId: 4,
    status: 'SUCCEEDED',
    backupId: 'backup-2',
    manifestChecksum: 'b'.repeat(64),
    byteSize: 1024,
    errorCode: null,
    errorMessage: null,
    uploadStatus: 'PENDING',
    cleanupStatus: 'PENDING',
  });
  adapters.cleanupLocalBackupPackages.mockResolvedValue({
    mode: 'MANUAL',
    organizationId: 4,
    available: false,
    reason: 'CLOUD_RECEIPT_MISSING',
    targetCount: 0,
    cleaned: 0,
    retained: 0,
    items: [],
  });
  adapters.acceptLocalRestore.mockResolvedValue({
    restoreId: 'restore-1',
    accepted: true,
    backupId: RECORD.backupId,
    protectionBackupId: 'protection-1',
    organizationId: 4,
    acceptedAt: '2026-11-23T00:00:00.000Z',
  });
  adapters.precheckLocalRestore.mockResolvedValue({
    restoreId: 'restore-1',
    outcome: 'FAILED',
    checkedAt: '2026-11-21T00:10:00.000Z',
    targetBackupId: RECORD.backupId,
    targetOrganizationId: 4,
    targetInstallationId: 'inst-1',
    manifestChecksum: null,
    packageReadable: true,
    fileCount: 1,
    originalCount: 0,
    verifiedFileCount: 1,
    protectionBackupId: 'protection-1',
    protectionCreated: true,
    findings: [
      {
        code: 'LOCAL_PACKAGE_MISSING',
        message: 'LOCAL_RESTORE_LOCAL_PACKAGE_MISSING',
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('备份与恢复面板', () => {
  it('就绪后呈现自动备份设置、备份记录与恢复能力状态', async () => {
    render(<LocalBackupPanel canPrecheck={false} />);

    await waitFor(() => {
      expect(screen.getByText('自动备份设置')).toBeTruthy();
    });
    expect(screen.getByText('备份记录')).toBeTruthy();
    expect(screen.getByText('11111111-2222-4333-8444-555555555555')).toBeTruthy();
    // 后端只回受控原因码：前端按码映射文案，不回显后端自由文本
    expect(screen.getByText(/未落地恢复期的写入\/同步闸门/)).toBeTruthy();
    expect(screen.getByText('当前环境暂不具备恢复执行能力')).toBeTruthy();
  });

  it('手动备份展示真实阶段结果：上云与清理未被伪造为已完成', async () => {
    render(<LocalBackupPanel canPrecheck={false} />);

    const trigger = await screen.findByRole('button', { name: '手动备份并清理本地备份包' });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(adapters.startManualLocalBackup).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('backup-2')).toBeTruthy();
    });
    // 上云与清理两个阶段按实际结果显示 PENDING，不显示为已成功。
    expect(screen.getAllByText('PENDING').length).toBeGreaterThanOrEqual(2);
  });

  it('没有完整云端回执时清理如实不可用，不谎报已清理', async () => {
    render(<LocalBackupPanel canPrecheck={false} />);

    const trigger = await screen.findByRole('button', { name: '手动备份并清理本地备份包' });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(adapters.cleanupLocalBackupPackages).toHaveBeenCalledWith('MANUAL');
    });
    await waitFor(() => {
      expect(screen.getByText(/未取得完整云端回执/)).toBeTruthy();
    });
    expect(screen.queryByText(/已清理 \d+ 个本地备份包/)).toBeNull();
  });

  it('部分清理失败时分别显示已清理与仍保留项', async () => {
    adapters.cleanupLocalBackupPackages.mockResolvedValue({
      mode: 'MANUAL',
      organizationId: 4,
      available: true,
      reason: null,
      targetCount: 2,
      cleaned: 1,
      retained: 1,
      items: [
        { backupId: 'backup-a', outcome: 'CLEANED', reason: null },
        // 后端对外只给受控原因码：原始异常只进服务端日志
        { backupId: 'backup-b', outcome: 'RETAINED', reason: 'LOCAL_PACKAGE_DELETE_FAILED' },
      ],
    });

    render(<LocalBackupPanel canPrecheck={false} />);

    const trigger = await screen.findByRole('button', { name: '手动备份并清理本地备份包' });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByText(/已清理 1 个本地备份包，仍保留 1 个/)).toBeTruthy();
    });
    expect(screen.getByText('backup-a')).toBeTruthy();
    expect(screen.getByText('backup-b')).toBeTruthy();
    expect(screen.getByText('已清理')).toBeTruthy();
    expect(screen.getByText('仍保留')).toBeTruthy();
    // 受控原因码按码映射文案，不回显原始异常文本
    expect(screen.getByText('本地包删除失败，已保留')).toBeTruthy();
    expect(screen.queryByText(/EACCES/)).toBeNull();
  });

  it('恢复预检展示结论与发现项', async () => {
    render(<LocalBackupPanel canPrecheck={true} />);

    const action = await screen.findByRole('button', { name: '恢复预检' });
    fireEvent.click(action);

    await waitFor(() => {
      expect(adapters.precheckLocalRestore).toHaveBeenCalledWith(RECORD.backupId);
    });
    await waitFor(() => {
      expect(screen.getByText(/预检未通过/)).toBeTruthy();
    });
    // 发现项的 message 是受控原因码：按码映射文案
    expect(screen.getByText('本机已无该备份包，需要先从云端取得可用副本')).toBeTruthy();
    expect(screen.getByText('restore-1')).toBeTruthy();
  });

  it('恢复预检入口按角色可见：非一级管理员不展示该入口', async () => {
    render(<LocalBackupPanel canPrecheck={false} />);

    await screen.findByText('备份记录');
    expect(screen.queryByRole('button', { name: '恢复预检' })).toBeNull();
  });

  it('读取失败时给出可重试的失败态，不伪造空数据', async () => {
    adapters.fetchLocalBackupRecords.mockRejectedValue(new Error('boom'));

    render(<LocalBackupPanel canPrecheck={false} />);

    await waitFor(() => {
      expect(screen.getByText('备份记录读取失败')).toBeTruthy();
    });
    // 失败态可重试
    expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy();
  });

  it('权限不足是独立第四态：提示联系管理员且不提供重试入口', async () => {
    adapters.fetchLocalBackupRecords.mockRejectedValue(
      new GraphQLIngressError({
        type: 'graphql',
        message: 'FORBIDDEN',
        graphqlErrors: [{ message: 'FORBIDDEN', extensions: { code: 'FORBIDDEN' } }],
      }),
    );

    render(<LocalBackupPanel canPrecheck={false} />);

    await waitFor(() => {
      expect(screen.getByText('当前账号没有该操作的权限，请联系管理员。')).toBeTruthy();
    });
    // 权限不足重试无用：不提供重读入口
    expect(screen.queryByRole('button', { name: '重新读取' })).toBeNull();
  });

  it('未知原因码走通用兜底文案，不把后端自由文本当契约渲染', async () => {
    adapters.fetchLocalRestoreCapability.mockResolvedValue({
      executionAvailable: false,
      reason: 'LOCAL_UNKNOWN_REASON_CODE',
    });
    adapters.cleanupLocalBackupPackages.mockResolvedValue({
      mode: 'MANUAL',
      organizationId: 4,
      available: true,
      reason: null,
      targetCount: 1,
      cleaned: 0,
      retained: 1,
      items: [{ backupId: 'backup-x', outcome: 'RETAINED', reason: 'LOCAL_UNKNOWN_REASON_CODE' }],
    });

    render(<LocalBackupPanel canPrecheck={false} />);

    const trigger = await screen.findByRole('button', { name: '手动备份并清理本地备份包' });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getAllByText('原因未登记').length).toBeGreaterThanOrEqual(1);
    });
    // 未知码不回显为原始文本
    expect(screen.queryByText('LOCAL_UNKNOWN_REASON_CODE')).toBeNull();
  });

  it('窄屏不撑破页面：备份记录表放在横向滚动容器内', async () => {
    render(<LocalBackupPanel canPrecheck={false} />);

    await waitFor(() => {
      expect(screen.getByText(RECORD.backupId)).toBeTruthy();
    });

    // antd 在 scroll.x 下把宽表放进自带横向滚动的内容容器，页面本身不被撑开
    const tableContent = document.querySelector('.ant-table-content') as HTMLElement | null;

    expect(tableContent).toBeTruthy();
    expect(tableContent?.style.overflowX).toBe('auto');
  });

  it('键盘可达：交互元素均为原生可聚焦控件且有可访问名称', async () => {
    render(<LocalBackupPanel canPrecheck={false} />);

    await waitFor(() => {
      expect(screen.getByText(RECORD.backupId)).toBeTruthy();
    });

    const interactive = Array.from(
      document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]'),
    );

    expect(interactive.length).toBeGreaterThan(0);
    for (const element of interactive) {
      const node = element as HTMLElement;

      // 不允许 div 伪按钮：必须可 Tab 聚焦
      expect(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']).toContain(node.tagName);
      // 只跳过框架自带的图标按钮（分页、表格排序）；表格内的自有按钮仍必须有可访问名称
      if (node.closest('.ant-pagination, .ant-table-column-sorter')) {
        continue;
      }
      const accessibleName = node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '';

      expect(accessibleName.length).toBeGreaterThan(0);
    }
  });

  it('预检未通过时不提供受理入口', async () => {
    render(<LocalBackupPanel canPrecheck={true} />);

    const action = await screen.findByRole('button', { name: '恢复预检' });
    fireEvent.click(action);

    await waitFor(() => {
      expect(screen.getByText(/预检未通过/)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: '确认受理本次恢复' })).toBeNull();
  });

  it('预检通过后给出受理入口；受理如实展示且不冒充恢复成功', async () => {
    adapters.precheckLocalRestore.mockResolvedValue({
      restoreId: 'restore-1',
      outcome: 'PASSED',
      checkedAt: '2026-11-23T00:00:00.000Z',
      targetBackupId: RECORD.backupId,
      targetOrganizationId: 4,
      targetInstallationId: 'inst-1',
      manifestChecksum: null,
      packageReadable: true,
      fileCount: 1,
      originalCount: 0,
      verifiedFileCount: 1,
      protectionBackupId: 'protection-1',
      protectionCreated: true,
      findings: [],
    });

    render(<LocalBackupPanel canPrecheck={true} />);

    const action = await screen.findByRole('button', { name: '恢复预检' });
    fireEvent.click(action);

    const acceptButton = await screen.findByRole('button', { name: '确认受理本次恢复' });
    fireEvent.click(acceptButton);

    await waitFor(() => {
      expect(adapters.acceptLocalRestore).toHaveBeenCalledWith('restore-1');
    });
    await waitFor(() => {
      expect(screen.getByText(/已受理/)).toBeTruthy();
    });
    // 受理 ≠ 恢复：页面必须明说，不把受理显示成恢复成功
    expect(screen.getByText(/受理不等于恢复成功/)).toBeTruthy();
  });
});

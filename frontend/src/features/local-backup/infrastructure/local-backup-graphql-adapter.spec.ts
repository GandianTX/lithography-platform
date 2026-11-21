// src/features/local-backup/infrastructure/local-backup-graphql-adapter.spec.ts

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupLocalBackupPackages,
  fetchLocalBackupRecords,
  fetchLocalBackupSettings,
  precheckLocalRestore,
  startManualLocalBackup,
} from './local-backup-graphql-adapter';

const executeGraphQL = vi.hoisted(() => vi.fn());

vi.mock('@/shared/graphql', () => ({
  executeGraphQL,
}));

afterEach(() => {
  executeGraphQL.mockReset();
});

describe('备份与恢复 GraphQL 适配层', () => {
  it('备份记录查询按页请求，且不传公司参数', async () => {
    executeGraphQL.mockResolvedValue({
      localBackupRecords: { items: [], total: 0, page: 2, pageSize: 20 },
    });

    const page = await fetchLocalBackupRecords(2, 20);

    expect(page.page).toBe(2);
    const [query, variables] = executeGraphQL.mock.calls[0] as [string, unknown];
    expect(query).toContain('localBackupRecords');
    expect(variables).toEqual({ pagination: { page: 2, pageSize: 20, withTotal: true } });
    expect(JSON.stringify(variables)).not.toContain('organizationId');
  });

  it('自动备份设置读取缺省归一为空数组', async () => {
    executeGraphQL.mockResolvedValue({});

    await expect(fetchLocalBackupSettings()).resolves.toEqual([]);
  });

  it('手动备份不指定公司时传 null，由服务端按会话裁决', async () => {
    executeGraphQL.mockResolvedValue({
      startManualLocalBackup: {
        runId: 1,
        organizationId: 4,
        status: 'SUCCEEDED',
        backupId: 'backup-1',
        manifestChecksum: 'a'.repeat(64),
        byteSize: 10,
        errorCode: null,
        errorMessage: null,
        uploadStatus: 'PENDING',
        cleanupStatus: 'PENDING',
      },
    });

    const result = await startManualLocalBackup();

    expect(result.status).toBe('SUCCEEDED');
    const [, variables] = executeGraphQL.mock.calls[0] as [string, unknown];
    expect(variables).toEqual({ organizationId: null });
  });

  it('恢复预检把备份 ID 原样传给服务端', async () => {
    executeGraphQL.mockResolvedValue({
      precheckLocalRestore: {
        restoreId: 'r-1',
        outcome: 'PASSED',
        checkedAt: '2026-11-21T00:00:00.000Z',
        targetBackupId: 'backup-1',
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
      },
    });

    const result = await precheckLocalRestore('backup-1');

    expect(result.outcome).toBe('PASSED');
    const [query, variables] = executeGraphQL.mock.calls[0] as [string, unknown];
    expect(query).toContain('precheckLocalRestore');
    expect(variables).toEqual({ backupId: 'backup-1' });
  });

  it('清理按模式发起，且不传公司参数（范围由服务端按会话裁决）', async () => {
    executeGraphQL.mockResolvedValue({
      cleanupLocalBackupPackages: {
        mode: 'MANUAL',
        organizationId: 4,
        available: false,
        reason: 'CLOUD_RECEIPT_MISSING',
        targetCount: 0,
        cleaned: 0,
        retained: 0,
        items: [],
      },
    });

    const result = await cleanupLocalBackupPackages('MANUAL');

    expect(result.available).toBe(false);
    expect(result.cleaned).toBe(0);
    const [query, variables] = executeGraphQL.mock.calls[0] as [string, unknown];
    expect(query).toContain('cleanupLocalBackupPackages');
    expect(variables).toEqual({ mode: 'MANUAL', organizationId: null });
  });

  it('请求失败向上抛错，不做乐观降级', async () => {
    executeGraphQL.mockRejectedValue(new Error('network down'));

    await expect(fetchLocalBackupRecords(1, 20)).rejects.toThrow('network down');
  });
});

// src/features/local-backup/infrastructure/local-backup-graphql-adapter.spec.ts

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acceptLocalRestore,
  cleanupLocalBackupPackages,
  downloadLocalBackupCloudPackage,
  executeLocalRestore,
  fetchLocalBackupCloudPackages,
  fetchLocalBackupRecords,
  fetchLocalBackupSettings,
  precheckLocalRestore,
  startManualLocalBackup,
} from './local-backup-graphql-adapter';

const executeGraphQL = vi.hoisted(() => vi.fn());
const fetchRestWithAuthRetry = vi.hoisted(() => vi.fn());

vi.mock('@/shared/graphql', () => ({
  executeGraphQL,
}));

vi.mock('@/shared/http/rest-request', () => ({
  fetchRestWithAuthRetry,
}));

afterEach(() => {
  executeGraphQL.mockReset();
  fetchRestWithAuthRetry.mockReset();
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

  it('恢复受理把 restoreId 原样传给服务端，并如实带回受理事实', async () => {
    executeGraphQL.mockResolvedValue({
      acceptLocalRestore: {
        restoreId: 'r-1',
        accepted: true,
        backupId: 'backup-1',
        protectionBackupId: 'protection-1',
        organizationId: 4,
        acceptedAt: '2026-11-23T00:00:00.000Z',
      },
    });

    const acceptance = await acceptLocalRestore('r-1');

    expect(acceptance.accepted).toBe(true);
    expect(acceptance.protectionBackupId).toBe('protection-1');
    const [query, variables] = executeGraphQL.mock.calls[0] as [string, unknown];
    expect(query).toContain('acceptLocalRestore');
    expect(variables).toEqual({ restoreId: 'r-1' });
  });

  it('恢复受理失败时如实上抛（不乐观降级为已受理）', async () => {
    executeGraphQL.mockRejectedValue(new Error('受理被拒'));

    await expect(acceptLocalRestore('r-1')).rejects.toThrow('受理被拒');
  });

  it('云包清单查询带上服务端声明的操作名，且不传公司参数', async () => {
    executeGraphQL.mockResolvedValue({
      localBackupCloudPackages: { packages: [] },
    });

    const list = await fetchLocalBackupCloudPackages();

    expect(list.packages).toEqual([]);
    const [query, variables] = executeGraphQL.mock.calls[0] as [string, unknown];
    expect(query).toContain('localBackupCloudPackages');
    // 不指定公司：`organizationId=null` ⇒ 公司范围由服务端按 Session 裁决（前端不传公司）
    expect(variables ?? {}).toEqual({ organizationId: null });
  });

  it('恢复执行把 restoreId 原样传给服务端，并如实带回失败终态与冻结事实', async () => {
    executeGraphQL.mockResolvedValue({
      executeLocalRestore: {
        restoreId: 'r-1',
        status: 'FAILED',
        reasonCode: 'RESTORE_EXECUTION_FAILED',
        reason: '恢复执行失败',
        restoredRecords: null,
        restoredOriginals: null,
        restoredQueue: null,
        released: false,
        holdRetained: true,
      },
    });

    const execution = await executeLocalRestore('r-1');

    expect(execution.status).toBe('FAILED');
    expect(execution.holdRetained).toBe(true);
    expect(execution.released).toBe(false);
    const [query, variables] = executeGraphQL.mock.calls[0] as [string, unknown];
    expect(query).toContain('executeLocalRestore');
    expect(variables).toEqual({ restoreId: 'r-1' });
  });

  it('云包下载走 REST 字节流，并优先用服务端给的文件名', async () => {
    fetchRestWithAuthRetry.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Disposition': "attachment; filename*=UTF-8''backup-4%2Fmanual.zip",
      }),
      blob: async () => new Blob(['bytes']),
    });

    const result = await downloadLocalBackupCloudPackage({ packageId: 'pkg-1' });

    expect(result.ok).toBe(true);
    expect(result.filename).toBe('backup-4/manual.zip');
    const [url] = fetchRestWithAuthRetry.mock.calls[0] as [string];
    // 路径必须带 `/api` 前缀（后端没有全局前缀，前端也只代理 `/api`）
    expect(url).toBe('/api/local-runtime/backup/cloud-packages/pkg-1/download');
  });

  it('云包下载失败时如实给出失败态（不假装成功）', async () => {
    fetchRestWithAuthRetry.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      blob: async () => new Blob([]),
    });

    const result = await downloadLocalBackupCloudPackage({ packageId: 'pkg-1' });

    expect(result.ok).toBe(false);
    expect(result.blob).toBeNull();
    expect(result.reason).toBe('not-found');
  });
});

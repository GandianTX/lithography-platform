// src/modules/lithography/backup-restore-precheck.service.spec.ts

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { BackupRestorePrecheckService } from './backup-restore-precheck.service';
import { BACKUP_SCOPE_TABLES } from '@core/local-runtime/policy/protected-backup.policy';
import { asPinoLogger, createTestPinoLogger } from '../../../test/utils/test-pino-logger';

/**
 * 恢复预检执行层单测（任务 09 S4，R085-01／02）。
 *
 * 覆盖：同机同公司通过、异设备拒绝、异公司拒绝、损坏包拒绝、
 * 本地包已清理拒绝、保护副本生成与绑定、预检不写业务表。
 */
describe('backup restore precheck service', () => {
  const now = new Date('2026-11-21T00:00:00.000Z');
  let packageRoot: string;

  beforeEach(() => {
    packageRoot = mkdtempSync(nodePath.join(tmpdir(), 'task09-precheck-'));
  });

  afterEach(() => {
    rmSync(packageRoot, { recursive: true, force: true });
  });

  function writePackage(options: { corrupt?: boolean } = {}): { path: string } {
    const dir = nodePath.join(packageRoot, 'pkg');
    mkdirSync(dir, { recursive: true });
    const payload = Buffer.from('PROTECTED-PAYLOAD');
    writeFileSync(nodePath.join(dir, 'payload.enc'), payload);
    const digest = options.corrupt
      ? 'b'.repeat(64)
      : createHash('sha256').update(payload).digest('hex');

    const manifest = {
      schema_version: 1,
      backup_id: '11111111-2222-4333-8444-555555555555',
      organization_id: 4,
      installation_id: 'inst-1',
      run_id: 10,
      generated_at: '2026-11-21T00:00:00.000Z',
      encryption: {
        algorithm: 'AES-256-GCM',
        key_id: 'key-1',
        iv: 'a'.repeat(24),
        auth_tag: 'b'.repeat(32),
      },
      scope: BACKUP_SCOPE_TABLES.map((table) => ({
        table,
        rowCount: 1,
        lastUpdatedAt: '2026-11-21T00:00:00.000Z',
      })),
      files: [
        {
          relative_path: 'payload.enc',
          sha256: digest,
          byte_size: payload.byteLength,
        },
      ],
      originals: [],
    };
    writeFileSync(nodePath.join(dir, 'manifest.json'), JSON.stringify(manifest));

    return { path: dir };
  }

  function buildService() {
    const inserted: Record<string, unknown>[] = [];
    const restoreRunRepository = {
      insert: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve({ identifiers: [] });
      }),
    };
    const service = new BackupRestorePrecheckService(
      restoreRunRepository as never,
      asPinoLogger(createTestPinoLogger()),
    );

    return { service, inserted };
  }

  const asset = (overrides: Record<string, unknown> = {}) => ({
    backupId: '11111111-2222-4333-8444-555555555555',
    organizationId: 4,
    installationId: 'inst-1',
    localReference: null,
    localStatus: 'PENDING',
    manifestChecksum: 'c'.repeat(64),
    ...overrides,
  });

  const protection = () =>
    Promise.resolve({
      backupId: 'protection-1',
      packagePath: '/tmp/protection',
    });

  it('同机同公司且包完整时通过，并写入预检事实', async () => {
    const pkg = writePackage();
    const { service, inserted } = buildService();

    const result = await service.execute({
      asset: asset({ localReference: pkg.path }),
      currentInstallationId: 'inst-1',
      allowedOrganizationId: 4,
      startedByAccountId: 7,
      createProtectionCopy: protection,
      now,
    });

    expect(result.outcome).toBe('PASSED');
    expect(result.snapshot.protection.backupId).toBe('protection-1');
    expect(result.snapshot.package.verifiedFileCount).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      backupId: '11111111-2222-4333-8444-555555555555',
      protectionBackupId: null,
      checkStatus: 'PASSED',
      status: 'PENDING',
      startedAt: null,
      finishedAt: null,
    });
  });

  it('异设备恢复被拒绝', async () => {
    const pkg = writePackage();
    const { service } = buildService();

    const result = await service.execute({
      asset: asset({ localReference: pkg.path, installationId: 'inst-other' }),
      currentInstallationId: 'inst-1',
      allowedOrganizationId: null,
      startedByAccountId: 7,
      createProtectionCopy: protection,
      now,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.snapshot.findings.map((finding) => finding.code)).toContain(
      'TARGET_INSTALLATION_MISMATCH',
    );
  });

  it('异公司恢复被拒绝', async () => {
    const pkg = writePackage();
    const { service } = buildService();

    const result = await service.execute({
      asset: asset({ localReference: pkg.path, organizationId: 9 }),
      currentInstallationId: 'inst-1',
      allowedOrganizationId: 4,
      startedByAccountId: 7,
      createProtectionCopy: protection,
      now,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.snapshot.findings.map((finding) => finding.code)).toContain(
      'TARGET_ORGANIZATION_MISMATCH',
    );
  });

  it('损坏包（校验值不符）被拒绝', async () => {
    const pkg = writePackage({ corrupt: true });
    const { service } = buildService();

    const result = await service.execute({
      asset: asset({ localReference: pkg.path }),
      currentInstallationId: 'inst-1',
      allowedOrganizationId: 4,
      startedByAccountId: 7,
      createProtectionCopy: protection,
      now,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.snapshot.findings.map((finding) => finding.code)).toContain(
      'FILE_CHECKSUM_MISMATCH',
    );
  });

  it('清单缺失时如实标记不可读', async () => {
    const dir = nodePath.join(packageRoot, 'empty');
    mkdirSync(dir, { recursive: true });
    const { service } = buildService();

    const result = await service.execute({
      asset: asset({ localReference: dir }),
      currentInstallationId: 'inst-1',
      allowedOrganizationId: 4,
      startedByAccountId: 7,
      createProtectionCopy: protection,
      now,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.snapshot.package.readable).toBe(false);
    expect(result.snapshot.findings.map((finding) => finding.code)).toContain('PACKAGE_UNREADABLE');
  });

  it('本地包已清理时拒绝恢复', async () => {
    const { service } = buildService();

    const result = await service.execute({
      asset: asset({ localStatus: 'CLEANED', localReference: null }),
      currentInstallationId: 'inst-1',
      allowedOrganizationId: 4,
      startedByAccountId: 7,
      createProtectionCopy: protection,
      now,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.snapshot.findings.map((finding) => finding.code)).toContain(
      'LOCAL_PACKAGE_MISSING',
    );
  });

  it('保护副本生成失败时如实记录发现项并判失败', async () => {
    const pkg = writePackage();
    const { service } = buildService();

    const result = await service.execute({
      asset: asset({ localReference: pkg.path }),
      currentInstallationId: 'inst-1',
      allowedOrganizationId: 4,
      startedByAccountId: 7,
      createProtectionCopy: () => Promise.reject(new Error('磁盘空间不足')),
      now,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.snapshot.protection.created).toBe(false);
    expect(result.snapshot.findings.map((finding) => finding.code)).toContain(
      'PROTECTION_COPY_FAILED',
    );
  });
});

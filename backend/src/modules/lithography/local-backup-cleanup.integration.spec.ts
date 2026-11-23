// src/modules/lithography/local-backup-cleanup.integration.spec.ts
// 受保护备份包清理的反例核对（任务 09 S3.4，A09-05／A09-08）。
//
// 用**真实文件系统**与**真实 ProtectedBackupService** 构造受保护备份包
// （manifest.json ＋ AES-256-GCM 载荷 ＋ 复制进包的业务原件），再执行清理，
// 核对以下事实不被破坏：
// - 公司外（其他公司数据区）的备份包哨兵不变；
// - 业务原件目录的哨兵文件内容不变；
// - 云副本事实（云引用与完整回执）不因本地清理被改写；
// - 过期 30 天清理的成功与失败分支各自可辨认。

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';

import {
  BACKUP_PAYLOAD_PATH,
  parseBackupManifest,
} from '@core/local-runtime/policy/protected-backup.policy';

import { LocalBackupCleanupService } from './local-backup-cleanup.service';
import { ProtectedBackupService } from './protected-backup.service';
import type { BackupAssetEntity } from './entities/backup-asset.entity';
import { asPinoLogger, createTestPinoLogger } from '../../../test/utils/test-pino-logger';

class FailingDeleteService extends LocalBackupCleanupService {
  protected override removePackageDirectory(): Promise<void> {
    const error = new Error('EACCES: permission denied');
    (error as NodeJS.ErrnoException).code = 'EACCES';
    return Promise.reject(error);
  }
}

describe('受保护备份包清理的反例核对（S3.4）', () => {
  const KEY_HEX = 'ab'.repeat(32);
  const workspace = nodePath.join(__dirname, '.tmp-cleanup-integration');
  const backupRoot = nodePath.join(workspace, 'local-backups');
  const originalRoot = nodePath.join(workspace, 'business-originals');
  const cloudSentinelPath = nodePath.join(workspace, 'cloud-sentinel.json');
  const now = new Date('2026-11-21T00:00:00.000Z');

  beforeAll(() => {
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(nodePath.join(originalRoot, 'docs'), { recursive: true });
    mkdirSync(nodePath.join(backupRoot, '5'), { recursive: true });
    writeFileSync(nodePath.join(originalRoot, 'docs', 'doc-1.txt'), 'ORIGINAL-DOC-1');
    writeFileSync(cloudSentinelPath, '{"cloudCopy":"kept"}');
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** 生成一份真实受保护备份包（公司 4），并登记资产行 */
  const buildProtectedBackup = async (suffix = 'manual-1') => {
    const repoOf = (rows: Record<string, unknown>[]) => ({
      find: jest.fn().mockResolvedValue(rows),
      findOne: jest.fn().mockResolvedValue(rows[0] ?? null),
      count: jest.fn().mockResolvedValue(rows.length),
      save: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((row: Record<string, unknown>) => row),
      createQueryBuilder: jest.fn(() => {
        const builder: Record<string, unknown> = {
          where: jest.fn(() => builder),
          orderBy: jest.fn(() => builder),
          limit: jest.fn(() => builder),
          getCount: jest.fn().mockResolvedValue(rows.length),
          getRawOne: jest.fn().mockResolvedValue(rows[0] ?? null),
          getMany: jest.fn().mockResolvedValue(rows),
          delete: jest.fn(() => ({ execute: jest.fn().mockResolvedValue({ affected: 0 }) })),
        };
        return builder;
      }),
    });
    const fileStorage = {
      open: (reference: string) =>
        Promise.resolve(createReadStream(nodePath.join(originalRoot, 'docs', reference))),
    };

    const backupService = new ProtectedBackupService(
      { findOne: jest.fn().mockResolvedValue({ installationId: 'inst-1' }) } as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([
        {
          id: 1,
          ownerOrganizationId: 4,
          updatedAt: now,
          storageBackend: 'local',
          storageReference: 'doc-1.txt',
          title: '资料1',
        },
      ]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      repoOf([]) as never,
      fileStorage as never,
      { keyHex: KEY_HEX, keyId: 'primary' },
      { baseDir: backupRoot },
    );

    const targetPath = nodePath.join(backupRoot, '4', suffix);
    const generated = await backupService.generateProtectedBackup({
      organizationId: 4,
      runId: 3,
      targetPath,
    });

    return generated;
  };

  const buildCleanupService = (
    rows: BackupAssetEntity[],
    serviceClass: typeof LocalBackupCleanupService = LocalBackupCleanupService,
  ) => {
    const updates: { backupId: string; patch: Record<string, unknown> }[] = [];
    const backupAssetRepository = {
      find: jest.fn().mockImplementation((input: { where: Record<string, unknown> }) => {
        const where = input.where ?? {};
        return Promise.resolve(
          rows.filter((row) =>
            Object.entries(where).every(
              ([key, value]) => row[key as keyof BackupAssetEntity] === value,
            ),
          ),
        );
      }),
      update: jest
        .fn()
        .mockImplementation((where: { backupId: string }, patch: Record<string, unknown>) => {
          updates.push({ backupId: where.backupId, patch });
          const target = rows.find((row) => row.backupId === where.backupId);
          if (target) {
            Object.assign(target, patch);
          }
          return Promise.resolve({ affected: 1 });
        }),
    };
    const service = new serviceClass(
      backupAssetRepository as never,
      { baseDir: backupRoot },
      asPinoLogger(createTestPinoLogger()),
      undefined,
    );
    return { service, updates, rows };
  };

  const asset = (overrides: Partial<BackupAssetEntity> = {}): BackupAssetEntity => ({
    backupId: 'backup-1',
    runId: 3,
    organizationId: 4,
    localCleanupRunId: null,
    installationId: 'inst-1',
    formatVersion: null,
    dataVersion: null,
    manifestChecksum: 'a'.repeat(64),
    localReference: null,
    cloudReference: 'cloud://backup-1',
    encryptionKeyId: 'primary',
    verifiedAt: now,
    retentionUntil: null,
    failureReason: null,
    deletedAt: null,
    localCleanupError: null,
    storageReference: '',
    fileSha256: 'a'.repeat(64),
    byteSize: '100',
    cloudStatus: 'SUCCEEDED',
    localStatus: 'PENDING',
    cloudReceipt: '{"received":true}',
    attemptCount: 1,
    lastAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  it('手动清理真实受保护包：公司外包、业务原件与云副本哨兵均不变', async () => {
    const generated = await buildProtectedBackup();
    // 包内容自证：清单、加密载荷与复制进包的业务原件都在
    expect(existsSync(nodePath.join(generated.packagePath, 'manifest.json'))).toBe(true);
    expect(existsSync(nodePath.join(generated.packagePath, BACKUP_PAYLOAD_PATH))).toBe(true);
    expect(existsSync(nodePath.join(generated.packagePath, 'files/doc-1.txt'))).toBe(true);
    const manifest = parseBackupManifest(
      JSON.parse(readFileSync(nodePath.join(generated.packagePath, 'manifest.json'), 'utf8')),
    );
    expect(manifest.organization_id).toBe(4);

    // 外公司数据区的包哨兵
    const otherCompanyPackage = nodePath.join(backupRoot, '5', 'manual-9');
    mkdirSync(otherCompanyPackage, { recursive: true });
    writeFileSync(nodePath.join(otherCompanyPackage, 'manifest.json'), '{"backup_id":"other"}');

    const rows = [
      asset({ backupId: 'backup-1', localReference: generated.packagePath }),
      asset({
        backupId: 'backup-other',
        organizationId: 5,
        localReference: otherCompanyPackage,
      }),
    ];
    const { service, updates } = buildCleanupService(rows);

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: '{"received":true}',
      now,
    });

    // 本机包被清理
    expect(result.cleaned).toBe(1);
    expect(existsSync(generated.packagePath)).toBe(false);

    // 公司外包哨兵不变
    expect(existsSync(nodePath.join(otherCompanyPackage, 'manifest.json'))).toBe(true);
    // 业务原件哨兵不变
    expect(readFileSync(nodePath.join(originalRoot, 'docs', 'doc-1.txt'), 'utf8')).toBe(
      'ORIGINAL-DOC-1',
    );
    // 云副本哨兵不变
    expect(readFileSync(cloudSentinelPath, 'utf8')).toBe('{"cloudCopy":"kept"}');

    // 云副本事实不被本地清理改写
    const cloudFieldsTouched = updates.filter((entry) =>
      Object.keys(entry.patch).some((key) => key.startsWith('cloud')),
    );
    expect(cloudFieldsTouched).toHaveLength(0);
    expect(rows[0].cloudReference).toBe('cloud://backup-1');
    expect(rows[0].cloudReceipt).toBe('{"received":true}');
    expect(rows[0].localStatus).toBe('CLEANED');
    expect(rows[0].localReference).toBeNull();
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it('过期 30 天清理：到期即清理，失败分支保留包并落原因', async () => {
    const generated = await buildProtectedBackup();
    const rows = [
      asset({
        backupId: 'backup-1',
        localReference: generated.packagePath,
        retentionUntil: new Date(now.getTime() - 86_400_000),
      }),
    ];
    const { service, updates } = buildCleanupService(rows, FailingDeleteService);

    const result = await service.cleanupExpiredPackages({
      organizationId: 4,
      installationId: 'inst-1',
      now,
    });

    // 失败分支：包保留、事实可辨认、不误标为已清理
    expect(result.cleaned).toBe(0);
    expect(result.retained).toBe(1);
    expect(result.items[0].reason).toContain('LOCAL_PACKAGE_DELETE_FAILED');
    expect(existsSync(generated.packagePath)).toBe(true);
    expect(rows[0].localStatus).toBe('FAILED');
    expect(rows[0].localCleanupError).toContain('LOCAL_PACKAGE_DELETE_FAILED');
    expect(updates.some((entry) => entry.patch['localStatus'] === 'CLEANED')).toBe(false);
    // 业务原件哨兵仍不变
    expect(readFileSync(nodePath.join(originalRoot, 'docs', 'doc-1.txt'), 'utf8')).toBe(
      'ORIGINAL-DOC-1',
    );
  });

  it('过期清理未到期时不动本机包；到期即清理（云副本不是门槛）', async () => {
    const generated = await buildProtectedBackup('manual-2');
    const freshRows = [
      asset({
        backupId: 'backup-fresh',
        localReference: generated.packagePath,
        retentionUntil: new Date(now.getTime() + 86_400_000),
      }),
    ];
    const fresh = buildCleanupService(freshRows);
    const freshResult = await fresh.service.cleanupExpiredPackages({
      organizationId: 4,
      installationId: 'inst-1',
      now,
    });
    expect(freshResult.targetCount).toBe(0);
    expect(existsSync(generated.packagePath)).toBe(true);

    // 到期即清理：任务书 R083-01「只清过期成功本地包」，云副本不是清理门槛
    const expiredRows = [
      asset({
        backupId: 'backup-nocloud',
        localReference: generated.packagePath,
        retentionUntil: new Date(now.getTime() - 86_400_000),
        cloudStatus: 'PENDING',
        cloudReceipt: null,
      }),
    ];
    const expired = buildCleanupService(expiredRows);
    const expiredResult = await expired.service.cleanupExpiredPackages({
      organizationId: 4,
      installationId: 'inst-1',
      now,
    });
    expect(expiredResult.targetCount).toBe(1);
    expect(expiredResult.cleaned).toBe(1);
    expect(existsSync(generated.packagePath)).toBe(false);
    // 云副本事实不被本地清理改写
    expect(expiredRows[0].cloudReceipt).toBeNull();
    expect(expiredRows[0].localStatus).toBe('CLEANED');
  });
});

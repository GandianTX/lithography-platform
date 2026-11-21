// src/modules/lithography/local-backup-cleanup.service.spec.ts
// 本地备份包清理执行层单测（任务 09 S3.3）。
//
// 用真实文件系统构造受保护包目录与哨兵文件，验证：
// - 无完整云回执时零清理（不删目录、不改资产状态）；
// - 有完整云回执时固定清单逐项删除，结果逐项落库；
// - 路径越界一律拒绝删除（业务原件与外公司哨兵不变）；
// - 删除失败时保留包并落失败原因；
// - 清理中断可辨认并可重试；
// - 过期清理的到期／未到期与云副本可证分支。

import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { LocalBackupCleanupService } from './local-backup-cleanup.service';
import type { BackupAssetEntity } from './entities/backup-asset.entity';

/** 删除动作失败的受控替身：覆盖底层删除，验证失败分支的落库事实 */
class FailingDeleteService extends LocalBackupCleanupService {
  protected override removePackageDirectory(): Promise<void> {
    const error = new Error('EACCES: permission denied');
    (error as NodeJS.ErrnoException).code = 'EACCES';
    return Promise.reject(error);
  }
}

describe('local backup cleanup service', () => {
  const base = new Date('2026-11-21T00:00:00.000Z');

  let rootDir = '';
  let backupRoot = '';
  let originalRoot = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(nodePath.join(tmpdir(), 'task09-cleanup-'));
    backupRoot = nodePath.join(rootDir, 'local-backups');
    originalRoot = nodePath.join(rootDir, 'business-originals');
    await mkdir(nodePath.join(backupRoot, '4'), { recursive: true });
    await mkdir(nodePath.join(backupRoot, '5'), { recursive: true });
    await mkdir(originalRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function asset(overrides: Partial<BackupAssetEntity> = {}): BackupAssetEntity {
    return {
      backupId: 'backup-1',
      runId: 10,
      organizationId: 4,
      localCleanupRunId: null,
      installationId: 'inst-1',
      formatVersion: null,
      dataVersion: null,
      manifestChecksum: 'a'.repeat(64),
      localReference: null,
      cloudReference: null,
      encryptionKeyId: null,
      verifiedAt: base,
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
      lastAttemptAt: base,
      createdAt: base,
      updatedAt: base,
      ...overrides,
    };
  }

  function buildService(
    rows: BackupAssetEntity[],
    serviceClass: typeof LocalBackupCleanupService = LocalBackupCleanupService,
  ) {
    const updates: { backupId: string; patch: Record<string, unknown> }[] = [];
    const runUpdates: { id: number; patch: Record<string, unknown> }[] = [];

    const backupAssetRepository = {
      find: jest
        .fn()
        .mockImplementation(
          (input: { where: Record<string, unknown>; order?: Record<string, unknown> }) => {
            const where = input.where ?? {};
            const matched = rows.filter((row) =>
              Object.entries(where).every(
                ([key, value]) => row[key as keyof BackupAssetEntity] === value,
              ),
            );
            const direction = (input.order?.['createdAt'] as 'ASC' | 'DESC' | undefined) ?? 'ASC';
            return Promise.resolve(direction === 'DESC' ? [...matched].reverse() : matched);
          },
        ),
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

    const backupRunRepository = {
      update: jest
        .fn()
        .mockImplementation((where: { id: number }, patch: Record<string, unknown>) => {
          runUpdates.push({ id: where.id, patch });
          return Promise.resolve({ affected: 1 });
        }),
    };

    const service = new serviceClass(
      backupAssetRepository as never,
      { baseDir: backupRoot },
      backupRunRepository as never,
    );

    return { service, updates, runUpdates, rows };
  }

  async function createPackage(relativeDir: string, files: string[]): Promise<string> {
    const packagePath = nodePath.join(backupRoot, relativeDir);
    await mkdir(nodePath.join(packagePath, 'files'), { recursive: true });
    await writeFile(nodePath.join(packagePath, 'manifest.json'), '{"backup_id":"x"}', 'utf8');
    for (const file of files) {
      await writeFile(nodePath.join(packagePath, 'files', file), `content-${file}`, 'utf8');
    }
    return packagePath;
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }

  it('无完整云回执时零清理：不删目录、不改资产状态', async () => {
    const packagePath = await createPackage('4/manual-1', ['a.txt']);
    const { service, updates } = buildService([asset({ localReference: packagePath })]);

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: null,
      now: base,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe('CLOUD_RECEIPT_MISSING');
    expect(result.cleaned).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(await exists(packagePath)).toBe(true);
  });

  it('有完整云回执时固定清单逐项删除，结果逐项落库', async () => {
    const first = await createPackage('4/manual-1', ['a.txt']);
    const second = await createPackage('4/manual-2', ['b.txt']);
    const { service, updates, runUpdates } = buildService([
      asset({ backupId: 'backup-1', localReference: first }),
      asset({ backupId: 'backup-2', localReference: second }),
    ]);

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: '{"received":true}',
      now: base,
    });

    expect(result.available).toBe(true);
    expect(result.targetCount).toBe(2);
    expect(result.cleaned).toBe(2);
    expect(result.retained).toBe(0);
    expect(result.items.map((item) => item.backupId)).toEqual(['backup-1', 'backup-2']);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(false);

    const cleanedPatch = updates.find((entry) => entry.patch['localStatus'] === 'CLEANED');
    expect(cleanedPatch?.patch).toMatchObject({
      localStatus: 'CLEANED',
      localReference: null,
      deletedAt: base,
    });
    // 删除前先落 CLEANING：中断可辨认
    expect(updates.some((entry) => entry.patch['localStatus'] === 'CLEANING')).toBe(true);
    expect(runUpdates).toHaveLength(1);
    expect(runUpdates[0].patch).toMatchObject({ manualCleanupStatus: 'SUCCEEDED' });
  });

  it('路径越界的资产一律保留，且不触碰越界目录中的文件', async () => {
    const sentinel = nodePath.join(originalRoot, 'business-original.bin');
    await writeFile(sentinel, '原件不可删除', 'utf8');
    const { service, updates } = buildService([asset({ localReference: sentinel })]);

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: '{"received":true}',
      now: base,
    });

    expect(result.cleaned).toBe(0);
    expect(result.retained).toBe(1);
    expect(result.items[0].outcome).toBe('RETAINED');
    expect(updates.some((entry) => entry.patch['localStatus'] === 'FAILED')).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('原件不可删除');
  });

  it('清理本公司包时外公司包与业务原件哨兵不变', async () => {
    const own = await createPackage('4/manual-1', ['a.txt']);
    const otherCompany = await createPackage('5/manual-9', ['other.txt']);
    const sentinel = nodePath.join(originalRoot, 'keep.bin');
    await writeFile(sentinel, '原件不可删除', 'utf8');

    const { service } = buildService([
      asset({ backupId: 'backup-1', localReference: own }),
      asset({ backupId: 'backup-2', organizationId: 5, localReference: otherCompany }),
    ]);

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: '{"received":true}',
      now: base,
    });

    expect(result.cleaned).toBe(1);
    expect(await exists(own)).toBe(false);
    expect(await exists(otherCompany)).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('原件不可删除');
  });

  it('删除失败时保留包并落失败原因，不误标为已清理', async () => {
    const packagePath = await createPackage('4/manual-1', ['a.txt']);
    const { service, updates } = buildService(
      [asset({ localReference: packagePath })],
      FailingDeleteService,
    );

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: '{"received":true}',
      now: base,
    });

    expect(result.cleaned).toBe(0);
    expect(result.retained).toBe(1);
    expect(result.items[0].outcome).toBe('RETAINED');
    expect(result.items[0].reason).toContain('本地包删除失败');
    expect(updates.some((entry) => entry.patch['localStatus'] === 'FAILED')).toBe(true);
    expect(updates.some((entry) => entry.patch['localStatus'] === 'CLEANED')).toBe(false);
    // 包被保留，未被误删
    expect(await exists(packagePath)).toBe(true);
  });

  it('包目录已不存在时视为清理目标成立（事实可辨认）', async () => {
    const packagePath = await createPackage('4/manual-1', ['a.txt']);
    const { service, updates } = buildService([asset({ localReference: packagePath })]);
    await rm(packagePath, { recursive: true, force: true });

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: '{"received":true}',
      now: base,
    });

    expect(result.cleaned).toBe(1);
    expect(updates.some((entry) => entry.patch['localStatus'] === 'CLEANED')).toBe(true);
  });

  it('清理中断可辨认：残留 CLEANING 登记中断原因并在本轮重试', async () => {
    const packagePath = await createPackage('4/manual-1', ['a.txt']);
    const { service, updates } = buildService([
      asset({
        localStatus: 'CLEANING',
        localReference: packagePath,
        updatedAt: new Date(base.getTime() - 60 * 60_000),
      }),
    ]);

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      cloudReceipt: '{"received":true}',
      now: base,
    });

    const interrupted = updates.find((entry) =>
      (entry.patch['localCleanupError'] as string | undefined)?.includes('中断'),
    );
    expect(interrupted).toBeDefined();
    expect(result.cleaned).toBe(1);
    expect(await exists(packagePath)).toBe(false);
  });

  it('过期清理：到期且云副本可证才清理，未到期与无云副本都不动', async () => {
    const expired = await createPackage('4/manual-old', ['old.txt']);
    const fresh = await createPackage('4/manual-fresh', ['fresh.txt']);
    const noCloud = await createPackage('4/manual-nocloud', ['nocloud.txt']);

    const { service } = buildService([
      asset({
        backupId: 'backup-old',
        localReference: expired,
        retentionUntil: new Date(base.getTime() - 86_400_000),
      }),
      asset({
        backupId: 'backup-fresh',
        localReference: fresh,
        retentionUntil: new Date(base.getTime() + 86_400_000),
      }),
      asset({
        backupId: 'backup-nocloud',
        localReference: noCloud,
        retentionUntil: new Date(base.getTime() - 86_400_000),
        cloudStatus: 'PENDING',
        cloudReceipt: null,
      }),
    ]);

    const result = await service.cleanupExpiredPackages({
      organizationId: 4,
      installationId: 'inst-1',
      now: base,
    });

    expect(result.targetCount).toBe(1);
    expect(result.cleaned).toBe(1);
    expect(await exists(expired)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(noCloud)).toBe(true);
  });

  it('手动清理的授权来源取自服务端已落库的完整回执，不接受客户端传入', async () => {
    const { service } = buildService([
      asset({ backupId: 'backup-1', cloudStatus: 'PENDING', cloudReceipt: null }),
      asset({ backupId: 'backup-2', cloudReceipt: '{"received":true}' }),
    ]);

    const found = await service.findLatestCompleteCloudReceipt({
      organizationId: 4,
      installationId: 'inst-1',
    });

    expect(found?.backupId).toBe('backup-2');
  });

  it('没有任何完整回执时授权来源为空', async () => {
    const { service } = buildService([asset({ cloudReceipt: null })]);

    const found = await service.findLatestCompleteCloudReceipt({
      organizationId: 4,
      installationId: 'inst-1',
    });

    expect(found).toBeNull();
  });

  it('30 天保留窗口边界：恰好到期即清理，早 1ms 不清理（到期判定用 <=now）', async () => {
    const exactly = await createPackage('4/manual-exact', ['exact.txt']);
    const almost = await createPackage('4/manual-almost', ['almost.txt']);

    const { service } = buildService([
      asset({
        backupId: 'backup-exact',
        localReference: exactly,
        retentionUntil: new Date(base.getTime()),
      }),
      asset({
        backupId: 'backup-almost',
        localReference: almost,
        retentionUntil: new Date(base.getTime() + 1),
      }),
    ]);

    const result = await service.cleanupExpiredPackages({
      organizationId: 4,
      installationId: 'inst-1',
      now: base,
    });

    expect(result.targetCount).toBe(1);
    expect(result.cleaned).toBe(1);
    expect(await exists(exactly)).toBe(false);
    expect(await exists(almost)).toBe(true);
  });
});

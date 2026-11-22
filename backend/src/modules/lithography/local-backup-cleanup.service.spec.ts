// src/modules/lithography/local-backup-cleanup.service.spec.ts
// 本地备份包清理执行层单测（任务 09 S3.3）。
//
// 用真实文件系统构造受保护包目录与哨兵文件，验证：
// - 无完整云回执时零清理（不删目录、不改资产状态）；
// - 有完整云回执时按固定范围逐项删除，结果逐项落库；
// - 手动清理的授权只认「本次手动备份」的回执，不回落用旧包回执；
// - 路径越界一律拒绝删除（业务原件与外公司哨兵不变）；
// - 删除失败时保留包并落失败原因；
// - 清理中断可辨认并可重试；
// - 过期清理的到期／未到期分支（云副本不是清理门槛）。

import { mkdtemp, mkdir, rm, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { LocalBackupCleanupService } from './local-backup-cleanup.service';
import type { BackupAssetEntity } from './entities/backup-asset.entity';
import { asPinoLogger, createTestPinoLogger } from '../../../test/utils/test-pino-logger';

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

  /** 手动运行事实（授权来源按「本次手动备份」定位） */
  type ManualRunFact = {
    id: number;
    organizationId: number;
    installationId: string;
    triggerType: string;
    manualUploadStatus: string | null;
  };

  function buildService(
    rows: BackupAssetEntity[],
    serviceClass: typeof LocalBackupCleanupService = LocalBackupCleanupService,
    manualRuns: ManualRunFact[] = [],
    options: { withoutRunRepository?: boolean } = {},
  ) {
    const updates: { backupId: string; patch: Record<string, unknown> }[] = [];
    const runUpdates: { id: number; patch: Record<string, unknown> }[] = [];

    const backupAssetRepository = {
      find: jest
        .fn()
        .mockImplementation(
          (input?: { where?: Record<string, unknown>; order?: Record<string, unknown> }) => {
            const where = input?.where ?? {};
            const matched = rows.filter((row) =>
              Object.entries(where).every(
                ([key, value]) => row[key as keyof BackupAssetEntity] === value,
              ),
            );
            const direction = (input?.order?.['createdAt'] as 'ASC' | 'DESC' | undefined) ?? 'ASC';
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
      find: jest.fn().mockImplementation((input: { where: Record<string, unknown> }) => {
        const where = input.where ?? {};
        const matched = manualRuns.filter((row) =>
          Object.entries(where).every(([key, value]) => row[key as keyof ManualRunFact] === value),
        );
        return Promise.resolve([...matched].sort((left, right) => right.id - left.id));
      }),
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
      asPinoLogger(createTestPinoLogger()),
      options.withoutRunRepository ? undefined : (backupRunRepository as never),
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

  // 任务书 R074-03：取得完整云回执后清理**本设备本公司固定范围内的全部**本地备份包，
  // **不额外要求每个旧包都单独有云副本**。
  it('手动清理按固定范围清理全部本地包：未单独上云的旧包也一并清理', async () => {
    const uploaded = await createPackage('4/manual-1', ['a.txt']);
    const notUploaded = await createPackage('4/manual-2', ['b.txt']);
    const { service, updates } = buildService([
      asset({ backupId: 'backup-1', localReference: uploaded }),
      asset({
        backupId: 'backup-2',
        localReference: notUploaded,
        cloudReceipt: null,
        cloudStatus: 'PENDING',
      }),
    ]);

    const result = await service.cleanupManualPackages({
      organizationId: 4,
      installationId: 'inst-1',
      // 授权层：本次手动备份已取得完整回执
      cloudReceipt: '{"received":true}',
      now: base,
    });

    expect(result.available).toBe(true);
    expect(result.targetCount).toBe(2);
    expect(result.cleaned).toBe(2);
    expect(result.retained).toBe(0);
    expect(await exists(uploaded)).toBe(false);
    expect(await exists(notUploaded)).toBe(false);
    // 两项都落了 CLEANED 事实
    expect(updates.filter((entry) => entry.patch['localStatus'] === 'CLEANED')).toHaveLength(2);
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
    expect(result.items[0].reason).toContain('LOCAL_PACKAGE_DELETE_FAILED');
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
      (entry.patch['localCleanupError'] as string | undefined)?.includes(
        'LOCAL_CLEANUP_INTERRUPTED',
      ),
    );
    expect(interrupted).toBeDefined();
    expect(result.cleaned).toBe(1);
    expect(await exists(packagePath)).toBe(false);
  });

  // review M8 重启补偿：孤儿包巡检
  it('孤儿包巡检：回收没有资产引用的旧半成品包，保留被引用的包', async () => {
    const orphanDir = nodePath.join(backupRoot, '4', 'manual-orphan');
    const referencedDir = nodePath.join(backupRoot, '4', 'manual-referenced');
    const freshOrphanDir = nodePath.join(backupRoot, '4', 'manual-fresh-orphan');
    for (const dir of [orphanDir, referencedDir, freshOrphanDir]) {
      await mkdir(dir, { recursive: true });
      await writeFile(nodePath.join(dir, 'manifest.json'), '{}', 'utf8');
    }
    // 旧到足以判定为孤儿（默认阈值 24 小时）
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(orphanDir, old, old);
    await utimes(referencedDir, old, old);

    const { service } = buildService([
      asset({ backupId: 'backup-kept', localReference: referencedDir }),
    ]);

    const result = await service.sweepOrphanPackages();

    expect(result.removed).toBe(1);
    expect(await exists(orphanDir)).toBe(false);
    // 被资产引用的包不动
    expect(await exists(referencedDir)).toBe(true);
    // 新鲜目录可能仍在生成中：不碰
    expect(await exists(freshOrphanDir)).toBe(true);
  });

  it('孤儿包巡检：没有运行事实可比对时不动磁盘', async () => {
    const orphanDir = nodePath.join(backupRoot, '4', 'manual-orphan');
    await mkdir(orphanDir, { recursive: true });
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(orphanDir, old, old);

    // 去掉运行仓储：无法比对运行事实时宁留孤儿
    const { service } = buildService([], LocalBackupCleanupService, [], {
      withoutRunRepository: true,
    });

    const result = await service.sweepOrphanPackages();

    expect(result).toEqual({ scanned: 0, removed: 0 });
    expect(await exists(orphanDir)).toBe(true);
  });

  it('过期清理：到期即清理（云副本不是门槛），未到期不动', async () => {
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

    // 到期的两份都清理（其中一份没有云副本：云副本不是清理门槛）
    expect(result.targetCount).toBe(2);
    expect(result.cleaned).toBe(2);
    expect(await exists(expired)).toBe(false);
    expect(await exists(noCloud)).toBe(false);
    // 未到期不动
    expect(await exists(fresh)).toBe(true);
  });

  it('手动清理的授权来源只认「本次手动备份」的完整回执，不接受客户端传入', async () => {
    const { service } = buildService(
      [
        asset({ backupId: 'backup-1', runId: 10, cloudStatus: 'PENDING', cloudReceipt: null }),
        asset({ backupId: 'backup-2', runId: 11, cloudReceipt: '{"received":true}' }),
      ],
      LocalBackupCleanupService,
      [
        {
          id: 11,
          organizationId: 4,
          installationId: 'inst-1',
          triggerType: 'MANUAL',
          manualUploadStatus: 'SUCCEEDED',
        },
      ],
    );

    const found = await service.findManualRunCloudReceipt({
      organizationId: 4,
      installationId: 'inst-1',
    });

    expect(found?.backupId).toBe('backup-2');
  });

  it('本次手动备份未取得完整回执时授权来源为空：不回落用旧包回执', async () => {
    const { service } = buildService(
      [
        asset({ backupId: 'backup-old', runId: 9, cloudReceipt: '{"received":true}' }),
        asset({
          backupId: 'backup-latest',
          runId: 10,
          cloudStatus: 'PENDING',
          cloudReceipt: null,
        }),
      ],
      LocalBackupCleanupService,
      [
        {
          id: 10,
          organizationId: 4,
          installationId: 'inst-1',
          triggerType: 'MANUAL',
          manualUploadStatus: 'PENDING',
        },
      ],
    );

    const found = await service.findManualRunCloudReceipt({
      organizationId: 4,
      installationId: 'inst-1',
    });

    expect(found).toBeNull();
  });

  it('没有手动运行时授权来源为空', async () => {
    const { service } = buildService([asset({ cloudReceipt: '{"received":true}' })]);

    const found = await service.findManualRunCloudReceipt({
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

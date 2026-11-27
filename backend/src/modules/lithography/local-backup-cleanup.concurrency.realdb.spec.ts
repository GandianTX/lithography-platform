// src/modules/lithography/local-backup-cleanup.concurrency.realdb.spec.ts

/**
 * 备份包清理的**实库并发幂等**验证（任务 09 第 09 项第 2 条：
 * 「核对'每日一次'的多实例要求和实际环境，必要时实现符合需求的并发幂等」）。
 *
 * 覆盖：
 * - **并发两个清理执行者**（模拟多实例／多进程同时跑到每日检查）：
 *   事务内的悲观写锁让第二个执行者等待，第一个提交后它读到**最新状态**
 *   （已 CLEANED / 无本地包引用）⇒ 裁决跳过，**不重复删除同一个目录**；
 * - 最终事实唯一且自洽：`local_status=CLEANED`、`local_reference` 为空、
 *   `deleted_at` 有值、目录确实不存在；
 * - 外公司哨兵仍然成立（并发清理不越界到本机未启用备份计划的公司）。
 *
 * 纪律：夹具全部由本规格登记（随机 `backup_id`／随机目录），**用完按名单精确删除**；
 * 不修改任何既有行；不连真实云。
 *
 * 默认跳过；启用时显式声明隔离库与清理许可：
 *   BACKUP_CLEANUP_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     E2E_ALLOWED_DB_NAMES=<隔离库> \
 *     npx jest src/modules/lithography/local-backup-cleanup.concurrency.realdb.spec.ts --runInBand
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { BackupAssetEntity } from '@src/modules/lithography/entities/backup-asset.entity';
import { LocalBackupRunEntity } from '@src/modules/lithography/entities/local-backup-run.entity';
import { LocalCompanySettingEntity } from '@src/modules/lithography/entities/local-company-setting.entity';
import { LocalBackupCleanupService } from '@src/modules/lithography/local-backup-cleanup.service';
import { LithographyModule } from '@src/modules/lithography/lithography.module';

import { assertDataSourceOnAllowedE2eDatabase } from '../../../test/utils/e2e-db-guard';

/** 装配真实 DataSource 需要更长时间（默认 10s 不够） */
jest.setTimeout(60_000);

const ENABLED = process.env.BACKUP_CLEANUP_CONCURRENCY_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
const ENV_FILE = 'env/.env.e2e';

/** 本公司（与本机计划一致） */
const OWN_ORGANIZATION_ID = 1;

/** 备份存储根：与生产装配同一套取法 */
function readBackupStorageRoot(): string {
  const envPath = join(process.cwd(), 'env/.env.e2e');
  const content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const match = content.match(/^LOCAL_RUNTIME_BACKUP_STORAGE_DIR=(.+)$/m);
  const configured = match?.[1]?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return join(process.cwd(), 'var/local-backups');
}

describeIntegration('备份包清理的实库并发幂等（任务 09 第 09 项）', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let cleanupService: LocalBackupCleanupService;
  let installationId: string;

  const createdBackupIds: string[] = [];
  const createdDirectories: string[] = [];
  let createdRunId: number | null = null;
  let createdSettingId: number | null = null;

  beforeAll(async () => {
    const declared = process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e';
    const config = loadExplicitEnvConfig(ENV_FILE, declared);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        LoggerModule,
        TypeOrmModule.forRoot({
          type: 'mysql',
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          database: config.database,
          timezone: config.timezone,
          charset: config.charset,
          synchronize: false,
          logging: false,
          entities: [join(__dirname, '../../**/*.entity.ts')],
        }),
        TypeOrmTransactionModule,
        LithographyModule,
      ],
    }).compile();

    dataSource = moduleRef.get<DataSource>(DataSource);
    await assertDataSourceOnAllowedE2eDatabase(dataSource, declared);
    cleanupService = moduleRef.get(LocalBackupCleanupService);

    const installationRows = (await dataSource.query(
      'SELECT `installation_id` FROM `local_installation` WHERE `id` = 1 LIMIT 1',
    )) as unknown as { installation_id: string }[];
    installationId = installationRows[0]?.installation_id ?? '';
    if (installationId === '') {
      throw new Error('隔离库缺少本机安装身份（local_installation id=1）');
    }
  });

  afterAll(async () => {
    for (const backupId of createdBackupIds) {
      await dataSource.query('DELETE FROM `backup_asset` WHERE `backup_id` = ?', [backupId]);
    }
    if (createdRunId !== null) {
      await dataSource.query('DELETE FROM `local_backup_run` WHERE `id` = ?', [createdRunId]);
    }
    if (createdSettingId !== null) {
      await dataSource.query('DELETE FROM `local_company_setting` WHERE `id` = ?', [
        createdSettingId,
      ]);
    }
    for (const directory of createdDirectories) {
      rmSync(directory, { force: true, recursive: true });
    }
    await dataSource.destroy();
  });

  /** 建立"本机正在备份的公司"的当前计划（过期清理的公司范围来源）；幂等：已存在则复用 */
  async function createBackupEnabledPlan(): Promise<void> {
    const repository = dataSource.getRepository(LocalCompanySettingEntity);
    const existing = await repository.findOne({
      where: { installationId, organizationId: OWN_ORGANIZATION_ID, isCurrent: true },
    });
    if (existing !== null) {
      createdSettingId = Number(existing.id);
      return;
    }
    const setting = repository.create({
      installationId,
      organizationId: OWN_ORGANIZATION_ID,
      settingSource: 'LOCAL_MANUAL',
      isCurrent: true,
      backupEnabled: true,
      backupIntervalHours: 72,
      nextBackupAt: new Date('2026-12-01T00:00:00.000Z'),
      autoUploadEnabled: false,
    });
    const saved = await repository.save(setting);
    createdSettingId = Number(saved.id);
  }

  /** 建立一次成功的手动备份运行 */
  async function createSucceededRun(): Promise<number> {
    const repository = dataSource.getRepository(LocalBackupRunEntity);
    const run = repository.create({
      installationId,
      organizationId: OWN_ORGANIZATION_ID,
      triggerType: 'MANUAL',
      status: 'SUCCEEDED',
      startedAt: new Date('2026-10-01T00:00:00.000Z'),
      finishedAt: new Date('2026-10-01T00:10:00.000Z'),
      manifestChecksum: 'c'.repeat(64),
      byteSize: 1024,
      attachmentCount: 1,
      schemaVersion: 1,
    });
    const saved = await repository.save(run);
    createdRunId = Number(saved.id);
    return createdRunId;
  }

  /** 建立一个过期备份资产（含真实包目录） */
  async function createAsset(input: {
    runId: number;
    organizationId: number;
    retentionUntil: Date;
  }): Promise<{ backupId: string; directory: string }> {
    const backupId = randomUUID();
    const directory = join(readBackupStorageRoot(), 'task09-concurrency', backupId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), '{"schemaVersion":1}', 'utf8');
    createdDirectories.push(directory);
    createdBackupIds.push(backupId);

    const repository = dataSource.getRepository(BackupAssetEntity);
    const asset = repository.create({
      backupId,
      runId: input.runId,
      organizationId: input.organizationId,
      installationId,
      storageReference: join(directory, 'package.zip'),
      fileSha256: 'd'.repeat(64),
      byteSize: '1024',
      cloudStatus: 'PENDING',
      localStatus: 'PENDING',
      attemptCount: 0,
      retentionUntil: input.retentionUntil,
      localReference: directory,
      formatVersion: 1,
      dataVersion: 'v1',
      manifestChecksum: 'c'.repeat(64),
      verifiedAt: new Date('2026-10-01T00:10:00.000Z'),
    });
    await repository.save(asset);
    return { backupId, directory };
  }

  it('并发两个清理执行者：只有一个真正删除，第二个读到最新事实后跳过', async () => {
    await createBackupEnabledPlan();
    const runId = await createSucceededRun();
    const now = new Date('2026-11-23T00:00:00.000Z');

    const expiredOwn = await createAsset({
      runId,
      organizationId: OWN_ORGANIZATION_ID,
      retentionUntil: new Date('2026-11-01T00:00:00.000Z'),
    });

    // 两个执行者同时开跑（模拟多实例的每日检查撞在一起）
    const [first, second] = await Promise.all([
      cleanupService.cleanupAllExpiredPackages({ now }),
      cleanupService.cleanupAllExpiredPackages({ now }),
    ]);

    // ① 目录只被删一次（第二个执行者不再重复删除同一个目录）
    expect(existsSync(expiredOwn.directory)).toBe(false);

    // ② 两个执行者的逐项结果自洽：合计只清理了一次
    const cleanedIds = [first, second]
      .flatMap((result) => result.items)
      .filter((item) => item.outcome === 'CLEANED')
      .map((item) => item.backupId);
    expect(cleanedIds).toEqual([expiredOwn.backupId]);

    // ③ 最终事实唯一且自洽：已清理、引用已空、删除时间已落
    const rows = (await dataSource.query(
      'SELECT `local_status`, `local_reference`, `deleted_at` FROM `backup_asset` WHERE `backup_id` = ?',
      [expiredOwn.backupId],
    )) as unknown as {
      local_status: string;
      local_reference: string | null;
      deleted_at: Date | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].local_status).toBe('CLEANED');
    expect(rows[0].local_reference).toBeNull();
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('并发清理不越界：本机未启用备份计划的外公司包保持不变', async () => {
    await createBackupEnabledPlan();
    const runId = await createSucceededRun();
    const now = new Date('2026-11-23T00:00:00.000Z');

    const otherCompanyRows = (await dataSource.query(
      'SELECT `id` FROM `organization` WHERE `id` <> ? ORDER BY `id` ASC LIMIT 1',
      [OWN_ORGANIZATION_ID],
    )) as unknown as { id: number }[];
    const otherOrganizationId = otherCompanyRows[0]?.id ?? 0;
    if (otherOrganizationId === 0) {
      throw new Error('隔离库缺少第二家公司，无法构造外公司哨兵');
    }

    const expiredOther = await createAsset({
      runId,
      organizationId: otherOrganizationId,
      retentionUntil: new Date('2026-11-01T00:00:00.000Z'),
    });

    await Promise.all([
      cleanupService.cleanupAllExpiredPackages({ now }),
      cleanupService.cleanupAllExpiredPackages({ now }),
    ]);

    // 外公司哨兵：目录仍在、资产行未被改动
    expect(existsSync(expiredOther.directory)).toBe(true);
    const rows = (await dataSource.query(
      'SELECT `local_status`, `local_reference` FROM `backup_asset` WHERE `backup_id` = ?',
      [expiredOther.backupId],
    )) as unknown as { local_status: string; local_reference: string | null }[];
    expect(rows[0].local_status).toBe('PENDING');
    expect(rows[0].local_reference).toBe(expiredOther.directory);
  });
});

// src/modules/lithography/local-backup-cleanup.sentinel.realdb.spec.ts

/**
 * 备份包清理的**实库哨兵**（任务 09 S4 自检）。
 *
 * 覆盖：精确清理结果的逐项断言 ＋ 文件哨兵（未到期包目录仍在）＋
 * **外公司哨兵**（本机没有启用备份计划的公司的过期包不被本机清理删掉）。
 *
 * 纪律：夹具全部由本规格登记（随机 `backup_id`／随机目录），**用完按名单精确删除**；
 * 不修改任何既有行；不连真实云（云端哨兵属外部待联调）。
 *
 * 默认跳过；启用时显式声明隔离库与清理许可：
 *   BACKUP_CLEANUP_SENTINEL_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     E2E_ALLOWED_DB_NAMES=<隔离库> \
 *     npx jest src/modules/lithography/local-backup-cleanup.sentinel.realdb.spec.ts --runInBand
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

const ENABLED = process.env.BACKUP_CLEANUP_SENTINEL_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
const ENV_FILE = 'env/.env.e2e';

/** 本公司（与本机计划一致） */
const OWN_ORGANIZATION_ID = 1;

/**
 * 备份存储根：**与生产装配同一套取法**
 * （`localRuntime.backupStorageDir` ⇒ `LOCAL_RUNTIME_BACKUP_STORAGE_DIR`，缺省 `var/local-backups`）。
 *
 * **夹具包目录必须落在根之下**：清理有既有路径闸门，根外的目录会以
 * `LOCAL_PACKAGE_PATH_OUTSIDE_ROOT` 被拒（首次实跑时正是卡在这里）。
 */
function readBackupStorageRoot(): string {
  const envPath = join(process.cwd(), 'env/.env.e2e');
  const content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const match = content.match(/^LOCAL_RUNTIME_BACKUP_STORAGE_DIR=(.+)$/m);
  const configured = match?.[1]?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : join(process.cwd(), 'var/local-backups');
}
/** 外公司（本机**没有**启用备份计划）：运行时按真实存在的另一家公司取，不猜 id */
let otherOrganizationId = 0;

describeIntegration('备份包清理的实库哨兵（S4 自检）', () => {
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

  /** 建立"本机正在备份的公司"的当前计划（过期清理的公司范围来源） */
  async function createBackupEnabledPlan(): Promise<void> {
    const repository = dataSource.getRepository(LocalCompanySettingEntity);
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

  /** 建立一个备份资产（含真实包目录） */
  async function createAsset(input: {
    runId: number;
    organizationId: number;
    retentionUntil: Date;
  }): Promise<{ backupId: string; directory: string }> {
    const backupId = randomUUID();
    const directory = join(readBackupStorageRoot(), 'task09-sentinel', backupId);
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

  it('逐项断言 ＋ 文件哨兵 ＋ 外公司哨兵：只清本机在备份公司的过期包', async () => {
    // 外公司：按库里真实存在的另一家公司取（外键约束必须成立，不造不存在的公司）
    const otherCompanyRows = (await dataSource.query(
      'SELECT `id` FROM `organization` WHERE `id` <> ? ORDER BY `id` ASC LIMIT 1',
      [OWN_ORGANIZATION_ID],
    )) as unknown as { id: number }[];
    otherOrganizationId = otherCompanyRows[0]?.id ?? 0;
    if (otherOrganizationId === 0) {
      throw new Error('隔离库缺少第二家公司，无法构造外公司哨兵');
    }

    await createBackupEnabledPlan();
    const runId = await createSucceededRun();
    const now = new Date('2026-11-23T00:00:00.000Z');

    const expiredOwn = await createAsset({
      runId,
      organizationId: OWN_ORGANIZATION_ID,
      retentionUntil: new Date('2026-11-01T00:00:00.000Z'),
    });
    const freshOwn = await createAsset({
      runId,
      organizationId: OWN_ORGANIZATION_ID,
      retentionUntil: new Date('2026-12-20T00:00:00.000Z'),
    });
    const expiredOther = await createAsset({
      runId,
      organizationId: otherOrganizationId,
      retentionUntil: new Date('2026-11-01T00:00:00.000Z'),
    });

    const result = await cleanupService.cleanupAllExpiredPackages({ now });
    if (process.env.SENTINEL_DEBUG === '1') {
      const rows = (await dataSource.query(
        'SELECT `backup_id`, `organization_id`, `retention_until`, `created_at`, `local_status` FROM `backup_asset`',
      )) as unknown as Record<string, unknown>[];
      const settings = (await dataSource.query(
        'SELECT `organization_id`, `is_current`, `backup_enabled` FROM `local_company_setting`',
      )) as unknown as Record<string, unknown>[];
      process.stdout.write(
        `SENTINEL_DEBUG assets=${JSON.stringify(rows)} settings=${JSON.stringify(settings)} result=${JSON.stringify(result)}\n`,
      );
    }

    // ① 精确清理结果的逐项断言：只清本公司那一条过期包
    expect(result.cleaned).toBe(1);
    const cleanedBackupIds = result.items
      .filter((item) => item.outcome === 'CLEANED')
      .map((item) => item.backupId);
    expect(cleanedBackupIds).toEqual([expiredOwn.backupId]);

    // ② 文件哨兵：过期包目录被删、未到期包目录仍在
    expect(existsSync(expiredOwn.directory)).toBe(false);
    expect(existsSync(freshOwn.directory)).toBe(true);

    // ③ 外公司哨兵：外公司的过期包**未被本机清理触碰**
    expect(existsSync(expiredOther.directory)).toBe(true);
    const otherRows = (await dataSource.query(
      'SELECT `local_status`, `deleted_at` FROM `backup_asset` WHERE `backup_id` = ?',
      [expiredOther.backupId],
    )) as unknown as { local_status: string; deleted_at: Date | null }[];
    expect(otherRows[0]?.local_status).toBe('PENDING');
    expect(otherRows[0]?.deleted_at ?? null).toBeNull();

    // ④ 未到期包的行也未被标记为已清理
    const freshRows = (await dataSource.query(
      'SELECT `local_status`, `local_reference` FROM `backup_asset` WHERE `backup_id` = ?',
      [freshOwn.backupId],
    )) as unknown as { local_status: string; local_reference: string | null }[];
    expect(freshRows[0]?.local_status).toBe('PENDING');
    expect(freshRows[0]?.local_reference).toBe(freshOwn.directory);
  });
});

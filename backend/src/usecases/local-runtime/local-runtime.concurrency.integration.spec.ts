/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { LocalUploadTaskInsertData } from '@src/modules/lithography/local-runtime.types';
import {
  assertManagerOnExpectedE2eDatabase,
  assertPhysicalCleanupConsent,
} from '../../../test/utils/e2e-db-guard';
import {
  assertRegisteredRowsAbsent,
  finalizeFixtureTeardown,
  OwnedFixtureLedger,
  prepareFixtureSetup,
  runOwnedFixtureCleanup,
} from '../../../test/utils/e2e-owned-fixture';
import { runTwoBranchTransactionRace } from '../../../test/utils/upload-race-runner';
import { join } from 'path';
import { DataSource, type QueryRunner } from 'typeorm';
import { LocalRuntimeUsecasesModule } from './local-runtime-usecases.module';
import { UpdateLocalRuntimeSettingsUsecase } from './update-local-runtime-settings.usecase';

/**
 * 本地运行数据真实 MySQL 并发验收（上传幂等入队、设置补丁合并）。
 *
 * 默认跳过；启用时必须显式声明隔离库与清理许可：
 *   LOCAL_RUNTIME_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     npx jest src/usecases/local-runtime/local-runtime.concurrency.integration.spec.ts --runInBand
 *
 * 竞争同步点来自真实锁等待（performance_schema.data_lock_waits），
 * 不使用固定 sleep 猜测执行顺序。
 *
 * 夹具策略：环境门禁通过后才允许写入；上传任务按返回 ID 立即登记，
 * 清理只按登记 ID 精确删除；安装设置按原始值受控恢复，不删除任何共享行。
 */
const ENABLED = process.env.LOCAL_RUNTIME_CONCURRENCY_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

const ENV_FILE = 'env/.env.e2e';
const ROUND_TAG = 'LOCAL-RUNTIME-CONC';
const FIXTURE_KEYS = [
  'CONC-S5C-SAME-KEY',
  'CONC-S5C-TARGET-A',
  'CONC-S5C-TARGET-B',
  'CONC-PARTIAL-OK',
];
const FIXTURE_ENTITY_LOCAL_ID = 9904621;
const SETTINGS_SITE_NAME = 'S5C 并发站点';

const SETTINGS_SESSION: UsecaseSession = {
  accountId: 9904601,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as UsecaseSession;

type InstallationOrigin = {
  local_site_name: string | null;
  auto_upload_enabled: boolean | number;
  backup_interval_days: number;
  updated_at: Date;
};

jest.setTimeout(180_000);

describeIntegration('本地运行数据真实并发验收', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let localRuntimeService: LocalRuntimeService;
  let updateSettingsUsecase: UpdateLocalRuntimeSettingsUsecase;
  let installationId = '';
  let originalInstallation: InstallationOrigin | null = null;
  let settingsInterval: number | null = null;
  let setupAllowed = false;
  let expectedDatabase = '';
  const ledger = new OwnedFixtureLedger(ROUND_TAG);

  const query = async <T = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> => dataSource.query<T[]>(sql, parameters);

  const readLockWaiterCount = async (): Promise<number> => {
    const rows = await query<{ total: number | string }>(
      'SELECT COUNT(DISTINCT REQUESTING_THREAD_ID) AS total FROM performance_schema.data_lock_waits',
    );
    return Number(rows[0]?.total ?? 0);
  };

  const waitForLockWaiters = async (expected: number, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let observed = 0;
    while (Date.now() < deadline) {
      observed = await readLockWaiterCount();
      if (observed >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`等待锁竞争超时：期望 ${expected} 个等待者，实际观察到 ${observed} 个。`);
  };

  const readOriginInstallation = async (): Promise<InstallationOrigin> => {
    const rows = await query<InstallationOrigin>(
      `SELECT local_site_name, auto_upload_enabled, backup_interval_days, updated_at
         FROM local_installation WHERE id = 1`,
    );
    if (!rows[0]) {
      throw new Error('隔离库缺少本地安装身份（local_installation id=1），拒绝继续。');
    }
    return rows[0];
  };

  /** 固定幂等键/目标版本已被占用时不创建、不覆盖，直接失败保留原数据 */
  const assertFixtureKeysAvailable = async (): Promise<void> => {
    const rows = await query<{ id: number }>(
      `SELECT id FROM local_upload_task
        WHERE idempotency_key IN (${FIXTURE_KEYS.map(() => '?').join(', ')})
           OR (installation_id = ? AND entity_local_id = ?)`,
      [...FIXTURE_KEYS, installationId, FIXTURE_ENTITY_LOCAL_ID],
    );
    if (rows.length > 0) {
      throw new Error(
        `上传任务夹具键已被占用（${rows.map((row) => row.id).join(', ')}），拒绝创建并保留原数据。`,
      );
    }
  };

  type UploadRaceOutcome = { taskId: number; created: boolean };
  type UploadRaceRawResult = { task: { id: number }; created: boolean };

  /** 把竞争分支的原始入队结果转换为断言用结果 */
  const toUploadRaceOutcome = (
    settled: PromiseSettledResult<UploadRaceRawResult>,
  ): PromiseSettledResult<UploadRaceOutcome> =>
    settled.status === 'fulfilled'
      ? {
          status: 'fulfilled',
          value: { taskId: settled.value.task.id, created: settled.value.created },
        }
      : settled;

  /** 提交成功后按实际 ID 登记；未创建任务的竞争分支不重复登记 */
  const registerCommittedTask = async (result: UploadRaceRawResult): Promise<void> => {
    if (result.created) {
      await ledger.registerById(query, 'local_upload_task', result.task.id);
    }
  };

  const describeSettledReason = (reason: unknown): string =>
    reason instanceof Error ? reason.message : String(reason);

  const assertNoRaceTeardownErrors = (errors: readonly string[]): void => {
    if (errors.length > 0) {
      throw new Error(`上传竞争分支收尾失败：${errors.join('；')}`);
    }
  };

  /**
   * 用两条独立事务调用真实模块服务：先让 A 完成插入但不提交，
   * 再让 B 在唯一键上等待，最后放行 A 提交，验证 B 的冲突后锁定回读路径。
   * 连接、事务、等待与释放均由统一竞争执行器托管，异常路径不提交。
   */
  const runUploadRace = async (
    first: Omit<LocalUploadTaskInsertData, 'installationId'>,
    second: Omit<LocalUploadTaskInsertData, 'installationId'>,
  ): Promise<
    [PromiseSettledResult<UploadRaceOutcome>, PromiseSettledResult<UploadRaceOutcome>]
  > => {
    const race = await runTwoBranchTransactionRace<UploadRaceRawResult>({
      createRunner: () => dataSource.createQueryRunner(),
      runFirst: (runner) =>
        localRuntimeService.enqueueUploadTask(
          { installationId, ...first },
          createTypeOrmPersistenceTransactionContext(runner.manager),
        ),
      runSecond: (runner) =>
        localRuntimeService.enqueueUploadTask(
          { installationId, ...second },
          createTypeOrmPersistenceTransactionContext(runner.manager),
        ),
      waitForCompetition: () => waitForLockWaiters(1),
      onFirstCommitted: registerCommittedTask,
      onSecondCommitted: registerCommittedTask,
    });
    assertNoRaceTeardownErrors(race.errors);
    return [toUploadRaceOutcome(race.first), toUploadRaceOutcome(race.second)];
  };

  const expectFulfilled = (
    result: PromiseSettledResult<UploadRaceOutcome>,
    label: string,
  ): UploadRaceOutcome => {
    if (result.status !== 'fulfilled') {
      throw new Error(`${label} 执行失败：${describeSettledReason(result.reason)}`);
    }
    return result.value;
  };

  /**
   * 恢复安装设置：同一事务内先锁定行、核验当前值只可能是「原始值」或「本轮设置用例写入值」，
   * 再按原始值写回并在同一连接内核对；任一步不符即放弃写入，避免覆盖他人数据。
   */
  const restoreInstallation = async (): Promise<string[]> => {
    const errors: string[] = [];
    if (!originalInstallation || settingsInterval === null) {
      errors.push('缺少安装设置原始值或本轮设置值，未执行恢复');
      return errors;
    }
    const origin = originalInstallation;
    const runner: QueryRunner = dataSource.createQueryRunner();
    try {
      assertPhysicalCleanupConsent();
      await runner.connect();
      await runner.startTransaction();
      await assertManagerOnExpectedE2eDatabase(runner.manager, expectedDatabase);
      const rows = (await runner.query(
        `SELECT local_site_name, auto_upload_enabled, backup_interval_days, updated_at
           FROM local_installation WHERE id = 1 FOR UPDATE`,
      )) as InstallationOrigin[];
      const current = rows[0];
      if (!current) {
        throw new Error('安装设置行缺失，拒绝写回');
      }
      // 本轮设置用例只会写入站点名与备份周期；其余组合视为外部改写，整批放弃写回
      const siteNameAllowed =
        current.local_site_name === origin.local_site_name ||
        current.local_site_name === SETTINGS_SITE_NAME;
      const intervalAllowed =
        Number(current.backup_interval_days) === Number(origin.backup_interval_days) ||
        Number(current.backup_interval_days) === settingsInterval;
      const uploadAllowed =
        Boolean(current.auto_upload_enabled) === Boolean(origin.auto_upload_enabled);
      if (!siteNameAllowed || !intervalAllowed || !uploadAllowed) {
        throw new Error('安装设置已被本轮之外的操作修改，拒绝写回');
      }
      await runner.query(
        `UPDATE local_installation
            SET local_site_name = ?, auto_upload_enabled = ?, backup_interval_days = ?, updated_at = ?
          WHERE id = 1
            AND local_site_name <=> ?
            AND auto_upload_enabled <=> ?
            AND backup_interval_days <=> ?`,
        [
          origin.local_site_name,
          origin.auto_upload_enabled,
          origin.backup_interval_days,
          origin.updated_at,
          current.local_site_name,
          current.auto_upload_enabled,
          current.backup_interval_days,
        ],
      );
      const restoredRows = (await runner.query(
        `SELECT local_site_name, auto_upload_enabled, backup_interval_days, updated_at
           FROM local_installation WHERE id = 1`,
      )) as InstallationOrigin[];
      const restored = restoredRows[0];
      if (
        !restored ||
        restored.local_site_name !== origin.local_site_name ||
        Boolean(restored.auto_upload_enabled) !== Boolean(origin.auto_upload_enabled) ||
        Number(restored.backup_interval_days) !== Number(origin.backup_interval_days) ||
        new Date(restored.updated_at).getTime() !== new Date(origin.updated_at).getTime()
      ) {
        throw new Error('安装设置恢复后与原始值不一致');
      }
      await runner.commitTransaction();
    } catch (error) {
      if (runner.isTransactionActive) {
        try {
          await runner.rollbackTransaction();
        } catch (rollbackError) {
          errors.push(`安装设置恢复回滚失败：${(rollbackError as Error).message}`);
        }
      }
      errors.push(`安装设置恢复失败：${(error as Error).message}`);
    } finally {
      try {
        await runner.release();
      } catch (releaseError) {
        errors.push(`关闭恢复连接失败：${(releaseError as Error).message}`);
      }
    }
    return errors;
  };

  beforeAll(async () => {
    const declared = process.env.LOCAL_RUNTIME_INTEGRATION_DATABASE ?? 'lithography_e2e';
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
          entities: [join(__dirname, '../../modules/**/*.entity.ts')],
        }),
        TypeOrmTransactionModule,
        LithographyModule,
        LocalRuntimeUsecasesModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    // 环境门禁全部通过后才允许读取/写入夹具
    const gate = await prepareFixtureSetup(dataSource, ROUND_TAG, config.database);
    expectedDatabase = gate.database;
    originalInstallation = await readOriginInstallation();
    const originalInterval = Number(originalInstallation.backup_interval_days);
    settingsInterval = originalInterval >= 365 ? originalInterval - 1 : originalInterval + 1;
    const installationRows = await query<{ installation_id: string }>(
      'SELECT installation_id FROM local_installation WHERE id = 1',
    );
    installationId = installationRows[0]?.installation_id ?? '';
    if (!installationId) {
      throw new Error('隔离库缺少本地安装身份标识，拒绝继续。');
    }
    await assertFixtureKeysAvailable();
    localRuntimeService = moduleRef.get(LocalRuntimeService);
    updateSettingsUsecase = moduleRef.get(UpdateLocalRuntimeSettingsUsecase);
    setupAllowed = true;
  });

  afterAll(async () => {
    await finalizeFixtureTeardown({
      steps: [
        {
          label: `清理夹具（目标库 ${expectedDatabase || '(未确认)'}）`,
          run: async () => {
            if (!setupAllowed) return;
            await runOwnedFixtureCleanup({
              dataSource,
              expectedDatabase,
              rows: ledger.list(),
            });
          },
        },
        {
          label: '核对夹具残留',
          run: async () => {
            if (!setupAllowed) return;
            const residue = await assertRegisteredRowsAbsent(dataSource, ledger.list());
            if (residue.length > 0) {
              throw new Error(`本轮登记资源仍存在：${residue.join('；')}`);
            }
          },
        },
        {
          label: '恢复安装设置',
          run: async () => {
            if (!setupAllowed) return;
            const restoreErrors = await restoreInstallation();
            if (restoreErrors.length > 0) {
              throw new Error(restoreErrors.join('；'));
            }
          },
        },
        {
          label: '关闭测试模块',
          run: async () => {
            if (moduleRef) {
              await moduleRef.close();
            }
          },
        },
      ],
    });
  });

  it('相同幂等键并发入队：仅一个任务，竞争方返回同一任务且无死锁', async () => {
    const data = {
      entityType: 'ATTACHMENT' as const,
      entityLocalId: 9904620,
      entityVersion: 'v1',
      idempotencyKey: 'CONC-S5C-SAME-KEY',
    };
    const settled = await runUploadRace(data, data);
    const first = expectFulfilled(settled[0], '先写入分支');
    const second = expectFulfilled(settled[1], '竞争分支');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.taskId).toBe(first.taskId);

    const rows = await query<{ total: number | string }>(
      "SELECT COUNT(*) AS total FROM local_upload_task WHERE installation_id = ? AND idempotency_key = 'CONC-S5C-SAME-KEY'",
      [installationId],
    );
    expect(Number(rows[0]?.total ?? 0)).toBe(1);
  });

  it('相同目标与版本但不同幂等键并发入队：仅一个任务，竞争方按同一任务返回', async () => {
    const first = {
      entityType: 'ATTACHMENT' as const,
      entityLocalId: FIXTURE_ENTITY_LOCAL_ID,
      entityVersion: 'v1',
      idempotencyKey: 'CONC-S5C-TARGET-A',
    };
    const second = {
      entityType: 'ATTACHMENT' as const,
      entityLocalId: FIXTURE_ENTITY_LOCAL_ID,
      entityVersion: 'v1',
      idempotencyKey: 'CONC-S5C-TARGET-B',
    };
    const settled = await runUploadRace(first, second);

    const openedTask = expectFulfilled(settled[0], '先写入分支');
    const racedTask = expectFulfilled(settled[1], '竞争分支');
    expect(openedTask.created).toBe(true);
    expect(racedTask.created).toBe(false);
    expect(racedTask.taskId).toBe(openedTask.taskId);

    const rows = await query<{ total: number | string; task_keys: string }>(
      `SELECT COUNT(*) AS total, GROUP_CONCAT(idempotency_key ORDER BY idempotency_key) AS task_keys
         FROM local_upload_task WHERE installation_id = ? AND entity_local_id = ?`,
      [installationId, FIXTURE_ENTITY_LOCAL_ID],
    );
    expect(Number(rows[0]?.total ?? 0)).toBe(1);
    expect(rows[0]?.task_keys).toBe('CONC-S5C-TARGET-A');
  });

  it('并发一方失败：成功入队的任务已登记并由受保护清理收尾', async () => {
    const successPayload = {
      entityType: 'ATTACHMENT' as const,
      entityLocalId: 9904622,
      entityVersion: 'v1',
      idempotencyKey: 'CONC-PARTIAL-OK',
    };
    // 空幂等键违反 CHECK 约束，用来制造必然失败的另一分支
    const failurePayload = {
      entityType: 'ATTACHMENT' as const,
      entityLocalId: 9904623,
      entityVersion: 'v1',
      idempotencyKey: '',
    };

    const race = await runTwoBranchTransactionRace<UploadRaceRawResult>({
      createRunner: () => dataSource.createQueryRunner(),
      runFirst: (runner) =>
        localRuntimeService.enqueueUploadTask(
          { installationId, ...successPayload },
          createTypeOrmPersistenceTransactionContext(runner.manager),
        ),
      runSecond: (runner) =>
        localRuntimeService.enqueueUploadTask(
          { installationId, ...failurePayload },
          createTypeOrmPersistenceTransactionContext(runner.manager),
        ),
      // 失败分支由 CHECK 约束决定，不需要等待锁竞争即可放行成功分支
      waitForCompetition: () => Promise.resolve(),
      onFirstCommitted: registerCommittedTask,
      onSecondCommitted: registerCommittedTask,
    });
    assertNoRaceTeardownErrors(race.errors);

    expect(race.first.status).toBe('fulfilled');
    expect(race.second.status).toBe('rejected');
    const created = expectFulfilled(toUploadRaceOutcome(race.first), '成功分支');
    expect(ledger.has('local_upload_task', created.taskId)).toBe(true);

    const rows = await query<{ total: number | string }>(
      'SELECT COUNT(*) AS total FROM local_upload_task WHERE idempotency_key = ?',
      ['CONC-PARTIAL-OK'],
    );
    expect(Number(rows[0]?.total ?? 0)).toBe(1);
  });

  it('本地设置并发修改不同字段：两个补丁均保留，不发生读—合并—写覆盖', async () => {
    if (!originalInstallation || settingsInterval === null) {
      throw new Error('缺少安装设置原始值，拒绝执行并发设置用例。');
    }
    const nextInterval = settingsInterval;
    const siteName = SETTINGS_SITE_NAME;

    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let released = false;
    try {
      await runner.query('SELECT id FROM local_installation WHERE id = 1 FOR UPDATE');
      const site = updateSettingsUsecase.execute({
        session: SETTINGS_SESSION,
        settings: { localSiteName: siteName },
      });
      await waitForLockWaiters(1);
      const interval = updateSettingsUsecase.execute({
        session: SETTINGS_SESSION,
        settings: { backupIntervalDays: nextInterval },
      });
      await waitForLockWaiters(2);
      released = true;
      await runner.commitTransaction();
      await Promise.all([site, interval]);
    } finally {
      if (!released && runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      await runner.release();
    }

    const rows = await query<InstallationOrigin>(
      'SELECT local_site_name, auto_upload_enabled, backup_interval_days, updated_at FROM local_installation WHERE id = 1',
    );
    expect(rows[0]?.local_site_name).toBe(siteName);
    expect(Number(rows[0]?.backup_interval_days)).toBe(nextInterval);
    expect(Boolean(rows[0]?.auto_upload_enabled)).toBe(
      Boolean(originalInstallation.auto_upload_enabled),
    );
  });
});

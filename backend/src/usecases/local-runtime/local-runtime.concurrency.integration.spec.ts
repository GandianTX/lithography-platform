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
 */
const ENABLED = process.env.LOCAL_RUNTIME_CONCURRENCY_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

const ENV_FILE = 'env/.env.e2e';
const ISOLATED_DATABASES = ['lithography_e2e'];
const CLEANUP_CONSENT_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';

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
  let actualDatabase = '';

  const query = async <T = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> => dataSource.query(sql, parameters);

  const assertConsent = (): void => {
    if (process.env[CLEANUP_CONSENT_ENV] !== '1') {
      throw new Error(`拒绝执行夹具写入/删除：缺少显式许可 ${CLEANUP_CONSENT_ENV}=1。`);
    }
  };

  const assertIsolatedTarget = async (declared: string): Promise<void> => {
    if (!ISOLATED_DATABASES.includes(declared.toLowerCase())) {
      throw new Error(
        `拒绝在库 "${declared}" 上执行集成验收：仅允许 ${ISOLATED_DATABASES.join(', ')}。`,
      );
    }
    const rows = await query<{ current: string }>('SELECT DATABASE() AS current');
    const current = (rows[0]?.current ?? '').toLowerCase();
    if (current !== declared.toLowerCase()) {
      throw new Error(`实际连接目标 "${current}" 与声明库 "${declared}" 不一致，拒绝写入。`);
    }
    actualDatabase = current;
  };

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

  /**
   * 用两条独立事务调用真实模块服务：先让 A 完成插入但不提交，
   * 再让 B 在唯一键上等待，最后放行 A 提交，验证 B 的冲突后锁定回读路径。
   */
  const runUploadRace = async (
    first: Omit<LocalUploadTaskInsertData, 'installationId'>,
    second: Omit<LocalUploadTaskInsertData, 'installationId'>,
  ): Promise<{
    first: { taskId: number; created: boolean };
    second: { taskId: number; created: boolean };
  }> => {
    const runnerA: QueryRunner = dataSource.createQueryRunner();
    await runnerA.connect();
    await runnerA.startTransaction();
    let signalInserted = (): void => undefined;
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    let allowCommit = (): void => undefined;
    const commitGate = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });

    const promiseA = (async () => {
      try {
        const result = await localRuntimeService.enqueueUploadTask(
          { installationId, ...first },
          createTypeOrmPersistenceTransactionContext(runnerA.manager),
        );
        signalInserted();
        await commitGate;
        await runnerA.commitTransaction();
        return { taskId: result.task.id, created: result.created };
      } catch (error) {
        if (runnerA.isTransactionActive) {
          await runnerA.rollbackTransaction();
        }
        throw error;
      } finally {
        await runnerA.release();
      }
    })();

    await inserted;

    const runnerB: QueryRunner = dataSource.createQueryRunner();
    await runnerB.connect();
    await runnerB.startTransaction();
    const promiseB = (async () => {
      try {
        const result = await localRuntimeService.enqueueUploadTask(
          { installationId, ...second },
          createTypeOrmPersistenceTransactionContext(runnerB.manager),
        );
        await runnerB.commitTransaction();
        return { taskId: result.task.id, created: result.created };
      } catch (error) {
        if (runnerB.isTransactionActive) {
          await runnerB.rollbackTransaction();
        }
        throw error;
      } finally {
        await runnerB.release();
      }
    })();

    try {
      await waitForLockWaiters(1);
    } finally {
      allowCommit();
    }

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    return { first: resultA, second: resultB };
  };

  const deleteFixtureTasks = async (): Promise<string[]> => {
    const errors: string[] = [];
    try {
      await query(
        "DELETE FROM local_upload_task WHERE installation_id = ? AND idempotency_key LIKE 'CONC-S5C-%'",
        [installationId],
      );
    } catch (error) {
      errors.push(`上传任务清理失败：${(error as Error).message}`);
    }
    return errors;
  };

  const restoreInstallation = async (): Promise<string[]> => {
    const errors: string[] = [];
    if (!originalInstallation) {
      errors.push('缺少安装设置原始值，未执行恢复');
      return errors;
    }
    try {
      await query(
        `UPDATE local_installation
            SET local_site_name = ?, auto_upload_enabled = ?, backup_interval_days = ?, updated_at = ?
          WHERE id = 1`,
        [
          originalInstallation.local_site_name,
          originalInstallation.auto_upload_enabled,
          originalInstallation.backup_interval_days,
          originalInstallation.updated_at,
        ],
      );
      const restored = await readOriginInstallation();
      if (
        restored.local_site_name !== originalInstallation.local_site_name ||
        Boolean(restored.auto_upload_enabled) !==
          Boolean(originalInstallation.auto_upload_enabled) ||
        Number(restored.backup_interval_days) !==
          Number(originalInstallation.backup_interval_days) ||
        new Date(restored.updated_at).getTime() !==
          new Date(originalInstallation.updated_at).getTime()
      ) {
        errors.push('安装设置恢复后与原始值不一致');
      }
    } catch (error) {
      errors.push(`安装设置恢复失败：${(error as Error).message}`);
    }
    return errors;
  };

  const assertNoResidue = async (): Promise<string[]> => {
    const errors: string[] = [];
    const checks: Array<{ label: string; sql: string; parameters?: unknown[] }> = [
      {
        label: '上传任务残留',
        sql: "SELECT COUNT(*) AS total FROM local_upload_task WHERE installation_id = ? AND idempotency_key LIKE 'CONC-S5C-%'",
        parameters: [installationId],
      },
    ];
    for (const check of checks) {
      try {
        const rows = await query<{ total: number | string }>(check.sql, check.parameters);
        if (Number(rows[0]?.total ?? 0) !== 0) {
          errors.push(`${check.label}：仍有 ${rows[0]?.total} 条`);
        }
      } catch (error) {
        errors.push(`${check.label}核对失败：${(error as Error).message}`);
      }
    }
    return errors;
  };

  beforeAll(async () => {
    assertConsent();
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
    await assertIsolatedTarget(config.database);
    originalInstallation = await readOriginInstallation();
    const installationRows = await query<{ installation_id: string }>(
      'SELECT installation_id FROM local_installation WHERE id = 1',
    );
    installationId = installationRows[0]?.installation_id ?? '';
    if (!installationId) {
      throw new Error('隔离库缺少本地安装身份标识，拒绝继续。');
    }
    localRuntimeService = moduleRef.get(LocalRuntimeService);
    updateSettingsUsecase = moduleRef.get(UpdateLocalRuntimeSettingsUsecase);
    await deleteFixtureTasks();
  });

  afterAll(async () => {
    const errors: string[] = [];
    if (moduleRef) {
      errors.push(...(await deleteFixtureTasks()));
      errors.push(...(await restoreInstallation()));
      errors.push(...(await assertNoResidue()));
      try {
        await moduleRef.close();
      } catch (error) {
        errors.push(`关闭测试模块失败：${(error as Error).message}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `夹具收尾失败（目标库 ${actualDatabase || '(未确认)'}）：${errors.join('；')}`,
      );
    }
  });

  it('相同幂等键并发入队：仅一个任务，竞争方返回同一任务且无死锁', async () => {
    const data = {
      entityType: 'ATTACHMENT' as const,
      entityLocalId: 9904620,
      entityVersion: 'v1',
      idempotencyKey: 'CONC-S5C-SAME-KEY',
    };
    const result = await runUploadRace(data, data);

    expect(result.first.created).toBe(true);
    expect(result.second.created).toBe(false);
    expect(result.second.taskId).toBe(result.first.taskId);

    const rows = await query<{ total: number | string }>(
      "SELECT COUNT(*) AS total FROM local_upload_task WHERE installation_id = ? AND idempotency_key = 'CONC-S5C-SAME-KEY'",
      [installationId],
    );
    expect(Number(rows[0]?.total ?? 0)).toBe(1);
  });

  it('相同目标与版本但不同幂等键并发入队：仅一个任务，竞争方按同一任务返回', async () => {
    const first = {
      entityType: 'ATTACHMENT' as const,
      entityLocalId: 9904621,
      entityVersion: 'v1',
      idempotencyKey: 'CONC-S5C-TARGET-A',
    };
    const second = {
      entityType: 'ATTACHMENT' as const,
      entityLocalId: 9904621,
      entityVersion: 'v1',
      idempotencyKey: 'CONC-S5C-TARGET-B',
    };
    const result = await runUploadRace(first, second);

    expect(result.first.created).toBe(true);
    expect(result.second.created).toBe(false);
    expect(result.second.taskId).toBe(result.first.taskId);

    const rows = await query<{ total: number | string; task_keys: string }>(
      `SELECT COUNT(*) AS total, GROUP_CONCAT(idempotency_key ORDER BY idempotency_key) AS task_keys
         FROM local_upload_task WHERE installation_id = ? AND entity_local_id = 9904621`,
      [installationId],
    );
    expect(Number(rows[0]?.total ?? 0)).toBe(1);
    expect(rows[0]?.task_keys).toBe('CONC-S5C-TARGET-A');
  });

  it('本地设置并发修改不同字段：两个补丁均保留，不发生读—合并—写覆盖', async () => {
    if (!originalInstallation) {
      throw new Error('缺少安装设置原始值，拒绝执行并发设置用例。');
    }
    const originalInterval = Number(originalInstallation.backup_interval_days);
    const nextInterval = originalInterval >= 365 ? originalInterval - 1 : originalInterval + 1;
    const siteName = 'S5C 并发站点';

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

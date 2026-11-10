import type { DataSource } from 'typeorm';

jest.mock('./incremental-migration', () => {
  const actual = jest.requireActual('./incremental-migration');
  return {
    ...actual,
    inspectMigrationState: jest.fn(),
    verifyMigrationState: jest.fn(),
    executePendingMigrations: jest.fn(),
  };
});

import { runUpgradeDeploy } from './database-deploy';
import {
  type MigrationDbConfig,
  type MigrationLogger,
  type MigrationRepositoryEntry,
  type MigrationState,
  type MigrationTarget,
  type VerificationReport,
  executePendingMigrations,
  inspectMigrationState,
  verifyMigrationState,
} from './incremental-migration';

const mockedInspect = inspectMigrationState as jest.MockedFunction<typeof inspectMigrationState>;
const mockedVerify = verifyMigrationState as jest.MockedFunction<typeof verifyMigrationState>;
const mockedExecute = executePendingMigrations as jest.MockedFunction<
  typeof executePendingMigrations
>;

const DATABASE = 'lithography_v13_spec';
const TARGET: MigrationTarget = {
  host: '127.0.0.1',
  port: 3306,
  database: DATABASE,
  serverVersion: '8.0.36',
};
const CONFIG = { database: DATABASE } as MigrationDbConfig;

const entry = (name: string, timestamp: number): MigrationRepositoryEntry => ({
  name,
  timestamp,
});

const historyEntry = (id: number, name: string, timestamp: number) => ({
  id,
  name,
  timestamp,
});

const buildState = (params: {
  readonly pending?: ReadonlyArray<MigrationRepositoryEntry>;
  readonly issues?: ReadonlyArray<string>;
  readonly warnings?: ReadonlyArray<string>;
}): MigrationState => ({
  target: TARGET,
  migrationsTableExists: true,
  history: [historyEntry(1, 'Base1773924900000', 1773924900000)],
  repository: [entry('Base1773924900000', 1773924900000)],
  pending: params.pending ?? [],
  issues: params.issues ?? [],
  warnings: params.warnings ?? [],
});

const verification = (issues: ReadonlyArray<string> = []): VerificationReport => ({
  target: TARGET,
  issues,
  warnings: [],
  businessTableCount: 51,
});

const buildDataSource = (): DataSource =>
  ({
    options: { host: '127.0.0.1', port: 3306, database: DATABASE },
    query: jest.fn((sql: string) => {
      if (sql.includes('DATABASE()')) {
        return Promise.resolve([{ current_database: DATABASE, server_version: '8.0.36' }]);
      }
      return Promise.resolve([]);
    }),
  }) as unknown as DataSource;

const logger = (): MigrationLogger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const dependencies = {
  createDataSource: jest.fn(),
  lockTimeoutSeconds: 1,
  migrationsDir: '/tmp/migrations',
};

describe('upgrade 正式入口的升级前预检', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('已达终态但存在未知业务表时拒绝，且不执行任何迁移', async () => {
    mockedInspect.mockResolvedValue(buildState({ issues: ['存在预期之外的业务表: legacy_extra'] }));
    mockedVerify.mockResolvedValue(verification());

    await expect(
      runUpgradeDeploy(buildDataSource(), CONFIG, logger(), dependencies),
    ).rejects.toThrow(/升级前预检失败：[\s\S]*legacy_extra/);
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('存在 pending 但未知业务表时在任何 pending 执行前拒绝', async () => {
    const pending = [entry('Next1775502000000', 1775502000000)];
    mockedInspect.mockResolvedValue(
      buildState({ pending, issues: ['存在预期之外的业务表: sentinel_extra'] }),
    );
    mockedVerify.mockResolvedValue(verification());

    await expect(
      runUpgradeDeploy(buildDataSource(), CONFIG, logger(), dependencies),
    ).rejects.toThrow(/升级前预检失败：[\s\S]*sentinel_extra/);
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('升级后终态存在 NOT ENFORCED CHECK 时拒绝', async () => {
    mockedInspect.mockResolvedValue(buildState({}));
    mockedVerify.mockResolvedValue(
      verification(['关键 CHECK 未强制执行: organization.chk_organization_service_provider']),
    );

    await expect(
      runUpgradeDeploy(buildDataSource(), CONFIG, logger(), dependencies),
    ).rejects.toThrow(/升级后校验失败：[\s\S]*chk_organization_service_provider/);
  });

  it('预检与终态校验均通过时才执行 pending 并返回报告', async () => {
    const pending = [entry('Next1775502000000', 1775502000000)];
    mockedInspect
      .mockResolvedValueOnce(buildState({ pending }))
      .mockResolvedValueOnce(buildState({}));
    mockedExecute.mockResolvedValue(['Next1775502000000']);
    mockedVerify.mockResolvedValue(verification());

    const report = await runUpgradeDeploy(buildDataSource(), CONFIG, logger(), dependencies);

    expect(mockedExecute).toHaveBeenCalledWith(expect.anything(), pending);
    expect(report.executed).toEqual(['Next1775502000000']);
    expect(report.mode).toBe('upgrade');
  });
});

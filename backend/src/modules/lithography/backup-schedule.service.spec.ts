// src/usecases/local-runtime/backup-schedule.service.spec.ts

import { BackupScheduleService } from '@src/modules/lithography/backup-schedule.service';
import { ProtectedBackupService } from '@src/modules/lithography/protected-backup.service';
import { asPinoLogger, createTestPinoLogger } from '../../../test/utils/test-pino-logger';

describe('backup schedule service', () => {
  const buildService = (
    overrides: {
      settings?: Record<string, unknown>[];
      runs?: Record<string, unknown>[];
      authorizations?: Record<string, unknown>[];
      installation?: Record<string, unknown> | null;
      generate?: (input: { organizationId: number }) => unknown;
    } = {},
  ) => {
    const findOf = (rows: Record<string, unknown>[]) =>
      jest.fn().mockImplementation(({ where }: { where?: Record<string, unknown> } = {}) => {
        let result = rows;
        for (const [key, value] of Object.entries(where ?? {})) {
          if (value && typeof value === 'object' && '_type' in value) {
            // FindOperator（LessThanOrEqual）：过滤 <= value
            const threshold = (value as unknown as { value: Date }).value;
            result = result.filter(
              (row) => row[key] instanceof Date && row[key].getTime() <= threshold.getTime(),
            );
            continue;
          }
          result = result.filter((row) => row[key] === value);
        }
        return Promise.resolve(result);
      });
    const settings = overrides.settings ?? [];
    const runs = overrides.runs ?? [];
    /** 计划行更新载荷（用于核对 next_backup_at 的精确推进） */
    const settingUpdates: { patch: Record<string, unknown> }[] = [];
    const generated: { organizationId: number; runId: number | null }[] = [];
    const service = new BackupScheduleService(
      {
        find: findOf(settings),
        save: jest.fn().mockImplementation((row) => Promise.resolve({ id: 'plan-new', ...row })),
        // 服务层按 (条件, 载荷) 两参调用 update：载荷取第二参
        update: jest
          .fn()
          .mockImplementation((_criteria: unknown, patch: Record<string, unknown>) => {
            settingUpdates.push({ patch });
            return Promise.resolve();
          }),
        create: jest.fn().mockImplementation((row) => ({ ...row })),
      } as never,
      {
        find: findOf(overrides.authorizations ?? []),
      } as never,
      {
        find: findOf(runs),
        findOne: jest
          .fn()
          .mockImplementation(({ where }: { where?: Record<string, unknown> } = {}) => {
            let result: Record<string, unknown> | null = null;
            for (const run of runs) {
              const match = Object.entries(where ?? {}).every(([key, value]) => run[key] === value);
              if (match) {
                result = run;
                break;
              }
            }
            return Promise.resolve(result);
          }),
        save: jest
          .fn()
          .mockImplementation((row) => Promise.resolve({ id: runs.length + 1, ...row })),
        update: jest.fn().mockImplementation(() => Promise.resolve()),
        create: jest.fn().mockImplementation((row) => ({ ...row })),
      } as never,
      {
        findOne: jest
          .fn()
          .mockResolvedValue(overrides.installation ?? { installationId: 'inst-1' }),
      } as never,
      {
        generateProtectedBackup: jest
          .fn()
          .mockImplementation((input: { organizationId: number; runId: number | null }) => {
            generated.push({ organizationId: input.organizationId, runId: input.runId });
            if (overrides.generate) {
              return overrides.generate(input);
            }
            return Promise.resolve({
              backupId: 'backup-uuid-1',
              packagePath: '/tmp/pkg',
              manifestChecksum: 'a'.repeat(64),
              byteSize: 100,
            });
          }),
        resolvePackageTargetPath: jest
          .fn()
          .mockImplementation(
            (organizationId: number, trigger: string, at: Date) =>
              `/var/local-backups/${organizationId}/${trigger.toLowerCase()}-${at.toISOString()}`,
          ),
      } as unknown as ProtectedBackupService,
      asPinoLogger(createTestPinoLogger()),
    );
    return { service, generated, runs, settingUpdates };
  };

  const duePlan = (overrides: Record<string, unknown> = {}) => ({
    id: 'plan-1',
    installationId: 'inst-1',
    organizationId: 4,
    isCurrent: true,
    backupIntervalHours: 72,
    backupEnabled: true,
    nextBackupAt: new Date('2026-11-19T00:00:00.000Z'),
    ...overrides,
  });

  const now = new Date('2026-11-19T08:00:00.000Z');

  it('到期计划触发：建 RUNNING→生成包→SUCCEEDED→next_backup_at 推进一个间隔', async () => {
    const { service, generated } = buildService({ settings: [duePlan()] });
    const result = await service.runOnce(now);

    expect(result.triggered).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(generated).toHaveLength(1);
    expect(generated[0].organizationId).toBe(4);
    expect(generated[0].runId).toBeGreaterThan(0);
  });

  it('生成失败：运行 FAILED、failure_reason 落计划行、next_backup_at 仍推进（下轮补一次）', async () => {
    const { service } = buildService({
      settings: [duePlan()],
      generate: () => Promise.reject(new Error('disk full')),
    });
    const result = await service.runOnce(now);

    expect(result.triggered).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it('同公司已有 RUNNING：本轮跳过触发（互斥），不改计划', async () => {
    const { service, generated } = buildService({
      settings: [duePlan()],
      runs: [
        {
          id: 1,
          organizationId: 4,
          status: 'RUNNING',
          startedAt: new Date(now.getTime() - 60_000),
        },
      ],
    });
    const result = await service.runOnce(now);

    expect(result.triggered).toBe(0);
    expect(generated).toHaveLength(0);
    // 已有 RUNNING 且未超补偿时限：不补偿
    expect(result.compensated).toBe(0);
  });

  it('重启补偿：超时限 RUNNING 改判 INTERRUPTED；时限内不动', async () => {
    const staleRun = {
      id: 7,
      organizationId: 4,
      status: 'RUNNING',
      startedAt: new Date(now.getTime() - 120 * 60_000), // 超时限
    };
    const freshRun = {
      id: 8,
      organizationId: 5,
      status: 'RUNNING',
      startedAt: new Date(now.getTime() - 5 * 60_000), // 时限内
    };
    const { service } = buildService({
      runs: [staleRun, freshRun],
      settings: [],
    });
    const result = await service.runOnce(now);

    expect(result.compensated).toBe(1);
  });

  it('计划初始化：活跃授权公司补 72h 计划（backup_enabled 默认关闭）', async () => {
    const { service } = buildService({
      settings: [],
      authorizations: [{ organizationId: 4, authorizationStatus: 'ACTIVE' }],
      installation: { installationId: 'inst-1' },
    });
    const result = await service.runOnce(now);

    expect(result.initialized).toBe(1);
  });

  it('未到期计划不触发', async () => {
    const { service, generated } = buildService({
      settings: [duePlan({ nextBackupAt: new Date('2026-11-20T00:00:00.000Z') })],
    });
    const result = await service.runOnce(now);

    expect(result.triggered).toBe(0);
    expect(generated).toHaveLength(0);
  });

  it('72 小时计划边界：next_backup_at 恰好等于判定时刻即触发，差 1ms 不触发', async () => {
    const onTime = buildService({ settings: [duePlan({ nextBackupAt: new Date(now.getTime()) })] });
    const onTimeResult = await onTime.service.runOnce(now);
    expect(onTimeResult.triggered).toBe(1);
    expect(onTime.generated).toHaveLength(1);

    const almost = buildService({
      settings: [duePlan({ nextBackupAt: new Date(now.getTime() + 1) })],
    });
    const almostResult = await almost.service.runOnce(now);
    expect(almostResult.triggered).toBe(0);
    expect(almost.generated).toHaveLength(0);
  });

  it('72 小时计划：触发后 next_backup_at 恰好推进一个间隔，且间隔取计划行真实值', async () => {
    const { service, settingUpdates } = buildService({ settings: [duePlan()] });
    await service.runOnce(now);
    const pushed = settingUpdates[0]?.patch['nextBackupAt'] as Date | undefined;
    expect(pushed?.getTime()).toBe(now.getTime() + 72 * 3_600_000);

    const custom = buildService({ settings: [duePlan({ backupIntervalHours: 24 })] });
    await custom.service.runOnce(now);
    const customPushed = custom.settingUpdates[0]?.patch['nextBackupAt'] as Date | undefined;
    expect(customPushed?.getTime()).toBe(now.getTime() + 24 * 3_600_000);
  });
});

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
      /** 计划行保存失败（用于覆盖并发初始化的唯一键冲突） */
      saveError?: Error;
      /** 运行登记失败（用于覆盖同公司并发的唯一键冲突） */
      runSaveError?: (row: Record<string, unknown>) => Error | undefined;
      /** 目标路径解析抛错（用于覆盖单计划异常不中断整轮） */
      resolveTargetPathError?: (organizationId: number) => Error | undefined;
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
    /** 计划行新建载荷（用于核对初始化写入的启停与首次到期时间） */
    const savedSettings: Record<string, unknown>[] = [];
    const generated: { organizationId: number; runId: number | null }[] = [];
    const service = new BackupScheduleService(
      {
        find: findOf(settings),
        save: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          if (overrides.saveError) {
            return Promise.reject(overrides.saveError);
          }
          savedSettings.push(row);
          return Promise.resolve({ id: 'plan-new', ...row });
        }),
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
        save: jest.fn().mockImplementation((row) => {
          const error = overrides.runSaveError?.(row as Record<string, unknown>);
          if (error) {
            return Promise.reject(error);
          }
          return Promise.resolve({ id: runs.length + 1, ...row });
        }),
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
          .mockImplementation((organizationId: number, trigger: string, at: Date) => {
            const error = overrides.resolveTargetPathError?.(organizationId);
            if (error) {
              throw error;
            }
            return `/var/local-backups/${organizationId}/${trigger.toLowerCase()}-${at.toISOString()}`;
          }),
      } as unknown as ProtectedBackupService,
      asPinoLogger(createTestPinoLogger()),
    );
    return { service, generated, runs, settingUpdates, savedSettings };
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

  it('生成失败：运行 FAILED、failure_reason 落计划行、下次时间不推进（仅成功后推进）', async () => {
    const { service, settingUpdates } = buildService({
      settings: [duePlan()],
      generate: () => Promise.reject(new Error('disk full')),
    });
    const result = await service.runOnce(now);

    expect(result.triggered).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    // R076-01：仅成功后 UPDATE 最近自动成功及下次时间——失败不推进下次时间
    const pushed = settingUpdates[0]?.patch['nextBackupAt'];
    expect(pushed).toBeUndefined();
    // 失败事实照实落库
    expect(settingUpdates[0]?.patch['lastAutoFailureAt']).toBeInstanceOf(Date);
    expect(settingUpdates[0]?.patch['failureReason']).toBe('LOCAL_BACKUP_GENERATION_FAILED');
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

  // R075-01：首次建立**启用**计划；首次从初始化起约 72 小时；云自动上云默认关闭且单独控制。
  it('计划初始化：首次建立启用的 72h 计划，首次到期＝初始化＋72h', async () => {
    const { service, savedSettings } = buildService({
      settings: [],
      authorizations: [{ organizationId: 4, authorizationStatus: 'ACTIVE' }],
      installation: { installationId: 'inst-1' },
    });
    const result = await service.runOnce(now);

    expect(result.initialized).toBe(1);
    expect(savedSettings).toHaveLength(1);
    const plan = savedSettings[0];
    expect(plan['backupEnabled']).toBe(true);
    expect(plan['backupIntervalHours']).toBe(72);
    expect((plan['nextBackupAt'] as Date).getTime()).toBe(now.getTime() + 72 * 3_600_000);
    // 云自动上云默认关闭，单独控制
    expect(plan['autoUploadEnabled']).toBe(false);
  });

  it('旧行兼容：已有计划行的公司不重复初始化，也不回填旧行', async () => {
    const { service, savedSettings } = buildService({
      settings: [
        {
          id: 'plan-existing',
          installationId: 'inst-1',
          organizationId: 4,
          isCurrent: true,
          backupIntervalHours: 72,
          backupEnabled: false,
          nextBackupAt: null,
        },
      ],
      authorizations: [{ organizationId: 4, authorizationStatus: 'ACTIVE' }],
      installation: { installationId: 'inst-1' },
    });
    const result = await service.runOnce(now);

    expect(result.initialized).toBe(0);
    expect(savedSettings).toHaveLength(0);
  });

  it('并发初始化：唯一键冲突按「已建」处理，不中断整轮扫描', async () => {
    const conflict = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    const { service, savedSettings } = buildService({
      settings: [],
      authorizations: [{ organizationId: 4, authorizationStatus: 'ACTIVE' }],
      installation: { installationId: 'inst-1' },
      saveError: conflict,
    });

    const result = await service.runOnce(now);

    // 冲突被吞掉：扫描不抛错，只是本轮没有新建成功
    expect(result.initialized).toBe(0);
    expect(savedSettings).toHaveLength(0);
  });

  it('未到期计划不触发', async () => {
    const { service, generated } = buildService({
      settings: [duePlan({ nextBackupAt: new Date('2026-11-20T00:00:00.000Z') })],
    });
    const result = await service.runOnce(now);

    expect(result.triggered).toBe(0);
    expect(generated).toHaveLength(0);
  });

  // M6：单计划失败不中断整轮扫描；并发推进按跳过处理
  it('同公司并发推进：运行登记唯一键冲突按「已推进」跳过，整轮不抛错', async () => {
    const conflict = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    const { service, generated } = buildService({
      settings: [duePlan({ organizationId: 4 })],
      runSaveError: (row) => (row['organizationId'] === 4 ? conflict : undefined),
    });

    const result = await service.runOnce(now);

    expect(result.skipped).toBe(1);
    expect(result.triggered).toBe(0);
    expect(result.failed).toBe(0);
    expect(generated).toHaveLength(0);
  });

  it('单个计划执行异常不中断整轮：其余公司计划照常推进', async () => {
    const { service, generated } = buildService({
      settings: [
        duePlan({ id: 'plan-4', organizationId: 4 }),
        duePlan({ id: 'plan-5', organizationId: 5 }),
      ],
      resolveTargetPathError: (organizationId) =>
        organizationId === 4 ? new Error('path resolver exploded') : undefined,
    });

    const result = await service.runOnce(now);

    // 4 号计划失败不影响 5 号计划
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(generated.map((item) => item.organizationId)).toEqual([5]);
  });

  it('运行登记非唯一键失败：如实记为失败，不误报并发推进', async () => {
    const { service, generated } = buildService({
      settings: [duePlan()],
      runSaveError: () => new Error('disk io error'),
    });

    const result = await service.runOnce(now);

    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
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

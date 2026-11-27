// src/bootstraps/worker/local-backup-schedule.runtime.spec.ts
// 本地备份计划运行时单测（任务 09 S3.1／S3.3）。
//
// 验证点：
// - 运行时随 Worker 常驻，**不依赖用户在线**：启动即执行一轮（补偿→初始化→到期触发）；
// - 过期清理「每日一次」按**本地日期**判定（不是 UTC 日期）；
// - 扫描异常只记日志，不中断进程（下一轮重试）。

import { Logger } from 'nestjs-pino';

import { LocalBackupScheduleRuntime, localDateKey } from './local-backup-schedule.runtime';

describe('local backup schedule runtime', () => {
  const buildRuntime = (
    options: {
      scheduleError?: Error;
      retentionError?: Error;
    } = {},
  ) => {
    const calls = {
      schedule: 0,
      upload: 0,
      retention: 0,
    };

    const backupScheduleService = {
      runOnce: jest.fn(() => {
        calls.schedule += 1;
        if (options.scheduleError) {
          return Promise.reject(options.scheduleError);
        }
        return Promise.resolve({
          compensated: 0,
          initialized: 0,
          triggered: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
        });
      }),
    };
    const backupUploadService = {
      runOnce: jest.fn(() => {
        calls.upload += 1;
        return Promise.resolve({
          attempted: 0,
          succeeded: 0,
          failed: 0,
          waiting: 0,
          skipped: 0,
          compensated: 0,
          receiverMissing: 0,
        });
      }),
    };
    const backupCleanupService = {
      cleanupAllExpiredPackages: jest.fn(() => {
        calls.retention += 1;
        if (options.retentionError) {
          return Promise.reject(options.retentionError);
        }
        return Promise.resolve({
          available: true,
          reason: null,
          targetCount: 0,
          cleaned: 0,
          retained: 0,
          items: [],
        });
      }),
    };
    const logger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
      fatal: jest.fn(),
    };

    const runtime = new LocalBackupScheduleRuntime(
      backupScheduleService as never,
      backupUploadService as never,
      backupCleanupService as never,
      logger as unknown as Logger,
    );

    return { runtime, calls, logger };
  };

  it('启动即执行一轮：调度、上云与过期清理都不依赖用户在线', async () => {
    const { runtime, calls } = buildRuntime();

    runtime.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.schedule).toBe(1);
    expect(calls.upload).toBe(1);
    expect(calls.retention).toBe(1);
    runtime.onApplicationShutdown();
  });

  it('过期清理每日一次：同一本地日期内第二轮不再清理', async () => {
    const { runtime, calls } = buildRuntime();

    runtime.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.retention).toBe(1);

    // 同一本地日期内再跑一轮：调度照常，过期清理不重复
    await (runtime as unknown as { runCycle: () => Promise<void> }).runCycle();
    expect(calls.schedule).toBe(2);
    expect(calls.retention).toBe(1);
    runtime.onApplicationShutdown();
  });

  it('每日一次按本地日期判定，不按 UTC 日期', () => {
    // 2026-11-22T20:00Z 在 Asia/Shanghai 是 2026-11-23 04:00（本地日期已是 23 日）
    const moment = new Date('2026-11-22T20:00:00.000Z');
    expect(moment.toISOString().slice(0, 10)).toBe('2026-11-22');
    expect(localDateKey(moment)).toBe('2026-11-23');
  });

  it('扫描异常只记日志，不中断进程', async () => {
    const { runtime, logger } = buildRuntime({ scheduleError: new Error('boom') });

    runtime.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalled();
    runtime.onApplicationShutdown();
  });

  it('备份调度失败**不阻断**过期清理（清理是独立职责）', async () => {
    const { runtime, calls } = buildRuntime({ scheduleError: new Error('boom') });

    runtime.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.schedule).toBe(1);
    // 关键：调度抛错后，上云与**过期清理照常执行**
    expect(calls.upload).toBe(1);
    expect(calls.retention).toBe(1);
    runtime.onApplicationShutdown();
  });

  it('过期清理自身失败只记日志，不中断进程、不逃逸成未处理 rejection', async () => {
    const { runtime, logger, calls } = buildRuntime({ retentionError: new Error('cleanup boom') });

    runtime.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.retention).toBe(1);
    expect(logger.error).toHaveBeenCalled();
    runtime.onApplicationShutdown();
  });
});

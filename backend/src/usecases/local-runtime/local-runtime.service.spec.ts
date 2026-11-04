// src/usecases/local-runtime/local-runtime.service.spec.ts

/// <reference types="jest" />
import { LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { normalizeBackupFinish } from './local-runtime.input.normalize';

type Row = Record<string, unknown>;

let mockManager: { getRepository: (target: unknown) => unknown } | null = null;

jest.mock(
  '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context',
  () => ({
    getTypeOrmEntityManager: () => {
      if (!mockManager) throw new Error('mock manager 未初始化');
      return mockManager;
    },
  }),
);

class FakeRepository {
  readonly rows: Row[] = [];
  readonly findOneCalls: Array<{ where: Row; lock?: unknown }> = [];
  /** 模拟 REPEATABLE READ 下的旧快照：普通读看不到并发胜者刚提交的行 */
  staleSnapshot = false;
  target: unknown = null;
  private nextId = 1;

  constructor(
    private readonly hasUniqueConflict: (row: Row, rows: Row[]) => boolean = () => false,
  ) {}

  create(data: Row): Row {
    return { ...data };
  }

  save(entity: Row): Promise<Row> {
    if (this.hasUniqueConflict(entity, this.rows)) {
      const error = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
      return Promise.reject(error);
    }
    const row = { ...entity, id: this.nextId, createdAt: new Date(), updatedAt: new Date() };
    this.nextId += 1;
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findOne(options: { where: Row; lock?: unknown }): Promise<Row | null> {
    this.findOneCalls.push({ where: options.where, lock: options.lock });
    if (this.staleSnapshot && !options.lock) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.rows.find((row) => matches(row, options.where)) ?? null);
  }

  update(criteria: Row, patch: Row): Promise<{ affected: number }> {
    const matched = this.rows.filter((row) => matches(row, criteria));
    for (const row of matched) {
      for (const [key, value] of Object.entries(patch)) {
        row[key] = typeof value === 'function' ? Number(row[key] ?? 0) + 1 : value;
      }
      row.updatedAt = new Date();
    }
    return Promise.resolve({ affected: matched.length });
  }

  count(): Promise<number> {
    return Promise.resolve(this.rows.length);
  }
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

const installationRow = (): Row => ({
  id: 1,
  installationId: 'inst-local-001',
  organizationId: 910001,
  organizationCodeSnapshot: 'CLIENT_DEFAULT',
  localSiteName: '一号厂房',
  autoUploadEnabled: true,
  backupIntervalDays: 7,
  lastBackupCompletedAt: null,
});

const makeHarness = () => {
  const installationTarget = { entity: 'LOCAL_INSTALLATION' };
  const uploadTaskTarget = { entity: 'LOCAL_UPLOAD_TASK' };
  const backupRunTarget = { entity: 'LOCAL_BACKUP_RUN' };
  const installationRepository = new FakeRepository();
  const uploadTaskRepository = new FakeRepository((row, rows) =>
    rows.some(
      (existing) =>
        existing.idempotencyKey === row.idempotencyKey ||
        (existing.installationId === row.installationId &&
          existing.entityType === row.entityType &&
          existing.entityLocalId === row.entityLocalId &&
          existing.entityVersion === row.entityVersion),
    ),
  );
  const backupRunRepository = new FakeRepository((row, rows) =>
    rows.some(
      (existing) =>
        existing.installationId === row.installationId &&
        existing.status === 'RUNNING' &&
        row.status === 'RUNNING',
    ),
  );
  installationRepository.rows.push(installationRow());
  installationRepository.target = installationTarget;
  uploadTaskRepository.target = uploadTaskTarget;
  backupRunRepository.target = backupRunTarget;
  const repositories = new Map<unknown, FakeRepository>([
    [installationTarget, installationRepository],
    [uploadTaskTarget, uploadTaskRepository],
    [backupRunTarget, backupRunRepository],
  ]);
  mockManager = {
    getRepository: (target: unknown) => {
      const repository = repositories.get(target);
      if (!repository) throw new Error('未注册的实体仓库');
      return repository;
    },
  };
  const service = new LocalRuntimeService(
    installationRepository as never,
    uploadTaskRepository as never,
    backupRunRepository as never,
  );
  const transactionContext = {} as PersistenceTransactionContext;
  return {
    service,
    installationRepository,
    uploadTaskRepository,
    backupRunRepository,
    transactionContext,
  };
};

const enqueue = (overrides: Record<string, unknown> = {}) => ({
  installationId: 'inst-local-001',
  entityType: 'REPORT_VERSION' as const,
  entityLocalId: 960001,
  entityVersion: 'v1',
  idempotencyKey: 'idem-001',
  ...overrides,
});

describe('LocalRuntimeService 上传任务幂等与状态机', () => {
  it('相同幂等键重复登记返回既有任务', async () => {
    const { service, uploadTaskRepository, transactionContext } = makeHarness();

    const first = await service.enqueueUploadTask(enqueue(), transactionContext);
    const second = await service.enqueueUploadTask(enqueue(), transactionContext);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(uploadTaskRepository.rows).toHaveLength(1);
  });

  it('唯一键冲突后的回读必须使用锁定读，才能看到旧快照外的并发胜者行', async () => {
    const { service, uploadTaskRepository, transactionContext } = makeHarness();
    const winner = { id: 777, status: 'PENDING', ...enqueue() };
    uploadTaskRepository.rows.push(winner);
    // 预检普通读命中旧快照（看不到胜者行），插入触发唯一键冲突，随后回读必须带行锁
    uploadTaskRepository.staleSnapshot = true;

    const result = await service.enqueueUploadTask(enqueue(), transactionContext);

    expect(result.created).toBe(false);
    expect(result.task.id).toBe(777);
    const lockedCalls = uploadTaskRepository.findOneCalls.filter((call) => call.lock);
    expect(lockedCalls).toHaveLength(1);
    expect(lockedCalls[0].lock).toEqual({ mode: 'pessimistic_write' });
  });

  it('相同实体版本换幂等键仍视为同一任务', async () => {
    const { service, uploadTaskRepository, transactionContext } = makeHarness();

    await service.enqueueUploadTask(enqueue(), transactionContext);
    const second = await service.enqueueUploadTask(
      enqueue({ idempotencyKey: 'idem-002' }),
      transactionContext,
    );

    expect(second.created).toBe(false);
    expect(uploadTaskRepository.rows).toHaveLength(1);
  });

  it('上传中不可重复开始，成功后不可再失败', async () => {
    const { service, transactionContext } = makeHarness();
    const { task } = await service.enqueueUploadTask(enqueue(), transactionContext);

    const started = await service.startUploadAttempt(task.id, transactionContext);
    expect(started.status).toBe('UPLOADING');
    expect(started.attemptCount).toBe(1);

    await expect(service.startUploadAttempt(task.id, transactionContext)).rejects.toMatchObject({
      code: LOCAL_RUNTIME_ERROR.UPLOAD_TASK_CONFLICT,
    });

    await service.completeUploadTask(
      task.id,
      { remoteId: 'cloud-1', remoteReceipt: 'ok' },
      transactionContext,
    );
    await expect(
      service.failUploadTask(
        task.id,
        { errorCode: 'E_NETWORK', errorMessage: '网络中断' },
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: LOCAL_RUNTIME_ERROR.UPLOAD_TASK_CONFLICT });
  });

  it('失败后可重试并累加尝试次数', async () => {
    const { service, transactionContext } = makeHarness();
    const { task } = await service.enqueueUploadTask(enqueue(), transactionContext);

    await service.startUploadAttempt(task.id, transactionContext);
    const failed = await service.failUploadTask(
      task.id,
      { errorCode: 'E_NETWORK', errorMessage: '网络中断' },
      transactionContext,
    );
    expect(failed.status).toBe('FAILED');

    const retry = await service.startUploadAttempt(task.id, transactionContext);
    expect(retry.status).toBe('UPLOADING');
    expect(retry.attemptCount).toBe(2);
    expect(retry.errorCode).toBeNull();
  });

  it('任务不存在时失败关闭', async () => {
    const { service, transactionContext } = makeHarness();
    await expect(service.startUploadAttempt(999, transactionContext)).rejects.toMatchObject({
      code: LOCAL_RUNTIME_ERROR.UPLOAD_TASK_NOT_FOUND,
    });
  });
});

describe('LocalRuntimeService 备份运行', () => {
  it('同一安装只允许一个 RUNNING 备份', async () => {
    const { service, backupRunRepository, transactionContext } = makeHarness();
    const first = await service.insertBackupRun(
      {
        installationId: 'inst-local-001',
        triggerType: 'SCHEDULED',
        startedAt: new Date('2026-10-01T00:00:00.000Z'),
        manifestPath: null,
      },
      transactionContext,
    );
    expect(first.status).toBe('RUNNING');

    await expect(
      service.insertBackupRun(
        {
          installationId: 'inst-local-001',
          triggerType: 'MANUAL',
          startedAt: new Date(),
          manifestPath: null,
        },
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: LOCAL_RUNTIME_ERROR.BACKUP_ALREADY_RUNNING });
    expect(backupRunRepository.rows).toHaveLength(1);
  });

  it('结束后刷新最近成功备份时间，且不可重复结束', async () => {
    const { service, installationRepository, transactionContext } = makeHarness();
    const run = await service.insertBackupRun(
      {
        installationId: 'inst-local-001',
        triggerType: 'MANUAL',
        startedAt: new Date('2026-10-01T00:00:00.000Z'),
        manifestPath: null,
      },
      transactionContext,
    );
    const finishedAt = new Date('2026-10-01T01:00:00.000Z');
    const finished = await service.finishBackupRun(
      run.id,
      {
        status: 'SUCCEEDED',
        finishedAt,
        manifestPath: 'backup/manifest.json',
        manifestChecksum: 'a'.repeat(64),
        byteSize: 1024,
        attachmentCount: 3,
        schemaVersion: 2,
        errorCode: null,
        errorMessage: null,
      },
      transactionContext,
    );

    expect(finished.status).toBe('SUCCEEDED');
    expect(installationRepository.rows[0].lastBackupCompletedAt).toBe(finishedAt);
    await expect(
      service.finishBackupRun(
        run.id,
        { ...finished, finishedAt: new Date() } as never,
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: LOCAL_RUNTIME_ERROR.BACKUP_STATE_CONFLICT });
  });

  it('结束未显式给出清单路径时保留开始时的路径（不被清空）', async () => {
    const { service, backupRunRepository, transactionContext } = makeHarness();
    const run = await service.insertBackupRun(
      {
        installationId: 'inst-local-001',
        triggerType: 'MANUAL',
        startedAt: new Date('2026-10-01T00:00:00.000Z'),
        manifestPath: 'backup/manifest-start.json',
      },
      transactionContext,
    );

    await service.finishBackupRun(
      run.id,
      {
        status: 'FAILED',
        finishedAt: new Date('2026-10-01T01:00:00.000Z'),
        manifestChecksum: null,
        byteSize: null,
        attachmentCount: null,
        schemaVersion: null,
        errorCode: 'E_IO',
        errorMessage: '磁盘错误',
      },
      transactionContext,
    );

    expect(backupRunRepository.rows[0].manifestPath).toBe('backup/manifest-start.json');
    expect(backupRunRepository.rows[0].status).toBe('FAILED');
  });

  it('运行中的备份不存在时结束操作失败关闭', async () => {
    const { service, transactionContext } = makeHarness();
    await expect(
      service.finishBackupRun(
        999,
        {
          status: 'FAILED',
          finishedAt: new Date(),
          manifestPath: null,
          manifestChecksum: null,
          byteSize: null,
          attachmentCount: null,
          schemaVersion: null,
          errorCode: 'E_IO',
          errorMessage: '磁盘错误',
        },
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: LOCAL_RUNTIME_ERROR.BACKUP_RUN_NOT_FOUND });
  });
});

describe('normalizeBackupFinish 清单完整性', () => {
  it('成功必须有清单校验值', () => {
    expect(() =>
      normalizeBackupFinish({ runId: 1, status: 'SUCCEEDED', manifestChecksum: null }, new Date()),
    ).toThrow(expect.objectContaining({ code: LOCAL_RUNTIME_ERROR.INVALID_PARAMS }));
  });

  it('失败必须有错误码与说明', () => {
    expect(() =>
      normalizeBackupFinish({ runId: 1, status: 'FAILED', errorCode: 'E_IO' }, new Date()),
    ).toThrow(expect.objectContaining({ code: LOCAL_RUNTIME_ERROR.INVALID_PARAMS }));
  });

  it('未提供清单路径时不产出覆盖值', () => {
    const data = normalizeBackupFinish(
      { runId: 1, status: 'FAILED', errorCode: 'E_IO', errorMessage: '磁盘错误' },
      new Date(),
    );

    expect(data.manifestPath).toBeUndefined();
  });

  it('运行中状态不能作为结束状态', () => {
    expect(() => normalizeBackupFinish({ runId: 1, status: 'RUNNING' }, new Date())).toThrow(
      expect.objectContaining({ code: LOCAL_RUNTIME_ERROR.INVALID_PARAMS }),
    );
  });
});

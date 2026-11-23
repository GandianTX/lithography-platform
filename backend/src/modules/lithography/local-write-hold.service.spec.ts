// src/modules/lithography/local-write-hold.service.spec.ts

/**
 * 写入／同步冻结闸门事实层的定向测试（任务 09 S5-2／S5-3；G30–G33 复核追加）。
 *
 * 守住：同一范围只留一条 ACTIVE 冻结（不堆叠）、解除后不再拦截、
 * 冻结事实**落库**（重启后可识别）、守卫失败关闭抛受控错误。
 *
 * **G30–G33 追加**：
 * - 已有 ACTIVE 属于**其它恢复**时，建立冻结必须**受控拒绝**且**不得覆盖**其归属；
 * - 释放必须校验**持有者**：不得解冻别人的冻结；
 * - 数据库范围锁未取得时必须**受控拒绝**（并发占用可判定）。
 */

import { asPinoLogger, createTestPinoLogger } from '../../../test/utils/test-pino-logger';

import { LocalWriteHoldService } from './local-write-hold.service';

/** 数据库范围锁的受控替身：默认取锁成功；`locked` 可设为 0 模拟"范围已被占用" */
function buildDataSource(options: { locked?: number } = {}) {
  const locked = options.locked ?? 1;
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn((sql: string) => {
      if (sql.includes('GET_LOCK')) {
        return Promise.resolve([{ locked }]);
      }
      if (sql.includes('RELEASE_LOCK')) {
        return Promise.resolve([{ released: 1 }]);
      }
      return Promise.resolve([]);
    }),
    release: jest.fn().mockResolvedValue(undefined),
  };
  return {
    createQueryRunner: jest.fn(() => queryRunner),
    queryRunner,
  };
}

function buildService(options: { locked?: number } = {}) {
  const store: Record<string, unknown>[] = [];
  const repository = {
    find: jest.fn().mockImplementation((options: { where: Record<string, unknown> }) => {
      let result = store;
      for (const [key, value] of Object.entries(options.where ?? {})) {
        result = result.filter((row) => row[key] === value);
      }
      return Promise.resolve(result);
    }),
    findOne: jest.fn().mockImplementation((options: { where: Record<string, unknown> }) => {
      const found = store.find((row) =>
        Object.entries(options.where ?? {}).every(([key, value]) => row[key] === value),
      );
      return Promise.resolve(found ?? null);
    }),
    create: jest.fn((entity: Record<string, unknown>) => ({ ...entity })),
    save: jest.fn((entity: Record<string, unknown>) => {
      const index = store.findIndex((row) => row['holdId'] === entity['holdId']);
      if (index >= 0) {
        store[index] = { ...store[index], ...entity };
      } else {
        store.push({ ...entity });
      }
      return Promise.resolve(entity);
    }),
    update: jest
      .fn()
      .mockImplementation((where: Record<string, unknown>, patch: Record<string, unknown>) => {
        let affected = 0;
        for (const row of store) {
          if (Object.entries(where).every(([key, value]) => row[key] === value)) {
            Object.assign(row, patch);
            affected += 1;
          }
        }
        return Promise.resolve({ affected });
      }),
  };
  const dataSource = buildDataSource(options);
  // 仓储的 `manager.connection` 提供 queryRunner 能力（本模块没有 DataSource provider）
  (repository as unknown as { manager: unknown }).manager = {
    connection: { createQueryRunner: dataSource.createQueryRunner },
  };
  const service = new LocalWriteHoldService(
    repository as never,
    { readInstallation: jest.fn().mockResolvedValue({ installationId: 'inst-1' }) } as never,
    asPinoLogger(createTestPinoLogger()),
  );
  return { service, store, repository, dataSource };
}

const SCOPE = { installationId: 'inst-1', organizationId: 4 };

describe('写入/同步冻结闸门事实层（S5-2／S5-3）', () => {
  it('建立冻结：落库一行 ACTIVE（重启后可识别）', async () => {
    const { service, store } = buildService();

    const result = await service.hold({ ...SCOPE, restoreId: 'restore-1', reason: '恢复期冻结' });

    expect(result.created).toBe(true);
    expect(store).toHaveLength(1);
    expect(store[0]?.['status']).toBe('ACTIVE');
    expect(store[0]?.['restoreId']).toBe('restore-1');
  });

  it('重复建立同一范围：只留一条 ACTIVE（不堆叠），并刷新原因', async () => {
    const { service, store } = buildService();

    await service.hold({ ...SCOPE, reason: '第一次' });
    const second = await service.hold({ ...SCOPE, reason: '第二次' });

    expect(second.created).toBe(false);
    expect(store).toHaveLength(1);
    expect(store[0]?.['reason']).toBe('第二次');
  });

  it('守卫：冻结中抛受控错误（失败关闭）', async () => {
    const { service } = buildService();
    await service.hold({ ...SCOPE, reason: '恢复期冻结' });

    await expect(service.assertWritable(SCOPE)).rejects.toThrow(/恢复期冻结/);
  });

  it('守卫：其它公司不受影响', async () => {
    const { service } = buildService();
    await service.hold({ ...SCOPE, reason: '恢复期冻结' });

    await expect(
      service.assertWritable({ installationId: 'inst-1', organizationId: 5 }),
    ).resolves.toBeUndefined();
  });

  it('解除冻结：标记 RELEASED，之后不再拦截', async () => {
    const { service, store } = buildService();
    await service.hold({ ...SCOPE, restoreId: 'restore-1', reason: '恢复期冻结' });

    const released = await service.release({ ...SCOPE, restoreId: 'restore-1' });

    expect(released).toBe(1);
    expect(store[0]?.['status']).toBe('RELEASED');
    await expect(service.assertWritable(SCOPE)).resolves.toBeUndefined();
  });
});

describe('恢复范围的占用互斥与冻结所有权（G30–G33）', () => {
  it('已有 ACTIVE 属于**其它恢复** ⇒ 受控拒绝，且不得覆盖其归属', async () => {
    const { service, store } = buildService();
    await service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复 A 执行中' });

    await expect(
      service.hold({ ...SCOPE, restoreId: 'restore-B', reason: '恢复 B 执行中' }),
    ).rejects.toThrow(/已被其它恢复占用/);

    // 归属与原因都必须是原来的那一条（不得被抢占）
    expect(store).toHaveLength(1);
    expect(store[0]?.['restoreId']).toBe('restore-A');
    expect(store[0]?.['reason']).toBe('恢复 A 执行中');
  });

  it('同一恢复重复建立 ⇒ 续用且**归属不被改写**（幂等重试／崩溃后收口）', async () => {
    const { service, store } = buildService();
    await service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复 A 执行中' });

    const again = await service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复 A 收口' });

    expect(again.created).toBe(false);
    expect(store).toHaveLength(1);
    expect(store[0]?.['restoreId']).toBe('restore-A');
    expect(store[0]?.['reason']).toBe('恢复 A 收口');
  });

  it('释放时不是持有者 ⇒ 别人的冻结不得被解掉', async () => {
    const { service, store } = buildService();
    await service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复 A 执行中' });

    // 按归属释放：只解冻归属一致的那些 ⇒ 别人的冻结不受影响，也不报错
    const released = await service.release({ ...SCOPE, restoreId: 'restore-B' });

    expect(released).toBe(0);
    expect(store[0]?.['status']).toBe('ACTIVE');
  });

  it('既不声明归属、也不给精确 ID ⇒ 受控拒绝（不允许按范围一刀切释放）', async () => {
    const { service, store } = buildService();
    await service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复 A 执行中' });

    await expect(service.release(SCOPE)).rejects.toThrow(/必须声明持有者/);

    expect(store[0]?.['status']).toBe('ACTIVE');
  });

  it('按精确 ID 释放但归属不符 ⇒ 受控拒绝（不释放）', async () => {
    const { service, store } = buildService();
    await service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复 A 执行中' });

    await expect(
      service.release({ ...SCOPE, restoreId: 'restore-B', holdId: store[0]?.['holdId'] as string }),
    ).rejects.toThrow(/其它恢复持有/);

    expect(store[0]?.['status']).toBe('ACTIVE');
  });

  it('持有者释放 ⇒ 只解冻自己那一条', async () => {
    const { service, store } = buildService();
    await service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复 A 执行中' });

    const released = await service.release({ ...SCOPE, restoreId: 'restore-A' });

    expect(released).toBe(1);
    expect(store[0]?.['status']).toBe('RELEASED');
  });

  it('数据库范围锁未取得 ⇒ 受控拒绝（并发占用可判定，不静默等待）', async () => {
    const { service, store } = buildService({ locked: 0 });

    await expect(
      service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复期冻结' }),
    ).rejects.toThrow(/正在被其它恢复占用/);

    expect(store).toHaveLength(0);
  });

  it('同范围存在多条并存 ACTIVE（历史冲突）⇒ 失败关闭，不静默挑一条', async () => {
    const { service, store } = buildService();
    store.push(
      {
        holdId: 'h-1',
        installationId: 'inst-1',
        organizationId: 4,
        holdType: 'RESTORE',
        status: 'ACTIVE',
        restoreId: 'restore-A',
        reason: 'A',
      },
      {
        holdId: 'h-2',
        installationId: 'inst-1',
        organizationId: 4,
        holdType: 'RESTORE',
        status: 'ACTIVE',
        restoreId: 'restore-B',
        reason: 'B',
      },
    );

    await expect(
      service.hold({ ...SCOPE, restoreId: 'restore-A', reason: '恢复期冻结' }),
    ).rejects.toThrow(/并存/);
  });
});

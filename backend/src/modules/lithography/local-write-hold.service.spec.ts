// src/modules/lithography/local-write-hold.service.spec.ts

/**
 * 写入／同步冻结闸门事实层的定向测试（任务 09 S5-2／S5-3）。
 *
 * 守住：同一范围只留一条 ACTIVE 冻结（不堆叠）、解除后不再拦截、
 * 冻结事实**落库**（重启后可识别）、守卫失败关闭抛受控错误。
 */

import { LocalWriteHoldService } from './local-write-hold.service';

function buildService() {
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
  const service = new LocalWriteHoldService(
    repository as never,
    { readInstallation: jest.fn().mockResolvedValue({ installationId: 'inst-1' }) } as never,
  );
  return { service, store, repository };
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
    await service.hold({ ...SCOPE, reason: '恢复期冻结' });

    const released = await service.release(SCOPE);

    expect(released).toBe(1);
    expect(store[0]?.['status']).toBe('RELEASED');
    await expect(service.assertWritable(SCOPE)).resolves.toBeUndefined();
  });
});

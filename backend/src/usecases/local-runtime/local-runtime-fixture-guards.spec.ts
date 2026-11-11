import { finalizeFixtureTeardown } from '../../../test/utils/e2e-owned-fixture';
import {
  matchesOriginalInstallation,
  planInstallationRestore,
  type InstallationRowValues,
} from '../../../test/utils/installation-restore-guard';
import { assertLockObservationCapability } from '../../../test/utils/upload-race-runner';

const ORIGIN: InstallationRowValues = {
  local_site_name: '原始站点',
  auto_upload_enabled: 1,
  backup_interval_days: 7,
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
};

describe('锁等待观测能力门禁', () => {
  it('缺少 PROCESS 时在造数前失败关闭', async () => {
    const queries: string[] = [];
    const query = jest.fn((sql: string): Promise<unknown> => {
      queries.push(sql);
      return Promise.resolve([{ total: 0 }]);
    });

    await expect(assertLockObservationCapability(query)).rejects.toThrow(/PROCESS.*零造数/);
    expect(queries).toHaveLength(1);
  });

  it('performance_schema 不可读时在造数前失败关闭', async () => {
    const query = jest.fn((sql: string): Promise<unknown> => {
      if (sql.includes('performance_schema')) {
        return Promise.reject(new Error('SELECT command denied'));
      }
      return Promise.resolve([{ total: 1 }]);
    });

    await expect(assertLockObservationCapability(query)).rejects.toThrow(/data_lock_waits/);
  });

  it('PROCESS 与 performance_schema 均可用时放行', async () => {
    const query = jest.fn((): Promise<unknown> => Promise.resolve([{ total: 1 }]));

    await expect(assertLockObservationCapability(query)).resolves.toBeUndefined();
  });
});

describe('创建后断言失败仍精确收尾', () => {
  it('残留断言抛错后仍继续执行后续清理步骤并汇总错误', async () => {
    const ran: string[] = [];

    await expect(
      finalizeFixtureTeardown({
        steps: [
          {
            label: '删除已登记资源',
            run: () => {
              ran.push('delete');
              return Promise.resolve();
            },
          },
          {
            label: '核对夹具残留',
            run: () => {
              ran.push('assert');
              return Promise.reject(new Error('仍有残留'));
            },
          },
          {
            label: '关闭测试模块',
            run: () => {
              ran.push('close');
              return Promise.resolve();
            },
          },
        ],
      }),
    ).rejects.toThrow(/核对夹具残留.*仍有残留/);
    expect(ran).toEqual(['delete', 'assert', 'close']);
  });
});

describe('安装设置原值恢复判定', () => {
  it('当前值等于原始值时允许写回', () => {
    expect(planInstallationRestore(ORIGIN, ORIGIN, 'S5C 并发站点', 8)).toEqual({
      allowed: true,
    });
  });

  it('当前值等于本轮写入值时允许写回', () => {
    expect(
      planInstallationRestore(
        ORIGIN,
        { ...ORIGIN, local_site_name: 'S5C 并发站点', backup_interval_days: 8 },
        'S5C 并发站点',
        8,
      ),
    ).toEqual({ allowed: true });
  });

  it.each([
    ['站点名', { ...ORIGIN, local_site_name: '外部改写站点' }],
    ['备份周期', { ...ORIGIN, backup_interval_days: 9 }],
    ['自动上传', { ...ORIGIN, auto_upload_enabled: 0 }],
  ])('发现异主修改（%s）时拒绝写回', (_label, current) => {
    expect(planInstallationRestore(ORIGIN, current, 'S5C 并发站点', 8)).toEqual({
      allowed: false,
      reason: '安装设置已被本轮之外的操作修改，拒绝写回',
    });
  });

  it('恢复后逐字段核对，包含 updated_at', () => {
    expect(matchesOriginalInstallation(ORIGIN, { ...ORIGIN })).toBe(true);
    expect(
      matchesOriginalInstallation(ORIGIN, {
        ...ORIGIN,
        updated_at: new Date('2026-11-02T00:00:00.000Z'),
      }),
    ).toBe(false);
    expect(matchesOriginalInstallation(ORIGIN, { ...ORIGIN, backup_interval_days: 9 })).toBe(false);
  });
});

// 历史身份清单读取的离线规格。
//
// 背景：全新库在 1775501100000 执行前，repair_request 表还没有 intake_id 列；
// 31 态库同样没有该列。读取器必须先判空、再按列是否存在选择投影表达式，
// 否则 init 会在首个 DDL 之前以 Unknown column 失败。
import type { QueryRunner } from 'typeorm';

import {
  fingerprintLegacyRepairRequestRow,
  resetLegacyRepairIdentityManifest,
  resolveAndVerifyLegacyRepairManifest,
  setLegacyRepairIdentityManifest,
  type LegacyRepairIdentityManifest,
} from './legacy-repair-identity-manifest';

interface FakeOptions {
  readonly rows?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly hasIntakeColumn?: boolean;
}

const asQueryRunner = (runner: FakeQueryRunner): QueryRunner => runner as unknown as QueryRunner;

class FakeQueryRunner {
  readonly queries: string[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    const trimmed = sql.trim();
    if (trimmed.includes('COUNT(*) AS count')) {
      return Promise.resolve([{ count: (this.options.rows ?? []).length }]);
    }
    if (trimmed.includes('`information_schema`')) {
      return Promise.resolve(
        this.options.hasIntakeColumn === true ? [{ COLUMN_NAME: 'intake_id' }] : [],
      );
    }
    if (trimmed.startsWith('SELECT') && trimmed.includes('`repair_request`')) {
      // 模拟 MySQL：列不存在时直接投影该列会以 Unknown column 失败。
      if (trimmed.includes('`id`, `intake_id`') && this.options.hasIntakeColumn !== true) {
        return Promise.reject(new Error("Unknown column 'intake_id' in 'field list'"));
      }
      return Promise.resolve(this.options.rows ?? []);
    }
    return Promise.resolve([]);
  }
}

const manifestOf = (
  rows: ReadonlyArray<{ readonly id: number; readonly fingerprint: string }>,
): LegacyRepairIdentityManifest => ({
  formatVersion: 1,
  source: 'V13_31_STATE',
  frozenAt: '2026-11-09T00:00:00.000Z',
  rows,
});

const legacyRow = {
  id: 7,
  intake_id: null,
  handling_status: 'INTERRUPTED',
  handling_result: 'NO_CAUSE',
};

describe('resolveAndVerifyLegacyRepairManifest', () => {
  afterEach(() => {
    resetLegacyRepairIdentityManifest();
  });

  it('空表直接返回 null，不读取 intake_id 列', async () => {
    const runner = new FakeQueryRunner({ rows: [] });

    await expect(resolveAndVerifyLegacyRepairManifest(asQueryRunner(runner))).resolves.toBeNull();

    expect(runner.queries).toHaveLength(1);
    expect(runner.queries[0]).toContain('COUNT(*) AS count');
    expect(runner.queries.some((sql) => sql.includes('intake_id'))).toBe(false);
  });

  it('非空且缺列时用 NULL AS intake_id，并在未提供清单时拒绝', async () => {
    const runner = new FakeQueryRunner({ rows: [legacyRow], hasIntakeColumn: false });

    await expect(resolveAndVerifyLegacyRepairManifest(asQueryRunner(runner))).rejects.toThrow(
      '未提供历史身份清单',
    );

    const selectSql = runner.queries.find((sql) => sql.includes('NULL AS `intake_id`'));
    expect(selectSql).toBeDefined();
    expect(runner.queries.some((sql) => /SELECT[^]*\bid\b/.test(sql))).toBe(true);
  });

  it('非空且缺列时按 intakeId=NULL 计算指纹，指纹一致才通过', async () => {
    const runner = new FakeQueryRunner({ rows: [legacyRow], hasIntakeColumn: false });
    setLegacyRepairIdentityManifest(
      manifestOf([
        {
          id: legacyRow.id,
          fingerprint: fingerprintLegacyRepairRequestRow({
            id: legacyRow.id,
            intakeId: null,
            handlingStatus: legacyRow.handling_status,
            handlingResult: legacyRow.handling_result,
          }),
        },
      ]),
    );

    await expect(
      resolveAndVerifyLegacyRepairManifest(asQueryRunner(runner)),
    ).resolves.toMatchObject({ source: 'V13_31_STATE' });
  });

  it('列存在时投影真实 intake_id，指纹不一致则拒绝', async () => {
    const runner = new FakeQueryRunner({
      rows: [{ ...legacyRow, intake_id: 3 }],
      hasIntakeColumn: true,
    });
    setLegacyRepairIdentityManifest(
      manifestOf([
        {
          id: legacyRow.id,
          fingerprint: fingerprintLegacyRepairRequestRow({
            id: legacyRow.id,
            intakeId: null,
            handlingStatus: legacyRow.handling_status,
            handlingResult: legacyRow.handling_result,
          }),
        },
      ]),
    );

    await expect(resolveAndVerifyLegacyRepairManifest(asQueryRunner(runner))).rejects.toThrow(
      '行指纹与冻结清单不一致',
    );

    expect(runner.queries.some((sql) => sql.includes('NULL AS `intake_id`'))).toBe(false);
    expect(runner.queries.some((sql) => sql.includes('`id`, `intake_id`'))).toBe(true);
  });

  it('31 态清单条数与库内行数不一致时拒绝', async () => {
    const runner = new FakeQueryRunner({ rows: [legacyRow], hasIntakeColumn: false });
    setLegacyRepairIdentityManifest(manifestOf([]));

    await expect(resolveAndVerifyLegacyRepairManifest(asQueryRunner(runner))).rejects.toThrow(
      '不一致',
    );
  });
});

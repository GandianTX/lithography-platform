import type { QueryRunner } from 'typeorm';

import { TightenRepairRequestRevisionPreviousVersionForV131775502200000 } from './migrations/1775502200000-tighten-repair-request-revision-previous-version-for-v13.migration';

interface ColumnState {
  columnType: string;
  isNullable: 'YES' | 'NO';
  columnDefault: string | null;
  extra: string;
  generationExpression: string;
}

interface RevisionRow {
  id: number;
  previousVersion: number | null;
  revisionNo: number;
}

interface FakeState {
  column: ColumnState | null;
  rows: RevisionRow[];
}

const NULLABLE_COLUMN = (): ColumnState => ({
  columnType: 'int unsigned',
  isNullable: 'YES',
  columnDefault: null,
  extra: '',
  generationExpression: '',
});

const NOT_NULL_COLUMN = (): ColumnState => ({
  columnType: 'int unsigned',
  isNullable: 'NO',
  columnDefault: null,
  extra: '',
  generationExpression: '',
});

const matchCondition = (row: RevisionRow, condition: string): boolean => {
  if (condition.includes('IS NULL') && !condition.includes('IS NOT NULL')) {
    return row.previousVersion === null;
  }
  if (condition.includes('IS NOT NULL') && condition.includes('>= `revision_no`')) {
    return row.previousVersion !== null && row.previousVersion >= row.revisionNo;
  }
  throw new Error(`未预期条件: ${condition}`);
};

const createFakeQueryRunner = (state: FakeState) => {
  const statements: string[] = [];
  const runner = {
    query: (sql: string, params?: ReadonlyArray<unknown>): Promise<unknown> => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('ALTER TABLE')) {
        statements.push(normalized);
        if (!state.column) {
          throw new Error('ALTER 触碰了不存在的列');
        }
        if (normalized.includes('NOT NULL')) {
          state.column.isNullable = 'NO';
          state.column.columnDefault = null;
        } else if (normalized.includes('NULL DEFAULT NULL')) {
          state.column.isNullable = 'YES';
          state.column.columnDefault = null;
        }
        return Promise.resolve([]);
      }
      if (
        normalized.includes('FROM information_schema.COLUMNS') &&
        normalized.includes('AS `columnName`')
      ) {
        if (!state.column) return Promise.resolve([]);
        return Promise.resolve([
          {
            columnName: 'previous_version',
            columnType: state.column.columnType,
            isNullable: state.column.isNullable,
            columnDefault: state.column.columnDefault,
            extra: state.column.extra,
            generationExpression: state.column.generationExpression,
          },
        ]);
      }
      if (normalized.includes('COUNT(*) AS `total`')) {
        const condition = normalized.slice(normalized.indexOf('WHERE ') + 'WHERE '.length);
        const total = state.rows.filter((row) => matchCondition(row, condition)).length;
        return Promise.resolve([{ total }]);
      }
      if (normalized.includes('SELECT `id` AS `id`')) {
        const condition = normalized
          .slice(normalized.indexOf('WHERE ') + 'WHERE '.length)
          .split(' ORDER BY ')[0];
        const ids = state.rows
          .filter((row) => matchCondition(row, condition))
          .map((row) => row.id)
          .sort((left, right) => left - right)
          .slice(0, 20)
          .map((id) => ({ id }));
        return Promise.resolve(ids);
      }
      throw new Error(`未预期 SQL: ${normalized} params=${JSON.stringify(params)}`);
    },
  };
  return { runner: runner as unknown as QueryRunner, statements };
};

const createMigration = (): TightenRepairRequestRevisionPreviousVersionForV131775502200000 =>
  new TightenRepairRequestRevisionPreviousVersionForV131775502200000();

describe('TightenRepairRequestRevisionPreviousVersionForV131775502200000', () => {
  it('空表直接收紧为非空、无默认，不做任何回填', async () => {
    const state: FakeState = { column: NULLABLE_COLUMN(), rows: [] };
    const { runner, statements } = createFakeQueryRunner(state);

    await createMigration().up(runner);

    expect(state.column?.isNullable).toBe('NO');
    expect(state.column?.columnDefault).toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('MODIFY COLUMN `previous_version` int unsigned NOT NULL');
    expect(statements.join(' ')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('合法首次 0 与后续实际基版本保留并收紧通过', async () => {
    const state: FakeState = {
      column: NULLABLE_COLUMN(),
      rows: [
        { id: 1, previousVersion: 0, revisionNo: 1 },
        { id: 2, previousVersion: 1, revisionNo: 2 },
        { id: 3, previousVersion: 2, revisionNo: 5 },
      ],
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await createMigration().up(runner);

    expect(state.column?.isNullable).toBe('NO');
    expect(state.rows).toEqual([
      { id: 1, previousVersion: 0, revisionNo: 1 },
      { id: 2, previousVersion: 1, revisionNo: 2 },
      { id: 3, previousVersion: 2, revisionNo: 5 },
    ]);
    expect(statements).toHaveLength(1);
  });

  it('存在 NULL 旧行时在任何 ALTER 前拒绝，并输出计数与定位 ID', async () => {
    const state: FakeState = {
      column: NULLABLE_COLUMN(),
      rows: [
        { id: 7, previousVersion: null, revisionNo: 1 },
        { id: 1, previousVersion: 0, revisionNo: 1 },
      ],
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await expect(createMigration().up(runner)).rejects.toThrow(
      /previous_version IS NULL=1（样本 ID: 7）/,
    );
    expect(statements).toEqual([]);
    expect(state.column?.isNullable).toBe('YES');
  });

  it('previous_version = revision_no 时拒绝且零 ALTER', async () => {
    const state: FakeState = {
      column: NOT_NULL_COLUMN(),
      rows: [{ id: 2, previousVersion: 2, revisionNo: 2 }],
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await expect(createMigration().up(runner)).rejects.toThrow(
      /previous_version >= revision_no=1（样本 ID: 2）/,
    );
    expect(statements).toEqual([]);
  });

  it('previous_version > revision_no 时拒绝且零 ALTER', async () => {
    const state: FakeState = {
      column: NOT_NULL_COLUMN(),
      rows: [{ id: 3, previousVersion: 9, revisionNo: 2 }],
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await expect(createMigration().up(runner)).rejects.toThrow(/非法|>= revision_no=1/);
    expect(statements).toEqual([]);
  });

  it('已是终态且数据合法时幂等跳过', async () => {
    const state: FakeState = {
      column: NOT_NULL_COLUMN(),
      rows: [{ id: 1, previousVersion: 0, revisionNo: 1 }],
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await createMigration().up(runner);

    expect(statements).toEqual([]);
  });

  it('类型不符时拒绝收紧', async () => {
    const state: FakeState = {
      column: { ...NULLABLE_COLUMN(), columnType: 'varchar(20)' },
      rows: [],
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await expect(createMigration().up(runner)).rejects.toThrow(/类型不符/);
    expect(statements).toEqual([]);
  });

  it('down 只回退可空性，不伪造或删除版本值', async () => {
    const state: FakeState = {
      column: NOT_NULL_COLUMN(),
      rows: [
        { id: 1, previousVersion: 0, revisionNo: 1 },
        { id: 2, previousVersion: 1, revisionNo: 2 },
      ],
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await createMigration().down(runner);

    expect(state.column?.isNullable).toBe('YES');
    expect(state.rows).toEqual([
      { id: 1, previousVersion: 0, revisionNo: 1 },
      { id: 2, previousVersion: 1, revisionNo: 2 },
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('NULL DEFAULT NULL');
    expect(statements.join(' ')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

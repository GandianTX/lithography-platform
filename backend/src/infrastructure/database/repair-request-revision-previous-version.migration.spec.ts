import type { QueryRunner } from 'typeorm';

import { AddRepairRequestRevisionPreviousVersionForV131775502100000 } from './migrations/1775502100000-add-repair-request-revision-previous-version-for-v13.migration';

interface ColumnState {
  columnType: string;
  isNullable: 'YES' | 'NO';
  columnDefault: string | null;
  extra: string;
  generationExpression: string;
}

interface FakeState {
  column: ColumnState | null;
  checkClause: string | null;
}

const EXPECTED_CLAUSE = '`previous_version` IS NULL OR `previous_version` < `revision_no`';

const createFakeQueryRunner = (state: FakeState) => {
  const statements: string[] = [];
  const runner = {
    query: (sql: string, params?: ReadonlyArray<unknown>): Promise<unknown> => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('ALTER TABLE')) {
        statements.push(normalized);
        if (normalized.includes('DROP COLUMN')) {
          state.column = null;
        }
        if (normalized.includes('DROP CHECK')) {
          state.checkClause = null;
        }
        if (normalized.includes('ADD COLUMN')) {
          state.column = {
            columnType: 'int unsigned',
            isNullable: 'YES',
            columnDefault: null,
            extra: '',
            generationExpression: '',
          };
        }
        if (normalized.includes('ADD CONSTRAINT')) {
          state.checkClause = EXPECTED_CLAUSE;
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
      if (normalized.includes('FROM information_schema.COLUMNS')) {
        return Promise.resolve(state.column ? [{ exists: 1 }] : []);
      }
      if (normalized.includes('FROM information_schema.TABLE_CONSTRAINTS')) {
        return Promise.resolve(state.checkClause ? [{ exists: 1 }] : []);
      }
      if (normalized.includes('FROM information_schema.CHECK_CONSTRAINTS')) {
        return Promise.resolve(state.checkClause ? [{ checkClause: state.checkClause }] : []);
      }
      throw new Error(`未预期 SQL: ${normalized} params=${JSON.stringify(params)}`);
    },
  };
  return { runner: runner as unknown as QueryRunner, statements };
};

const createMigration = (): AddRepairRequestRevisionPreviousVersionForV131775502100000 =>
  new AddRepairRequestRevisionPreviousVersionForV131775502100000();

describe('AddRepairRequestRevisionPreviousVersionForV131775502100000', () => {
  it('空结构时只追加可空列和 NULL 安全 CHECK，不写回填语句', async () => {
    const state: FakeState = { column: null, checkClause: null };
    const { runner, statements } = createFakeQueryRunner(state);

    await createMigration().up(runner);

    expect(state.column).toEqual({
      columnType: 'int unsigned',
      isNullable: 'YES',
      columnDefault: null,
      extra: '',
      generationExpression: '',
    });
    expect(state.checkClause).toBe(EXPECTED_CLAUSE);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('ADD COLUMN `previous_version` int unsigned NULL DEFAULT NULL');
    expect(statements[0]).toContain('AFTER `revision_no`');
    expect(statements[1]).toContain(
      'ADD CONSTRAINT `chk_repair_request_revision_previous_version`',
    );
    expect(statements.join(' ')).not.toMatch(/\b(INSERT|UPDATE)\b/);
  });

  it('已存在正确列和 CHECK 时幂等跳过', async () => {
    const state: FakeState = {
      column: {
        columnType: 'int unsigned',
        isNullable: 'YES',
        columnDefault: null,
        extra: '',
        generationExpression: '',
      },
      checkClause: EXPECTED_CLAUSE,
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await createMigration().up(runner);

    expect(statements).toEqual([]);
  });

  it('同名列表为非空时拒绝复用', async () => {
    const state: FakeState = {
      column: {
        columnType: 'int unsigned',
        isNullable: 'NO',
        columnDefault: null,
        extra: '',
        generationExpression: '',
      },
      checkClause: null,
    };
    const { runner } = createFakeQueryRunner(state);

    await expect(createMigration().up(runner)).rejects.toThrow(/定义不符/);
  });

  it('同名列表类型不符时拒绝复用', async () => {
    const state: FakeState = {
      column: {
        columnType: 'varchar(20)',
        isNullable: 'YES',
        columnDefault: null,
        extra: '',
        generationExpression: '',
      },
      checkClause: null,
    };
    const { runner } = createFakeQueryRunner(state);

    await expect(createMigration().up(runner)).rejects.toThrow(/定义不符/);
  });

  it('同名 CHECK 表达式不符时重建', async () => {
    const state: FakeState = {
      column: {
        columnType: 'int unsigned',
        isNullable: 'YES',
        columnDefault: null,
        extra: '',
        generationExpression: '',
      },
      checkClause: '`previous_version` <= `revision_no`',
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await createMigration().up(runner);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DROP CHECK');
    expect(statements[0]).toContain('ADD CONSTRAINT');
    expect(state.checkClause).toBe(EXPECTED_CLAUSE);
  });

  it('down 只删除新增的 CHECK 和列', async () => {
    const state: FakeState = {
      column: {
        columnType: 'int unsigned',
        isNullable: 'YES',
        columnDefault: null,
        extra: '',
        generationExpression: '',
      },
      checkClause: EXPECTED_CLAUSE,
    };
    const { runner, statements } = createFakeQueryRunner(state);

    await createMigration().down(runner);

    expect(state.column).toBeNull();
    expect(state.checkClause).toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DROP CHECK');
    expect(statements[0]).toContain('DROP COLUMN');
  });
});

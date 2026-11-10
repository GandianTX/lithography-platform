import type { DataSource } from 'typeorm';

import {
  CHECK_DEFINITIONS,
  COLUMN_DEFINITIONS,
  FOREIGN_KEY_DEFINITIONS,
  GENERATED_COLUMN_DEFINITIONS,
  INDEX_DEFINITIONS,
  REQUIRED_INDEXES,
  collectPrefixStructureRequirements,
} from './migration-schema-contract';
import {
  assertRequiredStructureDefinitions,
  collectDefinitionCoverageIssues,
  collectDefinitionCoverageStatistics,
  type DefinitionCoverageInput,
} from './migration-structure-definition-verifier';
import { inspectMigrationState, verifyMigrationState } from './incremental-migration';

interface Overrides {
  readonly column?: Readonly<Record<string, Record<string, unknown>>>;
  readonly generated?: Readonly<Record<string, string>>;
  readonly generatedExtra?: Readonly<Record<string, string>>;
  readonly index?: Readonly<Record<string, { unique?: boolean; columns?: ReadonlyArray<string> }>>;
  readonly check?: Readonly<Record<string, string>>;
  readonly checkEnforced?: Readonly<Record<string, string>>;
  readonly missingIndex?: ReadonlyArray<string>;
  readonly tables?: ReadonlyArray<string>;
  readonly foreignKey?: Readonly<
    Record<
      string,
      {
        referenceTable?: string;
        localColumns?: ReadonlyArray<string>;
        referenceColumns?: ReadonlyArray<string>;
        deleteRule?: string;
        updateRule?: string;
      }
    >
  >;
}

const at = <T>(key: string, value: T): Record<string, T> => ({ [key]: value });

const createFakeDataSource = (overrides: Overrides): DataSource => {
  const fake = {
    options: { host: '127.0.0.1', port: 3306, database: 'fake_db' },
    migrations: [{ name: 'Fake1775502000000' }],
    query: (sql: string, params: ReadonlyArray<string>): Promise<unknown> => {
      if (sql.includes('SELECT DATABASE()')) {
        return Promise.resolve([{ current_database: 'fake_db', server_version: '8.0.36' }]);
      }
      if (sql.includes("table_name = 'migrations'")) {
        return Promise.resolve([{ exists: 1 }]);
      }
      if (sql.includes('FROM migrations')) {
        return Promise.resolve([{ id: 1, timestamp: 1775502000000, name: 'Fake1775502000000' }]);
      }
      if (sql.includes('FROM information_schema.columns')) {
        if (sql.includes('generation_expression') && !sql.includes('column_type')) {
          const [, table, column] = params;
          const key = `${table}.${column}`;
          const expected = GENERATED_COLUMN_DEFINITIONS[key];
          const expression = overrides.generated?.[key] ?? expected?.expression ?? '(`id`)';
          const extra =
            overrides.generatedExtra?.[key] ??
            (expected
              ? expected.stored
                ? 'STORED GENERATED'
                : 'VIRTUAL GENERATED'
              : 'STORED GENERATED');
          return Promise.resolve([{ generation_expression: expression, extra }]);
        }
        if (!sql.includes('column_type')) {
          return Promise.resolve([]);
        }
        const [, table, column] = params;
        const key = `${table}.${column}`;
        const base = COLUMN_DEFINITIONS[key];
        if (!base) return Promise.resolve([]);
        return Promise.resolve([
          {
            column_type: base.columnType,
            is_nullable: base.nullable ? 'YES' : 'NO',
            column_default: base.defaultValue ?? null,
            generation_expression: null,
            ...overrides.column?.[key],
          },
        ]);
      }
      if (sql.includes('FROM information_schema.statistics')) {
        const [, table, index] = params;
        const key = `${table}.${index}`;
        if (overrides.missingIndex?.includes(key)) return Promise.resolve([]);
        const base = INDEX_DEFINITIONS[key];
        if (!base) return Promise.resolve([]);
        const adjusted = { ...base, ...overrides.index?.[key] };
        return Promise.resolve(
          adjusted.columns.map((column) => ({
            column_name: column,
            non_unique: adjusted.unique ? 0 : 1,
          })),
        );
      }
      if (sql.includes('FROM information_schema.check_constraints')) {
        const [, table, constraint] = params;
        const key = `${table}.${constraint}`;
        const base = CHECK_DEFINITIONS[key];
        if (!base) return Promise.resolve([]);
        return Promise.resolve([
          {
            check_clause: overrides.check?.[key] ?? base.clause,
            enforced: overrides.checkEnforced?.[key] ?? 'YES',
          },
        ]);
      }
      if (sql.includes('FROM information_schema.tables')) {
        return Promise.resolve((overrides.tables ?? []).map((table) => ({ table_name: table })));
      }
      if (sql.includes('FROM information_schema.key_column_usage')) {
        const [, table, constraint] = params;
        const key = `${table}.${constraint}`;
        const base = FOREIGN_KEY_DEFINITIONS[key];
        if (!base) return Promise.resolve([]);
        const adjusted = {
          referenceTable: overrides.foreignKey?.[key]?.referenceTable ?? base.referenceTable,
          localColumns: overrides.foreignKey?.[key]?.localColumns ?? base.localColumns,
          referenceColumns: overrides.foreignKey?.[key]?.referenceColumns ?? base.referenceColumns,
          deleteRule: overrides.foreignKey?.[key]?.deleteRule ?? base.onDelete ?? 'RESTRICT',
          updateRule: overrides.foreignKey?.[key]?.updateRule ?? base.onUpdate ?? 'RESTRICT',
        };
        return Promise.resolve(
          adjusted.localColumns.map((localColumn, position) => ({
            local_column: localColumn,
            reference_table: adjusted.referenceTable,
            reference_column: adjusted.referenceColumns[position],
            delete_rule: adjusted.deleteRule,
            update_rule: adjusted.updateRule,
          })),
        );
      }
      return Promise.resolve([]);
    },
  };
  return fake as unknown as DataSource;
};

describe('必要索引的精确登记', () => {
  it('REQUIRED_INDEXES 每一条都必须有唯一性与列序定义，避免只补单个名称', () => {
    const missing = REQUIRED_INDEXES.map(({ table, index }) => `${table}.${index}`).filter(
      (key) => !Object.prototype.hasOwnProperty.call(INDEX_DEFINITIONS, key),
    );

    expect(missing).toEqual([]);
  });

  it('uk_login_name 必须按登录名列唯一登记', () => {
    expect(INDEX_DEFINITIONS['base_user_account.uk_login_name']).toEqual({
      unique: true,
      columns: ['login_name'],
    });
    expect(
      REQUIRED_INDEXES.some(
        ({ table, index }) => table === 'base_user_account' && index === 'uk_login_name',
      ),
    ).toBe(true);
  });
});

describe('assertRequiredStructureDefinitions', () => {
  it('完整匹配的定义全部通过', async () => {
    await expect(
      assertRequiredStructureDefinitions(createFakeDataSource({}), 'lithography_v13_delivery_dev'),
    ).resolves.toBeUndefined();
  });

  it('1775501900000 之前的本期字段类型不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          column: at('stored_file.file_id', { column_type: 'bigint' }),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/stored_file\.file_id.*列类型不符/);
  });

  it('1775501900000 之前的本期 CHECK 表达式不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          check: at('stored_file.chk_stored_file_status', "(`status` IN ('READY'))"),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/关键 CHECK 定义漂移: stored_file\.chk_stored_file_status/);
  });

  it('关键 CHECK 存在但未强制执行时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          checkEnforced: at('stored_file.chk_stored_file_status', 'NO'),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/关键 CHECK 未强制执行: stored_file\.chk_stored_file_status/);
  });

  it('同名字段但类型不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          column: at('sync_conflict.local_version', { column_type: 'int' }),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/sync_conflict\.local_version.*列类型不符/);
  });

  it('同名字段可空/默认值不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          column: at('sync_conflict.decision', { is_nullable: 'YES', column_default: null }),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/sync_conflict\.decision.*列默认值不符/);
  });

  it('生成列同名但表达式为空时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          generated: at('organization_membership.active_account_id', ''),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/关键生成列缺少生成表达式/);
  });

  it('同名索引但列顺序或唯一性不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          index: at('management_audit_event.idx_management_audit_target', {
            columns: ['target_id', 'target_type', 'created_at'],
          }),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/关键索引定义漂移: management_audit_event\.idx_management_audit_target/);
  });

  it('同名 CHECK 但表达式不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          check: at(
            'repair_request.chk_repair_request_closure',
            '((`closure_status` IS NULL AND `closed_at` IS NULL) OR ' +
              "(`closure_status` = 'OPEN' AND `closed_at` IS NOT NULL))",
          ),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/关键 CHECK 定义漂移: repair_request\.chk_repair_request_closure/);
  });

  it('同名外键但引用表不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          foreignKey: at('management_audit_event.fk_management_audit_actor', {
            referenceTable: 'organization',
          }),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/关键外键定义漂移: management_audit_event\.fk_management_audit_actor/);
  });

  it('同名外键但删除规则不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          foreignKey: at('maintenance_report_fault.fk_maintenance_report_fault_report', {
            deleteRule: 'CASCADE',
          }),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(
      /关键外键定义漂移: maintenance_report_fault\.fk_maintenance_report_fault_report/,
    );
  });

  it('生成列表达式非空但不一致时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          generated: at(
            'organization_membership.active_account_id',
            "IF(`status` = 'INACTIVE', `account_id`, NULL)",
          ),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/关键生成列表达式漂移: organization_membership\.active_account_id/);
  });

  it('生成列存储方式不符时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          generatedExtra: at('organization_membership.active_account_id', 'VIRTUAL GENERATED'),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/关键生成列存储方式漂移: organization_membership\.active_account_id/);
  });

  it('MySQL 归一化后的生成表达式仍判定为一致', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          generated: at(
            'organization_membership.active_account_id',
            "if((`status` = _utf8mb4'ACTIVE'),`account_id`,null)",
          ),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).resolves.toBeUndefined();
  });

  it('previous_version 由第 44 条收紧为非空，仍可空时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          column: at('repair_request_revision.previous_version', { is_nullable: 'YES' }),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/repair_request_revision\.previous_version/);
  });

  it('previous_version CHECK 表达式漂移时失败关闭', async () => {
    await expect(
      assertRequiredStructureDefinitions(
        createFakeDataSource({
          check: at(
            'repair_request_revision.chk_repair_request_revision_previous_version',
            '`previous_version` IS NULL OR `previous_version` <= `revision_no`',
          ),
        }),
        'lithography_v13_delivery_dev',
      ),
    ).rejects.toThrow(/chk_repair_request_revision_previous_version/);
  });
});

const omitKey = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...record };
  delete copy[key];
  return copy;
};

const emptyCoverageInput = (): DefinitionCoverageInput => ({
  registry: {
    newTableColumns: {},
    existingTableColumns: [],
    columns: [],
    checks: [],
    indexes: [],
    foreignKeys: [],
    generatedColumns: [],
  },
  requiredColumns: [],
  columnDefinitions: {},
  requiredChecks: [],
  checkDefinitions: {},
  requiredIndexes: [],
  indexDefinitions: {},
  requiredForeignKeys: [],
  foreignKeyDefinitions: {},
  requiredGeneratedColumns: [],
  generatedDefinitions: {},
});

describe('collectDefinitionCoverageIssues', () => {
  it('1775501900000 之前的本期字段漏登记时拒绝', () => {
    const issues = collectDefinitionCoverageIssues({
      ...emptyCoverageInput(),
      registry: {
        newTableColumns: { stored_file: ['file_id'] },
        existingTableColumns: [],
        columns: ['stored_file.file_id'],
        checks: [],
        indexes: [],
        foreignKeys: [],
        generatedColumns: [],
      },
    });

    expect(issues).toContain('本期字段要求缺失: stored_file.file_id');
    expect(issues).toContain('本期字段缺少精确定义: stored_file.file_id');
  });

  it('1775501900000 之前的本期字段缺少定义时拒绝', () => {
    const issues = collectDefinitionCoverageIssues({
      columnDefinitions: omitKey(COLUMN_DEFINITIONS, 'stored_file.file_id'),
    });

    expect(issues).toContain('本期字段缺少精确定义: stored_file.file_id');
  });

  it('1775501900000 之前的本期 CHECK 漏登记时拒绝', () => {
    const issues = collectDefinitionCoverageIssues({
      ...emptyCoverageInput(),
      registry: {
        newTableColumns: {},
        existingTableColumns: [],
        columns: [],
        checks: ['stored_file.chk_stored_file_status'],
        indexes: [],
        foreignKeys: [],
        generatedColumns: [],
      },
    });

    expect(issues).toContain('本期CHECK 要求缺失: stored_file.chk_stored_file_status');
    expect(issues).toContain('本期CHECK 缺少精确定义: stored_file.chk_stored_file_status');
  });

  it('1775501900000 之前的本期 CHECK 缺少表达式时拒绝', () => {
    const issues = collectDefinitionCoverageIssues({
      checkDefinitions: omitKey(CHECK_DEFINITIONS, 'stored_file.chk_stored_file_status'),
    });

    expect(issues).toContain('本期CHECK 缺少精确定义: stored_file.chk_stored_file_status');
  });

  it('本期新增表遗漏字段要求时拒绝', () => {
    const issues = collectDefinitionCoverageIssues({
      ...emptyCoverageInput(),
      registry: {
        newTableColumns: { stored_file: ['file_id', 'original_filename'] },
        existingTableColumns: [],
        columns: ['stored_file.file_id', 'stored_file.original_filename'],
        checks: [],
        indexes: [],
        foreignKeys: [],
        generatedColumns: [],
      },
      requiredColumns: [{ table: 'stored_file', column: 'file_id' }],
      columnDefinitions: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- 键为 table.column 结构标识
        'stored_file.file_id': {},
        // eslint-disable-next-line @typescript-eslint/naming-convention -- 键为 table.column 结构标识
        'stored_file.original_filename': {},
      },
    });

    expect(issues).toContain('本期字段要求缺失: stored_file.original_filename');
    expect(issues).not.toContain('本期字段要求缺失: stored_file.file_id');
  });

  it('登记了结构要求之外的定义时报错', () => {
    const issues = collectDefinitionCoverageIssues({
      columnDefinitions: {
        ...COLUMN_DEFINITIONS,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- 键为 table.column 结构标识
        'sync_conflict.unplanned_column': {},
      },
    });

    expect(issues).toContain('字段定义未登记于结构要求: sync_conflict.unplanned_column');
  });

  it('本期交付生成列缺少定义时报错', () => {
    const issues = collectDefinitionCoverageIssues({
      ...emptyCoverageInput(),
      registry: {
        newTableColumns: {},
        existingTableColumns: [],
        columns: [],
        checks: [],
        indexes: [],
        foreignKeys: [],
        generatedColumns: ['organization_membership.active_account_id'],
      },
      requiredGeneratedColumns: [{ table: 'organization_membership', column: 'active_account_id' }],
    });

    expect(issues).toContain('本期生成列缺少精确定义: organization_membership.active_account_id');
  });

  it('正确结构覆盖完整，历史对象单列为沿用', () => {
    expect(collectDefinitionCoverageIssues()).toEqual([]);

    expect(collectDefinitionCoverageStatistics()).toEqual([
      { kind: 'column', expected: 280, covered: 280, missing: 0, inherited: 79 },
      { kind: 'check', expected: 110, covered: 110, missing: 0, inherited: 82 },
      { kind: 'index', expected: 43, covered: 43, missing: 0, inherited: 70 },
      { kind: 'foreignKey', expected: 51, covered: 51, missing: 0, inherited: 59 },
      { kind: 'generatedColumn', expected: 0, covered: 0, missing: 0, inherited: 4 },
    ]);
  });
});

describe('升级前结构要求', () => {
  it('未执行 1775501200000 时不提前要求 stored_file 字段', () => {
    const before = collectPrefixStructureRequirements(new Set([1775501100000]));
    expect(
      before.some(
        (item) => item.kind === 'column' && item.table === 'stored_file' && item.name === 'file_id',
      ),
    ).toBe(false);

    const after = collectPrefixStructureRequirements(new Set([1775501200000]));
    expect(
      after.some(
        (item) => item.kind === 'column' && item.table === 'stored_file' && item.name === 'file_id',
      ),
    ).toBe(true);
  });
});

describe('正式部署入口接线', () => {
  it('verifyMigrationState 会执行定义级校验并保留漂移问题', async () => {
    const report = await verifyMigrationState(
      createFakeDataSource({
        column: at('sync_conflict.local_version', { column_type: 'bigint' }),
      }),
      'fake_db',
    );

    expect(report.issues.join('\n')).toContain(
      '关键字段定义漂移: sync_conflict.local_version 列类型不符',
    );
  });

  it('verifyMigrationState 对缺失的登录名唯一索引失败关闭', async () => {
    const report = await verifyMigrationState(
      createFakeDataSource({ missingIndex: ['base_user_account.uk_login_name'] }),
      'fake_db',
    );

    expect(report.issues.join('\n')).toContain('关键索引缺失: base_user_account.uk_login_name');
  });

  it('verifyMigrationState 对 NOT ENFORCED 的关键 CHECK 失败关闭', async () => {
    const report = await verifyMigrationState(
      createFakeDataSource({
        checkEnforced: at('stored_file.chk_stored_file_status', 'NO'),
      }),
      'fake_db',
    );

    expect(report.issues.join('\n')).toContain(
      '关键 CHECK 未强制执行: stored_file.chk_stored_file_status',
    );
  });
});

describe('未知业务表', () => {
  it('pending 执行前发现未知表时拒绝', async () => {
    const report = await inspectMigrationState(
      createFakeDataSource({ tables: ['migrations', 'base_user_account', 'rogue_table'] }),
      'fake_db',
    );

    expect(report.issues.join('\n')).toContain('存在预期之外的业务表: rogue_table');
  });

  it('终态校验发现未知表时拒绝', async () => {
    const report = await verifyMigrationState(
      createFakeDataSource({ tables: ['migrations', 'base_user_account', 'rogue_table'] }),
      'fake_db',
    );

    expect(report.issues.join('\n')).toContain('存在预期之外的业务表: rogue_table');
  });
});

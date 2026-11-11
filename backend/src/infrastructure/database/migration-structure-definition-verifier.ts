import type { DataSource } from 'typeorm';

import {
  CHECK_DEFINITIONS,
  COLUMN_DEFINITIONS,
  DELIVERY_STRUCTURE_REGISTRY,
  FOREIGN_KEY_DEFINITIONS,
  GENERATED_COLUMN_DEFINITIONS,
  INDEX_DEFINITIONS,
  REQUIRED_CHECKS,
  REQUIRED_COLUMNS,
  REQUIRED_FOREIGN_KEYS,
  REQUIRED_GENERATED_COLUMNS,
  REQUIRED_INDEXES,
  type DeliveryStructureRegistry,
} from './migration-schema-contract';
import {
  compareColumnDefinition,
  normalizeCheckClause,
  normalizeMysqlCheckClauseText,
} from './incremental-migration';

const splitKey = (key: string): readonly [string, string] => {
  const separator = key.indexOf('.');
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error(`结构定义键格式无效: ${key}`);
  }
  return [key.slice(0, separator), key.slice(separator + 1)];
};

const keyOf = (table: string, name: string): string => `${table}.${name}`;

const rowsOf = (value: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (!Array.isArray(value)) {
    throw new Error('结构定义查询返回格式异常，预期为数组');
  }
  return value as ReadonlyArray<Record<string, unknown>>;
};

const readString = (row: Record<string, unknown>, key: string): string => {
  const value = row[key] ?? row[key.toUpperCase()];
  if (typeof value !== 'string') {
    throw new Error(`结构定义查询结果缺少字符串字段 ${key}`);
  }
  return value;
};

const readOptionalString = (row: Record<string, unknown>, key: string): string | null => {
  const value = row[key] ?? row[key.toUpperCase()];
  return typeof value === 'string' ? value : null;
};

/**
 * 定义覆盖入参：默认使用冻结契约；测试可注入缺口清单验证报错路径。
 *
 * 覆盖范围只取自 DELIVERY_STRUCTURE_REGISTRY 的显式登记，
 * 不再用时间戳推断，避免 1775501900000 之前的本期对象被整体漏检。
 */
export interface DefinitionCoverageInput {
  readonly registry?: DeliveryStructureRegistry;
  readonly requiredColumns?: ReadonlyArray<{ readonly table: string; readonly column: string }>;
  readonly requiredChecks?: ReadonlyArray<{ readonly table: string; readonly constraint: string }>;
  readonly requiredIndexes?: ReadonlyArray<{ readonly table: string; readonly index: string }>;
  readonly requiredForeignKeys?: ReadonlyArray<{
    readonly table: string;
    readonly constraint: string;
  }>;
  readonly requiredGeneratedColumns?: ReadonlyArray<{
    readonly table: string;
    readonly column: string;
  }>;
  readonly columnDefinitions?: Readonly<Record<string, unknown>>;
  readonly checkDefinitions?: Readonly<Record<string, unknown>>;
  readonly indexDefinitions?: Readonly<Record<string, unknown>>;
  readonly foreignKeyDefinitions?: Readonly<Record<string, unknown>>;
  readonly generatedDefinitions?: Readonly<Record<string, unknown>>;
}

interface CoverageContext {
  readonly registry: DeliveryStructureRegistry;
  readonly deliveryColumnKeys: ReadonlySet<string>;
  readonly deliveryCheckKeys: ReadonlySet<string>;
  readonly deliveryIndexKeys: ReadonlySet<string>;
  readonly deliveryForeignKeyKeys: ReadonlySet<string>;
  readonly deliveryGeneratedKeys: ReadonlySet<string>;
  readonly requiredColumnKeys: ReadonlySet<string>;
  readonly requiredCheckKeys: ReadonlySet<string>;
  readonly requiredIndexKeys: ReadonlySet<string>;
  readonly requiredForeignKeyKeys: ReadonlySet<string>;
  readonly requiredGeneratedKeys: ReadonlySet<string>;
  readonly columnDefinitions: Readonly<Record<string, unknown>>;
  readonly checkDefinitions: Readonly<Record<string, unknown>>;
  readonly indexDefinitions: Readonly<Record<string, unknown>>;
  readonly foreignKeyDefinitions: Readonly<Record<string, unknown>>;
  readonly generatedDefinitions: Readonly<Record<string, unknown>>;
}

const keysOf = <T>(items: ReadonlyArray<T>, toKey: (item: T) => string): ReadonlySet<string> =>
  new Set(items.map(toKey));

const resolveCoverageContext = (input: DefinitionCoverageInput): CoverageContext => {
  const registry = input.registry ?? DELIVERY_STRUCTURE_REGISTRY;
  const requiredColumns = input.requiredColumns ?? REQUIRED_COLUMNS;
  const requiredChecks = input.requiredChecks ?? REQUIRED_CHECKS;
  const requiredIndexes = input.requiredIndexes ?? REQUIRED_INDEXES;
  const requiredForeignKeys = input.requiredForeignKeys ?? REQUIRED_FOREIGN_KEYS;
  const requiredGenerated = input.requiredGeneratedColumns ?? REQUIRED_GENERATED_COLUMNS;

  const deliveryColumnKeys = new Set<string>(registry.columns);
  for (const [table, columns] of Object.entries(registry.newTableColumns)) {
    for (const column of columns) {
      deliveryColumnKeys.add(keyOf(table, column));
    }
  }

  return {
    registry,
    deliveryColumnKeys,
    deliveryCheckKeys: new Set(registry.checks),
    deliveryIndexKeys: new Set(registry.indexes),
    deliveryForeignKeyKeys: new Set(registry.foreignKeys),
    deliveryGeneratedKeys: new Set(registry.generatedColumns),
    requiredColumnKeys: keysOf(requiredColumns, (item) => keyOf(item.table, item.column)),
    requiredCheckKeys: keysOf(requiredChecks, (item) => keyOf(item.table, item.constraint)),
    requiredIndexKeys: keysOf(requiredIndexes, (item) => keyOf(item.table, item.index)),
    requiredForeignKeyKeys: keysOf(requiredForeignKeys, (item) =>
      keyOf(item.table, item.constraint),
    ),
    requiredGeneratedKeys: keysOf(requiredGenerated, (item) => keyOf(item.table, item.column)),
    columnDefinitions: input.columnDefinitions ?? COLUMN_DEFINITIONS,
    checkDefinitions: input.checkDefinitions ?? CHECK_DEFINITIONS,
    indexDefinitions: input.indexDefinitions ?? INDEX_DEFINITIONS,
    foreignKeyDefinitions: input.foreignKeyDefinitions ?? FOREIGN_KEY_DEFINITIONS,
    generatedDefinitions: input.generatedDefinitions ?? GENERATED_COLUMN_DEFINITIONS,
  };
};

/**
 * 显式交付清单必须在结构化要求与精确定义中同时落地。
 * 缺少任一环节都拒绝，避免“登记了字段但没定义”或“有定义但未纳入要求”。
 */
const collectDeliveryGapIssues = (
  expectedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
  definitions: Readonly<Record<string, unknown>>,
  label: string,
): string[] => {
  const issues: string[] = [];
  for (const key of expectedKeys) {
    if (!requiredKeys.has(key)) {
      issues.push(`本期${label}要求缺失: ${key}`);
    }
    if (definitions[key] === undefined) {
      issues.push(`本期${label}缺少精确定义: ${key}`);
    }
  }
  return issues;
};

/**
 * 新增表字段清单与汇总清单必须双向一致：
 * 既不能漏掉新增表字段，也不能让汇总清单出现未归类的字段。
 */
const collectColumnRegistryIssues = (registry: DeliveryStructureRegistry): string[] => {
  const issues: string[] = [];
  const declared = new Set<string>([
    ...Object.entries(registry.newTableColumns).flatMap(([table, columns]) =>
      columns.map((column) => keyOf(table, column)),
    ),
    ...registry.existingTableColumns,
  ]);
  const aggregated = new Set(registry.columns);
  for (const key of declared) {
    if (!aggregated.has(key)) {
      issues.push(`本期字段清单未汇总: ${key}`);
    }
  }
  for (const key of aggregated) {
    if (!declared.has(key)) {
      issues.push(`本期字段未归入新增表或既有表清单: ${key}`);
    }
  }
  return issues;
};

const collectOrphanDefinitionIssues = (
  definitions: Readonly<Record<string, unknown>>,
  requiredKeys: ReadonlySet<string>,
  label: string,
): string[] =>
  Object.keys(definitions)
    .filter((key) => !requiredKeys.has(key))
    .map((key) => `${label}定义未登记于结构要求: ${key}`);

/**
 * 继承 CHECK 同样属于最终态结构要求；缺少精确定义时不得静默跳过。
 */
const collectInheritedCheckGapIssues = (
  requiredKeys: ReadonlySet<string>,
  deliveryKeys: ReadonlySet<string>,
  definitions: Readonly<Record<string, unknown>>,
): string[] => {
  const issues: string[] = [];
  for (const key of requiredKeys) {
    if (!deliveryKeys.has(key) && definitions[key] === undefined) {
      issues.push(`继承CHECK 缺少精确定义: ${key}`);
    }
  }
  return issues;
};

/**
 * 覆盖完整性：本期交付清单中的字段/CHECK/索引/外键/生成列
 * 必须同时出现在结构化要求与精确定义中，定义也不得指向设计之外的名称。
 */
export function collectDefinitionCoverageIssues(
  input: DefinitionCoverageInput = {},
): ReadonlyArray<string> {
  const context = resolveCoverageContext(input);
  return [
    ...collectColumnRegistryIssues(context.registry),
    ...collectDeliveryGapIssues(
      context.deliveryColumnKeys,
      context.requiredColumnKeys,
      context.columnDefinitions,
      '字段',
    ),
    ...collectOrphanDefinitionIssues(context.columnDefinitions, context.requiredColumnKeys, '字段'),
    ...collectInheritedCheckGapIssues(
      context.requiredCheckKeys,
      context.deliveryCheckKeys,
      context.checkDefinitions,
    ),
    ...collectDeliveryGapIssues(
      context.deliveryCheckKeys,
      context.requiredCheckKeys,
      context.checkDefinitions,
      'CHECK ',
    ),
    ...collectOrphanDefinitionIssues(context.checkDefinitions, context.requiredCheckKeys, 'CHECK '),
    ...collectDeliveryGapIssues(
      context.deliveryIndexKeys,
      context.requiredIndexKeys,
      context.indexDefinitions,
      '索引',
    ),
    ...collectOrphanDefinitionIssues(context.indexDefinitions, context.requiredIndexKeys, '索引'),
    ...collectDeliveryGapIssues(
      context.deliveryForeignKeyKeys,
      context.requiredForeignKeyKeys,
      context.foreignKeyDefinitions,
      '外键',
    ),
    ...collectOrphanDefinitionIssues(
      context.foreignKeyDefinitions,
      context.requiredForeignKeyKeys,
      '外键',
    ),
    ...collectDeliveryGapIssues(
      context.deliveryGeneratedKeys,
      context.requiredGeneratedKeys,
      context.generatedDefinitions,
      '生成列',
    ),
    ...collectOrphanDefinitionIssues(
      context.generatedDefinitions,
      context.requiredGeneratedKeys,
      '生成列',
    ),
  ];
}

export interface DefinitionCoverageStatistics {
  readonly kind: 'column' | 'check' | 'index' | 'foreignKey' | 'generatedColumn';
  readonly expected: number;
  readonly covered: number;
  readonly missing: number;
  readonly inherited: number;
}

const countStatistics = (
  kind: DefinitionCoverageStatistics['kind'],
  expectedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
  definitions: Readonly<Record<string, unknown>>,
): DefinitionCoverageStatistics => {
  let covered = 0;
  for (const key of expectedKeys) {
    if (requiredKeys.has(key) && definitions[key] !== undefined) {
      covered += 1;
    }
  }
  let inherited = 0;
  for (const key of requiredKeys) {
    if (!expectedKeys.has(key)) {
      inherited += 1;
    }
  }
  return {
    kind,
    expected: expectedKeys.size,
    covered,
    missing: expectedKeys.size - covered,
    inherited,
  };
};

/** 按对象类型输出“应覆盖数/已覆盖数/缺失数”，并单列历史沿用数量。 */
export function collectDefinitionCoverageStatistics(
  input: DefinitionCoverageInput = {},
): ReadonlyArray<DefinitionCoverageStatistics> {
  const context = resolveCoverageContext(input);
  return [
    countStatistics(
      'column',
      context.deliveryColumnKeys,
      context.requiredColumnKeys,
      context.columnDefinitions,
    ),
    countStatistics(
      'check',
      context.deliveryCheckKeys,
      context.requiredCheckKeys,
      context.checkDefinitions,
    ),
    countStatistics(
      'index',
      context.deliveryIndexKeys,
      context.requiredIndexKeys,
      context.indexDefinitions,
    ),
    countStatistics(
      'foreignKey',
      context.deliveryForeignKeyKeys,
      context.requiredForeignKeyKeys,
      context.foreignKeyDefinitions,
    ),
    countStatistics(
      'generatedColumn',
      context.deliveryGeneratedKeys,
      context.requiredGeneratedKeys,
      context.generatedDefinitions,
    ),
  ];
}

/**
 * 定义级校验：覆盖完整性 + information_schema 实际定义比较。
 * 正式 migrate verify 与空库 init 终态校验共用本入口，避免两套口径。
 */
export async function collectRequiredStructureDefinitionIssues(
  dataSource: DataSource,
  databaseName: string,
): Promise<ReadonlyArray<string>> {
  const issues = [...collectDefinitionCoverageIssues()];
  issues.push(...(await collectColumnDefinitionIssues(dataSource, databaseName)));
  issues.push(...(await collectGeneratedColumnIssues(dataSource, databaseName)));
  issues.push(...(await collectIndexDefinitionIssues(dataSource, databaseName)));
  issues.push(...(await collectCheckDefinitionIssues(dataSource, databaseName)));
  issues.push(...(await collectForeignKeyDefinitionIssues(dataSource, databaseName)));
  return issues;
}

/**
 * 严格入口：任一覆盖或定义漂移即失败关闭。
 */
export async function assertRequiredStructureDefinitions(
  dataSource: DataSource,
  databaseName: string,
): Promise<void> {
  const issues = await collectRequiredStructureDefinitionIssues(dataSource, databaseName);
  if (issues.length > 0) {
    throw new Error(issues.join('；'));
  }
}

async function collectColumnDefinitionIssues(
  dataSource: DataSource,
  databaseName: string,
): Promise<ReadonlyArray<string>> {
  const issues: string[] = [];
  for (const [key, expected] of Object.entries(COLUMN_DEFINITIONS)) {
    const [table, column] = splitKey(key);
    const rows = rowsOf(
      await dataSource.query(
        `SELECT column_type, is_nullable, column_default, generation_expression
           FROM information_schema.columns
          WHERE table_schema = ?
            AND table_name = ?
            AND column_name = ?
          LIMIT 1`,
        [databaseName, table, column],
      ),
    );
    if (rows.length === 0) {
      issues.push(`关键字段定义缺失: ${key}`);
      continue;
    }
    const row = rows[0];
    const drift = compareColumnDefinition(expected, {
      columnType: readOptionalString(row, 'column_type'),
      nullable: readOptionalString(row, 'is_nullable'),
      defaultValue: readOptionalString(row, 'column_default'),
      generatedExpression: readOptionalString(row, 'generation_expression'),
    });
    for (const issue of drift) {
      issues.push(`关键字段定义漂移: ${key} ${issue}`);
    }
  }
  return issues;
}

async function collectGeneratedColumnIssues(
  dataSource: DataSource,
  databaseName: string,
): Promise<ReadonlyArray<string>> {
  const issues: string[] = [];
  for (const [key, expected] of Object.entries(GENERATED_COLUMN_DEFINITIONS)) {
    const [table, column] = splitKey(key);
    const rows = rowsOf(
      await dataSource.query(
        `SELECT generation_expression, extra
           FROM information_schema.columns
          WHERE table_schema = ?
            AND table_name = ?
            AND column_name = ?
          LIMIT 1`,
        [databaseName, table, column],
      ),
    );
    if (rows.length === 0) {
      issues.push(`关键生成列缺失: ${key}`);
      continue;
    }
    const actual = readOptionalString(rows[0], 'generation_expression');
    if (actual === null || actual.trim().length === 0) {
      issues.push(`关键生成列缺少生成表达式: ${key}`);
      continue;
    }
    const extra = (readOptionalString(rows[0], 'extra') ?? '').toUpperCase();
    const actualStored = extra.includes('STORED GENERATED');
    const actualVirtual = extra.includes('VIRTUAL GENERATED');
    if (!actualStored && !actualVirtual) {
      issues.push(`关键生成列缺少存储方式: ${key}`);
      continue;
    }
    if (actualStored !== expected.stored) {
      issues.push(
        `关键生成列存储方式漂移: ${key} 期望 ${expected.stored ? 'STORED' : 'VIRTUAL'}；` +
          `实际 ${actualStored ? 'STORED' : 'VIRTUAL'}`,
      );
    }
    const normalizedActual = normalizeCheckClause(normalizeMysqlCheckClauseText(actual));
    if (normalizedActual !== normalizeCheckClause(expected.expression)) {
      issues.push(`关键生成列表达式漂移: ${key} 期望 ${expected.expression}；实际 ${actual}`);
    }
  }
  return issues;
}

async function collectIndexDefinitionIssues(
  dataSource: DataSource,
  databaseName: string,
): Promise<ReadonlyArray<string>> {
  const issues: string[] = [];
  for (const [key, expected] of Object.entries(INDEX_DEFINITIONS)) {
    const [table, index] = splitKey(key);
    const rows = rowsOf(
      await dataSource.query(
        `SELECT column_name, non_unique
           FROM information_schema.statistics
          WHERE table_schema = ?
            AND table_name = ?
            AND index_name = ?
          ORDER BY seq_in_index`,
        [databaseName, table, index],
      ),
    );
    if (rows.length === 0) {
      issues.push(`关键索引定义缺失: ${key}`);
      continue;
    }
    const actualColumns = rows.map((row) => readString(row, 'column_name'));
    const actualUnique = Number(rows[0].non_unique ?? rows[0].NON_UNIQUE) === 0;
    if (
      actualUnique !== expected.unique ||
      actualColumns.length !== expected.columns.length ||
      actualColumns.some((column, position) => column !== expected.columns[position])
    ) {
      issues.push(
        `关键索引定义漂移: ${key} 期望 unique=${expected.unique}, columns=${expected.columns.join(
          ',',
        )}；实际 unique=${actualUnique}, columns=${actualColumns.join(',')}`,
      );
    }
  }
  return issues;
}

async function collectCheckDefinitionIssues(
  dataSource: DataSource,
  databaseName: string,
): Promise<ReadonlyArray<string>> {
  const issues: string[] = [];
  for (const item of REQUIRED_CHECKS) {
    const key = `${item.table}.${item.constraint}`;
    const [table, constraint] = [item.table, item.constraint];
    const expected = CHECK_DEFINITIONS[key];
    if (!expected) {
      issues.push(`关键 CHECK 缺少表达式定义: ${key}`);
      continue;
    }
    const rows = rowsOf(
      await dataSource.query(
        `SELECT cc.check_clause, tc.enforced AS enforced
           FROM information_schema.check_constraints cc
           JOIN information_schema.table_constraints tc
             ON tc.constraint_schema = cc.constraint_schema
            AND tc.constraint_name = cc.constraint_name
          WHERE cc.constraint_schema = ?
            AND tc.table_name = ?
            AND cc.constraint_name = ?
          LIMIT 1`,
        [databaseName, table, constraint],
      ),
    );
    if (rows.length === 0) {
      issues.push(`关键 CHECK 定义缺失: ${key}`);
      continue;
    }
    const enforced = readString(rows[0], 'enforced').toUpperCase();
    if (enforced !== 'YES') {
      issues.push(`关键 CHECK 未强制执行: ${key} enforced=${enforced || '(未知)'}`);
    }
    const actual = normalizeMysqlCheckClauseText(readString(rows[0], 'check_clause'));
    if (normalizeCheckClause(actual) !== normalizeCheckClause(expected.clause)) {
      issues.push(`关键 CHECK 定义漂移: ${key} 期望 ${expected.clause}；实际 ${actual}`);
    }
  }
  return issues;
}

async function collectForeignKeyDefinitionIssues(
  dataSource: DataSource,
  databaseName: string,
): Promise<ReadonlyArray<string>> {
  const issues: string[] = [];
  for (const [key, expected] of Object.entries(FOREIGN_KEY_DEFINITIONS)) {
    const [table, constraint] = splitKey(key);
    const rows = rowsOf(
      await dataSource.query(
        `SELECT kcu.column_name AS local_column,
                kcu.referenced_table_name AS reference_table,
                kcu.referenced_column_name AS reference_column,
                rc.delete_rule,
                rc.update_rule
           FROM information_schema.key_column_usage kcu
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_schema = kcu.constraint_schema
            AND rc.table_name = kcu.table_name
            AND rc.constraint_name = kcu.constraint_name
          WHERE kcu.constraint_schema = ?
            AND kcu.table_name = ?
            AND kcu.constraint_name = ?
          ORDER BY kcu.ordinal_position`,
        [databaseName, table, constraint],
      ),
    );
    if (rows.length === 0) {
      issues.push(`关键外键定义缺失: ${key}`);
      continue;
    }
    const actualLocal = rows.map((row) => readString(row, 'local_column'));
    const actualReference = rows.map((row) => readString(row, 'reference_column'));
    const actualReferenceTable = readString(rows[0], 'reference_table');
    const deleteRule = readString(rows[0], 'delete_rule');
    const updateRule = readString(rows[0], 'update_rule');
    const drift =
      actualReferenceTable !== expected.referenceTable ||
      actualLocal.length !== expected.localColumns.length ||
      actualLocal.some((column, position) => column !== expected.localColumns[position]) ||
      actualReference.length !== expected.referenceColumns.length ||
      actualReference.some((column, position) => column !== expected.referenceColumns[position]) ||
      (expected.onDelete !== undefined && expected.onDelete !== deleteRule) ||
      (expected.onUpdate !== undefined && expected.onUpdate !== updateRule);
    if (drift) {
      issues.push(
        `关键外键定义漂移: ${key} 期望 ${expected.referenceTable}(${expected.referenceColumns.join(
          ',',
        )}) 本地(${expected.localColumns.join(',')})；实际 ${actualReferenceTable}(${actualReference.join(
          ',',
        )}) 本地(${actualLocal.join(',')}) 删除=${deleteRule} 更新=${updateRule}`,
      );
    }
  }
  return issues;
}

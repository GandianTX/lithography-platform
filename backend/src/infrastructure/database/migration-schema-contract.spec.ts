import * as fs from 'fs';
import * as path from 'path';

import { DataSource, type EntityMetadata } from 'typeorm';

import {
  collectPrefixStructureRequirements,
  assertStructureDefinitionsComplete,
  type PrefixForeignKeyRequirement,
} from './migration-schema-contract';

const MIGRATION_DIR = path.join(__dirname, 'migrations');
const ENTITY_GLOB = path.join(__dirname, '../../modules/**/*.entity.ts');

const BASELINE_TIMESTAMPS = [
  1773889200000, 1773924900000, 1773925000000, 1773925700000, 1773926400000, 1773927600000,
  1775200800000, 1775200900000, 1775201000000, 1775201100000, 1775201200000, 1775201300000,
  1775201400000, 1775201500000, 1775301000000, 1775301100000, 1775301200000, 1775301300000,
  1775301400000, 1775301500000, 1775301600000, 1775301700000, 1775301800000, 1775301900000,
  1775401000000, 1775401100000, 1775401200000, 1775401300000, 1775401400000, 1775401500000,
  1775401600000,
];

const V13_TIMESTAMPS = [
  1775501000000, 1775501100000, 1775501200000, 1775501300000, 1775501400000, 1775501500000,
  1775501600000, 1775501700000, 1775501800000, 1775501900000, 1775502000000, 1775502100000,
  1775502200000,
];

const V13_TABLES = [
  'stored_file',
  'repair_request_intake',
  'intake_analysis_attempt',
  'repair_process_entry',
  'ai_message_analysis',
  'maintenance_report_fault',
  'repair_request_revision',
  'reference_document_revision',
  'local_account_authorization',
  'local_company_setting',
  'sync_receipt',
  'sync_conflict',
  'record_package_import',
  'record_package_item',
  'backup_asset',
  'backup_restore_run',
  'management_audit_event',
];

function readMigrationTimestamps(): number[] {
  return fs
    .readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith('.migration.ts'))
    .map((name) => Number(name.slice(0, 13)))
    .sort((left, right) => left - right);
}

let entityMetadataSource: DataSource | undefined;

/**
 * 仅构建元数据的 DataSource 子类：不建立连接，只解析 Entity 装饰器。
 */
class MetadataOnlyDataSource extends DataSource {
  async buildMetadataOnly(): Promise<void> {
    await this.buildMetadatas();
  }
}

async function loadEntityMetadata(): Promise<DataSource> {
  if (!entityMetadataSource) {
    const source = new MetadataOnlyDataSource({
      type: 'mysql',
      database: 'metadata_only_not_connected',
      entities: [ENTITY_GLOB],
      synchronize: false,
    });
    await source.buildMetadataOnly();
    entityMetadataSource = source;
  }
  return entityMetadataSource;
}

function collectForeignKeys(): PrefixForeignKeyRequirement[] {
  return collectPrefixStructureRequirements(new Set(readMigrationTimestamps())).filter(
    (item): item is PrefixForeignKeyRequirement => item.kind === 'foreign_key',
  );
}

function findEntityMetadata(source: DataSource, table: string): EntityMetadata | undefined {
  return source.entityMetadatas.find((metadata) => metadata.tableName === table);
}

function columnSetKey(columns: ReadonlyArray<string>): string {
  return [...columns].sort().join(',');
}

/**
 * 目标实体上可作为外键引用目标（主键或唯一键）的列集合。
 */
function uniqueColumnKeys(metadata: EntityMetadata): Set<string> {
  const keys = new Set<string>();
  keys.add(columnSetKey(metadata.primaryColumns.map((column) => column.databaseName)));
  for (const unique of metadata.uniques) {
    keys.add(columnSetKey(unique.columns.map((column) => column.databaseName)));
  }
  for (const index of metadata.indices) {
    if (index.isUnique) {
      keys.add(columnSetKey(index.columns.map((column) => column.databaseName)));
    }
  }
  return keys;
}

describe('V13 结构契约（不连接实库）', () => {
  it('契约内全部关键索引/外键列定义完整且自洽', () => {
    expect(() => assertStructureDefinitionsComplete()).not.toThrow();
  });

  it('前 31 条已接受迁移的序号与时间戳保持不变，V13 迁移只向前追加', () => {
    const timestamps = readMigrationTimestamps();
    expect(timestamps.slice(0, BASELINE_TIMESTAMPS.length)).toEqual(BASELINE_TIMESTAMPS);
    expect(timestamps.slice(BASELINE_TIMESTAMPS.length)).toEqual(V13_TIMESTAMPS);
  });

  it('17 个候选对象按独立表登记，且各自绑定所属迁移', () => {
    const requirements = collectPrefixStructureRequirements(new Set(V13_TIMESTAMPS));
    const tableRequirements = requirements.filter((item) => item.kind === 'table');
    for (const table of V13_TABLES) {
      const requirement = tableRequirements.find((item) => item.table === table);
      expect(requirement).toBeDefined();
      expect(V13_TIMESTAMPS).toContain(requirement?.since);
    }
  });

  it('记录包检查/导入状态列由第 39 条迁移登记，导入结果允许未执行', () => {
    const requirements = collectPrefixStructureRequirements(new Set(V13_TIMESTAMPS));
    const columns = requirements.filter((item) => item.kind === 'column');
    const checkStatus = columns.find(
      (item) => item.table === 'record_package_import' && item.name === 'check_status',
    );
    const checkResult = columns.find(
      (item) => item.table === 'record_package_item' && item.name === 'check_result',
    );
    const importResult = columns.find(
      (item) => item.table === 'record_package_item' && item.name === 'result',
    );
    expect(checkStatus?.since).toBe(1775501700000);
    expect(checkResult?.since).toBe(1775501700000);
    expect(importResult?.since).toBe(1775501400000);
    expect(
      checkStatus && checkStatus.kind === 'column' ? checkStatus.notNull : undefined,
    ).toBeUndefined();
    expect(
      checkResult && checkResult.kind === 'column' ? checkResult.notNull : undefined,
    ).toBeUndefined();
    expect(
      importResult && importResult.kind === 'column' ? importResult.notNull : undefined,
    ).toBeUndefined();
  });

  it('previous_version 第 43 条追加、第 44 条收紧为非空且保留顺序守卫', () => {
    const requirements = collectPrefixStructureRequirements(new Set(V13_TIMESTAMPS));
    const column = requirements.find(
      (item) =>
        item.kind === 'column' &&
        item.table === 'repair_request_revision' &&
        item.name === 'previous_version',
    );
    expect(column).toBeDefined();
    if (column && column.kind === 'column') {
      expect(column.since).toBe(1775502100000);
      expect(column.notNull).toBeUndefined();
      expect(column.definition).toEqual({
        since: 1775502200000,
        columnType: 'int unsigned',
        nullable: false,
        defaultValue: null,
      });
    }

    // 第 44 条未执行时（仅到 43 态）不得提前要求非空。
    const prefixOnly = collectPrefixStructureRequirements(
      new Set(V13_TIMESTAMPS.filter((timestamp) => timestamp < 1775502200000)),
    );
    const prefixColumn = prefixOnly.find(
      (item) =>
        item.kind === 'column' &&
        item.table === 'repair_request_revision' &&
        item.name === 'previous_version',
    );
    expect(prefixColumn).toBeDefined();
    if (prefixColumn && prefixColumn.kind === 'column') {
      expect(prefixColumn.notNull).toBeUndefined();
      expect(prefixColumn.definition).toBeUndefined();
    }

    const check = requirements.find(
      (item) =>
        item.kind === 'check' &&
        item.table === 'repair_request_revision' &&
        item.name === 'chk_repair_request_revision_previous_version',
    );
    expect(check).toBeDefined();
    expect(check?.since).toBe(1775502100000);
  });

  it('记录包检查/导入组合约束由第 39 条迁移登记', () => {
    const requirements = collectPrefixStructureRequirements(new Set(V13_TIMESTAMPS));
    const checks = requirements.filter((item) => item.kind === 'check');
    const expected = [
      ['record_package_import', 'chk_record_package_import_check_status'],
      ['record_package_import', 'chk_record_package_import_check_stage'],
      ['record_package_item', 'chk_record_package_item_check_result'],
      ['record_package_item', 'chk_record_package_item_check_stage'],
    ] as const;
    for (const [table, name] of expected) {
      const requirement = checks.find((item) => item.table === table && item.name === name);
      expect(requirement).toBeDefined();
      expect(requirement?.since).toBe(1775501700000);
    }
  });

  it('reference_document 旧归属保留可空，不强行收紧为非空', () => {
    const requirements = collectPrefixStructureRequirements(new Set(readMigrationTimestamps()));
    const ownerColumn = requirements.find(
      (item) =>
        item.kind === 'column' &&
        item.table === 'reference_document' &&
        item.name === 'owner_organization_id',
    );
    expect(ownerColumn).toBeDefined();
    expect(
      ownerColumn && ownerColumn.kind === 'column' ? ownerColumn.notNull : undefined,
    ).toBeUndefined();
  });

  it('local_backup_run 以「设备+公司」复合唯一键取代旧单列唯一键', () => {
    const requirements = collectPrefixStructureRequirements(new Set(V13_TIMESTAMPS));
    const indexRequirements = requirements.filter((item) => item.kind === 'index');
    const activeCompany = indexRequirements.find(
      (item) =>
        item.kind === 'index' &&
        item.table === 'local_backup_run' &&
        item.name === 'uk_local_backup_run_active_company',
    );
    expect(
      activeCompany && activeCompany.kind === 'index' ? activeCompany.columns : undefined,
    ).toEqual(['active_installation_id', 'organization_id']);
    expect(
      indexRequirements.some(
        (item) => item.name === 'uk_local_backup_run_active' && item.table === 'local_backup_run',
      ),
    ).toBe(false);
  });

  it('同报告版本复合外键按（版本号，报告号）登记', () => {
    const requirements = collectPrefixStructureRequirements(new Set(V13_TIMESTAMPS));
    const foreignKey = requirements.find(
      (item) =>
        item.kind === 'foreign_key' &&
        item.table === 'reference_document' &&
        item.name === 'fk_reference_document_source_report_version',
    );
    expect(foreignKey).toBeDefined();
    if (foreignKey && foreignKey.kind === 'foreign_key') {
      expect(foreignKey.referenceTable).toBe('maintenance_report_version');
      expect(foreignKey.localColumns).toEqual(['source_report_version_id', 'source_report_id']);
      expect(foreignKey.referenceColumns).toEqual(['id', 'report_id']);
    }
  });

  it('reference_document 内容来源 CHECK 使用 V13 新名称，旧名称不再要求', () => {
    const requirements = collectPrefixStructureRequirements(new Set(V13_TIMESTAMPS));
    const checks = requirements.filter((item) => item.kind === 'check');
    expect(
      checks.some(
        (item) =>
          item.table === 'reference_document' &&
          item.name === 'chk_reference_document_content_source_v13',
      ),
    ).toBe(true);
    expect(
      checks.some(
        (item) =>
          item.table === 'reference_document' &&
          item.name === 'chk_reference_document_content_source',
      ),
    ).toBe(false);
  });

  it('每条关键外键的引用列都能在 Entity 元数据中解析到真实物理列', async () => {
    const source = await loadEntityMetadata();
    const unresolved = collectForeignKeys().flatMap((item) => {
      const metadata = findEntityMetadata(source, item.referenceTable);
      if (!metadata) {
        return [`${item.table}.${item.name}: 目标表 ${item.referenceTable} 缺少 Entity 元数据`];
      }
      return item.referenceColumns
        .filter((column) => !metadata.findColumnWithDatabaseName(column))
        .map(
          (column) =>
            `${item.table}.${item.name}: 引用列 ${item.referenceTable}.${column} 在 Entity 中不存在`,
        );
    });

    expect(unresolved).toEqual([]);
  });

  it('每条关键外键的引用列在目标 Entity 中构成主键或唯一键', async () => {
    const source = await loadEntityMetadata();
    const notUnique = collectForeignKeys().flatMap((item) => {
      const metadata = findEntityMetadata(source, item.referenceTable);
      if (!metadata) {
        return [];
      }
      const key = columnSetKey(item.referenceColumns);
      if (uniqueColumnKeys(metadata).has(key)) {
        return [];
      }
      return [`${item.table}.${item.name}: ${item.referenceTable}(${key}) 不是主键或唯一键`];
    });

    expect(notUnique).toEqual([]);
  });

  it('record_package_item 两条外键引用父实体真实主键列而非默认 id', async () => {
    const source = await loadEntityMetadata();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['fk_record_package_item_package', 'record_package_import'],
      ['fk_record_package_item_receipt', 'sync_receipt'],
    ];

    for (const [name, table] of cases) {
      const metadata = source.getMetadata(table);
      const requirement = collectForeignKeys().find((item) => item.name === name);
      expect(requirement).toBeDefined();
      expect(requirement?.referenceColumns).toEqual(
        metadata.primaryColumns.map((column) => column.databaseName),
      );
    }
  });

  it('四张 JSON 版本表的 Entity CHECK 均要求键存在且非 JSON null', async () => {
    const source = await loadEntityMetadata();
    const cases = [
      {
        table: 'repair_request_revision',
        name: 'chk_repair_request_revision_schema',
        columns: ['before_snapshot', 'after_snapshot'],
        equality: true,
      },
      {
        table: 'reference_document_revision',
        name: 'chk_reference_document_revision_schema',
        columns: ['before_snapshot', 'after_snapshot'],
        equality: false,
      },
      {
        table: 'sync_conflict',
        name: 'chk_sync_conflict_schema',
        columns: ['local_snapshot', 'cloud_snapshot'],
        equality: false,
      },
      {
        table: 'backup_restore_run',
        name: 'chk_backup_restore_run_schema',
        columns: ['check_snapshot'],
        equality: false,
      },
    ] as const;

    for (const item of cases) {
      const metadata = source.getMetadata(item.table);
      const check = metadata.checks.find((candidate) => candidate.name === item.name);
      expect(check).toBeDefined();
      const expression = check?.expression ?? '';
      for (const column of item.columns) {
        expect(expression).toContain(`JSON_EXTRACT(\`${column}\`, '$.schema_version') IS NOT NULL`);
        expect(expression).toContain(
          `JSON_TYPE(JSON_EXTRACT(\`${column}\`, '$.schema_version')) <> 'NULL'`,
        );
      }
      if (item.equality) {
        for (const column of item.columns) {
          expect(expression).toContain(
            `JSON_EXTRACT(\`${column}\`, '$.schema_version') = \`schema_version\``,
          );
        }
      }
    }
  });
});

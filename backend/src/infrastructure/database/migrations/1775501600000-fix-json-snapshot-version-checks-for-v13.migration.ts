import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 修复 V13 JSON 快照的 schema_version 必填约束。
 *
 * 第十一轮 D6 只验证了“合法版本 / 等值不符”等命题，未覆盖：
 * - 缺键时 JSON_EXTRACT 为 SQL NULL，`col = schema_version` 得到 UNKNOWN，CHECK 被放行；
 * - JSON null 不是 SQL NULL，`IS NOT NULL` 仍为 TRUE，CHECK 被放行。
 *
 * 本迁移只重建四条既有 CHECK，不新增独立列、不增加整数类型或版本范围限制：
 * - repair_request_revision：键必须存在且非 JSON null，并保留与 schema_version 列相等；
 * - reference_document_revision：两个快照键必须存在且非 JSON null；
 * - sync_conflict：local/cloud 两个快照键必须存在且非 JSON null；
 * - backup_restore_run：check_snapshot 键必须存在且非 JSON null。
 *
 * 安全语义：ALTER 之前先扫描全部受影响表；任一行违反目标约束即失败关闭，
 * 只报告脱敏计数与定位 ID，不删除、不自动补版本。
 *
 * MySQL DDL 会隐式提交，不能随迁移事务整体回滚；多表 ALTER 可能部分成功。
 * 因此每张表重建前都检查约束是否存在，失败信息会列出已完成/失败/未执行表，
 * 修复失败原因后可直接重跑本迁移。
 */
export class FixJsonSnapshotVersionChecksForV131775501600000 implements MigrationInterface {
  name = 'FixJsonSnapshotVersionChecksForV131775501600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertNoExistingViolations(queryRunner);
    await rebuildConstraints(queryRunner, fixedExpression);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回退到修复前的较弱表达式；新约束下已存在的数据均满足旧表达式，无需预检。
    await rebuildConstraints(queryRunner, legacyExpression);
  }
}

const SCHEMA_VERSION_PATH = "'$.schema_version'";

interface JsonVersionTableSpec {
  readonly table: string;
  readonly locator: string;
  readonly snapshotColumns: readonly string[];
  readonly equalityColumn?: string;
  readonly constraint: string;
}

/**
 * 受影响对象固定为四张表、四条约束。
 * 定位列使用各表真实主键：id / id / conflict_id / restore_id。
 */
const JSON_VERSION_TABLES: readonly JsonVersionTableSpec[] = [
  {
    table: 'repair_request_revision',
    locator: 'id',
    snapshotColumns: ['before_snapshot', 'after_snapshot'],
    equalityColumn: 'schema_version',
    constraint: 'chk_repair_request_revision_schema',
  },
  {
    table: 'reference_document_revision',
    locator: 'id',
    snapshotColumns: ['before_snapshot', 'after_snapshot'],
    constraint: 'chk_reference_document_revision_schema',
  },
  {
    table: 'sync_conflict',
    locator: 'conflict_id',
    snapshotColumns: ['local_snapshot', 'cloud_snapshot'],
    constraint: 'chk_sync_conflict_schema',
  },
  {
    table: 'backup_restore_run',
    locator: 'restore_id',
    snapshotColumns: ['check_snapshot'],
    constraint: 'chk_backup_restore_run_schema',
  },
];

const versionKeyGuard = (column: string): string =>
  [
    `JSON_EXTRACT(\`${column}\`, ${SCHEMA_VERSION_PATH}) IS NOT NULL`,
    `JSON_TYPE(JSON_EXTRACT(\`${column}\`, ${SCHEMA_VERSION_PATH})) <> 'NULL'`,
  ].join('\n          AND ');

/** 修复后的目标表达式：键存在、非 JSON null；repair 额外保留与独立列相等。 */
const fixedExpression = (spec: JsonVersionTableSpec): string => {
  const clauses: string[] = [];
  if (spec.equalityColumn) {
    clauses.push(`\`${spec.equalityColumn}\` >= 1`);
  }
  for (const column of spec.snapshotColumns) {
    clauses.push(`JSON_VALID(\`${column}\`)`);
  }
  for (const column of spec.snapshotColumns) {
    clauses.push(versionKeyGuard(column));
  }
  if (spec.equalityColumn) {
    for (const column of spec.snapshotColumns) {
      clauses.push(
        `JSON_EXTRACT(\`${column}\`, ${SCHEMA_VERSION_PATH}) = \`${spec.equalityColumn}\``,
      );
    }
  }
  return clauses.join('\n          AND ');
};

/** 修复前的表达式，仅用于 down 回退。 */
const legacyExpression = (spec: JsonVersionTableSpec): string => {
  const clauses: string[] = [];
  if (spec.equalityColumn) {
    clauses.push(`\`${spec.equalityColumn}\` >= 1`);
  }
  for (const column of spec.snapshotColumns) {
    clauses.push(`JSON_VALID(\`${column}\`)`);
  }
  for (const column of spec.snapshotColumns) {
    clauses.push(
      spec.equalityColumn
        ? `JSON_EXTRACT(\`${column}\`, ${SCHEMA_VERSION_PATH}) = \`${spec.equalityColumn}\``
        : `JSON_EXTRACT(\`${column}\`, ${SCHEMA_VERSION_PATH}) IS NOT NULL`,
    );
  }
  return clauses.join('\n          AND ');
};

const jsonValue = (column: string): string => `JSON_EXTRACT(\`${column}\`, ${SCHEMA_VERSION_PATH})`;

/**
 * 单列违反目标约束的判定。
 *
 * CASE 按顺序短路：先判非法 JSON，再判缺键（SQL NULL）、JSON null，
 * 最后判独立版本列 < 1、与独立列不等。避免在非法 JSON 上直接调用 JSON_EXTRACT 抛错。
 */
const violationCase = (spec: JsonVersionTableSpec, column: string): string => {
  const branches = [
    `WHEN JSON_VALID(\`${column}\`) = 0 THEN 1`,
    `WHEN ${jsonValue(column)} IS NULL THEN 1`,
    `WHEN JSON_TYPE(${jsonValue(column)}) = 'NULL' THEN 1`,
  ];
  if (spec.equalityColumn) {
    branches.push(`WHEN \`${spec.equalityColumn}\` < 1 THEN 1`);
    branches.push(`WHEN ${jsonValue(column)} <> \`${spec.equalityColumn}\` THEN 1`);
  }
  return `(CASE\n            ${branches.join('\n            ')}\n            ELSE 0\n          END) = 1`;
};

const violationWhere = (spec: JsonVersionTableSpec): string =>
  spec.snapshotColumns.map((column) => violationCase(spec, column)).join('\n           OR ');

const anyColumn = (spec: JsonVersionTableSpec, condition: (column: string) => string): string =>
  spec.snapshotColumns.map((column) => `(${condition(column)})`).join('\n             OR ');

interface PreflightCountRow {
  readonly total?: unknown;
  readonly invalid_json_rows?: unknown;
  readonly missing_key_rows?: unknown;
  readonly json_null_rows?: unknown;
  readonly mismatch_rows?: unknown;
  readonly version_below_one_rows?: unknown;
}

interface PreflightSampleRow {
  readonly locator?: unknown;
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * ALTER 前扫描全部受影响表。
 *
 * 任一行违反目标约束即抛错，且不执行任何 ALTER。
 * 报告只含脱敏计数与定位 ID，不输出快照内容。
 */
async function assertNoExistingViolations(queryRunner: QueryRunner): Promise<void> {
  const tableRows = (await queryRunner.query(
    `SELECT TABLE_NAME AS table_name
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${JSON_VERSION_TABLES.map(() => '?').join(', ')})`,
    JSON_VERSION_TABLES.map((spec) => spec.table),
  )) as Array<{ table_name?: unknown }>;

  const existingTables = new Set(tableRows.map((row) => String(row.table_name)));
  const missingTables = JSON_VERSION_TABLES.map((spec) => spec.table).filter(
    (table) => !existingTables.has(table),
  );
  if (missingTables.length > 0) {
    throw new Error(
      '[fix-json-snapshot-version-checks] 预检失败：缺少受影响表 ' +
        `${missingTables.join('、')}；未执行任何 ALTER。`,
    );
  }

  const details: string[] = [];
  for (const spec of JSON_VERSION_TABLES) {
    const countRows = (await queryRunner.query(
      `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN ${anyColumn(spec, (column) => `JSON_VALID(\`${column}\`) = 0`)} THEN 1 ELSE 0 END), 0) AS invalid_json_rows,
          COALESCE(SUM(CASE WHEN ${anyColumn(spec, (column) => `JSON_VALID(\`${column}\`) = 1 AND ${jsonValue(column)} IS NULL`)} THEN 1 ELSE 0 END), 0) AS missing_key_rows,
          COALESCE(SUM(CASE WHEN ${anyColumn(spec, (column) => `JSON_VALID(\`${column}\`) = 1 AND JSON_TYPE(${jsonValue(column)}) = 'NULL'`)} THEN 1 ELSE 0 END), 0) AS json_null_rows${
            spec.equalityColumn
              ? `,
          COALESCE(SUM(CASE WHEN \`${spec.equalityColumn}\` < 1 THEN 1 ELSE 0 END), 0) AS version_below_one_rows,
          COALESCE(SUM(CASE WHEN ${anyColumn(
            spec,
            (column) =>
              `JSON_VALID(\`${column}\`) = 1 AND ${jsonValue(column)} IS NOT NULL AND JSON_TYPE(${jsonValue(column)}) <> 'NULL' AND ${jsonValue(column)} <> \`${spec.equalityColumn}\``,
          )} THEN 1 ELSE 0 END), 0) AS mismatch_rows`
              : ''
          }
        FROM \`${spec.table}\`
        WHERE ${violationWhere(spec)}`,
    )) as PreflightCountRow[];
    const total = toNumber(countRows[0]?.total);
    if (total === 0) {
      continue;
    }

    const sampleRows = (await queryRunner.query(
      `SELECT \`${spec.locator}\` AS locator
         FROM \`${spec.table}\`
        WHERE ${violationWhere(spec)}
        ORDER BY \`${spec.locator}\`
        LIMIT 20`,
    )) as PreflightSampleRow[];
    const locators = sampleRows.map((row) => String(row.locator)).join(', ');

    details.push(
      `  - ${spec.table}: 违规 ${String(total)} 行（缺键 ${String(
        toNumber(countRows[0]?.missing_key_rows),
      )}、JSON null ${String(toNumber(countRows[0]?.json_null_rows))}、非法 JSON ${String(
        toNumber(countRows[0]?.invalid_json_rows),
      )}、等值不符 ${String(toNumber(countRows[0]?.mismatch_rows))}${
        spec.equalityColumn
          ? `、独立列版本<1 ${String(toNumber(countRows[0]?.version_below_one_rows))}`
          : ''
      }）；` + `定位 ID（最多 20 个）：${locators}${total > sampleRows.length ? ' …' : ''}`,
    );
  }

  if (details.length > 0) {
    throw new Error(
      '[fix-json-snapshot-version-checks] 预检失败：受影响表存在违反目标 JSON 版本约束的行，' +
        '未执行任何 ALTER。\n' +
        `${details.join('\n')}\n` +
        '分类计数可重叠；本迁移不删除、不自动补 schema_version。' +
        '请先人工核对并修复上述行，再重新执行本迁移。',
    );
  }
}

/**
 * 逐表重建约束。
 *
 * 每表先探测约束是否存在：存在则 DROP + ADD（单表 ALTER 原子），
 * 不存在则只 ADD，便于部分失败后的幂等续跑。
 */
async function rebuildConstraints(
  queryRunner: QueryRunner,
  expression: (spec: JsonVersionTableSpec) => string,
): Promise<void> {
  const completed: string[] = [];

  for (const spec of JSON_VERSION_TABLES) {
    try {
      const constraintRows = (await queryRunner.query(
        `SELECT 1 AS present
           FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND CONSTRAINT_NAME = ?
            AND CONSTRAINT_TYPE = 'CHECK'
          LIMIT 1`,
        [spec.table, spec.constraint],
      )) as Array<{ present?: unknown }>;
      const constraintExists = constraintRows.length > 0;
      const dropClause = constraintExists
        ? `\n            DROP CONSTRAINT \`${spec.constraint}\`,`
        : '';
      const checkExpression = expression(spec);

      await queryRunner.query(
        `ALTER TABLE \`${spec.table}\`${dropClause}
            ADD CONSTRAINT \`${spec.constraint}\` CHECK (
              ${checkExpression}
            );`,
      );
      completed.push(spec.table);
    } catch (error) {
      const failedIndex = JSON_VERSION_TABLES.indexOf(spec);
      const pending = JSON_VERSION_TABLES.slice(failedIndex + 1).map((item) => item.table);
      throw new Error(
        '[fix-json-snapshot-version-checks] ALTER 失败：' +
          `已完成 ${completed.length > 0 ? completed.join('、') : '无'}；` +
          `失败表 ${spec.table}（${spec.constraint}）；` +
          `未执行 ${pending.length > 0 ? pending.join('、') : '无'}。\n` +
          'MySQL DDL 会隐式提交，已成功的 ALTER 不能随本迁移整体回滚；' +
          '本次迁移尚未被 TypeORM 记录为成功，不要假定全部完成。\n' +
          '续跑：修复失败原因后可直接重新执行本迁移；每张表会先检查约束是否存在，' +
          '已重建表将幂等 DROP/ADD。\n' +
          `原始错误：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

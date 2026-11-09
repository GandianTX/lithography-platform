import type { MigrationInterface, QueryRunner } from 'typeorm';

const AUDIT_OPERATION_CHECK = 'chk_management_audit_operation';
const AUDIT_ALLOWED_OPERATIONS = [
  'ADMIN_DELETE_DOCUMENT',
  'CORRECT_DOCUMENT_OWNERSHIP',
  'RESTORE_LOCAL_BUSINESS',
] as const;
const AUDIT_OPERATION_COMMENT =
  '管理操作类型：ADMIN_DELETE_DOCUMENT/CORRECT_DOCUMENT_OWNERSHIP/RESTORE_LOCAL_BUSINESS';

const REPAIR_CLOSURE_CHECK = 'chk_repair_request_closure';
// MySQL 8.0 的 CHECK 必须是布尔表达式；裸 CASE 会被拒绝，且纯 OR 组合在
// (closure_status=NULL, closed_at=NOT NULL) 时求值为 UNKNOWN 而被放行。
// 因此用 CASE 表达四态并与 TRUE 显式比较，确保两种单边 NULL 都被拒绝。
const REPAIR_CLOSURE_CLAUSE =
  '(CASE WHEN `closure_status` IS NULL THEN `closed_at` IS NULL ' +
  "WHEN `closure_status` = 'OPEN' THEN `closed_at` IS NULL " +
  "WHEN `closure_status` = 'CLOSED' THEN `closed_at` IS NOT NULL " +
  'ELSE FALSE END) = TRUE';

const SYNC_CONFLICT_COLUMNS = [
  { name: 'local_version', type: 'int unsigned', defaultValue: null },
  { name: 'cloud_version', type: 'int unsigned', defaultValue: null },
  { name: 'displayed_cloud_version', type: 'int unsigned', defaultValue: null },
  { name: 'decision', type: 'varchar(24)', defaultValue: 'PENDING' },
] as const;

const SYNC_CONFLICT_VERSION_CHECK = 'chk_sync_conflict_versions';
const SYNC_CONFLICT_VERSION_CLAUSE =
  '(`local_version` IS NULL AND `cloud_version` IS NULL) OR ' +
  '(`local_version` IS NOT NULL AND `cloud_version` IS NOT NULL)';

const SYNC_CONFLICT_DECISION_CHECK = 'chk_sync_conflict_decision';
const SYNC_CONFLICT_DECISION_CLAUSE =
  "`decision` IS NULL OR `decision` IN ('PENDING', 'LOCAL', 'CLOUD')";

interface CheckConstraintRow {
  readonly checkClause: string;
}

interface AuditOperationRow {
  readonly operation: string;
  readonly total: number;
}

interface ColumnRow {
  readonly columnName: string;
  readonly columnType: string;
  readonly isNullable: 'YES' | 'NO';
  readonly columnDefault: string | null;
  readonly extra: string;
  readonly generationExpression: string;
}

const detailOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const normalizeType = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const readCount = (rows: unknown): number => {
  const list: unknown[] = Array.isArray(rows) ? (rows as unknown[]) : [];
  const first = list[0] as { total?: unknown } | undefined;
  const total = Number(first?.total);
  return Number.isFinite(total) ? total : 0;
};

/**
 * 关闭本轮 D3 结构缺口：
 * 1. management_audit_event 只允许三类已确认操作；
 * 2. sync_conflict 按冻结设计补齐本地/云端/已展示版本及选择事实；
 * 3. repair_request 统一 NULL 安全结单 CHECK。
 *
 * 历史数据原则：旧审计类型不自动映射；旧冲突行无法证明的版本与选择结果保持 NULL
 * （明确历史未知）；repair_request 若存在单边 NULL 等无法安全收口的旧行，迁移失败关闭。
 */
export class CloseD3StructuralGapsForV131775502000000 implements MigrationInterface {
  readonly name = 'CloseD3StructuralGapsForV131775502000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const completed: string[] = [];
    try {
      await this.assertAuditOperations(queryRunner);
      completed.push('旧审计操作扫描');

      await this.assertRepairClosure(queryRunner);
      completed.push('旧结单数据扫描');

      await this.ensureAuditOperationCheck(queryRunner);
      completed.push('审计操作约束替换');

      await this.ensureRepairClosureCheck(queryRunner);
      completed.push('结单约束替换');

      await this.ensureSyncConflictColumns(queryRunner);
      completed.push('同步冲突版本与选择字段补齐');

      await this.ensureSyncConflictChecks(queryRunner);
      completed.push('同步冲突约束补齐');
    } catch (error) {
      throw new Error(
        `D3 结构缺口迁移失败；已完成 [${completed.join('、') || '无'}]；原因：${detailOf(error)}`,
        { cause: error },
      );
    }
  }

  down(): Promise<void> {
    return Promise.reject(new Error('D3 结构缺口迁移不支持自动回退，请使用已审批的恢复方案'));
  }

  private async assertAuditOperations(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT \`operation\`, COUNT(*) AS \`total\`
         FROM \`management_audit_event\`
        GROUP BY \`operation\``,
    )) as unknown as AuditOperationRow[];
    const allowed = new Set<string>(AUDIT_ALLOWED_OPERATIONS);
    const unknown = rows
      .filter((row) => !allowed.has(String(row.operation)))
      .map((row) => `${String(row.operation)}(${Number(row.total)})`);
    if (unknown.length > 0) {
      throw new Error(
        `存在无法自动映射的旧审计操作：${unknown.join('、')}；请先人工确认归属后再迁移`,
      );
    }
  }

  private async assertRepairClosure(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS \`total\`
         FROM \`repair_request\`
        WHERE (\`closure_status\` IS NULL AND \`closed_at\` IS NOT NULL)
           OR (\`closure_status\` IS NOT NULL AND \`closed_at\` IS NULL)
           OR (\`closure_status\` IS NOT NULL AND \`closure_status\` NOT IN ('OPEN', 'CLOSED'))`,
    )) as unknown;
    const total = readCount(rows);
    if (total > 0) {
      throw new Error(`存在 ${total} 条无法安全收口的结单数据（单边 NULL 或非法状态）`);
    }
  }

  private async ensureAuditOperationCheck(queryRunner: QueryRunner): Promise<void> {
    const exists = await this.hasCheck(
      queryRunner,
      'management_audit_event',
      AUDIT_OPERATION_CHECK,
    );
    const add = `ADD CONSTRAINT \`${AUDIT_OPERATION_CHECK}\` CHECK (\`operation\` IN (${AUDIT_ALLOWED_OPERATIONS.map(
      (operation) => `'${operation}'`,
    ).join(', ')}))`;
    const modify = `MODIFY COLUMN \`operation\` varchar(32) NOT NULL COMMENT '${AUDIT_OPERATION_COMMENT}'`;
    if (exists) {
      const definition = await this.readCheckClause(
        queryRunner,
        'management_audit_event',
        AUDIT_OPERATION_CHECK,
      );
      const operations = this.readQuotedValues(definition);
      if (this.sameValueSet(operations, AUDIT_ALLOWED_OPERATIONS)) {
        return;
      }
      await queryRunner.query(
        `ALTER TABLE \`management_audit_event\`
           ${modify},
           DROP CHECK \`${AUDIT_OPERATION_CHECK}\`,
           ${add}`,
      );
      return;
    }
    await queryRunner.query(`ALTER TABLE \`management_audit_event\` ${modify}, ${add}`);
  }

  private async ensureRepairClosureCheck(queryRunner: QueryRunner): Promise<void> {
    const exists = await this.hasCheck(queryRunner, 'repair_request', REPAIR_CLOSURE_CHECK);
    const add = `ADD CONSTRAINT \`${REPAIR_CLOSURE_CHECK}\` CHECK (${REPAIR_CLOSURE_CLAUSE})`;
    if (exists) {
      await queryRunner.query(
        `ALTER TABLE \`repair_request\`
           DROP CHECK \`${REPAIR_CLOSURE_CHECK}\`,
           ${add}`,
      );
      return;
    }
    await queryRunner.query(`ALTER TABLE \`repair_request\` ${add}`);
  }

  /**
   * 冻结设计中的 id 已由既有主键 conflict_id 承担，不重复加列；
   * version_no 是旧冲突版本号，无法证明归属于本地或云端，因此保留但不映射，
   * 新增字段对旧行保持 NULL（明确历史未知）。
   */
  private async ensureSyncConflictColumns(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT \`COLUMN_NAME\` AS \`columnName\`,
              \`COLUMN_TYPE\` AS \`columnType\`,
              \`IS_NULLABLE\` AS \`isNullable\`,
              \`COLUMN_DEFAULT\` AS \`columnDefault\`,
              \`EXTRA\` AS \`extra\`,
              \`GENERATION_EXPRESSION\` AS \`generationExpression\`
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'sync_conflict'
          AND COLUMN_NAME IN (${SYNC_CONFLICT_COLUMNS.map(() => '?').join(', ')})`,
      SYNC_CONFLICT_COLUMNS.map((column) => column.name),
    )) as unknown as ColumnRow[];

    if (rows.length === 0) {
      await queryRunner.query(
        `ALTER TABLE \`sync_conflict\`
           ${SYNC_CONFLICT_COLUMNS.map(
             (column) => `ADD COLUMN \`${column.name}\` ${column.type} NULL DEFAULT NULL`,
           ).join(',\n           ')}`,
      );
      // 旧行保持 NULL（历史未知）；只给后续 INSERT 设置默认值，不回填旧行。
      await queryRunner.query(
        "ALTER TABLE `sync_conflict` ALTER COLUMN `decision` SET DEFAULT 'PENDING'",
      );
      return;
    }

    if (rows.length !== SYNC_CONFLICT_COLUMNS.length) {
      const present = rows.map((row) => row.columnName).join('、');
      throw new Error(`同步冲突字段只存在部分列（${present}），拒绝猜测补齐`);
    }

    let decisionDefaultNeedsRepair = false;
    for (const expected of SYNC_CONFLICT_COLUMNS) {
      const actual = rows.find((row) => row.columnName === expected.name);
      if (!actual) {
        throw new Error(`同步冲突字段 ${expected.name} 缺失，拒绝猜测补齐`);
      }
      const typeMatches = normalizeType(actual.columnType) === normalizeType(expected.type);
      const nullable = actual.isNullable === 'YES';
      const actualDefault = this.normalizeDefault(actual.columnDefault);
      const expectedDefault = this.normalizeDefault(expected.defaultValue);
      const notGenerated = actual.generationExpression.trim() === '';
      const extra = actual.extra.trim().toLowerCase();
      if (!typeMatches || !nullable || !notGenerated || extra !== '') {
        throw new Error(
          `同步冲突字段 ${expected.name} 已存在但定义不符（type=${actual.columnType}, nullable=${actual.isNullable}, extra=${actual.extra}），拒绝复用`,
        );
      }
      if (actualDefault === expectedDefault) continue;
      if (expected.name === 'decision' && actualDefault === null && expectedDefault === 'pending') {
        decisionDefaultNeedsRepair = true;
        continue;
      }
      throw new Error(
        `同步冲突字段 ${expected.name} 默认值不符（default=${String(
          actual.columnDefault,
        )}，期望 ${String(expected.defaultValue)}），拒绝复用`,
      );
    }
    if (decisionDefaultNeedsRepair) {
      await queryRunner.query(
        "ALTER TABLE `sync_conflict` ALTER COLUMN `decision` SET DEFAULT 'PENDING'",
      );
    }
  }

  private async ensureSyncConflictChecks(queryRunner: QueryRunner): Promise<void> {
    const versionExists = await this.hasCheck(
      queryRunner,
      'sync_conflict',
      SYNC_CONFLICT_VERSION_CHECK,
    );
    const decisionExists = await this.hasCheck(
      queryRunner,
      'sync_conflict',
      SYNC_CONFLICT_DECISION_CHECK,
    );
    const clauses: string[] = [];
    if (versionExists) clauses.push(`DROP CHECK \`${SYNC_CONFLICT_VERSION_CHECK}\``);
    if (decisionExists) clauses.push(`DROP CHECK \`${SYNC_CONFLICT_DECISION_CHECK}\``);
    clauses.push(
      `ADD CONSTRAINT \`${SYNC_CONFLICT_VERSION_CHECK}\` CHECK (${SYNC_CONFLICT_VERSION_CLAUSE})`,
      `ADD CONSTRAINT \`${SYNC_CONFLICT_DECISION_CHECK}\` CHECK (${SYNC_CONFLICT_DECISION_CLAUSE})`,
    );
    await queryRunner.query(`ALTER TABLE \`sync_conflict\` ${clauses.join(',\n           ')}`);
  }

  private async hasCheck(
    queryRunner: QueryRunner,
    tableName: string,
    constraintName: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1
         FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND CONSTRAINT_NAME = ?
          AND CONSTRAINT_TYPE = 'CHECK'
        LIMIT 1`,
      [tableName, constraintName],
    )) as unknown as unknown[];
    return rows.length > 0;
  }

  private async readCheckClause(
    queryRunner: QueryRunner,
    tableName: string,
    constraintName: string,
  ): Promise<string> {
    const rows = (await queryRunner.query(
      `SELECT cc.\`CHECK_CLAUSE\` AS \`checkClause\`
         FROM information_schema.CHECK_CONSTRAINTS cc
         JOIN information_schema.TABLE_CONSTRAINTS tc
           ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
          AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
        WHERE cc.CONSTRAINT_SCHEMA = DATABASE()
          AND tc.TABLE_NAME = ?
          AND cc.CONSTRAINT_NAME = ?`,
      [tableName, constraintName],
    )) as unknown as CheckConstraintRow[];
    return String(rows[0]?.checkClause ?? '');
  }

  private readQuotedValues(clause: string): string[] {
    return [...clause.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
  }

  private normalizeDefault(value: string | null): string | null {
    if (value === null) return null;
    return value.trim().replace(/^'|'$/g, '').toLowerCase();
  }

  private sameValueSet(actual: readonly string[], expected: readonly string[]): boolean {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    return (
      actualSet.size === expectedSet.size && [...expectedSet].every((value) => actualSet.has(value))
    );
  }
}

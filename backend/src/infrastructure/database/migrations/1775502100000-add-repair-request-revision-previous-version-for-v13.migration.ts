import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'repair_request_revision';
const COLUMN = 'previous_version';
const CHECK = 'chk_repair_request_revision_previous_version';
const CHECK_CLAUSE = '`previous_version` IS NULL OR `previous_version` < `revision_no`';
const COLUMN_TYPE = 'int unsigned';
const COLUMN_COMMENT = '该修订比较/基于的上一生效修订号；0=首版；NULL=历史无法证明';

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

/**
 * 第 43 条：补回 repair_request_revision.previous_version。
 *
 * 冻结 Word 将该列定义为“非空”，但 V13 之前的历史行无法证明其比较版本。
 * 本迁移按“历史未知保留 NULL”的兼容原则只追加可空列，不回填、不设置默认版本；
 * 0 明确表示基于原始版本的首次管理修订，未来写入方必须填写锁定并核验后的
 * current_revision_no。CHECK 只做 NULL 安全的顺序守卫，不把“修订号连续”这一
 * 应用不变量写成结构假设。
 */
export class AddRepairRequestRevisionPreviousVersionForV131775502100000 implements MigrationInterface {
  readonly name = 'AddRepairRequestRevisionPreviousVersionForV131775502100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const completed: string[] = [];
    try {
      await this.ensureColumn(queryRunner);
      completed.push('previous_version 列');

      await this.ensureCheck(queryRunner);
      completed.push('previous_version CHECK');
    } catch (error) {
      throw new Error(
        `previous_version 迁移失败；已完成 [${completed.join('、') || '无'}]；原因：${detailOf(error)}`,
        { cause: error },
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const checkExists = await this.hasCheck(queryRunner);
    const columnExists = await this.hasColumn(queryRunner);
    const clauses: string[] = [];
    if (checkExists) clauses.push(`DROP CHECK \`${CHECK}\``);
    if (columnExists) clauses.push(`DROP COLUMN \`${COLUMN}\``);
    if (clauses.length === 0) return;
    await queryRunner.query(`ALTER TABLE \`${TABLE}\` ${clauses.join(', ')}`);
  }

  private async ensureColumn(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT \`COLUMN_NAME\` AS \`columnName\`,
              \`COLUMN_TYPE\` AS \`columnType\`,
              \`IS_NULLABLE\` AS \`isNullable\`,
              \`COLUMN_DEFAULT\` AS \`columnDefault\`,
              \`EXTRA\` AS \`extra\`,
              \`GENERATION_EXPRESSION\` AS \`generationExpression\`
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    )) as unknown as ColumnRow[];

    if (rows.length === 0) {
      await queryRunner.query(
        `ALTER TABLE \`${TABLE}\`
           ADD COLUMN \`${COLUMN}\` ${COLUMN_TYPE} NULL DEFAULT NULL
             COMMENT '${COLUMN_COMMENT}'
             AFTER \`revision_no\``,
      );
      return;
    }

    const actual = rows[0];
    const typeMatches = normalizeType(actual.columnType) === normalizeType(COLUMN_TYPE);
    const nullable = actual.isNullable === 'YES';
    const defaultIsNull =
      actual.columnDefault === null || String(actual.columnDefault).trim().toLowerCase() === 'null';
    const notGenerated = actual.generationExpression.trim() === '';
    const extra = actual.extra.trim().toLowerCase();
    if (!typeMatches || !nullable || !defaultIsNull || !notGenerated || extra !== '') {
      throw new Error(
        `字段 ${COLUMN} 已存在但定义不符（type=${actual.columnType}, nullable=${actual.isNullable}, default=${String(
          actual.columnDefault,
        )}, extra=${actual.extra}），拒绝复用`,
      );
    }
  }

  private async ensureCheck(queryRunner: QueryRunner): Promise<void> {
    const exists = await this.hasCheck(queryRunner);
    if (exists) {
      const clause = await this.readCheckClause(queryRunner);
      if (this.normalizeClause(clause) === this.normalizeClause(CHECK_CLAUSE)) {
        return;
      }
      await queryRunner.query(
        `ALTER TABLE \`${TABLE}\`
           DROP CHECK \`${CHECK}\`,
           ADD CONSTRAINT \`${CHECK}\` CHECK (${CHECK_CLAUSE})`,
      );
      return;
    }
    await queryRunner.query(
      `ALTER TABLE \`${TABLE}\`
         ADD CONSTRAINT \`${CHECK}\` CHECK (${CHECK_CLAUSE})`,
    );
  }

  private async hasColumn(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
        LIMIT 1`,
      [TABLE, COLUMN],
    )) as unknown as unknown[];
    return rows.length > 0;
  }

  private async hasCheck(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1
         FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND CONSTRAINT_NAME = ?
          AND CONSTRAINT_TYPE = 'CHECK'
        LIMIT 1`,
      [TABLE, CHECK],
    )) as unknown as unknown[];
    return rows.length > 0;
  }

  private async readCheckClause(queryRunner: QueryRunner): Promise<string> {
    const rows = (await queryRunner.query(
      `SELECT cc.\`CHECK_CLAUSE\` AS \`checkClause\`
         FROM information_schema.CHECK_CONSTRAINTS cc
         JOIN information_schema.TABLE_CONSTRAINTS tc
           ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
          AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
        WHERE cc.CONSTRAINT_SCHEMA = DATABASE()
          AND tc.TABLE_NAME = ?
          AND cc.CONSTRAINT_NAME = ?`,
      [TABLE, CHECK],
    )) as unknown as ReadonlyArray<{ readonly checkClause?: string }>;
    return String(rows[0]?.checkClause ?? '');
  }

  private normalizeClause(value: string): string {
    return value.replace(/[`\s]/g, '').toLowerCase();
  }
}

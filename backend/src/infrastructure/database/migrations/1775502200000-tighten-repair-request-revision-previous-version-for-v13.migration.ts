import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'repair_request_revision';
const COLUMN = 'previous_version';
const COLUMN_TYPE = 'int unsigned';
const COLUMN_COMMENT = '该修订比较/基于的上一生效修订号；0=首版；后续=实际基版本';
const SAMPLE_LIMIT = 20;

interface ColumnRow {
  readonly columnName: string;
  readonly columnType: string;
  readonly isNullable: 'YES' | 'NO';
  readonly columnDefault: string | null;
  readonly extra: string;
  readonly generationExpression: string;
}

interface CountRow {
  readonly total: number | string;
}

interface IdRow {
  readonly id: number | string | null;
}

const detailOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const normalizeType = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const defaultIsNull = (value: string | null): boolean =>
  value === null || String(value).trim().toLowerCase() === 'null';

/**
 * 第 44 条：把 repair_request_revision.previous_version 收紧为 NOT NULL、无默认值。
 *
 * 已批准的 previous_version 裁决：
 * - 最终列 NOT NULL 且无默认值；
 * - 首次修订明确写 0，后续写实际基版本；
 * - 保留 `previous_version < revision_no` 顺序守卫（第 43 条的 CHECK 继续生效）；
 * - 旧行无法证明取值时拒绝升级，不猜测回填、不删除历史行。
 *
 * 因此本迁移在**任何 ALTER 之前**先校验 NULL 与非法版本序；发现违规则失败关闭，
 * 只输出脱敏计数与有限定位 ID，不做自动 UPDATE。无违规才收紧列约束。
 * down 只回退可空性，不伪造、不删除任何版本值。
 */
export class TightenRepairRequestRevisionPreviousVersionForV131775502200000 implements MigrationInterface {
  readonly name = 'TightenRepairRequestRevisionPreviousVersionForV131775502200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const completed: string[] = [];
    try {
      const column = await this.readColumn(queryRunner);
      if (!column) {
        throw new Error(`字段 ${COLUMN} 缺失：第 44 条要求第 43 条已执行`);
      }

      // 1. 在任何 ALTER 之前完成数据校验：NULL 与非法版本序都拒绝。
      await this.assertTightenable(queryRunner);

      // 2. 只有无违规才收紧；重复执行时已是终态则跳过。
      const changed = await this.tighten(queryRunner, column);
      if (changed) completed.push('previous_version NOT NULL');

      await this.assertFinalColumn(queryRunner);
    } catch (error) {
      throw new Error(
        `previous_version 收紧失败；已完成 [${completed.join('、') || '无 ALTER'}]；` +
          `原因：${detailOf(error)}`,
        { cause: error },
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const column = await this.readColumn(queryRunner);
    if (!column) return;
    if (column.isNullable === 'YES' && defaultIsNull(column.columnDefault)) return;
    // 仅回退可空性，保留所有已写入的版本值，不伪造、不删除。
    await queryRunner.query(
      `ALTER TABLE \`${TABLE}\`
         MODIFY COLUMN \`${COLUMN}\` ${COLUMN_TYPE} NULL DEFAULT NULL
           COMMENT '${COLUMN_COMMENT}'`,
    );
  }

  private async assertTightenable(queryRunner: QueryRunner): Promise<void> {
    const nullCount = await this.countWhere(queryRunner, `\`${COLUMN}\` IS NULL`);
    const invalidCondition = `\`${COLUMN}\` IS NOT NULL AND \`${COLUMN}\` >= \`revision_no\``;
    const invalidCount = await this.countWhere(queryRunner, invalidCondition);
    if (nullCount === 0 && invalidCount === 0) return;

    const nullIds = nullCount > 0 ? await this.sampleIds(queryRunner, `\`${COLUMN}\` IS NULL`) : [];
    const invalidIds = invalidCount > 0 ? await this.sampleIds(queryRunner, invalidCondition) : [];
    throw new Error(
      `数据不满足收紧条件（仅输出计数与有限定位 ID）：` +
        `previous_version IS NULL=${nullCount}` +
        `${nullIds.length > 0 ? `（样本 ID: ${nullIds.join(',')}）` : ''}；` +
        `previous_version >= revision_no=${invalidCount}` +
        `${invalidIds.length > 0 ? `（样本 ID: ${invalidIds.join(',')}）` : ''}。` +
        `本迁移未执行任何 ALTER；禁止猜测回填或删除历史行，请人工核实后重试`,
    );
  }

  private async tighten(queryRunner: QueryRunner, column: ColumnRow): Promise<boolean> {
    const typeMatches = normalizeType(column.columnType) === normalizeType(COLUMN_TYPE);
    if (!typeMatches) {
      throw new Error(
        `字段 ${COLUMN} 类型不符（实际 ${column.columnType}，期望 ${COLUMN_TYPE}），拒绝收紧`,
      );
    }
    if (column.generationExpression.trim() !== '') {
      throw new Error(`字段 ${COLUMN} 为生成列，拒绝收紧`);
    }
    if (
      column.isNullable === 'NO' &&
      defaultIsNull(column.columnDefault) &&
      column.extra.trim() === ''
    ) {
      return false;
    }
    await queryRunner.query(
      `ALTER TABLE \`${TABLE}\`
         MODIFY COLUMN \`${COLUMN}\` ${COLUMN_TYPE} NOT NULL
           COMMENT '${COLUMN_COMMENT}'`,
    );
    return true;
  }

  private async assertFinalColumn(queryRunner: QueryRunner): Promise<void> {
    const actual = await this.readColumn(queryRunner);
    if (!actual) {
      throw new Error(`字段 ${COLUMN} 在收紧后缺失`);
    }
    const problems: string[] = [];
    if (normalizeType(actual.columnType) !== normalizeType(COLUMN_TYPE)) {
      problems.push(`type=${actual.columnType}`);
    }
    if (actual.isNullable !== 'NO') problems.push(`nullable=${actual.isNullable}`);
    if (!defaultIsNull(actual.columnDefault))
      problems.push(`default=${String(actual.columnDefault)}`);
    if (actual.extra.trim() !== '') problems.push(`extra=${actual.extra}`);
    if (actual.generationExpression.trim() !== '') {
      problems.push(`generated=${actual.generationExpression}`);
    }
    if (problems.length > 0) {
      throw new Error(`字段 ${COLUMN} 收紧后仍不符：${problems.join(', ')}`);
    }
  }

  private async countWhere(queryRunner: QueryRunner, condition: string): Promise<number> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS \`total\` FROM \`${TABLE}\` WHERE ${condition}`,
    )) as unknown as CountRow[];
    const total = Number(rows[0]?.total);
    if (!Number.isFinite(total) || total < 0) {
      throw new Error(`无法读取 ${COLUMN} 违规计数`);
    }
    return total;
  }

  private async sampleIds(queryRunner: QueryRunner, condition: string): Promise<string[]> {
    const rows = (await queryRunner.query(
      `SELECT \`id\` AS \`id\` FROM \`${TABLE}\`
        WHERE ${condition}
        ORDER BY \`id\` ASC
        LIMIT ${SAMPLE_LIMIT}`,
    )) as unknown as IdRow[];
    return rows
      .map((row) => (row.id === null || row.id === undefined ? '' : String(row.id)))
      .filter((id) => id.length > 0);
  }

  private async readColumn(queryRunner: QueryRunner): Promise<ColumnRow | null> {
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
          AND COLUMN_NAME = ?
        LIMIT 1`,
      [TABLE, COLUMN],
    )) as unknown as ColumnRow[];
    return rows[0] ?? null;
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 恢复 `maintenance_report.ai_helpfulness` 的 1—5 取值范围。
 *
 * 旧版 V13 第 32 条（`AlterRepairAiReportForV131775501100000`）曾把该 CHECK 收紧为 1—4，
 * 使 31 态合法的评分 5 无法升级。已修正的第 32 条不再收紧；但已经执行过旧版第 32 条
 * 的目标仍停在 1—4，需要本迁移把定义恢复成与新建/31 态升级一致的 1—5。
 *
 * 范围：
 * - 只重建 `chk_maintenance_report_ai_helpfulness` 一条 CHECK；
 * - 不改写任何行、不修改 `ai_helpfulness` 值、不触碰 `ai_score`；
 * - 新输入 1—4 的限制在应用层执行，数据库保留 1—5 以读取历史 5。
 *
 * 幂等：先探测约束是否存在，存在则 DROP + ADD（单条 ALTER 原子），
 * 不存在则只 ADD，便于部分失败后重跑。无新增列或索引，结构预检不视为新对象。
 */
export class RestoreMaintenanceReportHelpfulnessRangeForV131775501800000 implements MigrationInterface {
  name = 'RestoreMaintenanceReportHelpfulnessRangeForV131775501800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await rebuildHelpfulnessConstraint(queryRunner);
  }

  public async down(): Promise<void> {
    // 有意不回退：重新收紧为 1—4 会让库内合法旧值 5 不可用，也与已批准的目标结构冲突。
  }
}

const TABLE = 'maintenance_report';
const CONSTRAINT = 'chk_maintenance_report_ai_helpfulness';

async function rebuildHelpfulnessConstraint(queryRunner: QueryRunner): Promise<void> {
  const rows = (await queryRunner.query(
    `SELECT 1 AS present
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?
        AND CONSTRAINT_TYPE = 'CHECK'
      LIMIT 1`,
    [TABLE, CONSTRAINT],
  )) as ReadonlyArray<{ present?: unknown }>;

  const dropClause = rows.length > 0 ? `\n        DROP CONSTRAINT \`${CONSTRAINT}\`,` : '';

  try {
    await queryRunner.query(`
      ALTER TABLE \`${TABLE}\`${dropClause}
        ADD CONSTRAINT \`${CONSTRAINT}\` CHECK (
          \`ai_helpfulness\` IS NULL OR \`ai_helpfulness\` BETWEEN 1 AND 5
        );
    `);
  } catch (error) {
    throw new Error(
      '[restore-ai-helpfulness-range] ALTER 失败：未能恢复 ai_helpfulness 1—5 约束；' +
        'MySQL DDL 会隐式提交，本迁移尚未被记录为成功。\n' +
        '续跑：修复失败原因后可重新执行本迁移；约束存在时会幂等 DROP/ADD。\n' +
        `原始错误：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

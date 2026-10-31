import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 维修申请处理组合的 NULL 安全修正（第 31 条迁移）。
 *
 * 26 号迁移的原始表达式在单边 NULL 时会退化为 UNKNOWN，而 MySQL CHECK
 * 对 UNKNOWN 视为通过，导致「结果有值 / 状态为空」或反向组合落库。
 * 本迁移只放宽「两者同时为空」与「两者成对且符合固定映射」两种合法形态，
 * 其余组合表达式都显式得到 FALSE。
 *
 * MySQL 8 的 DDL 会隐式提交，迁移事务无法回滚结构变更；因此这里把
 * DROP + ADD 收敛为单条 ALTER TABLE（MySQL 8 原子 DDL），失败时结构
 * 停留在 30 态并由 `migration:status` 的预检报告，不自动补偿、不删除数据。
 */
export class AddNullSafeHandlingConstraints1775401600000 implements MigrationInterface {
  name = 'AddNullSafeHandlingConstraints1775401600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 替换前先扫描存量非法组合；发现即失败并报告行数与样例 ID，不猜测修复。
    const invalidRows = (await queryRunner.query(`
      SELECT COUNT(*) AS total
      FROM \`repair_request\`
      WHERE (\`handling_result\` IS NULL AND \`handling_status\` IS NOT NULL)
         OR (\`handling_result\` IS NOT NULL AND \`handling_status\` IS NULL)
         OR (
           \`handling_result\` IS NOT NULL AND \`handling_status\` IS NOT NULL
           AND NOT (
             (\`handling_result\` = 'FIXED' AND \`handling_status\` = 'COMPLETED')
             OR (\`handling_result\` = 'PART_PURCHASED' AND \`handling_status\` = 'COMPLETED')
             OR (\`handling_result\` = 'PROVIDE_PLAN_SELF_EXECUTE' AND \`handling_status\` = 'COMPLETED')
             OR (\`handling_result\` = 'INTERRUPTED' AND \`handling_status\` = 'IN_PROGRESS')
             OR (\`handling_result\` = 'UNREPAIRABLE' AND \`handling_status\` = 'UNRESOLVED')
           )
         )
         OR (
           \`handling_result\` IS NULL AND \`handling_status\` IS NULL
           AND (\`handling_recorded_at\` IS NOT NULL OR \`handling_ended_at\` IS NOT NULL)
         )
         OR (
           \`handling_result\` IS NOT NULL AND \`handling_status\` IS NOT NULL
           AND (
             \`handling_recorded_at\` IS NULL
             OR (\`handling_status\` = 'IN_PROGRESS' AND \`handling_ended_at\` IS NOT NULL)
             OR (\`handling_status\` IN ('COMPLETED', 'UNRESOLVED') AND \`handling_ended_at\` IS NULL)
           )
         );
    `)) as Array<{ total: number | string }>;
    const invalidCount = Number(invalidRows[0]?.total ?? 0);
    if (invalidCount > 0) {
      const samples = (await queryRunner.query(`
        SELECT \`id\`
        FROM \`repair_request\`
        WHERE (\`handling_result\` IS NULL AND \`handling_status\` IS NOT NULL)
           OR (\`handling_result\` IS NOT NULL AND \`handling_status\` IS NULL)
           OR (
             \`handling_result\` IS NOT NULL AND \`handling_status\` IS NOT NULL
             AND NOT (
               (\`handling_result\` = 'FIXED' AND \`handling_status\` = 'COMPLETED')
               OR (\`handling_result\` = 'PART_PURCHASED' AND \`handling_status\` = 'COMPLETED')
               OR (\`handling_result\` = 'PROVIDE_PLAN_SELF_EXECUTE' AND \`handling_status\` = 'COMPLETED')
               OR (\`handling_result\` = 'INTERRUPTED' AND \`handling_status\` = 'IN_PROGRESS')
               OR (\`handling_result\` = 'UNREPAIRABLE' AND \`handling_status\` = 'UNRESOLVED')
             )
           )
           OR (
             \`handling_result\` IS NULL AND \`handling_status\` IS NULL
             AND (\`handling_recorded_at\` IS NOT NULL OR \`handling_ended_at\` IS NOT NULL)
           )
           OR (
             \`handling_result\` IS NOT NULL AND \`handling_status\` IS NOT NULL
             AND (
               \`handling_recorded_at\` IS NULL
               OR (\`handling_status\` = 'IN_PROGRESS' AND \`handling_ended_at\` IS NOT NULL)
               OR (\`handling_status\` IN ('COMPLETED', 'UNRESOLVED') AND \`handling_ended_at\` IS NULL)
             )
           )
        ORDER BY \`id\`
        LIMIT 5;
      `)) as Array<{ id: number | string }>;
      const sampleIds = samples.map((row) => String(row.id)).join(', ');
      throw new Error(
        `[repair_request 处理组合预检失败] 发现 ${String(invalidCount)} 行非法'处理结果/状态/时间组合'（样例 id: ${sampleIds}）。` +
          '请人工核对并修复数据后重试；本迁移不会自动猜测修复或删除记录。',
      );
    }

    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        DROP CHECK \`chk_repair_request_handling_mapping\`,
        DROP CHECK \`chk_repair_request_handling_time\`,
        ADD CONSTRAINT \`chk_repair_request_handling_mapping\` CHECK (
          (\`handling_result\` IS NULL AND \`handling_status\` IS NULL)
          OR
          (\`handling_result\` IS NOT NULL AND \`handling_status\` IS NOT NULL
            AND (
              (\`handling_result\` = 'FIXED' AND \`handling_status\` = 'COMPLETED')
              OR (\`handling_result\` = 'PART_PURCHASED' AND \`handling_status\` = 'COMPLETED')
              OR (\`handling_result\` = 'PROVIDE_PLAN_SELF_EXECUTE' AND \`handling_status\` = 'COMPLETED')
              OR (\`handling_result\` = 'INTERRUPTED' AND \`handling_status\` = 'IN_PROGRESS')
              OR (\`handling_result\` = 'UNREPAIRABLE' AND \`handling_status\` = 'UNRESOLVED')
            )
          )
        ),
        ADD CONSTRAINT \`chk_repair_request_handling_time\` CHECK (
          (\`handling_result\` IS NULL AND \`handling_status\` IS NULL
            AND \`handling_recorded_at\` IS NULL AND \`handling_ended_at\` IS NULL)
          OR
          (\`handling_result\` IS NOT NULL AND \`handling_status\` IS NOT NULL
            AND \`handling_recorded_at\` IS NOT NULL
            AND (
              (\`handling_status\` = 'IN_PROGRESS' AND \`handling_ended_at\` IS NULL)
              OR (\`handling_status\` IN ('COMPLETED', 'UNRESOLVED') AND \`handling_ended_at\` IS NOT NULL)
            )
          )
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        DROP CHECK \`chk_repair_request_handling_time\`,
        DROP CHECK \`chk_repair_request_handling_mapping\`,
        ADD CONSTRAINT \`chk_repair_request_handling_mapping\` CHECK (
          (\`handling_result\` IS NULL AND \`handling_status\` IS NULL)
          OR
          (\`handling_result\` = 'FIXED' AND \`handling_status\` = 'COMPLETED')
          OR
          (\`handling_result\` = 'PART_PURCHASED' AND \`handling_status\` = 'COMPLETED')
          OR
          (\`handling_result\` = 'PROVIDE_PLAN_SELF_EXECUTE' AND \`handling_status\` = 'COMPLETED')
          OR
          (\`handling_result\` = 'INTERRUPTED' AND \`handling_status\` = 'IN_PROGRESS')
          OR
          (\`handling_result\` = 'UNREPAIRABLE' AND \`handling_status\` = 'UNRESOLVED')
        ),
        ADD CONSTRAINT \`chk_repair_request_handling_time\` CHECK (
          (\`handling_result\` IS NULL AND \`handling_ended_at\` IS NULL AND \`handling_recorded_at\` IS NULL)
          OR
          (\`handling_result\` IS NOT NULL AND \`handling_recorded_at\` IS NOT NULL
            AND ((\`handling_status\` = 'IN_PROGRESS' AND \`handling_ended_at\` IS NULL)
              OR (\`handling_status\` IN ('COMPLETED', 'UNRESOLVED') AND \`handling_ended_at\` IS NOT NULL)))
        );
    `);
  }
}

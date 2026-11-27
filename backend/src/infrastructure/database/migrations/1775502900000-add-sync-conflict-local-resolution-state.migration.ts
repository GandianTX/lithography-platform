import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 「保留本地」裁决幂等状态（第 51 条，前向追加）。
 *
 * 背景（任务 09 R-03；review M7）：「保留本地」裁决跨三段写入——
 * tx1 锁读并规划、tx2 由来源业务受控入口写正文、tx3 写回冲突事实。
 * tx2 自持事务（跨域受控入口），tx3 失败时**正文已写、冲突事实未改写**。
 * 此时重放同一裁决，若没有幂等依据就会再写一份正文。
 *
 * 本迁移在 `sync_conflict` 上追加一列 `local_resolution_state` 作为**幂等标记**：
 * - 业务键就是冲突主键 `conflict_id`（不再另立键列）；
 * - `WRITING`：正文写入已开始（尚未写回冲突事实）；
 * - `WRITTEN`：正文与冲突事实都已写回。
 *
 * 兼容口径：
 * - 历史行保持 NULL（从未走过本地裁决），**不回填、不伪造**；
 * - 不改写既有 `decision`／`status` 事实，不新建表；
 * - 不修改已接受的 50 条历史迁移。
 */
const TABLE = 'sync_conflict';
const NEW_COLUMN = 'local_resolution_state';
const NEW_CHECK = 'chk_sync_conflict_local_resolution_state';

export class AddSyncConflictLocalResolutionStateForV131775502900000 implements MigrationInterface {
  name = 'AddSyncConflictLocalResolutionStateForV131775502900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreparation(queryRunner);

    try {
      await queryRunner.query(
        `
        ALTER TABLE \`${TABLE}\`
          ADD COLUMN \`${NEW_COLUMN}\` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '保留本地裁决幂等状态：WRITING/WRITTEN；历史行保持 NULL',
          ADD CONSTRAINT \`${NEW_CHECK}\` CHECK (\`${NEW_COLUMN}\` IS NULL OR \`${NEW_COLUMN}\` IN ('WRITING', 'WRITTEN'))
      `,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 51 条迁移失败于「${TABLE} 追加保留本地裁决幂等状态列」；重跑前会由半迁移预检拦截，请人工核对已生效对象。原因：${reason}`,
        { cause: error },
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回退顺序固定：先删约束，再删列；不改数据、不回填。
    await queryRunner.query(`ALTER TABLE \`${TABLE}\` DROP CHECK \`${NEW_CHECK}\`;`);
    await queryRunner.query(`ALTER TABLE \`${TABLE}\` DROP COLUMN \`${NEW_COLUMN}\`;`);
  }

  /**
   * 半迁移保护：前置表缺失或目标列已存在即失败关闭，禁止盲目重跑。
   */
  private async assertPreparation(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable(TABLE))) {
      throw new Error(`迁移前置表缺失：${TABLE}`);
    }
    if (await queryRunner.hasColumn(TABLE, NEW_COLUMN)) {
      throw new Error(`检测到半迁移状态：${TABLE}.${NEW_COLUMN} 已存在，请人工核对后处理`);
    }
  }
}

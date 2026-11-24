import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 本机写入／同步**范围锁载体**（任务 09 独立验收 P1-1，前向追加）。
 *
 * 背景（P1-1 反例）：业务写入侧只**读**冻结事实（`local_write_hold`），
 * 恢复侧**写**冻结事实，两侧没有共用同一个"持有到业务事务提交"的锁 ⇒
 * "A 已检查未冻结但尚未提交 → B 建立冻结并开始恢复 → A 继续写入"的窗口成立。
 *
 * 本迁移新增 `local_write_scope_lock` 表：每个**（本机安装标识 × 公司数据区）**范围一行，
 * 业务写入取共享锁（`FOR SHARE`）、恢复建立／解除冻结取排他锁（`FOR UPDATE`），
 * 行锁随事务提交／回滚自动释放 ⇒ 恢复建立冻结必须等在途业务事务收口后才成立。
 *
 * 兼容口径：
 * - 新建表，不修改任何已接受的历史迁移；
 * - 建表语句里表名**写字面量**（迁移诊断器按字面量解析"本迁移应创建的表"）；
 * - 不预置任何行（历史没有"范围锁"这一事实，不伪造）。
 */
const TABLE = 'local_write_scope_lock';
const NEW_UNIQUE_INDEX = 'uk_local_write_scope_lock_scope';
const NEW_INSTALLATION_FOREIGN_KEY = 'fk_local_write_scope_lock_installation';
const NEW_ORGANIZATION_FOREIGN_KEY = 'fk_local_write_scope_lock_organization';

export class AddLocalWriteScopeLockForV131775503400000 implements MigrationInterface {
  name = 'AddLocalWriteScopeLockForV131775503400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreparation(queryRunner);

    try {
      await queryRunner.query(
        `
        CREATE TABLE \`local_write_scope_lock\` (
          \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '范围锁行ID',
          \`installation_id\` char(36) NOT NULL COMMENT '本机安装标识',
          \`organization_id\` int NOT NULL COMMENT '公司数据区',
          \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '范围锁行建立时间',
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`${NEW_UNIQUE_INDEX}\` (\`installation_id\`, \`organization_id\`),
          CONSTRAINT \`${NEW_INSTALLATION_FOREIGN_KEY}\` FOREIGN KEY (\`installation_id\`)
            REFERENCES \`local_installation\` (\`installation_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
          CONSTRAINT \`${NEW_ORGANIZATION_FOREIGN_KEY}\` FOREIGN KEY (\`organization_id\`)
            REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='本机写入/同步范围锁载体表'
      `,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 54 条迁移失败于「${TABLE} 建立写入/同步范围锁载体」；重跑前会由半迁移预检拦截，请人工核对已生效对象。原因：${reason}`,
        { cause: error },
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS \`${TABLE}\`;`);
  }

  /** 半迁移保护：表已存在即失败关闭，禁止盲目重跑 */
  private async assertPreparation(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS \`count\` FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [TABLE],
    )) as unknown as { count: number }[];
    if (Number(rows[0]?.count ?? 0) > 0) {
      throw new Error(`半迁移状态：${TABLE} 已存在`);
    }
  }
}

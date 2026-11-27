import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 上传任务的原账号授权绑定（第 52 条，前向追加）。
 *
 * 背景（任务 09 S2.1／S2.2）：`local_upload_task` 此前只有 `installation_id` 一个外键，
 * 既没有公司列也没有账号列，导致：
 * - 任务无法按公司范围派发与核对（读侧注释已登记该缺口：G-8）；
 * - 无法证明"这条任务由原账号的授权发起"，换账号／换公司可能接管原任务（R090）。
 *
 * 本迁移追加两列并建立 RESTRICT 外键与组合索引：
 * - `organization_id`：任务归属的公司数据区；
 * - `account_id`：来源记录的授权主体账号（原账号）。
 *
 * 兼容口径：
 * - 历史行两列保持 NULL（**不回填、不猜测**）：历史任务从未登记绑定事实，
 *   派生一个公司／账号冒充原绑定会制造虚假归属；
 * - 派发链遇到绑定为 NULL 的历史任务时按"无法归属"处理，不据空值放行；
 * - 不新建表，不修改已接受的历史迁移。
 */
const TABLE = 'local_upload_task';
const NEW_COLUMNS = ['organization_id', 'account_id'] as const;
const NEW_INDEX = 'idx_local_upload_task_binding';
const NEW_ORGANIZATION_FOREIGN_KEY = 'fk_local_upload_task_organization';
const NEW_ACCOUNT_FOREIGN_KEY = 'fk_local_upload_task_account';
/**
 * 账号表的**真实表名**（实体 `@Entity('base_user_account')`）。
 *
 * 早期版本误写为 `account`，导致本迁移在任何既有库上都无法执行
 * （外键目标表不存在 ⇒ 前置校验失败关闭）。该迁移从未在任何库生效过
 * （dev 库无 `organization_id`/`account_id` 列、迁移历史也无此条），
 * 故按"未生效的迁移可就地订正"处理：**不改已接受基线**，
 * 只把外键目标与前置表名校正为真实表名。
 */
const ACCOUNT_TABLE = 'base_user_account';

export class AddUploadTaskAccountBindingForV131775503000000 implements MigrationInterface {
  name = 'AddUploadTaskAccountBindingForV131775503000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreparation(queryRunner);

    try {
      await queryRunner.query(
        `
        ALTER TABLE \`${TABLE}\`
          ADD COLUMN \`organization_id\` int DEFAULT NULL COMMENT '公司数据区；历史行保持 NULL（无法归属公司）',
          ADD COLUMN \`account_id\` int DEFAULT NULL COMMENT '原账号（授权主体）账号ID；历史行保持 NULL',
          ADD KEY \`${NEW_INDEX}\` (\`installation_id\`, \`organization_id\`, \`account_id\`),
          ADD CONSTRAINT \`${NEW_ORGANIZATION_FOREIGN_KEY}\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
          ADD CONSTRAINT \`${NEW_ACCOUNT_FOREIGN_KEY}\` FOREIGN KEY (\`account_id\`) REFERENCES \`${ACCOUNT_TABLE}\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
      `,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 52 条迁移失败于「${TABLE} 追加原账号授权绑定列」；重跑前会由半迁移预检拦截，请人工核对已生效对象。原因：${reason}`,
        { cause: error },
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回退顺序固定：先删外键与索引，再删列；不改数据、不回填。
    await queryRunner.query(
      `ALTER TABLE \`${TABLE}\` DROP FOREIGN KEY \`${NEW_ACCOUNT_FOREIGN_KEY}\`;`,
    );
    await queryRunner.query(
      `ALTER TABLE \`${TABLE}\` DROP FOREIGN KEY \`${NEW_ORGANIZATION_FOREIGN_KEY}\`;`,
    );
    await queryRunner.query(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${NEW_INDEX}\`;`);
    await queryRunner.query(`ALTER TABLE \`${TABLE}\` DROP COLUMN \`account_id\`;`);
    await queryRunner.query(`ALTER TABLE \`${TABLE}\` DROP COLUMN \`organization_id\`;`);
  }

  /**
   * 半迁移保护：前置表缺失或目标列已存在即失败关闭，禁止盲目重跑。
   */
  private async assertPreparation(queryRunner: QueryRunner): Promise<void> {
    for (const table of [TABLE, 'organization', ACCOUNT_TABLE]) {
      if (!(await queryRunner.hasTable(table))) {
        throw new Error(`迁移前置表缺失：${table}`);
      }
    }
    for (const column of NEW_COLUMNS) {
      if (await queryRunner.hasColumn(TABLE, column)) {
        throw new Error(`检测到半迁移状态：${TABLE}.${column} 已存在，请人工核对后处理`);
      }
    }
  }
}

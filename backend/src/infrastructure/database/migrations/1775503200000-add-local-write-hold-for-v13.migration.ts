import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 本机写入／同步冻结闸门（第 53 条，前向追加）。
 *
 * 背景（任务 09 S5-2／S5-3）：恢复执行需要三道闸门，其中"写入/同步闸门"此前**完全没有载体**——
 * `restore-execution-capability.policy.ts` 只能如实报 `RESTORE_WRITE_GATE_UNAVAILABLE`，
 * 恢复执行链因此无法落地（"恢复期间冻结目标公司数据区的写入与同步"无处落地）。
 *
 * 本迁移新增 `local_write_hold` 表：
 * - 冻结范围＝**本机安装标识 × 受影响公司数据区**（"受影响设备公司范围"）；
 * - 冻结类型＝`RESTORE`（恢复期冻结写入与同步）；
 * - 状态＝`ACTIVE`／`RELEASED`，`RELEASED` 必须带 `released_at`；
 * - 关联恢复运行 ID（`restore_id`），便于"重启后可识别"（冻结事实落库，不依赖进程内存）。
 *
 * 兼容口径：
 * - 新建表，不修改任何已接受的历史迁移；
 * - 建表语句里表名**写字面量**（不用模板变量）：迁移诊断器按字面量解析"本迁移应创建的表"，
 *   模板变量会被解析成 `${TABLE}` 而误报"结构缺失"；
 * - 不预置任何行（历史无冻结事实，不伪造）。
 */
const TABLE = 'local_write_hold';
const NEW_INDEX = 'idx_local_write_hold_scope';
const NEW_INSTALLATION_FOREIGN_KEY = 'fk_local_write_hold_installation';
const NEW_ORGANIZATION_FOREIGN_KEY = 'fk_local_write_hold_organization';

export class AddLocalWriteHoldForV131775503200000 implements MigrationInterface {
  name = 'AddLocalWriteHoldForV131775503200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreparation(queryRunner);

    try {
      await queryRunner.query(
        `
        CREATE TABLE \`local_write_hold\` (
          \`hold_id\` char(36) NOT NULL COMMENT '冻结ID',
          \`installation_id\` char(36) NOT NULL COMMENT '本机安装标识',
          \`organization_id\` int NOT NULL COMMENT '受影响公司数据区',
          \`hold_type\` varchar(16) NOT NULL COMMENT '冻结类型：RESTORE=恢复期写入/同步冻结',
          \`status\` varchar(16) NOT NULL COMMENT 'ACTIVE/RELEASED',
          \`restore_id\` char(36) DEFAULT NULL COMMENT '关联恢复运行ID；恢复期冻结的来源',
          \`reason\` varchar(255) NOT NULL COMMENT '冻结原因（受控说明，不含敏感材料）',
          \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '冻结建立时间',
          \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间',
          \`released_at\` timestamp(3) DEFAULT NULL COMMENT '解除冻结时间',
          PRIMARY KEY (\`hold_id\`),
          KEY \`${NEW_INDEX}\` (\`installation_id\`, \`organization_id\`, \`status\`),
          CONSTRAINT \`chk_local_write_hold_type\` CHECK (\`hold_type\` IN ('RESTORE')),
          CONSTRAINT \`chk_local_write_hold_status\` CHECK (\`status\` IN ('ACTIVE', 'RELEASED')),
          CONSTRAINT \`chk_local_write_hold_released\` CHECK (
            (\`status\` = 'ACTIVE' AND \`released_at\` IS NULL) OR (\`status\` = 'RELEASED' AND \`released_at\` IS NOT NULL)
          ),
          CONSTRAINT \`${NEW_INSTALLATION_FOREIGN_KEY}\` FOREIGN KEY (\`installation_id\`)
            REFERENCES \`local_installation\` (\`installation_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
          CONSTRAINT \`${NEW_ORGANIZATION_FOREIGN_KEY}\` FOREIGN KEY (\`organization_id\`)
            REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='本机写入/同步冻结闸门表'
      `,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 53 条迁移失败于「${TABLE} 建立写入/同步冻结闸门」；重跑前会由半迁移预检拦截，请人工核对已生效对象。原因：${reason}`,
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

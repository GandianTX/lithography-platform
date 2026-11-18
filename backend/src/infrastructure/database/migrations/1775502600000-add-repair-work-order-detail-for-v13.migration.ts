import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 报修工单维修事实与排查明细（第 48 条，前向追加）。
 *
 * 仅在 repair_request 上追加维修事实列，并新建排查步骤/故障面板两张子表；
 * 历史行不搬迁、不猜测回填：维修列保持 NULL，维修版本号默认 0。
 * 附件引用指向既有 stored_file.file_id，唯一且 RESTRICT；面板 -> 步骤 -> 工单
 * 全部 RESTRICT，删除顺序必须先子后父。
 */
const REPAIR_REQUEST_NEW_COLUMNS = [
  'maintenance_date',
  'maintenance_engineer_name_snapshot',
  'reset_result',
  'supplementary_note',
  'maintenance_attachment_file_id',
  'maintenance_version_no',
] as const;

const NEW_TABLES = ['repair_request_diagnostic_step', 'repair_request_fault_panel'] as const;

export class AddRepairWorkOrderDetailForV131775502600000 implements MigrationInterface {
  name = 'AddRepairWorkOrderDetailForV131775502600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreparation(queryRunner);

    await this.executeStep(
      queryRunner,
      'repair_request 维修列与附件约束',
      `
      ALTER TABLE \`repair_request\`
        ADD COLUMN \`maintenance_date\` date DEFAULT NULL COMMENT '维修日期',
        ADD COLUMN \`maintenance_engineer_name_snapshot\` varchar(200) DEFAULT NULL COMMENT '维修工程师姓名快照',
        ADD COLUMN \`reset_result\` varchar(16) DEFAULT NULL COMMENT '复位结果：NORMAL/SAME_FAULT/NEW_FAULT',
        ADD COLUMN \`supplementary_note\` text NULL COMMENT '维修补充说明',
        ADD COLUMN \`maintenance_attachment_file_id\` char(36) DEFAULT NULL COMMENT '维修附件原件ID',
        ADD COLUMN \`maintenance_version_no\` int unsigned NOT NULL DEFAULT 0 COMMENT '维修版本号；独立于管理修订版本',
        ADD UNIQUE KEY \`uk_repair_request_maintenance_attachment\` (\`maintenance_attachment_file_id\`),
        ADD CONSTRAINT \`fk_repair_request_maintenance_attachment\` FOREIGN KEY (\`maintenance_attachment_file_id\`) REFERENCES \`stored_file\` (\`file_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`chk_repair_request_maintenance_reset_result\` CHECK (\`reset_result\` IS NULL OR \`reset_result\` IN ('NORMAL', 'SAME_FAULT', 'NEW_FAULT')),
        ADD CONSTRAINT \`chk_repair_request_maintenance_version\` CHECK (\`maintenance_version_no\` >= 0)
    `,
    );

    await this.executeStep(
      queryRunner,
      '创建 repair_request_diagnostic_step',
      `
      CREATE TABLE \`repair_request_diagnostic_step\` (
        \`id\` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '排查步骤主键ID',
        \`request_id\` int NOT NULL COMMENT '所属工单ID',
        \`step_no\` int unsigned NOT NULL COMMENT '工单内顺序号；>=1 且唯一',
        \`error_code\` varchar(300) DEFAULT NULL COMMENT '步骤报错代码；保留前导零',
        \`part_name\` varchar(300) DEFAULT NULL COMMENT '零件/部位；选填',
        \`action_text\` text NOT NULL COMMENT '排查动作',
        \`result_code\` varchar(16) NOT NULL COMMENT 'RESOLVED/UNRESOLVED/NEW_FAULT',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_repair_request_diagnostic_step_no\` (\`request_id\`, \`step_no\`),
        UNIQUE KEY \`uk_repair_request_diagnostic_step_id\` (\`request_id\`, \`id\`),
        CONSTRAINT \`fk_repair_request_diagnostic_step_request\` FOREIGN KEY (\`request_id\`) REFERENCES \`repair_request\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_repair_request_diagnostic_step_no\` CHECK (\`step_no\` >= 1),
        CONSTRAINT \`chk_repair_request_diagnostic_step_action\` CHECK (CHAR_LENGTH(TRIM(\`action_text\`)) > 0),
        CONSTRAINT \`chk_repair_request_diagnostic_step_result\` CHECK (\`result_code\` IN ('RESOLVED', 'UNRESOLVED', 'NEW_FAULT'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='工单排查步骤';
    `,
    );

    await this.executeStep(
      queryRunner,
      '创建 repair_request_fault_panel',
      `
      CREATE TABLE \`repair_request_fault_panel\` (
        \`id\` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '故障面板主键ID',
        \`request_id\` int NOT NULL COMMENT '所属工单ID',
        \`panel_type\` varchar(24) NOT NULL COMMENT 'INITIAL/STEP_NEW_FAULT/RESET_NEW_FAULT',
        \`step_id\` bigint unsigned DEFAULT NULL COMMENT '来源步骤；仅 STEP_NEW_FAULT 非空',
        \`phase_code\` varchar(16) DEFAULT NULL COMMENT '稳定阶段编码；PHASE_01—PHASE_10',
        \`main_error\` varchar(300) DEFAULT NULL COMMENT '主报警代码',
        \`unit_error\` varchar(300) DEFAULT NULL COMMENT '单元报警代码',
        \`source\` varchar(300) DEFAULT NULL COMMENT '来源',
        \`error_type\` varchar(300) DEFAULT NULL COMMENT '错误类型',
        \`gpib_status\` varchar(300) DEFAULT NULL COMMENT 'GPIB 状态',
        \`fault_status\` varchar(300) DEFAULT NULL COMMENT '故障状态',
        \`description\` text NOT NULL COMMENT '故障描述',
        \`action\` text NULL COMMENT '处理动作',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        \`initial_request_id\` int GENERATED ALWAYS AS (IF(\`panel_type\` = 'INITIAL', \`request_id\`, NULL)) STORED COMMENT '初始面板唯一槽（生成列）',
        \`reset_request_id\` int GENERATED ALWAYS AS (IF(\`panel_type\` = 'RESET_NEW_FAULT', \`request_id\`, NULL)) STORED COMMENT '复位新故障面板唯一槽（生成列）',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_repair_request_fault_panel_initial\` (\`initial_request_id\`),
        UNIQUE KEY \`uk_repair_request_fault_panel_reset\` (\`reset_request_id\`),
        UNIQUE KEY \`uk_repair_request_fault_panel_step\` (\`request_id\`, \`step_id\`),
        CONSTRAINT \`fk_repair_request_fault_panel_request\` FOREIGN KEY (\`request_id\`) REFERENCES \`repair_request\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_request_fault_panel_step\` FOREIGN KEY (\`request_id\`, \`step_id\`) REFERENCES \`repair_request_diagnostic_step\` (\`request_id\`, \`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_repair_request_fault_panel_type\` CHECK (\`panel_type\` IN ('INITIAL', 'STEP_NEW_FAULT', 'RESET_NEW_FAULT')),
        CONSTRAINT \`chk_repair_request_fault_panel_step\` CHECK (((\`panel_type\` = 'STEP_NEW_FAULT') AND (\`step_id\` IS NOT NULL)) OR ((\`panel_type\` <> 'STEP_NEW_FAULT') AND (\`step_id\` IS NULL))),
        CONSTRAINT \`chk_repair_request_fault_panel_phase\` CHECK (\`phase_code\` IS NULL OR \`phase_code\` IN ('PHASE_01', 'PHASE_02', 'PHASE_03', 'PHASE_04', 'PHASE_05', 'PHASE_06', 'PHASE_07', 'PHASE_08', 'PHASE_09', 'PHASE_10')),
        CONSTRAINT \`chk_repair_request_fault_panel_description\` CHECK (CHAR_LENGTH(TRIM(\`description\`)) > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='工单故障面板';
    `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `repair_request_fault_panel`;');
    await queryRunner.query('DROP TABLE IF EXISTS `repair_request_diagnostic_step`;');
    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        DROP FOREIGN KEY \`fk_repair_request_maintenance_attachment\`,
        DROP INDEX \`uk_repair_request_maintenance_attachment\`,
        DROP CHECK \`chk_repair_request_maintenance_reset_result\`,
        DROP CHECK \`chk_repair_request_maintenance_version\`,
        DROP COLUMN \`maintenance_attachment_file_id\`,
        DROP COLUMN \`maintenance_version_no\`,
        DROP COLUMN \`supplementary_note\`,
        DROP COLUMN \`reset_result\`,
        DROP COLUMN \`maintenance_engineer_name_snapshot\`,
        DROP COLUMN \`maintenance_date\`
    `);
  }

  private async executeStep(queryRunner: QueryRunner, step: string, sql: string): Promise<void> {
    try {
      await queryRunner.query(sql);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 48 条迁移失败于「${step}」；重跑前会由半迁移预检拦截，请人工核对已生效对象。原因：${reason}`,
        { cause: error },
      );
    }
  }

  /**
   * 半迁移保护：任一目标对象已存在即失败关闭，禁止盲目重跑。
   */
  private async assertPreparation(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['repair_request', 'stored_file']) {
      if (!(await queryRunner.hasTable(table))) {
        throw new Error(`迁移前置表缺失：${table}`);
      }
    }
    for (const column of REPAIR_REQUEST_NEW_COLUMNS) {
      if (await queryRunner.hasColumn('repair_request', column)) {
        throw new Error(`检测到半迁移状态：repair_request.${column} 已存在，请人工核对后处理`);
      }
    }
    for (const table of NEW_TABLES) {
      if (await queryRunner.hasTable(table)) {
        throw new Error(`检测到半迁移状态：${table} 已存在，请人工核对后处理`);
      }
    }
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 统一维修报告根表 + 初始八项报警（工作态）+ 排查步骤（工作态）。
 * 纯新增表，无存量回填。
 */
export class CreateMaintenanceReportAndContent1775401200000 implements MigrationInterface {
  name = 'CreateMaintenanceReportAndContent1775401200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`maintenance_report\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '报告主键ID',
        \`owner_organization_id\` int NOT NULL COMMENT '所属组织ID（组织隔离唯一真实落点）',
        \`source_type\` varchar(32) NOT NULL COMMENT '来源：HISTORICAL_CASE=历史案例；WORK_ORDER_SUMMARY=工单总结',
        \`repair_request_id\` int DEFAULT NULL COMMENT '关联工单ID；工单总结必填，历史案例为空',
        \`title\` varchar(200) DEFAULT NULL COMMENT '标题；草稿可空，提交前必填',
        \`customer_factory_name\` varchar(100) DEFAULT NULL COMMENT '客户厂家（手填，不作为权限来源）',
        \`equipment_model_id\` int DEFAULT NULL COMMENT '设备型号ID（全局型号库）',
        \`equipment_model_text\` varchar(100) DEFAULT NULL COMMENT '型号文字快照；与型号ID互斥',
        \`maintenance_date\` date DEFAULT NULL COMMENT '维修业务日期；不默认今天',
        \`maintenance_engineer_account_id\` int NOT NULL COMMENT '负责工程师账号ID',
        \`maintenance_engineer_name_snapshot\` varchar(50) NOT NULL COMMENT '负责工程师姓名快照',
        \`phase_flow_version\` smallint unsigned NOT NULL DEFAULT '1' COMMENT '阶段流程版本',
        \`status\` varchar(16) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT/PENDING_REVIEW/RETURNED/APPROVED',
        \`current_version_no\` int unsigned NOT NULL DEFAULT '0' COMMENT '最近冻结版本号',
        \`last_submitted_at\` timestamp(3) NULL DEFAULT NULL COMMENT '最近提交事件时间',
        \`last_reviewed_at\` timestamp(3) NULL DEFAULT NULL COMMENT '最近一次通过/退回的审核事件时间；退回后重提进入 PENDING_REVIEW 时清空',
        \`ai_usage\` varchar(16) NOT NULL DEFAULT 'NOT_USED' COMMENT 'AI 使用标记：USED/NOT_USED',
        \`ai_source_type\` varchar(64) DEFAULT NULL COMMENT '分析结果来源命名空间（正式实现接入后确定取值）',
        \`ai_source_id\` varchar(128) DEFAULT NULL COMMENT '分析结果稳定标识',
        \`ai_source_version\` varchar(64) DEFAULT NULL COMMENT '分析结果不可变版本/内容摘要',
        \`ai_score\` tinyint unsigned DEFAULT NULL COMMENT 'AI 评分 1-5；不适用为空',
        \`ai_correctness\` varchar(16) DEFAULT NULL COMMENT 'AI 正确性：CORRECT/PARTIAL/INCORRECT',
        \`ai_helpfulness\` tinyint unsigned DEFAULT NULL COMMENT 'AI 帮助程度 1-5；不适用为空',
        \`ai_note\` varchar(2000) DEFAULT NULL COMMENT 'AI 文字评价',
        \`created_by_account_id\` int NOT NULL COMMENT '创建人账号ID',
        \`updated_by_account_id\` int NOT NULL COMMENT '最后修改人账号ID',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_maintenance_report_request\` (\`repair_request_id\`),
        UNIQUE KEY \`uk_maintenance_report_id_owner\` (\`id\`, \`owner_organization_id\`),
        KEY \`idx_maintenance_report_owner_status_created\` (\`owner_organization_id\`, \`status\`, \`created_at\`),
        KEY \`idx_maintenance_report_engineer_created\` (\`maintenance_engineer_account_id\`, \`created_at\`),
        KEY \`idx_maintenance_report_source_created\` (\`source_type\`, \`created_at\`),
        CONSTRAINT \`fk_maintenance_report_owner_organization\` FOREIGN KEY (\`owner_organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_repair_request\` FOREIGN KEY (\`repair_request_id\`) REFERENCES \`repair_request\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_equipment_model\` FOREIGN KEY (\`equipment_model_id\`) REFERENCES \`equipment_model\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_engineer_account\` FOREIGN KEY (\`maintenance_engineer_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_created_by\` FOREIGN KEY (\`created_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_updated_by\` FOREIGN KEY (\`updated_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_maintenance_report_source\` CHECK (\`source_type\` IN ('HISTORICAL_CASE', 'WORK_ORDER_SUMMARY')),
        CONSTRAINT \`chk_maintenance_report_request_source\` CHECK (
          (\`source_type\` = 'WORK_ORDER_SUMMARY' AND \`repair_request_id\` IS NOT NULL)
          OR (\`source_type\` = 'HISTORICAL_CASE' AND \`repair_request_id\` IS NULL)
        ),
        CONSTRAINT \`chk_maintenance_report_status\` CHECK (\`status\` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'APPROVED')),
        CONSTRAINT \`chk_maintenance_report_status_consistency\` CHECK (
          (\`status\` = 'DRAFT' AND \`current_version_no\` = 0 AND \`last_submitted_at\` IS NULL AND \`last_reviewed_at\` IS NULL)
          OR (\`status\` = 'PENDING_REVIEW' AND \`current_version_no\` >= 1 AND \`last_submitted_at\` IS NOT NULL AND \`last_reviewed_at\` IS NULL)
          OR (\`status\` IN ('RETURNED', 'APPROVED') AND \`current_version_no\` >= 1 AND \`last_submitted_at\` IS NOT NULL AND \`last_reviewed_at\` IS NOT NULL)
        ),
        CONSTRAINT \`chk_maintenance_report_model_exclusive\` CHECK (
          \`equipment_model_id\` IS NULL OR \`equipment_model_text\` IS NULL
        ),
        CONSTRAINT \`chk_maintenance_report_phase_flow\` CHECK (\`phase_flow_version\` >= 1),
        CONSTRAINT \`chk_maintenance_report_ai_usage\` CHECK (
          (\`ai_usage\` = 'NOT_USED' AND \`ai_source_type\` IS NULL AND \`ai_source_id\` IS NULL AND \`ai_source_version\` IS NULL
            AND \`ai_score\` IS NULL AND \`ai_correctness\` IS NULL AND \`ai_helpfulness\` IS NULL AND \`ai_note\` IS NULL)
          OR (\`ai_usage\` = 'USED' AND \`ai_source_type\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`ai_source_type\`)) > 0
            AND \`ai_source_id\` IS NOT NULL AND \`ai_source_version\` IS NOT NULL)
        ),
        CONSTRAINT \`chk_maintenance_report_ai_score\` CHECK (\`ai_score\` IS NULL OR \`ai_score\` BETWEEN 1 AND 5),
        CONSTRAINT \`chk_maintenance_report_ai_helpfulness\` CHECK (\`ai_helpfulness\` IS NULL OR \`ai_helpfulness\` BETWEEN 1 AND 5),
        CONSTRAINT \`chk_maintenance_report_ai_correctness\` CHECK (\`ai_correctness\` IS NULL OR \`ai_correctness\` IN ('CORRECT', 'PARTIAL', 'INCORRECT'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='统一维修报告根表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`maintenance_report_alarm\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '报警项主键ID',
        \`report_id\` int NOT NULL COMMENT '所属报告ID',
        \`alarm_index\` tinyint unsigned NOT NULL COMMENT '固定槽位 1-8',
        \`alarm_code\` varchar(100) NOT NULL COMMENT '报警代码原文（保留大小写与前导零）',
        \`alarm_description\` varchar(500) DEFAULT NULL COMMENT '报警说明',
        \`phase_code\` varchar(32) NOT NULL COMMENT '稳定阶段编码',
        \`reset_result\` varchar(16) NOT NULL COMMENT '复位结果：RESET_OK/RESET_FAILED/NOT_ATTEMPTED',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_maintenance_report_alarm_slot\` (\`report_id\`, \`alarm_index\`),
        KEY \`idx_maintenance_report_alarm_code\` (\`alarm_code\`),
        CONSTRAINT \`fk_maintenance_report_alarm_report\` FOREIGN KEY (\`report_id\`) REFERENCES \`maintenance_report\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_maintenance_report_alarm_index\` CHECK (\`alarm_index\` BETWEEN 1 AND 8),
        CONSTRAINT \`chk_maintenance_report_alarm_code\` CHECK (CHAR_LENGTH(TRIM(\`alarm_code\`)) > 0),
        CONSTRAINT \`chk_maintenance_report_alarm_phase\` CHECK (\`phase_code\` IN ('PHASE_01','PHASE_02','PHASE_03','PHASE_04','PHASE_05','PHASE_06','PHASE_07','PHASE_08','PHASE_09','PHASE_10')),
        CONSTRAINT \`chk_maintenance_report_alarm_reset\` CHECK (\`reset_result\` IN ('RESET_OK', 'RESET_FAILED', 'NOT_ATTEMPTED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='维修报告初始八项报警表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`maintenance_report_step\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '排查步骤主键ID',
        \`report_id\` int NOT NULL COMMENT '所属报告ID',
        \`step_no\` smallint unsigned NOT NULL COMMENT '顺序号；从 1 连续',
        \`step_code\` varchar(64) NOT NULL COMMENT '步骤稳定编码',
        \`phase_code\` varchar(32) NOT NULL COMMENT '稳定阶段编码',
        \`part_name\` varchar(100) DEFAULT NULL COMMENT '零件/部位',
        \`action_text\` text NOT NULL COMMENT '动作',
        \`result_text\` varchar(2000) DEFAULT NULL COMMENT '结果',
        \`new_alarm_code\` varchar(100) DEFAULT NULL COMMENT '新故障分支对应报警代码原文',
        \`is_valid_new_branch\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '有效新故障分支标记',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_maintenance_report_step_no\` (\`report_id\`, \`step_no\`),
        UNIQUE KEY \`uk_maintenance_report_step_code\` (\`report_id\`, \`step_code\`),
        KEY \`idx_maintenance_report_step_phase\` (\`report_id\`, \`phase_code\`),
        CONSTRAINT \`fk_maintenance_report_step_report\` FOREIGN KEY (\`report_id\`) REFERENCES \`maintenance_report\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_maintenance_report_step_no\` CHECK (\`step_no\` >= 1),
        CONSTRAINT \`chk_maintenance_report_step_code\` CHECK (CHAR_LENGTH(TRIM(\`step_code\`)) > 0),
        CONSTRAINT \`chk_maintenance_report_step_action\` CHECK (CHAR_LENGTH(TRIM(\`action_text\`)) > 0),
        CONSTRAINT \`chk_maintenance_report_step_phase\` CHECK (\`phase_code\` IN ('PHASE_01','PHASE_02','PHASE_03','PHASE_04','PHASE_05','PHASE_06','PHASE_07','PHASE_08','PHASE_09','PHASE_10')),
        CONSTRAINT \`chk_maintenance_report_step_branch\` CHECK (\`is_valid_new_branch\` IN (0, 1) AND (\`is_valid_new_branch\` = 0 OR \`new_alarm_code\` IS NOT NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='维修报告排查步骤（工作态）表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `maintenance_report_step`;');
    await queryRunner.query('DROP TABLE `maintenance_report_alarm`;');
    await queryRunner.query('DROP TABLE `maintenance_report`;');
  }
}

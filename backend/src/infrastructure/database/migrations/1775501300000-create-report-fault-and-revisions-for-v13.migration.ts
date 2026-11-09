import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V13 报告故障分支、工单管理修订、资料生效修订。
 *
 * 修订正文以 JSON 快照保存；资料修订的格式版本写在 JSON 内部，不额外增加版本列（OI-02）。
 */
export class CreateReportFaultAndRevisionsForV131775501300000 implements MigrationInterface {
  name = 'CreateReportFaultAndRevisionsForV131775501300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`maintenance_report_fault\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '故障ID',
        \`report_id\` int NOT NULL COMMENT '所属报告ID',
        \`fault_uuid\` char(36) NOT NULL COMMENT '报告内稳定故障标识',
        \`branch_kind\` varchar(32) NOT NULL COMMENT 'INITIAL_PANEL/NEW_FAULT_BRANCH/STEP_NEW_FAULT',
        \`step_code\` varchar(64) DEFAULT NULL COMMENT 'STEP_NEW_FAULT 关联的报告内步骤编号',
        \`panel_snapshot\` longtext DEFAULT NULL COMMENT '发生时的实际故障面板快照',
        \`fault_description\` text NOT NULL COMMENT '故障现象描述',
        \`fault_cause\` text DEFAULT NULL COMMENT '故障原因判断',
        \`handling_action\` longtext DEFAULT NULL COMMENT '对应处理动作',
        \`status\` varchar(16) NOT NULL COMMENT 'OPEN/IN_PROGRESS/RESOLVED',
        \`source\` varchar(16) NOT NULL COMMENT 'USER/ADMIN/SYSTEM',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '系统保存时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_maintenance_report_fault_uuid\` (\`fault_uuid\`),
        KEY \`idx_maintenance_report_fault_report\` (\`report_id\`, \`branch_kind\`),
        CONSTRAINT \`fk_maintenance_report_fault_report\` FOREIGN KEY (\`report_id\`) REFERENCES \`maintenance_report\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_fault_step\`
          FOREIGN KEY (\`report_id\`, \`step_code\`)
          REFERENCES \`maintenance_report_step\` (\`report_id\`, \`step_code\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_maintenance_report_fault_branch\` CHECK (
          \`branch_kind\` IN ('INITIAL_PANEL', 'NEW_FAULT_BRANCH', 'STEP_NEW_FAULT')
        ),
        CONSTRAINT \`chk_maintenance_report_fault_step\` CHECK (
          (\`branch_kind\` = 'STEP_NEW_FAULT' AND \`step_code\` IS NOT NULL)
          OR (\`branch_kind\` <> 'STEP_NEW_FAULT' AND \`step_code\` IS NULL)
        ),
        CONSTRAINT \`chk_maintenance_report_fault_description\` CHECK (CHAR_LENGTH(TRIM(\`fault_description\`)) > 0),
        CONSTRAINT \`chk_maintenance_report_fault_status\` CHECK (\`status\` IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
        CONSTRAINT \`chk_maintenance_report_fault_source\` CHECK (\`source\` IN ('USER', 'ADMIN', 'SYSTEM'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='报告故障分支表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`repair_request_revision\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '修订ID',
        \`request_id\` int NOT NULL COMMENT '所属工单ID',
        \`revision_no\` int unsigned NOT NULL COMMENT '生效修订号；从 1 递增',
        \`before_snapshot\` longtext NOT NULL COMMENT '修订前完整快照 JSON',
        \`after_snapshot\` longtext NOT NULL COMMENT '修订后完整快照 JSON',
        \`schema_version\` int unsigned NOT NULL COMMENT '快照格式版本；与 JSON 内同值',
        \`actor_account_id\` int NOT NULL COMMENT '实际修订人账号ID',
        \`reason\` text NOT NULL COMMENT '修订原因',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '保存时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_repair_request_revision_no\` (\`request_id\`, \`revision_no\`),
        CONSTRAINT \`fk_repair_request_revision_request\` FOREIGN KEY (\`request_id\`) REFERENCES \`repair_request\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_request_revision_actor\` FOREIGN KEY (\`actor_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_repair_request_revision_no\` CHECK (\`revision_no\` >= 1),
        CONSTRAINT \`chk_repair_request_revision_schema\` CHECK (
          \`schema_version\` >= 1
          AND JSON_VALID(\`before_snapshot\`) AND JSON_VALID(\`after_snapshot\`)
          AND JSON_EXTRACT(\`before_snapshot\`, '$.schema_version') = \`schema_version\`
          AND JSON_EXTRACT(\`after_snapshot\`, '$.schema_version') = \`schema_version\`
        ),
        CONSTRAINT \`chk_repair_request_revision_reason\` CHECK (CHAR_LENGTH(TRIM(\`reason\`)) > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='工单管理修订表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`reference_document_revision\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '资料修订ID',
        \`document_id\` int NOT NULL COMMENT '所属资料ID',
        \`revision_no\` int unsigned NOT NULL COMMENT '生效修订号；从 1 递增',
        \`before_snapshot\` longtext NOT NULL COMMENT '修订前完整快照 JSON；含 schema_version',
        \`after_snapshot\` longtext NOT NULL COMMENT '修订后完整快照 JSON；含 schema_version',
        \`actor_account_id\` int NOT NULL COMMENT '实际修订人账号ID',
        \`reason\` text NOT NULL COMMENT '修订原因',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '保存时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_reference_document_revision_no\` (\`document_id\`, \`revision_no\`),
        CONSTRAINT \`fk_reference_document_revision_document\` FOREIGN KEY (\`document_id\`) REFERENCES \`reference_document\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_reference_document_revision_actor\` FOREIGN KEY (\`actor_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_reference_document_revision_no\` CHECK (\`revision_no\` >= 1),
        CONSTRAINT \`chk_reference_document_revision_schema\` CHECK (
          JSON_VALID(\`before_snapshot\`) AND JSON_VALID(\`after_snapshot\`)
          AND JSON_EXTRACT(\`before_snapshot\`, '$.schema_version') IS NOT NULL
          AND JSON_EXTRACT(\`after_snapshot\`, '$.schema_version') IS NOT NULL
        ),
        CONSTRAINT \`chk_reference_document_revision_reason\` CHECK (CHAR_LENGTH(TRIM(\`reason\`)) > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='资料生效修订表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `reference_document_revision`;');
    await queryRunner.query('DROP TABLE `repair_request_revision`;');
    await queryRunner.query('DROP TABLE `maintenance_report_fault`;');
  }
}

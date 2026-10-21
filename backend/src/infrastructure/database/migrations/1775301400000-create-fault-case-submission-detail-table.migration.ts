import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFaultCaseSubmissionDetailTable1775301400000 implements MigrationInterface {
  name = 'CreateFaultCaseSubmissionDetailTable1775301400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`fault_case_submission_detail\` (
        \`submission_id\` int NOT NULL COMMENT '投稿ID（主键即投稿外键）',
        \`title\` varchar(255) DEFAULT NULL COMMENT '案例标题',
        \`equipment_model_id\` int DEFAULT NULL COMMENT '适用设备型号ID；与机型文字互斥',
        \`equipment_model_text\` varchar(100) DEFAULT NULL COMMENT '机型文字（用户手填）；与机型ID互斥',
        \`error_code\` varchar(100) DEFAULT NULL COMMENT '设备错误码；保留大小写与内部符号',
        \`phenomenon\` varchar(2000) DEFAULT NULL COMMENT '故障现象',
        \`condition_text\` varchar(2000) DEFAULT NULL COMMENT '触发条件',
        \`reproduction_steps\` text DEFAULT NULL COMMENT '复现步骤',
        \`diagnosis\` text DEFAULT NULL COMMENT '排查过程',
        \`action_taken\` text DEFAULT NULL COMMENT '处理措施',
        \`handling_status\` varchar(32) DEFAULT NULL COMMENT '处理状态：UNRESOLVED/IN_PROGRESS/RESOLVED',
        \`resolution\` varchar(2000) DEFAULT NULL COMMENT '处理结果；已解决时必填',
        \`extension_json\` json DEFAULT NULL COMMENT '按 schema_version 校验的补充属性',
        \`schema_version\` smallint unsigned NOT NULL DEFAULT '1' COMMENT '明细 schema 版本',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（系统事件时间）',
        PRIMARY KEY (\`submission_id\`),
        KEY \`idx_fault_case_submission_detail_equipment_model\` (\`equipment_model_id\`),
        CONSTRAINT \`fk_fault_case_submission_detail_submission\` FOREIGN KEY (\`submission_id\`) REFERENCES \`content_submission\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_fault_case_submission_detail_equipment_model\` FOREIGN KEY (\`equipment_model_id\`) REFERENCES \`equipment_model\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_fault_case_submission_detail_model_exclusive\` CHECK (\`equipment_model_id\` IS NULL OR \`equipment_model_text\` IS NULL),
        CONSTRAINT \`chk_fault_case_submission_detail_handling_status\` CHECK (
          \`handling_status\` IS NULL OR \`handling_status\` IN ('UNRESOLVED', 'IN_PROGRESS', 'RESOLVED')
        ),
        CONSTRAINT \`chk_fault_case_submission_detail_resolution\` CHECK (
          \`handling_status\` IS NULL OR \`handling_status\` <> 'RESOLVED'
          OR (\`resolution\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`resolution\`)) > 0)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='故障案例投稿明细表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `fault_case_submission_detail`;');
  }
}

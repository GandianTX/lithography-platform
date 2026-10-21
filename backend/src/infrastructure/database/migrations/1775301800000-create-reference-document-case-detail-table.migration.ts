import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReferenceDocumentCaseDetailTable1775301800000 implements MigrationInterface {
  name = 'CreateReferenceDocumentCaseDetailTable1775301800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`reference_document_case_detail\` (
        \`document_id\` int NOT NULL COMMENT '正式资料ID（主键即资料外键）',
        \`error_code\` varchar(100) DEFAULT NULL COMMENT '设备错误码；保留大小写与内部符号',
        \`handling_status\` varchar(32) NOT NULL COMMENT '处理状态：UNRESOLVED/IN_PROGRESS/RESOLVED',
        \`phenomenon\` varchar(2000) NOT NULL COMMENT '故障现象',
        \`condition_text\` varchar(2000) DEFAULT NULL COMMENT '触发条件',
        \`reproduction_steps\` text NOT NULL COMMENT '复现步骤',
        \`diagnosis\` text DEFAULT NULL COMMENT '排查过程',
        \`action_taken\` text DEFAULT NULL COMMENT '处理措施',
        \`resolution\` varchar(2000) DEFAULT NULL COMMENT '处理结果；已解决时必填',
        \`case_payload_json\` json DEFAULT NULL COMMENT '案例结构化补充快照（按 schema_version 校验）',
        \`schema_version\` smallint unsigned NOT NULL DEFAULT '1' COMMENT '明细 schema 版本',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（系统事件时间）',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（系统事件时间）',
        PRIMARY KEY (\`document_id\`),
        CONSTRAINT \`fk_reference_document_case_detail_document\` FOREIGN KEY (\`document_id\`) REFERENCES \`reference_document\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_reference_document_case_detail_status\` CHECK (\`handling_status\` IN ('UNRESOLVED', 'IN_PROGRESS', 'RESOLVED')),
        CONSTRAINT \`chk_reference_document_case_detail_resolution\` CHECK (
          \`handling_status\` <> 'RESOLVED'
          OR (\`resolution\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`resolution\`)) > 0)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='正式故障案例明细表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `reference_document_case_detail`;');
  }
}

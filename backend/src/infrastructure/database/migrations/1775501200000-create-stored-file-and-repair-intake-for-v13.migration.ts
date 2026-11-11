import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V13 原件目录、报修原始输入、分析尝试、内部过程与 AI 消息分析。
 *
 * 依赖：organization/base_user_account/equipment_model/repair_request/ai_conversation/ai_message
 * 均已由既有迁移建立；本迁移只新增候选表，不修改既有表正文。
 */
export class CreateStoredFileAndRepairIntakeForV131775501200000 implements MigrationInterface {
  name = 'CreateStoredFileAndRepairIntakeForV131775501200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`stored_file\` (
        \`file_id\` char(36) NOT NULL COMMENT '稳定原件编号',
        \`uploaded_by_account_id\` int NOT NULL COMMENT '实际上传者账号ID',
        \`owner_organization_id\` int NOT NULL COMMENT '可信文件归属公司ID',
        \`storage_reference\` varchar(1024) NOT NULL COMMENT '私有存储引用；不存公开直链',
        \`original_filename\` varchar(255) NOT NULL COMMENT '原始文件名',
        \`mime_type\` varchar(255) NOT NULL COMMENT '内容校验后的实际类型',
        \`byte_size\` bigint unsigned NOT NULL COMMENT '精确字节数；0 < 值 <= 20000000',
        \`checksum_sha256\` char(64) NOT NULL COMMENT '文件 SHA-256',
        \`status\` varchar(16) NOT NULL COMMENT 'STAGING/VALID/FAILED',
        \`business_type\` varchar(32) NOT NULL COMMENT '业务引用类型',
        \`business_id\` varchar(64) DEFAULT NULL COMMENT '绑定业务真实ID；暂存为空',
        \`upload_context_id\` char(36) NOT NULL COMMENT '本次上传上下文；服务端生成',
        \`binding_status\` varchar(16) NOT NULL COMMENT 'TEMPORARY/BOUND',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '保存时间',
        \`verified_at\` timestamp(3) NULL DEFAULT NULL COMMENT '完整校验时间；VALID 必有',
        PRIMARY KEY (\`file_id\`),
        UNIQUE KEY \`uk_stored_file_upload_context\` (\`upload_context_id\`),
        KEY \`idx_stored_file_business\` (\`business_type\`, \`business_id\`),
        KEY \`idx_stored_file_owner_created\` (\`owner_organization_id\`, \`created_at\`),
        KEY \`idx_stored_file_status_created\` (\`status\`, \`created_at\`),
        CONSTRAINT \`fk_stored_file_uploader\` FOREIGN KEY (\`uploaded_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_stored_file_owner_organization\` FOREIGN KEY (\`owner_organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_stored_file_size\` CHECK (\`byte_size\` >= 1 AND \`byte_size\` <= 20000000),
        CONSTRAINT \`chk_stored_file_status\` CHECK (\`status\` IN ('STAGING', 'VALID', 'FAILED')),
        CONSTRAINT \`chk_stored_file_binding_status\` CHECK (\`binding_status\` IN ('TEMPORARY', 'BOUND')),
        CONSTRAINT \`chk_stored_file_binding_pair\` CHECK (
          (\`binding_status\` = 'TEMPORARY' AND \`business_id\` IS NULL)
          OR (\`binding_status\` = 'BOUND' AND \`business_id\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`business_id\`)) > 0)
        ),
        CONSTRAINT \`chk_stored_file_verified\` CHECK (\`status\` <> 'VALID' OR \`verified_at\` IS NOT NULL),
        CONSTRAINT \`chk_stored_file_checksum\` CHECK (CHAR_LENGTH(\`checksum_sha256\`) = 64),
        CONSTRAINT \`chk_stored_file_business_type\` CHECK (CHAR_LENGTH(TRIM(\`business_type\`)) > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='统一私有原件登记表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`repair_request_intake\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '报修请求ID',
        \`record_uuid\` char(36) NOT NULL COMMENT '跨端稳定编号',
        \`customer_account_id\` int NOT NULL COMMENT '报修客户账号ID',
        \`customer_organization_id\` int NOT NULL COMMENT '报修时客户可信公司ID',
        \`service_organization_id\` int NOT NULL COMMENT '选定维修公司ID',
        \`equipment_model_id\` int NOT NULL COMMENT '预置机型ID',
        \`error_code\` varchar(100) NOT NULL COMMENT '设备错误代码；保留前导零',
        \`fault_description\` longtext NOT NULL COMMENT '客户原始故障；不超过 5000 字',
        \`file_id\` char(36) DEFAULT NULL COMMENT '报修私有原件',
        \`analysis_status\` varchar(16) NOT NULL COMMENT 'WAITING/RUNNING/SUCCEEDED/FAILED',
        \`analysis_generation\` int unsigned NOT NULL DEFAULT '0' COMMENT '0=初次；1=唯一重试',
        \`converted_request_id\` int DEFAULT NULL COMMENT '转换后的唯一维修工单ID',
        \`deleted_at\` timestamp(3) NULL DEFAULT NULL COMMENT '逻辑删除时间',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '系统创建时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_repair_request_intake_record_uuid\` (\`record_uuid\`),
        UNIQUE KEY \`uk_repair_request_intake_converted\` (\`converted_request_id\`),
        KEY \`idx_repair_request_intake_customer_created\` (\`customer_account_id\`, \`created_at\`),
        KEY \`idx_repair_request_intake_organization_status\` (\`customer_organization_id\`, \`analysis_status\`),
        CONSTRAINT \`fk_repair_request_intake_customer_account\` FOREIGN KEY (\`customer_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_request_intake_customer_organization\` FOREIGN KEY (\`customer_organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_request_intake_service_organization\` FOREIGN KEY (\`service_organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_request_intake_equipment_model\` FOREIGN KEY (\`equipment_model_id\`) REFERENCES \`equipment_model\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_request_intake_file\` FOREIGN KEY (\`file_id\`) REFERENCES \`stored_file\` (\`file_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_request_intake_converted_request\` FOREIGN KEY (\`converted_request_id\`) REFERENCES \`repair_request\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_repair_request_intake_analysis_status\` CHECK (\`analysis_status\` IN ('WAITING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT \`chk_repair_request_intake_generation\` CHECK (\`analysis_generation\` IN (0, 1)),
        CONSTRAINT \`chk_repair_request_intake_description\` CHECK (CHAR_LENGTH(\`fault_description\`) <= 5000)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='报修原始输入表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`intake_analysis_attempt\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '分析尝试ID',
        \`intake_id\` int NOT NULL COMMENT '原报修ID',
        \`generation_no\` int unsigned NOT NULL COMMENT '0=初次；1=唯一重试',
        \`status\` varchar(16) NOT NULL COMMENT 'RUNNING/SUCCEEDED/FAILED',
        \`output_text\` longtext DEFAULT NULL COMMENT '真实模型输出原文',
        \`failure_reason\` text DEFAULT NULL COMMENT '实际失败原因',
        \`provider_call_id\` int DEFAULT NULL COMMENT '模型调用追溯ID',
        \`started_at\` timestamp(3) NULL DEFAULT NULL COMMENT '实际开始时间',
        \`finished_at\` timestamp(3) NULL DEFAULT NULL COMMENT '实际结束时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_intake_analysis_attempt_generation\` (\`intake_id\`, \`generation_no\`),
        CONSTRAINT \`fk_intake_analysis_attempt_intake\` FOREIGN KEY (\`intake_id\`) REFERENCES \`repair_request_intake\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_intake_analysis_attempt_provider_call\` FOREIGN KEY (\`provider_call_id\`) REFERENCES \`ai_provider_call_record\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_intake_analysis_attempt_generation\` CHECK (\`generation_no\` IN (0, 1)),
        CONSTRAINT \`chk_intake_analysis_attempt_status\` CHECK (\`status\` IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT \`chk_intake_analysis_attempt_failure\` CHECK (
          \`status\` <> 'FAILED' OR (\`failure_reason\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`failure_reason\`)) > 0)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='报修分析尝试表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`repair_process_entry\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '过程ID',
        \`entry_uuid\` char(36) NOT NULL COMMENT '稳定记录编号',
        \`request_id\` int NOT NULL COMMENT '所属工单ID',
        \`author_account_id\` int NOT NULL COMMENT '实际记录人账号ID',
        \`operation_text\` longtext NOT NULL COMMENT '人工执行操作',
        \`test_result\` longtext DEFAULT NULL COMMENT '实际测试事实',
        \`occurred_at\` datetime DEFAULT NULL COMMENT '业务现场事件时间',
        \`time_source\` varchar(32) NOT NULL COMMENT '人工或系统时间来源',
        \`file_id\` char(36) DEFAULT NULL COMMENT '内部私有原件',
        \`version_no\` int unsigned NOT NULL COMMENT '过程修改版本',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '系统保存时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_repair_process_entry_uuid\` (\`entry_uuid\`),
        KEY \`idx_repair_process_entry_request_created\` (\`request_id\`, \`created_at\`),
        CONSTRAINT \`fk_repair_process_entry_request\` FOREIGN KEY (\`request_id\`) REFERENCES \`repair_request\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_process_entry_author\` FOREIGN KEY (\`author_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_repair_process_entry_file\` FOREIGN KEY (\`file_id\`) REFERENCES \`stored_file\` (\`file_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_repair_process_entry_operation\` CHECK (CHAR_LENGTH(TRIM(\`operation_text\`)) > 0),
        CONSTRAINT \`chk_repair_process_entry_version\` CHECK (\`version_no\` >= 1),
        CONSTRAINT \`chk_repair_process_entry_time_source\` CHECK (CHAR_LENGTH(TRIM(\`time_source\`)) > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='工单内部维修过程表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`ai_message_analysis\` (
        \`question_uuid\` char(36) NOT NULL COMMENT '问题请求稳定标识',
        \`conversation_id\` int NOT NULL COMMENT '固定会话ID',
        \`question_message_id\` int NOT NULL COMMENT '原问题消息ID',
        \`answer_message_id\` int DEFAULT NULL COMMENT '实际回答消息ID',
        \`status\` varchar(16) NOT NULL COMMENT 'PENDING/RUNNING/SUCCEEDED/FAILED',
        \`failure_reason\` text DEFAULT NULL COMMENT '真实失败原因',
        \`content_version\` int unsigned NOT NULL COMMENT '已保存内容版本',
        \`saved_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '持久保存时间',
        \`completed_at\` timestamp(3) NULL DEFAULT NULL COMMENT '实际完成时间',
        PRIMARY KEY (\`question_uuid\`),
        UNIQUE KEY \`uk_ai_message_analysis_question\` (\`question_message_id\`),
        KEY \`idx_ai_message_analysis_conversation_status\` (\`conversation_id\`, \`status\`),
        CONSTRAINT \`fk_ai_message_analysis_conversation\` FOREIGN KEY (\`conversation_id\`) REFERENCES \`ai_conversation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_ai_message_analysis_question_message\` FOREIGN KEY (\`question_message_id\`) REFERENCES \`ai_message\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_ai_message_analysis_answer_message\` FOREIGN KEY (\`answer_message_id\`) REFERENCES \`ai_message\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_ai_message_analysis_status\` CHECK (\`status\` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT \`chk_ai_message_analysis_failure\` CHECK (
          \`status\` <> 'FAILED' OR (\`failure_reason\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`failure_reason\`)) > 0)
        ),
        CONSTRAINT \`chk_ai_message_analysis_content_version\` CHECK (\`content_version\` >= 1),
        CONSTRAINT \`chk_ai_message_analysis_completed\` CHECK (
          \`status\` IN ('PENDING', 'RUNNING') OR \`completed_at\` IS NOT NULL
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='AI 消息分析结果表';
    `);

    // 循环引用分两步建立：先让 intake 引用 repair_request，再回填 repair_request.intake_id 外键。
    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        ADD CONSTRAINT \`fk_repair_request_intake\`
          FOREIGN KEY (\`intake_id\`) REFERENCES \`repair_request_intake\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`repair_request\` DROP CONSTRAINT \`fk_repair_request_intake\`;
    `);
    await queryRunner.query('DROP TABLE `ai_message_analysis`;');
    await queryRunner.query('DROP TABLE `repair_process_entry`;');
    await queryRunner.query('DROP TABLE `intake_analysis_attempt`;');
    await queryRunner.query('DROP TABLE `repair_request_intake`;');
    await queryRunner.query('DROP TABLE `stored_file`;');
  }
}

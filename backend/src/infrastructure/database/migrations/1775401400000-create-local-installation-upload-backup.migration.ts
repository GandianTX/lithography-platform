import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 本地部署身份、单向上传任务与备份运行清单（最小数据契约）。
 * 不复制云端业务主键；不写组织映射；不设计自动清理。
 */
export class CreateLocalInstallationUploadBackup1775401400000 implements MigrationInterface {
  name = 'CreateLocalInstallationUploadBackup1775401400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`local_installation\` (
        \`id\` tinyint unsigned NOT NULL DEFAULT '1' COMMENT '单例行，恒为 1',
        \`installation_id\` char(36) NOT NULL COMMENT '稳定安装标识（UUID），本地来源标识',
        \`organization_id\` int DEFAULT NULL COMMENT '云端组织映射；未映射为空',
        \`organization_code_snapshot\` varchar(64) DEFAULT NULL COMMENT '映射时组织编码留痕',
        \`local_site_name\` varchar(100) DEFAULT NULL COMMENT '现场名称',
        \`auto_upload_enabled\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '自动上传开关；默认关闭',
        \`backup_interval_days\` smallint unsigned NOT NULL DEFAULT '3' COMMENT '自动备份间隔天数',
        \`last_backup_completed_at\` timestamp(3) NULL DEFAULT NULL COMMENT '最近成功备份完成时间',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_local_installation_installation_id\` (\`installation_id\`),
        KEY \`idx_local_installation_organization\` (\`organization_id\`),
        CONSTRAINT \`fk_local_installation_organization\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_local_installation_singleton\` CHECK (\`id\` = 1),
        CONSTRAINT \`chk_local_installation_interval\` CHECK (\`backup_interval_days\` >= 1)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='本地部署身份与设置（单行）表';
    `);

    await queryRunner.query(`
      INSERT INTO \`local_installation\` (\`id\`, \`installation_id\`, \`auto_upload_enabled\`, \`backup_interval_days\`)
      VALUES (1, UUID(), 0, 3)
      ON DUPLICATE KEY UPDATE \`id\` = \`id\`;
    `);

    await queryRunner.query(`
      CREATE TABLE \`local_upload_task\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '上传任务主键ID',
        \`installation_id\` char(36) NOT NULL COMMENT '本地安装标识',
        \`entity_type\` varchar(32) NOT NULL COMMENT 'REPORT_VERSION/ATTACHMENT/BACKUP_MANIFEST',
        \`entity_local_id\` int unsigned NOT NULL COMMENT '本地实体ID（仅本地语义）',
        \`entity_version\` varchar(64) NOT NULL COMMENT '版本号或内容摘要',
        \`idempotency_key\` varchar(191) NOT NULL COMMENT '幂等键',
        \`status\` varchar(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/UPLOADING/SUCCEEDED/FAILED/CANCELLED',
        \`attempt_count\` smallint unsigned NOT NULL DEFAULT '0' COMMENT '尝试次数',
        \`last_attempt_at\` timestamp(3) NULL DEFAULT NULL COMMENT '最近尝试时间',
        \`remote_id\` varchar(128) DEFAULT NULL COMMENT '云端返回标识（不反写业务主键）',
        \`remote_receipt\` varchar(512) DEFAULT NULL COMMENT '回执/摘要',
        \`error_code\` varchar(64) DEFAULT NULL COMMENT '失败错误码',
        \`error_message\` varchar(1000) DEFAULT NULL COMMENT '失败说明；不含凭据',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_local_upload_task_idempotency\` (\`idempotency_key\`),
        UNIQUE KEY \`uk_local_upload_task_entity\` (\`installation_id\`, \`entity_type\`, \`entity_local_id\`, \`entity_version\`),
        KEY \`idx_local_upload_task_status_created\` (\`status\`, \`created_at\`),
        CONSTRAINT \`fk_local_upload_task_installation\` FOREIGN KEY (\`installation_id\`) REFERENCES \`local_installation\` (\`installation_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_local_upload_task_entity_type\` CHECK (\`entity_type\` IN ('REPORT_VERSION', 'ATTACHMENT', 'BACKUP_MANIFEST')),
        CONSTRAINT \`chk_local_upload_task_status\` CHECK (\`status\` IN ('PENDING', 'UPLOADING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
        CONSTRAINT \`chk_local_upload_task_attempt\` CHECK (\`attempt_count\` >= 0),
        CONSTRAINT \`chk_local_upload_task_version\` CHECK (CHAR_LENGTH(TRIM(\`entity_version\`)) > 0),
        CONSTRAINT \`chk_local_upload_task_idempotency\` CHECK (CHAR_LENGTH(TRIM(\`idempotency_key\`)) > 0),
        CONSTRAINT \`chk_local_upload_task_error\` CHECK (
          \`status\` <> 'FAILED' OR (\`error_code\` IS NOT NULL AND \`error_message\` IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='本地上传任务（幂等/回执）表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`local_backup_run\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '备份运行主键ID',
        \`installation_id\` char(36) NOT NULL COMMENT '本地安装标识',
        \`trigger_type\` varchar(16) NOT NULL COMMENT 'SCHEDULED/MANUAL/USB_EXPORT',
        \`status\` varchar(16) NOT NULL DEFAULT 'RUNNING' COMMENT 'RUNNING/SUCCEEDED/FAILED/INTERRUPTED',
        \`active_installation_id\` char(36) GENERATED ALWAYS AS (
          IF(\`status\` = 'RUNNING', \`installation_id\`, NULL)
        ) STORED COMMENT '运行中备份唯一锚点；非 RUNNING 为 NULL',
        \`started_at\` timestamp(3) NOT NULL COMMENT '开始时间',
        \`finished_at\` timestamp(3) NULL DEFAULT NULL COMMENT '结束时间；非 RUNNING 必填',
        \`manifest_path\` varchar(512) DEFAULT NULL COMMENT '清单文件位置',
        \`manifest_checksum\` char(64) DEFAULT NULL COMMENT '清单 SHA-256',
        \`byte_size\` bigint unsigned DEFAULT NULL COMMENT '备份总字节数',
        \`attachment_count\` int unsigned DEFAULT NULL COMMENT '附件条目数',
        \`schema_version\` smallint unsigned DEFAULT NULL COMMENT '备份时结构版本/迁移号',
        \`error_code\` varchar(64) DEFAULT NULL COMMENT '失败错误码',
        \`error_message\` varchar(1000) DEFAULT NULL COMMENT '失败说明；不含凭据',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_local_backup_run_active\` (\`active_installation_id\`),
        KEY \`idx_local_backup_run_started\` (\`started_at\`),
        CONSTRAINT \`fk_local_backup_run_installation\` FOREIGN KEY (\`installation_id\`) REFERENCES \`local_installation\` (\`installation_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_local_backup_run_trigger\` CHECK (\`trigger_type\` IN ('SCHEDULED', 'MANUAL', 'USB_EXPORT')),
        CONSTRAINT \`chk_local_backup_run_status\` CHECK (\`status\` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')),
        CONSTRAINT \`chk_local_backup_run_finish\` CHECK (
          (\`status\` = 'RUNNING' AND \`finished_at\` IS NULL)
          OR (\`status\` <> 'RUNNING' AND \`finished_at\` IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='本地备份运行清单表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `local_backup_run`;');
    await queryRunner.query('DROP TABLE `local_upload_task`;');
    await queryRunner.query('DROP TABLE `local_installation`;');
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V13 云端备份资产、恢复运行与三类管理审计事件。
 */
export class CreateBackupAndAuditForV131775501500000 implements MigrationInterface {
  name = 'CreateBackupAndAuditForV131775501500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`backup_asset\` (
        \`backup_id\` char(36) NOT NULL COMMENT '备份资产ID',
        \`run_id\` int NOT NULL COMMENT '对应本地备份运行ID',
        \`organization_id\` int NOT NULL COMMENT '公司数据区',
        \`local_cleanup_run_id\` int DEFAULT NULL COMMENT '执行本地清理的备份运行ID',
        \`storage_reference\` varchar(1024) NOT NULL COMMENT '云端私有存储引用',
        \`file_sha256\` char(64) NOT NULL COMMENT '备份文件 SHA-256',
        \`byte_size\` bigint unsigned NOT NULL COMMENT '备份文件字节数',
        \`cloud_status\` varchar(16) NOT NULL COMMENT 'PENDING/UPLOADING/SUCCEEDED/FAILED',
        \`local_status\` varchar(16) NOT NULL COMMENT 'PENDING/CLEANING/CLEANED/FAILED',
        \`cloud_receipt\` text DEFAULT NULL COMMENT '云端回执/摘要；成功后必有',
        \`attempt_count\` int unsigned NOT NULL DEFAULT '0' COMMENT '尝试次数',
        \`last_attempt_at\` timestamp(3) NULL DEFAULT NULL COMMENT '最近尝试时间',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`backup_id\`),
        KEY \`idx_backup_asset_organization_status\` (\`organization_id\`, \`cloud_status\`, \`created_at\`),
        CONSTRAINT \`fk_backup_asset_run\` FOREIGN KEY (\`run_id\`) REFERENCES \`local_backup_run\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_backup_asset_organization\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_backup_asset_cleanup_run\` FOREIGN KEY (\`local_cleanup_run_id\`) REFERENCES \`local_backup_run\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_backup_asset_sha\` CHECK (CHAR_LENGTH(\`file_sha256\`) = 64),
        CONSTRAINT \`chk_backup_asset_size\` CHECK (\`byte_size\` >= 0),
        CONSTRAINT \`chk_backup_asset_cloud_status\`
          CHECK (\`cloud_status\` IN ('PENDING', 'UPLOADING', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT \`chk_backup_asset_local_status\`
          CHECK (\`local_status\` IN ('PENDING', 'CLEANING', 'CLEANED', 'FAILED')),
        CONSTRAINT \`chk_backup_asset_cloud_receipt\` CHECK (
          \`cloud_status\` <> 'SUCCEEDED' OR \`cloud_receipt\` IS NOT NULL
        ),
        CONSTRAINT \`chk_backup_asset_attempts\` CHECK (\`attempt_count\` >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='云端备份资产表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`backup_restore_run\` (
        \`restore_id\` char(36) NOT NULL COMMENT '恢复运行ID',
        \`backup_id\` char(36) NOT NULL COMMENT '被恢复的备份资产ID',
        \`protection_backup_id\` char(36) NOT NULL COMMENT '恢复前保护备份ID',
        \`organization_id\` int NOT NULL COMMENT '恢复目标公司数据区',
        \`started_by_account_id\` int NOT NULL COMMENT '实际发起人账号ID',
        \`status\` varchar(16) NOT NULL COMMENT 'RUNNING/SUCCEEDED/FAILED/INTERRUPTED',
        \`check_snapshot\` longtext NOT NULL COMMENT '恢复前核对结果 JSON；含 schema_version',
        \`restored_scope\` text DEFAULT NULL COMMENT '实际覆盖/恢复范围',
        \`result_summary\` text DEFAULT NULL COMMENT '实际结果摘要',
        \`started_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '开始时间',
        \`finished_at\` timestamp(3) NULL DEFAULT NULL COMMENT '结束时间；非 RUNNING 必填',
        PRIMARY KEY (\`restore_id\`),
        KEY \`idx_backup_restore_run_organization\` (\`organization_id\`, \`started_at\`),
        CONSTRAINT \`fk_backup_restore_run_backup\` FOREIGN KEY (\`backup_id\`) REFERENCES \`backup_asset\` (\`backup_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_backup_restore_run_protection\` FOREIGN KEY (\`protection_backup_id\`) REFERENCES \`backup_asset\` (\`backup_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_backup_restore_run_organization\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_backup_restore_run_actor\` FOREIGN KEY (\`started_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_backup_restore_run_status\`
          CHECK (\`status\` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')),
        CONSTRAINT \`chk_backup_restore_run_finish\` CHECK (
          (\`status\` = 'RUNNING' AND \`finished_at\` IS NULL)
          OR (\`status\` <> 'RUNNING' AND \`finished_at\` IS NOT NULL)
        ),
        CONSTRAINT \`chk_backup_restore_run_protection\` CHECK (\`backup_id\` <> \`protection_backup_id\`),
        CONSTRAINT \`chk_backup_restore_run_schema\` CHECK (
          JSON_VALID(\`check_snapshot\`)
          AND JSON_EXTRACT(\`check_snapshot\`, '$.schema_version') IS NOT NULL
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='备份恢复运行表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`management_audit_event\` (
        \`event_id\` char(36) NOT NULL COMMENT '审计事件ID',
        \`actor_account_id\` int NOT NULL COMMENT '操作人账号ID',
        \`actor_admin_level\` tinyint NOT NULL COMMENT '当时的实际管理员等级',
        \`organization_id\` int DEFAULT NULL COMMENT '作用公司ID',
        \`operation\` varchar(32) NOT NULL COMMENT 'MANAGE_ACCOUNT/ASSIGN_RESOURCE/MANAGE_COMPANY',
        \`target_type\` varchar(32) NOT NULL COMMENT '目标类型',
        \`target_id\` varchar(64) NOT NULL COMMENT '目标真实ID',
        \`result\` varchar(16) NOT NULL COMMENT 'SUCCEEDED/FAILED/DENIED',
        \`detail\` text DEFAULT NULL COMMENT '可展示变更详情；不含凭据',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发生时间',
        PRIMARY KEY (\`event_id\`),
        KEY \`idx_management_audit_actor\` (\`actor_account_id\`, \`created_at\`),
        KEY \`idx_management_audit_organization\` (\`organization_id\`, \`created_at\`),
        KEY \`idx_management_audit_target\` (\`target_type\`, \`target_id\`, \`created_at\`),
        CONSTRAINT \`fk_management_audit_actor\`
          FOREIGN KEY (\`actor_account_id\`) REFERENCES \`base_user_account\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_management_audit_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_management_audit_level\` CHECK (\`actor_admin_level\` IN (1, 2)),
        CONSTRAINT \`chk_management_audit_operation\`
          CHECK (\`operation\` IN ('MANAGE_ACCOUNT', 'ASSIGN_RESOURCE', 'MANAGE_COMPANY')),
        CONSTRAINT \`chk_management_audit_result\`
          CHECK (\`result\` IN ('SUCCEEDED', 'FAILED', 'DENIED')),
        CONSTRAINT \`chk_management_audit_target\`
          CHECK (CHAR_LENGTH(TRIM(\`target_type\`)) > 0 AND CHAR_LENGTH(TRIM(\`target_id\`)) > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='管理审计事件表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `management_audit_event`;');
    await queryRunner.query('DROP TABLE `backup_restore_run`;');
    await queryRunner.query('DROP TABLE `backup_asset`;');
  }
}

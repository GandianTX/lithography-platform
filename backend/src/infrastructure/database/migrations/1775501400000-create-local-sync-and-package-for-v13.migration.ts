import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V13 本机账号授权、同机多公司配置、同步回执/冲突、U 盘记录包。
 */
export class CreateLocalSyncAndPackageForV131775501400000 implements MigrationInterface {
  name = 'CreateLocalSyncAndPackageForV131775501400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`local_account_authorization\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '授权记录ID',
        \`installation_id\` char(36) NOT NULL COMMENT '本机安装标识',
        \`account_id\` int NOT NULL COMMENT '被授权账号ID',
        \`organization_id\` int NOT NULL COMMENT '授权生效公司ID',
        \`authorization_status\` varchar(16) NOT NULL COMMENT 'ACTIVE/REVOKED',
        \`authorized_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '授权时间',
        \`revoked_at\` timestamp(3) NULL DEFAULT NULL COMMENT '撤销时间',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_local_account_authorization_scope\`
          (\`installation_id\`, \`account_id\`, \`organization_id\`),
        KEY \`idx_local_account_authorization_account\` (\`account_id\`, \`authorization_status\`),
        CONSTRAINT \`fk_local_account_authorization_installation\`
          FOREIGN KEY (\`installation_id\`) REFERENCES \`local_installation\` (\`installation_id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_local_account_authorization_account\`
          FOREIGN KEY (\`account_id\`) REFERENCES \`base_user_account\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_local_account_authorization_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_local_account_authorization_status\` CHECK (
          (\`authorization_status\` = 'ACTIVE' AND \`revoked_at\` IS NULL)
          OR (\`authorization_status\` = 'REVOKED' AND \`revoked_at\` IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='本机账号授权表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`local_company_setting\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '配置ID',
        \`installation_id\` char(36) NOT NULL COMMENT '本机安装标识',
        \`organization_id\` int NOT NULL COMMENT '公司ID',
        \`setting_source\` varchar(24) NOT NULL COMMENT 'LOCAL_MANUAL/CLOUD_MAPPING',
        \`is_current\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否当前生效',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_local_company_setting_scope\` (\`installation_id\`, \`organization_id\`),
        CONSTRAINT \`fk_local_company_setting_installation\`
          FOREIGN KEY (\`installation_id\`) REFERENCES \`local_installation\` (\`installation_id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_local_company_setting_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_local_company_setting_source\`
          CHECK (\`setting_source\` IN ('LOCAL_MANUAL', 'CLOUD_MAPPING')),
        CONSTRAINT \`chk_local_company_setting_current\` CHECK (\`is_current\` IN (0, 1))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='同机多公司配置表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`sync_receipt\` (
        \`receipt_id\` char(36) NOT NULL COMMENT '回执ID',
        \`record_uuid\` char(36) NOT NULL COMMENT '业务稳定编号',
        \`organization_id\` int NOT NULL COMMENT '公司数据区',
        \`resource_type\` varchar(32) NOT NULL COMMENT '同步资源类型',
        \`version_no\` int unsigned NOT NULL COMMENT '同步版本号',
        \`source_system\` varchar(16) NOT NULL COMMENT 'LOCAL/CLOUD',
        \`receipt_status\` varchar(16) NOT NULL COMMENT 'PENDING/SUCCEEDED/FAILED/CONFLICT',
        \`manifest_checksum\` char(64) NOT NULL COMMENT '同步清单 SHA-256',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`confirmed_at\` timestamp(3) NULL DEFAULT NULL COMMENT '实际确认时间',
        PRIMARY KEY (\`receipt_id\`),
        UNIQUE KEY \`uk_sync_receipt_scope\`
          (\`record_uuid\`, \`organization_id\`, \`resource_type\`, \`version_no\`, \`source_system\`),
        KEY \`idx_sync_receipt_organization_status\` (\`organization_id\`, \`receipt_status\`, \`created_at\`),
        CONSTRAINT \`fk_sync_receipt_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_sync_receipt_status\`
          CHECK (\`receipt_status\` IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CONFLICT')),
        CONSTRAINT \`chk_sync_receipt_source\` CHECK (\`source_system\` IN ('LOCAL', 'CLOUD')),
        CONSTRAINT \`chk_sync_receipt_manifest\` CHECK (CHAR_LENGTH(\`manifest_checksum\`) = 64),
        CONSTRAINT \`chk_sync_receipt_confirmed\` CHECK (
          \`receipt_status\` IN ('PENDING', 'CONFLICT') OR \`confirmed_at\` IS NOT NULL
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='同步回执表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`sync_conflict\` (
        \`conflict_id\` char(36) NOT NULL COMMENT '冲突ID',
        \`record_uuid\` char(36) NOT NULL COMMENT '业务稳定编号',
        \`organization_id\` int NOT NULL COMMENT '公司数据区',
        \`resource_type\` varchar(32) NOT NULL COMMENT '冲突资源类型',
        \`version_no\` int unsigned NOT NULL COMMENT '冲突版本号',
        \`local_snapshot\` longtext NOT NULL COMMENT '本地快照 JSON；含 schema_version',
        \`cloud_snapshot\` longtext NOT NULL COMMENT '云端快照 JSON；含 schema_version',
        \`conflict_reason\` text NOT NULL COMMENT '可展示的冲突原因',
        \`status\` varchar(16) NOT NULL COMMENT 'PENDING/RESOLVED/IGNORED',
        \`confirmed_by_account_id\` int DEFAULT NULL COMMENT '确认处理人',
        \`confirmed_at\` timestamp(3) NULL DEFAULT NULL COMMENT '确认时间',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        PRIMARY KEY (\`conflict_id\`),
        UNIQUE KEY \`uk_sync_conflict_scope\`
          (\`record_uuid\`, \`organization_id\`, \`resource_type\`, \`version_no\`),
        KEY \`idx_sync_conflict_organization_status\` (\`organization_id\`, \`status\`, \`created_at\`),
        CONSTRAINT \`fk_sync_conflict_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_sync_conflict_confirmer\`
          FOREIGN KEY (\`confirmed_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_sync_conflict_status\` CHECK (\`status\` IN ('PENDING', 'RESOLVED', 'IGNORED')),
        CONSTRAINT \`chk_sync_conflict_confirmed\` CHECK (
          (\`status\` = 'PENDING' AND \`confirmed_by_account_id\` IS NULL AND \`confirmed_at\` IS NULL)
          OR (\`status\` IN ('RESOLVED', 'IGNORED')
            AND \`confirmed_by_account_id\` IS NOT NULL AND \`confirmed_at\` IS NOT NULL)
        ),
        CONSTRAINT \`chk_sync_conflict_schema\` CHECK (
          JSON_VALID(\`local_snapshot\`) AND JSON_VALID(\`cloud_snapshot\`)
          AND JSON_EXTRACT(\`local_snapshot\`, '$.schema_version') IS NOT NULL
          AND JSON_EXTRACT(\`cloud_snapshot\`, '$.schema_version') IS NOT NULL
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='同步冲突表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`record_package_import\` (
        \`package_id\` char(36) NOT NULL COMMENT '导入包ID',
        \`organization_id\` int NOT NULL COMMENT '目标公司数据区',
        \`imported_by_account_id\` int NOT NULL COMMENT '实际导入人',
        \`manifest_json\` longtext NOT NULL COMMENT '包清单 JSON；含 schema_version',
        \`manifest_checksum\` char(64) NOT NULL COMMENT '包清单 SHA-256',
        \`status\` varchar(16) NOT NULL COMMENT 'PENDING/RUNNING/SUCCEEDED/PARTIAL/FAILED',
        \`item_total\` int unsigned NOT NULL DEFAULT '0' COMMENT '清点总条数',
        \`item_succeeded\` int unsigned NOT NULL DEFAULT '0' COMMENT '成功条数',
        \`item_failed\` int unsigned NOT NULL DEFAULT '0' COMMENT '失败条数',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`completed_at\` timestamp(3) NULL DEFAULT NULL COMMENT '完成时间',
        PRIMARY KEY (\`package_id\`),
        KEY \`idx_record_package_import_organization\` (\`organization_id\`, \`created_at\`),
        CONSTRAINT \`fk_record_package_import_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_record_package_import_actor\`
          FOREIGN KEY (\`imported_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_record_package_import_status\`
          CHECK (\`status\` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
        CONSTRAINT \`chk_record_package_import_manifest\` CHECK (
          JSON_VALID(\`manifest_json\`)
          AND JSON_EXTRACT(\`manifest_json\`, '$.schema_version') IS NOT NULL
          AND CHAR_LENGTH(\`manifest_checksum\`) = 64
        ),
        CONSTRAINT \`chk_record_package_import_counts\` CHECK (
          \`item_succeeded\` + \`item_failed\` <= \`item_total\`
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='记录包导入批次表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`record_package_item\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT COMMENT '导入条目ID',
        \`package_id\` char(36) NOT NULL COMMENT '所属导入包',
        \`record_uuid\` char(36) NOT NULL COMMENT '业务稳定编号',
        \`resource_type\` varchar(32) NOT NULL COMMENT '资源类型',
        \`version_no\` int unsigned NOT NULL COMMENT '业务版本号',
        \`result\` varchar(16) NOT NULL COMMENT 'SUCCEEDED/FAILED/SKIPPED',
        \`receipt_id\` char(36) DEFAULT NULL COMMENT '对应同步回执ID',
        \`error_message\` text DEFAULT NULL COMMENT '失败原因',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_record_package_item_scope\`
          (\`package_id\`, \`record_uuid\`, \`resource_type\`, \`version_no\`),
        CONSTRAINT \`fk_record_package_item_package\`
          FOREIGN KEY (\`package_id\`) REFERENCES \`record_package_import\` (\`package_id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_record_package_item_receipt\`
          FOREIGN KEY (\`receipt_id\`) REFERENCES \`sync_receipt\` (\`receipt_id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_record_package_item_result\`
          CHECK (\`result\` IN ('SUCCEEDED', 'FAILED', 'SKIPPED')),
        CONSTRAINT \`chk_record_package_item_error\` CHECK (
          \`result\` <> 'FAILED' OR (\`error_message\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`error_message\`)) > 0)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='记录包逐条导入结果表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `record_package_item`;');
    await queryRunner.query('DROP TABLE `record_package_import`;');
    await queryRunner.query('DROP TABLE `sync_conflict`;');
    await queryRunner.query('DROP TABLE `sync_receipt`;');
    await queryRunner.query('DROP TABLE `local_company_setting`;');
    await queryRunner.query('DROP TABLE `local_account_authorization`;');
  }
}

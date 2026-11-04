import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 附件当前集合、冻结版本、冻结附件清单（含发布选择）与审核记录。
 * 复合外键确保版本附件只能引用同一报告的版本与附件。
 */
export class CreateMaintenanceReportAttachmentVersionReview1775401300000 implements MigrationInterface {
  name = 'CreateMaintenanceReportAttachmentVersionReview1775401300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`maintenance_report_attachment\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '附件主键ID（本地标识，非云端主键）',
        \`report_id\` int NOT NULL COMMENT '所属报告ID',
        \`original_filename\` varchar(255) NOT NULL COMMENT '原文件名快照',
        \`mime_type\` varchar(100) NOT NULL COMMENT 'MIME 类型',
        \`byte_size\` bigint unsigned NOT NULL COMMENT '文件字节数；单文件上限 20 MiB',
        \`checksum_sha256\` char(64) DEFAULT NULL COMMENT 'SHA-256 校验值',
        \`storage_backend\` varchar(16) NOT NULL COMMENT '存储后端：LOCAL/OBJECT',
        \`storage_reference\` varchar(512) NOT NULL COMMENT '本地相对路径或对象键',
        \`sort_order\` smallint unsigned NOT NULL COMMENT '展示顺序 1-10',
        \`description\` varchar(500) DEFAULT NULL COMMENT '附件说明',
        \`status\` varchar(16) NOT NULL DEFAULT 'CURRENT' COMMENT 'CURRENT/RETIRED',
        \`active_sort_order\` smallint unsigned GENERATED ALWAYS AS (
          IF(\`status\` = 'CURRENT', \`sort_order\`, NULL)
        ) STORED COMMENT '当前有效排序唯一锚点；退役行为 NULL',
        \`uploaded_by_account_id\` int NOT NULL COMMENT '上传人账号ID',
        \`retired_at\` timestamp(3) NULL DEFAULT NULL COMMENT '退役时间；RETIRED 必填',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_maintenance_report_attachment_id_report\` (\`id\`, \`report_id\`),
        UNIQUE KEY \`uk_maintenance_report_attachment_active_slot\` (\`report_id\`, \`active_sort_order\`),
        KEY \`idx_maintenance_report_attachment_report_status\` (\`report_id\`, \`status\`, \`sort_order\`),
        CONSTRAINT \`fk_maintenance_report_attachment_report\` FOREIGN KEY (\`report_id\`) REFERENCES \`maintenance_report\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_attachment_uploaded_by\` FOREIGN KEY (\`uploaded_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_maintenance_report_attachment_byte_size\` CHECK (\`byte_size\` > 0 AND \`byte_size\` <= 20971520),
        CONSTRAINT \`chk_maintenance_report_attachment_sort\` CHECK (\`sort_order\` BETWEEN 1 AND 10),
        CONSTRAINT \`chk_maintenance_report_attachment_status\` CHECK (\`status\` IN ('CURRENT', 'RETIRED')),
        CONSTRAINT \`chk_maintenance_report_attachment_retired\` CHECK (
          (\`status\` = 'CURRENT' AND \`retired_at\` IS NULL)
          OR (\`status\` = 'RETIRED' AND \`retired_at\` IS NOT NULL)
        ),
        CONSTRAINT \`chk_maintenance_report_attachment_storage\` CHECK (\`storage_backend\` IN ('LOCAL', 'OBJECT')),
        CONSTRAINT \`chk_maintenance_report_attachment_filename\` CHECK (CHAR_LENGTH(TRIM(\`original_filename\`)) > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='维修报告当前附件集合表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`maintenance_report_version\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '冻结版本主键ID',
        \`report_id\` int NOT NULL COMMENT '所属报告ID',
        \`version_no\` int unsigned NOT NULL COMMENT '版本号；从 1 递增',
        \`change_kind\` varchar(24) NOT NULL DEFAULT 'SUBMIT' COMMENT 'SUBMIT/FORMAL_CORRECTION',
        \`change_reason\` varchar(500) DEFAULT NULL COMMENT '更正原因；正式更正必填',
        \`schema_version\` smallint unsigned NOT NULL DEFAULT '2' COMMENT '快照严格 schema 版本',
        \`payload_snapshot\` json NOT NULL COMMENT '标题/厂家/型号/日期/负责人/报警/步骤/AI 使用与评价完整快照',
        \`submitted_by_account_id\` int NOT NULL COMMENT '提交人账号ID',
        \`submitted_at\` timestamp(3) NOT NULL COMMENT '冻结事件时间',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_maintenance_report_version_no\` (\`report_id\`, \`version_no\`),
        UNIQUE KEY \`uk_maintenance_report_version_id_report\` (\`id\`, \`report_id\`),
        KEY \`idx_maintenance_report_version_submitted\` (\`report_id\`, \`submitted_at\`),
        CONSTRAINT \`fk_maintenance_report_version_report\` FOREIGN KEY (\`report_id\`) REFERENCES \`maintenance_report\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_version_submitted_by\` FOREIGN KEY (\`submitted_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_maintenance_report_version_no\` CHECK (\`version_no\` >= 1),
        CONSTRAINT \`chk_maintenance_report_version_change_kind\` CHECK (\`change_kind\` IN ('SUBMIT', 'FORMAL_CORRECTION')),
        CONSTRAINT \`chk_maintenance_report_version_correction_reason\` CHECK (\`change_kind\` = 'SUBMIT' OR \`change_reason\` IS NOT NULL),
        CONSTRAINT \`chk_maintenance_report_version_payload\` CHECK (JSON_VALID(\`payload_snapshot\`)),
        CONSTRAINT \`chk_maintenance_report_version_schema\` CHECK (\`schema_version\` >= 2)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='维修报告冻结版本表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`maintenance_report_version_attachment\` (
        \`version_id\` int NOT NULL COMMENT '冻结版本ID',
        \`attachment_id\` int NOT NULL COMMENT '附件ID',
        \`report_id\` int NOT NULL COMMENT '所属报告ID（复合外键锚点）',
        \`sort_order\` smallint unsigned NOT NULL COMMENT '冻结时展示顺序',
        \`description_snapshot\` varchar(500) DEFAULT NULL COMMENT '冻结时附件说明',
        \`publish_flag\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '审核通过时的发布选择；提交前恒为 0',
        PRIMARY KEY (\`version_id\`, \`attachment_id\`),
        UNIQUE KEY \`uk_maintenance_report_version_attachment_sort\` (\`version_id\`, \`sort_order\`),
        KEY \`idx_maintenance_report_version_attachment_attachment\` (\`attachment_id\`),
        CONSTRAINT \`fk_maintenance_report_version_attachment_version\` FOREIGN KEY (\`version_id\`, \`report_id\`) REFERENCES \`maintenance_report_version\` (\`id\`, \`report_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_version_attachment_attachment\` FOREIGN KEY (\`attachment_id\`, \`report_id\`) REFERENCES \`maintenance_report_attachment\` (\`id\`, \`report_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_maintenance_report_version_attachment_sort\` CHECK (\`sort_order\` BETWEEN 1 AND 10),
        CONSTRAINT \`chk_maintenance_report_version_attachment_publish\` CHECK (\`publish_flag\` IN (0, 1))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='维修报告冻结附件清单与发布选择表';
    `);

    await queryRunner.query(`
      CREATE TABLE \`maintenance_report_review\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '审核记录主键ID',
        \`report_id\` int NOT NULL COMMENT '所属报告ID',
        \`version_id\` int NOT NULL COMMENT '被审核冻结版本ID；每版本至多一条',
        \`decision\` varchar(16) NOT NULL COMMENT 'APPROVE/RETURN',
        \`comment\` varchar(2000) DEFAULT NULL COMMENT '审核意见；退回必填',
        \`reviewed_by_account_id\` int NOT NULL COMMENT '审核管理员账号ID',
        \`reviewed_at\` timestamp(3) NOT NULL COMMENT '审核事件时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_maintenance_report_review_version\` (\`version_id\`),
        UNIQUE KEY \`uk_maintenance_report_review_id_report\` (\`id\`, \`report_id\`),
        KEY \`idx_maintenance_report_review_report_time\` (\`report_id\`, \`reviewed_at\`),
        CONSTRAINT \`fk_maintenance_report_review_version\` FOREIGN KEY (\`version_id\`, \`report_id\`) REFERENCES \`maintenance_report_version\` (\`id\`, \`report_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_maintenance_report_review_reviewer\` FOREIGN KEY (\`reviewed_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_maintenance_report_review_decision\` CHECK (\`decision\` IN ('APPROVE', 'RETURN')),
        CONSTRAINT \`chk_maintenance_report_review_comment\` CHECK (\`decision\` = 'APPROVE' OR \`comment\` IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='维修报告审核记录表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `maintenance_report_review`;');
    await queryRunner.query('DROP TABLE `maintenance_report_version_attachment`;');
    await queryRunner.query('DROP TABLE `maintenance_report_version`;');
    await queryRunner.query('DROP TABLE `maintenance_report_attachment`;');
  }
}

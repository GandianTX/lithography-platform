import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  markHistoricalRepairRequests,
  resolveAndVerifyLegacyRepairManifest,
  type LegacyRepairIdentityManifest,
} from '../legacy-repair-identity-manifest';

/**
 * V13 报修/会话/报告/资料/本地任务结构。
 *
 * 只做前向扩展：旧值保留，新增字段先可空，能从现有字段证明的历史事实才回填；
 * 不猜测旧工单归属，不改写历史业务正文。
 *
 * 兼容边界：`ai_helpfulness` 库内保持 1—5（旧合法值 5 不改写），新输入收紧到 1—4
 * 由应用层执行；其余会拒绝既有合法行的约束（ACTIVE 会话已带反馈、旧中断工单缺少
 * closure_reason）在任何 ALTER 之前先做兼容预检，失败即中止且不留半迁移。
 */
export class AlterRepairAiReportForV131775501100000 implements MigrationInterface {
  name = 'AlterRepairAiReportForV131775501100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 所有收紧既有数据的约束都必须先完成兼容判定，再执行任何 ALTER；
    // 否则 MySQL 隐式提交会让失败现场停在半迁移。
    const legacyManifest = await resolveAndVerifyLegacyRepairManifest(queryRunner);
    await assertLegacyDataCompatible(queryRunner, legacyManifest);
    await this.upgradeRepairRequest(queryRunner, legacyManifest);
    await this.upgradeAiConversation(queryRunner);
    await this.upgradeAiMessage(queryRunner);
    await this.upgradeMaintenanceReportStep(queryRunner);
    await this.upgradeMaintenanceReport(queryRunner);
    await this.upgradeReferenceDocument(queryRunner);
    await this.upgradeLocalTasks(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`local_backup_run\`
        DROP CONSTRAINT \`chk_local_backup_run_manual_status\`,
        DROP INDEX \`idx_local_backup_run_organization\`,
        DROP CONSTRAINT \`fk_local_backup_run_organization\`,
        DROP COLUMN \`manual_cleanup_status\`,
        DROP COLUMN \`manual_upload_status\`,
        DROP COLUMN \`organization_id\`;
    `);
    await queryRunner.query(`
      ALTER TABLE \`local_backup_run\`
        DROP INDEX \`uk_local_backup_run_active_company\`,
        ADD UNIQUE KEY \`uk_local_backup_run_active\` (\`active_installation_id\`),
        DROP CONSTRAINT \`chk_local_backup_run_trigger\`,
        ADD CONSTRAINT \`chk_local_backup_run_trigger\`
          CHECK (\`trigger_type\` IN ('SCHEDULED', 'MANUAL', 'USB_EXPORT'));
    `);

    await queryRunner.query(`
      ALTER TABLE \`local_upload_task\`
        DROP CONSTRAINT \`chk_local_upload_task_task_kind\`,
        DROP CONSTRAINT \`chk_local_upload_task_manifest_checksum\`,
        DROP INDEX \`idx_local_upload_task_record_uuid\`,
        DROP COLUMN \`manifest_checksum\`,
        DROP COLUMN \`task_kind\`,
        DROP COLUMN \`source_version\`,
        DROP COLUMN \`record_uuid\`;
    `);

    await queryRunner.query(`
      ALTER TABLE \`reference_document\`
        DROP CONSTRAINT \`chk_reference_document_report_source_pair\`,
        DROP CONSTRAINT \`chk_reference_document_content_source_v13\`,
        DROP CONSTRAINT \`chk_reference_document_ownership\`,
        DROP CONSTRAINT \`chk_reference_document_publication\`,
        DROP CONSTRAINT \`chk_reference_document_ingest_method\`,
        DROP FOREIGN KEY \`fk_reference_document_source_report_version\`,
        DROP INDEX \`uk_reference_document_source_report_version\`,
        DROP COLUMN \`source_report_version_id\`,
        DROP COLUMN \`source_report_id\`,
        DROP COLUMN \`source_kind\`,
        DROP COLUMN \`current_revision_no\`,
        DROP COLUMN \`ownership_status\`,
        DROP COLUMN \`publication_status\`,
        MODIFY COLUMN \`owner_organization_id\` int NOT NULL COMMENT '所属组织ID',
        ADD CONSTRAINT \`chk_reference_document_ingest_method\`
          CHECK (\`ingest_method\` IN ('ADMIN_DIRECT', 'REVIEWED_SUBMISSION', 'SYSTEM_IMPORT')),
        ADD CONSTRAINT \`chk_reference_document_content_source\`
          CHECK (\`content_text\` IS NOT NULL OR \`storage_reference\` IS NOT NULL);
    `);

    await queryRunner.query(`
      ALTER TABLE \`maintenance_report\`
        DROP CONSTRAINT \`chk_maintenance_report_submission_pair\`,
        DROP CONSTRAINT \`chk_maintenance_report_closure_reason\`,
        DROP CONSTRAINT \`chk_maintenance_report_reset_result\`,
        DROP CONSTRAINT \`chk_maintenance_report_handling_result\`,
        DROP INDEX \`uk_maintenance_report_submission\`,
        DROP CONSTRAINT \`chk_maintenance_report_ai_correctness\`,
        DROP CONSTRAINT \`chk_maintenance_report_ai_helpfulness\`,
        DROP CONSTRAINT \`chk_maintenance_report_status_consistency\`,
        DROP CONSTRAINT \`chk_maintenance_report_status\`,
        DROP COLUMN \`submission_payload_hash\`,
        DROP COLUMN \`submission_request_id\`,
        DROP COLUMN \`verification_result\`,
        DROP COLUMN \`repair_actions\`,
        DROP COLUMN \`actual_cause\`,
        DROP COLUMN \`reset_result\`,
        DROP COLUMN \`closure_reason\`,
        DROP COLUMN \`handling_result\`,
        DROP COLUMN \`supplementary_note\`,
        MODIFY COLUMN \`maintenance_engineer_name_snapshot\` varchar(50) NOT NULL COMMENT '负责工程师姓名快照',
        MODIFY COLUMN \`equipment_model_text\` varchar(100) DEFAULT NULL COMMENT '型号文字快照；与型号ID互斥',
        MODIFY COLUMN \`customer_factory_name\` varchar(100) DEFAULT NULL COMMENT '客户厂家（手填，不作为权限来源）',
        ADD CONSTRAINT \`chk_maintenance_report_status\`
          CHECK (\`status\` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'APPROVED')),
        ADD CONSTRAINT \`chk_maintenance_report_status_consistency\` CHECK (
          (\`status\` = 'DRAFT' AND \`current_version_no\` = 0 AND \`last_submitted_at\` IS NULL AND \`last_reviewed_at\` IS NULL)
          OR (\`status\` = 'PENDING_REVIEW' AND \`current_version_no\` >= 1 AND \`last_submitted_at\` IS NOT NULL AND \`last_reviewed_at\` IS NULL)
          OR (\`status\` IN ('RETURNED', 'APPROVED') AND \`current_version_no\` >= 1 AND \`last_submitted_at\` IS NOT NULL AND \`last_reviewed_at\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_maintenance_report_ai_helpfulness\`
          CHECK (\`ai_helpfulness\` IS NULL OR \`ai_helpfulness\` BETWEEN 1 AND 5),
        ADD CONSTRAINT \`chk_maintenance_report_ai_correctness\`
          CHECK (\`ai_correctness\` IS NULL OR \`ai_correctness\` IN ('CORRECT', 'PARTIAL', 'INCORRECT'));
    `);

    await queryRunner.query(`
      ALTER TABLE \`maintenance_report_step\`
        DROP CONSTRAINT \`chk_maintenance_report_step_result_code\`,
        DROP COLUMN \`result_code\`,
        DROP COLUMN \`error_code\`,
        MODIFY COLUMN \`step_no\` smallint unsigned NOT NULL COMMENT '顺序号；从 1 连续',
        MODIFY COLUMN \`action_text\` text NOT NULL COMMENT '动作',
        MODIFY COLUMN \`part_name\` varchar(100) DEFAULT NULL COMMENT '零件/部位';
    `);

    await queryRunner.query(`
      ALTER TABLE \`ai_message\`
        DROP CONSTRAINT \`chk_ai_message_content_version\`,
        DROP INDEX \`uk_ai_message_question_uuid\`,
        DROP COLUMN \`content_version\`,
        DROP COLUMN \`question_uuid\`;
    `);

    await queryRunner.query(`
      ALTER TABLE \`ai_conversation\`
        DROP CONSTRAINT \`chk_ai_conversation_content_version\`,
        DROP CONSTRAINT \`chk_ai_conversation_completion\`,
        DROP INDEX \`idx_ai_conversation_owner_created\`,
        DROP CONSTRAINT \`fk_ai_conversation_owner_organization\`,
        DROP COLUMN \`content_version\`,
        DROP COLUMN \`owner_organization_id\`,
        MODIFY COLUMN \`request_id\` int NOT NULL COMMENT '维修申请ID',
        ADD CONSTRAINT \`chk_ai_conversation_completion\` CHECK (
          (\`status\` = 'ACTIVE' AND \`completed_at\` IS NULL)
          OR (\`status\` = 'COMPLETED' AND \`ai_feedback\` IS NOT NULL
            AND CHAR_LENGTH(TRIM(\`ai_feedback\`)) > 0 AND \`completed_at\` IS NOT NULL)
        );
    `);

    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        DROP CONSTRAINT \`chk_repair_request_closure_reason\`,
        DROP CONSTRAINT \`chk_repair_request_closure\`,
        DROP CONSTRAINT \`chk_repair_request_new_intake_companies\`,
        DROP CONSTRAINT \`chk_repair_request_current_revision\`,
        DROP INDEX \`uk_repair_request_intake\`,
        DROP INDEX \`idx_repair_request_customer_organization\`,
        DROP INDEX \`idx_repair_request_service_organization\`,
        DROP CONSTRAINT \`fk_repair_request_customer_organization\`,
        DROP CONSTRAINT \`fk_repair_request_service_organization\`,
        DROP COLUMN \`current_revision_no\`,
        DROP COLUMN \`is_historical\`,
        DROP COLUMN \`closure_reason\`,
        DROP COLUMN \`closed_at\`,
        DROP COLUMN \`closure_status\`,
        DROP COLUMN \`service_organization_id\`,
        DROP COLUMN \`customer_organization_id\`,
        DROP COLUMN \`intake_id\`;
    `);
  }

  private async upgradeRepairRequest(
    queryRunner: QueryRunner,
    legacyManifest: LegacyRepairIdentityManifest | null,
  ): Promise<void> {
    // 历史标记必须先于原因约束生效：先加列、按冻结清单置 1，再添加宽松后的约束。
    // MySQL 8 的 DDL 隐式提交：若上次在本迁移后续步骤失败，本列可能已提交；
    // 已存在时跳过加列，避免续跑因 Duplicate column 中止（不回退已提交结构）。
    if (!(await columnExists(queryRunner, 'repair_request', 'is_historical'))) {
      await queryRunner.query(`
        ALTER TABLE \`repair_request\`
          ADD COLUMN \`is_historical\` tinyint(1) NOT NULL DEFAULT '0'
            COMMENT '历史导入工单；仅迁移/运维可置1，普通业务输入不可修改';
      `);
    }
    if (legacyManifest !== null && legacyManifest.rows.length > 0) {
      await markHistoricalRepairRequests(
        queryRunner,
        legacyManifest.rows.map((row) => row.id),
      );
    }
    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        ADD COLUMN \`intake_id\` int DEFAULT NULL COMMENT '报修原始输入ID；新工单唯一，旧工单可空',
        ADD COLUMN \`customer_organization_id\` int DEFAULT NULL COMMENT '客户公司ID；仅可从可证明来源回填',
        ADD COLUMN \`service_organization_id\` int DEFAULT NULL COMMENT '服务公司ID；仅可从可证明来源回填',
        ADD COLUMN \`closure_status\` varchar(16) DEFAULT NULL COMMENT 'OPEN/CLOSED；旧行可空',
        ADD COLUMN \`closed_at\` timestamp(3) NULL DEFAULT NULL COMMENT '结束事实时间',
        ADD COLUMN \`closure_reason\` text DEFAULT NULL COMMENT '中断或无法修复时的结束原因',
        ADD COLUMN \`current_revision_no\` int unsigned NOT NULL DEFAULT '0' COMMENT '管理修订生效版本',
        ADD UNIQUE KEY \`uk_repair_request_intake\` (\`intake_id\`),
        ADD KEY \`idx_repair_request_customer_organization\` (\`customer_organization_id\`, \`created_at\`),
        ADD KEY \`idx_repair_request_service_organization\` (\`service_organization_id\`, \`created_at\`),
        ADD CONSTRAINT \`fk_repair_request_customer_organization\`
          FOREIGN KEY (\`customer_organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`fk_repair_request_service_organization\`
          FOREIGN KEY (\`service_organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`chk_repair_request_new_intake_companies\` CHECK (
          \`intake_id\` IS NULL
          OR (\`customer_organization_id\` IS NOT NULL AND \`service_organization_id\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_repair_request_closure\` CHECK (
          (\`closure_status\` IS NULL AND \`closed_at\` IS NULL)
          OR (\`closure_status\` = 'OPEN' AND \`closed_at\` IS NULL)
          OR (\`closure_status\` = 'CLOSED' AND \`closed_at\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_repair_request_closure_reason\` CHECK (
          \`is_historical\` = 1
          OR \`handling_result\` IS NULL
          OR \`handling_result\` NOT IN ('INTERRUPTED', 'UNREPAIRABLE')
          OR (\`closure_reason\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`closure_reason\`)) > 0)
        ),
        ADD CONSTRAINT \`chk_repair_request_current_revision\` CHECK (\`current_revision_no\` >= 0);
    `);
  }

  private async upgradeAiConversation(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`ai_conversation\`
        MODIFY COLUMN \`request_id\` int NULL COMMENT '维修申请ID；独立AI会话为空',
        ADD COLUMN \`owner_organization_id\` int DEFAULT NULL COMMENT '会话可信公司ID；新会话非空',
        ADD COLUMN \`content_version\` int unsigned NOT NULL DEFAULT '1' COMMENT '内容版本；新写入递增',
        ADD KEY \`idx_ai_conversation_owner_created\` (\`owner_organization_id\`, \`created_at\`),
        ADD CONSTRAINT \`fk_ai_conversation_owner_organization\`
          FOREIGN KEY (\`owner_organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`chk_ai_conversation_content_version\` CHECK (\`content_version\` >= 1),
        DROP CONSTRAINT \`chk_ai_conversation_completion\`,
        ADD CONSTRAINT \`chk_ai_conversation_completion\` CHECK (
          (\`status\` = 'ACTIVE' AND \`ai_feedback\` IS NULL AND \`completed_at\` IS NULL)
          OR (\`status\` = 'COMPLETED' AND \`ai_feedback\` IS NOT NULL
            AND CHAR_LENGTH(TRIM(\`ai_feedback\`)) > 0 AND \`completed_at\` IS NOT NULL)
        );
    `);
  }

  private async upgradeAiMessage(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`ai_message\`
        ADD COLUMN \`question_uuid\` char(36) DEFAULT NULL COMMENT '原问题稳定标识；旧消息可空',
        ADD COLUMN \`content_version\` int unsigned NOT NULL DEFAULT '1' COMMENT '消息内容版本；已存原文不可无痕覆盖',
        ADD UNIQUE KEY \`uk_ai_message_question_uuid\` (\`question_uuid\`),
        ADD CONSTRAINT \`chk_ai_message_content_version\` CHECK (\`content_version\` >= 1);
    `);
  }

  private async upgradeMaintenanceReportStep(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`maintenance_report_step\`
        ADD COLUMN \`error_code\` varchar(300) DEFAULT NULL COMMENT '步骤报错代码；保留前导零',
        ADD COLUMN \`result_code\` varchar(16) DEFAULT NULL COMMENT 'RESOLVED/UNRESOLVED/NEW_FAULT',
        ADD CONSTRAINT \`chk_maintenance_report_step_result_code\` CHECK (
          \`result_code\` IS NULL OR \`result_code\` IN ('RESOLVED', 'UNRESOLVED', 'NEW_FAULT')
        );
    `);
    await queryRunner.query(`
      ALTER TABLE \`maintenance_report_step\`
        MODIFY COLUMN \`step_no\` int unsigned NOT NULL COMMENT '顺序号；报告内唯一且 >=1，不限制十步',
        MODIFY COLUMN \`part_name\` varchar(300) DEFAULT NULL COMMENT '零件/部位；选填',
        MODIFY COLUMN \`action_text\` longtext NOT NULL COMMENT '动作；正式内容不超过 10000 字';
    `);
  }

  private async upgradeMaintenanceReport(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`maintenance_report\`
        MODIFY COLUMN \`customer_factory_name\` varchar(200) DEFAULT NULL COMMENT '客户厂家；草稿可空，正式必填',
        MODIFY COLUMN \`equipment_model_text\` varchar(200) DEFAULT NULL COMMENT '型号文字快照；与型号ID互斥',
        MODIFY COLUMN \`maintenance_engineer_name_snapshot\` varchar(200) NOT NULL COMMENT '负责工程师姓名快照',
        ADD COLUMN \`supplementary_note\` longtext DEFAULT NULL COMMENT '补充说明；不超过 10000 字',
        ADD COLUMN \`handling_result\` varchar(32) DEFAULT NULL COMMENT 'FIXED/PART_PURCHASED/PROVIDE_PLAN_SELF_EXECUTE/INTERRUPTED/UNREPAIRABLE',
        ADD COLUMN \`closure_reason\` text DEFAULT NULL COMMENT '中断或无法修复时必填',
        ADD COLUMN \`reset_result\` varchar(24) DEFAULT NULL COMMENT 'NORMAL/SAME_FAULT/NEW_FAULT',
        ADD COLUMN \`actual_cause\` text DEFAULT NULL COMMENT '实际原因；正式不超过 2000 字',
        ADD COLUMN \`repair_actions\` longtext DEFAULT NULL COMMENT '实际修复动作；正式不超过 10000 字',
        ADD COLUMN \`verification_result\` text DEFAULT NULL COMMENT '验证结果；正式不超过 2000 字',
        ADD COLUMN \`submission_request_id\` varchar(64) DEFAULT NULL COMMENT '提交动作标识；同次重试复用',
        ADD COLUMN \`submission_payload_hash\` char(64) DEFAULT NULL COMMENT '规范化提交正文 SHA-256',
        ADD UNIQUE KEY \`uk_maintenance_report_submission\`
          (\`created_by_account_id\`, \`owner_organization_id\`, \`submission_request_id\`),
        DROP CONSTRAINT \`chk_maintenance_report_status\`,
        ADD CONSTRAINT \`chk_maintenance_report_status\` CHECK (
          \`status\` IN ('DRAFT', 'SUBMITTED', 'PENDING_REVIEW', 'RETURNED', 'APPROVED')
        ),
        DROP CONSTRAINT \`chk_maintenance_report_status_consistency\`,
        ADD CONSTRAINT \`chk_maintenance_report_status_consistency\` CHECK (
          (\`status\` = 'DRAFT' AND \`current_version_no\` = 0 AND \`last_submitted_at\` IS NULL AND \`last_reviewed_at\` IS NULL)
          OR (\`status\` IN ('SUBMITTED', 'PENDING_REVIEW') AND \`current_version_no\` >= 1
            AND \`last_submitted_at\` IS NOT NULL AND \`last_reviewed_at\` IS NULL)
          OR (\`status\` IN ('RETURNED', 'APPROVED') AND \`current_version_no\` >= 1
            AND \`last_submitted_at\` IS NOT NULL AND \`last_reviewed_at\` IS NOT NULL)
        ),
        DROP CONSTRAINT \`chk_maintenance_report_ai_helpfulness\`,
        ADD CONSTRAINT \`chk_maintenance_report_ai_helpfulness\` CHECK (
          \`ai_helpfulness\` IS NULL OR \`ai_helpfulness\` BETWEEN 1 AND 5
        ),
        DROP CONSTRAINT \`chk_maintenance_report_ai_correctness\`,
        ADD CONSTRAINT \`chk_maintenance_report_ai_correctness\` CHECK (
          \`ai_correctness\` IS NULL
          OR \`ai_correctness\` IN ('CORRECT', 'PARTIAL', 'INCORRECT', 'UNKNOWN')
        ),
        ADD CONSTRAINT \`chk_maintenance_report_handling_result\` CHECK (
          \`handling_result\` IS NULL OR \`handling_result\` IN (
            'FIXED', 'PART_PURCHASED', 'PROVIDE_PLAN_SELF_EXECUTE', 'INTERRUPTED', 'UNREPAIRABLE'
          )
        ),
        ADD CONSTRAINT \`chk_maintenance_report_reset_result\` CHECK (
          \`reset_result\` IS NULL OR \`reset_result\` IN ('NORMAL', 'SAME_FAULT', 'NEW_FAULT')
        ),
        ADD CONSTRAINT \`chk_maintenance_report_closure_reason\` CHECK (
          \`handling_result\` IS NULL
          OR \`handling_result\` NOT IN ('INTERRUPTED', 'UNREPAIRABLE')
          OR (\`closure_reason\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`closure_reason\`)) > 0)
        ),
        ADD CONSTRAINT \`chk_maintenance_report_submission_pair\` CHECK (
          (\`submission_request_id\` IS NULL AND \`submission_payload_hash\` IS NULL)
          OR (\`submission_request_id\` IS NOT NULL
            AND CHAR_LENGTH(TRIM(\`submission_request_id\`)) > 0
            AND \`submission_payload_hash\` IS NOT NULL
            AND CHAR_LENGTH(\`submission_payload_hash\`) = 64)
        );
    `);
  }

  private async upgradeReferenceDocument(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`reference_document\`
        ADD COLUMN \`publication_status\` varchar(16) DEFAULT NULL COMMENT 'ONLINE/OFFLINE；删除另记',
        ADD COLUMN \`ownership_status\` varchar(16) DEFAULT NULL COMMENT 'CONFIRMED/PENDING',
        ADD COLUMN \`current_revision_no\` int unsigned NOT NULL DEFAULT '0' COMMENT '生效管理修订版本',
        ADD COLUMN \`source_kind\` varchar(32) DEFAULT NULL COMMENT 'INDEPENDENT_REPORT/WORK_ORDER_SUMMARY/MATERIAL',
        ADD COLUMN \`source_report_id\` int DEFAULT NULL COMMENT '来源报告ID；与版本同报告',
        ADD COLUMN \`source_report_version_id\` int DEFAULT NULL COMMENT '来源冻结报告版本ID；永久保留';
    `);

    // 只使用现有字段可证明的事实回填：已软删/下架 -> OFFLINE；已有组织 -> CONFIRMED；历史资料 -> MATERIAL。
    await queryRunner.query(`
      UPDATE \`reference_document\`
      SET \`publication_status\` = CASE
        WHEN \`deprecated\` = 0 AND \`deleted_at\` IS NULL THEN 'ONLINE'
        ELSE 'OFFLINE'
      END
      WHERE \`publication_status\` IS NULL;
    `);
    await queryRunner.query(`
      UPDATE \`reference_document\`
      SET \`ownership_status\` = CASE
        WHEN \`owner_organization_id\` IS NOT NULL THEN 'CONFIRMED'
        ELSE 'PENDING'
      END
      WHERE \`ownership_status\` IS NULL;
    `);
    await queryRunner.query(`
      UPDATE \`reference_document\`
      SET \`source_kind\` = 'MATERIAL'
      WHERE \`source_kind\` IS NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE \`reference_document\`
        MODIFY COLUMN \`owner_organization_id\` int NULL COMMENT '所属组织ID；未知历史归属为空，不猜测',
        MODIFY COLUMN \`publication_status\` varchar(16) NOT NULL COMMENT 'ONLINE/OFFLINE；删除另记',
        MODIFY COLUMN \`ownership_status\` varchar(16) NOT NULL COMMENT 'CONFIRMED/PENDING',
        MODIFY COLUMN \`source_kind\` varchar(32) NOT NULL COMMENT 'INDEPENDENT_REPORT/WORK_ORDER_SUMMARY/MATERIAL',
        ADD UNIQUE KEY \`uk_reference_document_source_report_version\` (\`source_report_version_id\`),
        ADD CONSTRAINT \`fk_reference_document_source_report_version\`
          FOREIGN KEY (\`source_report_version_id\`, \`source_report_id\`)
          REFERENCES \`maintenance_report_version\` (\`id\`, \`report_id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`chk_reference_document_publication\`
          CHECK (\`publication_status\` IN ('ONLINE', 'OFFLINE')),
        ADD CONSTRAINT \`chk_reference_document_ownership\` CHECK (
          \`ownership_status\` IN ('CONFIRMED', 'PENDING')
          AND (\`ownership_status\` = 'PENDING' OR \`owner_organization_id\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_reference_document_report_source_pair\` CHECK (
          (\`source_report_id\` IS NULL AND \`source_report_version_id\` IS NULL)
          OR (\`source_report_id\` IS NOT NULL AND \`source_report_version_id\` IS NOT NULL)
        ),
        DROP CONSTRAINT \`chk_reference_document_ingest_method\`,
        ADD CONSTRAINT \`chk_reference_document_ingest_method\` CHECK (
          \`ingest_method\` IN ('ADMIN_DIRECT', 'REVIEWED_SUBMISSION', 'SYSTEM_IMPORT', 'DIRECT_SUBMISSION')
        ),
        DROP CONSTRAINT \`chk_reference_document_content_source\`,
        ADD CONSTRAINT \`chk_reference_document_content_source_v13\` CHECK (
          (\`source_kind\` = 'MATERIAL' AND (\`content_text\` IS NOT NULL OR \`storage_reference\` IS NOT NULL))
          OR (\`source_kind\` IN ('INDEPENDENT_REPORT', 'WORK_ORDER_SUMMARY')
            AND \`source_report_id\` IS NOT NULL AND \`source_report_version_id\` IS NOT NULL)
        );
    `);
  }

  private async upgradeLocalTasks(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`local_upload_task\`
        ADD COLUMN \`record_uuid\` char(36) DEFAULT NULL COMMENT '跨端稳定业务编号；新任务非空',
        ADD COLUMN \`source_version\` int unsigned DEFAULT NULL COMMENT '业务版本；新任务非空',
        ADD COLUMN \`task_kind\` varchar(32) DEFAULT NULL COMMENT 'BUSINESS_SYNC/BACKUP_UPLOAD',
        ADD COLUMN \`manifest_checksum\` char(64) DEFAULT NULL COMMENT '正文与原件清单 SHA-256',
        ADD KEY \`idx_local_upload_task_record_uuid\` (\`record_uuid\`),
        ADD CONSTRAINT \`chk_local_upload_task_task_kind\` CHECK (
          \`task_kind\` IS NULL OR \`task_kind\` IN ('BUSINESS_SYNC', 'BACKUP_UPLOAD')
        ),
        ADD CONSTRAINT \`chk_local_upload_task_manifest_checksum\` CHECK (
          \`manifest_checksum\` IS NULL OR CHAR_LENGTH(\`manifest_checksum\`) = 64
        );
    `);

    await queryRunner.query(`
      ALTER TABLE \`local_backup_run\`
        ADD COLUMN \`organization_id\` int DEFAULT NULL COMMENT '公司数据区；旧行可空',
        ADD COLUMN \`manual_upload_status\` varchar(16) DEFAULT NULL COMMENT 'PENDING/RUNNING/SUCCEEDED/FAILED/NOT_REQUIRED',
        ADD COLUMN \`manual_cleanup_status\` varchar(16) DEFAULT NULL COMMENT 'PENDING/RUNNING/SUCCEEDED/FAILED/NOT_REQUIRED',
        ADD KEY \`idx_local_backup_run_organization\` (\`organization_id\`, \`started_at\`),
        ADD CONSTRAINT \`fk_local_backup_run_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT,
        DROP CONSTRAINT \`chk_local_backup_run_trigger\`,
        ADD CONSTRAINT \`chk_local_backup_run_trigger\` CHECK (
          \`trigger_type\` IN ('SCHEDULED', 'MANUAL', 'AUTO', 'RETRY', 'USB_EXPORT')
        ),
        ADD CONSTRAINT \`chk_local_backup_run_manual_status\` CHECK (
          (\`manual_upload_status\` IS NULL OR \`manual_upload_status\` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NOT_REQUIRED'))
          AND (\`manual_cleanup_status\` IS NULL OR \`manual_cleanup_status\` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NOT_REQUIRED'))
        );
    `);

    // 设备+公司+RUNNING 条件唯一；旧行 organization_id 为空时不制造猜测值。
    await queryRunner.query(
      'ALTER TABLE `local_backup_run` DROP INDEX `uk_local_backup_run_active`;',
    );
    await queryRunner.query(`
      ALTER TABLE \`local_backup_run\`
        ADD UNIQUE KEY \`uk_local_backup_run_active_company\`
          (\`active_installation_id\`, \`organization_id\`);
    `);
  }
}

interface CountRow {
  readonly total?: unknown;
}

const SAMPLE_LIMIT = 20;

const toCount = (rows: ReadonlyArray<CountRow>): number => {
  const parsed = Number(rows[0]?.total ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function columnExists(
  queryRunner: QueryRunner,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = (await queryRunner.query(
    `SELECT 1 AS present
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column],
  )) as ReadonlyArray<{ present?: unknown }>;
  return rows.length > 0;
}

async function collectLocators(
  queryRunner: QueryRunner,
  table: string,
  where: string,
): Promise<string> {
  const rows = (await queryRunner.query(
    `SELECT \`id\` AS locator
       FROM \`${table}\`
      WHERE ${where}
      ORDER BY \`id\`
      LIMIT ${SAMPLE_LIMIT}`,
  )) as ReadonlyArray<{ locator?: unknown }>;
  return rows.map((row) => String(row.locator)).join(', ');
}

/**
 * 兼容预检：覆盖“本次迁移会把既有合法行变为非法”的收紧项，以及其他旧合法状态组合。
 *
 * 1. `chk_ai_conversation_completion`：31 态允许 ACTIVE 会话已有反馈，
 *    本迁移要求 ACTIVE 时 `ai_feedback` 必须为空；
 * 2. `chk_repair_request_closure_reason`：本迁移要求 INTERRUPTED/UNREPAIRABLE
 *    必须有 `closure_reason`。冻结清单命中的历史行由 `is_historical` 豁免；
 *    清单外缺少原因的行不编造原因，如实报告并中止；
 * 3. maintenance_report / local_backup_run / reference_document 的旧值域与组合预检。
 *
 * 判定先于任何 ALTER 执行：失败时迁移历史不会前进，库内也不会出现半迁移结构。
 * 错误信息只含计数与主键 ID，不输出业务正文。
 */
async function assertLegacyDataCompatible(
  queryRunner: QueryRunner,
  legacyManifest: LegacyRepairIdentityManifest | null,
): Promise<void> {
  const details: string[] = [];

  const conversationViolations = toCount(
    (await queryRunner.query(
      `SELECT COUNT(*) AS total
         FROM \`ai_conversation\`
        WHERE \`status\` = 'ACTIVE'
          AND \`ai_feedback\` IS NOT NULL`,
    )) as ReadonlyArray<CountRow>,
  );
  if (conversationViolations > 0) {
    const locators = await collectLocators(
      queryRunner,
      'ai_conversation',
      "`status` = 'ACTIVE' AND `ai_feedback` IS NOT NULL",
    );
    details.push(
      `  - ai_conversation：ACTIVE 且已有 ai_feedback 的历史会话 ${String(
        conversationViolations,
      )} 条（ID：${locators}${conversationViolations > SAMPLE_LIMIT ? ' …' : ''}）`,
    );
  }

  const hasClosureReason = await columnExists(queryRunner, 'repair_request', 'closure_reason');
  const missingClosureReason = hasClosureReason
    ? '(`closure_reason` IS NULL OR CHAR_LENGTH(TRIM(`closure_reason`)) = 0)'
    : '1 = 1';
  const closureWhere =
    "`handling_result` IN ('INTERRUPTED', 'UNREPAIRABLE') AND " + missingClosureReason;
  const closureRows = (await queryRunner.query(
    `SELECT \`id\` AS id
       FROM \`repair_request\`
      WHERE ${closureWhere}
      ORDER BY \`id\``,
  )) as ReadonlyArray<{ id?: unknown }>;
  const legacyIds = new Set((legacyManifest?.rows ?? []).map((row) => row.id));
  const unclassifiedClosure = closureRows
    .map((row) => Number(row.id))
    .filter((id) => !legacyIds.has(id));
  if (unclassifiedClosure.length > 0) {
    const sample = unclassifiedClosure.slice(0, SAMPLE_LIMIT).join(', ');
    details.push(
      `  - repair_request：缺少 closure_reason 且不在冻结历史清单内的工单 ${String(
        unclassifiedClosure.length,
      )} 条（ID：${sample}${unclassifiedClosure.length > SAMPLE_LIMIT ? ' …' : ''}）`,
    );
  }

  // 其他旧合法状态组合：只做预检，不修数据；任何越界组合都在 ALTER 前失败关闭。
  const reportStatusViolations = toCount(
    (await queryRunner.query(
      `SELECT COUNT(*) AS total
         FROM \`maintenance_report\`
        WHERE \`status\` NOT IN ('DRAFT', 'SUBMITTED', 'PENDING_REVIEW', 'RETURNED', 'APPROVED')`,
    )) as ReadonlyArray<CountRow>,
  );
  if (reportStatusViolations > 0) {
    details.push(
      `  - maintenance_report：状态值不在新旧合法集合内的旧行 ${String(reportStatusViolations)} 条`,
    );
  }
  const reportConsistencyViolations = toCount(
    (await queryRunner.query(
      `SELECT COUNT(*) AS total
         FROM \`maintenance_report\`
        WHERE NOT (
          (\`status\` = 'DRAFT' AND \`current_version_no\` = 0
            AND \`last_submitted_at\` IS NULL AND \`last_reviewed_at\` IS NULL)
          OR (\`status\` IN ('SUBMITTED', 'PENDING_REVIEW') AND \`current_version_no\` >= 1
            AND \`last_submitted_at\` IS NOT NULL AND \`last_reviewed_at\` IS NULL)
          OR (\`status\` IN ('RETURNED', 'APPROVED') AND \`current_version_no\` >= 1
            AND \`last_submitted_at\` IS NOT NULL AND \`last_reviewed_at\` IS NOT NULL)
        )`,
    )) as ReadonlyArray<CountRow>,
  );
  if (reportConsistencyViolations > 0) {
    details.push(
      `  - maintenance_report：状态与版本/提交/审核时间不一致的旧行 ${String(
        reportConsistencyViolations,
      )} 条`,
    );
  }
  const backupTriggerViolations = toCount(
    (await queryRunner.query(
      `SELECT COUNT(*) AS total
         FROM \`local_backup_run\`
        WHERE \`trigger_type\` NOT IN ('SCHEDULED', 'MANUAL', 'AUTO', 'RETRY', 'USB_EXPORT')`,
    )) as ReadonlyArray<CountRow>,
  );
  if (backupTriggerViolations > 0) {
    details.push(
      `  - local_backup_run：trigger_type 不在新旧合法集合内的旧行 ${String(
        backupTriggerViolations,
      )} 条`,
    );
  }
  const ingestViolations = toCount(
    (await queryRunner.query(
      `SELECT COUNT(*) AS total
         FROM \`reference_document\`
        WHERE \`ingest_method\` NOT IN
          ('ADMIN_DIRECT', 'REVIEWED_SUBMISSION', 'SYSTEM_IMPORT', 'DIRECT_SUBMISSION')`,
    )) as ReadonlyArray<CountRow>,
  );
  if (ingestViolations > 0) {
    details.push(
      `  - reference_document：ingest_method 不在新旧合法集合内的旧行 ${String(
        ingestViolations,
      )} 条`,
    );
  }

  if (details.length === 0) {
    return;
  }

  throw new Error(
    '[alter-repair-ai-report] 升级兼容预检失败：既有合法行会被后续约束拒绝，' +
      '未执行任何 ALTER。\n' +
      `${details.join('\n')}\n` +
      '处置约束：不得编造 closure_reason，不得静默改评分，也不得把历史工单当作新工单；' +
      '历史工单只能来自库外冻结 ID/指纹清单，清单外缺少原因的行必须由业务确认后再升级。',
  );
}

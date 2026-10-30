import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 工程师自助注册申请与组织审核记录表。
 *
 * 只新增申请记录，不改动既有账号、资料与成员关系；不把申请状态混入账号状态，
 * 也不为历史客户/工程师回填申请。待审唯一性由生成列 `pending_account_id` 上的
 * 唯一键保证：同一账号同时最多一份 PENDING 申请，终态行共享 NULL 不受限制。
 * 外键只证明引用存在；审核管理员属于目标组织、目标账号确为待审工程师等事实
 * 必须由审核事务在锁内校验。
 */
export class CreateEngineerRegistrationApplication1775401500000 implements MigrationInterface {
  name = 'CreateEngineerRegistrationApplication1775401500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`engineer_registration_application\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '申请记录主键ID',
        \`account_id\` int NOT NULL COMMENT '待审工程师账号ID',
        \`organization_id\` int NOT NULL COMMENT '本次申请的目标组织ID',
        \`status\` varchar(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/APPROVED/REJECTED',
        \`application_note\` varchar(2000) DEFAULT NULL COMMENT '申请说明；可空',
        \`submitted_at\` timestamp(3) NOT NULL COMMENT '提交时间（系统事件时间）',
        \`reviewed_by_account_id\` int DEFAULT NULL COMMENT '审核管理员账号ID；待审为空',
        \`reviewed_at\` timestamp(3) NULL DEFAULT NULL COMMENT '审核事件时间；待审为空',
        \`review_comment\` varchar(2000) DEFAULT NULL COMMENT '审核意见；拒绝必填非空白，通过可空',
        \`pending_account_id\` int GENERATED ALWAYS AS (
          IF(\`status\` = 'PENDING', \`account_id\`, NULL)
        ) STORED COMMENT '生成列：PENDING 时为账号ID，否则为 NULL',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（系统事件时间）',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（系统事件时间）',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_engineer_registration_application_pending_account\` (\`pending_account_id\`),
        KEY \`idx_engineer_registration_application_org_status_submitted\` (\`organization_id\`, \`status\`, \`submitted_at\`, \`id\`),
        KEY \`idx_engineer_registration_application_account_submitted\` (\`account_id\`, \`submitted_at\`, \`id\`),
        CONSTRAINT \`fk_engineer_registration_application_account\` FOREIGN KEY (\`account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_engineer_registration_application_organization\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_engineer_registration_application_reviewer\` FOREIGN KEY (\`reviewed_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_engineer_registration_application_status\` CHECK (\`status\` IN ('PENDING', 'APPROVED', 'REJECTED')),
        CONSTRAINT \`chk_engineer_registration_application_pending_review\` CHECK (
          (\`status\` = 'PENDING' AND \`reviewed_by_account_id\` IS NULL AND \`reviewed_at\` IS NULL AND \`review_comment\` IS NULL)
          OR \`status\` <> 'PENDING'
        ),
        CONSTRAINT \`chk_engineer_registration_application_reviewed\` CHECK (
          \`status\` = 'PENDING'
          OR (\`reviewed_by_account_id\` IS NOT NULL AND \`reviewed_at\` IS NOT NULL)
        ),
        CONSTRAINT \`chk_engineer_registration_application_reject_comment\` CHECK (
          \`status\` <> 'REJECTED'
          OR (\`review_comment\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`review_comment\`)) > 0)
        ),
        CONSTRAINT \`chk_engineer_registration_application_review_time\` CHECK (
          \`reviewed_at\` IS NULL OR \`reviewed_at\` >= \`submitted_at\`
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='工程师自助注册申请与组织审核记录表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `engineer_registration_application`;');
  }
}

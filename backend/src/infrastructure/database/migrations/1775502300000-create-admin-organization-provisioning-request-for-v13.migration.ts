import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 一级管理员「新增公司档案」的开通提交标识（幂等台账）。
 *
 * 用途：同一次提交（用途 + 可信操作者 + 提交标识）只产生一家公司与一个二级管理员；
 * 事务内先落 PENDING 行作为唯一键串行点，创建完成后更新为 COMPLETED。
 * 三个外键全部 RESTRICT，不产生级联删除；本表不存任何凭据或输入原文。
 */
export class CreateAdminOrganizationProvisioningRequestForV131775502300000 implements MigrationInterface {
  name = 'CreateAdminOrganizationProvisioningRequestForV131775502300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`admin_organization_provisioning_request\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '开通请求主键ID',
        \`purpose\` varchar(32) NOT NULL COMMENT '开通用途；当前仅 ADMIN_CREATE_ORGANIZATION',
        \`submission_key\` varchar(36) NOT NULL COMMENT '提交标识（UUID）；同次提交重试复用',
        \`actor_account_id\` int NOT NULL COMMENT '可信操作者账号（请求期会话账号）',
        \`input_fingerprint\` char(64) NOT NULL COMMENT '规范化输入 SHA-256',
        \`state\` varchar(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING=进行中；COMPLETED=已完成',
        \`organization_id\` int DEFAULT NULL COMMENT '已开通公司',
        \`admin_account_id\` int DEFAULT NULL COMMENT '已开通二级管理员账号',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_provisioning_purpose_actor_key\` (\`purpose\`, \`actor_account_id\`, \`submission_key\`),
        KEY \`idx_provisioning_organization\` (\`organization_id\`),
        KEY \`idx_provisioning_admin_account\` (\`admin_account_id\`),
        CONSTRAINT \`fk_provisioning_actor\` FOREIGN KEY (\`actor_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_provisioning_organization\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_provisioning_admin_account\` FOREIGN KEY (\`admin_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_provisioning_purpose\` CHECK (\`purpose\` = 'ADMIN_CREATE_ORGANIZATION'),
        CONSTRAINT \`chk_provisioning_state\` CHECK (\`state\` IN ('PENDING', 'COMPLETED')),
        CONSTRAINT \`chk_provisioning_key_nonempty\` CHECK (CHAR_LENGTH(TRIM(\`submission_key\`)) > 0),
        CONSTRAINT \`chk_provisioning_fingerprint_length\` CHECK (CHAR_LENGTH(\`input_fingerprint\`) = 64),
        CONSTRAINT \`chk_provisioning_completion\` CHECK (
          \`state\` = 'PENDING'
          OR (\`organization_id\` IS NOT NULL AND \`admin_account_id\` IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='一级管理员新增公司开通提交标识（幂等）';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `admin_organization_provisioning_request`;');
  }
}

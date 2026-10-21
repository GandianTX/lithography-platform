import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateContentSubmissionTable1775301200000 implements MigrationInterface {
  name = 'CreateContentSubmissionTable1775301200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`content_submission\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '投稿主键ID',
        \`submission_kind\` varchar(32) NOT NULL COMMENT '投稿类别：MATERIAL=普通资料；FAULT_CASE=故障案例',
        \`owner_organization_id\` int NOT NULL COMMENT '所属组织ID',
        \`submitted_by_account_id\` int NOT NULL COMMENT '投稿人账号ID',
        \`status\` varchar(32) NOT NULL DEFAULT 'DRAFT' COMMENT '投稿状态：DRAFT/PENDING_REVIEW/RETURNED/PUBLISHED',
        \`current_revision_no\` int unsigned NOT NULL DEFAULT '0' COMMENT '当前送审版本号；0=尚未送审',
        \`last_submitted_at\` timestamp(3) NULL DEFAULT NULL COMMENT '最近送审时间（系统事件时间）',
        \`published_at\` timestamp(3) NULL DEFAULT NULL COMMENT '最近发布时间（系统事件时间）',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（系统事件时间）',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（系统事件时间）',
        PRIMARY KEY (\`id\`),
        KEY \`idx_content_submission_org_status_updated\` (\`owner_organization_id\`,\`status\`,\`updated_at\`),
        KEY \`idx_content_submission_submitter_status_updated\` (\`submitted_by_account_id\`,\`status\`,\`updated_at\`),
        CONSTRAINT \`fk_content_submission_owner_organization\` FOREIGN KEY (\`owner_organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_content_submission_submitted_by_account\` FOREIGN KEY (\`submitted_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_content_submission_kind\` CHECK (\`submission_kind\` IN ('MATERIAL', 'FAULT_CASE')),
        CONSTRAINT \`chk_content_submission_status\` CHECK (\`status\` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'PUBLISHED')),
        CONSTRAINT \`chk_content_submission_revision_consistency\` CHECK (
          (\`status\` = 'DRAFT' AND \`current_revision_no\` = 0 AND \`last_submitted_at\` IS NULL)
          OR
          (\`status\` <> 'DRAFT' AND \`current_revision_no\` >= 1 AND \`last_submitted_at\` IS NOT NULL)
        ),
        CONSTRAINT \`chk_content_submission_publish_consistency\` CHECK (
          (\`status\` = 'PUBLISHED' AND \`published_at\` IS NOT NULL)
          OR
          (\`status\` <> 'PUBLISHED' AND \`published_at\` IS NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='内容投稿主表（资料/案例草稿与送审状态）';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `content_submission`;');
  }
}

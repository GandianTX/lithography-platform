import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateContentSubmissionRevisionTable1775301600000 implements MigrationInterface {
  name = 'CreateContentSubmissionRevisionTable1775301600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`content_submission_revision\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '送审版本主键ID',
        \`submission_id\` int NOT NULL COMMENT '所属投稿ID',
        \`revision_no\` int unsigned NOT NULL COMMENT '版本号；从 1 开始递增',
        \`payload_snapshot\` json NOT NULL COMMENT '送审内容完整快照',
        \`schema_version\` smallint unsigned NOT NULL DEFAULT '1' COMMENT '快照 schema 版本',
        \`title_snapshot\` varchar(255) NOT NULL COMMENT '标题快照',
        \`attachment_id\` int DEFAULT NULL COMMENT '当次送审冻结附件ID；为空表示纯文本投稿',
        \`notice_version\` varchar(64) NOT NULL COMMENT '入库告知版本（服务端固定）',
        \`confirmed_by_account_id\` int NOT NULL COMMENT '入库告知确认人账号ID',
        \`confirmed_at\` timestamp(3) NOT NULL COMMENT '入库告知确认时间（系统事件时间）',
        \`submitted_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '送审时间（系统事件时间）',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_content_submission_revision_submission_no\` (\`submission_id\`,\`revision_no\`),
        UNIQUE KEY \`uk_content_submission_revision_id_submission\` (\`id\`,\`submission_id\`),
        KEY \`idx_content_submission_revision_attachment\` (\`attachment_id\`,\`submission_id\`),
        KEY \`idx_content_submission_revision_confirmed_by\` (\`confirmed_by_account_id\`),
        CONSTRAINT \`fk_content_submission_revision_submission\` FOREIGN KEY (\`submission_id\`) REFERENCES \`content_submission\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_content_submission_revision_attachment\` FOREIGN KEY (\`attachment_id\`,\`submission_id\`) REFERENCES \`content_submission_attachment\` (\`id\`,\`submission_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_content_submission_revision_confirmed_by_account\` FOREIGN KEY (\`confirmed_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_content_submission_revision_no\` CHECK (\`revision_no\` >= 1),
        CONSTRAINT \`chk_content_submission_revision_title\` CHECK (CHAR_LENGTH(TRIM(\`title_snapshot\`)) > 0),
        CONSTRAINT \`chk_content_submission_revision_notice\` CHECK (CHAR_LENGTH(TRIM(\`notice_version\`)) > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='投稿送审冻结版本表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `content_submission_revision`;');
  }
}

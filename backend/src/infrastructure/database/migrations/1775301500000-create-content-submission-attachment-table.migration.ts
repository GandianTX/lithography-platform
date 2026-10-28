import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateContentSubmissionAttachmentTable1775301500000 implements MigrationInterface {
  name = 'CreateContentSubmissionAttachmentTable1775301500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`content_submission_attachment\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '附件主键ID',
        \`submission_id\` int NOT NULL COMMENT '所属投稿ID',
        \`original_filename\` varchar(255) NOT NULL COMMENT '原始文件名',
        \`mime_type\` varchar(127) NOT NULL COMMENT '文件MIME类型',
        \`byte_size\` int unsigned NOT NULL COMMENT '文件实际字节大小（依据服务端接收字节）',
        \`storage_backend\` varchar(32) NOT NULL COMMENT '私有存储后端',
        \`storage_reference\` varchar(512) NOT NULL COMMENT '私有存储引用',
        \`uploaded_by_account_id\` int NOT NULL COMMENT '上传人账号ID',
        \`status\` varchar(16) NOT NULL DEFAULT 'CURRENT' COMMENT '附件状态：CURRENT=当前有效；RETIRED=已退役',
        \`uploaded_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '上传时间（系统事件时间）',
        \`retired_at\` timestamp(3) NULL DEFAULT NULL COMMENT '退役时间（系统事件时间）',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_content_submission_attachment_id_submission\` (\`id\`,\`submission_id\`),
        KEY \`idx_content_submission_attachment_submission_status\` (\`submission_id\`,\`status\`),
        KEY \`idx_content_submission_attachment_uploaded_by\` (\`uploaded_by_account_id\`),
        CONSTRAINT \`fk_content_submission_attachment_submission\` FOREIGN KEY (\`submission_id\`) REFERENCES \`content_submission\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_content_submission_attachment_uploaded_by_account\` FOREIGN KEY (\`uploaded_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_content_submission_attachment_status\` CHECK (\`status\` IN ('CURRENT', 'RETIRED')),
        CONSTRAINT \`chk_content_submission_attachment_retire_consistency\` CHECK (
          (\`status\` = 'CURRENT' AND \`retired_at\` IS NULL)
          OR
          (\`status\` = 'RETIRED' AND \`retired_at\` IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='投稿私有附件表（单附件模型）';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `content_submission_attachment`;');
  }
}

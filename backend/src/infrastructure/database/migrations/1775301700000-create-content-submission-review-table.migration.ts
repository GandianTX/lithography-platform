import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateContentSubmissionReviewTable1775301700000 implements MigrationInterface {
  name = 'CreateContentSubmissionReviewTable1775301700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`content_submission_review\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '审核记录主键ID',
        \`submission_id\` int NOT NULL COMMENT '所属投稿ID',
        \`revision_id\` int NOT NULL COMMENT '被审核的冻结版本ID',
        \`decision\` varchar(16) NOT NULL COMMENT '审核决定：RETURN=退回；APPROVE=通过',
        \`reviewed_by_account_id\` int NOT NULL COMMENT '审核人账号ID',
        \`comment\` varchar(2000) DEFAULT NULL COMMENT '审核意见；退回时必填',
        \`publish_attachment\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '通过时是否将当次附件发布为正式文件',
        \`reviewed_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '审核时间（系统事件时间）',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_content_submission_review_revision\` (\`revision_id\`),
        KEY \`idx_content_submission_review_revision_submission\` (\`revision_id\`,\`submission_id\`),
        KEY \`idx_content_submission_review_submission_reviewed\` (\`submission_id\`,\`reviewed_at\`),
        KEY \`idx_content_submission_review_reviewed_by\` (\`reviewed_by_account_id\`),
        CONSTRAINT \`fk_content_submission_review_revision\` FOREIGN KEY (\`revision_id\`,\`submission_id\`) REFERENCES \`content_submission_revision\` (\`id\`,\`submission_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_content_submission_review_reviewed_by_account\` FOREIGN KEY (\`reviewed_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_content_submission_review_decision\` CHECK (\`decision\` IN ('RETURN', 'APPROVE')),
        CONSTRAINT \`chk_content_submission_review_comment\` CHECK (
          \`decision\` <> 'RETURN' OR (\`comment\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`comment\`)) > 0)
        ),
        CONSTRAINT \`chk_content_submission_review_publish_flag\` CHECK (
          \`decision\` <> 'RETURN' OR \`publish_attachment\` = 0
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='投稿审核记录表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `content_submission_review`;');
  }
}

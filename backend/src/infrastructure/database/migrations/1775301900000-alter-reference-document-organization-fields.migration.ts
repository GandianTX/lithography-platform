import { MigrationInterface, QueryRunner } from 'typeorm';

export class AlterReferenceDocumentOrganizationFields1775301900000 implements MigrationInterface {
  name = 'AlterReferenceDocumentOrganizationFields1775301900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 第一步：追加可空新列，不打断既有写入路径
    await queryRunner.query(`
      ALTER TABLE \`reference_document\`
        ADD COLUMN \`owner_organization_id\` int DEFAULT NULL COMMENT '所属组织ID' AFTER \`created_by_account_id\`,
        ADD COLUMN \`ingest_method\` varchar(32) DEFAULT NULL COMMENT '入库方式：ADMIN_DIRECT=管理员直建；REVIEWED_SUBMISSION=审核发布；SYSTEM_IMPORT=预留' AFTER \`owner_organization_id\`,
        ADD COLUMN \`source_submission_id\` int DEFAULT NULL COMMENT '来源投稿ID；管理员直建为空' AFTER \`ingest_method\`,
        ADD COLUMN \`source_revision_id\` int DEFAULT NULL COMMENT '来源送审版本ID；必须属于来源投稿' AFTER \`source_submission_id\`,
        ADD COLUMN \`equipment_model_text\` varchar(100) DEFAULT NULL COMMENT '机型文字（用户手填）；与机型ID互斥' AFTER \`source_revision_id\`,
        ADD COLUMN \`updated_by_account_id\` int DEFAULT NULL COMMENT '最后修改人账号ID；正式更正时必写' AFTER \`equipment_model_text\`,
        ADD COLUMN \`extension_json\` json DEFAULT NULL COMMENT '按 schema_version 校验的补充属性' AFTER \`updated_by_account_id\`,
        ADD COLUMN \`schema_version\` smallint unsigned NOT NULL DEFAULT '1' COMMENT '内容 schema 版本' AFTER \`extension_json\`;
    `);

    // 第二步：幂等建立甲方默认组织（业务初始化记录），并回填旧资料归属与入库方式
    await queryRunner.query(`
      INSERT IGNORE INTO \`organization\` (\`organization_code\`, \`name\`, \`kind\`, \`status\`)
      VALUES ('CLIENT_DEFAULT', '甲方默认组织', 'CLIENT', 'ACTIVE');
    `);
    await queryRunner.query(`
      UPDATE \`reference_document\`
      SET \`owner_organization_id\` = (
        SELECT \`id\` FROM \`organization\` WHERE \`organization_code\` = 'CLIENT_DEFAULT'
      )
      WHERE \`owner_organization_id\` IS NULL;
    `);
    await queryRunner.query(`
      UPDATE \`reference_document\` SET \`ingest_method\` = 'ADMIN_DIRECT' WHERE \`ingest_method\` IS NULL;
    `);

    // 第三步：归属回填完成后收紧 NOT NULL，再补索引、外键与检查约束
    await queryRunner.query(`
      ALTER TABLE \`reference_document\`
        MODIFY COLUMN \`owner_organization_id\` int NOT NULL COMMENT '所属组织ID',
        MODIFY COLUMN \`ingest_method\` varchar(32) NOT NULL DEFAULT 'ADMIN_DIRECT' COMMENT '入库方式：ADMIN_DIRECT=管理员直建；REVIEWED_SUBMISSION=审核发布；SYSTEM_IMPORT=预留';
    `);
    await queryRunner.query(`
      ALTER TABLE \`reference_document\`
        ADD UNIQUE KEY \`uk_reference_document_source_submission\` (\`source_submission_id\`),
        ADD KEY \`idx_reference_document_source_revision\` (\`source_revision_id\`,\`source_submission_id\`),
        ADD KEY \`idx_reference_document_org_deleted_created\` (\`owner_organization_id\`,\`deleted_at\`,\`created_at\`),
        ADD CONSTRAINT \`fk_reference_document_owner_organization\` FOREIGN KEY (\`owner_organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`fk_reference_document_source_submission\` FOREIGN KEY (\`source_submission_id\`) REFERENCES \`content_submission\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`fk_reference_document_source_revision\` FOREIGN KEY (\`source_revision_id\`,\`source_submission_id\`) REFERENCES \`content_submission_revision\` (\`id\`,\`submission_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`fk_reference_document_updated_by_account\` FOREIGN KEY (\`updated_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`chk_reference_document_ingest_method\` CHECK (\`ingest_method\` IN ('ADMIN_DIRECT', 'REVIEWED_SUBMISSION', 'SYSTEM_IMPORT')),
        ADD CONSTRAINT \`chk_reference_document_source_pair\` CHECK (
          (\`source_submission_id\` IS NULL AND \`source_revision_id\` IS NULL)
          OR
          (\`source_submission_id\` IS NOT NULL AND \`source_revision_id\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_reference_document_model_exclusive\` CHECK (
          \`equipment_model_id\` IS NULL OR \`equipment_model_text\` IS NULL
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`reference_document\`
        DROP FOREIGN KEY \`fk_reference_document_source_revision\`,
        DROP FOREIGN KEY \`fk_reference_document_source_submission\`,
        DROP FOREIGN KEY \`fk_reference_document_owner_organization\`,
        DROP FOREIGN KEY \`fk_reference_document_updated_by_account\`;
    `);
    await queryRunner.query(`
      ALTER TABLE \`reference_document\`
        DROP CHECK \`chk_reference_document_ingest_method\`,
        DROP CHECK \`chk_reference_document_source_pair\`,
        DROP CHECK \`chk_reference_document_model_exclusive\`,
        DROP INDEX \`uk_reference_document_source_submission\`,
        DROP INDEX \`idx_reference_document_source_revision\`,
        DROP INDEX \`idx_reference_document_org_deleted_created\`,
        DROP COLUMN \`schema_version\`,
        DROP COLUMN \`extension_json\`,
        DROP COLUMN \`updated_by_account_id\`,
        DROP COLUMN \`equipment_model_text\`,
        DROP COLUMN \`source_revision_id\`,
        DROP COLUMN \`source_submission_id\`,
        DROP COLUMN \`ingest_method\`,
        DROP COLUMN \`owner_organization_id\`;
    `);
  }
}

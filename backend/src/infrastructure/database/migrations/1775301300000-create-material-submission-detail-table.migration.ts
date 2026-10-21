import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMaterialSubmissionDetailTable1775301300000 implements MigrationInterface {
  name = 'CreateMaterialSubmissionDetailTable1775301300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`material_submission_detail\` (
        \`submission_id\` int NOT NULL COMMENT '投稿ID（主键即投稿外键）',
        \`title\` varchar(255) DEFAULT NULL COMMENT '资料标题',
        \`document_type\` varchar(100) DEFAULT NULL COMMENT '资料类型；不允许 FAULT_CASE',
        \`equipment_model_id\` int DEFAULT NULL COMMENT '适用设备型号ID；与机型文字互斥',
        \`equipment_model_text\` varchar(100) DEFAULT NULL COMMENT '机型文字（用户手填）；与机型ID互斥',
        \`description\` varchar(2000) DEFAULT NULL COMMENT '资料说明',
        \`content_text\` longtext DEFAULT NULL COMMENT '资料正文',
        \`extension_json\` json DEFAULT NULL COMMENT '按 schema_version 校验的补充属性',
        \`schema_version\` smallint unsigned NOT NULL DEFAULT '1' COMMENT '明细 schema 版本',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（系统事件时间）',
        PRIMARY KEY (\`submission_id\`),
        KEY \`idx_material_submission_detail_equipment_model\` (\`equipment_model_id\`),
        CONSTRAINT \`fk_material_submission_detail_submission\` FOREIGN KEY (\`submission_id\`) REFERENCES \`content_submission\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_material_submission_detail_equipment_model\` FOREIGN KEY (\`equipment_model_id\`) REFERENCES \`equipment_model\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_material_submission_detail_model_exclusive\` CHECK (\`equipment_model_id\` IS NULL OR \`equipment_model_text\` IS NULL),
        CONSTRAINT \`chk_material_submission_detail_type\` CHECK (\`document_type\` IS NULL OR \`document_type\` <> 'FAULT_CASE')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='普通资料投稿明细表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `material_submission_detail`;');
  }
}

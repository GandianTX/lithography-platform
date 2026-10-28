import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrganizationTable1775301000000 implements MigrationInterface {
  name = 'CreateOrganizationTable1775301000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`organization\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '组织主键ID',
        \`organization_code\` varchar(64) NOT NULL COMMENT '组织业务编码',
        \`name\` varchar(100) NOT NULL COMMENT '组织名称',
        \`kind\` varchar(16) NOT NULL COMMENT '组织类别：CLIENT=甲方；PEER=同行',
        \`status\` varchar(16) NOT NULL DEFAULT 'ACTIVE' COMMENT '组织状态：ACTIVE=启用；DISABLED=停用',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（系统事件时间）',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（系统事件时间）',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_organization_code\` (\`organization_code\`),
        KEY \`idx_organization_kind_status\` (\`kind\`,\`status\`),
        CONSTRAINT \`chk_organization_kind\` CHECK (\`kind\` IN ('CLIENT', 'PEER')),
        CONSTRAINT \`chk_organization_status\` CHECK (\`status\` IN ('ACTIVE', 'DISABLED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='组织表（甲方/同行）';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `organization`;');
  }
}

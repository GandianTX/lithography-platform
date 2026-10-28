import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrganizationMembershipTable1775301100000 implements MigrationInterface {
  name = 'CreateOrganizationMembershipTable1775301100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`organization_membership\` (
        \`id\` int NOT NULL AUTO_INCREMENT COMMENT '成员关系主键ID',
        \`organization_id\` int NOT NULL COMMENT '组织ID',
        \`account_id\` int NOT NULL COMMENT '账号ID',
        \`member_role\` varchar(32) NOT NULL COMMENT '组织内角色：SUPER_ADMIN=组织管理员；ENGINEER=工程师',
        \`status\` varchar(16) NOT NULL DEFAULT 'ACTIVE' COMMENT '成员状态：ACTIVE=在籍；LEFT=已退出',
        \`joined_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '加入时间（系统事件时间）',
        \`left_at\` timestamp(3) NULL DEFAULT NULL COMMENT '退出时间（系统事件时间）',
        \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（系统事件时间）',
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（系统事件时间）',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_organization_membership_org_account\` (\`organization_id\`,\`account_id\`),
        KEY \`idx_organization_membership_account_status\` (\`account_id\`,\`status\`),
        CONSTRAINT \`fk_organization_membership_organization\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`fk_organization_membership_account\` FOREIGN KEY (\`account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT \`chk_organization_membership_role\` CHECK (\`member_role\` IN ('SUPER_ADMIN', 'ENGINEER')),
        CONSTRAINT \`chk_organization_membership_status\` CHECK (\`status\` IN ('ACTIVE', 'LEFT')),
        CONSTRAINT \`chk_organization_membership_period\` CHECK (
          (\`status\` = 'ACTIVE' AND \`left_at\` IS NULL)
          OR
          (\`status\` = 'LEFT' AND \`left_at\` IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='组织成员关系表';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `organization_membership`;');
  }
}

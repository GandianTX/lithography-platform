import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 组织成员增量：
 * 1. 成员角色扩展为客户（CUSTOMER）；
 * 2. 通过生成列 + 唯一索引保证「同一账号至多一条 ACTIVE 归属」由数据库兜底；
 * 3. 增加组织内角色/状态查询索引。
 *
 * 存量若已存在同账号多条 ACTIVE 归属，则不猜测保留哪一条，直接中止迁移并报告。
 */
export class AlterOrganizationMembershipCustomerSingleActive1775401000000 implements MigrationInterface {
  name = 'AlterOrganizationMembershipCustomerSingleActive1775401000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const conflicts = (await queryRunner.query(`
      SELECT \`account_id\`, COUNT(*) AS \`total\`
      FROM \`organization_membership\`
      WHERE \`status\` = 'ACTIVE'
      GROUP BY \`account_id\`
      HAVING COUNT(*) > 1;
    `)) as Array<{ account_id: number; total: number }>;
    if (conflicts.length > 0) {
      const accountIds = conflicts.map((item) => item.account_id).join(', ');
      throw new Error(
        `[${this.name}] 存在同一账号多条 ACTIVE 成员关系，无法建立单有效组织唯一约束；待人工核对账号：${accountIds}`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE \`organization_membership\`
        DROP CHECK \`chk_organization_membership_role\`,
        ADD CONSTRAINT \`chk_organization_membership_role\`
          CHECK (\`member_role\` IN ('SUPER_ADMIN', 'ENGINEER', 'CUSTOMER'));
    `);

    await queryRunner.query(`
      ALTER TABLE \`organization_membership\`
        ADD COLUMN \`active_account_id\` int
          GENERATED ALWAYS AS (IF(\`status\` = 'ACTIVE', \`account_id\`, NULL)) STORED
          COMMENT '单有效组织生成列：ACTIVE 时为账号ID，否则为 NULL',
        ADD UNIQUE KEY \`uk_organization_membership_active_account\` (\`active_account_id\`),
        ADD KEY \`idx_organization_membership_org_role_status\`
          (\`organization_id\`, \`member_role\`, \`status\`);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`organization_membership\`
        DROP INDEX \`idx_organization_membership_org_role_status\`,
        DROP INDEX \`uk_organization_membership_active_account\`,
        DROP COLUMN \`active_account_id\`;
    `);
    await queryRunner.query(`
      ALTER TABLE \`organization_membership\`
        DROP CHECK \`chk_organization_membership_role\`,
        ADD CONSTRAINT \`chk_organization_membership_role\`
          CHECK (\`member_role\` IN ('SUPER_ADMIN', 'ENGINEER'));
    `);
  }
}

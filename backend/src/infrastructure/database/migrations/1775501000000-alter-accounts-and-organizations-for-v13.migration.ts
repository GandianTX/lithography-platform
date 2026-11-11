import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V13 账户/客户资料/公司字段。
 *
 * - 管理员等级与默认改密限制先以可空/默认值落地，真实账号→等级映射由受控工具另行执行，
 *   迁移本身不推断任何人的等级。
 * - 客户公司只表达“客户所属公司”，不自动授予工程师成员资格。
 */
export class AlterAccountsAndOrganizationsForV131775501000000 implements MigrationInterface {
  name = 'AlterAccountsAndOrganizationsForV131775501000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`base_user_account\`
        ADD COLUMN \`admin_level\` tinyint DEFAULT NULL COMMENT '管理员等级：1=一级；2=二级；NULL=非管理员或未映射',
        ADD COLUMN \`must_change_password\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否必须先修改密码',
        ADD CONSTRAINT \`chk_base_user_account_admin_level\` CHECK (
          \`admin_level\` IS NULL OR \`admin_level\` IN (1, 2)
        );
    `);

    await queryRunner.query(`
      ALTER TABLE \`base_user_info\`
        ADD COLUMN \`real_name\` varchar(200) DEFAULT NULL COMMENT '真实姓名；与昵称分开',
        ADD COLUMN \`customer_organization_id\` int DEFAULT NULL COMMENT '客户所属公司ID；不自动授予工程师成员资格',
        ADD KEY \`idx_base_user_info_customer_organization\` (\`customer_organization_id\`),
        ADD CONSTRAINT \`fk_base_user_info_customer_organization\`
          FOREIGN KEY (\`customer_organization_id\`) REFERENCES \`organization\` (\`id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT;
    `);

    await queryRunner.query(`
      ALTER TABLE \`organization\`
        MODIFY COLUMN \`name\` varchar(200) NOT NULL COMMENT '组织全称；编号不随改名变化',
        ADD COLUMN \`short_name\` varchar(100) DEFAULT NULL COMMENT '简称',
        ADD COLUMN \`contact_name\` varchar(200) DEFAULT NULL COMMENT '联系人姓名',
        ADD COLUMN \`contact_phone\` varchar(100) DEFAULT NULL COMMENT '联系电话；支持区号分机',
        ADD COLUMN \`contact_email\` varchar(254) DEFAULT NULL COMMENT '公司邮箱',
        ADD COLUMN \`address\` varchar(1000) DEFAULT NULL COMMENT '公司地址；不代表维修现场',
        ADD COLUMN \`remark\` text DEFAULT NULL COMMENT '备注',
        ADD COLUMN \`is_service_provider\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否具备维修服务资格；不由注册审批自动打开',
        ADD COLUMN \`is_managed_company\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否属于一级维护的公司名单；仅服务端依据名单写入',
        ADD CONSTRAINT \`chk_organization_service_provider\` CHECK (\`is_service_provider\` IN (0, 1)),
        ADD CONSTRAINT \`chk_organization_managed_company\` CHECK (\`is_managed_company\` IN (0, 1));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`organization\`
        DROP CONSTRAINT \`chk_organization_managed_company\`,
        DROP CONSTRAINT \`chk_organization_service_provider\`,
        DROP COLUMN \`is_managed_company\`,
        DROP COLUMN \`is_service_provider\`,
        DROP COLUMN \`remark\`,
        DROP COLUMN \`address\`,
        DROP COLUMN \`contact_email\`,
        DROP COLUMN \`contact_phone\`,
        DROP COLUMN \`contact_name\`,
        DROP COLUMN \`short_name\`,
        MODIFY COLUMN \`name\` varchar(100) NOT NULL COMMENT '组织名称';
    `);

    await queryRunner.query(`
      ALTER TABLE \`base_user_info\`
        DROP CONSTRAINT \`fk_base_user_info_customer_organization\`,
        DROP INDEX \`idx_base_user_info_customer_organization\`,
        DROP COLUMN \`customer_organization_id\`,
        DROP COLUMN \`real_name\`;
    `);

    await queryRunner.query(`
      ALTER TABLE \`base_user_account\`
        DROP CONSTRAINT \`chk_base_user_account_admin_level\`,
        DROP COLUMN \`must_change_password\`,
        DROP COLUMN \`admin_level\`;
    `);
  }
}

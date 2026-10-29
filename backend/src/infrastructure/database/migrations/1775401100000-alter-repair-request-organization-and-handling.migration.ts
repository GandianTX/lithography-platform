import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 维修申请增量：
 * 1. 新增业务归属 `owner_organization_id`（可空，存量仅按已核实的客户 ACTIVE 成员关系回填；
 *    无证据保持 NULL 并列入异常清单，不按厂家/公司名猜测）；
 * 2. 新增五类处理结果、三种实际处理状态及终结事实列；
 * 3. 结果与状态映射、终结时间、状态前置事实均由 CHECK 约束兜底。
 *
 * 旧单不伪造「完成/未完成」，也不改写既有接单/撤回事实。
 */
export class AlterRepairRequestOrganizationAndHandling1775401100000 implements MigrationInterface {
  name = 'AlterRepairRequestOrganizationAndHandling1775401100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        ADD COLUMN \`owner_organization_id\` int DEFAULT NULL COMMENT '所属组织ID；存量无证据时为空' AFTER \`accepted_at\`,
        ADD COLUMN \`handling_result\` varchar(32) DEFAULT NULL COMMENT '处理结果：FIXED/PART_PURCHASED/PROVIDE_PLAN_SELF_EXECUTE/INTERRUPTED/UNREPAIRABLE' AFTER \`owner_organization_id\`,
        ADD COLUMN \`handling_status\` varchar(16) DEFAULT NULL COMMENT '实际处理状态：COMPLETED/IN_PROGRESS/UNRESOLVED；由服务端按固定映射维护' AFTER \`handling_result\`,
        ADD COLUMN \`handling_recorded_at\` timestamp(3) NULL DEFAULT NULL COMMENT '处理结果记录时间（事件时间）' AFTER \`handling_status\`,
        ADD COLUMN \`handling_recorded_by_account_id\` int DEFAULT NULL COMMENT '处理结果记录人账号ID' AFTER \`handling_recorded_at\`,
        ADD COLUMN \`handling_ended_at\` timestamp(3) NULL DEFAULT NULL COMMENT '终结时间；完成/未完成必填，处理中必须为空' AFTER \`handling_recorded_by_account_id\`;
    `);

    // 存量归属仅按「客户账号存在唯一 ACTIVE 成员关系」回填；无有效成员关系保持 NULL
    await queryRunner.query(`
      UPDATE \`repair_request\` rr
      JOIN \`organization_membership\` m
        ON m.\`account_id\` = rr.\`customer_account_id\`
       AND m.\`status\` = 'ACTIVE'
       AND m.\`member_role\` = 'CUSTOMER'
      SET rr.\`owner_organization_id\` = m.\`organization_id\`
      WHERE rr.\`owner_organization_id\` IS NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        ADD UNIQUE KEY \`uk_repair_request_id_owner\` (\`id\`, \`owner_organization_id\`),
        ADD KEY \`idx_repair_request_owner_created\` (\`owner_organization_id\`, \`created_at\`),
        ADD KEY \`idx_repair_request_owner_status\` (\`owner_organization_id\`, \`handling_status\`),
        ADD KEY \`idx_repair_request_handling_recorder\` (\`handling_recorded_by_account_id\`),
        ADD CONSTRAINT \`fk_repair_request_owner_organization\` FOREIGN KEY (\`owner_organization_id\`) REFERENCES \`organization\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`fk_repair_request_handling_recorder\` FOREIGN KEY (\`handling_recorded_by_account_id\`) REFERENCES \`base_user_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
        ADD CONSTRAINT \`chk_repair_request_handling_result\` CHECK (
          \`handling_result\` IS NULL OR \`handling_result\` IN (
            'FIXED', 'PART_PURCHASED', 'PROVIDE_PLAN_SELF_EXECUTE', 'INTERRUPTED', 'UNREPAIRABLE'
          )
        ),
        ADD CONSTRAINT \`chk_repair_request_handling_status\` CHECK (
          \`handling_status\` IS NULL OR \`handling_status\` IN ('COMPLETED', 'IN_PROGRESS', 'UNRESOLVED')
        ),
        ADD CONSTRAINT \`chk_repair_request_handling_mapping\` CHECK (
          (\`handling_result\` IS NULL AND \`handling_status\` IS NULL)
          OR
          (\`handling_result\` = 'FIXED' AND \`handling_status\` = 'COMPLETED')
          OR
          (\`handling_result\` = 'PART_PURCHASED' AND \`handling_status\` = 'COMPLETED')
          OR
          (\`handling_result\` = 'PROVIDE_PLAN_SELF_EXECUTE' AND \`handling_status\` = 'COMPLETED')
          OR
          (\`handling_result\` = 'INTERRUPTED' AND \`handling_status\` = 'IN_PROGRESS')
          OR
          (\`handling_result\` = 'UNREPAIRABLE' AND \`handling_status\` = 'UNRESOLVED')
        ),
        ADD CONSTRAINT \`chk_repair_request_handling_requires_accepted\` CHECK (
          \`handling_result\` IS NULL OR \`is_accepted\` = 1
        ),
        ADD CONSTRAINT \`chk_repair_request_handling_time\` CHECK (
          (\`handling_result\` IS NULL AND \`handling_ended_at\` IS NULL AND \`handling_recorded_at\` IS NULL)
          OR
          (\`handling_result\` IS NOT NULL AND \`handling_recorded_at\` IS NOT NULL
            AND ((\`handling_status\` = 'IN_PROGRESS' AND \`handling_ended_at\` IS NULL)
              OR (\`handling_status\` IN ('COMPLETED', 'UNRESOLVED') AND \`handling_ended_at\` IS NOT NULL)))
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        DROP CHECK \`chk_repair_request_handling_time\`,
        DROP CHECK \`chk_repair_request_handling_requires_accepted\`,
        DROP CHECK \`chk_repair_request_handling_mapping\`,
        DROP CHECK \`chk_repair_request_handling_status\`,
        DROP CHECK \`chk_repair_request_handling_result\`,
        DROP FOREIGN KEY \`fk_repair_request_handling_recorder\`,
        DROP FOREIGN KEY \`fk_repair_request_owner_organization\`,
        DROP INDEX \`idx_repair_request_handling_recorder\`,
        DROP INDEX \`idx_repair_request_owner_status\`,
        DROP INDEX \`idx_repair_request_owner_created\`,
        DROP INDEX \`uk_repair_request_id_owner\`,
        DROP COLUMN \`handling_ended_at\`,
        DROP COLUMN \`handling_recorded_by_account_id\`,
        DROP COLUMN \`handling_recorded_at\`,
        DROP COLUMN \`handling_status\`,
        DROP COLUMN \`handling_result\`,
        DROP COLUMN \`owner_organization_id\`;
    `);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

const AUDIT_OPERATION_CHECK = 'chk_management_audit_operation';
const TASK10_OPERATIONS = [
  'ADMIN_DELETE_DOCUMENT',
  'CORRECT_DOCUMENT_OWNERSHIP',
  'RESTORE_LOCAL_BUSINESS',
] as const;
const S3_OPERATIONS = ['REISSUE_LEVEL2_CREDENTIAL', 'RESET_LEVEL2_CREDENTIAL'] as const;
const EXTENDED_OPERATIONS = [...TASK10_OPERATIONS, ...S3_OPERATIONS] as const;

function buildCheckClause(operations: ReadonlyArray<string>): string {
  return `\`operation\` IN (${operations.map((operation) => `'${operation}'`).join(', ')})`;
}

/**
 * 扩展管理审计操作 CHECK（S3）。
 *
 * 补发 / 重置二级管理员凭据使用专用审计通道：沿用 `management_audit_event` 的
 * 操作者、目标公司、目标账号与时间列，只把本补丁的两个操作加入白名单；
 * 不放开任务 10 的查询契约，也不修改其已有三类操作。
 */
export class ExtendManagementAuditOperationForV131775502500000 implements MigrationInterface {
  name = 'ExtendManagementAuditOperationForV131775502500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`management_audit_event\`
        DROP CHECK \`${AUDIT_OPERATION_CHECK}\`,
        ADD CONSTRAINT \`${AUDIT_OPERATION_CHECK}\` CHECK (${buildCheckClause(EXTENDED_OPERATIONS)});
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`management_audit_event\`
        DROP CHECK \`${AUDIT_OPERATION_CHECK}\`,
        ADD CONSTRAINT \`${AUDIT_OPERATION_CHECK}\` CHECK (${buildCheckClause(TASK10_OPERATIONS)});
    `);
  }
}

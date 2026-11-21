import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 业务源表持久化稳定身份（第 50 条，前向追加）。
 *
 * 背景（任务 09 后续S1.4／证据 S0 §5）：同步体系里的 `record_uuid` 目前由
 * `deriveRecordUuid(resourceType, 本地自增 ID)` 派生，它只在**本机内**唯一，
 * 跨设备会撞号，因此不能当作跨端稳定身份；同时因为派生键不可反解，读侧只能
 * 按（公司、类型）全表扫描再比对派生值。
 *
 * 本迁移沿用 03 的既有做法（`repair_request_intake.record_uuid` ＋ 唯一索引）：
 * 在三张业务源表上**持久化**稳定身份列 `record_uuid`，由创建入口一次性生成，
 * 此后不再变化；读侧据此按列**定向定位**，不再全表扫描。
 *
 * 兼容口径：
 * - 历史行保持 NULL，**不回填、不伪造**（派生值不是可信跨端身份）；
 * - 唯一索引允许多行 NULL，历史行互不冲突；
 * - 既有派生 UUID 的历史事实（`record_package_item`／`local_upload_task`／
 *   `sync_receipt`）**不被改写**，读侧对这类键保留派生值回退定位；
 * - 不新建表，也不修改已接受的 49 条历史迁移。
 */
const TARGET_TABLES = [
  { table: 'repair_request', index: 'uk_repair_request_record_uuid' },
  { table: 'reference_document', index: 'uk_reference_document_record_uuid' },
  { table: 'maintenance_report', index: 'uk_maintenance_report_record_uuid' },
] as const;

const NEW_COLUMN = 'record_uuid';

export class AddRecordUuidToSourceTablesForV131775502800000 implements MigrationInterface {
  name = 'AddRecordUuidToSourceTablesForV131775502800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreparation(queryRunner);

    for (const target of TARGET_TABLES) {
      await this.executeStep(
        queryRunner,
        `${target.table} 追加稳定身份列与唯一索引`,
        `
        ALTER TABLE \`${target.table}\`
          ADD COLUMN \`${NEW_COLUMN}\` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '跨端稳定业务编号；历史行保持 NULL',
          ADD UNIQUE KEY \`${target.index}\` (\`${NEW_COLUMN}\`)
      `,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回退顺序固定：先删唯一索引，再删列；不改数据、不回填。
    for (const target of TARGET_TABLES) {
      await queryRunner.query(`ALTER TABLE \`${target.table}\` DROP INDEX \`${target.index}\`;`);
      await queryRunner.query(`ALTER TABLE \`${target.table}\` DROP COLUMN \`${NEW_COLUMN}\`;`);
    }
  }

  private async executeStep(queryRunner: QueryRunner, step: string, sql: string): Promise<void> {
    try {
      await queryRunner.query(sql);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 50 条迁移失败于「${step}」；重跑前会由半迁移预检拦截，请人工核对已生效对象。原因：${reason}`,
        { cause: error },
      );
    }
  }

  /**
   * 半迁移保护：前置表缺失或目标列已存在即失败关闭，禁止盲目重跑。
   */
  private async assertPreparation(queryRunner: QueryRunner): Promise<void> {
    for (const target of TARGET_TABLES) {
      if (!(await queryRunner.hasTable(target.table))) {
        throw new Error(`迁移前置表缺失：${target.table}`);
      }
      if (await queryRunner.hasColumn(target.table, NEW_COLUMN)) {
        throw new Error(`检测到半迁移状态：${target.table}.${NEW_COLUMN} 已存在，请人工核对后处理`);
      }
    }
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 维修报告附件关联原件（第 49 条，前向追加）。
 *
 * 只在 maintenance_report_attachment 追加可空 file_id，并对该列建立普通索引与指向
 * stored_file.file_id 的 RESTRICT 外键；列字符集/排序规则显式与 stored_file 一致
 * （utf8mb4 / utf8mb4_0900_ai_ci），避免跨表引用因隐式转换失败。
 *
 * 历史行保持 NULL，不回填、不搬迁、不猜测旧原件；不新建表，也不修改
 * stored_file、maintenance_report_version_attachment 或历史迁移。
 */
const NEW_COLUMNS = ['file_id'] as const;

const NEW_INDEX = 'idx_maintenance_report_attachment_file';

const NEW_FOREIGN_KEY = 'fk_maintenance_report_attachment_file';

export class AddMaintenanceReportAttachmentFileForV131775502700000 implements MigrationInterface {
  name = 'AddMaintenanceReportAttachmentFileForV131775502700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreparation(queryRunner);

    await this.executeStep(
      queryRunner,
      'maintenance_report_attachment 追加原件列与关联约束',
      `
      ALTER TABLE \`maintenance_report_attachment\`
        ADD COLUMN \`file_id\` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '关联原件ID；历史行保持 NULL',
        ADD KEY \`${NEW_INDEX}\` (\`file_id\`),
        ADD CONSTRAINT \`${NEW_FOREIGN_KEY}\` FOREIGN KEY (\`file_id\`) REFERENCES \`stored_file\` (\`file_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
    `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回退顺序固定：先删外键，再删索引，最后删列；不改数据、不猜回填。
    await queryRunner.query(
      `ALTER TABLE \`maintenance_report_attachment\` DROP FOREIGN KEY \`${NEW_FOREIGN_KEY}\`;`,
    );
    await queryRunner.query(
      `ALTER TABLE \`maintenance_report_attachment\` DROP INDEX \`${NEW_INDEX}\`;`,
    );
    await queryRunner.query('ALTER TABLE `maintenance_report_attachment` DROP COLUMN `file_id`;');
  }

  private async executeStep(queryRunner: QueryRunner, step: string, sql: string): Promise<void> {
    try {
      await queryRunner.query(sql);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 49 条迁移失败于「${step}」；重跑前会由半迁移预检拦截，请人工核对已生效对象。原因：${reason}`,
        { cause: error },
      );
    }
  }

  /**
   * 半迁移保护：前置表缺失或目标列已存在即失败关闭，禁止盲目重跑。
   */
  private async assertPreparation(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['maintenance_report_attachment', 'stored_file']) {
      if (!(await queryRunner.hasTable(table))) {
        throw new Error(`迁移前置表缺失：${table}`);
      }
    }
    for (const column of NEW_COLUMNS) {
      if (await queryRunner.hasColumn('maintenance_report_attachment', column)) {
        throw new Error(
          `检测到半迁移状态：maintenance_report_attachment.${column} 已存在，请人工核对后处理`,
        );
      }
    }
  }
}

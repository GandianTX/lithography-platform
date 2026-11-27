import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 账号的跨端稳定标识（第 54 条，前向追加）。
 *
 * 背景（任务 09 S1-2「修复跨安装来源身份」）：
 * 记录包／业务同步在跨设备搬运时，需要把「来源账号」映射到目标设备的**同一个自然人**。
 * 此前包内只携带 `source_account_id`（**源机自增主键**）。同一台目标设备上
 * 「id=7」完全可能是**另一个人**（源机与目标机的账号空间互不相干），
 * 于是按数字 id 选作者会产出**错归属**：把源机工程师的正式报告记到目标机
 * 另一个工程师名下。这不是"可能"，而是双设备各自建号时的常态。
 *
 * 本迁移为账号补一个**真实产生、持久不变、可按列查找**的跨端稳定标识
 * `account_uuid`（与 03/06/07 已有的 `record_uuid` 同一口径）：
 * - 由账号创建入口（`AccountService.insertAccount()`）一次性生成并持久化，
 *   此后不再变化（改名、改密、换公司都不影响它）；
 * - 唯一索引保证「一个标识只对应一个账号行」，可按列定向查找；
 * - **历史行保持 NULL，不回填、不伪造**：派生值（例如按 login_name 派生）
 *   不是可信跨端身份，用它冒充会制造虚假映射。
 *
 * 兼容口径：
 * - 唯一索引允许多行 NULL，历史行互不冲突；
 * - 本迁移不修改任何已接受的历史迁移，也不改写既有账号行的任何既有列；
 * - 账号表在既有库中已存在（`base_user_account`），前置表缺失即失败关闭。
 */
const ACCOUNT_TABLE = 'base_user_account';
const NEW_COLUMN = 'account_uuid';
const NEW_INDEX = 'uk_base_user_account_account_uuid';

export class AddAccountUuidForCrossInstallationIdentityForV131775503300000 implements MigrationInterface {
  name = 'AddAccountUuidForCrossInstallationIdentityForV131775503300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreparation(queryRunner);

    try {
      await queryRunner.query(
        `
        ALTER TABLE \`${ACCOUNT_TABLE}\`
          ADD COLUMN \`${NEW_COLUMN}\` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '跨端稳定账号标识；创建时一次性生成，历史行保持 NULL',
          ADD UNIQUE KEY \`${NEW_INDEX}\` (\`${NEW_COLUMN}\`)
      `,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 54 条迁移失败于「${ACCOUNT_TABLE} 追加跨端稳定账号标识」；重跑前会由半迁移预检拦截，请人工核对已生效对象。原因：${reason}`,
        { cause: error },
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`${ACCOUNT_TABLE}\` DROP INDEX \`${NEW_INDEX}\`;`);
    await queryRunner.query(`ALTER TABLE \`${ACCOUNT_TABLE}\` DROP COLUMN \`${NEW_COLUMN}\`;`);
  }

  /**
   * 半迁移保护：前置表缺失或目标列已存在即失败关闭，禁止盲目重跑。
   */
  private async assertPreparation(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable(ACCOUNT_TABLE))) {
      throw new Error(`迁移前置表缺失：${ACCOUNT_TABLE}`);
    }
    if (await queryRunner.hasColumn(ACCOUNT_TABLE, NEW_COLUMN)) {
      throw new Error(`检测到半迁移状态：${ACCOUNT_TABLE}.${NEW_COLUMN} 已存在，请人工核对后处理`);
    }
  }
}

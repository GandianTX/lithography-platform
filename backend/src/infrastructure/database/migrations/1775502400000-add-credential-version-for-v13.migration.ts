import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 凭据代次列（S3）。
 *
 * 用途：补发、二级专用重置、自助改密与公司启停时递增；访问令牌签发时写入
 * `credentialVersion` 声明，`ValidateAccessTokenSessionUsecase` 每请求比对，
 * 使旧令牌在凭据变更后永久不可用（不依赖布尔强制改密位或到期时间）。
 *
 * 存量行默认 0；旧令牌不含该声明时按 0 处理，因此升级瞬间不会批量踢出在线会话。
 */
export class AddCredentialVersionForV131775502400000 implements MigrationInterface {
  name = 'AddCredentialVersionForV131775502400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`base_user_account\`
        ADD COLUMN \`credential_version\` int unsigned NOT NULL DEFAULT 0
          COMMENT '凭据代次：补发/重置/改密/公司启停时递增，用于永久撤销旧访问令牌'
          AFTER \`must_change_password\`;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`base_user_account\`
        DROP COLUMN \`credential_version\`;
    `);
  }
}

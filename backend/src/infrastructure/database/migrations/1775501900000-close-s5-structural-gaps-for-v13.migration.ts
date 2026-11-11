import { MigrationInterface, QueryRunner } from 'typeorm';

async function dropCheckIfExists(
  queryRunner: QueryRunner,
  table: string,
  checkName: string,
): Promise<void> {
  const rows = (await queryRunner.query(
    `SELECT 1
       FROM information_schema.table_constraints
      WHERE constraint_schema = DATABASE()
        AND table_name = ?
        AND constraint_name = ?
        AND constraint_type = 'CHECK'
      LIMIT 1`,
    [table, checkName],
  )) as ReadonlyArray<unknown>;
  if (rows.length > 0) {
    await queryRunner.query(`ALTER TABLE \`${table}\` DROP CHECK \`${checkName}\``);
  }
}

async function dropIndexIfExists(
  queryRunner: QueryRunner,
  table: string,
  indexName: string,
): Promise<void> {
  const rows = (await queryRunner.query(
    `SELECT 1
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND index_name = ?
      LIMIT 1`,
    [table, indexName],
  )) as ReadonlyArray<unknown>;
  if (rows.length > 0) {
    await queryRunner.query(`ALTER TABLE \`${table}\` DROP INDEX \`${indexName}\``);
  }
}

/**
 * 单条 ALTER 在 MySQL 8 中是原子的：要么整条生效，要么完全未生效。
 * 续跑时以每条 ALTER 的首个列/对象作为“该条已提交”的判据，已存在则整条跳过；
 * 不做逐列猜测，也不回退已提交结构。
 */
async function columnExists(
  queryRunner: QueryRunner,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = (await queryRunner.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?
      LIMIT 1`,
    [table, column],
  )) as ReadonlyArray<unknown>;
  return rows.length > 0;
}

async function constraintExists(
  queryRunner: QueryRunner,
  table: string,
  constraintName: string,
): Promise<boolean> {
  const rows = (await queryRunner.query(
    `SELECT 1
       FROM information_schema.table_constraints
      WHERE constraint_schema = DATABASE()
        AND table_name = ?
        AND constraint_name = ?
      LIMIT 1`,
    [table, constraintName],
  )) as ReadonlyArray<unknown>;
  return rows.length > 0;
}

/**
 * 四列唯一键预检：存在重复组时在首次 DDL 前停止。
 * 不自动合并、删除或择一保留，也不凭 storage_reference 猜测归属。
 */
async function assertNoDuplicateSyncReceiptGroups(queryRunner: QueryRunner): Promise<void> {
  const duplicateGroups = (await queryRunner.query(
    `SELECT \`organization_id\`, \`resource_type\`, \`record_uuid\`, \`version_no\`,
            COUNT(*) AS dup_count
       FROM \`sync_receipt\`
      GROUP BY \`organization_id\`, \`resource_type\`, \`record_uuid\`, \`version_no\`
     HAVING COUNT(*) > 1
      LIMIT 21`,
  )) as ReadonlyArray<Record<string, unknown>>;
  if (duplicateGroups.length === 0) {
    return;
  }
  const sample = duplicateGroups
    .slice(0, 20)
    .map(
      (row) =>
        `(${String(row['record_uuid'])}, ${String(row['organization_id'])}, ` +
        `${String(row['resource_type'])}, ${String(row['version_no'])})`,
    )
    .join('; ');
  throw new Error(
    '[close-s5-structural-gaps] 结构补齐预检失败，未执行任何 ALTER。\n' +
      `  - sync_receipt 四列唯一键存在重复组：${sample}\n` +
      '处置约束：不得自动合并/删除重复组，不得凭 storage_reference 猜云端地址，' +
      '不得为旧行伪造版本、摘要、密钥、检查结论或故障原始字段。',
  );
}

/**
 * S5 合并阻塞集中修复：F1—F5 结构补齐、历史工单身份与闭单兼容。
 *
 * 本迁移追加在 1775501800000 之后，只负责把“已完成旧版增量”的库补齐到与
 * 全新/31 态一致的终态；不手工插入迁移历史，也不声称能修复前序迁移已失败的库。
 */
export class CloseS5StructuralGapsForV131775501900000 implements MigrationInterface {
  name = 'CloseS5StructuralGapsForV131775501900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const completedSteps: string[] = [];
    let currentStep = 'repair_request 历史身份读取';
    try {
      // 1. 历史身份由 1775501100000 统一负责：空表短路、缺列按 NULL 参与指纹、
      //    加列后按库外清单标记。本迁移不再重复定义 is_historical，否则结构预检会把
      //    “1100000 已提交该列、1900000 未执行”误判为半迁移。

      // 2. 旧行兼容性预检：只拒绝无法合法保留的数据，全部发生在首次 DDL 之前。
      //    新增事实列对历史行保持 NULL（历史未知），不回填、不删除旧行；
      //    因此只检查“新唯一键会冲突”的旧数据，而不是以表空作为升级前提。
      currentStep = '旧行兼容性预检（首次 DDL 前）';
      await assertNoDuplicateSyncReceiptGroups(queryRunner);

      // 3. repair_request 闭单约束重建。
      currentStep = 'repair_request 闭单约束';
      await this.rebuildRepairRequestClosureChecks(queryRunner);
      completedSteps.push('repair_request 闭单约束');

      // 4. local_company_setting 备份计划与自动上传开关。
      currentStep = 'local_company_setting 备份计划与自动上传开关';
      if (!(await columnExists(queryRunner, 'local_company_setting', 'initialized_at'))) {
        await queryRunner.query(`
      ALTER TABLE \`local_company_setting\`
        ADD COLUMN \`initialized_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
          COMMENT '首次启用/初始化时间',
        ADD COLUMN \`backup_interval_hours\` int unsigned NOT NULL DEFAULT '72'
          COMMENT '备份间隔小时数',
        ADD COLUMN \`backup_enabled\` tinyint(1) NOT NULL DEFAULT '0'
          COMMENT '是否启用自动备份；历史行不自动开启',
        ADD COLUMN \`next_backup_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '下次计划备份时间；旧行无证据时保持为空',
        ADD COLUMN \`last_auto_success_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '最近自动备份成功时间',
        ADD COLUMN \`last_auto_failure_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '最近自动备份失败时间',
        ADD COLUMN \`failure_reason\` text NULL DEFAULT NULL
          COMMENT '最近一次自动备份失败原因',
        ADD COLUMN \`auto_upload_enabled\` tinyint(1) NOT NULL DEFAULT '0'
          COMMENT '自动备份成功后是否自动上传'
    `);
        // 只对刚补齐列的历史行做可证明回填；续跑已提交时不再重复覆盖。
        await queryRunner.query(`
      UPDATE \`local_company_setting\`
         SET \`initialized_at\` = \`created_at\`,
             \`backup_enabled\` = 0,
             \`auto_upload_enabled\` = 0,
             \`next_backup_at\` = NULL
    `);
      }
      if (
        !(await constraintExists(
          queryRunner,
          'local_company_setting',
          'chk_local_company_setting_backup_interval',
        ))
      ) {
        await queryRunner.query(`
      ALTER TABLE \`local_company_setting\`
        ADD CONSTRAINT \`chk_local_company_setting_backup_interval\`
          CHECK (\`backup_interval_hours\` > 0),
        ADD CONSTRAINT \`chk_local_company_setting_backup_schedule\`
          CHECK (\`backup_enabled\` = 0 OR \`next_backup_at\` IS NOT NULL),
        ADD CONSTRAINT \`chk_local_company_setting_auto_upload\`
          CHECK (\`auto_upload_enabled\` = 0 OR \`backup_enabled\` = 1)
    `);
      }
      // 5. local_account_authorization 离线资格签名事实。
      completedSteps.push('local_company_setting 备份计划与自动上传开关');
      currentStep = 'local_account_authorization 离线资格签名事实';
      if (!(await columnExists(queryRunner, 'local_account_authorization', 'signed_claims'))) {
        await queryRunner.query(`
      ALTER TABLE \`local_account_authorization\`
        ADD COLUMN \`signed_claims\` json NULL DEFAULT NULL
          COMMENT '签名凭据原文；历史行不伪造',
        ADD COLUMN \`permission_version\` int unsigned NULL DEFAULT NULL
          COMMENT '签名权限版本',
        ADD COLUMN \`last_verified_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '最近一次签名校验成功时间'
    `);
      }
      if (
        !(await constraintExists(
          queryRunner,
          'local_account_authorization',
          'chk_local_account_authorization_signed_claims',
        ))
      ) {
        await queryRunner.query(`
      ALTER TABLE \`local_account_authorization\`
        ADD CONSTRAINT \`chk_local_account_authorization_signed_claims\` CHECK (
          (\`signed_claims\` IS NULL AND \`permission_version\` IS NULL AND \`last_verified_at\` IS NULL)
          OR (\`signed_claims\` IS NOT NULL AND \`permission_version\` IS NOT NULL
              AND \`last_verified_at\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_local_account_authorization_permission_version\` CHECK (
          \`permission_version\` IS NULL OR \`permission_version\` >= 1
        )
    `);
      }

      // 6. sync_receipt 来源安装与四列唯一键（单条 ALTER，MySQL 8 原子）。
      completedSteps.push('local_account_authorization 离线资格签名事实');
      currentStep = 'sync_receipt 来源安装、四列唯一键与确认时间约束';
      //    Q17：source_system 仅作兼容描述，不参与唯一键；receipt_status 是有效状态；
      //    confirmed_at 是旧版确认事件时间。新 received_at 只由新写入者按对端回执填写。
      if (!(await columnExists(queryRunner, 'sync_receipt', 'source_installation_id'))) {
        await queryRunner.query(`
      ALTER TABLE \`sync_receipt\`
        ADD COLUMN \`source_installation_id\` char(36) NULL DEFAULT NULL
          COMMENT '远端来源安装标识；历史未知为 NULL，不因本机未登记而拒绝',
        ADD COLUMN \`remote_resource_id\` varchar(64) NULL DEFAULT NULL
          COMMENT '云端远端资源标识；本机写入或历史未知时为空',
        ADD COLUMN \`received_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '设计字段：对端实际接收时间；历史未知为 NULL，不从 confirmed_at 复制',
        MODIFY COLUMN \`source_system\` varchar(16) NOT NULL
          COMMENT '兼容描述：旧版 LOCAL/CLOUD 来源维度，不参与四维唯一键',
        MODIFY COLUMN \`receipt_status\` varchar(16) NOT NULL
          COMMENT '有效同步状态（对应设计 status）：PENDING/SUCCEEDED/FAILED/CONFLICT',
        MODIFY COLUMN \`confirmed_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '旧版确认事件时间；历史未知为 NULL，不双写新 received_at',
        DROP INDEX \`uk_sync_receipt_scope\`,
        ADD UNIQUE KEY \`uk_sync_receipt_scope_v13\`
          (\`organization_id\`, \`resource_type\`, \`record_uuid\`, \`version_no\`)
    `);
      }
      // Q17：旧 CHECK 强制 SUCCEEDED/FAILED 必须有 confirmed_at，会把“新流程只写 received_at”
      // 误判为非法，也会迫使无依据双写。改为：历史 confirmed_at 或新 received_at 任一可证明确认事件。
      await dropCheckIfExists(queryRunner, 'sync_receipt', 'chk_sync_receipt_confirmed');
      if (!(await constraintExists(queryRunner, 'sync_receipt', 'chk_sync_receipt_confirm_time'))) {
        await queryRunner.query(`
      ALTER TABLE \`sync_receipt\`
        ADD CONSTRAINT \`chk_sync_receipt_confirm_time\` CHECK (
          \`receipt_status\` IN ('PENDING', 'CONFLICT')
          OR \`received_at\` IS NOT NULL
          OR \`confirmed_at\` IS NOT NULL
        )
    `);
      }

      // 7. backup_asset 本地/云端引用、版本、校验与清理事实。
      completedSteps.push('sync_receipt 来源安装、四列唯一键与确认时间约束');
      currentStep = 'backup_asset 事实列与清理约束';
      //    Q18：新增事实列对历史行保持 NULL（历史未知），只回填可证明值；
      //    Q16：installation_id 语义仍可能为远端来源机器，本轮不加 FK。
      if (!(await columnExists(queryRunner, 'backup_asset', 'installation_id'))) {
        await queryRunner.query(`
      ALTER TABLE \`backup_asset\`
        ADD COLUMN \`installation_id\` char(36) NULL DEFAULT NULL
          COMMENT '产生备份的安装标识；历史未知为 NULL',
        ADD COLUMN \`format_version\` int unsigned NULL DEFAULT NULL
          COMMENT '备份包格式版本；历史未知为 NULL',
        ADD COLUMN \`data_version\` varchar(64) NULL DEFAULT NULL
          COMMENT '业务数据版本；历史未知为 NULL',
        ADD COLUMN \`manifest_checksum\` char(64) NULL DEFAULT NULL
          COMMENT '备份清单 SHA-256；历史未知为 NULL，不由 file_sha256 推定',
        ADD COLUMN \`local_reference\` varchar(1024) NULL DEFAULT NULL
          COMMENT '本地包引用；清理后为空',
        ADD COLUMN \`cloud_reference\` varchar(1024) NULL DEFAULT NULL
          COMMENT '云端对象引用；不从 storage_reference 推断',
        ADD COLUMN \`encryption_key_id\` varchar(128) NULL DEFAULT NULL
          COMMENT '加密密钥标识；历史未知为 NULL',
        ADD COLUMN \`verified_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '最近校验成功时间；历史未知为 NULL',
        ADD COLUMN \`retention_until\` timestamp(3) NULL DEFAULT NULL
          COMMENT '保留截止时间；历史未知为 NULL',
        ADD COLUMN \`failure_reason\` text NULL DEFAULT NULL
          COMMENT '最近失败原因',
        ADD COLUMN \`deleted_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '本地包清理事实时间；历史 CLEANED 行无法证明时为 NULL',
        ADD COLUMN \`local_cleanup_error\` text NULL DEFAULT NULL
          COMMENT '本地清理失败原因',
        ADD CONSTRAINT \`chk_backup_asset_manifest\`
          CHECK (\`manifest_checksum\` IS NULL OR CHAR_LENGTH(\`manifest_checksum\`) = 64),
        ADD CONSTRAINT \`chk_backup_asset_format_version\`
          CHECK (\`format_version\` IS NULL OR \`format_version\` >= 1),
        ADD CONSTRAINT \`chk_backup_asset_local_cleanup\` CHECK (
          (\`local_status\` = 'CLEANED' AND \`local_reference\` IS NULL)
          OR (\`local_status\` <> 'CLEANED' AND \`deleted_at\` IS NULL)
        ),
        ADD KEY \`idx_backup_asset_installation\` (\`installation_id\`, \`created_at\`)
    `);
      }

      // 8. backup_restore_run 预检/执行事实与 CASE 执行门。
      completedSteps.push('backup_asset 事实列与清理约束');
      currentStep = 'backup_restore_run 事实列与外键';
      //    Q13：check_status 使用 PENDING/PASSED/FAILED，历史未知为 NULL，不自动填 PASSED。
      //    Q16：target_installation_id 明确为当前恢复目标本机，采用既有安装关系（可空以容纳历史行）。
      if (!(await columnExists(queryRunner, 'backup_restore_run', 'target_installation_id'))) {
        await queryRunner.query(`
      ALTER TABLE \`backup_restore_run\`
        MODIFY COLUMN \`protection_backup_id\` char(36) NULL DEFAULT NULL
          COMMENT '恢复前保护备份ID；预检阶段可空，新流程执行阶段必须非空',
        MODIFY COLUMN \`started_at\` timestamp(3) NULL DEFAULT NULL
          COMMENT '实际开始时间；预检阶段为空',
        ADD COLUMN \`target_installation_id\` char(36) NULL DEFAULT NULL
          COMMENT '实际恢复目标安装标识；历史未知为 NULL',
        ADD COLUMN \`check_status\` varchar(16) NULL DEFAULT NULL
          COMMENT '恢复前检查结论：PENDING/PASSED/FAILED；历史未知为 NULL',
        ADD COLUMN \`confirmation\` json NULL DEFAULT NULL
          COMMENT '执行前确认原文；新流程执行阶段必须非空',
        ADD CONSTRAINT \`fk_backup_restore_run_target\`
          FOREIGN KEY (\`target_installation_id\`) REFERENCES \`local_installation\` (\`installation_id\`)
          ON DELETE RESTRICT ON UPDATE RESTRICT
    `);
      }
      currentStep = 'backup_restore_run 状态与检查结论约束';
      // 先删旧检查，再清理可能存在的本轮新检查，最后一次性重建：重复执行不产生重复约束。
      await dropCheckIfExists(queryRunner, 'backup_restore_run', 'chk_backup_restore_run_status');
      await dropCheckIfExists(queryRunner, 'backup_restore_run', 'chk_backup_restore_run_finish');
      await dropCheckIfExists(
        queryRunner,
        'backup_restore_run',
        'chk_backup_restore_run_protection',
      );
      await dropCheckIfExists(
        queryRunner,
        'backup_restore_run',
        'chk_backup_restore_run_execution_guard',
      );
      await dropCheckIfExists(
        queryRunner,
        'backup_restore_run',
        'chk_backup_restore_run_check_status',
      );
      await dropCheckIfExists(
        queryRunner,
        'backup_restore_run',
        'chk_backup_restore_run_check_outcome',
      );
      await queryRunner.query(`
      ALTER TABLE \`backup_restore_run\`
        ADD CONSTRAINT \`chk_backup_restore_run_status\` CHECK (
          \`status\` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')
        ),
        ADD CONSTRAINT \`chk_backup_restore_run_finish\` CHECK (
          (\`status\` = 'PENDING' AND \`started_at\` IS NULL AND \`finished_at\` IS NULL)
          OR (\`status\` = 'RUNNING' AND \`started_at\` IS NOT NULL AND \`finished_at\` IS NULL)
          OR (\`status\` IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED')
              AND \`finished_at\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_backup_restore_run_protection\` CHECK (
          \`protection_backup_id\` IS NULL OR \`protection_backup_id\` <> \`backup_id\`
        ),
        ADD CONSTRAINT \`chk_backup_restore_run_execution_guard\` CHECK (
          (\`status\` = 'PENDING'
            AND \`protection_backup_id\` IS NULL AND \`confirmation\` IS NULL)
          OR (\`status\` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')
            AND \`started_at\` IS NOT NULL AND \`protection_backup_id\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_backup_restore_run_check_status\` CHECK (
          \`check_status\` IS NULL
          OR \`check_status\` IN ('PENDING', 'PASSED', 'FAILED')
        ),
        ADD CONSTRAINT \`chk_backup_restore_run_check_outcome\` CHECK (
          (
            \`check_status\` IS NULL
            OR (\`status\` = 'SUCCEEDED' AND \`check_status\` <> 'FAILED')
            OR (\`status\` NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED'))
          )
          AND (
            \`check_status\` IS NULL
            OR \`status\` NOT IN ('FAILED', 'INTERRUPTED')
            OR \`check_status\` <> 'PASSED'
          )
        )
    `);

      // 9. maintenance_report_fault 原始八字段、phase_code 与生命周期分离。
      completedSteps.push('backup_restore_run 状态与检查结论约束');
      currentStep = 'maintenance_report_fault 生命周期改名与原始字段';
      // 旧 CHECK 引用 `status`/`source`；必须先删，否则 CHANGE COLUMN 会被拒绝。
      await dropCheckIfExists(
        queryRunner,
        'maintenance_report_fault',
        'chk_maintenance_report_fault_status',
      );
      await dropCheckIfExists(
        queryRunner,
        'maintenance_report_fault',
        'chk_maintenance_report_fault_source',
      );
      if (!(await columnExists(queryRunner, 'maintenance_report_fault', 'lifecycle_status'))) {
        await queryRunner.query(`
      ALTER TABLE \`maintenance_report_fault\`
        CHANGE COLUMN \`status\` \`lifecycle_status\` varchar(16) NOT NULL
          COMMENT '处理生命周期：OPEN/IN_PROGRESS/RESOLVED',
        CHANGE COLUMN \`source\` \`lifecycle_source\` varchar(16) NOT NULL
          COMMENT '生命周期来源：USER/ADMIN/SYSTEM'
    `);
      }
      if (!(await columnExists(queryRunner, 'maintenance_report_fault', 'main_error'))) {
        await queryRunner.query(`
      ALTER TABLE \`maintenance_report_fault\`
        ADD COLUMN \`main_error\` varchar(300) NULL DEFAULT NULL
          COMMENT '原始主错误文本',
        ADD COLUMN \`unit_error\` varchar(300) NULL DEFAULT NULL
          COMMENT '原始单元错误文本',
        ADD COLUMN \`error_type\` varchar(300) NULL DEFAULT NULL
          COMMENT '原始错误类型',
        ADD COLUMN \`gpib_status\` varchar(300) NULL DEFAULT NULL
          COMMENT '原始 GPIB 状态',
        ADD COLUMN \`status\` varchar(300) NULL DEFAULT NULL
          COMMENT '原始故障状态文本',
        ADD COLUMN \`source\` varchar(300) NULL DEFAULT NULL
          COMMENT '原始故障来源文本',
        ADD COLUMN \`phase_code\` varchar(32) NULL DEFAULT NULL
          COMMENT '所属流程阶段：PHASE_01—PHASE_10；历史未知为 NULL',
        ADD COLUMN \`is_active\` tinyint(1) NULL DEFAULT NULL
          COMMENT '是否当前有效分支；历史未知为 NULL，新流程必须显式写入'
    `);
      }
      // 重建本轮新检查前先清理同名对象，保证重复执行不产生重复约束。
      for (const checkName of [
        'chk_maintenance_report_fault_lifecycle_status',
        'chk_maintenance_report_fault_lifecycle_source',
        'chk_maintenance_report_fault_description_len',
        'chk_maintenance_report_fault_action_len',
        'chk_maintenance_report_fault_phase_code',
        'chk_maintenance_report_fault_active',
      ]) {
        await dropCheckIfExists(queryRunner, 'maintenance_report_fault', checkName);
      }
      await queryRunner.query(`
      ALTER TABLE \`maintenance_report_fault\`
        ADD CONSTRAINT \`chk_maintenance_report_fault_lifecycle_status\` CHECK (
          \`lifecycle_status\` IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')
        ),
        ADD CONSTRAINT \`chk_maintenance_report_fault_lifecycle_source\` CHECK (
          \`lifecycle_source\` IN ('USER', 'ADMIN', 'SYSTEM')
        ),
        ADD CONSTRAINT \`chk_maintenance_report_fault_description_len\` CHECK (
          \`fault_description\` IS NULL OR CHAR_LENGTH(\`fault_description\`) <= 10000
        ),
        ADD CONSTRAINT \`chk_maintenance_report_fault_action_len\` CHECK (
          \`handling_action\` IS NULL OR CHAR_LENGTH(\`handling_action\`) <= 10000
        ),
        ADD CONSTRAINT \`chk_maintenance_report_fault_phase_code\` CHECK (
          \`phase_code\` IS NULL
          OR \`phase_code\` IN (
            'PHASE_01', 'PHASE_02', 'PHASE_03', 'PHASE_04', 'PHASE_05',
            'PHASE_06', 'PHASE_07', 'PHASE_08', 'PHASE_09', 'PHASE_10'
          )
        ),
        ADD CONSTRAINT \`chk_maintenance_report_fault_active\` CHECK (
          \`is_active\` IS NULL OR \`is_active\` IN (0, 1)
        )
    `);
      completedSteps.push('maintenance_report_fault 生命周期改名与原始字段');
    } catch (error) {
      const completed =
        completedSteps.length > 0 ? completedSteps.join(' → ') : '无（失败发生在首个 DDL 前）';
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(
        `[close-s5-structural-gaps] 步骤「${currentStep}」失败：${detail}\n` +
          `已完成 DDL 步骤：${completed}\n` +
          '诊断边界：MySQL DDL 隐式提交，本迁移不声称整体回滚，也不自动修复或清空数据。' +
          '请先用 information_schema 核对上列步骤的列/索引/约束是否已存在，' +
          '确认无冲突后重新执行部署入口；重复执行已成功的完整迁移不会产生数据漂移。',
        { cause: error },
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropCheckIfExists(
      queryRunner,
      'maintenance_report_fault',
      'chk_maintenance_report_fault_active',
    );
    await dropCheckIfExists(
      queryRunner,
      'maintenance_report_fault',
      'chk_maintenance_report_fault_phase_code',
    );
    await dropCheckIfExists(
      queryRunner,
      'maintenance_report_fault',
      'chk_maintenance_report_fault_action_len',
    );
    await dropCheckIfExists(
      queryRunner,
      'maintenance_report_fault',
      'chk_maintenance_report_fault_description_len',
    );
    await dropCheckIfExists(
      queryRunner,
      'maintenance_report_fault',
      'chk_maintenance_report_fault_lifecycle_source',
    );
    await dropCheckIfExists(
      queryRunner,
      'maintenance_report_fault',
      'chk_maintenance_report_fault_lifecycle_status',
    );
    await queryRunner.query(`
      ALTER TABLE \`maintenance_report_fault\`
        DROP COLUMN \`is_active\`,
        DROP COLUMN \`phase_code\`,
        DROP COLUMN \`source\`,
        DROP COLUMN \`status\`,
        DROP COLUMN \`gpib_status\`,
        DROP COLUMN \`error_type\`,
        DROP COLUMN \`unit_error\`,
        DROP COLUMN \`main_error\`,
        CHANGE COLUMN \`lifecycle_status\` \`status\` varchar(16) NOT NULL
          COMMENT 'OPEN/IN_PROGRESS/RESOLVED',
        CHANGE COLUMN \`lifecycle_source\` \`source\` varchar(16) NOT NULL
          COMMENT 'USER/ADMIN/SYSTEM',
        ADD CONSTRAINT \`chk_maintenance_report_fault_status\`
          CHECK (\`status\` IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
        ADD CONSTRAINT \`chk_maintenance_report_fault_source\`
          CHECK (\`source\` IN ('USER', 'ADMIN', 'SYSTEM'))
    `);

    await dropCheckIfExists(
      queryRunner,
      'backup_restore_run',
      'chk_backup_restore_run_check_outcome',
    );
    await dropCheckIfExists(
      queryRunner,
      'backup_restore_run',
      'chk_backup_restore_run_check_status',
    );
    await dropCheckIfExists(
      queryRunner,
      'backup_restore_run',
      'chk_backup_restore_run_execution_guard',
    );
    await queryRunner.query(`
      ALTER TABLE \`backup_restore_run\`
        DROP FOREIGN KEY \`fk_backup_restore_run_target\`
    `);
    await dropCheckIfExists(queryRunner, 'backup_restore_run', 'chk_backup_restore_run_protection');
    await dropCheckIfExists(queryRunner, 'backup_restore_run', 'chk_backup_restore_run_finish');
    await dropCheckIfExists(queryRunner, 'backup_restore_run', 'chk_backup_restore_run_status');
    await queryRunner.query(`
      ALTER TABLE \`backup_restore_run\`
        DROP COLUMN \`confirmation\`,
        DROP COLUMN \`check_status\`,
        DROP COLUMN \`target_installation_id\`,
        MODIFY COLUMN \`started_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
          COMMENT '开始时间',
        MODIFY COLUMN \`protection_backup_id\` char(36) NOT NULL
          COMMENT '恢复前保护备份ID',
        ADD CONSTRAINT \`chk_backup_restore_run_status\`
          CHECK (\`status\` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')),
        ADD CONSTRAINT \`chk_backup_restore_run_finish\` CHECK (
          (\`status\` = 'RUNNING' AND \`finished_at\` IS NULL)
          OR (\`status\` <> 'RUNNING' AND \`finished_at\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_backup_restore_run_protection\`
          CHECK (\`backup_id\` <> \`protection_backup_id\`)
    `);

    await dropIndexIfExists(queryRunner, 'backup_asset', 'idx_backup_asset_installation');
    await dropCheckIfExists(queryRunner, 'backup_asset', 'chk_backup_asset_local_cleanup');
    await dropCheckIfExists(queryRunner, 'backup_asset', 'chk_backup_asset_format_version');
    await dropCheckIfExists(queryRunner, 'backup_asset', 'chk_backup_asset_manifest');
    await queryRunner.query(`
      ALTER TABLE \`backup_asset\`
        DROP COLUMN \`local_cleanup_error\`,
        DROP COLUMN \`deleted_at\`,
        DROP COLUMN \`failure_reason\`,
        DROP COLUMN \`retention_until\`,
        DROP COLUMN \`verified_at\`,
        DROP COLUMN \`encryption_key_id\`,
        DROP COLUMN \`cloud_reference\`,
        DROP COLUMN \`local_reference\`,
        DROP COLUMN \`manifest_checksum\`,
        DROP COLUMN \`data_version\`,
        DROP COLUMN \`format_version\`,
        DROP COLUMN \`installation_id\`
    `);

    await dropIndexIfExists(queryRunner, 'sync_receipt', 'uk_sync_receipt_scope_v13');
    await dropCheckIfExists(queryRunner, 'sync_receipt', 'chk_sync_receipt_confirm_time');
    await queryRunner.query(`
      ALTER TABLE \`sync_receipt\`
        DROP COLUMN \`received_at\`,
        DROP COLUMN \`remote_resource_id\`,
        DROP COLUMN \`source_installation_id\`,
        ADD UNIQUE KEY \`uk_sync_receipt_scope\`
          (\`record_uuid\`, \`organization_id\`, \`resource_type\`, \`version_no\`, \`source_system\`),
        ADD CONSTRAINT \`chk_sync_receipt_confirmed\` CHECK (
          \`receipt_status\` IN ('PENDING', 'CONFLICT') OR \`confirmed_at\` IS NOT NULL
        )
    `);

    await dropCheckIfExists(
      queryRunner,
      'local_account_authorization',
      'chk_local_account_authorization_permission_version',
    );
    await dropCheckIfExists(
      queryRunner,
      'local_account_authorization',
      'chk_local_account_authorization_signed_claims',
    );
    await queryRunner.query(`
      ALTER TABLE \`local_account_authorization\`
        DROP COLUMN \`last_verified_at\`,
        DROP COLUMN \`permission_version\`,
        DROP COLUMN \`signed_claims\`
    `);

    await dropCheckIfExists(
      queryRunner,
      'local_company_setting',
      'chk_local_company_setting_auto_upload',
    );
    await dropCheckIfExists(
      queryRunner,
      'local_company_setting',
      'chk_local_company_setting_backup_schedule',
    );
    await dropCheckIfExists(
      queryRunner,
      'local_company_setting',
      'chk_local_company_setting_backup_interval',
    );
    await queryRunner.query(`
      ALTER TABLE \`local_company_setting\`
        DROP COLUMN \`auto_upload_enabled\`,
        DROP COLUMN \`failure_reason\`,
        DROP COLUMN \`last_auto_failure_at\`,
        DROP COLUMN \`last_auto_success_at\`,
        DROP COLUMN \`next_backup_at\`,
        DROP COLUMN \`backup_enabled\`,
        DROP COLUMN \`backup_interval_hours\`,
        DROP COLUMN \`initialized_at\`
    `);

    await dropCheckIfExists(queryRunner, 'repair_request', 'chk_repair_request_closure_reason');
    await dropCheckIfExists(queryRunner, 'repair_request', 'chk_repair_request_closure');
    // 回退到 1775501100000 建立的形态：CASE 闭单 + 历史身份豁免，避免历史行阻塞回滚。
    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        ADD CONSTRAINT \`chk_repair_request_closure\` CHECK (
          (\`closure_status\` IS NULL AND \`closed_at\` IS NULL)
          OR (\`closure_status\` = 'OPEN' AND \`closed_at\` IS NULL)
          OR (\`closure_status\` = 'CLOSED' AND \`closed_at\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_repair_request_closure_reason\` CHECK (
          \`is_historical\` = 1
          OR \`handling_result\` IS NULL
          OR \`handling_result\` NOT IN ('INTERRUPTED', 'UNREPAIRABLE')
          OR (\`closure_reason\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`closure_reason\`)) > 0)
        )
    `);
  }

  private async rebuildRepairRequestClosureChecks(queryRunner: QueryRunner): Promise<void> {
    await dropCheckIfExists(queryRunner, 'repair_request', 'chk_repair_request_closure_reason');
    await dropCheckIfExists(queryRunner, 'repair_request', 'chk_repair_request_closure');
    await queryRunner.query(`
      ALTER TABLE \`repair_request\`
        ADD CONSTRAINT \`chk_repair_request_closure\` CHECK (
          (\`closure_status\` IS NULL AND \`closed_at\` IS NULL)
          OR (\`closure_status\` = 'OPEN' AND \`closed_at\` IS NULL)
          OR (\`closure_status\` = 'CLOSED' AND \`closed_at\` IS NOT NULL)
        ),
        ADD CONSTRAINT \`chk_repair_request_closure_reason\` CHECK (
          \`is_historical\` = 1
          OR \`handling_result\` IS NULL
          OR \`handling_result\` NOT IN ('INTERRUPTED', 'UNREPAIRABLE')
          OR (\`closure_reason\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`closure_reason\`)) > 0)
        )
    `);
  }
}

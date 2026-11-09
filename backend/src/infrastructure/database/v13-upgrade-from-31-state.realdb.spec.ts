// 31 态 → 40 态升级挡点实库规格（默认关闭；含第 40 条追加修复迁移）
//
// 目的：在“冻结前 31 条迁移正向构建”的库上，先插入 31 态合法旧样本，再通过正式升级入口
// （runDatabaseDeploy mode=upgrade）升级，记录旧样本是否可保存、实际失败迁移/SQL 阶段、
// 失败前已提交的 DDL、迁移历史、数据与结构状态。
//
// 安全门（缺一即拒绝，不自动清库、不回退 DDL）：
//   V13_UPGRADE_SPECS=1
//   E2E_ALLOW_PHYSICAL_CLEANUP=1
//   V13_UPGRADE_SCENARIO=ctrl|a_ai5|b_closure|d_conv
//   V13_UPGRADE_DB_NAME=<场景固定的专用库名>
//   V13_UPGRADE_ENV_FILE=<绝对路径，含 DB_HOST/DB_USER/DB_PORT/DB_NAME>
//   V13_UPGRADE_EVIDENCE_DIR=<绝对路径>
//
// 本规格不做清理、不做回滚、不自动修数据；控制组（ctrl）通过才代表基线升级路径可用。
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { DataSource, type DataSourceOptions, type QueryRunner } from 'typeorm';

import { runDatabaseDeploy } from './database-deploy';
import {
  createMigrationDataSource,
  loadExplicitEnvConfig,
  readRepositoryMigrations,
  type MigrationDbConfig,
  type MigrationLogger,
} from './incremental-migration';
import { resolveMigrationName } from './migration-schema-contract';
import {
  fingerprintLegacyRepairRequestRow,
  resetLegacyRepairIdentityManifest,
  type LegacyRepairIdentityManifest,
} from './legacy-repair-identity-manifest';

const BASELINE_COUNT = 31;
const V13_ALERT_MIGRATION_TIMESTAMP = 1775401600000;

const SCENARIOS = {
  ctrl: {
    database: 'lithography_v13_upg31_ctrl_r2',
    purpose: '控制组：31 态无风险样本 + C 合法组合，全量升级必须成功',
  },
  a_ai5: {
    database: 'lithography_v13_upg31_a_ai5_r2',
    purpose: 'A：ai_helpfulness=5（31 态合法）',
  },
  b_closure: {
    database: 'lithography_v13_upg31_b_closure_r2',
    purpose: 'B：INTERRUPTED 且无 closure_reason（31 态合法，应标记历史后成功升级）',
  },
  d_conv: {
    database: 'lithography_v13_upg31_d_conv_r2',
    purpose: 'D：ACTIVE + ai_feedback（31 态 DB 合法、无真实写入者，防御性）',
  },
} as const;

type ScenarioName = keyof typeof SCENARIOS;

const DDL_PROBES: ReadonlyArray<{
  readonly key: string;
  readonly table: string;
  readonly column: string;
  readonly statement: string;
}> = [
  {
    key: 'repair_request.intake_id',
    table: 'repair_request',
    column: 'intake_id',
    statement: '1775501100000-alter-repair-ai-report-for-v13.migration.ts: upgradeRepairRequest',
  },
  {
    key: 'repair_request.is_historical',
    table: 'repair_request',
    column: 'is_historical',
    statement: '1775501100000-alter-repair-ai-report-for-v13.migration.ts: upgradeRepairRequest',
  },
  {
    key: 'ai_conversation.owner_organization_id',
    table: 'ai_conversation',
    column: 'owner_organization_id',
    statement: '1775501100000-alter-repair-ai-report-for-v13.migration.ts: upgradeAiConversation',
  },
  {
    key: 'ai_message.question_uuid',
    table: 'ai_message',
    column: 'question_uuid',
    statement: '1775501100000-alter-repair-ai-report-for-v13.migration.ts: upgradeAiMessage',
  },
  {
    key: 'maintenance_report_step.error_code',
    table: 'maintenance_report_step',
    column: 'error_code',
    statement:
      '1775501100000-alter-repair-ai-report-for-v13.migration.ts: upgradeMaintenanceReportStep',
  },
  {
    key: 'maintenance_report.supplementary_note',
    table: 'maintenance_report',
    column: 'supplementary_note',
    statement:
      '1775501100000-alter-repair-ai-report-for-v13.migration.ts: upgradeMaintenanceReport',
  },
];

const STRUCTURE_TABLES: ReadonlyArray<string> = [
  'repair_request',
  'ai_conversation',
  'ai_message',
  'maintenance_report_step',
  'maintenance_report',
];

const MASTER_SWITCH = 'V13_UPGRADE_SPECS';
const ENV_PREFIX = 'V13_UPGRADE_';
const ENABLED = process.env[MASTER_SWITCH] === '1';
const HAS_ANY_UPGRADE_ENV = Object.keys(process.env).some((key) => key.startsWith(ENV_PREFIX));

if (HAS_ANY_UPGRADE_ENV && !ENABLED) {
  throw new Error(
    `检测到 ${ENV_PREFIX}* 变量但未设置 ${MASTER_SWITCH}=1；为避免误连库，已拒绝加载`,
  );
}

interface UpgradeRuntime {
  readonly scenario: ScenarioName;
  readonly database: string;
  readonly envFile: string;
  readonly evidenceDir: string;
  readonly config: MigrationDbConfig;
}

interface MigrationConstructor {
  new (): {
    up: (queryRunner: QueryRunner) => Promise<void>;
    down: (queryRunner: QueryRunner) => Promise<void>;
  };
}

interface FixtureIds {
  readonly organizationId: number;
  readonly accountId: number;
  readonly equipmentModelId: number;
  readonly repairRequestId: number | null;
  readonly reportId: number | null;
  readonly conversationId: number | null;
}

interface UpgradeEvidence {
  scenario: ScenarioName | 'disabled';
  database: string;
  startedAt: string;
  baselineCount: number;
  baselineMigrationNames: ReadonlyArray<string>;
  legacySampleSaved: boolean;
  legacyIds: Record<string, number | string | null>;
  outcome: 'SUCCESS' | 'FAILURE' | 'NOT_RUN';
  stage: 'BASELINE' | 'PRECHECK' | 'MIGRATION' | 'NONE';
  executedMigrations: ReadonlyArray<string>;
  failedMigration: string | null;
  errorMessage: string | null;
  committedDdl: Record<string, boolean>;
  migrationHistoryCount: number;
  migrationHistory: ReadonlyArray<{ id: number; timestamp: number; name: string }>;
  sampleRows: ReadonlyArray<Record<string, unknown>>;
  structure: Record<string, string>;
  cleanup: 'NONE';
}

function isScenarioName(value: string): value is ScenarioName {
  return Object.prototype.hasOwnProperty.call(SCENARIOS, value);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`缺少必需环境变量 ${name}`);
  }
  return value.trim();
}

function readScenarioName(): ScenarioName {
  const raw = requireEnv('V13_UPGRADE_SCENARIO');
  if (!isScenarioName(raw)) {
    throw new Error(
      `V13_UPGRADE_SCENARIO 只接受 ${Object.keys(SCENARIOS).join('/')}，实际为 ${raw}`,
    );
  }
  return raw;
}

function resolveRuntime(): UpgradeRuntime {
  if (!ENABLED) {
    throw new Error(`未设置 ${MASTER_SWITCH}=1`);
  }
  if (process.env.E2E_ALLOW_PHYSICAL_CLEANUP !== '1') {
    throw new Error('未设置 E2E_ALLOW_PHYSICAL_CLEANUP=1；本规格会产生物理写入，已拒绝');
  }
  const scenario = readScenarioName();
  const database = requireEnv('V13_UPGRADE_DB_NAME');
  if (database !== SCENARIOS[scenario].database) {
    throw new Error(
      `目标库与场景不匹配：场景 ${scenario} 要求 ${SCENARIOS[scenario].database}，实际 ${database}`,
    );
  }
  const envFile = path.resolve(requireEnv('V13_UPGRADE_ENV_FILE'));
  if (!fs.existsSync(envFile)) {
    throw new Error(`环境文件不存在: ${envFile}`);
  }
  const evidenceDir = path.resolve(requireEnv('V13_UPGRADE_EVIDENCE_DIR'));
  const config = loadExplicitEnvConfig(envFile, database);
  return { scenario, database, envFile, evidenceDir, config };
}

function createDataSourceWithMigrations(
  config: MigrationDbConfig,
  migrations: ReadonlyArray<MigrationConstructor>,
): DataSource {
  const baseOptions = createMigrationDataSource(config).options;
  const options = {
    ...baseOptions,
    migrations: migrations as unknown as DataSourceOptions['migrations'],
  } as DataSourceOptions;
  return new DataSource(options);
}

function readRows(result: unknown): ReadonlyArray<Record<string, unknown>> {
  return result as ReadonlyArray<Record<string, unknown>>;
}

function readColumnValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function readNumber(row: Record<string, unknown>, key: string): number {
  return Number(readColumnValue(row, key));
}

function readString(row: Record<string, unknown>, key: string): string {
  return String(readColumnValue(row, key));
}

async function readActualDatabase(dataSource: DataSource): Promise<string> {
  const rows = readRows(
    await dataSource.query(
      'SELECT DATABASE() AS `current_database`, VERSION() AS `server_version`',
    ),
  );
  if (rows.length === 0) {
    throw new Error('无法读取实际连接数据库');
  }
  return readString(rows[0], 'current_database');
}

async function listBaseTables(dataSource: DataSource): Promise<ReadonlyArray<string>> {
  const rows = readRows(
    await dataSource.query(
      'SELECT `TABLE_NAME` AS `table_name` FROM `information_schema`.`TABLES` ' +
        'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_TYPE` = ?',
      ['BASE TABLE'],
    ),
  );
  return rows.map((row) => String(readColumnValue(row, 'table_name'))).sort();
}

async function assertEmptyTarget(dataSource: DataSource, database: string): Promise<void> {
  const tables = await listBaseTables(dataSource);
  if (tables.length > 0) {
    throw new Error(
      `目标库 ${database} 不是空库（${tables.join(', ')}）；本规格不自动清库，请人工处置后重试`,
    );
  }
}

async function readMigrationNames(dataSource: DataSource): Promise<ReadonlyArray<string>> {
  const rows = readRows(
    await dataSource.query('SELECT `name` AS `name` FROM `migrations` ORDER BY `id` ASC'),
  );
  return rows.map((row) => readString(row, 'name'));
}

async function buildBaseline31(config: MigrationDbConfig): Promise<{
  readonly dataSource: DataSource;
  readonly baselineNames: ReadonlyArray<string>;
  readonly repositoryNames: ReadonlyArray<string>;
}> {
  const probe = createMigrationDataSource(config);
  await probe.initialize();
  let entries: ReadonlyArray<{ name: string; timestamp: number }>;
  let instances: ReadonlyArray<object>;
  try {
    const actualDatabase = await readActualDatabase(probe);
    if (actualDatabase !== config.database) {
      throw new Error(`实际连接库与声明不一致：实际 ${actualDatabase}，声明 ${config.database}`);
    }
    await assertEmptyTarget(probe, config.database);
    entries = readRepositoryMigrations(probe);
    instances = [...probe.migrations];
  } finally {
    await probe.destroy();
  }

  if (entries.length < BASELINE_COUNT) {
    throw new Error(`仓库迁移不足 ${BASELINE_COUNT} 条，无法构建 31 态`);
  }
  const alertEntry = entries[BASELINE_COUNT - 1];
  if (alertEntry.timestamp !== V13_ALERT_MIGRATION_TIMESTAMP) {
    throw new Error(
      `第 ${BASELINE_COUNT} 条迁移时间戳异常：期望 ${V13_ALERT_MIGRATION_TIMESTAMP}，实际 ${alertEntry.timestamp}`,
    );
  }

  const byName = new Map<string, MigrationConstructor>(
    instances.map((instance) => [
      resolveMigrationName(instance),
      (instance as { constructor: MigrationConstructor }).constructor,
    ]),
  );
  const baselineClasses = entries.slice(0, BASELINE_COUNT).map((entry) => {
    const migrationClass = byName.get(entry.name);
    if (!migrationClass) {
      throw new Error(`无法从仓库迁移实例中定位 ${entry.name}`);
    }
    return migrationClass;
  });

  const dataSource = createDataSourceWithMigrations(config, baselineClasses);
  await dataSource.initialize();
  try {
    const executed = await dataSource.runMigrations({ transaction: 'none' });
    if (executed.length !== BASELINE_COUNT) {
      throw new Error(`31 态基线实际执行 ${executed.length} 条，期望 ${BASELINE_COUNT} 条`);
    }
    const baselineNames = await readMigrationNames(dataSource);
    if (baselineNames.length !== BASELINE_COUNT) {
      throw new Error(`31 态历史实际 ${baselineNames.length} 条，期望 ${BASELINE_COUNT} 条`);
    }
  } catch (error) {
    await dataSource.destroy();
    throw error;
  }
  return {
    dataSource,
    baselineNames: entries.slice(0, BASELINE_COUNT).map((entry) => entry.name),
    repositoryNames: entries.map((entry) => entry.name),
  };
}

async function insertCommonFixtures(
  dataSource: DataSource,
  scenario: ScenarioName,
): Promise<FixtureIds> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const organizationCode = `upg31_${scenario}_${suffix}`;
  const loginName = `u31_${scenario}_${suffix}`;
  const modelCode = `M31_${scenario}_${suffix}`;

  await dataSource.query(
    'INSERT INTO `organization` (`organization_code`, `name`, `kind`) VALUES (?, ?, ?)',
    [organizationCode, '31 态升级样本组织', 'CLIENT'],
  );
  const organizationRows = readRows(
    await dataSource.query('SELECT `id` FROM `organization` WHERE `organization_code` = ?', [
      organizationCode,
    ]),
  );

  await dataSource.query(
    'INSERT INTO `base_user_account` (`login_name`, `login_password`, `status`) VALUES (?, ?, ?)',
    [loginName, 'upg31-sample', 'ACTIVE'],
  );
  const accountRows = readRows(
    await dataSource.query('SELECT `id` FROM `base_user_account` WHERE `login_name` = ?', [
      loginName,
    ]),
  );

  await dataSource.query(
    'INSERT INTO `equipment_model` (`model_code`, `model_name`) VALUES (?, ?)',
    [modelCode, '31 态样本型号'],
  );
  const modelRows = readRows(
    await dataSource.query('SELECT `id` FROM `equipment_model` WHERE `model_code` = ?', [
      modelCode,
    ]),
  );

  return {
    organizationId: readNumber(organizationRows[0], 'id'),
    accountId: readNumber(accountRows[0], 'id'),
    equipmentModelId: readNumber(modelRows[0], 'id'),
    repairRequestId: null,
    reportId: null,
    conversationId: null,
  };
}

async function insertRepairRequest(
  dataSource: DataSource,
  fixtures: FixtureIds,
  scenario: ScenarioName,
  interrupted: boolean,
): Promise<number> {
  const requestNo = `U31-${scenario}-${randomUUID().slice(0, 8)}`;
  if (interrupted) {
    await dataSource.query(
      'INSERT INTO `repair_request` (`request_no`, `customer_account_id`, `equipment_model_id`, ' +
        '`error_code`, `fault_description`, `content_md`, `is_accepted`, ' +
        '`accepted_by_engineer_account_id`, `accepted_at`, `handling_result`, `handling_status`, ' +
        '`handling_recorded_at`, `handling_recorded_by_account_id`, `handling_ended_at`) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3), 'INTERRUPTED', 'IN_PROGRESS', NOW(3), ?, NULL)",
      [
        requestNo,
        fixtures.accountId,
        fixtures.equipmentModelId,
        '31-B-ERR',
        '31 态：中断处理且无 closure_reason',
        '# 31 态样本',
        1,
        fixtures.accountId,
        fixtures.accountId,
      ],
    );
  } else {
    await dataSource.query(
      'INSERT INTO `repair_request` (`request_no`, `customer_account_id`, `equipment_model_id`, ' +
        '`error_code`, `fault_description`, `content_md`, `is_accepted`) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        requestNo,
        fixtures.accountId,
        fixtures.equipmentModelId,
        '31-N-ERR',
        '31 态：普通工单',
        '# 31 态样本',
        0,
      ],
    );
  }
  const rows = readRows(
    await dataSource.query('SELECT `id` FROM `repair_request` WHERE `request_no` = ?', [requestNo]),
  );
  return readNumber(rows[0], 'id');
}

async function insertReport(
  dataSource: DataSource,
  fixtures: FixtureIds,
  variant: 'reviewed' | 'ai5',
): Promise<number> {
  const title = variant === 'reviewed' ? '31 态：已退回报告' : '31 态：AI 帮助度 5';
  const status = variant === 'reviewed' ? 'RETURNED' : 'DRAFT';
  const versionNo = variant === 'reviewed' ? 1 : 0;
  const submittedAt = variant === 'reviewed' ? new Date() : null;
  const reviewedAt = variant === 'reviewed' ? new Date() : null;
  const aiUsage = variant === 'ai5' ? 'USED' : 'NOT_USED';
  const aiSourceType = variant === 'ai5' ? 'REPAIR_AI' : null;
  const aiSourceId = variant === 'ai5' ? 'legacy-ai-summary' : null;
  const aiSourceVersion = variant === 'ai5' ? 'v31' : null;
  const aiHelpfulness = variant === 'ai5' ? 5 : null;

  await dataSource.query(
    'INSERT INTO `maintenance_report` (`owner_organization_id`, `source_type`, ' +
      '`repair_request_id`, `title`, `equipment_model_id`, `maintenance_engineer_account_id`, ' +
      '`maintenance_engineer_name_snapshot`, `status`, `current_version_no`, `last_submitted_at`, ' +
      '`last_reviewed_at`, `ai_usage`, `ai_source_type`, `ai_source_id`, `ai_source_version`, ' +
      '`ai_helpfulness`, `created_by_account_id`, `updated_by_account_id`) ' +
      "VALUES (?, 'HISTORICAL_CASE', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtures.organizationId,
      title,
      fixtures.equipmentModelId,
      fixtures.accountId,
      '样本工程师',
      status,
      versionNo,
      submittedAt,
      reviewedAt,
      aiUsage,
      aiSourceType,
      aiSourceId,
      aiSourceVersion,
      aiHelpfulness,
      fixtures.accountId,
      fixtures.accountId,
    ],
  );
  const rows = readRows(
    await dataSource.query(
      'SELECT `id` FROM `maintenance_report` WHERE `owner_organization_id` = ? AND `title` = ?',
      [fixtures.organizationId, title],
    ),
  );
  return readNumber(rows[0], 'id');
}

async function insertConversation(
  dataSource: DataSource,
  fixtures: FixtureIds,
  requestId: number,
  withFeedback: boolean,
): Promise<number> {
  await dataSource.query(
    'INSERT INTO `ai_conversation` (`request_id`, `engineer_account_id`, `status`, ' +
      "`ai_feedback`, `completed_at`) VALUES (?, ?, 'ACTIVE', ?, NULL)",
    [requestId, fixtures.accountId, withFeedback ? '31 态：ACTIVE 会话已有反馈' : null],
  );
  const rows = readRows(
    await dataSource.query(
      'SELECT `id` FROM `ai_conversation` WHERE `request_id` = ? ORDER BY `id` DESC LIMIT 1',
      [requestId],
    ),
  );
  return readNumber(rows[0], 'id');
}

async function insertScenarioFixtures(
  dataSource: DataSource,
  scenario: ScenarioName,
): Promise<FixtureIds> {
  const common = await insertCommonFixtures(dataSource, scenario);
  if (scenario === 'ctrl') {
    const requestId = await insertRepairRequest(dataSource, common, scenario, false);
    const reportId = await insertReport(dataSource, common, 'reviewed');
    const conversationId = await insertConversation(dataSource, common, requestId, false);
    return { ...common, repairRequestId: requestId, reportId, conversationId };
  }
  if (scenario === 'a_ai5') {
    const reportId = await insertReport(dataSource, common, 'ai5');
    return { ...common, reportId };
  }
  if (scenario === 'b_closure') {
    const requestId = await insertRepairRequest(dataSource, common, scenario, true);
    return { ...common, repairRequestId: requestId };
  }
  const requestId = await insertRepairRequest(dataSource, common, scenario, false);
  const conversationId = await insertConversation(dataSource, common, requestId, true);
  return { ...common, repairRequestId: requestId, conversationId };
}

async function readSampleRows(
  dataSource: DataSource,
  ids: FixtureIds,
  includeV13Facts = false,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  if (ids.reportId !== null) {
    rows.push(
      ...readRows(
        await dataSource.query(
          'SELECT `id`, `status`, `current_version_no`, `last_submitted_at`, `last_reviewed_at`, ' +
            '`ai_usage`, `ai_helpfulness` FROM `maintenance_report` WHERE `id` = ?',
          [ids.reportId],
        ),
      ),
    );
  }
  if (ids.repairRequestId !== null) {
    let v13Columns = '';
    if (includeV13Facts) {
      // 预期拒绝场景可能停在 1100000 之前，只有真实存在的 V13 列才能进入投影。
      const columnRows = readRows(
        await dataSource.query(
          'SELECT `COLUMN_NAME` AS `column_name` FROM `information_schema`.`COLUMNS` ' +
            "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'repair_request' " +
            "AND `COLUMN_NAME` IN ('is_historical', 'closure_status', 'closed_at', 'closure_reason')",
        ),
      );
      const existing = new Set(columnRows.map((row) => String(row['column_name'])));
      v13Columns = ['is_historical', 'closure_status', 'closed_at', 'closure_reason']
        .filter((column) => existing.has(column))
        .map((column) => `, \`${column}\``)
        .join('');
    }
    rows.push(
      ...readRows(
        await dataSource.query(
          'SELECT `id`, `is_accepted`, `handling_result`, `handling_status`, ' +
            `\`handling_recorded_at\`, \`handling_ended_at\`${v13Columns} ` +
            'FROM `repair_request` WHERE `id` = ?',
          [ids.repairRequestId],
        ),
      ),
    );
  }
  if (ids.conversationId !== null) {
    rows.push(
      ...readRows(
        await dataSource.query(
          'SELECT `id`, `status`, `ai_feedback`, `completed_at` FROM `ai_conversation` WHERE `id` = ?',
          [ids.conversationId],
        ),
      ),
    );
  }
  return rows;
}

/**
 * 从 31 态库导出本场景的历史身份清单（内存注入，不落库外文件）。
 * 真实部署必须用获授权人签字导出的库外清单，不能用本规格替代。
 */
function toNullableText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  throw new Error('历史身份清单读取到非文本列值');
}

async function buildLegacyManifest(
  dataSource: DataSource,
): Promise<LegacyRepairIdentityManifest | null> {
  // 31 态尚无 intake_id 列；清单指纹必须与升级时解析口径一致（缺失时按 NULL 计算）。
  const intakeColumnRows = readRows(
    await dataSource.query(
      'SELECT `COLUMN_NAME` AS `column_name` FROM `information_schema`.`COLUMNS` ' +
        'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? AND `COLUMN_NAME` = ?',
      ['repair_request', 'intake_id'],
    ),
  );
  const intakeExpression = intakeColumnRows.length > 0 ? '`intake_id`' : 'NULL AS `intake_id`';
  const rows = readRows(
    await dataSource.query(
      `SELECT \`id\`, ${intakeExpression}, \`handling_status\`, \`handling_result\` ` +
        'FROM `repair_request` ORDER BY `id`',
    ),
  );
  if (rows.length === 0) {
    return null;
  }
  return {
    formatVersion: 1,
    source: 'V13_31_STATE',
    frozenAt: new Date().toISOString(),
    rows: rows.map((row) => {
      const id = readNumber(row, 'id');
      const intakeId = row['intake_id'];
      return {
        id,
        fingerprint: fingerprintLegacyRepairRequestRow({
          id,
          intakeId: intakeId === null || intakeId === undefined ? null : Number(intakeId),
          handlingStatus: toNullableText(row['handling_status']),
          handlingResult: toNullableText(row['handling_result']),
        }),
      };
    }),
  };
}

async function readCommittedDdl(dataSource: DataSource): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const probe of DDL_PROBES) {
    const rows = readRows(
      await dataSource.query(
        'SELECT `COLUMN_NAME` AS `column_name` FROM `information_schema`.`COLUMNS` ' +
          'WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? AND `COLUMN_NAME` = ?',
        [probe.table, probe.column],
      ),
    );
    result[probe.key] = rows.length > 0;
  }
  return result;
}

async function readStructure(dataSource: DataSource): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of STRUCTURE_TABLES) {
    const rows = readRows(await dataSource.query(`SHOW CREATE TABLE \`${table}\``));
    if (rows.length > 0) {
      const values = Object.values(rows[0]);
      result[table] = values.length > 1 ? String(values[1]) : '';
    }
  }
  return result;
}

async function readMigrationHistory(
  dataSource: DataSource,
): Promise<ReadonlyArray<{ id: number; timestamp: number; name: string }>> {
  const rows = readRows(
    await dataSource.query(
      'SELECT `id` AS `id`, `timestamp` AS `timestamp`, `name` AS `name` ' +
        'FROM `migrations` ORDER BY `id` ASC',
    ),
  );
  return rows.map((row) => ({
    id: readNumber(row, 'id'),
    timestamp: readNumber(row, 'timestamp'),
    name: readString(row, 'name'),
  }));
}

function writeEvidence(runtime: UpgradeRuntime, evidence: UpgradeEvidence): string {
  fs.mkdirSync(runtime.evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(runtime.evidenceDir, `${runtime.scenario}-${stamp}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

const DESCRIBE_TITLE = ENABLED
  ? `v13 31→40 升级挡点（${readScenarioName()}）`
  : 'v13 31→40 升级挡点（默认关闭，设置 V13_UPGRADE_SPECS=1 启用）';

jest.setTimeout(180_000);

const describeUpgrade = ENABLED ? describe : describe.skip;

describeUpgrade(DESCRIBE_TITLE, () => {
  it('记录旧样本保存事实、正式升级结果与失败现场（不清理、不回退）', async () => {
    const runtime = resolveRuntime();
    const evidence: UpgradeEvidence = {
      scenario: runtime.scenario,
      database: runtime.database,
      startedAt: new Date().toISOString(),
      baselineCount: BASELINE_COUNT,
      baselineMigrationNames: [],
      legacySampleSaved: false,
      legacyIds: {},
      outcome: 'NOT_RUN',
      stage: 'BASELINE',
      executedMigrations: [],
      failedMigration: null,
      errorMessage: null,
      committedDdl: {},
      migrationHistoryCount: 0,
      migrationHistory: [],
      sampleRows: [],
      structure: {},
      cleanup: 'NONE',
    };

    const baseline = await buildBaseline31(runtime.config);
    const baselineNames = baseline.baselineNames;
    const repositoryNames = baseline.repositoryNames;
    evidence.baselineMigrationNames = baselineNames;

    let ids: FixtureIds;
    let legacyManifest: LegacyRepairIdentityManifest | null;
    try {
      ids = await insertScenarioFixtures(baseline.dataSource, runtime.scenario);
      evidence.legacySampleSaved = true;
      evidence.legacyIds = {
        organizationId: ids.organizationId,
        accountId: ids.accountId,
        equipmentModelId: ids.equipmentModelId,
        repairRequestId: ids.repairRequestId,
        reportId: ids.reportId,
        conversationId: ids.conversationId,
      };
      evidence.sampleRows = await readSampleRows(baseline.dataSource, ids);
      legacyManifest = await buildLegacyManifest(baseline.dataSource);
    } catch (error) {
      await baseline.dataSource.destroy();
      throw error;
    }
    await baseline.dataSource.destroy();
    // 正式入口会在每次部署前清空进程内清单，只认库外文件；这里按真实主键+指纹落盘 0600。
    let manifestFile: string | undefined;
    if (legacyManifest) {
      fs.mkdirSync(runtime.evidenceDir, { recursive: true });
      manifestFile = path.join(runtime.evidenceDir, `legacy-manifest-${runtime.scenario}.json`);
      fs.writeFileSync(manifestFile, `${JSON.stringify(legacyManifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    // 样本创建成功立即落盘登记真实 ID；失败也会保留现场证据。
    writeEvidence(runtime, evidence);

    const logger: MigrationLogger = {
      info: (message) => {
        process.stdout.write(`[v13-upg31] ${message}\n`);
      },
      warn: (message) => {
        process.stdout.write(`[v13-upg31][warn] ${message}\n`);
      },
      error: (message) => {
        process.stderr.write(`[v13-upg31][error] ${message}\n`);
      },
    };

    try {
      const executed = (
        await runDatabaseDeploy(
          {
            mode: 'upgrade',
            envFile: runtime.envFile,
            database: runtime.database,
            confirmDatabase: runtime.database,
            legacyRepairManifestFile: manifestFile,
          },
          logger,
        )
      ).executed;
      evidence.outcome = 'SUCCESS';
      evidence.stage = 'NONE';
      evidence.executedMigrations = executed;
    } catch (error) {
      evidence.outcome = 'FAILURE';
      evidence.errorMessage =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      evidence.stage = evidence.errorMessage.includes('升级前预检失败') ? 'PRECHECK' : 'MIGRATION';
    } finally {
      resetLegacyRepairIdentityManifest();
    }

    const inspector = createMigrationDataSource(runtime.config);
    await inspector.initialize();
    try {
      const history = await readMigrationHistory(inspector);
      evidence.migrationHistory = history;
      evidence.migrationHistoryCount = history.length;
      evidence.failedMigration =
        evidence.outcome === 'FAILURE' ? (repositoryNames[history.length] ?? null) : null;
      evidence.committedDdl = await readCommittedDdl(inspector);
      evidence.sampleRows = await readSampleRows(inspector, ids, true);
      evidence.structure = await readStructure(inspector);
    } finally {
      await inspector.destroy();
    }

    const evidencePath = writeEvidence(runtime, evidence);
    process.stdout.write(`[v13-upg31] 证据已写入 ${evidencePath}\n`);

    expect(evidence.legacySampleSaved).toBe(true);
    expect(evidence.migrationHistoryCount).toBeGreaterThanOrEqual(BASELINE_COUNT);

    const maintenanceReportStructure = (
      evidence.structure['maintenance_report'] ?? ''
    ).toLowerCase();
    const expectHelpfulnessRangeOneToFive = (): void => {
      expect(maintenanceReportStructure).toContain('between 1 and 5');
      expect(maintenanceReportStructure).not.toContain('between 1 and 4');
    };

    if (runtime.scenario === 'ctrl') {
      expect(evidence.outcome).toBe('SUCCESS');
      expect(evidence.failedMigration).toBeNull();
      expect(evidence.executedMigrations.length).toBe(repositoryNames.length - BASELINE_COUNT);
      for (const probe of DDL_PROBES) {
        expect(evidence.committedDdl[probe.key]).toBe(true);
      }
      expectHelpfulnessRangeOneToFive();
      return;
    }

    if (runtime.scenario === 'a_ai5') {
      // 修正后：31 态合法评分 5 不再阻断，升级后原值保留，终态约束为 1—5。
      expect(evidence.outcome).toBe('SUCCESS');
      expect(evidence.failedMigration).toBeNull();
      expect(evidence.executedMigrations.length).toBe(repositoryNames.length - BASELINE_COUNT);
      for (const probe of DDL_PROBES) {
        expect(evidence.committedDdl[probe.key]).toBe(true);
      }
      expectHelpfulnessRangeOneToFive();
      const reportRow = evidence.sampleRows.find((row) => 'ai_helpfulness' in row);
      expect(reportRow?.ai_helpfulness).toBe(5);
      return;
    }

    if (runtime.scenario === 'b_closure') {
      // 31 态合法的历史中断行：按冻结清单标记 is_historical 后成功升级，
      // 不补造 closure_reason，新原因约束只对历史行豁免。
      expect(evidence.outcome).toBe('SUCCESS');
      expect(evidence.failedMigration).toBeNull();
      expect(evidence.executedMigrations.length).toBe(repositoryNames.length - BASELINE_COUNT);
      for (const probe of DDL_PROBES) {
        expect(evidence.committedDdl[probe.key]).toBe(true);
      }
      const closureRow = evidence.sampleRows.find((row) => 'handling_result' in row);
      expect(closureRow?.handling_result).toBe('INTERRUPTED');
      expect(closureRow?.closure_reason).toBeNull();
      expect(Number(closureRow?.is_historical)).toBe(1);
      return;
    }

    // d_conv：兼容预检先于任何 ALTER 失败，历史停在第 31 条增量之后，
    // 1775501100000 的全部 DDL 都不得提交。
    expect(evidence.outcome).toBe('FAILURE');
    expect(evidence.stage).toBe('MIGRATION');
    expect(evidence.errorMessage).toContain('升级兼容预检失败');
    expect(evidence.failedMigration).toBe(repositoryNames[BASELINE_COUNT]);
    expect(evidence.failedMigration).toContain('AlterRepairAiReportForV13');
    expect(evidence.migrationHistoryCount).toBe(BASELINE_COUNT + 1);
    expect(evidence.migrationHistory[evidence.migrationHistory.length - 1]?.name).toBe(
      repositoryNames[BASELINE_COUNT],
    );
    for (const probe of DDL_PROBES) {
      expect(evidence.committedDdl[probe.key]).toBe(false);
    }
  });
});

const NONEMPTY_ENABLED = process.env.V13_NONEMPTY_SPECS === '1';
const NONEMPTY_DATABASE = 'lithography_v13_incremental_nonempty_r2';

const describeNonempty = NONEMPTY_ENABLED ? describe : describe.skip;

describeNonempty('v13 旧版增量非空升级（incremental_nonempty_r2）', () => {
  it('旧行保留、新事实为空、四列重复组在首次 DDL 前拒绝', async () => {
    if (process.env.E2E_ALLOW_PHYSICAL_CLEANUP !== '1') {
      throw new Error('未设置 E2E_ALLOW_PHYSICAL_CLEANUP=1；本规格会产生物理写入，已拒绝');
    }
    const envFile = path.resolve(requireEnv('V13_NONEMPTY_ENV_FILE'));
    if (!fs.existsSync(envFile)) {
      throw new Error(`环境文件不存在: ${envFile}`);
    }
    const config = loadExplicitEnvConfig(envFile, NONEMPTY_DATABASE);
    const evidenceDir = path.resolve(requireEnv('V13_NONEMPTY_EVIDENCE_DIR'));

    const probe = createMigrationDataSource(config);
    await probe.initialize();
    let entries: ReadonlyArray<{ name: string; timestamp: number }>;
    let instances: ReadonlyArray<object>;
    try {
      const actualDatabase = await readActualDatabase(probe);
      if (actualDatabase !== NONEMPTY_DATABASE) {
        throw new Error(
          `实际连接库与声明不一致：实际 ${actualDatabase}，声明 ${NONEMPTY_DATABASE}`,
        );
      }
      await assertEmptyTarget(probe, NONEMPTY_DATABASE);
      entries = readRepositoryMigrations(probe);
      instances = [...probe.migrations];
    } finally {
      await probe.destroy();
    }
    if (entries.length !== 41) {
      throw new Error(`仓库迁移应为 41 条，实际 ${entries.length}`);
    }
    const byName = new Map<string, MigrationConstructor>(
      instances.map((instance) => [
        resolveMigrationName(instance),
        (instance as { constructor: MigrationConstructor }).constructor,
      ]),
    );
    const oldStateClasses = entries.slice(0, 40).map((entry) => {
      const migrationClass = byName.get(entry.name);
      if (!migrationClass) {
        throw new Error(`无法从仓库迁移实例中定位 ${entry.name}`);
      }
      return migrationClass;
    });

    // 旧增量态：31 基线 + 1775501000000..1775501800000，全部由正常执行器记录历史。
    const oldState = createDataSourceWithMigrations(config, oldStateClasses);
    await oldState.initialize();
    let oldIds!: Record<string, string | number>;
    try {
      const executed = await oldState.runMigrations({ transaction: 'none' });
      if (executed.length !== 40) {
        throw new Error(`旧增量态实际执行 ${executed.length} 条，期望 40 条`);
      }
      const fixtures = await insertCommonFixtures(oldState, 'ctrl');
      const installationRows = readRows(
        await oldState.query('SELECT `installation_id` FROM `local_installation` LIMIT 1'),
      );
      const installationId = readString(installationRows[0], 'installation_id');

      await oldState.query(
        'INSERT INTO `local_backup_run` (`installation_id`, `trigger_type`, `status`, ' +
          '`started_at`, `finished_at`) VALUES (?, ?, ?, NOW(3), NOW(3))',
        [installationId, 'MANUAL', 'SUCCEEDED'],
      );
      const runRows = readRows(
        await oldState.query('SELECT `id` FROM `local_backup_run` ORDER BY `id` DESC LIMIT 1'),
      );
      const runId = readNumber(runRows[0], 'id');

      const duplicateRecordUuid = randomUUID();
      const receiptLocal = randomUUID();
      const receiptCloud = randomUUID();
      for (const [receiptId, sourceSystem] of [
        [receiptLocal, 'LOCAL'],
        [receiptCloud, 'CLOUD'],
      ] as const) {
        await oldState.query(
          'INSERT INTO `sync_receipt` (`receipt_id`, `record_uuid`, `organization_id`, ' +
            '`resource_type`, `version_no`, `source_system`, `receipt_status`, ' +
            '`manifest_checksum`, `confirmed_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
          [
            receiptId,
            duplicateRecordUuid,
            fixtures.organizationId,
            'MAINTENANCE_REPORT',
            1,
            sourceSystem,
            'PENDING',
            'a'.repeat(64),
          ],
        );
      }

      const backupA = randomUUID();
      const backupB = randomUUID();
      await oldState.query(
        'INSERT INTO `backup_asset` (`backup_id`, `run_id`, `organization_id`, ' +
          '`storage_reference`, `file_sha256`, `byte_size`, `cloud_status`, `local_status`, ' +
          '`cloud_receipt`, `attempt_count`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          backupA,
          runId,
          fixtures.organizationId,
          'cloud://legacy-assets/backup-a.bin',
          'b'.repeat(64),
          1024,
          'SUCCEEDED',
          'CLEANED',
          'legacy-cloud-receipt-a',
          1,
        ],
      );
      await oldState.query(
        'INSERT INTO `backup_asset` (`backup_id`, `run_id`, `organization_id`, ' +
          '`storage_reference`, `file_sha256`, `byte_size`, `cloud_status`, `local_status`, ' +
          '`cloud_receipt`, `attempt_count`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          backupB,
          runId,
          fixtures.organizationId,
          'cloud://legacy-assets/backup-b.bin',
          'c'.repeat(64),
          2048,
          'SUCCEEDED',
          'PENDING',
          'legacy-cloud-receipt-b',
          1,
        ],
      );

      await oldState.query(
        'INSERT INTO `backup_restore_run` (`restore_id`, `backup_id`, `protection_backup_id`, ' +
          '`organization_id`, `started_by_account_id`, `status`, `check_snapshot`, ' +
          '`restored_scope`, `result_summary`, `started_at`, `finished_at`) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))',
        [
          randomUUID(),
          backupA,
          backupB,
          fixtures.organizationId,
          fixtures.accountId,
          'SUCCEEDED',
          JSON.stringify({ schema_version: 1, checks: 'legacy' }),
          'legacy-scope',
          'legacy-summary',
        ],
      );

      const reportId = await insertReport(oldState, fixtures, 'reviewed');
      await oldState.query(
        'INSERT INTO `maintenance_report_fault` (`report_id`, `fault_uuid`, `branch_kind`, ' +
          '`step_code`, `fault_description`, `fault_cause`, `handling_action`, `status`, `source`) ' +
          "VALUES (?, ?, 'INITIAL_PANEL', NULL, ?, ?, ?, 'OPEN', 'USER')",
        [reportId, randomUUID(), '旧故障描述', '旧故障原因', '旧处理动作'],
      );

      await oldState.query(
        'INSERT INTO `local_company_setting` (`installation_id`, `organization_id`, ' +
          '`setting_source`, `is_current`) VALUES (?, ?, ?, 1)',
        [installationId, fixtures.organizationId, 'LOCAL_MANUAL'],
      );
      await oldState.query(
        'INSERT INTO `local_account_authorization` (`installation_id`, `account_id`, ' +
          "`organization_id`, `authorization_status`) VALUES (?, ?, ?, 'ACTIVE')",
        [installationId, fixtures.accountId, fixtures.organizationId],
      );

      oldIds = {
        installationId,
        duplicateRecordUuid,
        receiptLocal,
        receiptCloud,
        backupA,
        backupB,
        reportId,
      };
    } finally {
      await oldState.destroy();
    }

    const logger: MigrationLogger = {
      info: (message) => {
        process.stdout.write(`[v13-nonempty] ${message}\n`);
      },
      warn: (message) => {
        process.stdout.write(`[v13-nonempty][warn] ${message}\n`);
      },
      error: (message) => {
        process.stderr.write(`[v13-nonempty][error] ${message}\n`);
      },
    };

    const runDuplicatePrecheck = async (): Promise<{
      historyCount: number;
      newColumns: number;
      rowsPreserved: boolean;
      message: string;
    }> => {
      const inspector = createMigrationDataSource(config);
      await inspector.initialize();
      try {
        let message = '';
        try {
          await runDatabaseDeploy(
            {
              mode: 'upgrade',
              envFile,
              database: NONEMPTY_DATABASE,
              confirmDatabase: NONEMPTY_DATABASE,
            },
            logger,
          );
          throw new Error('四列重复组预检本应失败，但升级返回成功');
        } catch (error) {
          message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        if (!message.includes('四列唯一键存在重复组')) {
          throw new Error(`重复组预检失败信息不符合预期：${message}`);
        }
        const historyCount = (await readMigrationHistory(inspector)).length;
        const columnRows = readRows(
          await inspector.query(
            'SELECT COUNT(*) AS `count` FROM `information_schema`.`COLUMNS` ' +
              "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'sync_receipt' " +
              "AND `COLUMN_NAME` IN ('source_installation_id', 'remote_resource_id', 'received_at')",
          ),
        );
        const newColumns = readNumber(columnRows[0], 'count');
        const preserved = readRows(
          await inspector.query(
            'SELECT (SELECT COUNT(*) FROM `sync_receipt`) AS `receipts`, ' +
              '(SELECT COUNT(*) FROM `backup_asset`) AS `assets`, ' +
              '(SELECT COUNT(*) FROM `backup_restore_run`) AS `restores`, ' +
              '(SELECT COUNT(*) FROM `maintenance_report_fault`) AS `faults`',
          ),
        );
        const rowsPreserved =
          readNumber(preserved[0], 'receipts') === 2 &&
          readNumber(preserved[0], 'assets') === 2 &&
          readNumber(preserved[0], 'restores') === 1 &&
          readNumber(preserved[0], 'faults') === 1;

        // 仅删除本轮登记的重复样本（CLOUD 来源那一行），保留其余旧行。
        await inspector.query('DELETE FROM `sync_receipt` WHERE `receipt_id` = ?', [
          oldIds.receiptCloud,
        ]);
        return { historyCount, newColumns, rowsPreserved, message };
      } finally {
        await inspector.destroy();
      }
    };

    const precheck = await runDuplicatePrecheck();

    const upgraded = await runDatabaseDeploy(
      {
        mode: 'upgrade',
        envFile,
        database: NONEMPTY_DATABASE,
        confirmDatabase: NONEMPTY_DATABASE,
      },
      logger,
    );

    const checker = createMigrationDataSource(config);
    await checker.initialize();
    let verification: Record<string, unknown>;
    try {
      const history = await readMigrationHistory(checker);
      const counts = readRows(
        await checker.query(
          'SELECT (SELECT COUNT(*) FROM `sync_receipt`) AS `receipts`, ' +
            '(SELECT COUNT(*) FROM `backup_asset`) AS `assets`, ' +
            '(SELECT COUNT(*) FROM `backup_restore_run`) AS `restores`, ' +
            '(SELECT COUNT(*) FROM `maintenance_report_fault`) AS `faults`, ' +
            '(SELECT COUNT(*) FROM `local_company_setting`) AS `settings`, ' +
            '(SELECT COUNT(*) FROM `local_account_authorization`) AS `authorizations`',
        ),
      );
      const receipt = readRows(
        await checker.query(
          'SELECT `receipt_status`, `manifest_checksum`, `confirmed_at`, ' +
            '`source_installation_id`, `remote_resource_id`, `received_at` ' +
            'FROM `sync_receipt` WHERE `receipt_id` = ?',
          [oldIds.receiptLocal],
        ),
      );
      const asset = readRows(
        await checker.query(
          'SELECT `storage_reference`, `file_sha256`, `byte_size`, `cloud_status`, ' +
            '`local_status`, `cloud_receipt`, `attempt_count`, `installation_id`, ' +
            '`format_version`, `data_version`, `manifest_checksum`, `local_reference`, ' +
            '`cloud_reference`, `encryption_key_id`, `verified_at`, `retention_until`, ' +
            '`failure_reason`, `deleted_at`, `local_cleanup_error` ' +
            'FROM `backup_asset` WHERE `backup_id` = ?',
          [oldIds.backupA],
        ),
      );
      const restore = readRows(
        await checker.query(
          'SELECT `backup_id`, `protection_backup_id`, `status`, `check_snapshot`, ' +
            '`restored_scope`, `result_summary`, `started_at`, `finished_at`, ' +
            '`target_installation_id`, `check_status`, `confirmation` ' +
            'FROM `backup_restore_run` LIMIT 1',
        ),
      );
      const fault = readRows(
        await checker.query(
          'SELECT `branch_kind`, `lifecycle_status`, `lifecycle_source`, `status`, `source`, ' +
            '`fault_description`, `fault_cause`, `handling_action`, `main_error`, `unit_error`, ' +
            '`error_type`, `gpib_status`, `phase_code`, `is_active` ' +
            'FROM `maintenance_report_fault` LIMIT 1',
        ),
      );
      const setting = readRows(
        await checker.query(
          'SELECT `initialized_at`, `backup_interval_hours`, `backup_enabled`, ' +
            '`next_backup_at`, `auto_upload_enabled`, `failure_reason` ' +
            'FROM `local_company_setting` LIMIT 1',
        ),
      );
      const authorization = readRows(
        await checker.query(
          'SELECT `authorization_status`, `signed_claims`, `permission_version`, ' +
            '`last_verified_at` FROM `local_account_authorization` LIMIT 1',
        ),
      );
      verification = {
        historyCount: history.length,
        lastMigration: history[history.length - 1]?.name ?? null,
        executed: upgraded.executed,
        counts: counts[0],
        receipt: receipt[0],
        asset: asset[0],
        restore: restore[0],
        fault: fault[0],
        setting: setting[0],
        authorization: authorization[0],
        rejection: {
          historyCount: precheck.historyCount,
          newColumns: precheck.newColumns,
          rowsPreserved: precheck.rowsPreserved,
          message: precheck.message,
        },
      };
    } finally {
      await checker.destroy();
    }

    fs.mkdirSync(evidenceDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const evidencePath = path.join(evidenceDir, `nonempty-${stamp}.json`);
    fs.writeFileSync(evidencePath, `${JSON.stringify({ ids: oldIds, verification }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    process.stdout.write(`[v13-nonempty] 证据已写入 ${evidencePath}\n`);

    expect(verification.historyCount).toBe(41);
    expect((verification.executed as ReadonlyArray<string>).length).toBe(1);
    expect(precheck.historyCount).toBe(40);
    expect(precheck.newColumns).toBe(0);
    expect(precheck.rowsPreserved).toBe(true);

    const receiptRow = verification.receipt as Record<string, unknown>;
    expect(receiptRow.receipt_status).toBe('PENDING');
    expect(receiptRow.manifest_checksum).toBe('a'.repeat(64));
    expect(receiptRow.confirmed_at).toBeNull();
    expect(receiptRow.source_installation_id).toBeNull();
    expect(receiptRow.remote_resource_id).toBeNull();
    expect(receiptRow.received_at).toBeNull();

    const assetRow = verification.asset as Record<string, unknown>;
    expect(assetRow.storage_reference).toBe('cloud://legacy-assets/backup-a.bin');
    expect(assetRow.file_sha256).toBe('b'.repeat(64));
    expect(Number(assetRow.byte_size)).toBe(1024);
    expect(assetRow.cloud_status).toBe('SUCCEEDED');
    expect(assetRow.local_status).toBe('CLEANED');
    expect(assetRow.cloud_receipt).toBe('legacy-cloud-receipt-a');
    expect(Number(assetRow.attempt_count)).toBe(1);
    for (const column of [
      'installation_id',
      'format_version',
      'data_version',
      'manifest_checksum',
      'local_reference',
      'cloud_reference',
      'encryption_key_id',
      'verified_at',
      'retention_until',
      'failure_reason',
      'deleted_at',
      'local_cleanup_error',
    ]) {
      expect(assetRow[column] ?? null).toBeNull();
    }

    const restoreRow = verification.restore as Record<string, unknown>;
    expect(restoreRow.protection_backup_id).toBe(oldIds.backupB);
    expect(restoreRow.status).toBe('SUCCEEDED');
    expect(restoreRow.restored_scope).toBe('legacy-scope');
    expect(restoreRow.result_summary).toBe('legacy-summary');
    expect(restoreRow.target_installation_id).toBeNull();
    expect(restoreRow.check_status).toBeNull();
    expect(restoreRow.confirmation).toBeNull();

    const faultRow = verification.fault as Record<string, unknown>;
    expect(faultRow.lifecycle_status).toBe('OPEN');
    expect(faultRow.lifecycle_source).toBe('USER');
    expect(faultRow.fault_description).toBe('旧故障描述');
    expect(faultRow.fault_cause).toBe('旧故障原因');
    expect(faultRow.handling_action).toBe('旧处理动作');
    for (const column of [
      'status',
      'source',
      'main_error',
      'unit_error',
      'error_type',
      'gpib_status',
      'phase_code',
      'is_active',
    ]) {
      expect(faultRow[column] ?? null).toBeNull();
    }

    const settingRow = verification.setting as Record<string, unknown>;
    expect(settingRow.initialized_at).not.toBeNull();
    expect(Number(settingRow.backup_interval_hours)).toBe(72);
    expect(Number(settingRow.backup_enabled)).toBe(0);
    expect(Number(settingRow.auto_upload_enabled)).toBe(0);
    expect(settingRow.next_backup_at).toBeNull();
    expect(settingRow.failure_reason).toBeNull();

    const authorizationRow = verification.authorization as Record<string, unknown>;
    expect(authorizationRow.authorization_status).toBe('ACTIVE');
    expect(authorizationRow.signed_claims ?? null).toBeNull();
    expect(authorizationRow.permission_version ?? null).toBeNull();
    expect(authorizationRow.last_verified_at ?? null).toBeNull();

    const countRow = verification.counts as Record<string, unknown>;
    expect(readNumber(countRow, 'receipts')).toBe(1);
    expect(readNumber(countRow, 'assets')).toBe(2);
    expect(readNumber(countRow, 'restores')).toBe(1);
    expect(readNumber(countRow, 'faults')).toBe(1);
    expect(readNumber(countRow, 'settings')).toBe(1);
    expect(readNumber(countRow, 'authorizations')).toBe(1);
  }, 600_000);
});

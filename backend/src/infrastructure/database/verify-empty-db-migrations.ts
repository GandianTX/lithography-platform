// src/infrastructure/database/verify-empty-db-migrations.ts
import 'reflect-metadata';
import 'tsconfig-paths/register';

import databaseConfig from '@src/infrastructure/config/database.config';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';

type MysqlDataSourceOptions = Extract<DataSourceOptions, { type: 'mysql' | 'mariadb' }>;

interface MysqlConnectionConfig {
  type: 'mysql';
  host: string;
  port: number;
  username: string;
  password?: string;
  database?: string;
  timezone?: string;
  charset?: string;
  extra?: Record<string, unknown>;
}

const REQUIRED_TABLES = [
  'ai_provider_call_record',
  'ai_workflow_context',
  'base_user_account',
  'base_user_info',
  'base_async_task_record',
  'base_third_party_auth',
  'base_verification_record',
  'equipment_model',
  'repair_request',
  'ai_conversation',
  'ai_message',
  'ai_report',
  'engineer_response',
  'reference_document',
  'organization',
  'organization_membership',
  'content_submission',
  'material_submission_detail',
  'fault_case_submission_detail',
  'content_submission_attachment',
  'content_submission_revision',
  'content_submission_review',
  'reference_document_case_detail',
] as const;

const REQUIRED_INDEXES: ReadonlyArray<{ table: string; index: string }> = [
  { table: 'base_user_account', index: 'uk_login_email' },
  { table: 'base_third_party_auth', index: 'base_third_party_auth_provider_IDX' },
  { table: 'base_async_task_record', index: 'uk_queue_name_job_id' },
  { table: 'ai_provider_call_record', index: 'uk_ai_provider_call_trace_seq' },
  { table: 'ai_workflow_context', index: 'uk_ai_workflow_context_type_active_dedup_hash' },
  { table: 'ai_workflow_context', index: 'uk_ai_workflow_context_queue_job' },
  { table: 'base_verification_record', index: 'uk_token_fp' },
  { table: 'equipment_model', index: 'uk_equipment_model_code' },
  { table: 'repair_request', index: 'uk_repair_request_no' },
  { table: 'ai_message', index: 'uk_ai_message_conversation_seq' },
  { table: 'ai_report', index: 'uk_ai_report_conversation_type' },
  { table: 'organization', index: 'uk_organization_code' },
  { table: 'organization', index: 'idx_organization_kind_status' },
  { table: 'organization_membership', index: 'uk_organization_membership_org_account' },
  { table: 'organization_membership', index: 'idx_organization_membership_account_status' },
  { table: 'content_submission', index: 'idx_content_submission_org_status_updated' },
  { table: 'content_submission', index: 'idx_content_submission_submitter_status_updated' },
  {
    table: 'material_submission_detail',
    index: 'idx_material_submission_detail_equipment_model',
  },
  {
    table: 'fault_case_submission_detail',
    index: 'idx_fault_case_submission_detail_equipment_model',
  },
  {
    table: 'content_submission_attachment',
    index: 'uk_content_submission_attachment_id_submission',
  },
  {
    table: 'content_submission_attachment',
    index: 'idx_content_submission_attachment_submission_status',
  },
  {
    table: 'content_submission_attachment',
    index: 'idx_content_submission_attachment_uploaded_by',
  },
  { table: 'content_submission_revision', index: 'uk_content_submission_revision_submission_no' },
  { table: 'content_submission_revision', index: 'uk_content_submission_revision_id_submission' },
  { table: 'content_submission_revision', index: 'idx_content_submission_revision_attachment' },
  { table: 'content_submission_revision', index: 'idx_content_submission_revision_confirmed_by' },
  { table: 'content_submission_review', index: 'uk_content_submission_review_revision' },
  {
    table: 'content_submission_review',
    index: 'idx_content_submission_review_revision_submission',
  },
  {
    table: 'content_submission_review',
    index: 'idx_content_submission_review_submission_reviewed',
  },
  { table: 'content_submission_review', index: 'idx_content_submission_review_reviewed_by' },
  { table: 'reference_document', index: 'uk_reference_document_source_submission' },
  { table: 'reference_document', index: 'idx_reference_document_source_revision' },
  { table: 'reference_document', index: 'idx_reference_document_org_deleted_created' },
];

const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string; notNull?: boolean }> = [
  { table: 'base_user_info', column: 'company_name' },
  { table: 'ai_conversation', column: 'status' },
  { table: 'ai_conversation', column: 'ai_feedback' },
  { table: 'ai_conversation', column: 'completed_at' },
  { table: 'ai_message', column: 'message_seq' },
  { table: 'ai_message', column: 'turn_no' },
  { table: 'reference_document', column: 'deprecated' },
  { table: 'reference_document', column: 'deleted_at' },
  { table: 'reference_document', column: 'owner_organization_id', notNull: true },
  { table: 'reference_document', column: 'ingest_method', notNull: true },
  { table: 'reference_document', column: 'source_submission_id' },
  { table: 'reference_document', column: 'source_revision_id' },
  { table: 'reference_document', column: 'equipment_model_text' },
  { table: 'reference_document', column: 'updated_by_account_id' },
  { table: 'reference_document', column: 'extension_json' },
  { table: 'reference_document', column: 'schema_version' },
];

const FORBIDDEN_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'ai_conversation', column: 'content_md' },
];

const REQUIRED_CHECKS: ReadonlyArray<{ table: string; constraint: string }> = [
  { table: 'equipment_model', constraint: 'chk_equipment_model_enabled' },
  { table: 'repair_request', constraint: 'chk_repair_request_acceptance_consistency' },
  { table: 'repair_request', constraint: 'chk_repair_request_deletion_consistency' },
  { table: 'ai_conversation', constraint: 'chk_ai_conversation_completion' },
  { table: 'ai_message', constraint: 'chk_ai_message_turn' },
  { table: 'reference_document', constraint: 'chk_reference_document_deletion_consistency' },
  { table: 'reference_document', constraint: 'chk_reference_document_storage_pair' },
  { table: 'reference_document', constraint: 'chk_reference_document_content_source' },
  { table: 'organization', constraint: 'chk_organization_kind' },
  { table: 'organization', constraint: 'chk_organization_status' },
  { table: 'organization_membership', constraint: 'chk_organization_membership_role' },
  { table: 'organization_membership', constraint: 'chk_organization_membership_status' },
  { table: 'organization_membership', constraint: 'chk_organization_membership_period' },
  { table: 'content_submission', constraint: 'chk_content_submission_kind' },
  { table: 'content_submission', constraint: 'chk_content_submission_status' },
  { table: 'content_submission', constraint: 'chk_content_submission_revision_consistency' },
  { table: 'content_submission', constraint: 'chk_content_submission_publish_consistency' },
  {
    table: 'material_submission_detail',
    constraint: 'chk_material_submission_detail_model_exclusive',
  },
  { table: 'material_submission_detail', constraint: 'chk_material_submission_detail_type' },
  {
    table: 'fault_case_submission_detail',
    constraint: 'chk_fault_case_submission_detail_model_exclusive',
  },
  {
    table: 'fault_case_submission_detail',
    constraint: 'chk_fault_case_submission_detail_handling_status',
  },
  {
    table: 'fault_case_submission_detail',
    constraint: 'chk_fault_case_submission_detail_resolution',
  },
  {
    table: 'content_submission_attachment',
    constraint: 'chk_content_submission_attachment_status',
  },
  {
    table: 'content_submission_attachment',
    constraint: 'chk_content_submission_attachment_retire_consistency',
  },
  { table: 'content_submission_revision', constraint: 'chk_content_submission_revision_no' },
  { table: 'content_submission_revision', constraint: 'chk_content_submission_revision_title' },
  { table: 'content_submission_revision', constraint: 'chk_content_submission_revision_notice' },
  { table: 'content_submission_review', constraint: 'chk_content_submission_review_decision' },
  { table: 'content_submission_review', constraint: 'chk_content_submission_review_comment' },
  { table: 'content_submission_review', constraint: 'chk_content_submission_review_publish_flag' },
  {
    table: 'reference_document_case_detail',
    constraint: 'chk_reference_document_case_detail_status',
  },
  {
    table: 'reference_document_case_detail',
    constraint: 'chk_reference_document_case_detail_resolution',
  },
  { table: 'reference_document', constraint: 'chk_reference_document_ingest_method' },
  { table: 'reference_document', constraint: 'chk_reference_document_source_pair' },
  { table: 'reference_document', constraint: 'chk_reference_document_model_exclusive' },
];

const REQUIRED_FOREIGN_KEYS: ReadonlyArray<{
  table: string;
  constraint: string;
  referencedTable: string;
}> = [
  {
    table: 'base_user_info',
    constraint: 'base_user_info_ibfk_1',
    referencedTable: 'base_user_account',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_customer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'ai_conversation',
    constraint: 'fk_ai_conversation_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'ai_conversation',
    constraint: 'fk_ai_conversation_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'ai_message',
    constraint: 'fk_ai_message_conversation',
    referencedTable: 'ai_conversation',
  },
  {
    table: 'ai_report',
    constraint: 'fk_ai_report_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'ai_report',
    constraint: 'fk_ai_report_conversation',
    referencedTable: 'ai_conversation',
  },
  {
    table: 'ai_report',
    constraint: 'fk_ai_report_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'engineer_response',
    constraint: 'fk_engineer_response_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'engineer_response',
    constraint: 'fk_engineer_response_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'engineer_response',
    constraint: 'fk_engineer_response_customer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_created_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'organization_membership',
    constraint: 'fk_organization_membership_organization',
    referencedTable: 'organization',
  },
  {
    table: 'organization_membership',
    constraint: 'fk_organization_membership_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'content_submission',
    constraint: 'fk_content_submission_owner_organization',
    referencedTable: 'organization',
  },
  {
    table: 'content_submission',
    constraint: 'fk_content_submission_submitted_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'material_submission_detail',
    constraint: 'fk_material_submission_detail_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'material_submission_detail',
    constraint: 'fk_material_submission_detail_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'fault_case_submission_detail',
    constraint: 'fk_fault_case_submission_detail_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'fault_case_submission_detail',
    constraint: 'fk_fault_case_submission_detail_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'content_submission_attachment',
    constraint: 'fk_content_submission_attachment_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'content_submission_attachment',
    constraint: 'fk_content_submission_attachment_uploaded_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'content_submission_revision',
    constraint: 'fk_content_submission_revision_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'content_submission_revision',
    constraint: 'fk_content_submission_revision_attachment',
    referencedTable: 'content_submission_attachment',
  },
  {
    table: 'content_submission_revision',
    constraint: 'fk_content_submission_revision_confirmed_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'content_submission_review',
    constraint: 'fk_content_submission_review_revision',
    referencedTable: 'content_submission_revision',
  },
  {
    table: 'content_submission_review',
    constraint: 'fk_content_submission_review_reviewed_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'reference_document_case_detail',
    constraint: 'fk_reference_document_case_detail_document',
    referencedTable: 'reference_document',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_owner_organization',
    referencedTable: 'organization',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_source_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_source_revision',
    referencedTable: 'content_submission_revision',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_updated_by_account',
    referencedTable: 'base_user_account',
  },
];

interface DrillDatabaseTarget {
  readonly databaseName: string;
  readonly shouldCreate: boolean;
  readonly shouldDrop: boolean;
}

/**
 * 输出标准信息日志。
 */
function writeInfo(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * 输出标准错误日志。
 */
function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * 判断查询结果是否为数组结构。
 */
function isQueryRows(value: unknown): value is ReadonlyArray<Record<string, unknown>> {
  return Array.isArray(value);
}

/**
 * 执行存在性查询并返回结果。
 */
async function hasQueryResult(
  dataSource: DataSource,
  query: string,
  params: string[],
): Promise<boolean> {
  const rows: unknown = await dataSource.query(query, params);
  if (!isQueryRows(rows)) {
    throw new Error('查询返回格式异常，预期为数组');
  }
  return rows.length > 0;
}

/**
 * 加载 Migration 演练所需环境变量。
 */
function loadMigrationDrillEnv(): void {
  const candidates = [
    process.env.MIGRATION_DRILL_DOTENV
      ? path.resolve(process.cwd(), process.env.MIGRATION_DRILL_DOTENV)
      : null,
    path.resolve(process.cwd(), 'env/.env.e2e'),
    path.resolve(process.cwd(), 'env/.ev.e2e'),
    path.resolve(process.cwd(), 'env/.env.development'),
    path.resolve(process.cwd(), 'env/.ev.development'),
  ].filter((item): item is string => item !== null);

  const envFile = candidates.find((candidate) => fs.existsSync(candidate));
  if (envFile) {
    dotenv.config({ path: envFile });
    writeInfo(`🌱 已加载环境文件: ${envFile}`);
  } else {
    writeInfo('🌱 未找到环境文件，使用当前进程环境变量');
  }
}

/**
 * 解析演练数据库目标。
 */
function resolveDrillDatabaseTarget(mysqlConfig: MysqlConnectionConfig): DrillDatabaseTarget {
  const configuredDatabase = process.env.MIGRATION_DRILL_DATABASE?.trim();
  if (configuredDatabase) {
    return {
      databaseName: configuredDatabase,
      shouldCreate: false,
      shouldDrop: false,
    };
  }

  if (process.env.MIGRATION_DRILL_CREATE_TEMP_DB === 'true') {
    const dbPrefix = (mysqlConfig.database ?? 'worker_backend').replace(/[^a-zA-Z0-9_]/g, '_');
    return {
      databaseName: `${dbPrefix}_baseline_drill_${Date.now()}`,
      shouldCreate: true,
      shouldDrop: true,
    };
  }

  const configuredAppDatabase = mysqlConfig.database?.trim();
  if (configuredAppDatabase) {
    return {
      databaseName: configuredAppDatabase,
      shouldCreate: false,
      shouldDrop: false,
    };
  }

  throw new Error(
    '未指定演练数据库，请设置 DB_NAME 或 MIGRATION_DRILL_DATABASE；如确需临时建库，请设置 MIGRATION_DRILL_CREATE_TEMP_DB=true',
  );
}

/**
 * 读取并校验 MySQL 连接配置。
 */
function loadMysqlConfig(): MysqlConnectionConfig {
  const config = databaseConfig() as { mysql: MysqlConnectionConfig };
  const mysql = config.mysql;

  if (!mysql?.host || !mysql.port || !mysql.username) {
    throw new Error('数据库配置不完整，至少需要 DB_HOST/DB_PORT/DB_USER');
  }

  return mysql;
}

/**
 * 对数据库标识符进行安全转义。
 */
function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

/**
 * 构建用于管理库操作（创建/删除数据库）的连接配置。
 */
function buildAdminDataSourceOptions(config: MysqlConnectionConfig): MysqlDataSourceOptions {
  return {
    type: 'mysql',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    timezone: config.timezone,
    charset: config.charset,
    logging: false,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    extra: config.extra,
  };
}

/**
 * 构建用于执行 migration 的空库连接配置。
 */
function buildMigrationDataSourceOptions(
  config: MysqlConnectionConfig,
  databaseName: string,
  migrations?: ReadonlyArray<new () => unknown>,
): MysqlDataSourceOptions {
  const options: MysqlDataSourceOptions = {
    ...buildAdminDataSourceOptions(config),
    database: databaseName,
    migrations: migrations
      ? (migrations as unknown as MysqlDataSourceOptions['migrations'])
      : [
          path.resolve(__dirname, './migrations/*.migration.ts'),
          path.resolve(__dirname, './migrations/*.migration.js'),
        ],
  };

  return options;
}

/**
 * 校验关键表是否存在。
 */
async function assertRequiredTables(dataSource: DataSource, databaseName: string): Promise<void> {
  for (const tableName of REQUIRED_TABLES) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = ?
          AND table_name = ?
        LIMIT 1
      `,
      [databaseName, tableName],
    );

    if (!exists) {
      throw new Error(`关键表缺失: ${tableName}`);
    }
  }
}

/**
 * 校验关键索引是否存在。
 */
async function assertRequiredIndexes(dataSource: DataSource, databaseName: string): Promise<void> {
  for (const item of REQUIRED_INDEXES) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = ?
          AND table_name = ?
          AND index_name = ?
        LIMIT 1
      `,
      [databaseName, item.table, item.index],
    );

    if (!exists) {
      throw new Error(`关键索引缺失: ${item.table}.${item.index}`);
    }
  }
}

/**
 * 校验关键字段存在，并防止已废弃字段回归。
 */
async function assertRequiredColumns(dataSource: DataSource, databaseName: string): Promise<void> {
  for (const item of REQUIRED_COLUMNS) {
    const rows: unknown = await dataSource.query(
      `
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = ?
          AND column_name = ?
        LIMIT 1
      `,
      [databaseName, item.table, item.column],
    );

    if (!isQueryRows(rows) || rows.length === 0) {
      throw new Error(`关键字段缺失: ${item.table}.${item.column}`);
    }

    if (item.notNull) {
      // is_nullable 必须确为字符串才继续规范化；非字符串属查询结果异常，
      // 失败关闭而不是用 String() 折叠成 "[object Object]" 掩盖问题。
      const rawNullable = rows[0]['is_nullable'] ?? rows[0]['IS_NULLABLE'];
      if (typeof rawNullable !== 'string') {
        throw new Error(`关键字段 is_nullable 查询结果格式无效: ${item.table}.${item.column}`);
      }
      const isNullable = rawNullable.trim().toUpperCase();
      if (isNullable !== 'NO') {
        throw new Error(`关键字段允许 NULL，未完成收紧: ${item.table}.${item.column}`);
      }
    }
  }

  for (const item of FORBIDDEN_COLUMNS) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = ?
          AND column_name = ?
        LIMIT 1
      `,
      [databaseName, item.table, item.column],
    );

    if (exists) {
      throw new Error(`已废弃字段仍存在: ${item.table}.${item.column}`);
    }
  }
}

/**
 * 校验关键 CHECK 约束存在。
 */
async function assertRequiredChecks(dataSource: DataSource, databaseName: string): Promise<void> {
  for (const item of REQUIRED_CHECKS) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_schema = ?
          AND table_name = ?
          AND constraint_name = ?
          AND constraint_type = 'CHECK'
        LIMIT 1
      `,
      [databaseName, item.table, item.constraint],
    );

    if (!exists) {
      throw new Error(`关键 CHECK 约束缺失: ${item.table}.${item.constraint}`);
    }
  }
}

/**
 * 校验关键外键是否存在。
 */
async function assertRequiredForeignKeys(
  dataSource: DataSource,
  databaseName: string,
): Promise<void> {
  for (const item of REQUIRED_FOREIGN_KEYS) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.referential_constraints
        WHERE constraint_schema = ?
          AND table_name = ?
          AND constraint_name = ?
          AND referenced_table_name = ?
        LIMIT 1
      `,
      [databaseName, item.table, item.constraint, item.referencedTable],
    );

    if (!exists) {
      throw new Error(`关键外键缺失: ${item.table}.${item.constraint} -> ${item.referencedTable}`);
    }
  }
}

/**
 * 校验目标数据库名称，避免误操作生产库。
 */
function ensureSafeDatabaseTarget(databaseName: string): void {
  const isExplicitlyAllowed = process.env.MIGRATION_DRILL_ALLOW_NON_TEST_DB === 'true';
  const lower = databaseName.toLowerCase();
  const looksSafe = lower.includes('test') || lower.includes('drill') || lower.includes('ci');

  if (!looksSafe && !isExplicitlyAllowed) {
    throw new Error(
      `数据库名 ${databaseName} 未包含 test/drill/ci，已拒绝执行。若确认安全请设置 MIGRATION_DRILL_ALLOW_NON_TEST_DB=true`,
    );
  }
}

/**
 * 清空目标数据库中的全部表，确保 migration 在空库语义下执行。
 */
async function clearDatabaseTables(dataSource: DataSource, databaseName: string): Promise<void> {
  const rows: unknown = await dataSource.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
    `,
    [databaseName],
  );

  if (!isQueryRows(rows)) {
    throw new Error('读取数据库表清单失败，返回格式异常');
  }

  if (rows.length === 0) {
    return;
  }

  await dataSource.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const row of rows) {
      const tableNameCandidate = row['table_name'] ?? row['TABLE_NAME'];
      const tableNameValue =
        typeof tableNameCandidate === 'string' ? tableNameCandidate : String(tableNameCandidate);
      if (typeof tableNameValue !== 'string' || tableNameValue.length === 0) {
        throw new Error('读取到非法表名，无法继续清库');
      }
      await dataSource.query(`DROP TABLE IF EXISTS ${escapeIdentifier(tableNameValue)}`);
    }
  } finally {
    await dataSource.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

/**
 * 解析旧库升级演练基线数量（T02，可重跑）。
 * 未设置或非正整数时返回 null，表示执行常规空库演练。
 */
function parseBaselineCount(total: number): number | null {
  const raw = process.env.MIGRATION_DRILL_BASELINE_COUNT?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`MIGRATION_DRILL_BASELINE_COUNT 必须为正整数，实际: ${raw}`);
  }
  if (parsed >= total) {
    throw new Error(`基线数量 ${parsed} 必须小于迁移总数 ${total}`);
  }
  return parsed;
}

/**
 * 提取迁移类名，用于比对已执行迁移记录。
 */
function resolveMigrationName(migration: unknown): string {
  const candidate = (migration as { name?: unknown }).name;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  throw new Error('迁移项缺少可识别的名称，无法进行升级演练校验');
}

/**
 * 解析迁移时间戳（类名末尾 13 位数字），与 TypeORM 的排序口径一致。
 */
function resolveMigrationTimestamp(migration: unknown): number {
  const name = resolveMigrationName(migration);
  const timestamp = Number.parseInt(name.slice(-13), 10);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`无法从迁移名解析时间戳: ${name}`);
  }
  return timestamp;
}

/**
 * 将 dataSource 上的迁移实例还原为按时间戳升序的迁移类，供子集演练使用。
 */
function toMigrationClasses(instances: ReadonlyArray<unknown>): ReadonlyArray<new () => unknown> {
  return [...instances]
    .sort((a, b) => resolveMigrationTimestamp(a) - resolveMigrationTimestamp(b))
    .map((migration) => (migration as { constructor: new () => unknown }).constructor);
}

/**
 * 在旧基线库上写入旧表旧列可用的 fixture，模拟旧库数据。
 */
async function insertLegacyUpgradeFixtures(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `INSERT INTO \`equipment_model\` (\`id\`, \`model_code\`, \`model_name\`, \`enabled\`, \`sort_order\`) VALUES (900001, 'T02-LEGACY-MODEL', 'T02 旧机型', 1, 1)`,
  );
  await dataSource.query(
    `INSERT INTO \`base_user_account\` (\`id\`, \`login_name\`, \`login_password\`, \`status\`) VALUES (900001, 't02_legacy_user', 'legacy-password-hash', 'ACTIVE')`,
  );
  await dataSource.query(
    `INSERT INTO \`reference_document\` (\`id\`, \`title\`, \`document_type\`, \`equipment_model_id\`, \`content_text\`, \`created_by_account_id\`, \`deprecated\`, \`deleted_at\`) VALUES (900001, 'T02 旧资料', 'MANUAL', 900001, 'T02 旧库升级基线内容', 900001, 0, NULL)`,
  );
}

/**
 * 校验迁移记录条数与新增迁移均已执行。
 */
async function assertMigrationsTableCount(
  dataSource: DataSource,
  databaseName: string,
  expected: number,
  expectedNewNames: ReadonlyArray<string>,
): Promise<void> {
  const rows: unknown = await dataSource.query(
    `SELECT COUNT(*) AS total FROM \`${databaseName}\`.\`migrations\``,
  );
  if (!isQueryRows(rows) || rows.length === 0) {
    throw new Error('读取 migrations 记录失败，返回格式异常');
  }
  const rawTotal = rows[0]['total'] ?? rows[0]['TOTAL'];
  const total = Number(rawTotal);
  if (total !== expected) {
    throw new Error(`migrations 记录数不符：预期 ${expected}，实际 ${String(rawTotal)}`);
  }

  for (const name of expectedNewNames) {
    const exists = await hasQueryResult(
      dataSource,
      `SELECT 1 FROM \`${databaseName}\`.\`migrations\` WHERE \`name\` = ? LIMIT 1`,
      [name],
    );
    if (!exists) {
      throw new Error(`新增迁移未记录: ${name}`);
    }
  }
}

/**
 * 校验旧库 fixture 在升级后保留且归属/入库方式已回填。
 */
async function assertLegacyUpgradeFixtures(dataSource: DataSource): Promise<void> {
  const equipmentRows: unknown = await dataSource.query(
    `SELECT \`model_code\` FROM \`equipment_model\` WHERE \`id\` = 900001 LIMIT 1`,
  );
  if (!isQueryRows(equipmentRows) || equipmentRows.length === 0) {
    throw new Error('旧库 fixture 丢失: equipment_model 900001 不存在（旧表数据未保留）');
  }

  const accountRows: unknown = await dataSource.query(
    `SELECT \`login_name\` FROM \`base_user_account\` WHERE \`id\` = 900001 LIMIT 1`,
  );
  if (!isQueryRows(accountRows) || accountRows.length === 0) {
    throw new Error('旧库 fixture 丢失: base_user_account 900001 不存在（旧表数据未保留）');
  }

  const documentRows: unknown = await dataSource.query(
    `SELECT \`owner_organization_id\`, \`ingest_method\`, \`schema_version\` FROM \`reference_document\` WHERE \`id\` = 900001 LIMIT 1`,
  );
  if (!isQueryRows(documentRows) || documentRows.length === 0) {
    throw new Error('旧库 fixture 丢失: reference_document 900001 不存在（旧资料未保留）');
  }
  const doc = documentRows[0];
  const ingestMethod = doc['ingest_method'] ?? doc['INGEST_METHOD'];
  if (ingestMethod !== 'ADMIN_DIRECT') {
    throw new Error(`旧资料入库方式回填错误：预期 ADMIN_DIRECT，实际 ${String(ingestMethod)}`);
  }
  const ownerValue = doc['owner_organization_id'] ?? doc['OWNER_ORGANIZATION_ID'];
  const ownerRows: unknown = await dataSource.query(
    `SELECT \`id\` FROM \`organization\` WHERE \`organization_code\` = 'CLIENT_DEFAULT' LIMIT 1`,
  );
  if (!isQueryRows(ownerRows) || ownerRows.length === 0) {
    throw new Error('回填目标组织 CLIENT_DEFAULT 不存在');
  }
  const expectedOwner = ownerRows[0]['id'] ?? ownerRows[0]['ID'];
  if (Number(ownerValue) !== Number(expectedOwner)) {
    throw new Error(
      `旧资料归属回填错误：预期组织 ${String(expectedOwner)}，实际 ${String(ownerValue)}`,
    );
  }
}

/**
 * 执行旧库升级演练（T02 可重跑版）：旧基线迁移 + 旧 fixture → 只执行新增迁移。
 */
async function runUpgradeMigrationDrill(
  migrationDataSource: DataSource,
  allMigrations: ReadonlyArray<new () => unknown>,
  mysqlConfig: MysqlConnectionConfig,
  databaseName: string,
  baselineCount: number,
): Promise<number> {
  const total = allMigrations.length;
  const expectedUpgrade = total - baselineCount;
  writeInfo(
    `🧱 旧库升级演练：旧基线 ${baselineCount} 条 + 新增 ${expectedUpgrade} 条（共 ${total} 条）`,
  );

  await clearDatabaseTables(migrationDataSource, databaseName);
  writeInfo('🧽 目标数据库已清空（模拟旧库前置）');

  const baselineDataSource = new DataSource(
    buildMigrationDataSourceOptions(
      mysqlConfig,
      databaseName,
      allMigrations.slice(0, baselineCount),
    ),
  );
  await baselineDataSource.initialize();
  let baselineExecuted: ReadonlyArray<unknown>;
  try {
    baselineExecuted = await baselineDataSource.runMigrations({ transaction: 'all' });
  } finally {
    await baselineDataSource.destroy();
  }
  if (baselineExecuted.length !== baselineCount) {
    throw new Error(`旧基线迁移数量不符：预期 ${baselineCount}，实际 ${baselineExecuted.length}`);
  }
  writeInfo(`✅ 旧基线迁移执行 ${baselineExecuted.length} 条`);

  await insertLegacyUpgradeFixtures(migrationDataSource);
  writeInfo('🗂️ 已写入旧库 fixture（旧表旧列可用）');

  const upgradeDataSource = new DataSource(
    buildMigrationDataSourceOptions(mysqlConfig, databaseName, allMigrations),
  );
  await upgradeDataSource.initialize();
  let upgradeExecuted: ReadonlyArray<unknown>;
  let secondRunCount: number;
  try {
    upgradeExecuted = await upgradeDataSource.runMigrations({ transaction: 'all' });
    if (upgradeExecuted.length !== expectedUpgrade) {
      throw new Error(
        `升级仅应执行新增 ${expectedUpgrade} 条，实际 ${upgradeExecuted.length} 条（旧迁移被重跑）`,
      );
    }
    await assertMigrationsTableCount(
      upgradeDataSource,
      databaseName,
      total,
      allMigrations.slice(baselineCount).map(resolveMigrationName),
    );
    await assertLegacyUpgradeFixtures(upgradeDataSource);

    const secondRun = await upgradeDataSource.runMigrations({ transaction: 'all' });
    if (secondRun.length !== 0) {
      throw new Error(`升级后再次执行应为 0 条，实际 ${secondRun.length} 条`);
    }
    secondRunCount = secondRun.length;
  } finally {
    await upgradeDataSource.destroy();
  }
  writeInfo(`✅ 升级只执行新增迁移 ${upgradeExecuted.length} 条，旧迁移无重跑`);
  writeInfo(
    `✅ 旧库 fixture 保留且归属/入库方式回填正确；升级后幂等（再次执行 ${secondRunCount} 条）`,
  );

  return total;
}

/**
 * 执行空库 migration 演练，失败时抛错以阻断 CI。
 */
async function runEmptyDbMigrationDrill(): Promise<void> {
  loadMigrationDrillEnv();
  const mysqlConfig = loadMysqlConfig();
  const target = resolveDrillDatabaseTarget(mysqlConfig);
  ensureSafeDatabaseTarget(target.databaseName);

  const adminDataSource = new DataSource(buildAdminDataSourceOptions(mysqlConfig));
  const migrationDataSource = new DataSource(
    buildMigrationDataSourceOptions(mysqlConfig, target.databaseName),
  );

  let adminInitialized = false;
  let migrationInitialized = false;

  try {
    writeInfo('🔧 开始空库 migration 演练...');
    await adminDataSource.initialize();
    adminInitialized = true;

    if (target.shouldCreate) {
      try {
        await adminDataSource.query(
          `CREATE DATABASE ${escapeIdentifier(target.databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        writeInfo(`🆕 已创建空库: ${target.databaseName}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '未知建库错误';
        throw new Error(
          `自动建库失败，请为当前账号授予 CREATE/DROP DATABASE 权限，或设置 MIGRATION_DRILL_DATABASE 使用预置空库。原始错误: ${message}`,
          {
            cause: error,
          },
        );
      }
    } else {
      writeInfo(`📌 使用指定演练库: ${target.databaseName}`);
    }

    try {
      await migrationDataSource.initialize();
      migrationInitialized = true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '未知连接错误';
      throw new Error(
        `连接演练库失败，请确认账号对 ${target.databaseName} 具备访问与建表权限，或改用 MIGRATION_DRILL_DATABASE。原始错误: ${message}`,
        {
          cause: error,
        },
      );
    }
    const allMigrations = toMigrationClasses(migrationDataSource.migrations);
    const baselineCount = parseBaselineCount(allMigrations.length);
    if (baselineCount === null) {
      await clearDatabaseTables(migrationDataSource, target.databaseName);
      writeInfo('🧽 目标数据库已清空');

      const executedMigrations = await migrationDataSource.runMigrations({ transaction: 'all' });
      if (executedMigrations.length === 0) {
        throw new Error('未执行任何 migration，请检查 migration 配置');
      }
      writeInfo(`✅ migration 执行成功，共 ${executedMigrations.length} 条`);
    } else {
      await runUpgradeMigrationDrill(
        migrationDataSource,
        allMigrations,
        mysqlConfig,
        target.databaseName,
        baselineCount,
      );
    }

    await assertRequiredTables(migrationDataSource, target.databaseName);
    await assertRequiredColumns(migrationDataSource, target.databaseName);
    await assertRequiredIndexes(migrationDataSource, target.databaseName);
    await assertRequiredChecks(migrationDataSource, target.databaseName);
    await assertRequiredForeignKeys(migrationDataSource, target.databaseName);
    writeInfo('✅ 关键表、字段、索引、CHECK 与外键校验通过');
    writeInfo(baselineCount === null ? '🎉 空库 migration 演练通过' : '🎉 旧库升级演练通过');
  } finally {
    if (migrationInitialized) {
      await migrationDataSource.destroy();
    }
    if (adminInitialized && target.shouldDrop) {
      try {
        await adminDataSource.query(
          `DROP DATABASE IF EXISTS ${escapeIdentifier(target.databaseName)}`,
        );
        writeInfo(`🧹 已清理临时数据库: ${target.databaseName}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '未知清理错误';
        writeError(`⚠️ 临时数据库清理失败: ${message}`);
      }
    }
    if (adminInitialized) {
      await adminDataSource.destroy();
    }
  }
}

void runEmptyDbMigrationDrill().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '未知错误';
  writeError(`❌ 空库 migration 演练失败: ${message}`);
  process.exit(1);
});

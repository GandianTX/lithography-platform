// src/infrastructure/database/incremental-migration.ts
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, DataSourceOptions, QueryRunner } from 'typeorm';

import {
  FORBIDDEN_COLUMNS,
  PrefixForeignKeyRequirement,
  PrefixIndexRequirement,
  PrefixStructureRequirement,
  REQUIRED_TABLES,
  collectAllStructureRequirements,
  collectPrefixStructureRequirements,
  hasQueryResult,
  isQueryRows,
  resolveMigrationName,
  resolveMigrationTimestamp,
} from './migration-schema-contract';

type MysqlDataSourceOptions = Extract<DataSourceOptions, { type: 'mysql' | 'mariadb' }>;

export type MigrationCommand = 'status' | 'run' | 'verify';

export interface MigrationCliOptions {
  readonly command: MigrationCommand;
  readonly envFile: string;
  readonly database: string;
  readonly confirmDatabase?: string;
}

export interface MigrationDbConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string;
  readonly database: string;
  readonly timezone: string;
  readonly charset: string;
}

export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface MigrationRepositoryEntry {
  readonly name: string;
  readonly timestamp: number;
}

export interface MigrationHistoryEntry {
  readonly id: number;
  readonly timestamp: number;
  readonly name: string;
}

export interface MigrationTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly serverVersion: string;
}

export interface MigrationState {
  readonly target: MigrationTarget;
  readonly migrationsTableExists: boolean;
  readonly history: ReadonlyArray<MigrationHistoryEntry>;
  readonly repository: ReadonlyArray<MigrationRepositoryEntry>;
  readonly pending: ReadonlyArray<MigrationRepositoryEntry>;
  readonly issues: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export interface VerificationReport {
  readonly target: MigrationTarget;
  readonly issues: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly businessTableCount: number;
}

export interface MigrationRunReport {
  readonly target: MigrationTarget;
  readonly executed: ReadonlyArray<string>;
  readonly pendingBefore: ReadonlyArray<string>;
  readonly pendingAfter: ReadonlyArray<string>;
  readonly verification: VerificationReport;
}

export interface MigrationRunCleanupTask {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface MigrationRunDependencies {
  readonly createDataSource: (config: MigrationDbConfig) => DataSource;
  readonly lockTimeoutSeconds?: number;
  readonly migrationsDir?: string;
}

// 注意：不能使用 --env-file。Node 20.6+ 原生支持 --env-file，且会在脚本执行前
// 拦截该参数（文件缺失时直接退出），导致本入口的显式配置校验无法生效。
const ENV_FILE_OPTION = '--config-file';
const DATABASE_OPTION = '--database';
const CONFIRM_DATABASE_OPTION = '--confirm-database';
const MIGRATION_LOCK_PREFIX = 'lithography:migration';

/**
 * 解析迁移 CLI 参数。命令必须显式给出，所有目标参数都必填，避免隐式回落到其他环境。
 */
export function parseMigrationCliArgs(argv: ReadonlyArray<string>): MigrationCliOptions {
  const args = [...argv];
  const command = args.shift();
  if (command !== 'status' && command !== 'run' && command !== 'verify') {
    throw new Error(
      '缺少有效命令：请使用 migration:status / migration:run / migration:verify 之一',
    );
  }

  let envFile: string | undefined;
  let database: string | undefined;
  let confirmDatabase: string | undefined;

  while (args.length > 0) {
    const token = args.shift();
    if (typeof token !== 'string') {
      throw new Error('参数解析异常');
    }
    const separatorIndex = token.indexOf('=');
    const option = separatorIndex >= 0 ? token.slice(0, separatorIndex) : token;
    const inlineValue = separatorIndex >= 0 ? token.slice(separatorIndex + 1) : undefined;
    const value = inlineValue ?? args.shift();

    if (!option.startsWith('--')) {
      throw new Error(`不支持的位置参数: ${option}`);
    }
    if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
      throw new Error(`参数 ${option} 缺少有效值`);
    }

    switch (option) {
      case ENV_FILE_OPTION:
        envFile = value;
        break;
      case DATABASE_OPTION:
        database = value;
        break;
      case CONFIRM_DATABASE_OPTION:
        confirmDatabase = value;
        break;
      default:
        throw new Error(`不支持的参数: ${option}`);
    }
  }

  if (!envFile) {
    throw new Error(`必须显式指定 ${ENV_FILE_OPTION}，不会自动回落其他环境文件`);
  }
  if (!database) {
    throw new Error(`必须显式指定 ${DATABASE_OPTION}`);
  }
  if (command === 'run') {
    if (!confirmDatabase) {
      throw new Error(`migration:run 必须提供 ${CONFIRM_DATABASE_OPTION} 再次确认目标库`);
    }
    if (confirmDatabase !== database) {
      throw new Error(
        `目标确认不一致：${DATABASE_OPTION}=${database}，${CONFIRM_DATABASE_OPTION}=${confirmDatabase}`,
      );
    }
  }

  return { command, envFile, database, confirmDatabase };
}

/**
 * 读取显式环境文件并校验数据库连接字段。文件缺失/无效立即失败，不自动回落。
 */
export function loadExplicitEnvConfig(
  envFile: string,
  expectedDatabase: string,
  cwd: string = process.cwd(),
): MigrationDbConfig {
  const resolvedPath = path.isAbsolute(envFile) ? envFile : path.resolve(cwd, envFile);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`环境文件不存在: ${resolvedPath}`);
  }
  const content = fs.readFileSync(resolvedPath, 'utf8');
  if (content.trim().length === 0) {
    throw new Error(`环境文件为空: ${resolvedPath}`);
  }
  const parsed = dotenv.parse(content);
  const host = readRequiredEnv(parsed, 'DB_HOST', resolvedPath);
  const username = readRequiredEnv(parsed, 'DB_USER', resolvedPath);
  const database = readRequiredEnv(parsed, 'DB_NAME', resolvedPath);
  const rawPort = readRequiredEnv(parsed, 'DB_PORT', resolvedPath);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('环境文件中的 DB_PORT 必须为 1-65535 的整数');
  }
  if (database !== expectedDatabase) {
    throw new Error(
      `环境文件目标库与参数不一致：文件 DB_NAME=${database}，参数 --database=${expectedDatabase}`,
    );
  }
  const synchronize = (parsed.DB_SYNCHRONIZE ?? '').trim().toLowerCase();
  if (synchronize === 'true') {
    throw new Error('环境文件声明 DB_SYNCHRONIZE=true，与迁移入口强制 synchronize=false 冲突');
  }

  return {
    host,
    port,
    username,
    password: parsed.DB_PASS,
    database,
    timezone: (parsed.DB_TIMEZONE ?? '+08:00').trim() || '+08:00',
    charset: 'utf8mb4',
  };
}

/**
 * 读取必填环境变量，错误信息不包含变量值。
 */
function readRequiredEnv(parsed: Record<string, string>, key: string, envFile: string): string {
  const value = parsed[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`环境文件 ${envFile} 缺少 ${key}`);
  }
  return value.trim();
}

/**
 * 构建迁移专用 DataSource；强制关闭 synchronize / dropSchema / migrationsRun。
 */
export function createMigrationDataSource(config: MigrationDbConfig): DataSource {
  const options: MysqlDataSourceOptions = {
    type: 'mysql',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    timezone: config.timezone,
    charset: config.charset,
    logging: false,
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    migrations: [
      path.resolve(__dirname, './migrations/*.migration.ts'),
      path.resolve(__dirname, './migrations/*.migration.js'),
    ],
    extra: {
      connectionLimit: 4,
      connectTimeout: 60000,
    },
  };

  return new DataSource(options);
}

/**
 * 读取仓库中的迁移清单（类名 + 时间戳），并校验时间戳唯一且升序。
 */
export function readRepositoryMigrations(
  dataSource: DataSource,
): ReadonlyArray<MigrationRepositoryEntry> {
  const instances: ReadonlyArray<unknown> = dataSource.migrations;
  if (instances.length === 0) {
    throw new Error('未从仓库迁移目录加载到任何迁移，请检查 TS/JS 运行模式与迁移文件');
  }

  const entries = instances
    .map((instance) => ({
      name: resolveMigrationName(instance),
      timestamp: resolveMigrationTimestamp(instance),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const seenNames = new Set<string>();
  const seenTimestamps = new Set<number>();
  for (const entry of entries) {
    if (seenNames.has(entry.name)) {
      throw new Error(`仓库迁移名称重复: ${entry.name}`);
    }
    if (seenTimestamps.has(entry.timestamp)) {
      throw new Error(`仓库迁移时间戳重复: ${entry.timestamp}（${entry.name}）`);
    }
    seenNames.add(entry.name);
    seenTimestamps.add(entry.timestamp);
  }

  return entries;
}

/**
 * 读取实际连接目标与服务器版本，并核对与显式声明一致。
 */
export async function readAndAssertTarget(
  dataSource: DataSource,
  expectedDatabase: string,
): Promise<MigrationTarget> {
  const rows: unknown = await dataSource.query(
    'SELECT DATABASE() AS current_database, VERSION() AS server_version',
  );
  if (!isQueryRows(rows) || rows.length === 0) {
    throw new Error('无法读取实际连接数据库，查询结果格式异常');
  }
  const currentDatabase = readRowString(rows[0], ['current_database', 'CURRENT_DATABASE']);
  if (currentDatabase !== expectedDatabase) {
    throw new Error(
      `实际连接库与声明不一致：实际 ${currentDatabase ?? '<空>'}，声明 ${expectedDatabase}`,
    );
  }
  const serverVersion = readRowString(rows[0], ['server_version', 'SERVER_VERSION']) ?? '未知';
  const options = dataSource.options as MysqlDataSourceOptions;

  return {
    host: String(options.host ?? ''),
    port: Number(options.port ?? 0),
    database: currentDatabase,
    serverVersion,
  };
}

/**
 * 读取一行中的字符串字段，兼容 MySQL 驱动的大小写差异。
 */
function readRowString(row: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

/**
 * 读取数据库中全部基础表名称。
 */
export async function readBaseTableNames(
  dataSource: DataSource,
  databaseName: string,
): Promise<ReadonlyArray<string>> {
  const rows: unknown = await dataSource.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `,
    [databaseName],
  );
  if (!isQueryRows(rows)) {
    throw new Error('读取数据库表清单失败，返回格式异常');
  }
  return rows
    .map((row) => row['table_name'] ?? row['TABLE_NAME'])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/**
 * 读取 migrations 记录表是否存在及历史行。
 */
export async function readMigrationHistory(
  dataSource: DataSource,
  databaseName: string,
): Promise<{ migrationsTableExists: boolean; history: ReadonlyArray<MigrationHistoryEntry> }> {
  const migrationsTableExists = await hasQueryResult(
    dataSource,
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_name = 'migrations'
      LIMIT 1
    `,
    [databaseName],
  );
  if (!migrationsTableExists) {
    return { migrationsTableExists: false, history: [] };
  }

  const rows: unknown = await dataSource.query(
    'SELECT id, timestamp, name FROM migrations ORDER BY id ASC',
  );
  if (!isQueryRows(rows)) {
    throw new Error('读取 migrations 记录失败，返回格式异常');
  }
  const history = rows.map((row) => ({
    id: Number(row['id'] ?? row['ID']),
    timestamp: Number(row['timestamp'] ?? row['TIMESTAMP']),
    name: readRowString(row, ['name', 'NAME']) ?? '',
  }));

  return { migrationsTableExists, history };
}

/**
 * 校验已执行历史必须是仓库迁移的完整有序前缀。
 */
export function classifyHistoryIssues(
  repository: ReadonlyArray<MigrationRepositoryEntry>,
  history: ReadonlyArray<MigrationHistoryEntry>,
): ReadonlyArray<string> {
  const issues: string[] = [];
  if (history.length === 0) {
    issues.push('未发现任何已执行迁移记录，拒绝把“有旧表”推断为“迁移已执行”');
    return issues;
  }
  if (history.length > repository.length) {
    issues.push(`已执行迁移数 ${history.length} 超过仓库迁移数 ${repository.length}，存在未知记录`);
  }

  const seen = new Set<string>();
  for (const executed of history) {
    if (seen.has(executed.name)) {
      issues.push(`迁移记录重复: ${executed.name}`);
    }
    seen.add(executed.name);
  }

  const compareLength = Math.min(history.length, repository.length);
  for (let index = 0; index < compareLength; index += 1) {
    const executed = history[index];
    const expected = repository[index];
    if (executed.name !== expected.name) {
      issues.push(
        `迁移历史顺序与仓库不一致：第 ${index + 1} 条记录为 ${executed.name}，仓库应为 ${expected.name}`,
      );
      continue;
    }
    if (executed.timestamp !== expected.timestamp) {
      issues.push(
        `迁移记录时间戳不一致：${executed.name} 记录 ${executed.timestamp}，仓库 ${expected.timestamp}`,
      );
    }
  }

  for (const executed of history) {
    if (!repository.some((entry) => entry.name === executed.name)) {
      issues.push(`迁移记录不在当前仓库中: ${executed.name}`);
    }
  }

  return issues;
}

interface MigrationArtifacts {
  readonly createdTables: ReadonlyArray<string>;
  readonly addedColumns: ReadonlyArray<{ table: string; column: string }>;
  readonly addedObjects: ReadonlyArray<{ table: string; name: string }>;
}

/**
 * 列出迁移目录下与时间戳对应的文件，供只读结构预检使用。
 */
function resolveMigrationFiles(migrationsDir: string): ReadonlyMap<number, string> {
  const files = new Map<number, string>();
  if (!fs.existsSync(migrationsDir)) {
    return files;
  }
  for (const fileName of fs.readdirSync(migrationsDir)) {
    if (!/\.migration\.(ts|js)$/.test(fileName)) {
      continue;
    }
    const match = /^(\d{13})-/.exec(fileName);
    if (!match) {
      continue;
    }
    const timestamp = Number(match[1]);
    if (!files.has(timestamp)) {
      files.set(timestamp, path.resolve(migrationsDir, fileName));
    }
  }
  return files;
}

/**
 * 从迁移文件文本中提取建表、加列、加约束/索引目标，仅用于只读漂移检测。
 */
function parseMigrationArtifacts(content: string): MigrationArtifacts {
  // 迁移源码多用模板字符串，SQL 标识符反引号会被转义为 \`。先还原再解析，
  // 否则结构预检会漏掉全部建表/加列/加约束目标，半迁移检测形同虚设。
  const normalized = content.replace(/\\`/g, '`');
  // 只解析 up() 主体：down() 里的反向 DDL 不代表迁移前应缺失的对象。
  const upStart = normalized.search(/public\s+async\s+up\s*\(/);
  const downStart = normalized.search(/public\s+async\s+down\s*\(/);
  const scoped =
    upStart >= 0
      ? normalized.slice(upStart, downStart > upStart ? downStart : undefined)
      : normalized;
  const createdTables: string[] = [];
  const addedColumns: Array<{ table: string; column: string }> = [];
  const addedObjects: Array<{ table: string; name: string }> = [];
  // up() 内先 DROP 再 ADD 的同名约束属于“改定义”，不能当作迁移前应缺失的新对象。
  const droppedObjects = new Set<string>();

  const createTablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/gi;
  let createMatch = createTablePattern.exec(scoped);
  while (createMatch !== null) {
    createdTables.push(createMatch[1]);
    createMatch = createTablePattern.exec(scoped);
  }

  const dropObjectPattern =
    /DROP\s+(?:CHECK\s+|FOREIGN\s+KEY\s+|INDEX\s+|KEY\s+|CONSTRAINT\s+)?`([^`]+)`/gi;
  let dropMatch = dropObjectPattern.exec(scoped);
  while (dropMatch !== null) {
    droppedObjects.add(dropMatch[1]);
    dropMatch = dropObjectPattern.exec(scoped);
  }

  const alterPattern = /ALTER\s+TABLE\s+`([^`]+)`([\s\S]*?)(?=ALTER\s+TABLE\s+`|$)/gi;
  let alterMatch = alterPattern.exec(scoped);
  while (alterMatch !== null) {
    const table = alterMatch[1];
    const clause = alterMatch[2];
    const columnPattern = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/gi;
    let columnMatch = columnPattern.exec(clause);
    while (columnMatch !== null) {
      addedColumns.push({ table, column: columnMatch[1] });
      columnMatch = columnPattern.exec(clause);
    }
    const objectPattern = /ADD\s+(?:CONSTRAINT\s+|UNIQUE\s+KEY\s+|KEY\s+|INDEX\s+)`([^`]+)`/gi;
    let objectMatch = objectPattern.exec(clause);
    while (objectMatch !== null) {
      if (!droppedObjects.has(objectMatch[1])) {
        addedObjects.push({ table, name: objectMatch[1] });
      }
      objectMatch = objectPattern.exec(clause);
    }
    alterMatch = alterPattern.exec(scoped);
  }

  return { createdTables, addedColumns, addedObjects };
}

/**
 * 读取仓库迁移对应的结构目标；文件缺失时抛错，避免盲目放行。
 */
function loadMigrationArtifacts(
  repository: ReadonlyArray<MigrationRepositoryEntry>,
  migrationsDir: string,
): ReadonlyMap<number, MigrationArtifacts> {
  const files = resolveMigrationFiles(migrationsDir);
  const artifacts = new Map<number, MigrationArtifacts>();
  for (const entry of repository) {
    const file = files.get(entry.timestamp);
    if (!file) {
      throw new Error(`未找到迁移文件: ${entry.name}（时间戳 ${entry.timestamp}）`);
    }
    artifacts.set(entry.timestamp, parseMigrationArtifacts(fs.readFileSync(file, 'utf8')));
  }
  return artifacts;
}

/**
 * 检查指定表是否存在。
 */
async function tableExists(
  dataSource: DataSource,
  databaseName: string,
  tableName: string,
): Promise<boolean> {
  return hasQueryResult(
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
}

/**
 * 检查指定列是否存在。
 */
async function columnExists(
  dataSource: DataSource,
  databaseName: string,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  return hasQueryResult(
    dataSource,
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = ?
        AND column_name = ?
      LIMIT 1
    `,
    [databaseName, tableName, columnName],
  );
}

/**
 * 检查指定索引/约束是否存在（索引按 statistics，约束按 table_constraints）。
 */
async function objectExists(
  dataSource: DataSource,
  databaseName: string,
  tableName: string,
  objectName: string,
): Promise<boolean> {
  const asIndex = await hasQueryResult(
    dataSource,
    `
      SELECT 1
      FROM information_schema.statistics
      WHERE table_schema = ?
        AND table_name = ?
        AND index_name = ?
      LIMIT 1
    `,
    [databaseName, tableName, objectName],
  );
  if (asIndex) {
    return true;
  }
  return hasQueryResult(
    dataSource,
    `
      SELECT 1
      FROM information_schema.table_constraints
      WHERE constraint_schema = ?
        AND table_name = ?
        AND constraint_name = ?
      LIMIT 1
    `,
    [databaseName, tableName, objectName],
  );
}

/**
 * 比较有序值数组，顺序不同即视为定义漂移。
 */
function sameOrderedValues(
  expected: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
): boolean {
  if (expected.length !== actual.length) {
    return false;
  }
  return expected.every((value, index) => value === actual[index]);
}

/**
 * 比较单个索引：读取全部列并按 seq_in_index 排序，拒绝表达式/前缀索引。
 */
async function collectIndexIssues(
  dataSource: DataSource,
  databaseName: string,
  item: PrefixIndexRequirement,
): Promise<ReadonlyArray<string>> {
  const rows: unknown = await dataSource.query(
    `
      SELECT seq_in_index, column_name, non_unique, sub_part, expression
      FROM information_schema.statistics
      WHERE table_schema = ?
        AND table_name = ?
        AND index_name = ?
      ORDER BY seq_in_index ASC
    `,
    [databaseName, item.table, item.name],
  );
  if (!isQueryRows(rows) || rows.length === 0) {
    return [`关键索引缺失: ${item.table}.${item.name}`];
  }

  let actualUnique: boolean | null = null;
  const actualColumns: string[] = [];
  for (const row of rows) {
    const nonUnique = Number(row['non_unique'] ?? row['NON_UNIQUE']);
    if (!Number.isFinite(nonUnique)) {
      throw new Error(`关键索引定义查询结果格式无效: ${item.table}.${item.name}`);
    }
    const rowUnique = nonUnique === 0;
    if (actualUnique === null) {
      actualUnique = rowUnique;
    } else if (actualUnique !== rowUnique) {
      throw new Error(`关键索引唯一性不一致: ${item.table}.${item.name}`);
    }

    const expression = readRowString(row, ['expression', 'EXPRESSION']);
    if (expression !== null && expression.length > 0) {
      return [`关键索引不支持表达式索引: ${item.table}.${item.name}`];
    }
    const rawSubPart = row['sub_part'] ?? row['SUB_PART'];
    if (rawSubPart !== null && rawSubPart !== undefined && Number(rawSubPart) > 0) {
      return [`关键索引不接受前缀索引: ${item.table}.${item.name}`];
    }
    const column = readRowString(row, ['column_name', 'COLUMN_NAME']);
    if (column === null || column.length === 0) {
      throw new Error(`关键索引列定义查询结果格式无效: ${item.table}.${item.name}`);
    }
    actualColumns.push(column);
  }

  if (actualUnique === null) {
    throw new Error(`关键索引唯一性查询结果为空: ${item.table}.${item.name}`);
  }
  const issues: string[] = [];
  if (actualUnique !== item.unique) {
    issues.push(
      `关键索引定义不符: ${item.table}.${item.name} 期望${item.unique ? '唯一' : '非唯一'}，实际${actualUnique ? '唯一' : '非唯一'}`,
    );
  }
  if (!sameOrderedValues(item.columns, actualColumns)) {
    issues.push(
      `关键索引列定义不符: ${item.table}.${item.name} 期望(${item.columns.join(', ')})，实际(${actualColumns.join(', ')})`,
    );
  }
  return issues;
}

/**
 * 比较单个外键：按 ORDINAL_POSITION 读取本地列与引用列，并核对引用 schema。
 */
async function collectForeignKeyIssues(
  dataSource: DataSource,
  databaseName: string,
  item: PrefixForeignKeyRequirement,
): Promise<ReadonlyArray<string>> {
  const exists = await hasQueryResult(
    dataSource,
    `
      SELECT 1
      FROM information_schema.table_constraints
      WHERE constraint_schema = ?
        AND table_name = ?
        AND constraint_name = ?
        AND constraint_type = 'FOREIGN KEY'
      LIMIT 1
    `,
    [databaseName, item.table, item.name],
  );
  if (!exists) {
    return [`关键外键缺失: ${item.table}.${item.name} -> ${item.referenceTable}`];
  }

  const rows: unknown = await dataSource.query(
    `
      SELECT ordinal_position, column_name, referenced_table_schema,
             referenced_table_name, referenced_column_name
      FROM information_schema.key_column_usage
      WHERE constraint_schema = ?
        AND table_name = ?
        AND constraint_name = ?
      ORDER BY ordinal_position ASC
    `,
    [databaseName, item.table, item.name],
  );
  if (!isQueryRows(rows) || rows.length === 0) {
    throw new Error(`关键外键列映射查询结果为空: ${item.table}.${item.name}`);
  }

  const actualLocal: string[] = [];
  const actualReference: string[] = [];
  let actualSchema: string | null = null;
  let actualTable: string | null = null;
  for (const row of rows) {
    const local = readRowString(row, ['column_name', 'COLUMN_NAME']);
    const reference = readRowString(row, ['referenced_column_name', 'REFERENCED_COLUMN_NAME']);
    const referenceTable = readRowString(row, ['referenced_table_name', 'REFERENCED_TABLE_NAME']);
    const referenceSchema = readRowString(row, [
      'referenced_table_schema',
      'REFERENCED_TABLE_SCHEMA',
    ]);
    if (
      local === null ||
      local.length === 0 ||
      reference === null ||
      reference.length === 0 ||
      referenceTable === null ||
      referenceTable.length === 0 ||
      referenceSchema === null ||
      referenceSchema.length === 0
    ) {
      throw new Error(`关键外键列映射查询结果格式无效: ${item.table}.${item.name}`);
    }
    if (actualSchema === null) {
      actualSchema = referenceSchema;
    } else if (actualSchema !== referenceSchema) {
      throw new Error(`关键外键引用 schema 不一致: ${item.table}.${item.name}`);
    }
    if (actualTable === null) {
      actualTable = referenceTable;
    } else if (actualTable !== referenceTable) {
      throw new Error(`关键外键引用表不一致: ${item.table}.${item.name}`);
    }
    actualLocal.push(local);
    actualReference.push(reference);
  }

  const issues: string[] = [];
  if (actualSchema !== databaseName) {
    issues.push(
      `关键外键引用 schema 不符: ${item.table}.${item.name} 期望 ${databaseName}，实际 ${String(actualSchema)}`,
    );
  }
  if (
    actualTable !== item.referenceTable ||
    !sameOrderedValues(item.localColumns, actualLocal) ||
    !sameOrderedValues(item.referenceColumns, actualReference)
  ) {
    issues.push(
      `关键外键定义不符: ${item.table}.${item.name} 期望 (${item.localColumns.join(', ')}) -> ${databaseName}.${item.referenceTable}(${item.referenceColumns.join(', ')})，实际 (${actualLocal.join(', ')}) -> ${String(actualSchema)}.${String(actualTable)}(${actualReference.join(', ')})`,
    );
  }
  return issues;
}

/**
 * 共用结构比较：status/run 预检与最终 verify 使用同一套规则。
 */
async function collectStructureIssues(
  dataSource: DataSource,
  databaseName: string,
  requirements: ReadonlyArray<PrefixStructureRequirement>,
): Promise<ReadonlyArray<string>> {
  const issues: string[] = [];

  for (const item of requirements) {
    switch (item.kind) {
      case 'table': {
        if (!(await tableExists(dataSource, databaseName, item.table))) {
          issues.push(`关键表缺失: ${item.table}`);
        }
        break;
      }
      case 'index': {
        issues.push(...(await collectIndexIssues(dataSource, databaseName, item)));
        break;
      }
      case 'column': {
        const exists = await columnExists(dataSource, databaseName, item.table, item.name);
        if (!exists) {
          issues.push(`关键字段缺失: ${item.table}.${item.name}`);
          break;
        }
        if (item.notNull) {
          const nullable = await readColumnNullable(
            dataSource,
            databaseName,
            item.table,
            item.name,
          );
          if (nullable !== 'NO') {
            issues.push(`关键字段允许 NULL，未完成收紧: ${item.table}.${item.name}`);
          }
        }
        break;
      }
      case 'check': {
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
          [databaseName, item.table, item.name],
        );
        if (!exists) {
          issues.push(`关键 CHECK 约束缺失: ${item.table}.${item.name}`);
        }
        break;
      }
      case 'foreign_key': {
        issues.push(...(await collectForeignKeyIssues(dataSource, databaseName, item)));
        break;
      }
      default: {
        const exhaustive: never = item;
        throw new Error(`未知的关键结构类型: ${String(exhaustive)}`);
      }
    }
  }

  return issues;
}

/**
 * 只读检查历史与真实结构：已执行迁移建的表必须存在，待执行迁移的目标对象必须不存在。
 */
export async function inspectMigrationState(
  dataSource: DataSource,
  databaseName: string,
  migrationsDir: string = path.resolve(__dirname, './migrations'),
): Promise<MigrationState> {
  const target = await readAndAssertTarget(dataSource, databaseName);
  const repository = readRepositoryMigrations(dataSource);
  const { migrationsTableExists, history } = await readMigrationHistory(dataSource, databaseName);
  const issues = [...classifyHistoryIssues(repository, history)];
  const warnings: string[] = [];
  const pending = repository.slice(history.length);

  let artifacts: ReadonlyMap<number, MigrationArtifacts>;
  try {
    artifacts = loadMigrationArtifacts(repository, migrationsDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '读取迁移文件失败';
    throw new Error(`无法完成只读结构预检: ${message}`, { cause: error });
  }

  const executedTimestamps = new Set(history.map((entry) => entry.timestamp));
  issues.push(
    ...(await collectStructureIssues(
      dataSource,
      databaseName,
      collectPrefixStructureRequirements(executedTimestamps),
    )),
  );

  for (const executed of history) {
    const artifact = artifacts.get(executed.timestamp);
    if (!artifact) {
      continue;
    }
    for (const tableName of artifact.createdTables) {
      if (!(await tableExists(dataSource, databaseName, tableName))) {
        const prefixMessage = `关键表缺失: ${tableName}`;
        if (!issues.includes(prefixMessage)) {
          issues.push(`已记录迁移但结构缺失：${executed.name} 应已创建表 ${tableName}`);
        }
      }
    }
  }

  for (const entry of pending) {
    const artifact = artifacts.get(entry.timestamp);
    if (!artifact) {
      warnings.push(`未找到待执行迁移的源文件，跳过对象预检: ${entry.name}`);
      continue;
    }
    for (const tableName of artifact.createdTables) {
      if (await tableExists(dataSource, databaseName, tableName)) {
        issues.push(`疑似半迁移：表 ${tableName} 已存在，但 ${entry.name} 未记录为已执行`);
      }
    }
    for (const column of artifact.addedColumns) {
      if (await columnExists(dataSource, databaseName, column.table, column.column)) {
        issues.push(
          `疑似半迁移：列 ${column.table}.${column.column} 已存在，但 ${entry.name} 未记录为已执行`,
        );
      }
    }
    for (const object of artifact.addedObjects) {
      if (await objectExists(dataSource, databaseName, object.table, object.name)) {
        issues.push(
          `疑似半迁移：索引/约束 ${object.table}.${object.name} 已存在，但 ${entry.name} 未记录为已执行`,
        );
      }
    }
  }

  if (!migrationsTableExists) {
    issues.push('migrations 记录表不存在，无法确认已执行历史');
  }

  return {
    target,
    migrationsTableExists,
    history,
    repository,
    pending,
    issues,
    warnings,
  };
}

/**
 * 收集最终结构差异，逐项输出而不是只看总表数。
 */
export async function collectStructuralIssues(
  dataSource: DataSource,
  databaseName: string,
): Promise<{ issues: string[]; warnings: string[]; businessTableCount: number }> {
  const warnings: string[] = [];
  const actualTables = await readBaseTableNames(dataSource, databaseName);
  const businessTables = actualTables.filter(
    (table) => table !== 'migrations' && table !== 'typeorm_metadata',
  );
  const expected = new Set<string>(REQUIRED_TABLES);
  const actual = new Set<string>(businessTables);

  for (const table of actual) {
    if (!expected.has(table)) {
      warnings.push(`存在预期之外的业务表: ${table}`);
    }
  }

  const issues = [
    ...(await collectStructureIssues(dataSource, databaseName, collectAllStructureRequirements())),
  ];

  for (const item of FORBIDDEN_COLUMNS) {
    if (await columnExists(dataSource, databaseName, item.table, item.column)) {
      issues.push(`已废弃字段仍存在: ${item.table}.${item.column}`);
    }
  }

  return { issues, warnings, businessTableCount: businessTables.length };
}

/**
 * 读取列的可空标记。
 */
async function readColumnNullable(
  dataSource: DataSource,
  databaseName: string,
  tableName: string,
  columnName: string,
): Promise<string | null> {
  const rows: unknown = await dataSource.query(
    `
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = ?
        AND column_name = ?
      LIMIT 1
    `,
    [databaseName, tableName, columnName],
  );
  if (!isQueryRows(rows) || rows.length === 0) {
    return null;
  }
  return readRowString(rows[0], ['is_nullable', 'IS_NULLABLE']);
}

/**
 * 查询标量计数。
 */
async function queryCount(
  dataSource: DataSource,
  query: string,
  params: ReadonlyArray<string | number> = [],
): Promise<number> {
  const rows: unknown = await dataSource.query(query, [...params]);
  if (!isQueryRows(rows) || rows.length === 0) {
    throw new Error('计数查询返回格式异常');
  }
  const raw = rows[0]['total'] ?? rows[0]['TOTAL'];
  const total = Number(raw);
  if (!Number.isFinite(total)) {
    throw new Error('计数查询结果不是有效数字');
  }
  return total;
}

/**
 * 校验旧资料回填、归属完整性以及默认组织唯一性。
 */
export async function collectDataIssues(
  dataSource: DataSource,
  databaseName: string,
): Promise<ReadonlyArray<string>> {
  const issues: string[] = [];
  if (!(await tableExists(dataSource, databaseName, 'reference_document'))) {
    issues.push('reference_document 表不存在，无法核对旧资料回填');
    return issues;
  }
  const hasOwnerColumns =
    (await columnExists(dataSource, databaseName, 'reference_document', 'owner_organization_id')) &&
    (await columnExists(dataSource, databaseName, 'reference_document', 'ingest_method'));
  if (!hasOwnerColumns) {
    issues.push('reference_document 缺少归属/入库方式字段，尚未完成升级回填');
    return issues;
  }

  const hasOrganization = await tableExists(dataSource, databaseName, 'organization');
  if (hasOrganization) {
    const referenceTotal = await queryCount(
      dataSource,
      'SELECT COUNT(*) AS total FROM `reference_document`',
    );
    const defaultOrganizations = await queryCount(
      dataSource,
      "SELECT COUNT(*) AS total FROM `organization` WHERE `organization_code` = 'CLIENT_DEFAULT'",
    );
    // 无旧资料时，默认组织可能已被测试清理删除，不据此判定迁移失败；
    // 只要存在旧资料，就必须能落到唯一的默认组织。
    if (referenceTotal > 0 && defaultOrganizations !== 1) {
      issues.push(`默认组织 CLIENT_DEFAULT 数量应为 1，实际 ${String(defaultOrganizations)}`);
    }
  } else {
    issues.push('organization 表不存在，无法核对默认组织');
  }

  const nullBackfill = await queryCount(
    dataSource,
    `
      SELECT COUNT(*) AS total
      FROM \`reference_document\`
      WHERE \`owner_organization_id\` IS NULL
        OR \`ingest_method\` IS NULL
    `,
  );
  if (nullBackfill !== 0) {
    issues.push(`旧资料归属/入库方式存在 NULL：${String(nullBackfill)} 行`);
  }

  if (hasOrganization) {
    const danglingOwner = await queryCount(
      dataSource,
      `
        SELECT COUNT(*) AS total
        FROM \`reference_document\` rd
        LEFT JOIN \`organization\` o ON o.\`id\` = rd.\`owner_organization_id\`
        WHERE o.\`id\` IS NULL
      `,
    );
    if (danglingOwner !== 0) {
      issues.push(`旧资料归属指向不存在的组织：${String(danglingOwner)} 行`);
    }
  }

  const hasSourceColumns =
    (await columnExists(dataSource, databaseName, 'reference_document', 'source_submission_id')) &&
    (await columnExists(dataSource, databaseName, 'reference_document', 'source_revision_id'));
  if (hasSourceColumns) {
    const sourcePairBroken = await queryCount(
      dataSource,
      `
        SELECT COUNT(*) AS total
        FROM \`reference_document\`
        WHERE (\`source_submission_id\` IS NULL) <> (\`source_revision_id\` IS NULL)
      `,
    );
    if (sourcePairBroken !== 0) {
      issues.push(`资料回链字段不成对：${String(sourcePairBroken)} 行`);
    }
  } else {
    issues.push('reference_document 缺少来源回链字段，尚未完成升级');
  }

  return issues;
}

/**
 * 最终校验：历史完整、结构齐备、回填数据正确、无剩余 pending。
 */
export async function verifyMigrationState(
  dataSource: DataSource,
  databaseName: string,
): Promise<VerificationReport> {
  const target = await readAndAssertTarget(dataSource, databaseName);
  const repository = readRepositoryMigrations(dataSource);
  const { migrationsTableExists, history } = await readMigrationHistory(dataSource, databaseName);
  const issues = [...classifyHistoryIssues(repository, history)];
  const warnings: string[] = [];

  if (!migrationsTableExists) {
    issues.push('migrations 记录表不存在，无法确认迁移完成');
  }
  if (history.length !== repository.length) {
    issues.push(`迁移未完成：仓库 ${repository.length} 条，已记录 ${history.length} 条`);
  }
  for (let index = 0; index < Math.min(history.length, repository.length); index += 1) {
    if (history[index].name !== repository[index].name) {
      issues.push(
        `迁移历史与仓库不一致：第 ${index + 1} 条记录 ${history[index].name}，仓库 ${repository[index].name}`,
      );
    }
  }

  const structural = await collectStructuralIssues(dataSource, databaseName);
  issues.push(...structural.issues);
  warnings.push(...structural.warnings);
  issues.push(...(await collectDataIssues(dataSource, databaseName)));

  return {
    target,
    issues,
    warnings,
    businessTableCount: structural.businessTableCount,
  };
}

/**
 * 执行待执行迁移，并核对返回结果与预检 pending 一致。
 */
export async function executePendingMigrations(
  dataSource: DataSource,
  pending: ReadonlyArray<MigrationRepositoryEntry>,
): Promise<ReadonlyArray<string>> {
  const executedInstances = await dataSource.runMigrations({ transaction: 'none' });
  const executed = executedInstances.map((migration) => resolveMigrationName(migration));
  const expected = pending.map((entry) => entry.name);
  if (executed.length !== expected.length) {
    throw new Error(
      `执行迁移数量与待执行清单不一致：预检 ${expected.length} 条，实际执行 ${executed.length} 条`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (executed[index] !== expected[index]) {
      throw new Error(
        `执行迁移顺序与待执行清单不一致：第 ${index + 1} 条实际 ${executed[index]}，预期 ${expected[index]}`,
      );
    }
  }
  return executed;
}

/**
 * 顺序执行收尾任务并收集错误，避免清理失败覆盖原始主因。
 */
export async function collectCleanupErrors(
  tasks: ReadonlyArray<MigrationRunCleanupTask>,
): Promise<ReadonlyArray<string>> {
  const errors: string[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '未知错误';
      errors.push(`${task.name} 失败: ${message}`);
    }
  }
  return errors;
}

/**
 * 将收尾错误附加到主因上；无主因时以收尾错误作为失败，绝不假成功。
 */
export function attachCleanupErrors(
  mainError: unknown,
  cleanupErrors: ReadonlyArray<string>,
): unknown {
  if (mainError !== null && mainError !== undefined) {
    if (cleanupErrors.length > 0 && mainError instanceof Error) {
      const withCleanup = mainError as Error & { cleanupErrors?: ReadonlyArray<string> };
      withCleanup.cleanupErrors = cleanupErrors;
    }
    return mainError;
  }
  return new MigrationCleanupError(cleanupErrors);
}

/**
 * 收尾失败错误：主因不存在时单独报错，提醒不能视为成功。
 */
export class MigrationCleanupError extends Error {
  public readonly cleanupErrors: ReadonlyArray<string>;

  constructor(cleanupErrors: ReadonlyArray<string>) {
    super(`迁移收尾失败，不能视为成功: ${cleanupErrors.join(' | ')}`);
    this.name = 'MigrationCleanupError';
    this.cleanupErrors = cleanupErrors;
  }
}

/**
 * 从错误对象读取附加的收尾错误，供 CLI 输出。
 */
export function getCleanupErrors(error: unknown): ReadonlyArray<string> {
  if (error instanceof MigrationCleanupError) {
    return error.cleanupErrors;
  }
  if (error instanceof Error) {
    const value = (error as Error & { cleanupErrors?: unknown }).cleanupErrors;
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
  }
  return [];
}

/**
 * 获取目标库连接级互斥锁；同一目标只允许一个迁移进程。
 */
async function acquireMigrationLock(
  dataSource: DataSource,
  databaseName: string,
  timeoutSeconds: number,
): Promise<{ queryRunner: QueryRunner; release: () => Promise<void> }> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  const lockName = `${MIGRATION_LOCK_PREFIX}:${databaseName}`.slice(0, 64);
  const rows: unknown = await queryRunner.query('SELECT GET_LOCK(?, ?) AS acquired', [
    lockName,
    timeoutSeconds,
  ]);
  if (!isQueryRows(rows) || rows.length === 0) {
    await queryRunner.release();
    throw new Error('无法获取迁移互斥锁：查询结果格式异常');
  }
  const acquired = Number(rows[0]['acquired'] ?? rows[0]['ACQUIRED']);
  if (acquired !== 1) {
    await queryRunner.release();
    throw new Error(
      `目标库 ${databaseName} 已有迁移进程持有互斥锁，本次拒绝并发执行（锁名 ${lockName}）`,
    );
  }

  return {
    queryRunner,
    release: async () => {
      const releaseRows: unknown = await queryRunner.query('SELECT RELEASE_LOCK(?) AS released', [
        lockName,
      ]);
      const released =
        isQueryRows(releaseRows) && releaseRows.length > 0
          ? Number(releaseRows[0]['released'] ?? releaseRows[0]['RELEASED'])
          : null;
      if (released !== 1) {
        throw new Error(`迁移互斥锁释放未确认（锁名 ${lockName}，返回值 ${String(released)}）`);
      }
    },
  };
}

/**
 * 失败后做一次只读现场诊断；诊断自身失败不影响原始主因。
 */
async function diagnoseAfterFailure(
  dataSource: DataSource,
  databaseName: string,
  logger: MigrationLogger,
  migrationsDir?: string,
): Promise<void> {
  try {
    const state = await inspectMigrationState(dataSource, databaseName, migrationsDir);
    logger.error(
      `失败后只读现场：已记录 ${state.history.length} 条，pending ${state.pending.length} 条`,
    );
    if (state.pending.length > 0) {
      logger.error(`仍待执行：${state.pending.map((entry) => entry.name).join(', ')}`);
    }
    for (const issue of state.issues) {
      logger.error(`现场诊断：${issue}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '未知错误';
    logger.error(`失败后只读诊断也失败（不影响原始主因）: ${message}`);
  }
}

/**
 * 执行正式增量迁移：仅运行 pending，失败不自动回滚/补记录/重跑。
 */
export async function runIncrementalMigration(
  options: MigrationCliOptions,
  logger: MigrationLogger,
  dependencies: MigrationRunDependencies = {
    createDataSource: createMigrationDataSource,
    lockTimeoutSeconds: 0,
  },
): Promise<MigrationRunReport> {
  if (options.command !== 'run') {
    throw new Error('runIncrementalMigration 仅接受 run 命令');
  }
  if (!options.confirmDatabase || options.confirmDatabase !== options.database) {
    throw new Error('migration:run 缺少一致的 --confirm-database 确认');
  }

  const config = loadExplicitEnvConfig(options.envFile, options.database);
  const dataSource = dependencies.createDataSource(config);
  let initialized = false;
  let lock: { release: () => Promise<void> } | null = null;
  let hasMainError = false;
  let mainError: unknown = null;
  let cleanupErrors: ReadonlyArray<string>;
  let completedReport: MigrationRunReport | null = null;
  let successHistoryCount: number | null = null;

  try {
    await dataSource.initialize();
    initialized = true;
    lock = await acquireMigrationLock(
      dataSource,
      config.database,
      dependencies.lockTimeoutSeconds ?? 0,
    );
    const target = await readAndAssertTarget(dataSource, config.database);
    logger.info(
      `目标：${target.host}:${target.port}/${target.database}（MySQL ${target.serverVersion}）`,
    );

    const state = await inspectMigrationState(
      dataSource,
      config.database,
      dependencies.migrationsDir,
    );
    for (const warning of state.warnings) {
      logger.warn(warning);
    }
    if (state.issues.length > 0) {
      throw new Error(`升级前预检失败：\n- ${state.issues.join('\n- ')}`);
    }
    logger.info(
      `历史 ${state.history.length} 条，仓库 ${state.repository.length} 条，pending ${state.pending.length} 条`,
    );
    if (state.pending.length === 0) {
      const verification = await verifyMigrationState(dataSource, config.database);
      if (verification.issues.length > 0) {
        throw new Error(`无待执行迁移，但最终校验失败：\n- ${verification.issues.join('\n- ')}`);
      }
      logger.info('待执行迁移为 0 条，结构校验通过');
      successHistoryCount = state.history.length;
      completedReport = {
        target,
        executed: [],
        pendingBefore: [],
        pendingAfter: [],
        verification,
      };
    } else {
      logger.info(`准备执行：${state.pending.map((entry) => entry.name).join(', ')}`);
      const executed = await executePendingMigrations(dataSource, state.pending);
      logger.info(`已执行 ${executed.length} 条迁移`);

      const verification = await verifyMigrationState(dataSource, config.database);
      for (const warning of verification.warnings) {
        logger.warn(warning);
      }
      if (verification.issues.length > 0) {
        throw new Error(`升级后校验失败：\n- ${verification.issues.join('\n- ')}`);
      }

      const afterState = await inspectMigrationState(
        dataSource,
        config.database,
        dependencies.migrationsDir,
      );
      if (afterState.pending.length !== 0) {
        throw new Error(
          `升级后仍存在 pending 迁移：${afterState.pending.map((entry) => entry.name).join(', ')}`,
        );
      }

      successHistoryCount = afterState.history.length;
      completedReport = {
        target,
        executed,
        pendingBefore: state.pending.map((entry) => entry.name),
        pendingAfter: [],
        verification,
      };
    }
  } catch (error: unknown) {
    hasMainError = true;
    mainError = error;
    if (initialized) {
      await diagnoseAfterFailure(dataSource, config.database, logger, dependencies.migrationsDir);
    }
  } finally {
    const activeLock = lock;
    cleanupErrors = await collectCleanupErrors([
      ...(activeLock
        ? [{ name: '释放迁移互斥锁', run: async (): Promise<void> => activeLock.release() }]
        : []),
      ...(initialized
        ? [
            {
              name: '关闭数据库连接',
              run: async (): Promise<void> => {
                await dataSource.destroy();
              },
            },
          ]
        : []),
    ]);
    for (const cleanupError of cleanupErrors) {
      logger.error(cleanupError);
    }
  }

  if (hasMainError) {
    throw attachCleanupErrors(mainError, cleanupErrors);
  }
  if (cleanupErrors.length > 0) {
    throw new MigrationCleanupError(cleanupErrors);
  }
  if (completedReport === null) {
    throw new Error('迁移执行未产生结果且未记录主因');
  }
  if (successHistoryCount === null) {
    throw new Error('迁移执行结果缺少历史记录数，无法确认升级完成');
  }
  logger.info(
    `升级完成：历史 ${successHistoryCount} 条，业务表 ${completedReport.verification.businessTableCount} 张，再次执行 0 条`,
  );
  return completedReport;
}

/**
 * 只读命令的连接生命周期管理：无论查询是否失败，都保留原始主因并暴露收尾错误。
 */
async function withReadOnlyDataSource<T>(
  config: MigrationDbConfig,
  dependencies: MigrationRunDependencies,
  action: (dataSource: DataSource) => Promise<T>,
): Promise<T> {
  const dataSource = dependencies.createDataSource(config);
  let hasMainError = false;
  let mainError: unknown = null;
  let cleanupErrors: ReadonlyArray<string>;
  let completedResult: { value: T } | null = null;
  try {
    await dataSource.initialize();
    completedResult = { value: await action(dataSource) };
  } catch (error: unknown) {
    hasMainError = true;
    mainError = error;
  } finally {
    cleanupErrors = await collectCleanupErrors(
      dataSource.isInitialized
        ? [
            {
              name: '关闭数据库连接',
              run: async (): Promise<void> => {
                await dataSource.destroy();
              },
            },
          ]
        : [],
    );
  }

  if (hasMainError) {
    throw attachCleanupErrors(mainError, cleanupErrors);
  }
  if (cleanupErrors.length > 0) {
    throw new MigrationCleanupError(cleanupErrors);
  }
  if (completedResult === null) {
    throw new Error('只读命令未产生结果且未记录主因');
  }
  return completedResult.value;
}

/**
 * 只读状态查询：不创建 migrations 表、不运行迁移。
 */
export async function runStatusCommand(
  options: MigrationCliOptions,
  logger: MigrationLogger,
  dependencies: MigrationRunDependencies = { createDataSource: createMigrationDataSource },
): Promise<MigrationState> {
  const config = loadExplicitEnvConfig(options.envFile, options.database);
  return withReadOnlyDataSource(config, dependencies, async (dataSource) => {
    const state = await inspectMigrationState(dataSource, config.database);
    logger.info(
      `目标：${state.target.host}:${state.target.port}/${state.target.database}（MySQL ${state.target.serverVersion}）`,
    );
    logger.info(
      `migrations 表：${state.migrationsTableExists ? '存在' : '缺失'}；历史 ${state.history.length} 条；仓库 ${state.repository.length} 条；pending ${state.pending.length} 条`,
    );
    if (state.pending.length > 0) {
      logger.info(`待执行：${state.pending.map((entry) => entry.name).join(', ')}`);
    }
    for (const warning of state.warnings) {
      logger.warn(warning);
    }
    for (const issue of state.issues) {
      logger.error(`预检问题：${issue}`);
    }
    return state;
  });
}

/**
 * 只读最终校验：结构、历史、回填数据与 pending 全部检查。
 */
export async function runVerifyCommand(
  options: MigrationCliOptions,
  logger: MigrationLogger,
  dependencies: MigrationRunDependencies = { createDataSource: createMigrationDataSource },
): Promise<VerificationReport> {
  const config = loadExplicitEnvConfig(options.envFile, options.database);
  return withReadOnlyDataSource(config, dependencies, async (dataSource) => {
    const report = await verifyMigrationState(dataSource, config.database);
    logger.info(
      `目标：${report.target.host}:${report.target.port}/${report.target.database}（MySQL ${report.target.serverVersion}）`,
    );
    logger.info(
      `业务表 ${report.businessTableCount} 张；历史校验与数据回填校验${report.issues.length === 0 ? '通过' : '失败'}`,
    );
    for (const warning of report.warnings) {
      logger.warn(warning);
    }
    for (const issue of report.issues) {
      logger.error(`校验问题：${issue}`);
    }
    return report;
  });
}

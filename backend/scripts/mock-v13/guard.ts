// scripts/mock-v13/guard.ts

/**
 * V13 Mock 数据入口的写入守卫。
 *
 * 本模块只做“是否允许连接与写入”的判定，不读取默认环境文件、不执行 SQL 写入。
 * 设计要点：
 * - 配置必须由 `--env-file` 显式给出，禁止回退 `env/.env.development` 等默认环境；
 * - 库名、确认串、预期实例 UUID、白名单四项必须同时匹配；
 * - `--write` 还要求环境文件内显式写入确认短语，避免复制命令即误写；
 * - 生产环境、非开发命名、非白名单库一律在建立连接前拒绝。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as dotenv from 'dotenv';

import { GuardViolationError } from './errors';

/** 允许写入的确认短语；必须与环境文件中的 `MOCK_V13_WRITE_ACK` 完全一致。 */
export const WRITE_ACK_PHRASE = 'I_UNDERSTAND_MOCK_V13_WRITES_DEV_DB';

/** 开发库命名约束：库名必须命中其一，且仍要出现在显式白名单里。 */
const SAFE_DATABASE_KEYWORDS = ['dev', 'test', 'drill', 'local', 'mock'] as const;

/** 预留：V13 Mock 会触碰的表，缺一即认为目标库尚未完成正式 V13 结构部署。 */
export const REQUIRED_TABLES = [
  'base_user_account',
  'base_user_info',
  'organization',
  'organization_membership',
  'equipment_model',
  'engineer_registration_application',
  'repair_request',
  'repair_request_intake',
  'engineer_response',
  'repair_process_entry',
  'maintenance_report',
  'maintenance_report_version',
  'maintenance_report_review',
  'maintenance_report_attachment',
  'maintenance_report_fault',
  'maintenance_report_step',
  'maintenance_report_alarm',
  'reference_document',
  'reference_document_revision',
  'stored_file',
  'management_audit_event',
  'ai_conversation',
  'ai_message',
  'ai_message_analysis',
  'ai_report',
  'local_installation',
  'local_company_setting',
  'local_account_authorization',
  'local_upload_task',
  'local_backup_run',
  'sync_receipt',
  'sync_conflict',
  'record_package_import',
  'record_package_item',
  'backup_asset',
  'backup_restore_run',
] as const;

/**
 * 关键列的抽查清单：只查表名无法区分“建过表”和“结构已补齐”，
 * 缺列会让写入在事务内才以 ER_BAD_FIELD_ERROR 失败（退出码 4），
 * 这里在写入前就按守卫拒绝（退出码 2）。只收录已由正式迁移确定的列。
 */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  base_user_account: ['identity_hint', 'admin_level', 'status', 'login_password'],
  base_user_info: ['access_group', 'meta_digest', 'user_state'],
  organization: ['organization_code', 'is_managed_company'],
  stored_file: ['binding_status', 'business_id', 'storage_reference', 'checksum_sha256'],
  maintenance_report_fault: ['lifecycle_status', 'lifecycle_source'],
  local_company_setting: [
    'setting_source',
    'is_current',
    'backup_enabled',
    'next_backup_at',
    'auto_upload_enabled',
  ],
  local_account_authorization: ['signed_claims', 'permission_version', 'last_verified_at'],
  local_backup_run: ['status', 'finished_at', 'error_code'],
  backup_asset: ['cloud_status', 'local_status', 'local_reference', 'deleted_at'],
  sync_receipt: ['source_installation_id', 'received_at', 'receipt_status'],
};

export interface MockV13CliOptions {
  readonly help: boolean;
  readonly envFile: string | null;
  readonly database: string | null;
  readonly confirmDatabase: string | null;
  readonly expectedInstanceUuid: string | null;
  readonly allowedDatabases: readonly string[];
  readonly write: boolean;
  readonly packs: readonly string[];
  readonly credentialsOut: string | null;
  readonly jsonOut: string | null;
  readonly mockFileDir: string;
  readonly referenceStorageDir: string;
  readonly failAfterPack: string | null;
}

export interface MockV13Env {
  readonly nodeEnv: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbUser: string;
  readonly dbPassword: string;
  readonly dbName: string;
  readonly dbTimezone: string | null;
  readonly dbCharset: string | null;
  readonly fieldEncryptionKey: string;
  readonly fieldEncryptionIv: string;
  readonly mockPassword: string;
  readonly writeAck: string;
}

export interface TargetFacts {
  readonly database: string;
  readonly instanceUuid: string;
  readonly readOnly: number;
}

export interface NormalizedGuard {
  readonly envFile: string;
  readonly database: string;
  readonly expectedInstanceUuid: string;
  readonly allowedDatabases: readonly string[];
  readonly env: MockV13Env;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DB_NAME_PATTERN = /^[A-Za-z0-9_]+$/u;

function requireValue(raw: Record<string, string>, key: string, context: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GuardViolationError(`${context} 缺少必填项 ${key}`);
  }
  return value.trim();
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new GuardViolationError(`环境文件 DB_PORT 非法: ${value}`);
  }
  return port;
}

/**
 * 解析环境文件内容。这里刻意不使用 `process.env`，也不调用 dotenv 的全局 config，
 * 避免把开发库配置隐式泄漏到当前进程或触发“默认环境回退”。
 */
export function parseMockEnv(envFile: string): MockV13Env {
  const absolute = path.resolve(envFile);
  if (!fs.existsSync(absolute)) {
    throw new GuardViolationError(`环境文件不存在: ${absolute}（必须显式提供，不提供默认回退）`);
  }
  const raw = dotenv.parse(fs.readFileSync(absolute, 'utf8'));
  const nodeEnv = requireValue(raw, 'NODE_ENV', 'Mock V13 环境文件');
  const database = requireValue(raw, 'DB_NAME', 'Mock V13 环境文件');
  const password =
    typeof raw.MOCK_V13_PASSWORD === 'string' && raw.MOCK_V13_PASSWORD.length > 0
      ? raw.MOCK_V13_PASSWORD
      : readPasswordFile(raw.MOCK_V13_PASSWORD_FILE);

  return {
    nodeEnv,
    dbHost: requireValue(raw, 'DB_HOST', 'Mock V13 环境文件'),
    dbPort: parsePort(requireValue(raw, 'DB_PORT', 'Mock V13 环境文件')),
    dbUser: requireValue(raw, 'DB_USER', 'Mock V13 环境文件'),
    dbPassword: raw.DB_PASS ?? '',
    dbName: database,
    dbTimezone: raw.DB_TIMEZONE ?? null,
    dbCharset: raw.DB_CHARSET ?? null,
    fieldEncryptionKey: requireValue(raw, 'FIELD_ENCRYPTION_KEY', 'Mock V13 环境文件'),
    fieldEncryptionIv: requireValue(raw, 'FIELD_ENCRYPTION_IV', 'Mock V13 环境文件'),
    mockPassword: password,
    writeAck: raw.MOCK_V13_WRITE_ACK ?? '',
  };
}

function readPasswordFile(passwordFile: string | undefined): string {
  if (typeof passwordFile !== 'string' || passwordFile.trim().length === 0) {
    throw new GuardViolationError(
      '环境文件缺少 MOCK_V13_PASSWORD 或 MOCK_V13_PASSWORD_FILE（测试密码不得硬编码或打印）',
    );
  }
  const absolute = path.resolve(passwordFile.trim());
  if (!fs.existsSync(absolute)) {
    throw new GuardViolationError(`MOCK_V13_PASSWORD_FILE 指向的文件不存在: ${absolute}`);
  }
  return fs.readFileSync(absolute, 'utf8').replace(/\r?\n$/u, '');
}

/**
 * 纯配置守卫：不连接数据库。任何不满足项都抛 `GuardViolationError`（退出码 2）。
 */
export function assertGuardConfig(options: MockV13CliOptions, env: MockV13Env): NormalizedGuard {
  if (!options.envFile) {
    throw new GuardViolationError('必须显式提供 --env-file，禁止回退默认开发环境');
  }
  if (!options.database) {
    throw new GuardViolationError('必须提供 --database');
  }
  const database = options.database;
  if (options.confirmDatabase !== database) {
    throw new GuardViolationError('--confirm-database 必须与 --database 完全一致');
  }
  if (env.dbName !== database) {
    throw new GuardViolationError(
      `环境文件 DB_NAME=${env.dbName} 与 --database=${database} 不一致`,
    );
  }
  if (!DB_NAME_PATTERN.test(database)) {
    throw new GuardViolationError(`库名 ${database} 含非法字符，拒绝执行`);
  }
  if (env.nodeEnv === 'production') {
    throw new GuardViolationError('NODE_ENV=production，Mock 数据禁止执行');
  }
  if (!SAFE_DATABASE_KEYWORDS.some((keyword) => database.toLowerCase().includes(keyword))) {
    throw new GuardViolationError(
      `库名 ${database} 未包含 ${SAFE_DATABASE_KEYWORDS.join('/')}，拒绝执行`,
    );
  }
  if (options.allowedDatabases.length === 0) {
    throw new GuardViolationError('必须提供至少一个 --allow-database 白名单库名');
  }
  if (!options.allowedDatabases.includes(database)) {
    throw new GuardViolationError(
      `库名 ${database} 不在白名单 [${options.allowedDatabases.join(', ')}] 内`,
    );
  }
  if (!options.expectedInstanceUuid || !UUID_PATTERN.test(options.expectedInstanceUuid)) {
    throw new GuardViolationError('必须提供 36 位小写 UUID 的 --expected-instance-uuid');
  }
  if (env.fieldEncryptionKey.length < 16 || env.fieldEncryptionIv.length < 16) {
    throw new GuardViolationError(
      'FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_IV 均需至少 16 个字符，且必须与开发应用同源',
    );
  }
  if (env.mockPassword.length === 0) {
    throw new GuardViolationError('测试密码为空，拒绝执行');
  }
  if (options.write && env.writeAck !== WRITE_ACK_PHRASE) {
    throw new GuardViolationError(`--write 要求环境文件中 MOCK_V13_WRITE_ACK=${WRITE_ACK_PHRASE}`);
  }
  if (options.packs.length === 0) {
    throw new GuardViolationError('未选择任何数据包（--pack ...）；使用 --pack all 执行默认顺序');
  }

  return {
    envFile: path.resolve(options.envFile),
    database,
    expectedInstanceUuid: options.expectedInstanceUuid,
    allowedDatabases: options.allowedDatabases,
    env,
  };
}

/**
 * 连接后的事实核对（纯函数，便于离线测试）：
 * 实际库名、实例 UUID、只读状态必须全部与显式期望一致。
 */
export function assertTargetFacts(guard: NormalizedGuard, facts: TargetFacts): void {
  if (facts.database !== guard.database) {
    throw new GuardViolationError(
      `实际连接库 ${facts.database} 与目标库 ${guard.database} 不一致，拒绝写入`,
    );
  }
  if (facts.instanceUuid.toLowerCase() !== guard.expectedInstanceUuid.toLowerCase()) {
    throw new GuardViolationError(
      `实例 UUID 不匹配：实际 ${facts.instanceUuid}，期望 ${guard.expectedInstanceUuid}`,
    );
  }
  if (Number(facts.readOnly) !== 0) {
    throw new GuardViolationError('目标实例处于只读模式，拒绝写入');
  }
}

/** 校验目标库是否已完成 V13 正式结构部署。缺表时在写入前终止。 */
export function assertSchemaTables(existing: readonly string[]): void {
  const present = new Set(existing);
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new GuardViolationError(
      `目标库缺少 V13 表: ${missing.join(', ')}；请先在该专用开发库执行正式结构部署，Mock 不会建表或改迁移`,
    );
  }
}

/** 校验关键列是否齐全；缺列同样在写入前以退出码 2 终止。 */
export function assertSchemaColumns(
  columnsByTable: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const problems = Object.entries(REQUIRED_COLUMNS).flatMap(([table, expected]) => {
    const actual = columnsByTable.get(table);
    if (!actual) return [];
    const missing = expected.filter((column) => !actual.has(column));
    return missing.length > 0 ? [`${table}(${missing.join(', ')})`] : [];
  });
  if (problems.length > 0) {
    throw new GuardViolationError(
      `目标库 V13 结构不完整，缺少列: ${problems.join('; ')}；请先补齐正式迁移，Mock 不会改结构`,
    );
  }
}

/**
 * Mock 文件目录的守卫：目录必须可明确归属，且不得写入后端源码、依赖、构建产物或版本库目录，
 * 避免回滚回收时误删工程文件。默认目录（`<cwd>/var/...`）不受影响。
 *
 * 受保护目录从实际仓库根定位到 `backend/src`、`backend/node_modules`、`backend/dist`，
 * 原件目录与参考资料目录都按路径组件判断是否落在其中（含目录自身及其任意子目录）。
 * 除字符串前缀外，还逐级检查已存在的路径组件：任何符号链接都拒绝，避免通过链接
 * 逃逸到受控目录之外。原件根下实际会写入的子目录也一并检查。
 */
export function assertMockDirectories(mockFileDir: string, referenceStorageDir: string): void {
  const targets = [
    { flag: '--mock-file-dir', dir: path.resolve(mockFileDir) },
    { flag: '--reference-storage-dir', dir: path.resolve(referenceStorageDir) },
  ];
  if (targets[0].dir === targets[1].dir) {
    throw new GuardViolationError('--mock-file-dir 与 --reference-storage-dir 必须指向不同目录');
  }
  const repositoryRoot = resolveRepositoryRoot();
  const forbiddenRoots = [
    path.join(repositoryRoot, 'backend', 'src'),
    path.join(repositoryRoot, 'backend', 'node_modules'),
    path.join(repositoryRoot, 'backend', 'dist'),
    path.join(repositoryRoot, '.git'),
  ];
  for (const target of targets) {
    if (path.parse(target.dir).root === target.dir) {
      throw new GuardViolationError(`${target.flag} 不能是文件系统根目录: ${target.dir}`);
    }
    for (const forbidden of forbiddenRoots) {
      const relative = path.relative(forbidden, target.dir);
      const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      if (inside) {
        throw new GuardViolationError(
          `${target.flag} 位于受保护目录内: ${forbidden}，拒绝写入 Mock 文件`,
        );
      }
    }
    assertNoSymlinkComponents(target.dir, target.flag);
    if (fs.existsSync(target.dir) && !fs.statSync(target.dir).isDirectory()) {
      throw new GuardViolationError(`${target.flag} 已存在但不是目录: ${target.dir}`);
    }
  }
  const mockSubdirectories = ['files', 'report-attachments', 'packages', 'backups'] as const;
  for (const name of mockSubdirectories) {
    const subdirectory = path.join(targets[0].dir, name);
    assertNoSymlinkComponents(subdirectory, `--mock-file-dir 子目录 ${name}`);
    if (fs.existsSync(subdirectory) && !fs.statSync(subdirectory).isDirectory()) {
      throw new GuardViolationError(`--mock-file-dir 子目录已存在但不是目录: ${subdirectory}`);
    }
  }
}

/**
 * 逐级检查目标路径已存在的组件；遇到符号链接立即拒绝。
 *
 * 该检查不跟随链接，也不依赖字符串前缀，因此可以识别“父目录是链接”的逃逸。
 * 目标自身不存在时，只检查其已存在的父级组件。
 */
export function assertNoSymlinkComponents(targetPath: string, label: string): void {
  const absolute = path.resolve(targetPath);
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw new GuardViolationError(
        `${label} 路径无法检查: ${current}（${(error as Error).message}）`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new GuardViolationError(`${label} 路径组件为符号链接，拒绝写入: ${current}`);
    }
  }
}

/** 统计/JSON 输出路径：目标自身不得是链接，父目录必须已存在且无符号链接组件。 */
export function assertOutputParentDirectory(outputPath: string, label: string): string {
  const absolute = path.resolve(outputPath);
  assertNoSymlinkComponents(absolute, label);
  const parent = path.dirname(absolute);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new GuardViolationError(`${label} 父目录不存在或不是目录: ${parent}`);
  }
  return absolute;
}

/**
 * 统计输出必须是一次运行专属的新文件：目标已存在时在连接/写入前拒绝。
 *
 * 仅做预检，真正的落盘仍由排他创建（`wx`）兜底，防止预检与写入之间出现的文件被覆盖。
 */
export function assertOutputPathVacant(outputPath: string, label: string): string {
  const absolute = assertOutputParentDirectory(outputPath, label);
  if (fs.existsSync(absolute)) {
    throw new GuardViolationError(
      `${label} 目标已存在: ${absolute}；每次运行必须使用新的统计文件名，或省略 ${label} 以不写统计`,
    );
  }
  return absolute;
}

/** 仓库根目录（用于阻止把凭据写到 Git 工作区）。 */
export function resolveRepositoryRoot(): string {
  return path.resolve(__dirname, '../../..');
}

/**
 * 凭据输出路径必须位于仓库之外，且父目录存在。
 *
 * 判定基于真实路径：父目录若是指向仓库的符号链接，会被识别并拒绝；
 * 目标文件若已存在且自身是符号链接，同样拒绝，避免实际落点逃逸。
 */
export function assertCredentialsPathOutsideRepository(credentialsPath: string): string {
  const absolute = path.resolve(credentialsPath);
  assertNoSymlinkComponents(absolute, '凭据文件');
  if (fs.existsSync(absolute)) {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      throw new GuardViolationError(`凭据文件本身是符号链接，拒绝写入: ${absolute}`);
    }
    if (!fs.statSync(absolute).isFile()) {
      throw new GuardViolationError(`凭据文件已存在但不是普通文件: ${absolute}`);
    }
  }
  const parent = path.dirname(absolute);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new GuardViolationError(`凭据文件父目录不存在: ${parent}`);
  }
  const repositoryRealRoot = fs.realpathSync(resolveRepositoryRoot());
  const parentRealPath = fs.realpathSync(parent);
  const targetRealPath = path.join(parentRealPath, path.basename(absolute));
  const relative = path.relative(repositoryRealRoot, targetRealPath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new GuardViolationError(
      `凭据文件实际目标 ${targetRealPath} 位于仓库内，拒绝写入；请使用仓库外的受控目录`,
    );
  }
  return absolute;
}

export function parseCliArgs(argv: readonly string[]): MockV13CliOptions {
  const packs: string[] = [];
  const allowedDatabases: string[] = [];
  let help = false;
  let envFile: string | null = null;
  let database: string | null = null;
  let confirmDatabase: string | null = null;
  let expectedInstanceUuid: string | null = null;
  let write = false;
  let credentialsOut: string | null = null;
  let jsonOut: string | null = null;
  let mockFileDir: string = path.resolve(process.cwd(), 'var/mock-v13');
  let referenceStorageDir: string = path.resolve(process.cwd(), 'var/reference-documents');
  let failAfterPack: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const readNext = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new GuardViolationError(`参数 ${argument} 缺少取值`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--env-file':
        envFile = readNext();
        break;
      case '--database':
        database = readNext();
        break;
      case '--confirm-database':
        confirmDatabase = readNext();
        break;
      case '--expected-instance-uuid':
        expectedInstanceUuid = readNext();
        break;
      case '--allow-database':
        allowedDatabases.push(readNext());
        break;
      case '--pack':
        packs.push(readNext());
        break;
      case '--write':
        write = true;
        break;
      case '--credentials-out':
        credentialsOut = readNext();
        break;
      case '--json-out':
        jsonOut = readNext();
        break;
      case '--mock-file-dir':
        mockFileDir = path.resolve(readNext());
        break;
      case '--reference-storage-dir':
        referenceStorageDir = path.resolve(readNext());
        break;
      case '--fail-after-pack':
        failAfterPack = readNext();
        break;
      default:
        throw new GuardViolationError(`未知参数: ${argument}`);
    }
  }

  return {
    help,
    envFile,
    database,
    confirmDatabase,
    expectedInstanceUuid,
    allowedDatabases,
    write,
    packs,
    credentialsOut,
    jsonOut,
    mockFileDir,
    referenceStorageDir,
    failAfterPack,
  };
}

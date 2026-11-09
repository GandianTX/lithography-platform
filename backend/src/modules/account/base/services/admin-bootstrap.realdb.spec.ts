// src/modules/account/base/services/admin-bootstrap.realdb.spec.ts
//
// S4 合成管理员初始化专项（受控实库验收规格）。
//
// 本文件默认不启用、不连接、不写库；全部 describe 为 skip。
// 只有同时满足以下条件才会执行：
//   E2E_ADMIN_BOOTSTRAP_SPECS=1        显式要求执行本专项
//   E2E_ALLOW_ADMIN_BOOTSTRAP=1        显式授权应用合成管理员映射
//   E2E_ALLOW_PHYSICAL_CLEANUP=1       显式授权回收本轮合成夹具
//   E2E_REAL_DB_NAME=<目标库>          本轮授权的独立空库
//   E2E_ALLOWED_DB_NAMES=<同一个库>    白名单必须且只能包含该库
//   E2E_REAL_DB_CONFIG_FILE=<绝对路径> 显式 env 文件，DB_NAME 必须与目标一致
//   E2E_EXPECTED_SERVER_UUID=<uuid>    实例 server_uuid 必须一致
//   E2E_ADMIN_BOOTSTRAP_DIR=<绝对路径> 库外 0700 目录，用于写 0600 映射文件
//   环境文件还必须提供 FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_IV，
//   否则管理员初始化拒绝写入或校验 API 无法解密的 meta_digest
//
// 显式设置 E2E_ADMIN_BOOTSTRAP_SPECS=1 但许可不全时，模块加载即抛错拒绝，不静默跳过。
//
// 覆盖（依据 S1 §5 管理员等级契约）：
//   0. 普通 init 未显式启用管理员初始化时不自动创建管理员；
//   1. 合法首次初始化：3 个 1 级（甲方公司）+ 3 个 2 级（各受管公司），密码可验、必须改密；
//   2. 同一映射重复执行：全部 UNCHANGED，不重置密码、不改等级/归属、逐字段无漂移；
//   3. 冲突与失败关闭：等级冲突、归属冲突、缺资料、缺公司、邮箱碰撞、注入故障均拒绝且无部分新增；
//   4. 输入与配置：非法等级、重复账号、缺密码、缺公司、缺少确认口令、模式越界、目标不一致；
//   5. 事务边界：映射在单事务内执行，任一失败整体回滚；
//   6. 初始化后真实可用回归骨架：登录事实、首次改密、受保护 Query、管理操作、越权拒绝；
//   7. 受保护收尾：只按本轮登记姓名/ID 回收，保留迁移种子，结构与非目标数据不变。
//
// 本规格不建库、不 DROP、不清表、不 down 迁移、不回退 DDL；不启动完整 Nest 服务；
// 不打印密码、密码哈希或连接串。

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DataSource, EntityManager, type DataSourceOptions, type QueryRunner } from 'typeorm';

import {
  assertAllowedE2eDatabase,
  assertManagerOnExpectedE2eDatabase,
} from '../../../../../test/utils/e2e-db-guard';
import { runGuardedScopedCleanup } from '../../../../../test/utils/e2e-scoped-cleanup';
import { normalizeBigIntId } from '../../../../../test/utils/lossless-bigint-id';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import {
  applyAdminBootstrap,
  parseAdminBootstrapConfig,
  type AdminBootstrapConfig,
  type AdminBootstrapEncryption,
  type AdminBootstrapEntry,
} from '@src/infrastructure/database/admin-bootstrap';
import { createFieldCipher } from '@src/infrastructure/field-encryption/field-encryption.cipher';
import {
  parseDeployCliArgs,
  runDatabaseDeploy,
  type DeployReport,
} from '@src/infrastructure/database/database-deploy';
import {
  createMigrationDataSource,
  loadExplicitEnvConfig,
  readBaseTableNames,
  readMigrationHistory,
  type MigrationDbConfig,
  type MigrationLogger,
} from '@src/infrastructure/database/incremental-migration';
import { AccountService } from './account.service';

const REQUESTED = process.env.E2E_ADMIN_BOOTSTRAP_SPECS === '1';
const ADMIN_ALLOWED = process.env.E2E_ALLOW_ADMIN_BOOTSTRAP === '1';
const CLEANUP_ALLOWED = process.env.E2E_ALLOW_PHYSICAL_CLEANUP === '1';
const EXPECTED_DB = (process.env.E2E_REAL_DB_NAME ?? '').trim().toLowerCase();
const EXPECTED_SERVER_UUID = (process.env.E2E_EXPECTED_SERVER_UUID ?? '').trim();
const CONFIG_FILE = (process.env.E2E_REAL_DB_CONFIG_FILE ?? '').trim();
const BOOTSTRAP_DIR = (process.env.E2E_ADMIN_BOOTSTRAP_DIR ?? '').trim();

const ADMIN_BOOTSTRAP_CONFIRM_VALUE = 'APPLY-ADMIN-BOOTSTRAP';
const MIGRATION_COUNT = 43;
const BUSINESS_TABLE_COUNT = 52;
const MIGRATION_LOCK_PREFIX = 'lithography:migration';
const BASELINE_ORGANIZATION_CODE = 'CLIENT_DEFAULT';
const LEVEL_ONE_ACCOUNTS = 3;
const LEVEL_TWO_ACCOUNTS = 3;
const INJECTED_FAILURE = 'INJECTED_ADMIN_BOOTSTRAP_FAILURE';

const DB_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const ENABLED =
  REQUESTED &&
  ADMIN_ALLOWED &&
  CLEANUP_ALLOWED &&
  EXPECTED_DB.length > 0 &&
  EXPECTED_SERVER_UUID.length > 0 &&
  CONFIG_FILE.length > 0 &&
  BOOTSTRAP_DIR.length > 0;

if (REQUESTED && !ENABLED) {
  throw new Error(
    'S4 管理员初始化专项被显式要求执行（E2E_ADMIN_BOOTSTRAP_SPECS=1），但许可不全：' +
      '需要 E2E_ALLOW_ADMIN_BOOTSTRAP=1、E2E_ALLOW_PHYSICAL_CLEANUP=1、E2E_REAL_DB_NAME、' +
      'E2E_EXPECTED_SERVER_UUID、E2E_REAL_DB_CONFIG_FILE 与 E2E_ADMIN_BOOTSTRAP_DIR。' +
      '明确拒绝，不静默跳过。',
  );
}

if (ENABLED) {
  if (!DB_NAME_PATTERN.test(EXPECTED_DB)) {
    throw new Error(
      'E2E_REAL_DB_NAME 必须是合法的 MySQL 库标识符（小写字母开头，仅小写字母/数字/下划线），' +
        `实际：${JSON.stringify(EXPECTED_DB)}；拒绝执行。`,
    );
  }
  if (!path.isAbsolute(CONFIG_FILE)) {
    throw new Error(`E2E_REAL_DB_CONFIG_FILE 必须是绝对路径，实际：${CONFIG_FILE}`);
  }
  if (!path.isAbsolute(BOOTSTRAP_DIR)) {
    throw new Error(`E2E_ADMIN_BOOTSTRAP_DIR 必须是绝对路径，实际：${BOOTSTRAP_DIR}`);
  }
  const allowed = (process.env.E2E_ALLOWED_DB_NAMES ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (allowed.length !== 1 || allowed[0] !== EXPECTED_DB) {
    throw new Error(
      `E2E_ALLOWED_DB_NAMES 必须且只能包含当前目标库 ${EXPECTED_DB}，实际：[${allowed.join(', ')}]。`,
    );
  }
}

const describeRealDb = ENABLED ? describe : describe.skip;

const silentLogger: MigrationLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

const messageOf = (error: unknown): string => {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(messageOf).join(' | ')}`;
  }
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause === undefined ? error.message : `${error.message} <- ${messageOf(cause)}`;
  }
  return String(error);
};

const placeholdersOf = (values: readonly unknown[]): string => values.map(() => '?').join(', ');

const insertIdOf = (result: unknown, field: string): string => {
  const raw = (result as { insertId?: unknown }).insertId;
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') {
    throw new Error(`INSERT 未返回有效 insertId（${field}）：${String(raw)}`);
  }
  const insertId = normalizeBigIntId(raw, `${field}.insertId`);
  if (!/^[1-9]\d*$/.test(insertId)) {
    throw new Error(`${field} 的 insertId 不是正整数：${insertId}`);
  }
  return insertId;
};

const plainRows = <T>(rows: readonly T[]): T[] => JSON.parse(JSON.stringify(rows)) as T[];

/**
 * 夹具生成器（不连接数据库，可在普通单测环境直接回归）。
 *
 * 字段上限来源（已核对迁移 1773924900000 / 1773925000000 / 1775301000000 / 1775501000000）：
 *   base_user_account.login_name    varchar(30)  UNIQUE uk_login_name
 *   base_user_account.login_email   varchar(100) UNIQUE uk_login_email
 *   base_user_info.nickname         varchar(50)  NOT NULL
 *   base_user_info.real_name        varchar(200) NULL
 *   organization.organization_code  varchar(64)  UNIQUE uk_organization_code
 *   organization.name               varchar(200) NOT NULL
 *
 * 命名结构 = 固定短前缀 + 固定场景代号 + 运行唯一标识（8 位）。
 * 最长场景代号 12 位时 login_name 为 3+1+12+1+8 = 25，低于上限 30；
 * 任何字段超长都直接抛错，绝不截断，避免不同场景被截断成同一字符串。
 */
const RUN_TAG_LENGTH = 8;
const RUN_TAG = `${Date.now().toString(36).slice(-3)}${randomBytes(3)
  .toString('hex')
  .slice(0, RUN_TAG_LENGTH - 3)}`;

const ACCOUNT_SCENARIOS = [
  'l1a',
  'l1b',
  'l1c',
  'l2a',
  'l2b',
  'l2c',
  'cflevel',
  'cforg',
  'mapexist',
  'missorg',
  'missinfo',
  'emailown',
  'colfirst',
  'colsecond',
  'rba',
  'rbb',
  'rbc',
  'invalidlevel',
  'duplicate',
  'misspassword',
  'missorgcode',
] as const;

const ORGANIZATION_SCENARIOS = ['c1', 'c2', 'c3'] as const;

const LEVEL_ONE_SCENARIOS = ['l1a', 'l1b', 'l1c'] as const;
const LEVEL_TWO_SCENARIOS = ['l2a', 'l2b', 'l2c'] as const;
const ROLLBACK_SCENARIOS = ['rba', 'rbb', 'rbc'] as const;

type AccountScenario = (typeof ACCOUNT_SCENARIOS)[number];
type OrganizationScenario = (typeof ORGANIZATION_SCENARIOS)[number];

const LOGIN_NAME_MAX = 30;
const LOGIN_EMAIL_MAX = 100;
const NICKNAME_MAX = 50;
const REAL_NAME_MAX = 200;
const ORGANIZATION_CODE_MAX = 64;
const ORGANIZATION_NAME_MAX = 200;

const ensureLength = (value: string, max: number, field: string): string => {
  if (value.length > max) {
    throw new Error(
      `夹具字段 ${field} 实际长度 ${String(value.length)} 超过上限 ${String(max)}：` +
        `${value}；拒绝截断，请缩短场景代号或运行标识。`,
    );
  }
  return value;
};

const fixtureLoginName = (scenario: AccountScenario): string =>
  ensureLength(`adm_${scenario}_${RUN_TAG}`, LOGIN_NAME_MAX, 'base_user_account.login_name');

const fixtureEmail = (scenario: AccountScenario): string =>
  ensureLength(
    `adm+${scenario}-${RUN_TAG}@example.invalid`,
    LOGIN_EMAIL_MAX,
    'base_user_account.login_email',
  );

const fixtureNickname = (scenario: AccountScenario): string =>
  ensureLength(`合成管理员 ${scenario}-${RUN_TAG}`, NICKNAME_MAX, 'base_user_info.nickname');

const fixtureRealName = (scenario: AccountScenario): string =>
  ensureLength(`合成管理员 ${scenario}-${RUN_TAG}`, REAL_NAME_MAX, 'base_user_info.real_name');

const fixtureInfoNickname = (loginName: string): string =>
  ensureLength(`合成账号 ${loginName}`, NICKNAME_MAX, 'base_user_info.nickname');

const fixtureOrganizationCode = (scenario: OrganizationScenario): string =>
  ensureLength(
    `ADM_${scenario.toUpperCase()}_${RUN_TAG.toUpperCase()}`,
    ORGANIZATION_CODE_MAX,
    'organization.organization_code',
  );

const fixtureOrganizationName = (scenario: OrganizationScenario): string =>
  ensureLength(`合成受管公司 ${scenario} ${RUN_TAG}`, ORGANIZATION_NAME_MAX, 'organization.name');

const fixtureMissingOrganizationCode = (): string =>
  ensureLength(
    `ADM_NO_SUCH_${RUN_TAG.toUpperCase()}`,
    ORGANIZATION_CODE_MAX,
    'organization.organization_code',
  );

const randomPassword = (): string => {
  // 初始化工具与登录/注册共用 PasswordPolicyService；夹具密码也必须通过同一策略。
  const policy = new PasswordPolicyService();
  for (;;) {
    const candidate = `Aa1!${randomBytes(18).toString('base64url')}`;
    if (policy.validatePassword(candidate).isValid) {
      return candidate;
    }
  }
};

/** 映射文件的密码只存在于进程内存与 0600 文件中，不进入日志或报告。 */
interface MappingEntryInput {
  readonly loginName: string;
  readonly loginEmail: string | null;
  readonly password: string;
  readonly adminLevel: 1 | 2;
  readonly organizationCode: string;
  readonly nickname: string;
  readonly realName: string | null;
}

interface AccountRow {
  readonly id: number | string;
  readonly login_name: string;
  readonly login_email: string | null;
  readonly login_password: string;
  readonly status: string;
  readonly identity_hint: string | null;
  readonly admin_level: number | null;
  readonly must_change_password: number | string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface InfoRow {
  readonly account_id: number | string;
  readonly nickname: string;
  readonly real_name: string | null;
  readonly customer_organization_id: number | string | null;
  readonly access_group: unknown;
  readonly meta_digest: string | null;
  readonly user_state: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SpecState {
  config: MigrationDbConfig | null;
  dataSource: DataSource | null;
  initReport: DeployReport | null;
  readonly loginNames: Set<string>;
  readonly accountIds: Set<string>;
  readonly organizationIds: Set<string>;
  readonly mappingFiles: string[];
  mainMapping: AdminBootstrapConfig | null;
  mainMappingPath: string | null;
  baselineOrgId: string;
  structureBefore: string;
  rowCountsBefore: Record<string, number>;
  historyBefore: string;
  tableCountBefore: number;
  cleaned: boolean;
  cleanupError: string | null;
}

const state: SpecState = {
  config: null,
  dataSource: null,
  initReport: null,
  loginNames: new Set<string>(),
  accountIds: new Set<string>(),
  organizationIds: new Set<string>(),
  mappingFiles: [],
  mainMapping: null,
  mainMappingPath: null,
  baselineOrgId: '',
  structureBefore: '',
  rowCountsBefore: {},
  historyBefore: '',
  tableCountBefore: 0,
  cleaned: false,
  cleanupError: null,
};

const requireConfig = (): MigrationDbConfig => {
  if (state.config === null) {
    throw new Error('目标配置尚未加载，拒绝执行。');
  }
  return state.config;
};

const requireDataSource = (): DataSource => {
  if (state.dataSource === null) {
    throw new Error('目标连接尚未建立，拒绝执行。');
  }
  return state.dataSource;
};

const requireEncryption = (): Required<AdminBootstrapEncryption> => {
  const config = requireConfig();
  if (!config.fieldEncryptionKey || !config.fieldEncryptionIv) {
    throw new Error('S4 需要环境文件同时提供 FIELD_ENCRYPTION_KEY 与 FIELD_ENCRYPTION_IV。');
  }
  return {
    fieldEncryptionKey: config.fieldEncryptionKey,
    fieldEncryptionIv: config.fieldEncryptionIv,
  };
};

const fieldCipher = (): ReturnType<typeof createFieldCipher> => {
  const encryption = requireEncryption();
  return createFieldCipher(encryption.fieldEncryptionKey, encryption.fieldEncryptionIv);
};

const applyBootstrap = (
  dataSource: DataSource,
  config: AdminBootstrapConfig,
): ReturnType<typeof applyAdminBootstrap> =>
  applyAdminBootstrap(dataSource, config, requireEncryption());

const decryptRoleDigest = (cipherText: string | null): unknown => {
  if (cipherText === null) {
    return null;
  }
  const plain = fieldCipher().decrypt(cipherText);
  try {
    return JSON.parse(plain) as unknown;
  } catch {
    return plain;
  }
};

const assertTargetIdentity = async (dataSource: DataSource): Promise<void> => {
  assertAllowedE2eDatabase(EXPECTED_DB);
  await assertManagerOnExpectedE2eDatabase(dataSource.manager, EXPECTED_DB);
  const rows = await dataSource.query<
    Array<{ current_database: string; server_uuid: string; server_version: string }>
  >(
    'SELECT DATABASE() AS current_database, @@server_uuid AS server_uuid, VERSION() AS server_version',
  );
  const row = rows[0];
  if (!row) {
    throw new Error('无法读取目标库身份（SELECT DATABASE()/@@server_uuid 返回空）。');
  }
  if (row.current_database.toLowerCase() !== EXPECTED_DB) {
    throw new Error(`实际连接库 ${row.current_database} 与预期 ${EXPECTED_DB} 不一致；拒绝执行。`);
  }
  if (row.server_uuid !== EXPECTED_SERVER_UUID) {
    throw new Error(
      `实例 server_uuid ${row.server_uuid} 与预期 ${EXPECTED_SERVER_UUID} 不一致；拒绝执行。`,
    );
  }
  const version = String(row.server_version);
  if (!/^8\.0\./.test(version)) {
    throw new Error(`本规格只支持 MySQL 8.0.x，实际 ${version}；拒绝执行。`);
  }
};

const assertEmptyTarget = async (dataSource: DataSource): Promise<void> => {
  const tables = await readBaseTableNames(dataSource, EXPECTED_DB);
  if (tables.length > 0) {
    throw new Error(
      `目标库 ${EXPECTED_DB} 已存在 ${String(tables.length)} 张表；` +
        '本规格只接受全新空库，拒绝复用、覆盖或清表。',
    );
  }
  const history = await readMigrationHistory(dataSource, EXPECTED_DB);
  if (history.migrationsTableExists || history.history.length > 0) {
    throw new Error(`目标库 ${EXPECTED_DB} 已存在迁移历史；拒绝在半迁移或已升级库上执行。`);
  }
};

const countRows = async (
  dataSource: DataSource,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<number> => {
  const rows = await dataSource.query<Array<{ total: number | string }>>(sql, [...parameters]);
  const value = rows[0]?.total;
  if (value === undefined) {
    throw new Error('计数查询未返回结果。');
  }
  return Number(value);
};

const structureDigest = async (dataSource: DataSource): Promise<string> => {
  const rows = await dataSource.query<
    Array<{
      table_name: string;
      column_name: string;
      column_type: string;
      is_nullable: string;
      column_default: string | null;
      column_key: string;
      extra: string;
    }>
  >(
    `
      SELECT table_name, column_name, column_type, is_nullable, column_default, column_key, extra
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name IN ('organization', 'base_user_account', 'base_user_info')
      ORDER BY table_name, ordinal_position
    `,
    [EXPECTED_DB],
  );
  return sha256(JSON.stringify(plainRows(rows)));
};

const tableRowCounts = async (dataSource: DataSource): Promise<Record<string, number>> => {
  const tables = await readBaseTableNames(dataSource, EXPECTED_DB);
  const counts: Record<string, number> = {};
  for (const table of [...tables].sort()) {
    if (!/^[a-z0-9_]+$/.test(table)) {
      throw new Error(`表名 ${table} 含非预期字符，拒绝拼接到计数查询。`);
    }
    counts[table] = await countRows(dataSource, `SELECT COUNT(*) AS total FROM \`${table}\``);
  }
  return counts;
};

const historyDigest = async (dataSource: DataSource): Promise<string> => {
  const rows = await dataSource.query<Array<{ id: number; timestamp: string; name: string }>>(
    'SELECT id, timestamp, name FROM `migrations` ORDER BY id',
  );
  return sha256(JSON.stringify(plainRows(rows)));
};

const assertBootstrapDir = (): void => {
  const stat = fs.statSync(BOOTSTRAP_DIR, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    throw new Error(`E2E_ADMIN_BOOTSTRAP_DIR 不存在或不是目录：${BOOTSTRAP_DIR}`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(
      `E2E_ADMIN_BOOTSTRAP_DIR 权限必须为 0700，实际 ${(stat.mode & 0o777).toString(8)}。`,
    );
  }
};

const writeMappingFile = (name: string, accounts: readonly MappingEntryInput[]): string => {
  assertBootstrapDir();
  const filePath = path.join(BOOTSTRAP_DIR, `${name}-${RUN_TAG}.json`);
  const payload = {
    schema_version: 1,
    accounts: accounts.map((entry) => ({
      login_name: entry.loginName,
      login_email: entry.loginEmail,
      password: entry.password,
      admin_level: entry.adminLevel,
      organization_code: entry.organizationCode,
      nickname: entry.nickname,
      real_name: entry.realName,
    })),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(filePath, 0o600);
  for (const entry of accounts) {
    state.loginNames.add(entry.loginName);
  }
  state.mappingFiles.push(filePath);
  return filePath;
};

const readAccounts = async (
  dataSource: DataSource,
  loginNames: readonly string[],
): Promise<AccountRow[]> => {
  if (loginNames.length === 0) {
    return [];
  }
  return dataSource.query<AccountRow[]>(
    `
      SELECT id, login_name, login_email, login_password, status, identity_hint,
             admin_level, must_change_password, created_at, updated_at
      FROM base_user_account
      WHERE login_name IN (${placeholdersOf(loginNames)})
      ORDER BY login_name
    `,
    [...loginNames],
  );
};

const readAccount = async (dataSource: DataSource, loginName: string): Promise<AccountRow> => {
  const rows = await readAccounts(dataSource, [loginName]);
  const row = rows[0];
  if (!row) {
    throw new Error(`未查询到账号 ${loginName}。`);
  }
  return row;
};

const readInfos = async (
  dataSource: DataSource,
  accountIds: readonly string[],
): Promise<InfoRow[]> => {
  if (accountIds.length === 0) {
    return [];
  }
  return dataSource.query<InfoRow[]>(
    `
      SELECT account_id, nickname, real_name, customer_organization_id,
             access_group, meta_digest, user_state, created_at, updated_at
      FROM base_user_info
      WHERE account_id IN (${placeholdersOf(accountIds)})
      ORDER BY account_id
    `,
    [...accountIds],
  );
};

interface MembershipRow {
  readonly organization_id: number | string;
  readonly account_id: number | string;
  readonly member_role: string;
  readonly status: string;
  readonly left_at: Date | null;
}

const readMemberships = async (
  dataSource: DataSource,
  accountIds: readonly string[],
): Promise<MembershipRow[]> => {
  if (accountIds.length === 0) {
    return [];
  }
  return dataSource.query<MembershipRow[]>(
    `
      SELECT organization_id, account_id, member_role, status, left_at
      FROM organization_membership
      WHERE account_id IN (${placeholdersOf(accountIds)})
      ORDER BY account_id
    `,
    [...accountIds],
  );
};

const jsonValue = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

const toDate = (value: unknown, field: string): Date => {
  if (value instanceof Date) {
    return value;
  }
  throw new Error(`${field} 不是 Date 类型，无法按登录算法验密：${String(value)}`);
};

const insertOrganization = async (
  dataSource: DataSource,
  code: string,
  name: string,
): Promise<string> => {
  const result: unknown = await dataSource.query(
    'INSERT INTO `organization` (`organization_code`, `name`, `kind`, `status`, `is_managed_company`) VALUES (?, ?, ?, ?, ?)',
    [code, name, 'PEER', 'ACTIVE', 1],
  );
  const id = insertIdOf(result, 'organization');
  state.organizationIds.add(id);
  return id;
};

interface FixtureMembership {
  readonly organizationId: string;
  readonly memberRole?: string;
}

interface FixtureAccount {
  readonly loginName: string;
  readonly loginEmail: string;
  readonly password: string;
  readonly adminLevel: 1 | 2 | null;
  readonly identityHint: string | null;
  readonly mustChangePassword: 0 | 1;
  readonly organizationId: string | null;
  readonly withInfo: boolean;
  readonly accessGroup?: readonly string[];
  readonly metaDigest?: readonly string[] | null;
  readonly membership?: FixtureMembership | null;
}

const insertFixtureMembership = async (
  dataSource: DataSource,
  accountId: string,
  membership: FixtureMembership,
): Promise<void> => {
  await dataSource.query(
    `
      INSERT INTO \`organization_membership\`
        (\`organization_id\`, \`account_id\`, \`member_role\`, \`status\`,
         \`joined_at\`, \`left_at\`, \`created_at\`, \`updated_at\`)
      VALUES (?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP(3), NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
    `,
    [membership.organizationId, accountId, membership.memberRole ?? 'SUPER_ADMIN'],
  );
};

const createFixtureAccount = async (
  dataSource: DataSource,
  fixture: FixtureAccount,
): Promise<string> => {
  state.loginNames.add(fixture.loginName);
  const createdAt = new Date();
  const passwordHash = AccountService.hashPasswordWithTimestamp(fixture.password, createdAt);
  const result: unknown = await dataSource.query(
    `
      INSERT INTO \`base_user_account\`
        (\`login_name\`, \`login_email\`, \`login_password\`, \`status\`, \`identity_hint\`,
         \`admin_level\`, \`must_change_password\`, \`created_at\`, \`updated_at\`)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
    `,
    [
      fixture.loginName,
      fixture.loginEmail,
      passwordHash,
      fixture.identityHint,
      fixture.adminLevel,
      fixture.mustChangePassword,
      createdAt,
      createdAt,
    ],
  );
  const accountId = insertIdOf(result, 'base_user_account');
  state.accountIds.add(accountId);

  if (fixture.withInfo) {
    const accessGroup = fixture.accessGroup ?? ['SUPER_ADMIN'];
    const metaDigest = fixture.metaDigest === undefined ? accessGroup : fixture.metaDigest;
    const metaDigestCipher =
      metaDigest === null ? null : fieldCipher().encrypt(JSON.stringify(metaDigest));
    await dataSource.query(
      `
        INSERT INTO \`base_user_info\`
          (\`account_id\`, \`nickname\`, \`real_name\`, \`customer_organization_id\`,
           \`access_group\`, \`meta_digest\`, \`user_state\`, \`created_at\`, \`updated_at\`)
        VALUES (?, ?, NULL, ?, ?, ?, 'ACTIVE', ?, ?)
      `,
      [
        accountId,
        fixtureInfoNickname(fixture.loginName),
        fixture.organizationId,
        JSON.stringify(accessGroup),
        metaDigestCipher,
        createdAt,
        createdAt,
      ],
    );
  }

  if (fixture.membership !== undefined && fixture.membership !== null) {
    await insertFixtureMembership(dataSource, accountId, fixture.membership);
  }

  return accountId;
};

const runInitWithoutAdmin = async (): Promise<DeployReport> =>
  runDatabaseDeploy(
    {
      mode: 'init',
      envFile: CONFIG_FILE,
      database: EXPECTED_DB,
      confirmDatabase: EXPECTED_DB,
    },
    silentLogger,
  );

const runInitWithAdmin = async (adminBootstrapFile: string): Promise<DeployReport> =>
  runDatabaseDeploy(
    {
      mode: 'init',
      envFile: CONFIG_FILE,
      database: EXPECTED_DB,
      confirmDatabase: EXPECTED_DB,
      adminBootstrapFile,
      confirmAdminBootstrap: ADMIN_BOOTSTRAP_CONFIRM_VALUE,
    },
    silentLogger,
  );

/**
 * 只解析 INSERT 语句头部（关键字 + 表名），不做整条 SQL 的字面量匹配。
 * 兼容多行缩进、反引号与大小写差异。
 */
const insertTargetTable = (sql: string): string | null => {
  const firstLine = sql.split('\n').find((line) => line.trim().length > 0) ?? '';
  const match = /^INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?/i.exec(firstLine.trim());
  return match === null ? null : match[1].toLowerCase();
};

interface InjectionProbe {
  infoInsertAttempts: number;
  successfulInserts: number;
  injectionCount: number;
  injectedError: Error | null;
  readonly insertRunners: QueryRunner[];
}

/**
 * 只允许在“本次初始化的第 2 条 base_user_info 插入”时失败的受控替身。
 *
 * 注入点必须落在 `DataSource.query`：`applyAdminBootstrap` 通过 `manager.query` 写入，
 * TypeORM 的 `EntityManager.query` 会转发到 `dataSource.query(sql, parameters, this.queryRunner)`；
 * 只重写 `createQueryRunner` 不会命中真实调用路径。
 *
 * 未注入的调用原样委托 `super.query`，并透传同一个 QueryRunner 与参数，保留事务上下文。
 */
class FailingDataSource extends DataSource {
  readonly probe: InjectionProbe = {
    infoInsertAttempts: 0,
    successfulInserts: 0,
    injectionCount: 0,
    injectedError: null,
    insertRunners: [],
  };

  constructor(
    options: DataSourceOptions,
    private readonly failOnInfoInsert?: number,
  ) {
    super(options);
  }

  override async query<T = unknown>(
    sql: string,
    parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): Promise<T> {
    const target = insertTargetTable(sql);
    if (target === 'base_user_info' && this.failOnInfoInsert !== undefined) {
      this.probe.infoInsertAttempts += 1;
      if (this.probe.infoInsertAttempts === this.failOnInfoInsert) {
        const error = new Error(INJECTED_FAILURE);
        this.probe.injectionCount += 1;
        this.probe.injectedError = error;
        throw error;
      }
    }

    const result = await super.query<T>(sql, parameters, queryRunner);
    if (target !== null) {
      this.probe.successfulInserts += 1;
      if (queryRunner !== undefined) {
        this.probe.insertRunners.push(queryRunner);
      }
    }
    return result;
  }
}

const cleanupOwned = async (): Promise<void> => {
  if (!ENABLED || state.config === null) {
    return;
  }
  const dataSource = createMigrationDataSource(state.config);
  await dataSource.initialize();
  try {
    await runGuardedScopedCleanup({
      dataSource,
      helper: 'S4 管理员初始化专项',
      expectedDatabase: EXPECTED_DB,
      cleanup: async (manager): Promise<void> => {
        const names = [...state.loginNames];
        if (names.length > 0) {
          await manager.query(
            `
              DELETE FROM \`organization_membership\`
              WHERE \`account_id\` IN (
                SELECT \`id\` FROM \`base_user_account\` WHERE \`login_name\` IN (${placeholdersOf(names)})
              )
            `,
            [...names],
          );
          await manager.query(
            `
              DELETE FROM \`base_user_info\`
              WHERE \`account_id\` IN (
                SELECT \`id\` FROM \`base_user_account\` WHERE \`login_name\` IN (${placeholdersOf(names)})
              )
            `,
            [...names],
          );
          await manager.query(
            `DELETE FROM \`base_user_account\` WHERE \`login_name\` IN (${placeholdersOf(names)})`,
            [...names],
          );
        }
        const ids = [...state.accountIds];
        if (ids.length > 0) {
          await manager.query(
            `DELETE FROM \`organization_membership\` WHERE \`account_id\` IN (${placeholdersOf(ids)})`,
            [...ids],
          );
          await manager.query(
            `DELETE FROM \`base_user_info\` WHERE \`account_id\` IN (${placeholdersOf(ids)})`,
            [...ids],
          );
          await manager.query(
            `DELETE FROM \`base_user_account\` WHERE \`id\` IN (${placeholdersOf(ids)})`,
            [...ids],
          );
        }
        const organizationIds = [...state.organizationIds];
        if (organizationIds.length > 0) {
          await manager.query(
            `DELETE FROM \`organization_membership\` WHERE \`organization_id\` IN (${placeholdersOf(organizationIds)})`,
            [...organizationIds],
          );
          await manager.query(
            `DELETE FROM \`organization\` WHERE \`id\` IN (${placeholdersOf(organizationIds)})`,
            [...organizationIds],
          );
        }
      },
    });
  } finally {
    await dataSource.destroy();
  }
};

describeRealDb('S4 合成管理员初始化专项（受控实库）', () => {
  beforeAll(async () => {
    assertBootstrapDir();
    state.config = loadExplicitEnvConfig(CONFIG_FILE, EXPECTED_DB);
    requireEncryption();

    const identityDataSource = createMigrationDataSource(requireConfig());
    await identityDataSource.initialize();
    try {
      await assertTargetIdentity(identityDataSource);
      await assertEmptyTarget(identityDataSource);
    } finally {
      await identityDataSource.destroy();
    }

    state.dataSource = createMigrationDataSource(requireConfig());
    await state.dataSource.initialize();

    state.initReport = await runInitWithoutAdmin();
    if (state.initReport.executed.length !== MIGRATION_COUNT) {
      throw new Error(
        `空库正向 init 应执行 ${String(MIGRATION_COUNT)} 条迁移，实际 ${String(
          state.initReport.executed.length,
        )} 条。`,
      );
    }
    if (state.initReport.noChanges) {
      throw new Error('空库 init 不应返回“无变化”。');
    }

    const dataSource = requireDataSource();
    const baselineRows = await dataSource.query<Array<{ id: number | string }>>(
      'SELECT id FROM `organization` WHERE `organization_code` = ?',
      [BASELINE_ORGANIZATION_CODE],
    );
    const baseline = baselineRows[0];
    if (!baseline || baselineRows.length !== 1) {
      throw new Error('迁移种子应恰好存在 1 个 CLIENT_DEFAULT 组织，拒绝继续。');
    }
    state.baselineOrgId = normalizeBigIntId(baseline.id, 'organization.id');

    // 基线必须在“普通 init 完成之后、任何合成公司/账号创建之前”采集：
    // 此刻库内只有迁移种子（organization 仅 CLIENT_DEFAULT 一行），本轮夹具尚未写入。
    // 收尾时仍与该基线逐项比较，不把期望值改成清理后的实际值。
    state.structureBefore = await structureDigest(dataSource);
    state.rowCountsBefore = await tableRowCounts(dataSource);
    state.historyBefore = await historyDigest(dataSource);
    state.tableCountBefore = (await readBaseTableNames(dataSource, EXPECTED_DB)).length;
    if (state.rowCountsBefore['organization'] !== 1) {
      throw new Error(
        `基线采样时 organization 应仅有 1 行迁移种子（${BASELINE_ORGANIZATION_CODE}），` +
          `实际 ${String(state.rowCountsBefore['organization'])} 行；拒绝继续。`,
      );
    }
    if (
      state.rowCountsBefore['base_user_account'] !== 0 ||
      state.rowCountsBefore['base_user_info'] !== 0
    ) {
      throw new Error('基线采样时账号/资料表应为空（迁移种子不含管理员）；拒绝继续。');
    }

    const codes: string[] = [];
    for (const scenario of ORGANIZATION_SCENARIOS) {
      const code = fixtureOrganizationCode(scenario);
      await insertOrganization(dataSource, code, fixtureOrganizationName(scenario));
      codes.push(code);
    }

    const levelOneAccounts: MappingEntryInput[] = LEVEL_ONE_SCENARIOS.map((scenario) => ({
      loginName: fixtureLoginName(scenario),
      loginEmail: fixtureEmail(scenario),
      password: randomPassword(),
      adminLevel: 1,
      organizationCode: BASELINE_ORGANIZATION_CODE,
      nickname: fixtureNickname(scenario),
      realName: fixtureRealName(scenario),
    }));
    const levelTwoAccounts: MappingEntryInput[] = LEVEL_TWO_SCENARIOS.map((scenario, index) => ({
      loginName: fixtureLoginName(scenario),
      loginEmail: fixtureEmail(scenario),
      password: randomPassword(),
      adminLevel: 2,
      organizationCode: codes[index] ?? '',
      nickname: fixtureNickname(scenario),
      realName: fixtureRealName(scenario),
    }));

    state.mainMappingPath = writeMappingFile('main', [...levelOneAccounts, ...levelTwoAccounts]);
    state.mainMapping = parseAdminBootstrapConfig(fs.readFileSync(state.mainMappingPath, 'utf8'));
  }, 300_000);

  afterAll(async () => {
    if (!state.cleaned) {
      try {
        await cleanupOwned();
      } catch (error: unknown) {
        state.cleanupError = messageOf(error);
      }
    }
    if (state.dataSource !== null) {
      await state.dataSource.destroy();
      state.dataSource = null;
    }
  }, 180_000);

  it('0. 普通 init 未显式启用管理员初始化时不创建管理员', async () => {
    const dataSource = requireDataSource();
    expect(state.initReport?.adminBootstrap).toBeNull();
    expect(await countRows(dataSource, 'SELECT COUNT(*) AS total FROM `base_user_account`')).toBe(
      0,
    );
    expect(
      await countRows(
        dataSource,
        'SELECT COUNT(*) AS total FROM `base_user_account` WHERE `admin_level` IS NOT NULL',
      ),
    ).toBe(0);
    expect(await countRows(dataSource, 'SELECT COUNT(*) AS total FROM `base_user_info`')).toBe(0);

    const history = await readMigrationHistory(dataSource, EXPECTED_DB);
    expect(history.history.length).toBe(MIGRATION_COUNT);
    const tables = await readBaseTableNames(dataSource, EXPECTED_DB);
    expect(tables.length).toBe(BUSINESS_TABLE_COUNT);
  }, 120_000);

  it('1. 合法首次初始化：3 个一级 + 3 个二级，密码可验且必须改密', async () => {
    if (state.mainMappingPath === null || state.mainMapping === null) {
      throw new Error('主映射未冻结。');
    }
    const report = await runInitWithAdmin(state.mainMappingPath);
    expect(report.noChanges).toBe(true);
    expect(report.adminBootstrap).not.toBeNull();
    const results = report.adminBootstrap ?? [];
    expect(results).toHaveLength(LEVEL_ONE_ACCOUNTS + LEVEL_TWO_ACCOUNTS);
    expect(results.every((item) => item.outcome === 'CREATED')).toBe(true);
    expect(results.filter((item) => item.adminLevel === 1)).toHaveLength(LEVEL_ONE_ACCOUNTS);
    expect(results.filter((item) => item.adminLevel === 2)).toHaveLength(LEVEL_TWO_ACCOUNTS);

    const dataSource = requireDataSource();
    const entries: readonly AdminBootstrapEntry[] = state.mainMapping.accounts;
    const accounts = await readAccounts(
      dataSource,
      entries.map((entry) => entry.loginName),
    );
    expect(accounts).toHaveLength(entries.length);

    const createdIds: string[] = [];
    for (const entry of entries) {
      const account = accounts.find((row) => row.login_name === entry.loginName);
      if (!account) {
        throw new Error(`创建的账号 ${entry.loginName} 未回读到。`);
      }
      createdIds.push(normalizeBigIntId(account.id, 'base_user_account.id'));
      state.accountIds.add(normalizeBigIntId(account.id, 'base_user_account.id'));

      expect(account.login_email).toBe(entry.loginEmail);
      expect(account.status).toBe('ACTIVE');
      expect(account.identity_hint).toBe('SUPER_ADMIN');
      expect(Number(account.admin_level)).toBe(entry.adminLevel);
      expect(Number(account.must_change_password)).toBe(1);
      expect(account.login_password).toMatch(/^[0-9a-f]{128}$/);

      const createdAt = toDate(account.created_at, 'base_user_account.created_at');
      expect(AccountService.verifyPassword(entry.password, account.login_password, createdAt)).toBe(
        true,
      );
      expect(
        AccountService.verifyPassword(`${entry.password}-wrong`, account.login_password, createdAt),
      ).toBe(false);
    }

    const infos = await readInfos(dataSource, createdIds);
    expect(infos).toHaveLength(entries.length);
    const memberships = await readMemberships(dataSource, createdIds);
    expect(memberships).toHaveLength(entries.length);
    for (const entry of entries) {
      const account = accounts.find((row) => row.login_name === entry.loginName);
      if (!account) {
        throw new Error(`创建的账号 ${entry.loginName} 未回读到。`);
      }
      const info = infos.find(
        (row) =>
          normalizeBigIntId(row.account_id, 'base_user_info.account_id') ===
          normalizeBigIntId(account.id, 'base_user_info.account_id'),
      );
      if (!info) {
        throw new Error(`账号 ${entry.loginName} 缺少用户资料。`);
      }
      expect(info.nickname).toBe(entry.nickname);
      expect(info.user_state).toBe('ACTIVE');
      const accessGroup = jsonValue(info.access_group);
      expect(accessGroup).toEqual(['SUPER_ADMIN']);
      if (info.meta_digest === null) {
        throw new Error(`账号 ${entry.loginName} 的 meta_digest 为空，角色事实不完整。`);
      }
      expect(info.meta_digest).not.toBe(JSON.stringify(accessGroup));
      expect(decryptRoleDigest(info.meta_digest)).toEqual(accessGroup);
      const convergence = convergeAccountRole({
        identityHint: account.identity_hint,
        accessGroup,
        metaDigest: decryptRoleDigest(info.meta_digest),
      });
      expect(convergence).toEqual({ converged: true, role: IdentityTypeEnum.SUPER_ADMIN });

      const expectedOrganizationId =
        entry.adminLevel === 1
          ? state.baselineOrgId
          : await organizationIdByCode(dataSource, entry.organizationCode);
      const actualOrganizationId = info.customer_organization_id;
      if (actualOrganizationId === null) {
        throw new Error(`账号 ${entry.loginName} 的用户资料未写入公司归属。`);
      }
      expect(normalizeBigIntId(actualOrganizationId, 'customer_organization_id')).toBe(
        expectedOrganizationId,
      );

      const membership = memberships.find(
        (row) =>
          normalizeBigIntId(row.account_id, 'organization_membership.account_id') ===
          normalizeBigIntId(account.id, 'organization_membership.account_id'),
      );
      if (!membership) {
        throw new Error(`账号 ${entry.loginName} 缺少组织成员关系。`);
      }
      expect(membership.member_role).toBe('SUPER_ADMIN');
      expect(membership.status).toBe('ACTIVE');
      expect(membership.left_at).toBeNull();
      expect(
        normalizeBigIntId(membership.organization_id, 'organization_membership.organization_id'),
      ).toBe(expectedOrganizationId);
    }
  }, 180_000);

  it('2. 同一映射重复执行：全部 UNCHANGED，密码与字段无漂移', async () => {
    if (state.mainMappingPath === null || state.mainMapping === null) {
      throw new Error('主映射未冻结。');
    }
    const dataSource = requireDataSource();
    const names = state.mainMapping.accounts.map((entry) => entry.loginName);
    const beforeAccounts = plainRows(await readAccounts(dataSource, names));
    const beforeIds = beforeAccounts.map((row) => normalizeBigIntId(row.id, 'account.id'));
    const beforeInfos = plainRows(await readInfos(dataSource, beforeIds));

    const report = await runInitWithAdmin(state.mainMappingPath);
    expect(report.noChanges).toBe(true);
    const results = report.adminBootstrap ?? [];
    expect(results).toHaveLength(names.length);
    expect(results.every((item) => item.outcome === 'UNCHANGED')).toBe(true);

    const afterAccounts = plainRows(await readAccounts(dataSource, names));
    const afterIds = afterAccounts.map((row) => normalizeBigIntId(row.id, 'account.id'));
    const afterInfos = plainRows(await readInfos(dataSource, afterIds));

    expect(afterAccounts).toEqual(beforeAccounts);
    expect(afterInfos).toEqual(beforeInfos);
    expect(afterIds).toEqual(beforeIds);
    expect(
      await countRows(
        dataSource,
        `SELECT COUNT(*) AS total FROM \`base_user_account\` WHERE \`login_name\` IN (${placeholdersOf(names)})`,
        names,
      ),
    ).toBe(names.length);
  }, 180_000);

  it('3a. 等级冲突：已有 2 级映射为 1 级，明确拒绝且原记录不变', async () => {
    const dataSource = requireDataSource();
    const fixtureName = fixtureLoginName('cflevel');
    const fixturePassword = randomPassword();
    await createFixtureAccount(dataSource, {
      loginName: fixtureName,
      loginEmail: fixtureEmail('cflevel'),
      password: fixturePassword,
      adminLevel: 2,
      identityHint: 'SUPER_ADMIN',
      mustChangePassword: 1,
      organizationId: state.baselineOrgId,
      withInfo: true,
    });
    const before = await readAccount(dataSource, fixtureName);

    const mappingPath = writeMappingFile('conflict-level', [
      {
        loginName: fixtureName,
        loginEmail: null,
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: '冲突映射',
        realName: null,
      },
    ]);
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));

    await expect(applyBootstrap(dataSource, mapping)).rejects.toThrow(/已有等级 2/);
    const after = await readAccount(dataSource, fixtureName);
    expect(after).toEqual(before);
    expect(Number(after.admin_level)).toBe(2);
    expect(
      await countRows(
        dataSource,
        'SELECT COUNT(*) AS total FROM `base_user_account` WHERE `login_name` = ?',
        [fixtureName],
      ),
    ).toBe(1);
  }, 120_000);

  it('3b. 归属冲突：已归属其他公司，拒绝覆盖且等级不被补齐', async () => {
    const dataSource = requireDataSource();
    const fixtureName = fixtureLoginName('cforg');
    const otherOrganizationId = [...state.organizationIds][0];
    if (otherOrganizationId === undefined) {
      throw new Error('缺少合成公司。');
    }
    await createFixtureAccount(dataSource, {
      loginName: fixtureName,
      loginEmail: fixtureEmail('cforg'),
      password: randomPassword(),
      adminLevel: null,
      identityHint: null,
      mustChangePassword: 0,
      organizationId: otherOrganizationId,
      withInfo: true,
    });
    const before = await readAccount(dataSource, fixtureName);

    const mappingPath = writeMappingFile('conflict-org', [
      {
        loginName: fixtureName,
        loginEmail: null,
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: '归属冲突映射',
        realName: null,
      },
    ]);
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));

    await expect(applyBootstrap(dataSource, mapping)).rejects.toThrow(/已归属其他公司/);
    const after = await readAccount(dataSource, fixtureName);
    expect(after).toEqual(before);
    expect(after.admin_level).toBeNull();
  }, 120_000);

  it('3c. 已有账号补映射：角色与成员关系有效时仅补等级/归属；重跑 UNCHANGED', async () => {
    const dataSource = requireDataSource();
    const fixtureName = fixtureLoginName('mapexist');
    const fixturePassword = randomPassword();
    const accountId = await createFixtureAccount(dataSource, {
      loginName: fixtureName,
      loginEmail: fixtureEmail('mapexist'),
      password: fixturePassword,
      adminLevel: null,
      identityHint: 'SUPER_ADMIN',
      mustChangePassword: 0,
      organizationId: null,
      withInfo: true,
      accessGroup: ['SUPER_ADMIN'],
      metaDigest: ['SUPER_ADMIN'],
      membership: { organizationId: state.baselineOrgId, memberRole: 'SUPER_ADMIN' },
    });
    const before = await readAccount(dataSource, fixtureName);

    const mappingPath = writeMappingFile('map-existing', [
      {
        loginName: fixtureName,
        loginEmail: null,
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: '补映射账号',
        realName: null,
      },
    ]);
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));

    const results = await applyBootstrap(dataSource, mapping);
    expect(results.map((item) => item.outcome)).toEqual(['MAPPED']);

    const after = await readAccount(dataSource, fixtureName);
    expect(Number(after.admin_level)).toBe(1);
    expect(after.login_password).toBe(before.login_password);
    expect(Number(after.must_change_password)).toBe(0);
    expect(after.identity_hint).toBe('SUPER_ADMIN');
    expect(
      AccountService.verifyPassword(
        fixturePassword,
        after.login_password,
        toDate(after.created_at, 'created_at'),
      ),
    ).toBe(true);
    const infoRows = await readInfos(dataSource, [accountId]);
    expect(infoRows).toHaveLength(1);
    const mappedOrganizationId = infoRows[0]?.customer_organization_id;
    if (mappedOrganizationId === null || mappedOrganizationId === undefined) {
      throw new Error('补映射后用户资料缺少公司归属。');
    }
    expect(normalizeBigIntId(mappedOrganizationId, 'customer_organization_id')).toBe(
      state.baselineOrgId,
    );

    const second = await applyBootstrap(dataSource, mapping);
    expect(second.map((item) => item.outcome)).toEqual(['UNCHANGED']);
    expect(await readAccount(dataSource, fixtureName)).toEqual(after);
  }, 120_000);

  it('3d. 映射引用不存在的公司：拒绝且不猜测、无新增账号', async () => {
    const dataSource = requireDataSource();
    const fixtureName = fixtureLoginName('missorg');
    const mappingPath = writeMappingFile('missing-org', [
      {
        loginName: fixtureName,
        loginEmail: fixtureEmail('missorg'),
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: fixtureMissingOrganizationCode(),
        nickname: '缺公司映射',
        realName: null,
      },
    ]);
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));
    await expect(applyBootstrap(dataSource, mapping)).rejects.toThrow(
      /不存在的公司 organization_code=/,
    );
    expect(
      await countRows(
        dataSource,
        'SELECT COUNT(*) AS total FROM `base_user_account` WHERE `login_name` = ?',
        [fixtureName],
      ),
    ).toBe(0);
  }, 120_000);

  it('3e. 已有账号缺少用户资料：拒绝自动补造且原记录不变', async () => {
    const dataSource = requireDataSource();
    const fixtureName = fixtureLoginName('missinfo');
    await createFixtureAccount(dataSource, {
      loginName: fixtureName,
      loginEmail: fixtureEmail('missinfo'),
      password: randomPassword(),
      adminLevel: null,
      identityHint: null,
      mustChangePassword: 0,
      organizationId: null,
      withInfo: false,
    });
    const before = await readAccount(dataSource, fixtureName);

    const mappingPath = writeMappingFile('missing-info', [
      {
        loginName: fixtureName,
        loginEmail: null,
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: '缺资料映射',
        realName: null,
      },
    ]);
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));

    await expect(applyBootstrap(dataSource, mapping)).rejects.toThrow(/缺少用户资料/);
    expect(await readAccount(dataSource, fixtureName)).toEqual(before);
  }, 120_000);

  it('3f. 邮箱唯一键碰撞：整批回滚，不产生部分账号', async () => {
    const dataSource = requireDataSource();
    const existingName = fixtureLoginName('emailown');
    const existingEmail = fixtureEmail('emailown');
    await createFixtureAccount(dataSource, {
      loginName: existingName,
      loginEmail: existingEmail,
      password: randomPassword(),
      adminLevel: null,
      identityHint: null,
      mustChangePassword: 0,
      organizationId: null,
      withInfo: true,
    });

    const firstNew = fixtureLoginName('colfirst');
    const secondNew = fixtureLoginName('colsecond');
    const mappingPath = writeMappingFile('email-collision', [
      {
        loginName: firstNew,
        loginEmail: fixtureEmail('colfirst'),
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: '碰撞第一个',
        realName: null,
      },
      {
        loginName: secondNew,
        loginEmail: existingEmail,
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: '碰撞第二个',
        realName: null,
      },
    ]);
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));

    await expect(applyBootstrap(dataSource, mapping)).rejects.toThrow(
      /Duplicate entry|ER_DUP_ENTRY|uk_login_email/,
    );
    expect(
      await countRows(
        dataSource,
        `SELECT COUNT(*) AS total FROM \`base_user_account\` WHERE \`login_name\` IN (?, ?)`,
        [firstNew, secondNew],
      ),
    ).toBe(0);
    expect(
      await countRows(
        dataSource,
        `
            SELECT COUNT(*) AS total FROM \`base_user_info\`
            WHERE \`account_id\` IN (
              SELECT \`id\` FROM \`base_user_account\` WHERE \`login_name\` IN (?, ?)
            )
          `,
        [firstNew, secondNew],
      ),
    ).toBe(0);
  }, 120_000);

  it('3g. 注入第 2 条用户资料写入失败：单事务整体回滚', async () => {
    const config = requireConfig();
    const baseOptions = createMigrationDataSource(config).options;
    const failing = new FailingDataSource(baseOptions, 2);
    const names = ROLLBACK_SCENARIOS.map((scenario) => fixtureLoginName(scenario));
    const mappingPath = writeMappingFile(
      'rollback',
      ROLLBACK_SCENARIOS.map((scenario, index) => ({
        loginName: fixtureLoginName(scenario),
        loginEmail: fixtureEmail(scenario),
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: `回滚账号 ${String(index + 1)}`,
        realName: null,
      })),
    );
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));

    await failing.initialize();
    let thrown: unknown = null;
    try {
      try {
        await applyBootstrap(failing, mapping);
      } catch (error: unknown) {
        thrown = error;
      }

      // 产品未包装错误：`applyAdminBootstrap` 的事务回调直接透传注入错误，
      // TypeORM 事务在回滚后原样 `throw`，因此这里断言抛出对象与注入对象是同一实例。
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toBe(failing.probe.injectedError);

      // 以下断言全部在业务调用失败后、任何数据清理之前执行：
      // 用“当前已提交状态”证明回滚，不依赖 afterAll 清理后的零行数。

      // 探针 1：注入点实际命中且只命中一次。
      expect(failing.probe.injectionCount).toBe(1);
      expect(failing.probe.infoInsertAttempts).toBe(2);

      // 探针 2：抛出的错误文本与预设错误一致（身份断言见上）。
      expect(failing.probe.injectedError).toBeInstanceOf(Error);
      expect((failing.probe.injectedError as Error).message).toBe(INJECTED_FAILURE);

      // 探针 3：故障发生前本事务内已有成功写入（账号+资料各至少一条）。
      expect(failing.probe.successfulInserts).toBeGreaterThanOrEqual(3);

      // 探针 4：委托写入复用同一个 QueryRunner，事务上下文未丢失。
      expect(failing.probe.insertRunners.length).toBe(failing.probe.successfulInserts);
      const runners = new Set(failing.probe.insertRunners);
      expect(runners.size).toBe(1);

      const dataSource = requireDataSource();
      expect(
        await countRows(
          dataSource,
          `SELECT COUNT(*) AS total FROM \`base_user_account\` WHERE \`login_name\` IN (${placeholdersOf(
            names,
          )})`,
          names,
        ),
      ).toBe(0);
      expect(
        await countRows(
          dataSource,
          `
              SELECT COUNT(*) AS total FROM \`base_user_info\`
              WHERE \`account_id\` IN (
                SELECT \`id\` FROM \`base_user_account\` WHERE \`login_name\` IN (${placeholdersOf(
                  names,
                )})
              )
            `,
          names,
        ),
      ).toBe(0);
    } finally {
      await failing.destroy();
    }
  }, 120_000);

  it('3h. 已有账号角色事实无效：明确拒绝，不返回 UNCHANGED', async () => {
    const dataSource = requireDataSource();
    const fixtureName = fixtureLoginName('invalidlevel');
    await createFixtureAccount(dataSource, {
      loginName: fixtureName,
      loginEmail: fixtureEmail('invalidlevel'),
      password: randomPassword(),
      adminLevel: null,
      identityHint: 'ENGINEER',
      mustChangePassword: 0,
      organizationId: null,
      withInfo: true,
      accessGroup: ['guest'],
      metaDigest: ['guest'],
    });
    const before = await readAccount(dataSource, fixtureName);

    const mappingPath = writeMappingFile('invalid-role', [
      {
        loginName: fixtureName,
        loginEmail: null,
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: '角色无效映射',
        realName: null,
      },
    ]);
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));

    await expect(applyBootstrap(dataSource, mapping)).rejects.toThrow(/角色事实无效/);
    expect(await readAccount(dataSource, fixtureName)).toEqual(before);
    expect(Number((await readAccount(dataSource, fixtureName)).admin_level)).toBeNull();
  }, 120_000);

  it('4. 输入与配置：非法映射与目标不一致明确拒绝且不连接', async () => {
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: fixtureLoginName('invalidlevel'),
              login_email: null,
              password: randomPassword(),
              admin_level: 3,
              organization_code: BASELINE_ORGANIZATION_CODE,
              nickname: '非法等级',
            },
          ],
        }),
      ),
    ).toThrow(/admin_level 必须为 1 或 2/);

    const duplicateName = fixtureLoginName('duplicate');
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [duplicateName, duplicateName].map((loginName) => ({
            login_name: loginName,
            login_email: null,
            password: randomPassword(),
            admin_level: 1,
            organization_code: BASELINE_ORGANIZATION_CODE,
            nickname: '重复账号',
          })),
        }),
      ),
    ).toThrow(/存在重复账号/);

    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: fixtureLoginName('misspassword'),
              login_email: null,
              admin_level: 1,
              organization_code: BASELINE_ORGANIZATION_CODE,
              nickname: '缺密码',
            },
          ],
        }),
      ),
    ).toThrow(/缺少非空字符串字段 password/);

    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: fixtureLoginName('missorgcode'),
              login_email: null,
              password: randomPassword(),
              admin_level: 1,
              nickname: '缺组织编码',
            },
          ],
        }),
      ),
    ).toThrow(/缺少非空字符串字段 organization_code/);

    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        `--config-file=${CONFIG_FILE}`,
        `--database=${EXPECTED_DB}`,
        `--confirm-database=${EXPECTED_DB}`,
        '--admin-bootstrap-file=/nonexistent.json',
      ]),
    ).toThrow(/confirm-admin-bootstrap/);

    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        `--config-file=${CONFIG_FILE}`,
        `--database=${EXPECTED_DB}`,
        `--confirm-database=${EXPECTED_DB}`,
        '--admin-bootstrap-file=/nonexistent.json',
        `--confirm-admin-bootstrap=${ADMIN_BOOTSTRAP_CONFIRM_VALUE}`,
      ]),
    ).toThrow(/只允许在 init 模式执行/);

    expect(() => loadExplicitEnvConfig(CONFIG_FILE, `${EXPECTED_DB}_mismatch`)).toThrow(
      /环境文件目标库与参数不一致/,
    );

    let dataSourceCreated = false;
    await expect(
      runDatabaseDeploy(
        {
          mode: 'init',
          envFile: CONFIG_FILE,
          database: `${EXPECTED_DB}_mismatch`,
          confirmDatabase: `${EXPECTED_DB}_mismatch`,
        },
        silentLogger,
        {
          createDataSource: (): DataSource => {
            dataSourceCreated = true;
            throw new Error('目标不一致时不应建立连接');
          },
          lockTimeoutSeconds: 0,
        },
      ),
    ).rejects.toThrow(/环境文件目标库与参数不一致/);
    expect(dataSourceCreated).toBe(false);
  });

  /**
   * 第 6 组是“初始化后真实可用”的回归骨架：本规格不启动 Nest/GraphQL，也不签发 JWT；
   * 这里对这个专项创建的账号执行登录/改密/受保护 Query/管理操作/越权拒绝所依赖的
   * 持久化事实回归。完整 API 会话链路由既有 e2e 套件覆盖，启用本专项时这些断言可执行。
   */
  it('6a. 回归骨架：真实登录所需的账号、密码、角色与成员事实一致', async () => {
    if (state.mainMapping === null) {
      throw new Error('主映射未冻结。');
    }
    const dataSource = requireDataSource();
    const entry = state.mainMapping.accounts.find((item) => item.adminLevel === 1);
    if (entry === undefined) {
      throw new Error('主映射缺少 1 级管理员。');
    }
    const account = await readAccount(dataSource, entry.loginName);
    const accountId = normalizeBigIntId(account.id, 'base_user_account.id');
    const info = (await readInfos(dataSource, [accountId]))[0];
    if (info === undefined) {
      throw new Error(`账号 ${entry.loginName} 缺少用户资料。`);
    }
    const membership = (await readMemberships(dataSource, [accountId]))[0];
    if (membership === undefined) {
      throw new Error(`账号 ${entry.loginName} 缺少组织成员关系。`);
    }

    expect(account.status).toBe('ACTIVE');
    expect(Number(account.must_change_password)).toBe(1);
    expect(
      AccountService.verifyPassword(
        entry.password,
        account.login_password,
        toDate(account.created_at, 'base_user_account.created_at'),
      ),
    ).toBe(true);
    const convergence = convergeAccountRole({
      identityHint: account.identity_hint,
      accessGroup: jsonValue(info.access_group),
      metaDigest: decryptRoleDigest(info.meta_digest),
    });
    expect(convergence).toEqual({ converged: true, role: IdentityTypeEnum.SUPER_ADMIN });
    expect(membership.member_role).toBe('SUPER_ADMIN');
    expect(membership.status).toBe('ACTIVE');
    expect(membership.left_at).toBeNull();
  }, 120_000);

  it('6b. 回归骨架：首次改密后旧密码失效、新密码可验且清除强制改密标记', async () => {
    if (state.mainMapping === null) {
      throw new Error('主映射未冻结。');
    }
    const dataSource = requireDataSource();
    const entry = state.mainMapping.accounts.find((item) => item.adminLevel === 2);
    if (entry === undefined) {
      throw new Error('主映射缺少 2 级管理员。');
    }
    const account = await readAccount(dataSource, entry.loginName);
    const newPassword = randomPassword();
    const createdAt = toDate(account.created_at, 'base_user_account.created_at');
    const newHash = AccountService.hashPasswordWithTimestamp(newPassword, createdAt);

    await dataSource.query(
      'UPDATE `base_user_account` SET `login_password` = ?, `must_change_password` = 0 WHERE `id` = ?',
      [newHash, account.id],
    );
    const updated = await readAccount(dataSource, entry.loginName);
    const updatedCreatedAt = toDate(updated.created_at, 'base_user_account.created_at');
    expect(
      AccountService.verifyPassword(entry.password, updated.login_password, updatedCreatedAt),
    ).toBe(false);
    expect(
      AccountService.verifyPassword(newPassword, updated.login_password, updatedCreatedAt),
    ).toBe(true);
    expect(Number(updated.must_change_password)).toBe(0);
  }, 120_000);

  it('6c. 回归骨架：受保护 Query 的角色事实收敛为 SUPER_ADMIN 且成员关系唯一有效', async () => {
    if (state.mainMapping === null) {
      throw new Error('主映射未冻结。');
    }
    const dataSource = requireDataSource();
    for (const entry of state.mainMapping.accounts) {
      const account = await readAccount(dataSource, entry.loginName);
      const accountId = normalizeBigIntId(account.id, 'base_user_account.id');
      const info = (await readInfos(dataSource, [accountId]))[0];
      if (info === undefined) {
        throw new Error(`账号 ${entry.loginName} 缺少用户资料。`);
      }
      expect(
        convergeAccountRole({
          identityHint: account.identity_hint,
          accessGroup: jsonValue(info.access_group),
          metaDigest: decryptRoleDigest(info.meta_digest),
        }),
      ).toEqual({ converged: true, role: IdentityTypeEnum.SUPER_ADMIN });
      const memberships = await readMemberships(dataSource, [accountId]);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.member_role).toBe('SUPER_ADMIN');
      expect(memberships[0]?.status).toBe('ACTIVE');
      expect(memberships[0]?.left_at).toBeNull();
    }
  }, 120_000);

  it('6d. 回归骨架：合法管理操作的等级与组织类型契约一致', async () => {
    if (state.mainMapping === null) {
      throw new Error('主映射未冻结。');
    }
    const dataSource = requireDataSource();
    for (const entry of state.mainMapping.accounts) {
      const account = await readAccount(dataSource, entry.loginName);
      const accountId = normalizeBigIntId(account.id, 'base_user_account.id');
      const membership = (await readMemberships(dataSource, [accountId]))[0];
      if (membership === undefined) {
        throw new Error(`账号 ${entry.loginName} 缺少组织成员关系。`);
      }
      const organizationId = normalizeBigIntId(
        membership.organization_id,
        'organization_membership.organization_id',
      );
      const organizationRows = await dataSource.query<
        Array<{ kind: string; is_managed_company: number | string }>
      >('SELECT `kind`, `is_managed_company` FROM `organization` WHERE `id` = ?', [organizationId]);
      const organization = organizationRows[0];
      if (organization === undefined) {
        throw new Error(`账号 ${entry.loginName} 的成员关系指向不存在的组织。`);
      }
      expect(Number(account.admin_level)).toBe(entry.adminLevel);
      if (entry.adminLevel === 1) {
        expect(organization.kind).toBe('CLIENT');
      } else {
        expect(Number(organization.is_managed_company)).toBe(1);
      }
    }
  }, 120_000);

  it('6e. 回归骨架：非管理员角色事实越权映射被明确拒绝', async () => {
    const dataSource = requireDataSource();
    const fixtureName = fixtureLoginName('rbc');
    await createFixtureAccount(dataSource, {
      loginName: fixtureName,
      loginEmail: fixtureEmail('rbc'),
      password: randomPassword(),
      adminLevel: null,
      identityHint: 'ENGINEER',
      mustChangePassword: 0,
      organizationId: null,
      withInfo: true,
      accessGroup: ['guest'],
      metaDigest: ['guest'],
      membership: { organizationId: state.baselineOrgId, memberRole: 'ENGINEER' },
    });
    const account = await readAccount(dataSource, fixtureName);
    const accountId = normalizeBigIntId(account.id, 'base_user_account.id');
    const info = (await readInfos(dataSource, [accountId]))[0];
    if (info === undefined) {
      throw new Error(`账号 ${fixtureName} 缺少用户资料。`);
    }
    expect(
      convergeAccountRole({
        identityHint: account.identity_hint,
        accessGroup: jsonValue(info.access_group),
        metaDigest: decryptRoleDigest(info.meta_digest),
      }),
    ).toEqual({ converged: true, role: IdentityTypeEnum.ENGINEER });

    const mappingPath = writeMappingFile('unauthorized', [
      {
        loginName: fixtureName,
        loginEmail: null,
        password: randomPassword(),
        adminLevel: 1,
        organizationCode: BASELINE_ORGANIZATION_CODE,
        nickname: '越权映射',
        realName: null,
      },
    ]);
    const mapping = parseAdminBootstrapConfig(fs.readFileSync(mappingPath, 'utf8'));
    await expect(applyBootstrap(dataSource, mapping)).rejects.toThrow(/角色事实无效/);
    expect(Number((await readAccount(dataSource, fixtureName)).admin_level)).toBeNull();
  }, 120_000);

  it('5. 受保护收尾：夹具零残留，迁移/结构/非目标数据不变', async () => {
    await cleanupOwned();
    state.cleaned = true;

    const dataSource = requireDataSource();
    const names = [...state.loginNames];
    expect(await readAccounts(dataSource, names)).toHaveLength(0);
    expect(
      await countRows(
        dataSource,
        `
            SELECT COUNT(*) AS total FROM \`organization_membership\`
            WHERE \`account_id\` IN (
              SELECT \`id\` FROM \`base_user_account\` WHERE \`login_name\` IN (${placeholdersOf(names)})
            )
          `,
        names,
      ),
    ).toBe(0);
    expect(
      await countRows(
        dataSource,
        `
            SELECT COUNT(*) AS total FROM \`base_user_info\`
            WHERE \`account_id\` IN (
              SELECT \`id\` FROM \`base_user_account\` WHERE \`login_name\` IN (${placeholdersOf(names)})
            )
          `,
        names,
      ),
    ).toBe(0);
    expect(
      await countRows(
        dataSource,
        `SELECT COUNT(*) AS total FROM \`organization\` WHERE \`id\` IN (${placeholdersOf([
          ...state.organizationIds,
        ])})`,
        [...state.organizationIds],
      ),
    ).toBe(0);

    const baselineRows = await dataSource.query<
      Array<{ id: number | string; organization_code: string }>
    >('SELECT id, organization_code FROM `organization` ORDER BY id');
    expect(baselineRows.map((row) => row.organization_code)).toEqual([BASELINE_ORGANIZATION_CODE]);
    const remainingBaselineId = baselineRows[0]?.id;
    if (remainingBaselineId === undefined) {
      throw new Error('收尾后未查询到基线组织。');
    }
    expect(normalizeBigIntId(remainingBaselineId, 'organization.id')).toBe(state.baselineOrgId);

    expect(await structureDigest(dataSource)).toBe(state.structureBefore);
    expect(await tableRowCounts(dataSource)).toEqual(state.rowCountsBefore);
    expect(await historyDigest(dataSource)).toBe(state.historyBefore);
    expect((await readBaseTableNames(dataSource, EXPECTED_DB)).length).toBe(state.tableCountBefore);

    const lockRows = await dataSource.query<Array<{ holder: number | null }>>(
      'SELECT IS_USED_LOCK(?) AS holder',
      [`${MIGRATION_LOCK_PREFIX}:${EXPECTED_DB}`],
    );
    expect(lockRows[0]?.holder ?? null).toBeNull();
    expect(
      await countRows(
        dataSource,
        `
            SELECT COUNT(*) AS total
            FROM information_schema.innodb_trx AS trx
            JOIN information_schema.processlist AS plist
              ON plist.id = trx.trx_mysql_thread_id
            WHERE plist.db = ?
          `,
        [EXPECTED_DB],
      ),
    ).toBe(0);
  }, 180_000);
});

/**
 * 不连接数据库的夹具生成器回归：长度、格式、跨场景唯一性。
 * 即使实库专项未授权（describeRealDb 为 skip），本块仍会执行。
 */
describe('S4 夹具生成器回归（不连库）', () => {
  it('运行唯一标识为 8 位小写字母数字', () => {
    expect(RUN_TAG).toHaveLength(RUN_TAG_LENGTH);
    expect(RUN_TAG).toMatch(/^[0-9a-z]{8}$/);
  });

  it('账号夹具字段长度合规、格式正确且跨场景不重复', () => {
    const logins = ACCOUNT_SCENARIOS.map((scenario) => fixtureLoginName(scenario));
    const emails = ACCOUNT_SCENARIOS.map((scenario) => fixtureEmail(scenario));
    const nicknames = ACCOUNT_SCENARIOS.map((scenario) => fixtureNickname(scenario));
    const realNames = ACCOUNT_SCENARIOS.map((scenario) => fixtureRealName(scenario));

    for (const [index, scenario] of ACCOUNT_SCENARIOS.entries()) {
      const login = logins[index] ?? '';
      const email = emails[index] ?? '';
      const nickname = nicknames[index] ?? '';
      const realName = realNames[index] ?? '';

      expect(login).toMatch(new RegExp(`^adm_${scenario}_[0-9a-z]{8}$`));
      expect(login.length).toBeLessThanOrEqual(LOGIN_NAME_MAX);
      expect(email).toMatch(new RegExp(`^adm\\+${scenario}-[0-9a-z]{8}@example\\.invalid$`));
      expect(email.length).toBeLessThanOrEqual(LOGIN_EMAIL_MAX);
      expect(nickname.length).toBeLessThanOrEqual(NICKNAME_MAX);
      expect(nickname).toContain(`${scenario}-${RUN_TAG}`);
      expect(realName.length).toBeLessThanOrEqual(REAL_NAME_MAX);
    }

    expect(new Set(logins).size).toBe(ACCOUNT_SCENARIOS.length);
    expect(new Set(emails).size).toBe(ACCOUNT_SCENARIOS.length);
    expect(new Set(nicknames).size).toBe(ACCOUNT_SCENARIOS.length);
  });

  it('组织夹具 code/name 长度合规且跨场景不重复', () => {
    const codes = ORGANIZATION_SCENARIOS.map((scenario) => fixtureOrganizationCode(scenario));
    const names = ORGANIZATION_SCENARIOS.map((scenario) => fixtureOrganizationName(scenario));

    for (const [index, scenario] of ORGANIZATION_SCENARIOS.entries()) {
      expect(codes[index]).toMatch(new RegExp(`^ADM_${scenario.toUpperCase()}_[0-9A-Z]{8}$`));
      expect((codes[index] ?? '').length).toBeLessThanOrEqual(ORGANIZATION_CODE_MAX);
      expect((names[index] ?? '').length).toBeLessThanOrEqual(ORGANIZATION_NAME_MAX);
    }

    expect(new Set(codes).size).toBe(ORGANIZATION_SCENARIOS.length);
    const missingCode = fixtureMissingOrganizationCode();
    expect(missingCode).toMatch(/^ADM_NO_SUCH_[0-9A-Z]{8}$/);
    expect(missingCode.length).toBeLessThanOrEqual(ORGANIZATION_CODE_MAX);
    expect(codes).not.toContain(missingCode);
  });

  it('超长场景代号直接失败，不做截断', () => {
    const overlong = 'x'.repeat(LOGIN_NAME_MAX) as unknown as AccountScenario;
    expect(() => fixtureLoginName(overlong)).toThrow(/超过上限/);
  });
});

/**
 * 不连接数据库的故障注入调用路径回归。
 *
 * 可离线证明：注入点位于 `DataSource.query`、命中次数与预设错误、未注入调用原样委托
 * （同一 SQL/参数/QueryRunner 对象）、`EntityManager.query` 确实转发到 `DataSource.query`。
 * 证据边界：MySQL 事务的真实回滚语义只能在实库上验证（下一轮 r3）；本块不声称已实测回滚。
 */
describe('S4 故障注入调用路径回归（不连库）', () => {
  const accountSql = `
      INSERT INTO \`base_user_account\`
        (\`login_name\`) VALUES (?)
    `;
  const infoSql = `
      INSERT INTO \`base_user_info\`
        (\`account_id\`) VALUES (?)
    `;

  it('只按语句头部解析 INSERT 目标表，不做整条 SQL 字面量匹配', () => {
    expect(insertTargetTable(accountSql)).toBe('base_user_account');
    expect(insertTargetTable(infoSql)).toBe('base_user_info');
    expect(insertTargetTable('  insert   into  base_user_info (id) values (1)')).toBe(
      'base_user_info',
    );
    expect(insertTargetTable('SELECT * FROM `base_user_info`')).toBeNull();
    expect(insertTargetTable('UPDATE `base_user_info` SET `nickname` = ?')).toBeNull();
  });

  it('第 2 条资料写入前抛预设错误，其余调用原样委托且保留事务上下文', async () => {
    const delegate = jest
      .spyOn(DataSource.prototype, 'query')
      .mockImplementation(() => Promise.resolve([{ ok: true }]));
    const failing = new FailingDataSource({ type: 'mysql' }, 2);
    const runner = { tag: 'tx-query-runner' } as unknown as QueryRunner;
    const firstParams = ['first'];
    const secondParams = ['second'];

    try {
      await failing.query(accountSql, firstParams, runner);
      await failing.query(infoSql, [1], runner);
      await failing.query(accountSql, secondParams, runner);

      // 委托 3 次，SQL/参数/QueryRunner 均原样透传。
      expect(delegate).toHaveBeenCalledTimes(3);
      expect(delegate.mock.calls[0]?.[0]).toBe(accountSql);
      expect(delegate.mock.calls[0]?.[1]).toBe(firstParams);
      expect(delegate.mock.calls[2]?.[2]).toBe(runner);
      expect(failing.probe.successfulInserts).toBe(3);
      expect(new Set(failing.probe.insertRunners).size).toBe(1);
      expect(failing.probe.insertRunners[0]).toBe(runner);

      // 第 2 条资料插入：命中注入点一次，抛出预设错误，且不再委托。
      await expect(failing.query(infoSql, [2], runner)).rejects.toThrow(INJECTED_FAILURE);
      expect(delegate).toHaveBeenCalledTimes(3);
      expect(failing.probe.infoInsertAttempts).toBe(2);
      expect(failing.probe.injectionCount).toBe(1);
      expect(failing.probe.injectedError?.message).toBe(INJECTED_FAILURE);

      // 注入只发生一次：后续调用恢复委托。
      await failing.query(infoSql, [3], runner);
      expect(delegate).toHaveBeenCalledTimes(4);
      expect(failing.probe.injectionCount).toBe(1);
      expect(failing.probe.successfulInserts).toBe(4);
    } finally {
      delegate.mockRestore();
    }
  });

  it('EntityManager.query 经 DataSource.query 转发并携带事务 QueryRunner', async () => {
    const forwarded: Array<{
      readonly sql: string;
      readonly parameters: unknown;
      readonly queryRunner: QueryRunner | undefined;
    }> = [];
    const stubDataSource = {
      query: (sql: string, parameters?: unknown, queryRunner?: QueryRunner): Promise<unknown> => {
        forwarded.push({ sql, parameters, queryRunner });
        return Promise.resolve([]);
      },
    } as unknown as DataSource;
    const runner = { tag: 'tx-query-runner' } as unknown as QueryRunner;
    const manager = new EntityManager(stubDataSource, runner);
    const params = [7];

    await manager.query(infoSql, params);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.sql).toBe(infoSql);
    expect(forwarded[0]?.parameters).toBe(params);
    expect(forwarded[0]?.queryRunner).toBe(runner);
  });
});

/**
 * 按 organization_code 读取主键；公司不存在时失败关闭。
 */
async function organizationIdByCode(dataSource: DataSource, code: string): Promise<string> {
  const rows = await dataSource.query<Array<{ id: number | string }>>(
    'SELECT id FROM `organization` WHERE `organization_code` = ? LIMIT 1',
    [code],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`未查询到公司 ${code}。`);
  }
  return normalizeBigIntId(row.id, 'organization.id');
}

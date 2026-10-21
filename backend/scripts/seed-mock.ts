// scripts/seed-mock.ts
import 'reflect-metadata';
import 'tsconfig-paths/register';

import databaseConfig from '@src/infrastructure/config/database.config';
import { AccountService } from '@src/modules/account/base/services/account.service';
import type { ContentSubmissionHandlingStatus } from '@src/modules/lithography/content-submission.types';
import {
  formatFaultCaseReferenceContent,
  type FaultCaseReferenceContentInput,
} from '@src/usecases/common/fault-case-fields.contract';
import { CONTENT_SUBMISSION_LIBRARY_NOTICE_VERSION } from '@src/usecases/content-submission/content-submission.types';
import * as CryptoJS from 'crypto-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { createHash } from 'node:crypto';
import * as path from 'path';
import { DataSource, DataSourceOptions, EntityManager } from 'typeorm';

import {
  buildPendingFaultCaseSnapshot,
  buildPublishedCaseDocumentContent,
  buildPublishedFaultCaseSnapshot,
  buildReturnedMaterialSnapshot,
  CONTENT_SEED_IDS,
  type SeedContentModelIdResolver,
} from './seed-mock-content-submissions';
import {
  type SeedMembership,
  type SeedOrganization,
  upsertSeedMembership,
  upsertSeedOrganization,
} from './seed-mock.organization-write';

type MysqlDataSourceOptions = Extract<DataSourceOptions, { type: 'mysql' | 'mariadb' }>;
type SeedDataSourceOptions = MysqlDataSourceOptions & { database: string };

interface MysqlConnectionConfig {
  type: 'mysql';
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  timezone?: string;
  charset?: string;
  extra?: Record<string, unknown>;
}

interface UpsertDefinition {
  table: string;
  columns: readonly string[];
  updateColumns: readonly string[];
  rows: readonly (readonly unknown[])[];
}

interface EquipmentSeed {
  modelCode: string;
  modelName: string;
  sortOrder: number;
  enabled: boolean;
}

interface MockAccount {
  id: number;
  userInfoId: number;
  loginName: string;
  loginEmail: string;
  nickname: string;
  companyName: string;
  role: 'SUPER_ADMIN' | 'ENGINEER' | 'CUSTOMER';
  phone: string;
  tags: string[];
}

interface FieldEncryptionCodec {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

const SEED_ID_MIN = 900_000;
const SEED_ID_MAX = 999_999;
const FIXED_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const EXPECTED_TABLES = [
  'base_user_account',
  'base_user_info',
  'base_async_task_record',
  'base_third_party_auth',
  'base_verification_record',
  'ai_provider_call_record',
  'ai_workflow_context',
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

const MOCK_ACCOUNTS: readonly MockAccount[] = [
  {
    id: 900_001,
    userInfoId: 901_001,
    loginName: 'mock_super_admin',
    loginEmail: 'super.admin@lithography.mock',
    nickname: '系统管理员',
    companyName: '光刻机智能支持平台',
    role: 'SUPER_ADMIN',
    phone: '13800000001',
    tags: ['平台管理', 'Mock'],
  },
  {
    id: 900_101,
    userInfoId: 901_101,
    loginName: 'mock_engineer_chen',
    loginEmail: 'engineer.chen@lithography.mock',
    nickname: '陈工',
    companyName: '光刻机智能支持平台',
    role: 'ENGINEER',
    phone: '13800000101',
    tags: ['浸没式光刻', '故障诊断', 'Mock'],
  },
  {
    id: 900_102,
    userInfoId: 901_102,
    loginName: 'mock_engineer_li',
    loginEmail: 'engineer.li@lithography.mock',
    nickname: '李工',
    companyName: '光刻机智能支持平台',
    role: 'ENGINEER',
    phone: '13800000102',
    tags: ['EUV', '设备维护', 'Mock'],
  },
  {
    id: 900_201,
    userInfoId: 901_201,
    loginName: 'mock_customer_alpha',
    loginEmail: 'customer.alpha@lithography.mock',
    nickname: '华芯设备主管',
    companyName: '华芯制造有限公司',
    role: 'CUSTOMER',
    phone: '13800000201',
    tags: ['客户', '生产一厂', 'Mock'],
  },
  {
    id: 900_202,
    userInfoId: 901_202,
    loginName: 'mock_customer_beta',
    loginEmail: 'customer.beta@lithography.mock',
    nickname: '晶圆科技值班员',
    companyName: '晶圆科技有限公司',
    role: 'CUSTOMER',
    phone: '13800000202',
    tags: ['客户', '夜班', 'Mock'],
  },
  {
    id: 900_301,
    userInfoId: 901_301,
    loginName: 'mock_admin_peer',
    loginEmail: 'admin.peer@lithography.mock',
    nickname: '同行组织管理员',
    companyName: '同行隔离测试组织',
    role: 'SUPER_ADMIN',
    phone: '13800000301',
    tags: ['同行', '隔离测试', 'Mock'],
  },
  {
    id: 900_302,
    userInfoId: 901_302,
    loginName: 'mock_engineer_peer',
    loginEmail: 'engineer.peer@lithography.mock',
    nickname: '同行工程师',
    companyName: '同行隔离测试组织',
    role: 'ENGINEER',
    phone: '13800000302',
    tags: ['同行', '隔离测试', 'Mock'],
  },
];

const EQUIPMENT_MODELS: readonly EquipmentSeed[] = [
  ['ASML-PAS-5500-100D', 'ASML PAS 5500/100D', 10],
  ['ASML-TWINSCAN-XT-860M', 'ASML TWINSCAN XT:860M', 20],
  ['ASML-TWINSCAN-XT-1460K', 'ASML TWINSCAN XT:1460K', 30],
  ['ASML-TWINSCAN-XT-1900I', 'ASML TWINSCAN XT:1900i', 40],
  ['ASML-TWINSCAN-NXT-1950I', 'ASML TWINSCAN NXT:1950i', 50],
  ['ASML-TWINSCAN-NXT-1980DI', 'ASML TWINSCAN NXT:1980Di', 60],
  ['ASML-TWINSCAN-NXT-2000I', 'ASML TWINSCAN NXT:2000i', 70],
  ['ASML-TWINSCAN-NXE-3400C', 'ASML TWINSCAN NXE:3400C', 80],
  ['ASML-TWINSCAN-NXE-3600D', 'ASML TWINSCAN NXE:3600D', 90],
  ['ASML-TWINSCAN-EXE-5000', 'ASML TWINSCAN EXE:5000', 100],
].map(([modelCode, modelName, sortOrder]) => ({
  modelCode: String(modelCode),
  modelName: String(modelName),
  sortOrder: Number(sortOrder),
  enabled: true,
}));

// 甲方默认组织（CLIENT_DEFAULT）可能已由迁移幂等建立（自增 ID 不固定）；
// Seed 仍按固定 ID 尝试登记，实际归属引用一律以按编码查询结果为准确。
const SEED_ORGANIZATIONS: readonly SeedOrganization[] = [
  {
    id: 910_001,
    organizationCode: 'CLIENT_DEFAULT',
    name: '甲方默认组织',
    kind: 'CLIENT',
    status: 'ACTIVE',
  },
  {
    id: 910_002,
    organizationCode: 'PEER_ALT',
    name: '同行隔离测试组织',
    kind: 'PEER',
    status: 'ACTIVE',
  },
];

// 客户账号不进入成员表（与管理员创建用户“客户不自动加入组织”的口径一致）；
// PEER_ALT 身份仅用于跨组织隔离验证，不参与正式资料读写。
const SEED_MEMBERSHIPS: readonly SeedMembership[] = [
  {
    id: 915_001,
    organizationCode: 'CLIENT_DEFAULT',
    accountId: 900_001,
    memberRole: 'SUPER_ADMIN',
    status: 'ACTIVE',
  },
  {
    id: 915_002,
    organizationCode: 'CLIENT_DEFAULT',
    accountId: 900_101,
    memberRole: 'ENGINEER',
    status: 'ACTIVE',
  },
  {
    id: 915_003,
    organizationCode: 'CLIENT_DEFAULT',
    accountId: 900_102,
    memberRole: 'ENGINEER',
    status: 'ACTIVE',
  },
  {
    id: 915_011,
    organizationCode: 'PEER_ALT',
    accountId: 900_301,
    memberRole: 'SUPER_ADMIN',
    status: 'ACTIVE',
  },
  {
    id: 915_012,
    organizationCode: 'PEER_ALT',
    accountId: 900_302,
    memberRole: 'ENGINEER',
    status: 'ACTIVE',
  },
];

/**
 * 投稿状态 Mock 固定主键与声明式冻结数据统一维护在
 * `./seed-mock-content-submissions`（纯数据模块，可被 Seed 契约测试安全导入；
 * 测试直接消费脚本实际声明的数据，不另手造 fixture）。
 */

/** 读取脚本环境变量；脚本入口是受控 wiring，不向业务层泄漏运行时配置。 */
function getSeedEnv(key: string): string | undefined {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  return process.env[key];
}

function loadSeedEnv(): void {
  const configuredEnvFile = getSeedEnv('SEED_DOTENV');
  const candidates = [
    configuredEnvFile ? path.resolve(process.cwd(), configuredEnvFile) : null,
    path.resolve(process.cwd(), 'env/.env.e2e'),
    path.resolve(process.cwd(), 'env/.env.development'),
  ].filter((item): item is string => item !== null);
  const envFile = candidates.find((candidate) => fs.existsSync(candidate));

  if (!envFile) {
    process.stdout.write('未找到 Seed 环境文件，使用当前进程环境变量\n');
    return;
  }

  dotenv.config({ path: envFile, quiet: true });
  process.stdout.write(`已加载 Seed 环境文件: ${envFile}\n`);
}

function buildDataSourceOptions(config: MysqlConnectionConfig): SeedDataSourceOptions {
  if (!config.username || !config.database) {
    throw new Error('数据库配置不完整，至少需要 DB_USER 和 DB_NAME');
  }

  return {
    type: 'mysql',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    timezone: config.timezone,
    charset: config.charset,
    extra: config.extra,
    entities: [],
    logging: false,
    synchronize: false,
    migrationsRun: false,
  };
}

function ensureSafeTarget(databaseName: string): void {
  if (getSeedEnv('NODE_ENV') === 'production') {
    throw new Error('Mock Data 禁止在 production 环境执行');
  }

  const lower = databaseName.toLowerCase();
  const looksSafe = ['test', 'drill', 'dev', 'local'].some((keyword) => lower.includes(keyword));
  if (!looksSafe && getSeedEnv('SEED_ALLOW_NON_TEST_DB') !== 'true') {
    throw new Error(
      `数据库名 ${databaseName} 未包含 test/drill/dev/local，已拒绝执行；确认安全后设置 SEED_ALLOW_NON_TEST_DB=true`,
    );
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`非法 SQL 标识符: ${identifier}`);
  }
  return `\`${identifier}\``;
}

async function upsertRows(manager: EntityManager, definition: UpsertDefinition): Promise<void> {
  if (definition.rows.length === 0) return;
  const width = definition.columns.length;
  if (definition.rows.some((row) => row.length !== width)) {
    throw new Error(`${definition.table} Seed 行的字段数量不一致`);
  }

  const columns = definition.columns.map(quoteIdentifier).join(', ');
  const rowPlaceholder = `(${definition.columns.map(() => '?').join(', ')})`;
  const placeholders = definition.rows.map(() => rowPlaceholder).join(', ');
  const updates = definition.updateColumns
    .map((column) => `${quoteIdentifier(column)} = VALUES(${quoteIdentifier(column)})`)
    .join(', ');
  const parameters = definition.rows.flatMap((row) => [...row]);

  await manager.query(
    `INSERT INTO ${quoteIdentifier(definition.table)} (${columns}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updates}`,
    parameters,
  );
}

/**
 * 固定主键归属预检（R4 要求 6）：重跑 Seed 前先核验固定主键的冲突归属。
 *
 * - 主键缺失（0 行）→ 放行（新插入）；
 * - 已存在行全部满足归属谓词 → 放行（属于本 Seed 的既有行）；
 * - 出现任一不满足归属谓词的行 → 抛错终止，拒绝凭主键冲突覆盖真实记录。
 */
async function assertMockOwnedOrAbsent(
  manager: EntityManager,
  guard: {
    table: string;
    idColumn: string;
    ids: readonly number[];
    /** 归属谓词：行满足该条件才视为本 Seed 拥有（脚本内字面量条件，无外部输入） */
    ownershipCondition: string;
    label: string;
  },
): Promise<void> {
  const placeholders = guard.ids.map(() => '?').join(', ');
  const result: unknown = await manager.query(
    `SELECT COUNT(*) AS total_count,
            COALESCE(SUM(CASE WHEN ${guard.ownershipCondition} THEN 1 ELSE 0 END), 0) AS owned_count
     FROM ${quoteIdentifier(guard.table)}
     WHERE ${quoteIdentifier(guard.idColumn)} IN (${placeholders})`,
    [...guard.ids],
  );
  const row = asRecordArray(result, guard.label)[0];
  if (!row) throw new Error(`${guard.label}归属预检没有返回结果`);
  const total = readNumber(row, 'total_count');
  const owned = readNumber(row, 'owned_count');
  if (total !== owned) {
    throw new Error(
      `${guard.label}固定主键已被非 Mock 记录占用（命中 ${total} 行，归属 Mock ${owned} 行），已拒绝覆盖`,
    );
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function buildFieldEncryptionCodec(): FieldEncryptionCodec {
  const keyText = getSeedEnv('FIELD_ENCRYPTION_KEY');
  const ivText = getSeedEnv('FIELD_ENCRYPTION_IV');
  if (!keyText || keyText.length < 16 || !ivText || ivText.length < 16) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY 和 FIELD_ENCRYPTION_IV 均需至少 16 个字符，且必须与 API 使用的配置一致',
    );
  }
  const key = CryptoJS.lib.WordArray.create(CryptoJS.enc.Utf8.parse(keyText).words, 16);
  const iv = CryptoJS.lib.WordArray.create(CryptoJS.enc.Utf8.parse(ivText).words, 16);
  const options = { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 };
  return {
    encrypt: (plain) => CryptoJS.AES.encrypt(plain, key, options).toString(),
    decrypt: (cipher) => CryptoJS.AES.decrypt(cipher, key, options).toString(CryptoJS.enc.Utf8),
  };
}

function asRecordArray(value: unknown, context: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'object' || item === null)) {
    throw new Error(`${context} 查询结果格式无效`);
  }
  return value as Record<string, unknown>[];
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`字段 ${key} 不是有效数字`);
  return value;
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`字段 ${key} 不是字符串`);
  return value;
}

async function assertSchemaReady(manager: EntityManager): Promise<void> {
  const placeholders = EXPECTED_TABLES.map(() => '?').join(', ');
  const result: unknown = await manager.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
    [...EXPECTED_TABLES],
  );
  const existing = new Set(
    asRecordArray(result, 'Schema').map((row) => String(row.table_name ?? row.TABLE_NAME)),
  );
  const missing = EXPECTED_TABLES.filter((table) => !existing.has(table));
  if (missing.length > 0) {
    throw new Error(`数据库尚未完成 Migration，缺少表: ${missing.join(', ')}`);
  }
}

// 大部分行是与表字段一一对应的声明式 Mock 数据，保持同表相邻便于审查。
// eslint-disable-next-line max-lines-per-function
async function seedAccounts(
  manager: EntityManager,
  password: string,
  encryption: FieldEncryptionCodec,
): Promise<void> {
  const passwordHash = AccountService.hashPasswordWithTimestamp(password, FIXED_CREATED_AT);
  await upsertRows(manager, {
    table: 'base_user_account',
    columns: [
      'id',
      'login_name',
      'login_email',
      'login_password',
      'status',
      'recent_login_history',
      'identity_hint',
      'created_at',
      'updated_at',
    ],
    // created_at 是密码哈希的时间盐（hashPasswordWithTimestamp），必须随 upsert 同步：
    // 否则旧库中 Mock 账号的 created_at 与本次写入的哈希不同源，密码校验必然失败。
    updateColumns: [
      'login_name',
      'login_email',
      'login_password',
      'status',
      'recent_login_history',
      'identity_hint',
      'created_at',
      'updated_at',
    ],
    rows: MOCK_ACCOUNTS.map((account) => [
      account.id,
      account.loginName,
      account.loginEmail,
      passwordHash,
      'ACTIVE',
      JSON.stringify([]),
      account.role,
      FIXED_CREATED_AT,
      FIXED_CREATED_AT,
    ]),
  });

  await upsertRows(manager, {
    table: 'base_user_info',
    columns: [
      'id',
      'account_id',
      'nickname',
      'company_name',
      'gender',
      'birth_date',
      'avatar_url',
      'email',
      'signature',
      'access_group',
      'address',
      'phone',
      'tags',
      'geographic',
      'meta_digest',
      'notify_count',
      'unread_count',
      'user_state',
      'created_at',
      'updated_at',
    ],
    updateColumns: [
      'nickname',
      'company_name',
      'email',
      'signature',
      'access_group',
      'address',
      'phone',
      'tags',
      'geographic',
      'meta_digest',
      'notify_count',
      'unread_count',
      'user_state',
      'updated_at',
    ],
    rows: MOCK_ACCOUNTS.map((account) => {
      const roles = [account.role];
      return [
        account.userInfoId,
        account.id,
        account.nickname,
        account.companyName,
        'SECRET',
        null,
        null,
        account.loginEmail,
        '光刻机平台开发 Mock 账号',
        JSON.stringify(roles),
        '上海市浦东新区',
        account.phone,
        JSON.stringify(account.tags),
        JSON.stringify({
          province: { label: '上海', key: '310000' },
          city: { label: '上海', key: '310100' },
        }),
        encryption.encrypt(JSON.stringify(roles)),
        account.role === 'CUSTOMER' ? 2 : 0,
        account.role === 'CUSTOMER' ? 1 : 0,
        'ACTIVE',
        FIXED_CREATED_AT,
        FIXED_CREATED_AT,
      ];
    }),
  });
}

async function seedEquipment(manager: EntityManager): Promise<Map<string, number>> {
  await upsertRows(manager, {
    table: 'equipment_model',
    columns: ['model_code', 'model_name', 'sort_order', 'enabled'],
    updateColumns: ['model_name', 'sort_order', 'enabled'],
    rows: EQUIPMENT_MODELS.map((model) => [
      model.modelCode,
      model.modelName,
      model.sortOrder,
      model.enabled,
    ]),
  });

  const placeholders = EQUIPMENT_MODELS.map(() => '?').join(', ');
  const result: unknown = await manager.query(
    `SELECT id, model_code FROM equipment_model WHERE model_code IN (${placeholders})`,
    EQUIPMENT_MODELS.map((model) => model.modelCode),
  );
  const rows = asRecordArray(result, 'equipment_model');
  const modelIds = new Map(
    rows.map((row) => [readString(row, 'model_code'), readNumber(row, 'id')] as const),
  );
  if (modelIds.size !== EQUIPMENT_MODELS.length) {
    throw new Error(`设备型号不完整：期望 ${EQUIPMENT_MODELS.length} 条，实际 ${modelIds.size} 条`);
  }
  return modelIds;
}

function requireModelId(modelIds: Map<string, number>, code: string): number {
  const id = modelIds.get(code);
  if (id === undefined) throw new Error(`找不到设备型号 ${code}`);
  return id;
}

function requireOrgId(orgIds: Map<string, number>, code: string): number {
  const id = orgIds.get(code);
  if (id === undefined) throw new Error(`找不到组织 ${code}`);
  return id;
}

/**
 * 登记甲方默认组织与同行隔离组织。
 *
 * CLIENT_DEFAULT 可能已由迁移幂等创建（自增 ID 不固定），因此固定主键归属核验
 * 与写入统一交给 `seed-mock.organization-write`：
 * - MIGRATION_BASE 按编码解析真实 ID，绝不改写其主键/名称/类别/状态；
 * - 异主固定主键或编码冲突直接抛错，由外层事务整体回滚。
 */
async function seedOrganizations(manager: EntityManager): Promise<Map<string, number>> {
  const orgIds = new Map<string, number>();
  for (const organization of SEED_ORGANIZATIONS) {
    const id = await upsertSeedOrganization(manager, organization);
    orgIds.set(organization.organizationCode, id);
  }
  return orgIds;
}

async function seedMemberships(manager: EntityManager, orgIds: Map<string, number>): Promise<void> {
  for (const membership of SEED_MEMBERSHIPS) {
    await upsertSeedMembership(manager, {
      ...membership,
      organizationId: requireOrgId(orgIds, membership.organizationCode),
    });
  }
}

// eslint-disable-next-line max-lines-per-function
async function seedBusinessTables(
  manager: EntityManager,
  modelIds: Map<string, number>,
  orgIds: Map<string, number>,
): Promise<void> {
  const requests = [
    [
      920_001,
      'MOCK-RR-2026-0001',
      900_201,
      requireModelId(modelIds, 'ASML-TWINSCAN-NXT-1980DI'),
      'E-CHUCK-101',
      '晶圆台吸附压力波动，连续三批次出现对准失败。',
      '## 故障现象\n晶圆台吸附压力波动，批次开始约 20 分钟后对准失败。',
      '2026-01-10 09:15:00.000',
      0,
      null,
      null,
      0,
      null,
    ],
    [
      920_002,
      'MOCK-RR-2026-0002',
      900_202,
      requireModelId(modelIds, 'ASML-TWINSCAN-NXE-3400C'),
      'E-LASER-207',
      '光源能量稳定性超限，曝光剂量重复性下降。',
      '## 故障现象\n光源能量稳定性报警，剂量重复性由 0.18% 上升至 0.42%。',
      '2026-01-11 14:20:00.000',
      1,
      900_101,
      '2026-01-11 14:35:00.000',
      0,
      null,
    ],
    [
      920_003,
      'MOCK-RR-2026-0003',
      900_201,
      requireModelId(modelIds, 'ASML-TWINSCAN-NXT-2000I'),
      'E-STAGE-315',
      '扫描台在高速扫描阶段出现位置跟随误差。',
      '## 故障现象\n高速扫描时 Y 方向位置误差超过阈值。',
      '2026-01-12 08:30:00.000',
      1,
      900_102,
      '2026-01-12 08:50:00.000',
      0,
      null,
    ],
    [
      920_004,
      'MOCK-RR-2026-0004',
      900_202,
      requireModelId(modelIds, 'ASML-TWINSCAN-XT-1900I'),
      'E-TEMP-044',
      '环境温度传感器偶发漂移，客户已撤回重复申请。',
      '## 故障现象\n该申请为重复提交，已由客户撤回。',
      '2026-01-13 10:00:00.000',
      0,
      null,
      null,
      1,
      '2026-01-13 10:10:00.000',
    ],
    [
      920_005,
      'MOCK-RR-2026-0005',
      900_201,
      requireModelId(modelIds, 'ASML-TWINSCAN-EXE-5000'),
      'E-OPTICS-512',
      '照明均匀性偏差，等待工程师接单。',
      '## 故障现象\n照明均匀性测量值逐步偏离基准。',
      '2026-01-14 16:45:00.000',
      0,
      null,
      null,
      0,
      null,
    ],
  ] as const;

  await upsertRows(manager, {
    table: 'repair_request',
    columns: [
      'id',
      'request_no',
      'customer_account_id',
      'equipment_model_id',
      'error_code',
      'fault_description',
      'content_md',
      'created_at',
      'is_accepted',
      'accepted_by_engineer_account_id',
      'accepted_at',
      'deprecated',
      'deleted_at',
    ],
    updateColumns: [
      'customer_account_id',
      'equipment_model_id',
      'error_code',
      'fault_description',
      'content_md',
      'is_accepted',
      'accepted_by_engineer_account_id',
      'accepted_at',
      'deprecated',
      'deleted_at',
    ],
    rows: requests,
  });

  await upsertRows(manager, {
    table: 'ai_conversation',
    columns: [
      'id',
      'request_id',
      'engineer_account_id',
      'status',
      'ai_feedback',
      'created_at',
      'completed_at',
    ],
    updateColumns: ['request_id', 'engineer_account_id', 'status', 'ai_feedback', 'completed_at'],
    rows: [
      [
        930_001,
        920_002,
        900_101,
        'COMPLETED',
        '现场检查确认能量传感器窗口有轻微污染；清洁并重新标定后，剂量重复性恢复至 0.16%。AI 建议有效。',
        '2026-01-11 15:00:00.000',
        '2026-01-11 16:10:00.000',
      ],
      [930_002, 920_003, 900_102, 'ACTIVE', null, '2026-01-12 09:05:00.000', null],
      [
        930_003,
        920_002,
        900_101,
        'COMPLETED',
        '复盘会话确认无需更换模块，保留现有标定结果并观察后续三个批次。',
        '2026-01-11 16:20:00.000',
        '2026-01-11 16:40:00.000',
      ],
    ],
  });

  await upsertRows(manager, {
    table: 'ai_message',
    columns: [
      'id',
      'conversation_id',
      'message_seq',
      'turn_no',
      'role',
      'content_text',
      'created_at',
    ],
    updateColumns: ['turn_no', 'role', 'content_text'],
    rows: [
      [
        940_001,
        930_001,
        1,
        null,
        'SYSTEM',
        '你是光刻机故障诊断助手，请基于错误码和测量数据给出排查建议。',
        '2026-01-11 15:00:00.000',
      ],
      [
        940_002,
        930_001,
        2,
        1,
        'USER',
        'NXE:3400C 报 E-LASER-207，剂量重复性升至 0.42%，先检查什么？',
        '2026-01-11 15:01:00.000',
      ],
      [
        940_003,
        930_001,
        3,
        1,
        'ASSISTANT',
        '建议先核对能量传感器窗口污染、最近一次标定时间及光源脉冲能量趋势。',
        '2026-01-11 15:01:05.000',
      ],
      [
        940_004,
        930_001,
        4,
        2,
        'USER',
        '窗口可见轻微雾状污染，标定在 28 天前完成。',
        '2026-01-11 15:08:00.000',
      ],
      [
        940_005,
        930_001,
        5,
        2,
        'ASSISTANT',
        '优先按维护规程清洁窗口，再做能量传感器零点与增益标定，并复测三个批次。',
        '2026-01-11 15:08:06.000',
      ],
      [
        940_006,
        930_002,
        1,
        null,
        'SYSTEM',
        '你是光刻机扫描台故障诊断助手。',
        '2026-01-12 09:05:00.000',
      ],
      [
        940_007,
        930_002,
        2,
        1,
        'USER',
        'NXT:2000i 高速扫描时 Y 方向位置跟随误差超限。',
        '2026-01-12 09:06:00.000',
      ],
      [
        940_008,
        930_002,
        3,
        1,
        'ASSISTANT',
        '请提供伺服误差趋势、扫描速度和最近一次导轨维护时间。',
        '2026-01-12 09:06:04.000',
      ],
      [
        940_009,
        930_002,
        4,
        null,
        'TOOL',
        '模拟监测数据：峰值误差 18 nm，扫描速度 600 mm/s。',
        '2026-01-12 09:07:00.000',
      ],
      [
        940_010,
        930_002,
        5,
        2,
        'USER',
        '降低到 500 mm/s 后峰值误差为 9 nm。',
        '2026-01-12 09:09:00.000',
      ],
      [
        940_011,
        930_002,
        6,
        2,
        'ASSISTANT',
        '初步判断与高速段伺服参数或机械阻力相关，建议先检查导轨状态并比对伺服增益参数。',
        '2026-01-12 09:09:08.000',
      ],
      [
        940_012,
        930_003,
        1,
        1,
        'USER',
        '清洁标定后连续三个批次均正常，是否还需要换能量传感器？',
        '2026-01-11 16:20:00.000',
      ],
      [
        940_013,
        930_003,
        2,
        1,
        'ASSISTANT',
        '当前证据不支持立即更换。建议记录标定结果并连续观察趋势，若再次漂移再评估传感器寿命。',
        '2026-01-11 16:20:05.000',
      ],
    ],
  });

  await upsertRows(manager, {
    table: 'ai_report',
    columns: [
      'id',
      'request_id',
      'conversation_id',
      'engineer_account_id',
      'report_title',
      'report_type',
      'content_md',
      'created_at',
    ],
    updateColumns: ['report_title', 'content_md'],
    rows: [
      [
        950_001,
        920_002,
        930_001,
        900_101,
        'E-LASER-207 故障诊断报告',
        'FAULT_DIAGNOSIS',
        '# 结论\n能量传感器窗口污染导致读数漂移。\n\n# 建议\n清洁后重新标定并观察三个批次。',
        '2026-01-11 16:12:00.000',
      ],
      [
        950_002,
        920_003,
        930_002,
        900_102,
        '扫描台位置误差阶段性分析',
        'INTERIM_ANALYSIS',
        '# 初步判断\n高速段伺服参数或机械阻力异常，等待进一步现场数据。',
        '2026-01-12 09:15:00.000',
      ],
    ],
  });

  await upsertRows(manager, {
    table: 'engineer_response',
    columns: [
      'id',
      'request_id',
      'engineer_account_id',
      'customer_account_id',
      'resolution_status',
      'response_text',
      'created_at',
    ],
    updateColumns: ['resolution_status', 'response_text'],
    rows: [
      [
        960_001,
        920_002,
        900_101,
        900_202,
        'PENDING',
        '已接单，初步建议暂停高精度批次并保留最近 24 小时能量趋势数据。',
        '2026-01-11 14:40:00.000',
      ],
      [
        960_002,
        920_002,
        900_101,
        900_202,
        'RESOLVED',
        '窗口清洁和重新标定已完成，三个验证批次结果正常，本次申请已解决。',
        '2026-01-11 16:15:00.000',
      ],
      [
        960_003,
        920_003,
        900_102,
        900_201,
        'PENDING',
        '已接单，正在比对高速与低速扫描的伺服误差数据。',
        '2026-01-12 09:00:00.000',
      ],
    ],
  });

  const clientOrgId = requireOrgId(orgIds, 'CLIENT_DEFAULT');
  const peerOrgId = requireOrgId(orgIds, 'PEER_ALT');

  await upsertRows(manager, {
    table: 'reference_document',
    columns: [
      'id',
      'title',
      'document_type',
      'equipment_model_id',
      'description',
      'original_filename',
      'mime_type',
      'content_text',
      'storage_backend',
      'storage_reference',
      'created_by_account_id',
      'owner_organization_id',
      'ingest_method',
      'source_submission_id',
      'source_revision_id',
      'equipment_model_text',
      'updated_by_account_id',
      'extension_json',
      'schema_version',
      'deprecated',
      'deleted_at',
      'created_at',
      'updated_at',
    ],
    updateColumns: [
      'title',
      'document_type',
      'equipment_model_id',
      'description',
      'original_filename',
      'mime_type',
      'content_text',
      'storage_backend',
      'storage_reference',
      'owner_organization_id',
      'ingest_method',
      'source_submission_id',
      'source_revision_id',
      'equipment_model_text',
      'updated_by_account_id',
      'extension_json',
      'schema_version',
      'deprecated',
      'deleted_at',
      'updated_at',
    ],
    rows: [
      [
        970_001,
        'NXT:1980Di 常见错误代码手册（Mock）',
        'ERROR_CODE_MANUAL',
        requireModelId(modelIds, 'ASML-TWINSCAN-NXT-1980DI'),
        '用于 AI 检索测试的模拟错误码资料。',
        'nxt-1980di-error-codes-mock.txt',
        'text/plain',
        'E-CHUCK-101：检查真空回路、密封圈与压力传感器。',
        null,
        null,
        900_001,
        clientOrgId,
        'ADMIN_DIRECT',
        null,
        null,
        null,
        null,
        null,
        1,
        0,
        null,
        '2026-01-02 10:00:00.000',
        '2026-01-02 10:00:00.000',
      ],
      [
        970_002,
        'NXE:3400C 光源维护指南（Mock）',
        'MAINTENANCE_GUIDE',
        requireModelId(modelIds, 'ASML-TWINSCAN-NXE-3400C'),
        '模拟光源维护资料，仅供开发环境使用。',
        'nxe-3400c-source-guide-mock.pdf',
        'application/pdf',
        'E-LASER-207：先检查能量传感器窗口和标定记录。',
        'LOCAL',
        'mock/reference/nxe-3400c-source-guide.pdf',
        900_101,
        clientOrgId,
        'ADMIN_DIRECT',
        null,
        null,
        null,
        null,
        null,
        1,
        0,
        null,
        '2026-01-03 10:00:00.000',
        '2026-01-03 10:00:00.000',
      ],
      [
        970_003,
        '光刻机故障诊断安全规范（Mock）',
        'SAFETY_STANDARD',
        null,
        '适用于所有设备型号的模拟安全提示。',
        'safety-standard-mock.md',
        'text/markdown',
        '执行任何现场操作前必须完成停机确认、权限核验与风险评估。',
        null,
        null,
        900_001,
        clientOrgId,
        'ADMIN_DIRECT',
        null,
        null,
        null,
        null,
        null,
        1,
        0,
        null,
        '2026-01-04 10:00:00.000',
        '2026-01-04 10:00:00.000',
      ],
      [
        970_004,
        '旧版 XT 系列检查表（已停用 Mock）',
        'CHECKLIST',
        requireModelId(modelIds, 'ASML-TWINSCAN-XT-1900I'),
        '用于验证资料软删除过滤。',
        'xt-checklist-old-mock.txt',
        'text/plain',
        '旧版检查表内容。',
        null,
        null,
        900_102,
        clientOrgId,
        'ADMIN_DIRECT',
        null,
        null,
        null,
        null,
        null,
        1,
        1,
        '2026-01-06 10:00:00.000',
        '2026-01-05 10:00:00.000',
        '2026-01-06 10:00:00.000',
      ],
      [
        970_005,
        '同行组织隔离测试资料（Mock）',
        'SAFETY_STANDARD',
        null,
        '仅属第二组织，用于验证跨组织资料不可见、不可下载。',
        'peer-isolation-mock.md',
        'text/markdown',
        '第二组织隔离内容，不得出现在甲方资料库。',
        null,
        null,
        900_301,
        peerOrgId,
        'ADMIN_DIRECT',
        null,
        null,
        null,
        null,
        null,
        1,
        0,
        null,
        '2026-01-07 10:00:00.000',
        '2026-01-07 10:00:00.000',
      ],
    ],
  });
}

/**
 * 两类投稿 × 四种状态的代表数据（R4 要求 5：S1 缺项补齐）。
 *
 * 覆盖矩阵（固定主键注释以 CONTENT_SEED_IDS 为准）：
 * - MATERIAL  + DRAFT          ：仅明细，无版本/附件/审核；
 * - MATERIAL  + RETURNED       ：冻结版本 + 附件 + 退回审核（comment 必填、不发布附件）；
 * - FAULT_CASE+ PENDING_REVIEW ：冻结版本 + 附件，无审核记录；
 * - FAULT_CASE+ PUBLISHED      ：冻结版本 + 附件 + 通过审核（publish_attachment=1）
 *   + 正式资料 970_006（ingest_method=REVIEWED_SUBMISSION，来源回链 984_004/988_003）
 *   + 正式案例明细（document_id = 970_006；字段与投稿明细 984_004 一致）。
 *
 * 幂等与非覆盖（R4 要求 6）：
 * - 插入前先做固定主键归属预检，非 Mock 占用时拒绝覆盖；
 * - ON DUPLICATE KEY UPDATE 只写主键自身（no-op）：已存在行（含人工测试改动过的
 *   冻结/发布状态）不被静默重置，缺失行补齐，不复制版本/审核/正式资料。
 *
 * 冻结快照完整性（G3/F04）：当前稿明细、送审版本 payload_snapshot、正式正文与
 * 正式案例明细全部取自 `./seed-mock-content-submissions` 的同一份构造器
 * （与真实 submit 快照同构、含可空字段），发布正文由发布链路同一格式化真源
 * `formatFaultCaseReferenceContent` 生成；四方对应关系由 Seed 契约测试与
 * assertSeedResult 的冻结快照核验共同保证。已导入的损坏 Mock 冻结数据不会被
 * 静默改动，需显式设置 SEED_REPAIR_MOCK_SNAPSHOTS=true 触发
 * repairDamagedMockFrozenData 定向修复（仅限确认的 Seed 主键行）。
 *
 * 存储引用为合法格式的 Mock 元数据（无物理文件）：附件下载未经真实文件验收；
 * 正文/案例解析对应关系由 Seed 契约测试以 publishAttachment=false 路径验证。
 */
// eslint-disable-next-line max-lines-per-function
async function seedContentSubmissions(
  manager: EntityManager,
  modelIds: Map<string, number>,
  orgIds: Map<string, number>,
): Promise<void> {
  const clientOrgId = requireOrgId(orgIds, 'CLIENT_DEFAULT');
  const ids = CONTENT_SEED_IDS;
  const resolveContentModelId: SeedContentModelIdResolver = (modelCode) =>
    requireModelId(modelIds, modelCode);
  // 三类冻结数据由声明模块唯一提供：当前稿明细、payload_snapshot、正式正文与
  // 案例明细全部取同一份值（G3/F04 同源对应）。
  const returnedMaterial = buildReturnedMaterialSnapshot();
  const pendingFaultCase = buildPendingFaultCaseSnapshot(resolveContentModelId);
  const publishedFaultCase = buildPublishedFaultCaseSnapshot(resolveContentModelId);

  // —— 固定主键归属预检（重跑幂等的前置安全门）——
  await assertMockOwnedOrAbsent(manager, {
    table: 'content_submission',
    idColumn: 'id',
    ids: [
      ids.draftSubmission,
      ids.returnedSubmission,
      ids.pendingSubmission,
      ids.publishedSubmission,
    ],
    ownershipCondition: `\`submitted_by_account_id\` IN (${900_101}, ${900_102}) AND \`owner_organization_id\` IN (SELECT \`id\` FROM \`organization\` WHERE \`organization_code\` IN ('CLIENT_DEFAULT', 'PEER_ALT'))`,
    label: '投稿主表',
  });
  await assertMockOwnedOrAbsent(manager, {
    table: 'material_submission_detail',
    idColumn: 'submission_id',
    ids: [ids.draftSubmission, ids.returnedSubmission],
    ownershipCondition: `\`submission_id\` IN (${ids.draftSubmission}, ${ids.returnedSubmission})`,
    label: '普通资料投稿明细',
  });
  await assertMockOwnedOrAbsent(manager, {
    table: 'fault_case_submission_detail',
    idColumn: 'submission_id',
    ids: [ids.pendingSubmission, ids.publishedSubmission],
    ownershipCondition: `\`submission_id\` IN (${ids.pendingSubmission}, ${ids.publishedSubmission})`,
    label: '故障案例投稿明细',
  });
  await assertMockOwnedOrAbsent(manager, {
    table: 'content_submission_attachment',
    idColumn: 'id',
    ids: [ids.attachmentReturned, ids.attachmentPending, ids.attachmentPublished],
    ownershipCondition: `\`submission_id\` IN (${ids.draftSubmission}, ${ids.returnedSubmission}, ${ids.pendingSubmission}, ${ids.publishedSubmission}) AND \`uploaded_by_account_id\` IN (${900_101}, ${900_102})`,
    label: '投稿附件',
  });
  await assertMockOwnedOrAbsent(manager, {
    table: 'content_submission_revision',
    idColumn: 'id',
    ids: [ids.revisionReturned, ids.revisionPending, ids.revisionPublished],
    ownershipCondition: `\`submission_id\` IN (${ids.returnedSubmission}, ${ids.pendingSubmission}, ${ids.publishedSubmission}) AND \`confirmed_by_account_id\` IN (${900_101}, ${900_102})`,
    label: '投稿送审版本',
  });
  await assertMockOwnedOrAbsent(manager, {
    table: 'content_submission_review',
    idColumn: 'id',
    ids: [ids.reviewReturned, ids.reviewApproved],
    ownershipCondition: `\`submission_id\` IN (${ids.returnedSubmission}, ${ids.publishedSubmission}) AND \`reviewed_by_account_id\` = ${900_001}`,
    label: '投稿审核记录',
  });
  await assertMockOwnedOrAbsent(manager, {
    table: 'reference_document',
    idColumn: 'id',
    ids: [ids.publishedDocument],
    ownershipCondition: `\`ingest_method\` = 'REVIEWED_SUBMISSION' AND \`source_submission_id\` IN (${ids.publishedSubmission}) AND \`owner_organization_id\` IN (SELECT \`id\` FROM \`organization\` WHERE \`organization_code\` IN ('CLIENT_DEFAULT', 'PEER_ALT'))`,
    label: '审核发布正式资料',
  });
  await assertMockOwnedOrAbsent(manager, {
    table: 'reference_document_case_detail',
    idColumn: 'document_id',
    ids: [ids.publishedDocument],
    ownershipCondition: `\`document_id\` = ${ids.publishedDocument}`,
    label: '正式案例明细',
  });

  // —— 已导入损坏 Mock 冻结数据的定向修复（默认关闭，仅显式开关；见函数注释）——
  await repairDamagedMockFrozenData(manager, resolveContentModelId, clientOrgId);

  // —— 投稿主表：两类 × 四状态 ——
  await upsertRows(manager, {
    table: 'content_submission',
    columns: [
      'id',
      'submission_kind',
      'owner_organization_id',
      'submitted_by_account_id',
      'status',
      'current_revision_no',
      'last_submitted_at',
      'published_at',
      'created_at',
      'updated_at',
    ],
    // no-op 更新：已存在行（含人工测试改动）不被重跑重置
    updateColumns: ['id'],
    rows: [
      [
        ids.draftSubmission,
        'MATERIAL',
        clientOrgId,
        900_101,
        'DRAFT',
        0,
        null,
        null,
        '2026-01-15 09:00:00.000',
        '2026-01-15 09:00:00.000',
      ],
      [
        ids.returnedSubmission,
        'MATERIAL',
        clientOrgId,
        900_101,
        'RETURNED',
        1,
        '2026-01-16 09:30:00.000',
        null,
        '2026-01-15 10:00:00.000',
        '2026-01-17 11:00:00.000',
      ],
      [
        ids.pendingSubmission,
        'FAULT_CASE',
        clientOrgId,
        900_102,
        'PENDING_REVIEW',
        1,
        '2026-01-18 14:00:00.000',
        null,
        '2026-01-17 15:00:00.000',
        '2026-01-18 14:00:00.000',
      ],
      [
        ids.publishedSubmission,
        'FAULT_CASE',
        clientOrgId,
        900_101,
        'PUBLISHED',
        1,
        '2026-01-20 09:00:00.000',
        '2026-01-21 09:30:00.000',
        '2026-01-19 16:00:00.000',
        '2026-01-21 09:30:00.000',
      ],
    ],
  });

  // —— 普通资料投稿明细（DRAFT / RETURNED）——
  await upsertRows(manager, {
    table: 'material_submission_detail',
    columns: [
      'submission_id',
      'title',
      'document_type',
      'equipment_model_id',
      'equipment_model_text',
      'description',
      'content_text',
      'extension_json',
      'schema_version',
      'updated_at',
    ],
    updateColumns: ['submission_id'],
    rows: [
      [
        ids.draftSubmission,
        'XT:1900i 维护要点（Mock 草稿）',
        'MAINTENANCE_GUIDE',
        requireModelId(modelIds, 'ASML-TWINSCAN-XT-1900I'),
        null,
        '尚未送审的普通资料草稿，用于开发环境草稿编辑链路。',
        '## 维护要点\n定期检查导轨润滑与温度补偿记录。',
        null,
        1,
        '2026-01-15 09:00:00.000',
      ],
      [
        ids.returnedSubmission,
        returnedMaterial.title,
        returnedMaterial.documentType,
        returnedMaterial.equipmentModelId,
        returnedMaterial.equipmentModelText,
        returnedMaterial.description,
        returnedMaterial.contentText,
        null,
        1,
        '2026-01-17 11:00:00.000',
      ],
    ],
  });

  // —— 故障案例投稿明细（PENDING_REVIEW / PUBLISHED）——
  await upsertRows(manager, {
    table: 'fault_case_submission_detail',
    columns: [
      'submission_id',
      'title',
      'equipment_model_id',
      'equipment_model_text',
      'error_code',
      'phenomenon',
      'condition_text',
      'reproduction_steps',
      'diagnosis',
      'action_taken',
      'handling_status',
      'resolution',
      'extension_json',
      'schema_version',
      'updated_at',
    ],
    updateColumns: ['submission_id'],
    rows: [
      [
        ids.pendingSubmission,
        pendingFaultCase.title,
        pendingFaultCase.equipmentModelId,
        pendingFaultCase.equipmentModelText,
        pendingFaultCase.errorCode,
        pendingFaultCase.phenomenon,
        pendingFaultCase.conditionText,
        pendingFaultCase.reproductionSteps,
        pendingFaultCase.diagnosis,
        pendingFaultCase.actionTaken,
        pendingFaultCase.handlingStatus,
        pendingFaultCase.resolution,
        null,
        1,
        '2026-01-18 14:00:00.000',
      ],
      [
        ids.publishedSubmission,
        publishedFaultCase.title,
        publishedFaultCase.equipmentModelId,
        publishedFaultCase.equipmentModelText,
        publishedFaultCase.errorCode,
        publishedFaultCase.phenomenon,
        publishedFaultCase.conditionText,
        publishedFaultCase.reproductionSteps,
        publishedFaultCase.diagnosis,
        publishedFaultCase.actionTaken,
        publishedFaultCase.handlingStatus,
        publishedFaultCase.resolution,
        null,
        1,
        '2026-01-21 09:30:00.000',
      ],
    ],
  });

  // —— 投稿私有附件（存储引用为合法格式 Mock 元数据，无物理文件）——
  await upsertRows(manager, {
    table: 'content_submission_attachment',
    columns: [
      'id',
      'submission_id',
      'original_filename',
      'mime_type',
      'byte_size',
      'storage_backend',
      'storage_reference',
      'uploaded_by_account_id',
      'status',
      'uploaded_at',
      'retired_at',
    ],
    updateColumns: ['id'],
    rows: [
      [
        ids.attachmentReturned,
        ids.returnedSubmission,
        'mock-returned-material.txt',
        'text/plain',
        1024,
        'local',
        'a1b2c3d4e5f60718293a4b5c6d7e8f90.txt',
        900_101,
        'CURRENT',
        '2026-01-16 09:20:00.000',
        null,
      ],
      [
        ids.attachmentPending,
        ids.pendingSubmission,
        'mock-case-evidence.png',
        'image/png',
        204800,
        'local',
        'b1c2d3e4f5a60718293a4b5c6d7e8f91.png',
        900_102,
        'CURRENT',
        '2026-01-18 13:50:00.000',
        null,
      ],
      [
        ids.attachmentPublished,
        ids.publishedSubmission,
        'mock-case-report.pdf',
        'application/pdf',
        512000,
        'local',
        'c1d2e3f4a5b60718293a4b5c6d7e8f92.pdf',
        900_101,
        'CURRENT',
        '2026-01-20 08:50:00.000',
        null,
      ],
    ],
  });

  // —— 送审冻结版本（含入库告知确认：notice_version + confirmed_by/at）——
  await upsertRows(manager, {
    table: 'content_submission_revision',
    columns: [
      'id',
      'submission_id',
      'revision_no',
      'payload_snapshot',
      'schema_version',
      'title_snapshot',
      'attachment_id',
      'notice_version',
      'confirmed_by_account_id',
      'confirmed_at',
      'submitted_at',
    ],
    updateColumns: ['id'],
    rows: [
      [
        ids.revisionReturned,
        ids.returnedSubmission,
        1,
        JSON.stringify(returnedMaterial),
        1,
        '安全操作补充说明（Mock 已退回）',
        ids.attachmentReturned,
        CONTENT_SUBMISSION_LIBRARY_NOTICE_VERSION,
        900_101,
        '2026-01-16 09:28:00.000',
        '2026-01-16 09:30:00.000',
      ],
      [
        ids.revisionPending,
        ids.pendingSubmission,
        1,
        JSON.stringify(pendingFaultCase),
        1,
        'NXT:1980Di 晶圆台吸附异常案例（Mock）',
        ids.attachmentPending,
        CONTENT_SUBMISSION_LIBRARY_NOTICE_VERSION,
        900_102,
        '2026-01-18 13:58:00.000',
        '2026-01-18 14:00:00.000',
      ],
      [
        ids.revisionPublished,
        ids.publishedSubmission,
        1,
        JSON.stringify(publishedFaultCase),
        1,
        'NXE:3400C 光源能量漂移故障案例（Mock）',
        ids.attachmentPublished,
        CONTENT_SUBMISSION_LIBRARY_NOTICE_VERSION,
        900_101,
        '2026-01-20 08:58:00.000',
        '2026-01-20 09:00:00.000',
      ],
    ],
  });

  // —— 审核记录（RETURN 必填 comment 且不发布附件；APPROVE 发布附件）——
  await upsertRows(manager, {
    table: 'content_submission_review',
    columns: [
      'id',
      'submission_id',
      'revision_id',
      'decision',
      'reviewed_by_account_id',
      'comment',
      'publish_attachment',
      'reviewed_at',
    ],
    updateColumns: ['id'],
    rows: [
      [
        ids.reviewReturned,
        ids.returnedSubmission,
        ids.revisionReturned,
        'RETURN',
        900_001,
        '请在正文中补充量测数据来源与三个批次复测记录后重新送审。',
        0,
        '2026-01-17 11:00:00.000',
      ],
      [
        ids.reviewApproved,
        ids.publishedSubmission,
        ids.revisionPublished,
        'APPROVE',
        900_001,
        null,
        1,
        '2026-01-21 09:30:00.000',
      ],
    ],
  });

  // —— 审核发布正式资料（REVIEWED_SUBMISSION 来源回链；存储引用为发布时新副本）——
  await upsertRows(manager, {
    table: 'reference_document',
    columns: [
      'id',
      'title',
      'document_type',
      'equipment_model_id',
      'description',
      'original_filename',
      'mime_type',
      'content_text',
      'storage_backend',
      'storage_reference',
      'created_by_account_id',
      'owner_organization_id',
      'ingest_method',
      'source_submission_id',
      'source_revision_id',
      'equipment_model_text',
      'updated_by_account_id',
      'extension_json',
      'schema_version',
      'deprecated',
      'deleted_at',
      'created_at',
      'updated_at',
    ],
    updateColumns: ['id'],
    rows: [
      [
        ids.publishedDocument,
        publishedFaultCase.title,
        'FAULT_CASE',
        publishedFaultCase.equipmentModelId,
        null,
        'mock-case-report.pdf',
        'application/pdf',
        // 正文与冻结快照同源：由发布链路同一格式化真源生成（G3/F04）
        buildPublishedCaseDocumentContent(resolveContentModelId),
        'local',
        // 发布时复制产生的新副本引用（Mock 元数据，无物理文件）
        'd1e2f3a4b5c60718293a4b5c6d7e8f93.pdf',
        900_001,
        clientOrgId,
        'REVIEWED_SUBMISSION',
        ids.publishedSubmission,
        ids.revisionPublished,
        publishedFaultCase.equipmentModelText,
        null,
        null,
        1,
        0,
        null,
        '2026-01-21 09:30:00.000',
        '2026-01-21 09:30:00.000',
      ],
    ],
  });

  // —— 正式案例明细（document_id = 970_006；字段与投稿明细 984_004 一致）——
  await upsertRows(manager, {
    table: 'reference_document_case_detail',
    columns: [
      'document_id',
      'error_code',
      'handling_status',
      'phenomenon',
      'condition_text',
      'reproduction_steps',
      'diagnosis',
      'action_taken',
      'resolution',
      'case_payload_json',
      'schema_version',
      'created_at',
      'updated_at',
    ],
    updateColumns: ['document_id'],
    rows: [
      [
        ids.publishedDocument,
        publishedFaultCase.errorCode,
        publishedFaultCase.handlingStatus,
        publishedFaultCase.phenomenon,
        publishedFaultCase.conditionText,
        publishedFaultCase.reproductionSteps,
        publishedFaultCase.diagnosis,
        publishedFaultCase.actionTaken,
        publishedFaultCase.resolution,
        null,
        1,
        '2026-01-21 09:30:00.000',
        '2026-01-21 09:30:00.000',
      ],
    ],
  });
}

// eslint-disable-next-line max-lines-per-function
async function seedInfrastructureTables(manager: EntityManager): Promise<void> {
  await upsertRows(manager, {
    table: 'base_third_party_auth',
    columns: [
      'id',
      'account_id',
      'provider',
      'provider_user_id',
      'union_id',
      'access_token',
      'created_at',
      'updated_at',
    ],
    updateColumns: ['account_id', 'union_id', 'access_token', 'updated_at'],
    rows: [
      [
        980_001,
        900_201,
        'WEAPP',
        'mock-weapp-openid-customer-alpha',
        'mock-weapp-union-customer-alpha',
        null,
        FIXED_CREATED_AT,
        FIXED_CREATED_AT,
      ],
      [
        980_002,
        900_101,
        'GITHUB',
        'mock-github-engineer-chen',
        null,
        null,
        FIXED_CREATED_AT,
        FIXED_CREATED_AT,
      ],
    ],
  });

  await upsertRows(manager, {
    table: 'base_verification_record',
    columns: [
      'id',
      'type',
      'token_fp',
      'status',
      'expires_at',
      'not_before',
      'target_account_id',
      'subject_type',
      'subject_id',
      'payload',
      'issued_by_account_id',
      'consumed_by_account_id',
      'consumed_at',
      'created_at',
      'updated_at',
    ],
    updateColumns: [
      'status',
      'expires_at',
      'payload',
      'consumed_by_account_id',
      'consumed_at',
      'updated_at',
    ],
    rows: [
      [
        981_001,
        'EMAIL_VERIFY_LINK',
        sha256('mock-email-verification-consumed'),
        'CONSUMED',
        '2026-01-02 00:00:00',
        '2026-01-01 08:00:00',
        900_201,
        'ACCOUNT',
        900_201,
        JSON.stringify({ email: 'customer.alpha@lithography.mock', mock: true }),
        900_001,
        900_201,
        '2026-01-01 09:00:00.000',
        FIXED_CREATED_AT,
        FIXED_CREATED_AT,
      ],
      [
        981_002,
        'PASSWORD_RESET',
        sha256('mock-password-reset-expired'),
        'EXPIRED',
        '2026-01-02 00:00:00',
        null,
        900_202,
        'ACCOUNT',
        900_202,
        JSON.stringify({ mock: true }),
        900_001,
        null,
        null,
        FIXED_CREATED_AT,
        FIXED_CREATED_AT,
      ],
    ],
  });

  await upsertRows(manager, {
    table: 'base_async_task_record',
    columns: [
      'id',
      'queue_name',
      'job_name',
      'job_id',
      'trace_id',
      'actor_account_id',
      'actor_active_role',
      'biz_type',
      'biz_key',
      'biz_sub_key',
      'source',
      'reason',
      'occurred_at',
      'dedup_key',
      'status',
      'attempt_count',
      'max_attempts',
      'enqueued_at',
      'started_at',
      'finished_at',
      'created_at',
      'updated_at',
    ],
    updateColumns: ['status', 'attempt_count', 'started_at', 'finished_at', 'updated_at'],
    rows: [
      [
        982_001,
        'ai-diagnosis',
        'generate-diagnosis',
        'mock-ai-job-001',
        'mock-trace-ai-001',
        900_101,
        'ENGINEER',
        'repair_request',
        '920002',
        '930001',
        'user_action',
        'AI_FAULT_DIAGNOSIS',
        '2026-01-11 15:00:00.000',
        'mock:diagnosis:930001',
        'succeeded',
        1,
        3,
        '2026-01-11 15:00:01.000',
        '2026-01-11 15:00:02.000',
        '2026-01-11 15:00:08.000',
        '2026-01-11 15:00:01.000',
        '2026-01-11 15:00:08.000',
      ],
      [
        982_002,
        'ai-diagnosis',
        'generate-diagnosis',
        'mock-ai-job-002',
        'mock-trace-ai-002',
        900_102,
        'ENGINEER',
        'repair_request',
        '920003',
        '930002',
        'user_action',
        'AI_FAULT_DIAGNOSIS',
        '2026-01-12 09:05:00.000',
        'mock:diagnosis:930002',
        'processing',
        1,
        3,
        '2026-01-12 09:05:01.000',
        '2026-01-12 09:05:02.000',
        null,
        '2026-01-12 09:05:01.000',
        '2026-01-12 09:05:02.000',
      ],
    ],
  });

  await upsertRows(manager, {
    table: 'ai_provider_call_record',
    columns: [
      'id',
      'async_task_record_id',
      'trace_id',
      'call_seq',
      'account_id',
      'nickname_snapshot',
      'biz_type',
      'biz_key',
      'biz_sub_key',
      'source',
      'provider',
      'model',
      'task_type',
      'provider_request_id',
      'provider_status',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'cost_amount',
      'cost_currency',
      'normalized_error_code',
      'provider_error_code',
      'error_message',
      'provider_started_at',
      'provider_finished_at',
      'provider_latency_ms',
      'created_at',
      'updated_at',
    ],
    updateColumns: [
      'provider_status',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'cost_amount',
      'cost_currency',
      'normalized_error_code',
      'provider_error_code',
      'error_message',
      'provider_finished_at',
      'provider_latency_ms',
      'updated_at',
    ],
    rows: [
      [
        983_001,
        982_001,
        'mock-trace-ai-001',
        1,
        900_101,
        '陈工',
        'repair_request',
        '920002',
        '930001',
        'user_action',
        'mock',
        'lithography-diagnosis-mock',
        'generate',
        'mock-provider-request-001',
        'succeeded',
        580,
        210,
        790,
        '0.00000000',
        'CNY',
        null,
        null,
        null,
        '2026-01-11 15:00:02.000',
        '2026-01-11 15:00:08.000',
        6000,
        '2026-01-11 15:00:02.000',
        '2026-01-11 15:00:08.000',
      ],
      [
        983_002,
        982_002,
        'mock-trace-ai-002',
        1,
        900_102,
        '李工',
        'repair_request',
        '920003',
        '930002',
        'user_action',
        'mock',
        'lithography-diagnosis-mock',
        'generate',
        'mock-provider-request-002',
        'succeeded',
        430,
        165,
        595,
        '0.00000000',
        'CNY',
        null,
        null,
        null,
        '2026-01-12 09:05:02.000',
        '2026-01-12 09:05:07.000',
        5000,
        '2026-01-12 09:05:02.000',
        '2026-01-12 09:05:07.000',
      ],
      [
        983_003,
        null,
        'mock-trace-ai-003',
        1,
        900_101,
        '陈工',
        'reference_document',
        '970002',
        null,
        'admin_action',
        'mock',
        'lithography-embedding-mock',
        'embed',
        'mock-provider-request-003',
        'failed',
        null,
        null,
        null,
        null,
        null,
        'MOCK_PROVIDER_TIMEOUT',
        'TIMEOUT',
        '模拟超时，用于错误状态页面测试',
        '2026-01-03 11:00:00.000',
        '2026-01-03 11:00:30.000',
        30000,
        '2026-01-03 11:00:00.000',
        '2026-01-03 11:00:30.000',
      ],
    ],
  });

  await upsertRows(manager, {
    table: 'ai_workflow_context',
    columns: [
      'workflow_id',
      'workflow_type',
      'workflow_dedup_hash',
      'workflow_dedup_active_hash',
      'trace_id',
      'queue_name',
      'job_name',
      'job_id',
      'async_task_record_id',
      'biz_type',
      'biz_key',
      'biz_sub_key',
      'source',
      'actor_account_id',
      'actor_active_role',
      'provider',
      'model',
      'status',
      'input_payload_json',
      'output_payload_json',
      'admission_attempt_count',
      'next_enqueue_at',
      'admission_expires_at',
      'admission_reason',
      'error_code',
      'error_message',
      'created_at',
      'updated_at',
    ],
    updateColumns: [
      'async_task_record_id',
      'status',
      'output_payload_json',
      'admission_attempt_count',
      'next_enqueue_at',
      'admission_expires_at',
      'admission_reason',
      'error_code',
      'error_message',
      'updated_at',
    ],
    rows: [
      [
        '00000000-0000-4000-8000-000000000001',
        'FAULT_DIAGNOSIS',
        sha256('mock:diagnosis:930001'),
        null,
        'mock-trace-ai-001',
        'ai-diagnosis',
        'generate-diagnosis',
        'mock-ai-job-001',
        982_001,
        'repair_request',
        '920002',
        '930001',
        'user_action',
        900_101,
        'ENGINEER',
        'mock',
        'lithography-diagnosis-mock',
        'SUCCEEDED',
        JSON.stringify({ conversationId: 930001, mock: true }),
        JSON.stringify({ reportId: 950001, mock: true }),
        1,
        null,
        null,
        null,
        null,
        null,
        '2026-01-11 15:00:00.000',
        '2026-01-11 15:00:08.000',
      ],
      [
        '00000000-0000-4000-8000-000000000002',
        'FAULT_DIAGNOSIS',
        sha256('mock:diagnosis:930002'),
        sha256('mock:diagnosis:930002'),
        'mock-trace-ai-002',
        'ai-diagnosis',
        'generate-diagnosis',
        'mock-ai-job-002',
        982_002,
        'repair_request',
        '920003',
        '930002',
        'user_action',
        900_102,
        'ENGINEER',
        'mock',
        'lithography-diagnosis-mock',
        'PROCESSING',
        JSON.stringify({ conversationId: 930002, mock: true }),
        null,
        1,
        null,
        '2026-01-12 10:05:00.000',
        null,
        null,
        null,
        '2026-01-12 09:05:00.000',
        '2026-01-12 09:05:02.000',
      ],
    ],
  });
}

/**
 * 键序无关的 JSON 规范化（G3/F04）：MySQL JSON 列读取后键序会被规范化
 * （按长度 + 字典序重排），直接 stringify 对比会误报差异、破坏修复幂等性。
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 读取 payload_snapshot 列（对象或 JSON 字符串均可）；非法内容抛错而非静默跳过 */
function parseSnapshotColumn(raw: unknown, label: string): Record<string, unknown> {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${label}：payload_snapshot 不是合法 JSON`);
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label}：payload_snapshot 不是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

/** 校验失败消息中的短预览（换行转义、超长截断），保证失败可读且不淹没日志 */
function previewValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
  const singleLine = text.replace(/\n/gu, '\\n');
  return singleLine.length > 90 ? `${singleLine.slice(0, 90)}…` : singleLine;
}

/** 快照可空字符串字段读取（缺失/undefined 归一为 null；类型非法抛错） */
function readSnapshotString(
  snapshot: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = snapshot[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`${label}：字段 ${key} 类型非法（期望字符串或 null）`);
  }
  return value;
}

/** 快照必填字符串字段读取（送审必填口径：title/phenomenon/reproductionSteps） */
function readSnapshotRequiredString(
  snapshot: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = readSnapshotString(snapshot, key, label);
  if (value === null || value.length === 0) throw new Error(`${label}：必填字段 ${key} 缺失`);
  return value;
}

/** 快照处理状态读取（值域与发布解析同口径） */
function readSnapshotHandlingStatus(
  snapshot: Record<string, unknown>,
  label: string,
): ContentSubmissionHandlingStatus {
  const value = snapshot.handlingStatus;
  if (value === 'UNRESOLVED' || value === 'IN_PROGRESS' || value === 'RESOLVED') return value;
  throw new Error(`${label}：handlingStatus 缺失或超出值域`);
}

/** 由冻结快照字段构造发布链路正文输入（与 approve 解析同口径，用于正文复现核验） */
function toFaultCaseContentInput(
  snapshot: Record<string, unknown>,
  label: string,
): FaultCaseReferenceContentInput {
  return {
    errorCode: readSnapshotString(snapshot, 'errorCode', label),
    phenomenon: readSnapshotRequiredString(snapshot, 'phenomenon', label),
    conditionText: readSnapshotString(snapshot, 'conditionText', label),
    reproductionSteps: readSnapshotRequiredString(snapshot, 'reproductionSteps', label),
    diagnosis: readSnapshotString(snapshot, 'diagnosis', label),
    actionTaken: readSnapshotString(snapshot, 'actionTaken', label),
    handlingStatus: readSnapshotHandlingStatus(snapshot, label),
    resolution: readSnapshotString(snapshot, 'resolution', label),
  };
}

/** 读取 UPDATE 影响行数（mysql2 返回 ResultSetHeader；结构异常时抛错而非默认 0） */
function readAffectedRows(result: unknown): number {
  if (result !== null && typeof result === 'object' && 'affectedRows' in result) {
    const affected = result.affectedRows;
    if (typeof affected === 'number') return affected;
  }
  throw new Error('无法读取 SQL 影响行数（结果结构异常）');
}

/** 快照字段 → 库内列对照表（[快照键, 列名]；只比对业务字段，不含 schema_version 等落库元数据） */
type SnapshotFieldMap = readonly (readonly [string, string])[];
const MATERIAL_DETAIL_FIELD_MAP: SnapshotFieldMap = [
  ['title', 'title'],
  ['documentType', 'document_type'],
  ['equipmentModelId', 'equipment_model_id'],
  ['equipmentModelText', 'equipment_model_text'],
  ['description', 'description'],
  ['contentText', 'content_text'],
];
const FAULT_CASE_DETAIL_FIELD_MAP: SnapshotFieldMap = [
  ['title', 'title'],
  ['equipmentModelId', 'equipment_model_id'],
  ['equipmentModelText', 'equipment_model_text'],
  ['errorCode', 'error_code'],
  ['phenomenon', 'phenomenon'],
  ['conditionText', 'condition_text'],
  ['reproductionSteps', 'reproduction_steps'],
  ['diagnosis', 'diagnosis'],
  ['actionTaken', 'action_taken'],
  ['handlingStatus', 'handling_status'],
  ['resolution', 'resolution'],
];
const CASE_DETAIL_FIELD_MAP: SnapshotFieldMap = [
  ['errorCode', 'error_code'],
  ['handlingStatus', 'handling_status'],
  ['phenomenon', 'phenomenon'],
  ['conditionText', 'condition_text'],
  ['reproductionSteps', 'reproduction_steps'],
  ['diagnosis', 'diagnosis'],
  ['actionTaken', 'action_taken'],
  ['resolution', 'resolution'],
];
const DOCUMENT_FIELD_MAP: SnapshotFieldMap = [
  ['title', 'title'],
  ['equipmentModelId', 'equipment_model_id'],
  ['equipmentModelText', 'equipment_model_text'],
];

/** 逐字段对照冻结快照与库内行；返回失败条目（空数组表示一致） */
function collectColumnMismatches(
  prefix: string,
  snapshot: Record<string, unknown> | null,
  row: Record<string, unknown> | null,
  fieldMap: SnapshotFieldMap,
): string[] {
  if (!snapshot) return [`${prefix}：冻结快照不可用，无法对照`];
  if (!row) return [`${prefix}：对应数据行不存在`];
  const mismatches: string[] = [];
  for (const [snapshotKey, column] of fieldMap) {
    const expected = snapshot[snapshotKey] ?? null;
    const actual = row[column] ?? null;
    if (expected !== actual) {
      mismatches.push(
        `${prefix}：${snapshotKey} 快照值 ${previewValue(expected)} ≠ 库内 ${column} 列 ${previewValue(actual)}`,
      );
    }
  }
  return mismatches;
}

/** 读取单行 Seed 数据（不存在时返回 null，由调用方决定是否记为失败） */
async function readSingleSeedRow(
  manager: EntityManager,
  sql: string,
  params: readonly unknown[],
  label: string,
): Promise<Record<string, unknown> | null> {
  const result: unknown = await manager.query(sql, params);
  return asRecordArray(result, label)[0] ?? null;
}

/**
 * 核验三个冻结版本自身：行存在、payload_snapshot 可解析且与声明构造器一致
 * （键序无关比较）、title_snapshot 与快照 title 对应。
 */
async function collectRevisionSnapshotProblems(
  manager: EntityManager,
  expectedSnapshots: readonly (readonly [number, Record<string, unknown>])[],
): Promise<{ problems: string[]; snapshots: Map<number, Record<string, unknown>> }> {
  const problems: string[] = [];
  const snapshots = new Map<number, Record<string, unknown>>();
  const revisionResult: unknown = await manager.query(
    'SELECT id, title_snapshot, payload_snapshot FROM content_submission_revision WHERE id IN (?, ?, ?)',
    expectedSnapshots.map(([revisionId]) => revisionId),
  );
  const revisionRows = new Map(
    asRecordArray(revisionResult, 'Seed 冻结版本快照').map(
      (row) => [readNumber(row, 'id'), row] as const,
    ),
  );
  for (const [revisionId, expectedSnapshot] of expectedSnapshots) {
    const row = revisionRows.get(revisionId);
    if (!row) {
      problems.push(`冻结版本 ${revisionId} 不存在`);
      continue;
    }
    let actual: Record<string, unknown> | null = null;
    try {
      actual = parseSnapshotColumn(row.payload_snapshot, `冻结版本 ${revisionId}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `冻结版本 ${revisionId} 快照不可解析`);
    }
    if (!actual) continue;
    snapshots.set(revisionId, actual);
    if (canonicalJson(actual) !== canonicalJson(expectedSnapshot)) {
      problems.push(`冻结版本 ${revisionId} payload_snapshot 与声明构造器不一致（结构或取值漂移）`);
    }
    if (row.title_snapshot !== expectedSnapshot.title) {
      problems.push(
        `冻结版本 ${revisionId} title_snapshot 与快照 title 不一致：${previewValue(row.title_snapshot)} ≠ ${previewValue(expectedSnapshot.title)}`,
      );
    }
  }
  return { problems, snapshots };
}

/**
 * 冻结快照对应关系核验（G3/F04）：送审版本 payload_snapshot 以真实 submit 结构为准
 * 且与声明构造器完全一致，并与当前稿明细、正式资料（正文 + 结构字段）、正式案例
 * 明细四方互证；正文必须能由冻结字段经发布链路同一格式化真源重新生成。
 * 失败时给出仅限确认 Seed 主键行的修复指引（SEED_REPAIR_MOCK_SNAPSHOTS=true）。
 */
// eslint-disable-next-line max-lines-per-function
async function assertFrozenSnapshotCorrespondence(
  manager: EntityManager,
  resolveContentModelId: SeedContentModelIdResolver,
): Promise<void> {
  const seedIds = CONTENT_SEED_IDS;
  // 1) 冻结版本自身：与声明构造器一致 + title_snapshot 与快照 title 一致
  const expectedSnapshots: readonly (readonly [number, Record<string, unknown>])[] = [
    [seedIds.revisionReturned, buildReturnedMaterialSnapshot()],
    [seedIds.revisionPending, buildPendingFaultCaseSnapshot(resolveContentModelId)],
    [seedIds.revisionPublished, buildPublishedFaultCaseSnapshot(resolveContentModelId)],
  ];
  const { problems, snapshots } = await collectRevisionSnapshotProblems(manager, expectedSnapshots);

  // 2) 冻结快照 ↔ 当前稿明细（普通资料退回稿 / 故障案例待审稿 / 已发布稿）
  const materialDetailRow = await readSingleSeedRow(
    manager,
    'SELECT title, document_type, equipment_model_id, equipment_model_text, description, content_text FROM material_submission_detail WHERE submission_id = ?',
    [seedIds.returnedSubmission],
    '普通资料退回稿明细',
  );
  problems.push(
    ...collectColumnMismatches(
      '退回稿快照↔明细',
      snapshots.get(seedIds.revisionReturned) ?? null,
      materialDetailRow,
      MATERIAL_DETAIL_FIELD_MAP,
    ),
  );
  const faultCaseColumns =
    'title, equipment_model_id, equipment_model_text, error_code, phenomenon, condition_text, reproduction_steps, diagnosis, action_taken, handling_status, resolution';
  const pendingDetailRow = await readSingleSeedRow(
    manager,
    `SELECT ${faultCaseColumns} FROM fault_case_submission_detail WHERE submission_id = ?`,
    [seedIds.pendingSubmission],
    '故障案例待审稿明细',
  );
  problems.push(
    ...collectColumnMismatches(
      '待审案例快照↔明细',
      snapshots.get(seedIds.revisionPending) ?? null,
      pendingDetailRow,
      FAULT_CASE_DETAIL_FIELD_MAP,
    ),
  );
  const publishedDetailRow = await readSingleSeedRow(
    manager,
    `SELECT ${faultCaseColumns} FROM fault_case_submission_detail WHERE submission_id = ?`,
    [seedIds.publishedSubmission],
    '故障案例已发布稿明细',
  );
  const publishedSnapshot = snapshots.get(seedIds.revisionPublished) ?? null;
  problems.push(
    ...collectColumnMismatches(
      '已发布案例快照↔明细',
      publishedSnapshot,
      publishedDetailRow,
      FAULT_CASE_DETAIL_FIELD_MAP,
    ),
  );

  // 3) 冻结快照 ↔ 正式资料（结构字段 + 正文可复现）
  const documentRow = await readSingleSeedRow(
    manager,
    'SELECT title, equipment_model_id, equipment_model_text, content_text FROM reference_document WHERE id = ?',
    [seedIds.publishedDocument],
    'Seed 正式资料',
  );
  problems.push(
    ...collectColumnMismatches(
      '已发布案例快照↔正式资料',
      publishedSnapshot,
      documentRow,
      DOCUMENT_FIELD_MAP,
    ),
  );
  if (publishedSnapshot && documentRow) {
    try {
      const expectedContent = formatFaultCaseReferenceContent(
        toFaultCaseContentInput(publishedSnapshot, '已发布案例冻结版本'),
      );
      if (documentRow.content_text !== expectedContent) {
        problems.push(
          `正式资料 970_006 正文无法由冻结快照重新生成：库内 ${previewValue(documentRow.content_text)} ≠ 期望 ${previewValue(expectedContent)}`,
        );
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : '正式正文复现校验失败');
    }
  }

  // 4) 冻结快照 ↔ 正式案例明细
  const caseDetailRow = await readSingleSeedRow(
    manager,
    'SELECT error_code, handling_status, phenomenon, condition_text, reproduction_steps, diagnosis, action_taken, resolution FROM reference_document_case_detail WHERE document_id = ?',
    [seedIds.publishedDocument],
    'Seed 正式案例明细',
  );
  problems.push(
    ...collectColumnMismatches(
      '已发布案例快照↔正式案例明细',
      publishedSnapshot,
      caseDetailRow,
      CASE_DETAIL_FIELD_MAP,
    ),
  );

  if (problems.length > 0) {
    const shown = problems
      .slice(0, 8)
      .map((problem) => `- ${problem}`)
      .join('\n');
    const more = problems.length > 8 ? `\n  （其余 ${problems.length - 8} 条省略）` : '';
    throw new Error(
      `Seed 冻结快照对应关系校验失败（${problems.length} 项）：\n${shown}${more}\n` +
        '如确认是历史导入的损坏 Mock 数据：可运行 SEED_REPAIR_MOCK_SNAPSHOTS=true npm run seed:mock ' +
        '定向修复 984_002/984_003/984_004 对应冻结快照与 970_006 正文（仅限确认的 Seed 主键行，不触碰非 Mock 数据）。',
    );
  }
}

/**
 * 已导入损坏 Mock 冻结数据的定向修复（G3/F04，默认关闭）。
 *
 * 背景：旧版本 Seed 落库的 payload_snapshot 缺 reproductionSteps/handlingStatus
 * 等必填字段，发布解析会拒绝；重跑 Seed 因 no-op 策略不会静默重置已存在行。
 * 仅当显式设置 SEED_REPAIR_MOCK_SNAPSHOTS=true 时执行：
 * - 只修固定主键 988_001/988_002/988_003 三个版本的 payload_snapshot；
 * - UPDATE WHERE 内再次核验 submission_id 与确认人归属（防误改非 Mock 行），
 *   且要求恰好影响 1 行，否则中止；
 * - 仅当库内值与声明构造器（键序无关比较）不同才更新，保证重复运行幂等；
 * - 正文修复同时核验 ingest_method='REVIEWED_SUBMISSION' + 来源回链 + 归属。
 */
// eslint-disable-next-line max-lines-per-function
async function repairDamagedMockFrozenData(
  manager: EntityManager,
  resolveContentModelId: SeedContentModelIdResolver,
  clientOrgId: number,
): Promise<void> {
  if (getSeedEnv('SEED_REPAIR_MOCK_SNAPSHOTS') !== 'true') return;

  const seedIds = CONTENT_SEED_IDS;
  const targets: readonly {
    revisionId: number;
    submissionId: number;
    label: string;
    snapshot: object;
  }[] = [
    {
      revisionId: seedIds.revisionReturned,
      submissionId: seedIds.returnedSubmission,
      label: '普通资料退回稿冻结版本',
      snapshot: buildReturnedMaterialSnapshot(),
    },
    {
      revisionId: seedIds.revisionPending,
      submissionId: seedIds.pendingSubmission,
      label: '故障案例待审冻结版本',
      snapshot: buildPendingFaultCaseSnapshot(resolveContentModelId),
    },
    {
      revisionId: seedIds.revisionPublished,
      submissionId: seedIds.publishedSubmission,
      label: '故障案例已发布冻结版本',
      snapshot: buildPublishedFaultCaseSnapshot(resolveContentModelId),
    },
  ];

  const repaired: string[] = [];
  const consistent: string[] = [];
  const absent: string[] = [];
  for (const target of targets) {
    const row = await readSingleSeedRow(
      manager,
      'SELECT payload_snapshot FROM content_submission_revision WHERE id = ? AND submission_id = ?',
      [target.revisionId, target.submissionId],
      target.label,
    );
    if (!row) {
      absent.push(`${target.label}（尚不存在，本次导入将按新结构创建）`);
      continue;
    }
    const existing = parseSnapshotColumn(row.payload_snapshot, target.label);
    if (canonicalJson(existing) === canonicalJson(target.snapshot)) {
      consistent.push(target.label);
      continue;
    }
    const updateResult: unknown = await manager.query(
      'UPDATE content_submission_revision SET payload_snapshot = ? WHERE id = ? AND submission_id = ? AND confirmed_by_account_id IN (?, ?)',
      [JSON.stringify(target.snapshot), target.revisionId, target.submissionId, 900_101, 900_102],
    );
    if (readAffectedRows(updateResult) !== 1) {
      throw new Error(
        `${target.label} 定向修复未命中预期行：为避免误改非 Mock 冻结历史已中止，请人工核对固定主键归属`,
      );
    }
    repaired.push(target.label);
  }

  // 已发布正式资料正文修复（仅当来源回链与归属均为 Mock 时；文本列直接比较）
  const expectedContent = buildPublishedCaseDocumentContent(resolveContentModelId);
  const documentRow = await readSingleSeedRow(
    manager,
    `SELECT content_text FROM reference_document
      WHERE id = ? AND ingest_method = 'REVIEWED_SUBMISSION'
        AND source_submission_id = ? AND source_revision_id = ?
        AND created_by_account_id = ? AND owner_organization_id = ?`,
    [
      seedIds.publishedDocument,
      seedIds.publishedSubmission,
      seedIds.revisionPublished,
      900_001,
      clientOrgId,
    ],
    'Seed 正式资料',
  );
  if (!documentRow) {
    absent.push('正式资料 970_006 正文（尚不存在，本次导入将按新结构创建）');
  } else if (documentRow.content_text === expectedContent) {
    consistent.push('正式资料 970_006 正文');
  } else {
    const updateResult: unknown = await manager.query(
      `UPDATE reference_document SET content_text = ?
        WHERE id = ? AND ingest_method = 'REVIEWED_SUBMISSION'
          AND source_submission_id = ? AND source_revision_id = ?
          AND created_by_account_id = ? AND owner_organization_id = ?`,
      [
        expectedContent,
        seedIds.publishedDocument,
        seedIds.publishedSubmission,
        seedIds.revisionPublished,
        900_001,
        clientOrgId,
      ],
    );
    if (readAffectedRows(updateResult) !== 1) {
      throw new Error('正式资料 970_006 正文定向修复未命中预期行：已中止，请人工核对归属');
    }
    repaired.push('正式资料 970_006 正文');
  }

  process.stdout.write(
    `[修复] SEED_REPAIR_MOCK_SNAPSHOTS=true 定向修复完成：修复 ${repaired.length} 项` +
      `${repaired.length > 0 ? `（${repaired.join('、')}）` : ''}；` +
      `已一致 ${consistent.length} 项；尚不存在 ${absent.length} 项` +
      `${absent.length > 0 ? `（${absent.join('、')}）` : ''}\n`,
  );
}

// 校验段逐块独立（数量→链路→成员→密码→加密字段→冻结快照对应关系），顺序即失败优先级。
// eslint-disable-next-line max-lines-per-function
async function assertSeedResult(
  manager: EntityManager,
  password: string,
  encryption: FieldEncryptionCodec,
  resolveContentModelId: SeedContentModelIdResolver,
): Promise<void> {
  const result: unknown = await manager.query(
    `SELECT
       (SELECT COUNT(*) FROM base_user_account WHERE id BETWEEN ? AND ?) AS accounts,
       (SELECT COUNT(*) FROM base_user_info WHERE id BETWEEN ? AND ?) AS user_infos,
       (SELECT COUNT(*) FROM repair_request WHERE id BETWEEN ? AND ?) AS repair_requests,
       (SELECT COUNT(*) FROM ai_conversation WHERE id BETWEEN ? AND ?) AS conversations,
       (SELECT COUNT(*) FROM ai_message WHERE id BETWEEN ? AND ?) AS messages,
       (SELECT COUNT(*) FROM ai_report WHERE id BETWEEN ? AND ?) AS reports,
       (SELECT COUNT(*) FROM engineer_response WHERE id BETWEEN ? AND ?) AS responses,
       (SELECT COUNT(*) FROM reference_document WHERE id BETWEEN ? AND ?) AS documents,
       (SELECT COUNT(*) FROM base_third_party_auth WHERE id BETWEEN ? AND ?) AS third_party_auth,
       (SELECT COUNT(*) FROM base_verification_record WHERE id BETWEEN ? AND ?) AS verification_records,
       (SELECT COUNT(*) FROM base_async_task_record WHERE id BETWEEN ? AND ?) AS async_tasks,
       (SELECT COUNT(*) FROM ai_provider_call_record WHERE id BETWEEN ? AND ?) AS provider_calls,
       (SELECT COUNT(*) FROM ai_workflow_context WHERE workflow_id LIKE '00000000-0000-4000-8000-00000000000%') AS workflows,
       (SELECT COUNT(*) FROM organization WHERE organization_code IN ('CLIENT_DEFAULT', 'PEER_ALT')) AS organizations,
       (SELECT COUNT(*) FROM organization_membership WHERE id BETWEEN ? AND ?) AS memberships,
       (SELECT COUNT(*) FROM content_submission WHERE id BETWEEN ? AND ?) AS content_submissions,
       (SELECT COUNT(*) FROM material_submission_detail WHERE submission_id BETWEEN ? AND ?) AS material_details,
       (SELECT COUNT(*) FROM fault_case_submission_detail WHERE submission_id BETWEEN ? AND ?) AS fault_case_details,
       (SELECT COUNT(*) FROM content_submission_attachment WHERE id BETWEEN ? AND ?) AS attachments,
       (SELECT COUNT(*) FROM content_submission_revision WHERE id BETWEEN ? AND ?) AS revisions,
       (SELECT COUNT(*) FROM content_submission_review WHERE id BETWEEN ? AND ?) AS reviews,
       (SELECT COUNT(*) FROM reference_document_case_detail WHERE document_id BETWEEN ? AND ?) AS case_details`,
    Array.from({ length: 20 }, () => [SEED_ID_MIN, SEED_ID_MAX]).flat(),
  );
  const row = asRecordArray(result, 'Seed 汇总')[0];
  if (!row) throw new Error('Seed 汇总查询没有返回结果');
  const expected: Record<string, number> = {
    accounts: 7,
    user_infos: 7,
    repair_requests: 5,
    conversations: 3,
    messages: 13,
    reports: 2,
    responses: 3,
    documents: 6,
    third_party_auth: 2,
    verification_records: 2,
    async_tasks: 2,
    provider_calls: 3,
    workflows: 2,
    organizations: 2,
    memberships: 5,
    content_submissions: 4,
    material_details: 2,
    fault_case_details: 2,
    attachments: 3,
    revisions: 3,
    reviews: 2,
    case_details: 1,
  };
  const mismatches = Object.entries(expected)
    .filter(([key, count]) => readNumber(row, key) !== count)
    .map(([key, count]) => `${key}: 期望 ${count}，实际 ${readNumber(row, key)}`);
  if (mismatches.length > 0) throw new Error(`Seed 数量校验失败：${mismatches.join('；')}`);

  // 数量正确不代表关系正确（R4 要求 5）：投稿→送审版本→审核→发布来源→
  // 正式案例明细的链路一致性单独交叉核验（期望值全部为确定值）。
  const seedIds = CONTENT_SEED_IDS;
  const flowResult: unknown = await manager.query(
    `SELECT
       (SELECT COUNT(*) FROM content_submission
         WHERE id = ? AND status = 'PUBLISHED' AND published_at IS NOT NULL) AS published_flags,
       (SELECT COUNT(*) FROM content_submission_review
         WHERE id = ? AND decision = 'APPROVE' AND publish_attachment = 1) AS approve_reviews,
       (SELECT COUNT(*) FROM reference_document
         WHERE id = ? AND ingest_method = 'REVIEWED_SUBMISSION'
           AND source_submission_id = ? AND source_revision_id = ?
           AND deprecated = 0 AND deleted_at IS NULL) AS published_sources,
       (SELECT COUNT(*) FROM content_submission_revision
         WHERE id IN (?, ?, ?) AND notice_version = ?
           AND confirmed_by_account_id IS NOT NULL AND confirmed_at IS NOT NULL) AS revisions_with_notice,
       (SELECT COUNT(*) FROM content_submission_review WHERE submission_id = ?) AS pending_reviews,
       (SELECT COUNT(*) FROM content_submission_revision WHERE submission_id = ?) AS draft_revisions,
       (SELECT COUNT(*) FROM reference_document_case_detail d
          JOIN fault_case_submission_detail f ON f.submission_id = ?
          WHERE d.document_id = ?
            AND d.error_code = f.error_code
            AND d.handling_status = f.handling_status
            AND d.phenomenon = f.phenomenon
            AND d.reproduction_steps = f.reproduction_steps
            AND d.resolution = f.resolution) AS case_detail_matches`,
    [
      seedIds.publishedSubmission,
      seedIds.reviewApproved,
      seedIds.publishedDocument,
      seedIds.publishedSubmission,
      seedIds.revisionPublished,
      seedIds.revisionReturned,
      seedIds.revisionPending,
      seedIds.revisionPublished,
      CONTENT_SUBMISSION_LIBRARY_NOTICE_VERSION,
      seedIds.pendingSubmission,
      seedIds.draftSubmission,
      seedIds.publishedSubmission,
      seedIds.publishedDocument,
    ],
  );
  const flowRow = asRecordArray(flowResult, 'Seed 链路一致性')[0];
  if (!flowRow) throw new Error('Seed 链路一致性查询没有返回结果');
  const expectedFlow: Record<string, number> = {
    published_flags: 1,
    approve_reviews: 1,
    published_sources: 1,
    revisions_with_notice: 3,
    pending_reviews: 0,
    draft_revisions: 0,
    case_detail_matches: 1,
  };
  const flowMismatches = Object.entries(expectedFlow)
    .filter(([key, count]) => readNumber(flowRow, key) !== count)
    .map(([key, count]) => `${key}: 期望 ${count}，实际 ${readNumber(flowRow, key)}`);
  if (flowMismatches.length > 0) {
    throw new Error(`Seed 链路一致性校验失败：${flowMismatches.join('；')}`);
  }

  const distributionResult: unknown = await manager.query(
    `SELECT o.organization_code AS organization_code, COUNT(*) AS member_count
     FROM organization_membership m
     JOIN organization o ON o.id = m.organization_id
     WHERE m.id BETWEEN ? AND ?
     GROUP BY o.organization_code`,
    [SEED_ID_MIN, SEED_ID_MAX],
  );
  const distribution = new Map(
    asRecordArray(distributionResult, 'Seed 成员分布').map(
      (distributionRow) =>
        [
          readString(distributionRow, 'organization_code'),
          readNumber(distributionRow, 'member_count'),
        ] as const,
    ),
  );
  const expectedDistribution: Record<string, number> = { CLIENT_DEFAULT: 3, PEER_ALT: 2 };
  const distributionMismatches = Object.entries(expectedDistribution)
    .filter(([code, count]) => distribution.get(code) !== count)
    .map(([code, count]) => `${code}: 期望 ${count}，实际 ${distribution.get(code) ?? 0}`);
  if (distributionMismatches.length > 0) {
    throw new Error(`Seed 成员组织分布校验失败：${distributionMismatches.join('；')}`);
  }

  const accountResult: unknown = await manager.query(
    'SELECT login_password, created_at FROM base_user_account WHERE id = ?',
    [MOCK_ACCOUNTS[0]?.id],
  );
  const accountRow = asRecordArray(accountResult, 'Mock 账号')[0];
  if (!accountRow) throw new Error('Mock 管理员账号不存在');
  const createdAtRaw = accountRow.created_at;
  const createdAt = createdAtRaw instanceof Date ? createdAtRaw : new Date(String(createdAtRaw));
  if (
    !AccountService.verifyPassword(password, readString(accountRow, 'login_password'), createdAt)
  ) {
    throw new Error('Mock 账号密码散列校验失败');
  }

  const digestResult: unknown = await manager.query(
    'SELECT meta_digest FROM base_user_info WHERE account_id = ?',
    [MOCK_ACCOUNTS[0]?.id],
  );
  const digestRow = asRecordArray(digestResult, 'Mock 用户信息')[0];
  if (!digestRow) throw new Error('Mock 管理员用户信息不存在');
  const roles: unknown = JSON.parse(encryption.decrypt(readString(digestRow, 'meta_digest')));
  if (!Array.isArray(roles) || roles[0] !== 'SUPER_ADMIN') {
    throw new Error('Mock 账号角色加密字段校验失败');
  }

  // 冻结快照对应关系（G3/F04）：快照↔明细↔正文↔案例明细四方互证
  await assertFrozenSnapshotCorrespondence(manager, resolveContentModelId);
}

async function seedMockData(): Promise<void> {
  loadSeedEnv();
  const password = getSeedEnv('MOCK_SEED_PASSWORD');
  if (!password) {
    throw new Error(
      '缺少 MOCK_SEED_PASSWORD；请在 Seed 环境文件或当前进程中设置统一 Mock 登录密码',
    );
  }

  const mysql = (databaseConfig() as { mysql: MysqlConnectionConfig }).mysql;
  const options = buildDataSourceOptions(mysql);
  ensureSafeTarget(options.database);
  const encryption = buildFieldEncryptionCodec();
  const dataSource = new DataSource(options);

  try {
    await dataSource.initialize();
    await dataSource.transaction(async (manager) => {
      await assertSchemaReady(manager);
      await seedAccounts(manager, password, encryption);
      const modelIds = await seedEquipment(manager);
      const orgIds = await seedOrganizations(manager);
      await seedMemberships(manager, orgIds);
      await seedBusinessTables(manager, modelIds, orgIds);
      await seedContentSubmissions(manager, modelIds, orgIds);
      await seedInfrastructureTables(manager);
      const resolveContentModelId: SeedContentModelIdResolver = (modelCode) =>
        requireModelId(modelIds, modelCode);
      await assertSeedResult(manager, password, encryption, resolveContentModelId);
    });
    process.stdout.write(
      `全量 Mock Data 导入成功：${EXPECTED_TABLES.length} 张表均已填充；Mock 主键保留区间 ${SEED_ID_MIN}-${SEED_ID_MAX}；可重复执行\n`,
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

void seedMockData().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '未知错误';
  process.stderr.write(`全量 Mock Data 导入失败：${message}\n`);
  process.exit(1);
});

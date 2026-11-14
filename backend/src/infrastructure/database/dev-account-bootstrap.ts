import { IdentityTypeEnum } from '@app-types/models/account.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import { hashPasswordWithTimestamp } from '@core/account/policy/password-hashing.policy';

import type { EntityManager } from 'typeorm';

import { createFieldCipher, type FieldCipher } from '../field-encryption/field-encryption.cipher';
import {
  assertExistingAccountLoginEmail,
  decryptMetaDigest,
  loadActiveMembership,
  loadBootstrapAccount,
  type BootstrapAccountFacts,
} from './bootstrap-account';
import { assertBootstrapPassword } from './bootstrap-password';
import { lockOrganizationByCode, type OrganizationRow } from './organization-bootstrap';

/**
 * 开发／验收样例账号受控初始化。
 *
 * 与管理员初始化分开授权：只有显式提供配置文件与确认口令、且目标库名带开发标记时
 * 才会写入；正式部署默认不生成任何客户／工程师样例。样例只补“账号可用所必需”的
 * 账号、资料、角色事实与组织成员关系，不生成工单、报告、文件或注册审批历史。
 */
export type DevAccountRole = 'CUSTOMER' | 'ENGINEER';

export interface DevAccountEntry {
  readonly loginName: string;
  readonly loginEmail: string | null;
  readonly password: string;
  readonly nickname: string;
  readonly realName: string | null;
  readonly organizationCode: string;
}

export interface DevAccountBootstrapConfig {
  readonly schemaVersion: 1;
  readonly customers: ReadonlyArray<DevAccountEntry>;
  readonly engineers: ReadonlyArray<DevAccountEntry>;
}

export interface DevAccountBootstrapEncryption {
  readonly fieldEncryptionKey?: string;
  readonly fieldEncryptionIv?: string;
}

export type DevAccountOutcome = 'CREATED' | 'UNCHANGED';

export interface DevAccountBootstrapResult {
  readonly loginName: string;
  readonly role: DevAccountRole;
  readonly organizationCode: string;
  readonly outcome: DevAccountOutcome;
}

const CONFIG_KEYS = new Set(['schema_version', 'customers', 'engineers']);
const ACCOUNT_KEYS = new Set([
  'login_name',
  'login_email',
  'password',
  'nickname',
  'real_name',
  'organization_code',
]);
const MAX_LOGIN_NAME_LENGTH = 30;
const MAX_LOGIN_EMAIL_LENGTH = 100;
const MAX_NICKNAME_LENGTH = 50;
const MAX_REAL_NAME_LENGTH = 200;
const MAX_ORGANIZATION_CODE_LENGTH = 64;

const ROLE_FACTS: Record<DevAccountRole, IdentityTypeEnum> = {
  CUSTOMER: IdentityTypeEnum.CUSTOMER,
  ENGINEER: IdentityTypeEnum.ENGINEER,
};

const DEV_TARGET_DATABASE_MARKERS = ['test', 'dev', 'local', 'drill'] as const;
const FORBIDDEN_DEV_TARGET_DATABASES = ['lithography_drill', 'lithography_e2e'] as const;
const FORBIDDEN_DEV_TARGET_SUFFIXES = ['_drill', '_e2e'] as const;

/**
 * 开发样例账号的目标库安全门：库名必须带明确的开发/测试标记。
 * 这样即使误把样例配置指向正式库，也会在连接与任何写入之前失败。
 * 现有共享验收库（lithography_drill / lithography_e2e 等）明确拒绝，
 * 不允许借库初始化。
 */
export function assertDevAccountTargetDatabase(database: string): void {
  const normalized = database.toLowerCase();
  if (
    FORBIDDEN_DEV_TARGET_DATABASES.some((name) => normalized === name) ||
    FORBIDDEN_DEV_TARGET_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    throw new Error(`开发账号初始化拒绝写入现有共享库 ${database}；请显式创建独立的开发验收库`);
  }
  if (!DEV_TARGET_DATABASE_MARKERS.some((marker) => normalized.includes(marker))) {
    throw new Error(
      `开发账号初始化只允许写入库名包含 ${DEV_TARGET_DATABASE_MARKERS.join('/')} 的开发或测试库；` +
        `当前目标库 ${database} 被拒绝`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 缺少非空字符串字段 ${key}`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${label} 字段 ${key} 超过最大长度 ${String(maxLength)}`);
  }
  return trimmed;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} 字段 ${key} 必须为字符串或省略`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} 字段 ${key} 超过最大长度 ${String(maxLength)}`);
  }
  return trimmed;
}

function assertNoUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} 存在不支持的字段 ${key}`);
    }
  }
}

function parseEntries(
  value: unknown,
  field: 'customers' | 'engineers',
  seenLoginNames: Set<string>,
  seenEmails: Set<string>,
): ReadonlyArray<DevAccountEntry> {
  if (!Array.isArray(value)) {
    throw new Error(`开发账号映射 ${field} 必须为数组`);
  }
  return value.map((item, index): DevAccountEntry => {
    const label = `开发账号映射 ${field}[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    assertNoUnknownKeys(item, ACCOUNT_KEYS, label);

    const loginName = readRequiredString(item, 'login_name', label, MAX_LOGIN_NAME_LENGTH);
    if (seenLoginNames.has(loginName)) {
      throw new Error(`开发账号映射存在重复账号 ${loginName}`);
    }
    seenLoginNames.add(loginName);

    const loginEmail = readOptionalString(item, 'login_email', label, MAX_LOGIN_EMAIL_LENGTH);
    if (loginEmail !== null) {
      if (seenEmails.has(loginEmail)) {
        throw new Error(`开发账号映射存在重复邮箱 ${loginEmail}`);
      }
      seenEmails.add(loginEmail);
    }

    return {
      loginName,
      loginEmail,
      password: readRequiredString(item, 'password', label, 128),
      nickname: readRequiredString(item, 'nickname', label, MAX_NICKNAME_LENGTH),
      realName: readOptionalString(item, 'real_name', label, MAX_REAL_NAME_LENGTH),
      organizationCode: readRequiredString(
        item,
        'organization_code',
        label,
        MAX_ORGANIZATION_CODE_LENGTH,
      ),
    };
  });
}

/**
 * 解析开发账号映射文件；客户与工程师列表都必须显式给出（可为空数组），
 * 但合计至少 1 个账号，避免“确认了开关却什么也没配置”的空操作。
 */
export function parseDevAccountBootstrapConfig(raw: string): DevAccountBootstrapConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '未知解析错误';
    throw new Error(`开发账号映射文件不是合法 JSON: ${message}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error('开发账号映射文件根节点必须是对象');
  }
  assertNoUnknownKeys(parsed, CONFIG_KEYS, '开发账号映射文件');
  if (parsed.schema_version !== 1) {
    throw new Error('开发账号映射文件 schema_version 必须为 1');
  }

  const seenLoginNames = new Set<string>();
  const seenEmails = new Set<string>();
  const customers = parseEntries(parsed.customers, 'customers', seenLoginNames, seenEmails);
  const engineers = parseEntries(parsed.engineers, 'engineers', seenLoginNames, seenEmails);
  if (customers.length + engineers.length === 0) {
    throw new Error('开发账号映射 customers 与 engineers 合计必须至少包含 1 个账号');
  }

  return { schemaVersion: 1, customers, engineers };
}

function resolveFieldCipher(encryption?: DevAccountBootstrapEncryption): FieldCipher {
  const key = encryption?.fieldEncryptionKey?.trim();
  const iv = encryption?.fieldEncryptionIv?.trim();
  if (!key || !iv) {
    throw new Error(
      '开发账号初始化需要 FIELD_ENCRYPTION_KEY 与 FIELD_ENCRYPTION_IV，' +
        '拒绝写入或校验 API 无法解密的 meta_digest',
    );
  }
  return createFieldCipher(key, iv);
}

async function assertLoginEmailAvailable(
  manager: EntityManager,
  entry: DevAccountEntry,
): Promise<void> {
  if (entry.loginEmail === null) {
    return;
  }
  const rows: unknown = await manager.query(
    'SELECT `login_name` FROM `base_user_account` WHERE `login_email` = ? LIMIT 1 FOR UPDATE',
    [entry.loginEmail],
  );
  if (Array.isArray(rows) && rows.length > 0) {
    throw new Error(`开发账号 ${entry.loginName} 的邮箱已被其他账号占用，拒绝创建或接管`);
  }
}

async function createDevAccount(
  manager: EntityManager,
  entry: DevAccountEntry,
  role: DevAccountRole,
  organization: OrganizationRow,
  cipher: FieldCipher,
): Promise<void> {
  const createdAt = new Date();
  const passwordHash = hashPasswordWithTimestamp(entry.password, createdAt);
  const roleFact = ROLE_FACTS[role];
  const accessGroupJson = JSON.stringify([roleFact]);
  const metaDigestCipher = cipher.encrypt(accessGroupJson);

  // 写前用同一 core policy 校验即将写入的三源角色事实，防止未来改动引入不一致。
  const intendedFacts = convergeAccountRole({
    identityHint: roleFact,
    accessGroup: [roleFact],
    metaDigest: [roleFact],
  });
  if (!intendedFacts.converged || intendedFacts.role !== roleFact) {
    throw new Error(`开发账号 ${entry.loginName} 的角色事实构造无效，拒绝写入`);
  }

  await manager.query(
    `
      INSERT INTO \`base_user_account\`
        (\`login_name\`, \`login_email\`, \`login_password\`, \`status\`, \`identity_hint\`,
         \`admin_level\`, \`must_change_password\`, \`created_at\`, \`updated_at\`)
      VALUES (?, ?, ?, 'ACTIVE', ?, NULL, 0, ?, ?)
    `,
    [entry.loginName, entry.loginEmail, passwordHash, roleFact, createdAt, createdAt],
  );

  const idRows: unknown = await manager.query('SELECT LAST_INSERT_ID() AS account_id');
  if (!Array.isArray(idRows) || idRows.length === 0) {
    throw new Error(`创建账号 ${entry.loginName} 后无法读取主键`);
  }
  const accountId = Number((idRows[0] as { readonly account_id: number }).account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error(`创建账号 ${entry.loginName} 后主键无效`);
  }

  // 客户资料绑定所属公司；工程师不用 customer_organization_id 表达归属。
  await manager.query(
    `
      INSERT INTO \`base_user_info\`
        (\`account_id\`, \`nickname\`, \`real_name\`, \`customer_organization_id\`,
         \`access_group\`, \`meta_digest\`, \`user_state\`, \`created_at\`, \`updated_at\`)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `,
    [
      accountId,
      entry.nickname,
      entry.realName,
      role === 'CUSTOMER' ? organization.id : null,
      accessGroupJson,
      metaDigestCipher,
      createdAt,
      createdAt,
    ],
  );

  // 生成列 active_account_id 由数据库计算，绝不手写。
  await manager.query(
    `
      INSERT INTO \`organization_membership\`
        (\`organization_id\`, \`account_id\`, \`member_role\`, \`status\`,
         \`joined_at\`, \`left_at\`, \`created_at\`, \`updated_at\`)
      VALUES (?, ?, ?, 'ACTIVE', ?, NULL, ?, ?)
    `,
    [organization.id, accountId, roleFact, createdAt, createdAt, createdAt],
  );
}

async function assertValidExistingDevAccount(params: {
  readonly manager: EntityManager;
  readonly entry: DevAccountEntry;
  readonly role: DevAccountRole;
  readonly account: BootstrapAccountFacts;
  readonly organization: OrganizationRow;
  readonly cipher: FieldCipher;
}): Promise<void> {
  const { manager, entry, role, account, organization, cipher } = params;

  if (!account.hasUserInfo) {
    throw new Error(`开发账号 ${entry.loginName} 缺少用户资料，拒绝自动补造`);
  }
  if (account.accountStatus !== 'ACTIVE') {
    throw new Error(
      `账号 ${entry.loginName} 状态为 ${String(account.accountStatus)}，不是 ACTIVE，拒绝初始化`,
    );
  }
  if (account.userState !== 'ACTIVE') {
    throw new Error(
      `账号 ${entry.loginName} 的资料状态为 ${String(account.userState)}，不是 ACTIVE，拒绝初始化`,
    );
  }
  if (account.adminLevel !== null) {
    throw new Error(
      `账号 ${entry.loginName} 已带管理员等级 ${String(account.adminLevel)}，` +
        '拒绝改写为开发样例账号',
    );
  }
  await assertExistingAccountLoginEmail(
    manager,
    entry.loginName,
    entry.loginEmail,
    account.loginEmail,
  );

  const expectedRole = ROLE_FACTS[role];
  const convergence = convergeAccountRole({
    identityHint: account.identityHint,
    accessGroup: account.accessGroup,
    metaDigest: decryptMetaDigest(account.metaDigest, cipher),
  });
  if (!convergence.converged) {
    throw new Error(
      `账号 ${entry.loginName} 角色事实无效（${convergence.reason}），` +
        '拒绝返回 UNCHANGED，需人工修复 identity_hint/access_group/meta_digest',
    );
  }
  if (convergence.role !== expectedRole) {
    throw new Error(
      `账号 ${entry.loginName} 角色事实为 ${convergence.role}，与开发样例 ${role} 不一致，拒绝覆盖`,
    );
  }

  if (role === 'CUSTOMER') {
    if (account.customerOrganizationId !== organization.id) {
      throw new Error(
        `客户账号 ${entry.loginName} 的公司归属与 ${entry.organizationCode} 不一致，拒绝覆盖`,
      );
    }
  } else if (account.customerOrganizationId !== null) {
    throw new Error(`工程师账号 ${entry.loginName} 带客户公司归属，拒绝按工程师样例接管`);
  }

  const membership = await loadActiveMembership(manager, account.id, organization.id);
  if (membership === null) {
    throw new Error(
      `账号 ${entry.loginName} 在组织 ${entry.organizationCode} 缺少 ACTIVE 成员关系，拒绝自动授予`,
    );
  }
  if (membership.member_role !== String(expectedRole)) {
    throw new Error(
      `账号 ${entry.loginName} 在组织 ${entry.organizationCode} 的成员角色为 ` +
        `${String(membership.member_role)}，不是 ${role}，拒绝覆盖`,
    );
  }
  if (membership.left_at !== null) {
    throw new Error(`账号 ${entry.loginName} 的成员关系已退出，拒绝初始化`);
  }
}

async function applyOne(
  manager: EntityManager,
  entry: DevAccountEntry,
  role: DevAccountRole,
  cipher: FieldCipher,
): Promise<DevAccountBootstrapResult> {
  const organization = await lockOrganizationByCode(manager, entry.organizationCode);
  if (organization === null) {
    throw new Error(
      `开发账号映射引用了不存在的公司 organization_code=${entry.organizationCode}，拒绝猜测公司`,
    );
  }
  if (organization.status !== 'ACTIVE') {
    throw new Error(`公司 ${entry.organizationCode} 不是 ACTIVE，拒绝挂接开发账号`);
  }
  if (role === 'ENGINEER' && !organization.isManagedCompany) {
    throw new Error(
      `工程师账号 ${entry.loginName} 只能挂接管理名单内公司，` +
        `organization_code=${entry.organizationCode} is_managed_company=false`,
    );
  }

  const account = await loadBootstrapAccount(manager, entry.loginName);
  if (account === null) {
    await assertLoginEmailAvailable(manager, entry);
    await createDevAccount(manager, entry, role, organization, cipher);
    return {
      loginName: entry.loginName,
      role,
      organizationCode: entry.organizationCode,
      outcome: 'CREATED',
    };
  }

  await assertValidExistingDevAccount({ manager, entry, role, account, organization, cipher });
  return {
    loginName: entry.loginName,
    role,
    organizationCode: entry.organizationCode,
    outcome: 'UNCHANGED',
  };
}

/**
 * 显式受控应用开发样例账号。
 *
 * 规则：
 * - 先对所有密码做项目策略校验，任何一个不合规都在写入前失败；
 * - 账号不存在才创建，同事务写入账号、资料、角色事实与组织成员关系；
 * - 账号已存在时绝不重置密码、绝不改等级/公司/角色；事实不完整或冲突一律失败关闭；
 * - 不创建注册／审批历史，不生成工单、报告等业务样例数据。
 */
export async function applyDevAccountBootstrap(
  manager: EntityManager,
  config: DevAccountBootstrapConfig,
  encryption?: DevAccountBootstrapEncryption,
): Promise<ReadonlyArray<DevAccountBootstrapResult>> {
  const cipher = resolveFieldCipher(encryption);

  for (const entry of config.customers) {
    assertBootstrapPassword(`开发客户账号 ${entry.loginName}`, entry.password);
  }
  for (const entry of config.engineers) {
    assertBootstrapPassword(`开发工程师账号 ${entry.loginName}`, entry.password);
  }

  const results: DevAccountBootstrapResult[] = [];
  for (const entry of config.customers) {
    results.push(await applyOne(manager, entry, 'CUSTOMER', cipher));
  }
  for (const entry of config.engineers) {
    results.push(await applyOne(manager, entry, 'ENGINEER', cipher));
  }
  return results;
}

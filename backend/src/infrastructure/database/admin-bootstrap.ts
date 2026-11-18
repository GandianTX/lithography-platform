import { IdentityTypeEnum } from '@app-types/models/account.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import {
  evaluateAdminBinding,
  maskLoginName,
  type AdminBindingEvaluation,
} from '@core/account/policy/admin-binding.policy';
import { hashPasswordWithTimestamp } from '@core/account/policy/password-hashing.policy';

import type { DataSource, EntityManager } from 'typeorm';

import { createFieldCipher, type FieldCipher } from '../field-encryption/field-encryption.cipher';
import {
  assertExistingAccountLoginEmail,
  decryptMetaDigest,
  loadActiveMembership,
  loadAdminBindingCandidateRows,
  loadBootstrapAccount,
  toAdminBindingCandidate,
  type BootstrapAccountFacts,
} from './bootstrap-account';
import { assertBootstrapPassword } from './bootstrap-password';
import { lockOrganizationByCode, type OrganizationRow } from './organization-bootstrap';

/**
 * 管理员初始化映射文件：账号 → 等级 → 公司。
 *
 * 文件本身是受控上线前置物，不在仓库中保存真实密码或真实账号清单；
 * 仓库只提供无秘密模板。缺少该文件时部署工具照常可用，但不会自动创建管理员。
 *
 * 版本 1：扁平 `accounts`，同时包含 1 级与 2 级账号（开发夹具沿用，不套用 3+N 规则）。
 * 版本 2：正式初始化口径，`level_one_accounts` 恰好 3 个 +
 * `default_managed_companies` 显式列出的默认受管公司（可为 0 家），每家公司 1 个二级账号。
 */
export interface AdminBootstrapEntry {
  readonly loginName: string;
  readonly loginEmail: string | null;
  readonly password: string;
  readonly adminLevel: 1 | 2;
  readonly organizationCode: string;
  readonly nickname: string;
  readonly realName: string | null;
}

export interface AdminDefaultManagedCompanyEntry {
  readonly organizationCode: string;
  readonly account: AdminBootstrapEntry;
}

export interface AdminBootstrapConfig {
  readonly schemaVersion: 1 | 2;
  readonly accounts: ReadonlyArray<AdminBootstrapEntry>;
  /** 仅 `schemaVersion=2` 使用；版本 1 为空数组。 */
  readonly defaultManagedCompanies: ReadonlyArray<AdminDefaultManagedCompanyEntry>;
}

/**
 * 字段加密配置：写 `base_user_info.meta_digest` 与校验既有密文都需要。
 * 缺失时失败关闭，绝不写入 API 无法解密的角色事实。
 */
export interface AdminBootstrapEncryption {
  readonly fieldEncryptionKey?: string;
  readonly fieldEncryptionIv?: string;
}

export type AdminBootstrapOutcome = 'CREATED' | 'MAPPED' | 'UNCHANGED';

export type AdminBootstrapBindingNote = 'REUSED_EXISTING_BINDING' | 'BOUND_ACCOUNT_NOT_ACTIVE';

export interface AdminBootstrapResult {
  readonly loginName: string;
  readonly outcome: AdminBootstrapOutcome;
  readonly adminLevel: number;
  readonly organizationCode: string;
  /** 仅正式初始化（schema 2）填充：本次是否产生需要受控交付的新临时密码。 */
  readonly temporaryPasswordIssued?: boolean;
  /** 仅正式初始化（schema 2）填充：复用既有绑定或账号停用的安全提示。 */
  readonly bindingNote?: AdminBootstrapBindingNote;
}

const CONFIG_KEYS = new Set(['schema_version', 'accounts']);
const CONFIG_KEYS_V2 = new Set([
  'schema_version',
  'level_one_accounts',
  'default_managed_companies',
]);
const ACCOUNT_KEYS = new Set([
  'login_name',
  'login_email',
  'password',
  'admin_level',
  'organization_code',
  'nickname',
  'real_name',
]);
const LEVEL_ONE_ACCOUNT_KEYS = new Set([
  'login_name',
  'login_email',
  'password',
  'organization_code',
  'nickname',
  'real_name',
]);
const LEVEL_TWO_ACCOUNT_KEYS = new Set([
  'login_name',
  'login_email',
  'password',
  'nickname',
  'real_name',
]);
const DEFAULT_MANAGED_COMPANY_KEYS = new Set(['organization_code', 'account']);
const REQUIRED_LEVEL_ONE_ACCOUNTS = 3;
const MIN_PASSWORD_LENGTH = 8;
const ADMIN_ROLE = IdentityTypeEnum.SUPER_ADMIN;
const ADMIN_ROLE_FACTS: ReadonlyArray<IdentityTypeEnum> = [ADMIN_ROLE];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 缺少非空字符串字段 ${key}`);
  }
  return value.trim();
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} 字段 ${key} 必须为字符串或省略`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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

interface AccountIdentityTracker {
  readonly loginNames: Set<string>;
  readonly loginEmails: Set<string>;
}

function createIdentityTracker(): AccountIdentityTracker {
  return { loginNames: new Set<string>(), loginEmails: new Set<string>() };
}

function parseBootstrapEntry(params: {
  readonly item: Record<string, unknown>;
  readonly label: string;
  readonly allowedKeys: ReadonlySet<string>;
  readonly adminLevel: 1 | 2;
  readonly organizationCode: string;
  readonly tracker: AccountIdentityTracker;
}): AdminBootstrapEntry {
  const { item, label, allowedKeys, adminLevel, organizationCode, tracker } = params;
  assertNoUnknownKeys(item, allowedKeys, label);

  const loginName = readRequiredString(item, 'login_name', label);
  if (tracker.loginNames.has(loginName)) {
    throw new Error(`管理员映射存在重复账号 ${loginName}`);
  }
  tracker.loginNames.add(loginName);

  const password = readRequiredString(item, 'password', label);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`${label} 的 password 长度不足 ${String(MIN_PASSWORD_LENGTH)}`);
  }

  const nickname = readRequiredString(item, 'nickname', label);
  const loginEmail = readOptionalString(item, 'login_email', label);
  if (loginEmail !== null) {
    const emailKey = loginEmail.toLowerCase();
    if (tracker.loginEmails.has(emailKey)) {
      throw new Error(`管理员映射存在重复邮箱 ${loginEmail}`);
    }
    tracker.loginEmails.add(emailKey);
  }

  return {
    loginName,
    loginEmail,
    password,
    adminLevel,
    organizationCode,
    nickname,
    realName: readOptionalString(item, 'real_name', label),
  };
}

/**
 * 解析并强校验管理员映射文件；任何缺失/越界/未知字段都失败关闭。
 *
 * - `schema_version=1`：开发夹具与既有映射，保持原扁平 `accounts` 语义；
 * - `schema_version=2`：正式初始化，3 个一级 + 0..N 家显式默认受管公司。
 */
export function parseAdminBootstrapConfig(raw: string): AdminBootstrapConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '未知解析错误';
    throw new Error(`管理员映射文件不是合法 JSON: ${message}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error('管理员映射文件根节点必须是对象');
  }
  if (parsed.schema_version === 2) {
    return parseAdminBootstrapConfigV2(parsed);
  }

  assertNoUnknownKeys(parsed, CONFIG_KEYS, '管理员映射文件');
  if (parsed.schema_version !== 1) {
    throw new Error('管理员映射文件 schema_version 必须为 1 或 2');
  }
  const accountsValue = parsed.accounts;
  if (!Array.isArray(accountsValue) || accountsValue.length === 0) {
    throw new Error('管理员映射文件 accounts 必须为非空数组');
  }

  const tracker = createIdentityTracker();
  const accounts = accountsValue.map((item, index): AdminBootstrapEntry => {
    const label = `管理员映射 accounts[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    const rawLevel = item.admin_level;
    if (rawLevel !== 1 && rawLevel !== 2) {
      throw new Error(`${label} 的 admin_level 必须为 1 或 2`);
    }
    const organizationCode = readRequiredString(item, 'organization_code', label);
    return parseBootstrapEntry({
      item,
      label,
      allowedKeys: ACCOUNT_KEYS,
      adminLevel: rawLevel,
      organizationCode,
      tracker,
    });
  });

  return { schemaVersion: 1, accounts, defaultManagedCompanies: [] };
}

/**
 * 正式初始化映射（schema_version=2）。
 *
 * - `level_one_accounts` 必须恰好 3 个，按原甲方组织规则在应用时校验 `CLIENT` 公司；
 * - `default_managed_companies` 只接受显式列出的默认受管公司，允许 0 家；
 *   每家公司只配置 1 个二级账号，重复公司编码或重复账号/邮箱在解析期失败关闭。
 */
function parseAdminBootstrapConfigV2(parsed: Record<string, unknown>): AdminBootstrapConfig {
  assertNoUnknownKeys(parsed, CONFIG_KEYS_V2, '管理员映射文件');

  const levelOneValue = parsed.level_one_accounts;
  if (!Array.isArray(levelOneValue)) {
    throw new Error('管理员映射文件 schema_version=2 必须提供 level_one_accounts 数组');
  }
  if (levelOneValue.length !== REQUIRED_LEVEL_ONE_ACCOUNTS) {
    throw new Error(
      `管理员映射文件 level_one_accounts 必须恰好 ${String(REQUIRED_LEVEL_ONE_ACCOUNTS)} 个，` +
        `实际 ${String(levelOneValue.length)} 个`,
    );
  }

  const tracker = createIdentityTracker();
  const accounts = levelOneValue.map((item, index): AdminBootstrapEntry => {
    const label = `管理员映射 level_one_accounts[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    const organizationCode = readRequiredString(item, 'organization_code', label);
    return parseBootstrapEntry({
      item,
      label,
      allowedKeys: LEVEL_ONE_ACCOUNT_KEYS,
      adminLevel: 1,
      organizationCode,
      tracker,
    });
  });

  const companiesValue = parsed.default_managed_companies;
  if (!Array.isArray(companiesValue)) {
    throw new Error(
      '管理员映射文件 schema_version=2 必须提供 default_managed_companies 数组（可为空）',
    );
  }

  const seenOrganizationCodes = new Set<string>();
  const defaultManagedCompanies = companiesValue.map(
    (item, index): AdminDefaultManagedCompanyEntry => {
      const label = `管理员映射 default_managed_companies[${String(index)}]`;
      if (!isRecord(item)) {
        throw new Error(`${label} 必须是对象`);
      }
      assertNoUnknownKeys(item, DEFAULT_MANAGED_COMPANY_KEYS, label);

      const organizationCode = readRequiredString(item, 'organization_code', label);
      if (seenOrganizationCodes.has(organizationCode)) {
        throw new Error(`${label} 公司重复配置 ${organizationCode}，每家公司只允许 1 个二级账号`);
      }
      seenOrganizationCodes.add(organizationCode);

      const accountValue = item.account;
      if (!isRecord(accountValue)) {
        throw new Error(`${label} 的 account 必须是对象`);
      }
      const account = parseBootstrapEntry({
        item: accountValue,
        label: `${label}.account`,
        allowedKeys: LEVEL_TWO_ACCOUNT_KEYS,
        adminLevel: 2,
        organizationCode,
        tracker,
      });
      return { organizationCode, account };
    },
  );

  return { schemaVersion: 2, accounts, defaultManagedCompanies };
}

function resolveFieldCipher(encryption?: AdminBootstrapEncryption): FieldCipher {
  const key = encryption?.fieldEncryptionKey?.trim();
  const iv = encryption?.fieldEncryptionIv?.trim();
  if (!key || !iv) {
    throw new Error(
      '管理员初始化需要 FIELD_ENCRYPTION_KEY 与 FIELD_ENCRYPTION_IV，' +
        '拒绝写入或校验 API 无法解密的 meta_digest',
    );
  }
  return createFieldCipher(key, iv);
}

async function loadOrganization(
  manager: EntityManager,
  entry: AdminBootstrapEntry,
): Promise<OrganizationRow> {
  const row = await lockOrganizationByCode(manager, entry.organizationCode);
  if (row === null) {
    throw new Error(
      `管理员映射引用了不存在的公司 organization_code=${entry.organizationCode}，拒绝猜测公司`,
    );
  }
  if (row.status !== 'ACTIVE') {
    throw new Error(`公司 ${entry.organizationCode} 状态为 ${String(row.status)}，不是 ACTIVE`);
  }
  if (entry.adminLevel === 1 && row.kind !== 'CLIENT') {
    throw new Error(
      `1 级管理员只能绑定 CLIENT 组织，organization_code=${entry.organizationCode} 实际 kind=${String(row.kind)}`,
    );
  }
  if (entry.adminLevel === 2 && !row.isManagedCompany) {
    throw new Error(
      `2 级管理员只能绑定受管公司，organization_code=${entry.organizationCode} 未标记 is_managed_company`,
    );
  }
  return row;
}

async function assertValidExistingAdminFacts(params: {
  readonly manager: EntityManager;
  readonly entry: AdminBootstrapEntry;
  readonly account: BootstrapAccountFacts;
  readonly organization: OrganizationRow;
  readonly cipher: FieldCipher;
}): Promise<void> {
  const { manager, entry, account, organization, cipher } = params;

  if (!account.hasUserInfo) {
    throw new Error(`账号 ${entry.loginName} 缺少用户资料，无法确认角色事实，拒绝自动补造`);
  }
  if (account.accountStatus !== 'ACTIVE') {
    throw new Error(
      `账号 ${entry.loginName} 状态为 ${String(account.accountStatus)}，不是 ACTIVE，拒绝映射`,
    );
  }
  if (account.userState !== 'ACTIVE') {
    throw new Error(
      `账号 ${entry.loginName} 的资料状态为 ${String(account.userState)}，不是 ACTIVE，拒绝映射`,
    );
  }
  await assertExistingAccountLoginEmail(
    manager,
    entry.loginName,
    entry.loginEmail,
    account.loginEmail,
  );
  if (account.adminLevel !== null && account.adminLevel !== entry.adminLevel) {
    throw new Error(
      `账号 ${entry.loginName} 已有等级 ${String(account.adminLevel)}，与映射 ${String(entry.adminLevel)} 不一致，拒绝覆盖`,
    );
  }
  if (
    account.customerOrganizationId !== null &&
    account.customerOrganizationId !== organization.id
  ) {
    throw new Error(`账号 ${entry.loginName} 已归属其他公司，拒绝覆盖为 ${entry.organizationCode}`);
  }

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
  if (convergence.role !== ADMIN_ROLE) {
    throw new Error(
      `账号 ${entry.loginName} 角色事实为 ${convergence.role}，` +
        `与管理员映射 ${String(entry.adminLevel)} 级 SUPER_ADMIN 不一致，拒绝覆盖`,
    );
  }

  const membership = await loadActiveMembership(manager, account.id, organization.id);
  if (membership === null) {
    throw new Error(
      `账号 ${entry.loginName} 在组织 ${entry.organizationCode} 缺少 ACTIVE 成员关系，拒绝映射`,
    );
  }
  if (membership.member_role !== String(ADMIN_ROLE)) {
    throw new Error(
      `账号 ${entry.loginName} 在组织 ${entry.organizationCode} 的成员角色为 ` +
        `${String(membership.member_role)}，不是 SUPER_ADMIN，拒绝映射`,
    );
  }
  if (membership.left_at !== null) {
    throw new Error(`账号 ${entry.loginName} 的成员关系已退出，拒绝映射`);
  }
}

/**
 * 与登录链路保持同一算法：NFKC 预处理后以 `created_at` 的 ISO 字符串为盐，
 * PBKDF2-SHA256 5000 次迭代、64 字节输出。实现由 core 的
 * `hashPasswordWithTimestamp()` 统一提供，不在此重复实现。
 */
export async function createAdminAccount(
  manager: EntityManager,
  entry: AdminBootstrapEntry,
  organization: OrganizationRow,
  cipher: FieldCipher,
): Promise<void> {
  const createdAt = new Date();
  const passwordHash = hashPasswordWithTimestamp(entry.password, createdAt);
  const accessGroupJson = JSON.stringify(ADMIN_ROLE_FACTS);
  const metaDigestCipher = cipher.encrypt(accessGroupJson);

  // 写前用同一 core policy 校验即将写入的三源角色事实，防止未来改动引入不一致。
  const intendedFacts = convergeAccountRole({
    identityHint: ADMIN_ROLE,
    accessGroup: [...ADMIN_ROLE_FACTS],
    metaDigest: [...ADMIN_ROLE_FACTS],
  });
  if (!intendedFacts.converged || intendedFacts.role !== ADMIN_ROLE) {
    throw new Error(`管理员 ${entry.loginName} 的角色事实构造无效，拒绝写入`);
  }

  if (entry.loginEmail !== null) {
    const conflictRows: unknown = await manager.query(
      'SELECT `login_name` FROM `base_user_account` WHERE `login_email` = ? LIMIT 1 FOR UPDATE',
      [entry.loginEmail],
    );
    if (Array.isArray(conflictRows) && conflictRows.length > 0) {
      const owner = (conflictRows[0] as { readonly login_name?: unknown }).login_name;
      throw new Error(
        `管理员 ${entry.loginName} 的邮箱 ${entry.loginEmail} 已被账号 ` +
          `${typeof owner === 'string' ? owner : '(未知)'} 占用，拒绝创建`,
      );
    }
  }

  await manager.query(
    `
      INSERT INTO \`base_user_account\`
        (\`login_name\`, \`login_email\`, \`login_password\`, \`status\`, \`identity_hint\`,
         \`admin_level\`, \`must_change_password\`, \`created_at\`, \`updated_at\`)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?, 1, ?, ?)
    `,
    [
      entry.loginName,
      entry.loginEmail,
      passwordHash,
      ADMIN_ROLE,
      entry.adminLevel,
      createdAt,
      createdAt,
    ],
  );

  const idRows: unknown = await manager.query('SELECT LAST_INSERT_ID() AS account_id');
  if (!Array.isArray(idRows) || idRows.length === 0) {
    throw new Error(`创建账号 ${entry.loginName} 后无法读取主键`);
  }
  const accountId = Number((idRows[0] as { readonly account_id: number }).account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error(`创建账号 ${entry.loginName} 后主键无效`);
  }

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
      organization.id,
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
    [organization.id, accountId, ADMIN_ROLE, createdAt, createdAt, createdAt],
  );
}

/**
 * 显式受控应用管理员映射。
 *
 * 规则：
 * - 账号不存在才创建，创建时写入真实 SUPER_ADMIN 三源角色事实、ACTIVE 资料与
 *   ACTIVE SUPER_ADMIN 组织成员关系，并标记必须修改初始密码；
 * - 账号已存在时绝不重置密码、绝不覆盖冲突身份；
 * - 既有身份等级/公司归属与映射冲突时失败关闭；
 * - 既有账号的角色事实（identity_hint/access_group/meta_digest）、目标组织 ACTIVE
 *   SUPER_ADMIN 成员关系、账号与资料状态任一无效时明确拒绝，不返回 UNCHANGED 掩盖；
 * - 仅当等级或公司归属为空时按显式映射补齐（MAPPED），全部已映射且有效时 UNCHANGED；
 * - 公司不存在或等级与组织类型不符时失败关闭，不猜测。
 */
export async function applyAdminBootstrap(
  dataSource: DataSource,
  config: AdminBootstrapConfig,
  encryption?: AdminBootstrapEncryption,
  manager?: EntityManager,
): Promise<ReadonlyArray<AdminBootstrapResult>> {
  const cipher = resolveFieldCipher(encryption);

  // 密码策略与登录/注册链路一致：先整体校验，任何不合规都在写入前失败。
  const allEntries = [
    ...config.accounts,
    ...config.defaultManagedCompanies.map((company) => company.account),
  ];
  for (const entry of allEntries) {
    assertBootstrapPassword(`管理员 ${entry.loginName}`, entry.password);
  }

  if (manager !== undefined) {
    return applyAdminBootstrapWithManager(manager, config, cipher);
  }
  return dataSource.transaction((tx) => applyAdminBootstrapWithManager(tx, config, cipher));
}

async function applyAdminBootstrapWithManager(
  manager: EntityManager,
  config: AdminBootstrapConfig,
  cipher: FieldCipher,
): Promise<ReadonlyArray<AdminBootstrapResult>> {
  if (config.schemaVersion === 2) {
    return applyAdminBootstrapV2WithManager(manager, config, cipher);
  }
  return applyAdminBootstrapLegacyWithManager(manager, config, cipher);
}

async function applyAdminBootstrapLegacyWithManager(
  manager: EntityManager,
  config: AdminBootstrapConfig,
  cipher: FieldCipher,
): Promise<ReadonlyArray<AdminBootstrapResult>> {
  const results: AdminBootstrapResult[] = [];
  for (const entry of config.accounts) {
    const organization = await loadOrganization(manager, entry);
    const account = await loadBootstrapAccount(manager, entry.loginName);

    if (account === null) {
      await createAdminAccount(manager, entry, organization, cipher);
      results.push({
        loginName: entry.loginName,
        outcome: 'CREATED',
        adminLevel: entry.adminLevel,
        organizationCode: entry.organizationCode,
      });
      continue;
    }

    await assertValidExistingAdminFacts({
      entry,
      account,
      organization,
      cipher,
      manager,
    });

    let outcome: AdminBootstrapOutcome = 'UNCHANGED';
    if (account.adminLevel === null) {
      await manager.query('UPDATE `base_user_account` SET `admin_level` = ? WHERE `id` = ?', [
        entry.adminLevel,
        account.id,
      ]);
      outcome = 'MAPPED';
    }
    if (account.customerOrganizationId === null) {
      await manager.query(
        'UPDATE `base_user_info` SET `customer_organization_id` = ? WHERE `account_id` = ?',
        [organization.id, account.id],
      );
      outcome = 'MAPPED';
    }

    results.push({
      loginName: entry.loginName,
      outcome,
      adminLevel: entry.adminLevel,
      organizationCode: entry.organizationCode,
    });
  }
  return results;
}

function formatBindingCandidateRefs(evaluation: AdminBindingEvaluation): string {
  if (evaluation.candidates.length === 0) {
    return '(无候选账号)';
  }
  return evaluation.candidates
    .map(
      (candidate) => `account_id=${String(candidate.accountId)} login=${candidate.loginNameMasked}`,
    )
    .join(', ');
}

function describeBindingIssue(
  organizationCode: string,
  evaluation: AdminBindingEvaluation,
): string {
  return (
    `公司 ${organizationCode} 绑定冲突（${String(evaluation.reason)}）：` +
    formatBindingCandidateRefs(evaluation)
  );
}

interface DefaultManagedCompanyPlan {
  readonly entry: AdminDefaultManagedCompanyEntry;
  readonly organization: OrganizationRow;
  readonly evaluation: AdminBindingEvaluation;
  readonly action: 'CREATE' | 'REUSE';
  readonly bindingNote?: AdminBootstrapBindingNote;
}

/**
 * 正式初始化（schema_version=2）：一级按原甲方组织规则验证；
 * 二级只处理配置显式列出的默认受管公司，先整体收集可定位问题，再在同一事务内落库。
 *
 * - 0 家默认受管公司是合法输入；
 * - 已有唯一合法绑定的公司直接复用，绝不重置密码、绝不新建第二个账号；
 * - 账号停用但绑定合法时沿用原账号标识，保持原状态；
 * - 未配置绑定时只创建新账号；配置账号名已存在（未绑定/错绑）时标人工问题并整体失败；
 * - 冲突、缺公司、停用公司、重复配置统一失败，且不产生半成品。
 */
async function applyAdminBootstrapV2WithManager(
  manager: EntityManager,
  config: AdminBootstrapConfig,
  cipher: FieldCipher,
): Promise<ReadonlyArray<AdminBootstrapResult>> {
  const results: AdminBootstrapResult[] = [];

  for (const entry of config.accounts) {
    const organization = await loadOrganization(manager, entry);
    const account = await loadBootstrapAccount(manager, entry.loginName);
    if (account === null) {
      await createAdminAccount(manager, entry, organization, cipher);
      results.push({
        loginName: entry.loginName,
        outcome: 'CREATED',
        adminLevel: 1,
        organizationCode: entry.organizationCode,
        temporaryPasswordIssued: true,
      });
      continue;
    }
    await assertValidExistingAdminFacts({ entry, account, organization, cipher, manager });
    let outcome: AdminBootstrapOutcome = 'UNCHANGED';
    if (account.adminLevel === null) {
      await manager.query('UPDATE `base_user_account` SET `admin_level` = ? WHERE `id` = ?', [
        1,
        account.id,
      ]);
      outcome = 'MAPPED';
    }
    if (account.customerOrganizationId === null) {
      await manager.query(
        'UPDATE `base_user_info` SET `customer_organization_id` = ? WHERE `account_id` = ?',
        [organization.id, account.id],
      );
      outcome = 'MAPPED';
    }
    results.push({
      loginName: entry.loginName,
      outcome,
      adminLevel: 1,
      organizationCode: entry.organizationCode,
      temporaryPasswordIssued: false,
    });
  }

  if (config.defaultManagedCompanies.length === 0) {
    return results;
  }

  const issues: string[] = [];
  const plans: DefaultManagedCompanyPlan[] = [];

  for (const entry of config.defaultManagedCompanies) {
    const organization = await lockOrganizationByCode(manager, entry.organizationCode);
    if (organization === null) {
      issues.push(
        `缺少公司 organization_code=${entry.organizationCode}（配置引用不存在，拒绝猜测）`,
      );
      continue;
    }
    if (organization.status !== 'ACTIVE') {
      issues.push(
        `公司 ${entry.organizationCode} 状态为 ${String(organization.status)}，不是 ACTIVE，拒绝绑定二级管理员`,
      );
      continue;
    }
    if (!organization.isManagedCompany) {
      issues.push(
        `公司 ${entry.organizationCode} 未标记 is_managed_company，不是默认受管公司，拒绝绑定二级管理员`,
      );
      continue;
    }

    const candidateRows = await loadAdminBindingCandidateRows(manager, organization.id, {
      forUpdate: true,
    });
    const evaluation = evaluateAdminBinding({
      organizationId: organization.id,
      organizationCode: entry.organizationCode,
      companyStatus: organization.status,
      isManagedCompany: organization.isManagedCompany,
      candidates: candidateRows.map((row) => toAdminBindingCandidate(row, cipher)),
    });

    if (evaluation.status === 'CONFLICT') {
      issues.push(describeBindingIssue(entry.organizationCode, evaluation));
      continue;
    }
    if (evaluation.status === 'COMPANY_DISABLED') {
      issues.push(`公司 ${entry.organizationCode} 已停用，不能初始化二级管理员`);
      continue;
    }

    if (evaluation.status === 'BOUND') {
      const boundLoginName = evaluation.boundLoginName;
      if (boundLoginName === null) {
        issues.push(`公司 ${entry.organizationCode} 绑定状态异常：缺少可复用账号标识`);
        continue;
      }
      if (boundLoginName !== entry.account.loginName) {
        const occupied = await loadBootstrapAccount(manager, entry.account.loginName);
        if (occupied !== null) {
          issues.push(
            `公司 ${entry.organizationCode} 已绑定历史账号 ${evaluation.boundLoginNameMasked}` +
              `（account_id=${String(evaluation.boundAccountId)}），` +
              `配置账号 ${maskLoginName(entry.account.loginName)}（account_id=${String(occupied.id)}）已存在；` +
              '拒绝猜名或改绑，请人工核对',
          );
          continue;
        }
      }
      plans.push({
        entry,
        organization,
        evaluation,
        action: 'REUSE',
        ...(evaluation.accountDisabled
          ? { bindingNote: 'BOUND_ACCOUNT_NOT_ACTIVE' as const }
          : boundLoginName !== entry.account.loginName
            ? { bindingNote: 'REUSED_EXISTING_BINDING' as const }
            : {}),
      });
      continue;
    }

    // CONFIGURED 但无候选：只允许创建新账号；配置账号名已存在时不得复用/补级/改绑。
    const existing = await loadBootstrapAccount(manager, entry.account.loginName);
    if (existing !== null) {
      issues.push(
        `公司 ${entry.organizationCode} 缺少二级绑定，但配置账号 ` +
          `${maskLoginName(entry.account.loginName)}（account_id=${String(existing.id)}）已存在且未绑定该公司；` +
          '拒绝复用、补级或改绑，请人工处理',
      );
      continue;
    }
    plans.push({ entry, organization, evaluation, action: 'CREATE' });
  }

  if (issues.length > 0) {
    throw new Error(
      `管理员映射存在 ${String(issues.length)} 个绑定问题，整批拒绝：\n- ${issues.join('\n- ')}`,
    );
  }

  for (const plan of plans) {
    if (plan.action === 'REUSE') {
      const evaluation = plan.evaluation;
      if (evaluation.boundLoginName === null) {
        throw new Error(`公司 ${plan.entry.organizationCode} 复用绑定缺少账号标识`);
      }
      results.push({
        loginName: evaluation.boundLoginName,
        outcome: 'UNCHANGED',
        adminLevel: 2,
        organizationCode: plan.entry.organizationCode,
        temporaryPasswordIssued: false,
        ...(plan.bindingNote !== undefined ? { bindingNote: plan.bindingNote } : {}),
      });
      continue;
    }
    await createAdminAccount(manager, plan.entry.account, plan.organization, cipher);
    results.push({
      loginName: plan.entry.account.loginName,
      outcome: 'CREATED',
      adminLevel: 2,
      organizationCode: plan.entry.organizationCode,
      temporaryPasswordIssued: true,
    });
  }

  return results;
}

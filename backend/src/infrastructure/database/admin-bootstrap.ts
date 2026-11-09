import { IdentityTypeEnum } from '@app-types/models/account.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import { hashPasswordWithTimestamp } from '@core/account/policy/password-hashing.policy';

import type { DataSource, EntityManager } from 'typeorm';

import { createFieldCipher, type FieldCipher } from '../field-encryption/field-encryption.cipher';
import {
  decryptMetaDigest,
  loadActiveMembership,
  loadBootstrapAccount,
  type BootstrapAccountFacts,
} from './bootstrap-account';
import { assertBootstrapPassword } from './bootstrap-password';
import { lockOrganizationByCode, type OrganizationRow } from './organization-bootstrap';

/**
 * 管理员初始化映射文件：账号 → 等级 → 公司。
 *
 * 文件本身是受控上线前置物，不在仓库中保存真实密码或真实账号清单；
 * 仓库只提供无秘密模板。缺少该文件时部署工具照常可用，但不会自动创建管理员。
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

export interface AdminBootstrapConfig {
  readonly schemaVersion: 1;
  readonly accounts: ReadonlyArray<AdminBootstrapEntry>;
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

export interface AdminBootstrapResult {
  readonly loginName: string;
  readonly outcome: AdminBootstrapOutcome;
  readonly adminLevel: number;
  readonly organizationCode: string;
}

const CONFIG_KEYS = new Set(['schema_version', 'accounts']);
const ACCOUNT_KEYS = new Set([
  'login_name',
  'login_email',
  'password',
  'admin_level',
  'organization_code',
  'nickname',
  'real_name',
]);
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

/**
 * 解析并强校验管理员映射文件；任何缺失/越界/未知字段都失败关闭。
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
  assertNoUnknownKeys(parsed, CONFIG_KEYS, '管理员映射文件');
  if (parsed.schema_version !== 1) {
    throw new Error('管理员映射文件 schema_version 必须为 1');
  }
  const accountsValue = parsed.accounts;
  if (!Array.isArray(accountsValue) || accountsValue.length === 0) {
    throw new Error('管理员映射文件 accounts 必须为非空数组');
  }

  const seenLoginNames = new Set<string>();
  const accounts = accountsValue.map((item, index): AdminBootstrapEntry => {
    const label = `管理员映射 accounts[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    assertNoUnknownKeys(item, ACCOUNT_KEYS, label);

    const loginName = readRequiredString(item, 'login_name', label);
    if (seenLoginNames.has(loginName)) {
      throw new Error(`管理员映射存在重复账号 ${loginName}`);
    }
    seenLoginNames.add(loginName);

    const password = readRequiredString(item, 'password', label);
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`${label} 的 password 长度不足 ${String(MIN_PASSWORD_LENGTH)}`);
    }

    const rawLevel = item.admin_level;
    if (rawLevel !== 1 && rawLevel !== 2) {
      throw new Error(`${label} 的 admin_level 必须为 1 或 2`);
    }

    const organizationCode = readRequiredString(item, 'organization_code', label);
    const nickname = readRequiredString(item, 'nickname', label);

    return {
      loginName,
      loginEmail: readOptionalString(item, 'login_email', label),
      password,
      adminLevel: rawLevel,
      organizationCode,
      nickname,
      realName: readOptionalString(item, 'real_name', label),
    };
  });

  return { schemaVersion: 1, accounts };
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
async function createAccount(
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
  for (const entry of config.accounts) {
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
  const results: AdminBootstrapResult[] = [];
  for (const entry of config.accounts) {
    const organization = await loadOrganization(manager, entry);
    const account = await loadBootstrapAccount(manager, entry.loginName);

    if (account === null) {
      await createAccount(manager, entry, organization, cipher);
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

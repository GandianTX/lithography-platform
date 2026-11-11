import type { EntityManager } from 'typeorm';

import type { FieldCipher } from '../field-encryption/field-encryption.cipher';

/**
 * 初始化工具共享的账号事实读取。
 *
 * 管理员与开发样例初始化都必须基于**同一读取口径**判断既有账号是否可用，
 * 避免两套 SQL 对“缺资料/状态不符/角色事实无效”给出不一致结论。
 */
export interface BootstrapAccountFacts {
  readonly id: number;
  readonly adminLevel: number | null;
  readonly identityHint: unknown;
  readonly accountStatus: string;
  readonly hasUserInfo: boolean;
  readonly customerOrganizationId: number | null;
  readonly accessGroup: unknown;
  readonly metaDigest: unknown;
  readonly userState: string | null;
  readonly loginEmail: string | null;
}

export interface BootstrapMembershipRow {
  readonly member_role: string;
  readonly left_at: Date | null;
}

/**
 * 把数据库中的 JSON 列值归一为可交给 `convergeAccountRole()` 判定的原始形状。
 * 非字符串原样返回，让 policy 失败关闭，不做静默修复。
 */
export function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * 解密 `meta_digest` 后再尝试 JSON 解析。
 *
 * 解密失败或明文不是 JSON 时保留原值（密文/字符串），由 `convergeAccountRole()`
 * 归为 `META_DIGEST_NOT_ARRAY` 失败关闭；与 `FieldEncryptionService.decryptEntity()` 同口径。
 */
export function decryptMetaDigest(cipherText: unknown, cipher: FieldCipher): unknown {
  if (typeof cipherText !== 'string' || cipherText.length === 0) {
    return cipherText;
  }
  const plain = cipher.decrypt(cipherText);
  try {
    return JSON.parse(plain) as unknown;
  } catch {
    return plain;
  }
}

export async function loadBootstrapAccount(
  manager: EntityManager,
  loginName: string,
): Promise<BootstrapAccountFacts | null> {
  const rows: unknown = await manager.query(
    `
      SELECT
        a.\`id\`,
        a.\`admin_level\`,
        a.\`identity_hint\`,
        a.\`login_email\`,
        a.\`status\` AS \`account_status\`,
        i.\`id\` AS \`info_id\`,
        i.\`customer_organization_id\`,
        i.\`access_group\`,
        i.\`meta_digest\`,
        i.\`user_state\`
      FROM \`base_user_account\` AS a
      LEFT JOIN \`base_user_info\` AS i ON i.\`account_id\` = a.\`id\`
      WHERE a.\`login_name\` = ?
      LIMIT 1 FOR UPDATE
    `,
    [loginName],
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const row = rows[0] as {
    readonly id: number;
    readonly admin_level: number | null;
    readonly identity_hint: string | null;
    readonly login_email: string | null;
    readonly account_status: string;
    readonly info_id: number | null;
    readonly customer_organization_id: number | null;
    readonly access_group: unknown;
    readonly meta_digest: string | null;
    readonly user_state: string | null;
  };
  return {
    id: Number(row.id),
    adminLevel: row.admin_level === null ? null : Number(row.admin_level),
    identityHint: row.identity_hint,
    accountStatus: row.account_status,
    hasUserInfo: row.info_id !== null && row.info_id !== undefined,
    customerOrganizationId:
      row.customer_organization_id === null ? null : Number(row.customer_organization_id),
    accessGroup: parseJsonColumn(row.access_group),
    metaDigest: row.meta_digest,
    userState: row.user_state,
    loginEmail: row.login_email ?? null,
  };
}

/**
 * 既有账号的映射邮箱核对。
 *
 * - 映射未提供邮箱时不改写、不接管；
 * - 邮箱已归另一账号时整批失败；
 * - 映射邮箱与既有邮箱不一致时明确拒绝，绝不静默覆盖或错误返回 UNCHANGED。
 */
export async function assertExistingAccountLoginEmail(
  manager: EntityManager,
  loginName: string,
  configuredEmail: string | null,
  existingEmail: string | null,
): Promise<void> {
  if (configuredEmail === null) {
    return;
  }
  const ownerRows: unknown = await manager.query(
    'SELECT `login_name` FROM `base_user_account` WHERE `login_email` = ? LIMIT 1 FOR UPDATE',
    [configuredEmail],
  );
  if (Array.isArray(ownerRows) && ownerRows.length > 0) {
    const owner = (ownerRows[0] as { readonly login_name?: unknown }).login_name;
    if (owner !== loginName) {
      throw new Error(
        `账号 ${loginName} 的映射邮箱 ${configuredEmail} 已被账号 ` +
          `${typeof owner === 'string' ? owner : '(未知)'} 占用，拒绝初始化`,
      );
    }
  }
  const sameEmail =
    existingEmail !== null && existingEmail.toLowerCase() === configuredEmail.toLowerCase();
  if (!sameEmail) {
    throw new Error(
      `账号 ${loginName} 既有邮箱 ${existingEmail ?? '(空)'} 与映射邮箱 ` +
        `${configuredEmail} 不一致，拒绝覆盖或接管`,
    );
  }
}

export async function loadActiveMembership(
  manager: EntityManager,
  accountId: number,
  organizationId: number,
): Promise<BootstrapMembershipRow | null> {
  const rows: unknown = await manager.query(
    `
      SELECT \`member_role\`, \`left_at\`
      FROM \`organization_membership\`
      WHERE \`account_id\` = ?
        AND \`organization_id\` = ?
        AND \`status\` = 'ACTIVE'
      ORDER BY \`id\` DESC
      LIMIT 1 FOR UPDATE
    `,
    [accountId, organizationId],
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  return rows[0] as BootstrapMembershipRow;
}

import type { EntityManager } from 'typeorm';

/**
 * 组织（公司）受控初始化。
 *
 * 空库迁移后只有结构、没有公司；管理员与开发账号映射都需要真实公司存在。
 * 本模块只按显式配置创建/核对约定公司，不猜测编码、名称或归属，也不覆盖既有
 * 公司的类别与标记。配置与真实公司清单是库外上线前置物，仓库只提供无秘密模板。
 */
export type OrganizationKind = 'CLIENT' | 'PEER';

export interface OrganizationBootstrapEntry {
  readonly organizationCode: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly kind: OrganizationKind;
  readonly isManagedCompany: boolean;
  readonly isServiceProvider: boolean;
}

export interface OrganizationBootstrapConfig {
  readonly schemaVersion: 1;
  readonly organizations: ReadonlyArray<OrganizationBootstrapEntry>;
}

export type OrganizationBootstrapOutcome = 'CREATED' | 'UNCHANGED';

export interface OrganizationBootstrapResult {
  readonly organizationCode: string;
  readonly kind: OrganizationKind;
  readonly outcome: OrganizationBootstrapOutcome;
  /** 编码相同但名称/简称与配置不同；只报告，不覆盖既有记录。 */
  readonly nameMismatch: boolean;
}

export interface OrganizationRow {
  readonly id: number;
  readonly name: string;
  readonly shortName: string | null;
  readonly kind: string;
  readonly isManagedCompany: boolean;
  readonly isServiceProvider: boolean;
  readonly status: string;
}

const CONFIG_KEYS = new Set(['schema_version', 'organizations']);
const ORGANIZATION_KEYS = new Set([
  'organization_code',
  'name',
  'short_name',
  'kind',
  'is_managed_company',
  'is_service_provider',
  'status',
]);
const MAX_ORGANIZATION_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_SHORT_NAME_LENGTH = 100;

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

function readRequiredBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${label} 字段 ${key} 必须为布尔值 true/false`);
  }
  return value;
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
 * 解析组织映射文件；任何缺失/越界/未知字段都失败关闭。
 *
 * `status` 只接受 `ACTIVE`：初始化工具只创建可挂接账号的启用公司，
 * 停用公司属于运行期管理动作，不由部署命令静默完成。
 */
export function parseOrganizationBootstrapConfig(raw: string): OrganizationBootstrapConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '未知解析错误';
    throw new Error(`组织映射文件不是合法 JSON: ${message}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error('组织映射文件根节点必须是对象');
  }
  assertNoUnknownKeys(parsed, CONFIG_KEYS, '组织映射文件');
  if (parsed.schema_version !== 1) {
    throw new Error('组织映射文件 schema_version 必须为 1');
  }
  const organizationsValue = parsed.organizations;
  if (!Array.isArray(organizationsValue) || organizationsValue.length === 0) {
    throw new Error('组织映射文件 organizations 必须为非空数组');
  }

  const seenCodes = new Set<string>();
  const organizations = organizationsValue.map((item, index): OrganizationBootstrapEntry => {
    const label = `组织映射 organizations[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    assertNoUnknownKeys(item, ORGANIZATION_KEYS, label);

    const organizationCode = readRequiredString(
      item,
      'organization_code',
      label,
      MAX_ORGANIZATION_CODE_LENGTH,
    );
    if (seenCodes.has(organizationCode)) {
      throw new Error(`组织映射存在重复编码 ${organizationCode}`);
    }
    seenCodes.add(organizationCode);

    const kindValue = item.kind;
    if (kindValue !== 'CLIENT' && kindValue !== 'PEER') {
      throw new Error(`${label} 的 kind 必须为 CLIENT 或 PEER`);
    }
    const statusValue = item.status;
    if (statusValue !== 'ACTIVE') {
      throw new Error(`${label} 的 status 必须为 ACTIVE`);
    }

    return {
      organizationCode,
      name: readRequiredString(item, 'name', label, MAX_NAME_LENGTH),
      shortName: readOptionalString(item, 'short_name', label, MAX_SHORT_NAME_LENGTH),
      kind: kindValue,
      isManagedCompany: readRequiredBoolean(item, 'is_managed_company', label),
      isServiceProvider: readRequiredBoolean(item, 'is_service_provider', label),
    };
  });

  return { schemaVersion: 1, organizations };
}

export function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/**
 * 按组织编码锁定并读取公司事实；不存在返回 null，由调用方决定是否拒绝。
 */
export async function lockOrganizationByCode(
  manager: EntityManager,
  organizationCode: string,
): Promise<OrganizationRow | null> {
  const rows: unknown = await manager.query(
    `
      SELECT \`id\`, \`name\`, \`short_name\`, \`kind\`, \`is_managed_company\`, \`is_service_provider\`, \`status\`
      FROM \`organization\`
      WHERE \`organization_code\` = ?
      LIMIT 1 FOR UPDATE
    `,
    [organizationCode],
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const row = rows[0] as {
    readonly id: number;
    readonly name: string;
    readonly short_name: string | null;
    readonly kind: string;
    readonly is_managed_company: unknown;
    readonly is_service_provider: unknown;
    readonly status: string;
  };
  const id = Number(row.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`公司 ${organizationCode} 的主键无效`);
  }
  return {
    id,
    name: row.name,
    shortName: row.short_name ?? null,
    kind: row.kind,
    isManagedCompany: isTruthyFlag(row.is_managed_company),
    isServiceProvider: isTruthyFlag(row.is_service_provider),
    status: row.status,
  };
}

/**
 * 显式受控创建/核对约定公司。
 *
 * - 编码不存在才创建；
 * - 已存在时只核对类别与两个资格标记，不一致失败关闭，不覆盖、不接管；
 * - 改名不静默写入，也不因此拒绝（编码是稳定业务键，名称属于运行期维护）。
 */
export async function applyOrganizationBootstrap(
  manager: EntityManager,
  config: OrganizationBootstrapConfig,
): Promise<ReadonlyArray<OrganizationBootstrapResult>> {
  const results: OrganizationBootstrapResult[] = [];
  for (const entry of config.organizations) {
    const existing = await lockOrganizationByCode(manager, entry.organizationCode);
    if (existing === null) {
      await manager.query(
        `
          INSERT INTO \`organization\`
            (\`organization_code\`, \`name\`, \`short_name\`, \`is_service_provider\`,
             \`is_managed_company\`, \`kind\`, \`status\`)
          VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
        `,
        [
          entry.organizationCode,
          entry.name,
          entry.shortName,
          entry.isServiceProvider ? 1 : 0,
          entry.isManagedCompany ? 1 : 0,
          entry.kind,
        ],
      );
      results.push({
        organizationCode: entry.organizationCode,
        kind: entry.kind,
        outcome: 'CREATED',
        nameMismatch: false,
      });
      continue;
    }

    if (existing.status !== 'ACTIVE') {
      throw new Error(
        `公司 ${entry.organizationCode} 状态为 ${existing.status}，不是 ACTIVE，拒绝挂接账号`,
      );
    }
    if (existing.kind !== entry.kind) {
      throw new Error(
        `公司 ${entry.organizationCode} 已存在且 kind=${existing.kind}，` +
          `与配置 ${entry.kind} 不一致，拒绝覆盖`,
      );
    }
    if (existing.isManagedCompany !== entry.isManagedCompany) {
      throw new Error(
        `公司 ${entry.organizationCode} 的 is_managed_company 与配置不一致，拒绝覆盖`,
      );
    }
    if (existing.isServiceProvider !== entry.isServiceProvider) {
      throw new Error(
        `公司 ${entry.organizationCode} 的 is_service_provider 与配置不一致，拒绝覆盖`,
      );
    }

    const nameMismatch =
      existing.name !== entry.name || existing.shortName !== (entry.shortName ?? null);
    results.push({
      organizationCode: entry.organizationCode,
      kind: entry.kind,
      outcome: 'UNCHANGED',
      nameMismatch,
    });
  }
  return results;
}

// scripts/mock-v13/packs-shared.ts

/**
 * 数据包共享工具：字段加密、组织/账号解析、稳定键查询。
 */

import { createFieldCipher } from '@src/infrastructure/field-encryption/field-encryption.cipher';

import { MockConflictError, MockWriteError } from './errors';
import { FileRegistry } from './files';
import { findMany, findOne, insertRow, MockQueryRunner, Row } from './db';
import { ACCOUNTS, OrganizationKey, ORGANIZATIONS } from './manifest';
import { RunReport } from './report';

export interface FieldEncryptionCodec {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

/**
 * 复用项目既有字段加密原语（与 `FieldEncryptionService` 同一 AES-CBC/Pkcs7 实现），
 * 不再平行实现一套，避免密钥派生/编码方式与业务侧分叉。
 */
export function buildFieldEncryptionCodec(keyText: string, ivText: string): FieldEncryptionCodec {
  if (keyText.length < 16 || ivText.length < 16) {
    throw new MockWriteError('FIELD_ENCRYPTION_KEY / IV 长度不足 16');
  }
  return createFieldCipher(keyText, ivText);
}

export interface PackContext {
  readonly qr: MockQueryRunner;
  readonly report: RunReport;
  readonly files: FileRegistry;
  readonly mockFileDir: string;
  readonly referenceStorageDir: string;
  readonly passwordHash: string;
  readonly encryption: FieldEncryptionCodec;
}

export interface OrganizationIds {
  readonly platform: number;
  readonly A: number;
  readonly B: number;
}

export interface InstallationIdentity {
  readonly installationId: string;
  readonly organizationId: number | null;
}

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * 读取正式迁移生成的 `local_installation` 单例（id=1），按实际 `installation_id` 复用。
 * 只读校验，绝不更新该行，也不补写组织归属：组织未映射时保持 null，
 * 由各样例自己的 `organization_id` 表达业务归属。
 */
export async function readInstallationIdentity(
  queryRunner: MockQueryRunner,
): Promise<InstallationIdentity> {
  const row = await findOne(queryRunner, 'local_installation', { id: 1 });
  if (!row) {
    throw new MockWriteError(
      '目标库缺少正式迁移生成的 local_installation 单例行（id=1），拒绝自行创建或补写',
    );
  }
  const installationId = readString(row, 'installation_id');
  if (!INSTALLATION_ID_PATTERN.test(installationId)) {
    throw new MockConflictError(
      `local_installation.id=1 的 installation_id 不是 36 位 UUID，拒绝复用: ${installationId}`,
    );
  }
  const rawOrganizationId = row.organization_id;
  const organizationId =
    rawOrganizationId === null || rawOrganizationId === undefined
      ? null
      : Number(rawOrganizationId);
  if (organizationId !== null && !Number.isFinite(organizationId)) {
    throw new MockConflictError('local_installation.id=1 的 organization_id 非法，拒绝复用');
  }
  return { installationId, organizationId };
}

export async function resolveInstallationIdentity(
  context: PackContext,
): Promise<InstallationIdentity> {
  const identity = await readInstallationIdentity(context.qr);
  context.report.note(
    `复用安装单例 id=1：installation_id=${identity.installationId}，organization_id=${
      identity.organizationId === null ? '未映射' : identity.organizationId
    }（整行不修改）`,
  );
  return identity;
}

export function readNumber(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) {
    throw new MockWriteError(`字段 ${key} 不是有效数字`);
  }
  return value;
}

export function readString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new MockWriteError(`字段 ${key} 不是字符串`);
  }
  return value;
}

/** 复用已存在的可信甲方组织；不存在时才创建带 Mock 标识的 CLIENT 组织。 */
export async function resolvePlatformOrganization(context: PackContext): Promise<number> {
  const rows = await findMany(
    context.qr,
    'organization',
    { kind: 'CLIENT', status: 'ACTIVE', is_managed_company: 0 },
    'id ASC',
    1,
  );
  const existing = rows[0];
  if (existing) {
    context.report.note('复用现有 CLIENT 组织，未改写原组织');
    return readNumber(existing, 'id');
  }
  context.report.inserted();
  return insertRow(context.qr, 'organization', {
    organization_code: 'MOCK-V13-PLATFORM',
    name: '[MOCK-V13] 甲方平台测试组织',
    short_name: 'Mock 甲方平台',
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    address: null,
    remark: 'V13 开发 Mock 数据；未找到现有 CLIENT 组织时创建',
    is_service_provider: 0,
    is_managed_company: 0,
    kind: 'CLIENT',
    status: 'ACTIVE',
    created_at: new Date('2026-11-05T00:30:00.000Z'),
    updated_at: new Date('2026-11-05T00:30:00.000Z'),
  });
}

export async function ensureOrganization(
  context: PackContext,
  key: OrganizationKey,
): Promise<number> {
  const spec = ORGANIZATIONS.find((item) => item.key === key);
  if (!spec) {
    throw new MockWriteError(`未知组织键 ${key}`);
  }
  const existing = await findOne(context.qr, 'organization', { organization_code: spec.code });
  if (existing) {
    const name = readString(existing, 'name');
    const kind = String(existing.kind);
    const managed = Number(existing.is_managed_company);
    if (!name.startsWith('[MOCK-V13]') || kind !== 'PEER' || managed !== 1) {
      throw new MockConflictError(
        `组织编号 ${spec.code} 已存在但不是本 Mock 受管公司（name=${name}），拒绝复用`,
      );
    }
    context.report.reused();
    return readNumber(existing, 'id');
  }
  context.report.inserted();
  return insertRow(context.qr, 'organization', {
    organization_code: spec.code,
    name: spec.name,
    short_name: spec.shortName,
    contact_name: '测试联系人',
    contact_phone: null,
    contact_email: null,
    address: null,
    remark: 'V13 开发 Mock 数据，仅用于开发联调',
    is_service_provider: 1,
    is_managed_company: 1,
    kind: 'PEER',
    status: 'ACTIVE',
    created_at: new Date('2026-11-05T00:30:00.000Z'),
    updated_at: new Date('2026-11-05T00:30:00.000Z'),
  });
}

export async function resolveOrganizationIds(context: PackContext): Promise<OrganizationIds> {
  return {
    platform: await resolvePlatformOrganization(context),
    A: await ensureOrganization(context, 'A'),
    B: await ensureOrganization(context, 'B'),
  };
}

export function organizationIdFor(
  ids: OrganizationIds,
  key: 'PLATFORM' | OrganizationKey | null,
): number | null {
  if (key === null) return null;
  if (key === 'PLATFORM') return ids.platform;
  return ids[key];
}

export async function requireOrganizationId(
  context: PackContext,
  key: 'PLATFORM' | OrganizationKey,
): Promise<number> {
  if (key === 'PLATFORM') {
    const rows = await findMany(
      context.qr,
      'organization',
      { kind: 'CLIENT', status: 'ACTIVE', is_managed_company: 0 },
      'id ASC',
      1,
    );
    if (!rows[0]) {
      throw new MockConflictError('缺少平台组织，请先运行 p0-org-accounts');
    }
    return readNumber(rows[0], 'id');
  }
  const spec = ORGANIZATIONS.find((item) => item.key === key);
  const row = spec
    ? await findOne(context.qr, 'organization', { organization_code: spec.code })
    : null;
  if (!row) {
    throw new MockConflictError(`缺少组织 ${key}，请先运行 p0-org-accounts`);
  }
  return readNumber(row, 'id');
}

export async function requireAccountId(context: PackContext, accountKey: string): Promise<number> {
  const spec = ACCOUNTS.find((item) => item.key === accountKey);
  if (!spec) {
    throw new MockWriteError(`未知账号键 ${accountKey}`);
  }
  const row = await findOne(context.qr, 'base_user_account', { login_name: spec.loginName });
  if (!row) {
    throw new MockConflictError(`缺少账号 ${spec.loginName}，请先运行 p0-org-accounts`);
  }
  return readNumber(row, 'id');
}

export async function findAccountId(
  context: PackContext,
  accountKey: string,
): Promise<number | null> {
  const spec = ACCOUNTS.find((item) => item.key === accountKey);
  if (!spec) {
    throw new MockWriteError(`未知账号键 ${accountKey}`);
  }
  const row = await findOne(context.qr, 'base_user_account', { login_name: spec.loginName });
  return row ? readNumber(row, 'id') : null;
}

export interface ResolvedModel {
  readonly id: number;
  readonly modelCode: string;
  readonly modelName: string;
  readonly mock: boolean;
}

/** 机型优先复用开发库已有启用项；不足时才补测试机型。 */
export async function resolveModels(context: PackContext): Promise<ResolvedModel[]> {
  const rows = await findMany(
    context.qr,
    'equipment_model',
    { enabled: 1 },
    'sort_order ASC, id ASC',
    2,
  );
  return rows.map((row) => ({
    id: readNumber(row, 'id'),
    modelCode: readString(row, 'model_code'),
    modelName: readString(row, 'model_name'),
    mock: readString(row, 'model_code').startsWith('MOCK-V13-'),
  }));
}

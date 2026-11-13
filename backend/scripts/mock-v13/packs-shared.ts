// scripts/mock-v13/packs-shared.ts

/**
 * 数据包共享工具：字段加密、组织/账号解析、稳定键查询。
 */

import { createFieldCipher } from '@src/infrastructure/field-encryption/field-encryption.cipher';

import { MockConflictError, MockVerificationError, MockWriteError } from './errors';
import { FileRegistry } from './files';
import { asRows, findMany, findOne, insertRow, MockQueryRunner, Row, updateRow } from './db';
import { ACCOUNTS, AccountSpec, OrganizationKey, ORGANIZATIONS, mockEmail } from './manifest';
import { RunReport } from './report';
import { parseRoleArrayValue } from './roles';

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

function asReferenceText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRoleArray(value: unknown, label: string): string[] {
  const parsed = parseRoleArrayValue(value);
  if (!parsed) {
    throw new MockVerificationError(`${label} 不是合法角色数组`);
  }
  return parsed;
}

export function organizationCodeOf(key: OrganizationKey): string {
  const organization = ORGANIZATIONS.find((item) => item.key === key);
  if (!organization) {
    throw new MockVerificationError(`未知组织键: ${key}`);
  }
  return organization.code;
}

async function organizationIdByCode(
  queryRunner: MockQueryRunner,
  organizationCode: string,
): Promise<number | null> {
  const organization = await findOne(queryRunner, 'organization', {
    organization_code: organizationCode,
  });
  return organization ? readNumber(organization, 'id') : null;
}

/**
 * 逐账号核对登录名、账号状态、资料状态、角色、等级与可信归属。
 *
 * 只按总数判断会被“对照客户补足总数”绕过；任一事实不符都判定失败，
 * 且不自动修复、不重置密码、不覆盖昵称。
 */
export async function collectAccountFailures(
  context: PackContext,
  specs: readonly AccountSpec[],
): Promise<string[]> {
  const queryRunner = context.qr;
  const failed: string[] = [];
  const check = (condition: boolean, message: string): void => {
    if (!condition) failed.push(message);
  };

  for (const spec of specs) {
    const account = await findOne(queryRunner, 'base_user_account', {
      login_name: spec.loginName,
    });
    if (!account) {
      failed.push(`${spec.loginName}: 账号缺失`);
      continue;
    }
    const accountId = Number(account.id);
    check(
      asReferenceText(account.login_email) === mockEmail(spec.loginName),
      `${spec.loginName}: 登录邮箱不一致`,
    );
    check(
      asReferenceText(account.status) === spec.accountStatus,
      `${spec.loginName}: 账号状态 ${asReferenceText(account.status)} != ${spec.accountStatus}`,
    );
    check(
      asReferenceText(account.identity_hint) === spec.role,
      `${spec.loginName}: 账号角色 ${asReferenceText(account.identity_hint)} != ${spec.role}`,
    );
    const adminLevel = account.admin_level === null ? null : Number(account.admin_level);
    check(
      adminLevel === spec.adminLevel,
      `${spec.loginName}: 管理员等级 ${String(adminLevel)} != ${String(spec.adminLevel)}`,
    );

    const info = await findOne(queryRunner, 'base_user_info', { account_id: accountId });
    if (!info) {
      failed.push(`${spec.loginName}: 用户资料缺失`);
      continue;
    }
    check(
      asReferenceText(info.user_state) === spec.userState,
      `${spec.loginName}: 资料状态 ${asReferenceText(info.user_state)} != ${spec.userState}`,
    );
    const accessGroup = asRoleArray(info.access_group, `${spec.loginName} access_group`);
    check(
      accessGroup.length === 1 && accessGroup[0] === spec.role,
      `${spec.loginName}: 资料角色 [${accessGroup.join(',')}] 与账号角色 ${spec.role} 不一致`,
    );

    const digestRoles = asRoleArray(
      context.encryption.decrypt(asReferenceText(info.meta_digest)),
      `${spec.loginName} meta_digest`,
    );
    check(
      digestRoles.length === 1 && digestRoles[0] === spec.role,
      `${spec.loginName}: meta_digest 角色 [${digestRoles.join(',')}] 与账号角色 ${spec.role} 不一致`,
    );

    const expectedProfileOrganizationId =
      spec.profileOrganization === null
        ? null
        : await organizationIdByCode(queryRunner, organizationCodeOf(spec.profileOrganization));
    const profileOrganizationId =
      info.customer_organization_id === null ? null : Number(info.customer_organization_id);
    check(
      profileOrganizationId === expectedProfileOrganizationId,
      `${spec.loginName}: 资料归属公司 ${String(profileOrganizationId)} != ${String(
        expectedProfileOrganizationId,
      )}`,
    );

    const memberships = asRows(
      await queryRunner.query(
        `SELECT o.organization_code, o.is_managed_company, o.status AS organization_status,
                m.member_role, m.status
           FROM organization_membership m
           JOIN organization o ON o.id = m.organization_id
          WHERE m.account_id = ? AND m.status = 'ACTIVE'`,
        [accountId],
      ),
    );
    // 与正式组织解析口径一致：成员行有效不等于组织有效，组织停用即成员资格失效。
    const activeMemberships = memberships.filter(
      (membership) => asReferenceText(membership.organization_status) === 'ACTIVE',
    );
    if (activeMemberships.length !== memberships.length) {
      failed.push(`${spec.loginName}: 成员关系所属组织不是 ACTIVE（成员有效不等于组织有效）`);
    }
    if (spec.organization === null) {
      check(activeMemberships.length === 0, `${spec.loginName}: 不应存在有效组织成员关系`);
    } else if (spec.organization === 'PLATFORM') {
      check(
        activeMemberships.length === 1 && Number(activeMemberships[0].is_managed_company) === 0,
        `${spec.loginName}: 平台归属成员关系缺失或异常`,
      );
      check(
        activeMemberships.length === 1 &&
          asReferenceText(activeMemberships[0].member_role) === spec.role,
        `${spec.loginName}: 平台成员角色与账号角色不一致`,
      );
    } else {
      const expectedCode = organizationCodeOf(spec.organization);
      check(
        activeMemberships.length === 1 &&
          asReferenceText(activeMemberships[0].organization_code) === expectedCode,
        `${spec.loginName}: 组织归属不是 ${expectedCode}`,
      );
      check(
        activeMemberships.length === 1 &&
          asReferenceText(activeMemberships[0].member_role) === spec.role,
        `${spec.loginName}: 成员角色与账号角色不一致`,
      );
    }
  }
  return failed;
}

/**
 * 分包复用前，按该包实际引用的账号执行同一套逐账号事实校验。
 *
 * 在写行或写文件之前调用；异常即拒绝，不要求重跑账号包，
 * 也不自动启用账号、重置密码或覆盖昵称。
 */
export async function assertAccountsEligible(
  context: PackContext,
  accountKeys: readonly string[],
  label: string,
): Promise<void> {
  const uniqueKeys = [...new Set(accountKeys)].sort();
  const specs: AccountSpec[] = [];
  for (const key of uniqueKeys) {
    const spec = ACCOUNTS.find((item) => item.key === key);
    if (!spec) {
      throw new MockWriteError(`${label} 引用了未知账号键 ${key}`);
    }
    specs.push(spec);
  }
  if (specs.length === 0) return;
  const failed = await collectAccountFailures(context, specs);
  if (failed.length > 0) {
    throw new MockVerificationError(
      `${label} 引用的账号事实校验失败（拒绝写入，不自动启用/重置密码/覆盖昵称）：${failed.join('；')}`,
    );
  }
  context.report.note(`${label} 复用前账号校验通过：${uniqueKeys.join(', ')}`);
}

export interface StoredFileExpectation {
  readonly fileId: string;
  readonly storageReference: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
  readonly businessType: string;
  readonly uploaderAccountId: number;
  readonly ownerOrganizationId: number;
}

/**
 * 复用已有原件行前核对归属、用途、文件事实与库内 SHA-256。
 * 任一不符都拒绝并保留原值，不做“就地修正”。
 */
export function assertStoredFileMatches(existing: Row, expected: StoredFileExpectation): void {
  const mismatches: string[] = [];
  const text = (key: string): string => asReferenceText(existing[key]);
  const compareText = (key: string, value: string): void => {
    if (text(key) !== value) {
      mismatches.push(`${key}=${text(key)} != ${value}`);
    }
  };
  compareText('storage_reference', expected.storageReference);
  compareText('original_filename', expected.originalFilename);
  compareText('mime_type', expected.mimeType);
  compareText('checksum_sha256', expected.checksumSha256);
  compareText('business_type', expected.businessType);
  compareText('status', 'VALID');
  if (Number(existing.byte_size) !== expected.byteSize) {
    mismatches.push(`byte_size=${String(existing.byte_size)} != ${expected.byteSize}`);
  }
  if (Number(existing.uploaded_by_account_id) !== expected.uploaderAccountId) {
    mismatches.push(
      `uploaded_by_account_id=${String(existing.uploaded_by_account_id)} != ${expected.uploaderAccountId}`,
    );
  }
  if (Number(existing.owner_organization_id) !== expected.ownerOrganizationId) {
    mismatches.push(
      `owner_organization_id=${String(existing.owner_organization_id)} != ${expected.ownerOrganizationId}`,
    );
  }
  if (mismatches.length > 0) {
    throw new MockConflictError(
      `已有原件 ${expected.fileId} 与本次引用不一致，拒绝复用并保留原值：${mismatches.join('；')}`,
    );
  }
}

export interface StoredFileBindingInput {
  readonly fileId: string;
  readonly businessType: string;
  readonly businessId: string;
  readonly checksumSha256: string;
  /** 只有本事务新建且仍未绑定的原件行才允许补绑。 */
  readonly createdInThisRun: boolean;
}

/**
 * 绑定或核对原件行：
 * - 已绑定：必须恰好指向本目标，只读不写；
 * - 未绑定：仅允许本事务新建的行，带明确条件更新并确认恰好命中一行；
 * - 改绑、跨事务补绑或身份不明：拒绝并保留原值。
 */
export async function bindStoredFile(
  context: PackContext,
  input: StoredFileBindingInput,
): Promise<'REUSED' | 'BOUND'> {
  const row = await findOne(context.qr, 'stored_file', { file_id: input.fileId });
  if (!row) {
    throw new MockConflictError(`原件行 ${input.fileId} 不存在，拒绝绑定`);
  }
  if (asReferenceText(row.business_type) !== input.businessType) {
    throw new MockConflictError(
      `原件 ${input.fileId} 的用途 ${asReferenceText(row.business_type)} != ${input.businessType}，拒绝改绑`,
    );
  }
  const bindingStatus = asReferenceText(row.binding_status);
  const rawBusinessId = row.business_id;
  const businessId =
    rawBusinessId === null
      ? null
      : typeof rawBusinessId === 'string' || typeof rawBusinessId === 'number'
        ? String(rawBusinessId)
        : '';
  if (bindingStatus === 'BOUND') {
    if (businessId !== input.businessId) {
      throw new MockConflictError(
        `原件 ${input.fileId} 已绑定到 ${String(businessId)}，拒绝改绑到 ${input.businessId}`,
      );
    }
    return 'REUSED';
  }
  if (bindingStatus !== 'TEMPORARY' || businessId !== null) {
    throw new MockConflictError(
      `原件 ${input.fileId} 绑定状态异常（${bindingStatus}/${String(businessId)}），拒绝复用`,
    );
  }
  if (!input.createdInThisRun) {
    throw new MockConflictError(`原件 ${input.fileId} 不是本事务新建的未绑定行，拒绝跨事务补绑`);
  }
  const affected = await updateRow(
    context.qr,
    'stored_file',
    {
      file_id: input.fileId,
      business_type: input.businessType,
      checksum_sha256: input.checksumSha256,
      binding_status: 'TEMPORARY',
      business_id: null,
    },
    { business_id: input.businessId, binding_status: 'BOUND' },
  );
  if (affected !== 1) {
    throw new MockConflictError(
      `原件 ${input.fileId} 绑定更新命中 ${affected} 行（要求恰好 1 行），拒绝继续`,
    );
  }
  const confirmed = await findOne(context.qr, 'stored_file', {
    file_id: input.fileId,
    binding_status: 'BOUND',
    business_id: input.businessId,
  });
  if (!confirmed) {
    throw new MockConflictError(`原件 ${input.fileId} 绑定后独立读回不一致，拒绝继续`);
  }
  return 'BOUND';
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

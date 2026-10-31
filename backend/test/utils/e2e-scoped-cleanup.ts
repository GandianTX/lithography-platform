// test/utils/e2e-scoped-cleanup.ts
//
// PR0 独立终审 R02：带双门禁、归属核验与引用闭包的窄范围清理执行器。
//
// 三道约束互相独立，任一门禁缺失都必须在第一条删除语句前失败关闭：
// 1. 物理清理许可：assertPhysicalCleanupConsent（只读 E2E_ALLOW_PHYSICAL_CLEANUP=1，刻意不读库名）；
// 2. 目标库白名单：assertDataSourceOnAllowedE2eDatabase（只 SELECT DATABASE() 校验，刻意不读许可开关）；
// 3. 归属范围：残留自然键只用于定位候选，必须逐字段匹配已知测试指纹；
//    本轮资源以数据库生成 ID 登记，删除阶段只接收预检通过的精确 ID。
//
// 预检与删除在同一事务内完成；根行先加锁，再发现并锁投稿/资料，最后做引用闭包校验。
// 任何归属冲突或集合外入向引用都会在第一条 DELETE 之前抛错，保证零删除。

import type { DataSource, EntityManager } from 'typeorm';
import {
  assertDataSourceOnAllowedE2eDatabase,
  assertManagerOnExpectedE2eDatabase,
  assertPhysicalCleanupConsent,
  resolveExpectedE2eDatabase,
} from './e2e-db-guard';
import type { TestAccountConfig } from './test-accounts';
import type { TestOrganizationSpec } from './test-organizations';

export type OwnedResourceCategory =
  | 'organization'
  | 'account'
  | 'membership'
  | 'submission'
  | 'revision'
  | 'attachment'
  | 'materialDetail'
  | 'faultCaseDetail'
  | 'review'
  | 'document'
  | 'documentCaseDetail'
  | 'equipmentModel'
  | 'thirdPartyAuth'
  | 'verificationRecord'
  | 'repairRequest'
  | 'engineerResponse'
  | 'engineerRegistrationApplication';

type OwnedIdKey = Exclude<keyof OwnedResourceLedger, 'facts'>;

const LEDGER_KEY_BY_CATEGORY: Record<OwnedResourceCategory, OwnedIdKey> = {
  organization: 'organizationIds',
  account: 'accountIds',
  membership: 'membershipIds',
  submission: 'submissionIds',
  revision: 'revisionIds',
  attachment: 'attachmentIds',
  materialDetail: 'materialDetailIds',
  faultCaseDetail: 'faultCaseDetailIds',
  review: 'reviewIds',
  document: 'documentIds',
  documentCaseDetail: 'documentCaseDetailIds',
  equipmentModel: 'equipmentModelIds',
  thirdPartyAuth: 'thirdPartyAuthIds',
  verificationRecord: 'verificationRecordIds',
  repairRequest: 'repairRequestIds',
  engineerResponse: 'engineerResponseIds',
  engineerRegistrationApplication: 'engineerRegistrationApplicationIds',
};

/**
 * 本轮资源的最小预期事实（R02）。
 *
 * 登记真实 ID 只证明“这行由本轮创建”，删除前仍必须核对证明归属的关键字段；
 * 预期事实来自受控创建输入/返回值，清理阶段不得读取当前值反填。
 * 合法受控写入改变了事实时，调用方必须在写入成功后显式 `updateOwnedExpectation`。
 */
export interface OwnedOrganizationFacts {
  readonly organizationCode: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
}

export interface OwnedAccountFacts {
  readonly loginName: string | null;
  readonly loginEmail: string | null;
  readonly status: string;
  readonly identityHint: string | null;
  readonly accessGroup: readonly string[];
  /**
   * 用户资料（base_user_info）的最小预期（N01）：
   * - 昵称、资料邮箱、资料状态必须与账号本身字段分开登记；
   * - 账号存在但本应存在的资料缺失，清理预检必须拒绝，而不是跳过比对。
   */
  readonly nickname: string;
  readonly userInfoEmail: string | null;
  readonly userState: string;
}

export interface OwnedMembershipFacts {
  readonly organizationId: number;
  readonly accountId: number;
  readonly memberRole: string;
  readonly status: string;
}

export interface OwnedDocumentFacts {
  readonly ownerOrganizationId: number;
  readonly createdByAccountId: number;
  readonly sourceSubmissionId: number | null;
  readonly sourceRevisionId: number | null;
  readonly equipmentModelId: number | null;
}

export interface OwnedEquipmentModelFacts {
  readonly modelCode: string;
  readonly modelName: string;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

export interface OwnedThirdPartyAuthFacts {
  readonly accountId: number;
  readonly provider: string;
  readonly providerUserId: string;
  readonly unionId: string | null;
}

export interface OwnedVerificationRecordFacts {
  readonly type: string;
  readonly targetAccountId: number | null;
  readonly subjectType: string | null;
  readonly subjectId: number | null;
  readonly issuedByAccountId: number | null;
  readonly payload: Record<string, unknown> | null;
}

export interface OwnedRepairRequestFacts {
  readonly requestNo: string;
  readonly customerAccountId: number;
  readonly equipmentModelId: number;
  readonly errorCode: string;
  readonly faultDescription: string;
  // content_md 由服务端按受控规则生成，接口不返回；归属证明不依赖该派生列。
  // 接单/撤回等合法状态变化不改变归属，故也不纳入预期事实。
}

export interface OwnedEngineerResponseFacts {
  readonly requestId: number;
  readonly engineerAccountId: number;
  readonly customerAccountId: number;
  readonly responseText: string;
  readonly resolutionStatus: string;
}

/**
 * 工程师注册申请的本轮归属事实。
 *
 * 只登记不可变归属字段：`account_id` / `organization_id` / `application_note`。
 * `status` 与审核意见会由合法审核写入改变（PENDING → APPROVED/REJECTED），
 * 不属于归属证明，故刻意不纳入预期事实；本轮登记的真实申请 ID 仍是删除前提。
 */
export interface OwnedEngineerRegistrationApplicationFacts {
  readonly accountId: number;
  readonly organizationId: number;
  readonly applicationNote: string | null;
}

/** 登记时允许携带预期事实的类别（其余类别的归属由既有父子关系核验证明）。 */
export interface OwnedFactsByCategory {
  organization: OwnedOrganizationFacts;
  account: OwnedAccountFacts;
  membership: OwnedMembershipFacts;
  document: OwnedDocumentFacts;
  equipmentModel: OwnedEquipmentModelFacts;
  thirdPartyAuth: OwnedThirdPartyAuthFacts;
  verificationRecord: OwnedVerificationRecordFacts;
  repairRequest: OwnedRepairRequestFacts;
  engineerResponse: OwnedEngineerResponseFacts;
  engineerRegistrationApplication: OwnedEngineerRegistrationApplicationFacts;
}

export type FactBearingCategory = keyof OwnedFactsByCategory;

export type OwnedResourceFacts = {
  readonly [C in FactBearingCategory]: Map<number, OwnedFactsByCategory[C]>;
};

export interface OwnedResourceLedger {
  organizationIds: number[];
  accountIds: number[];
  membershipIds: number[];
  submissionIds: number[];
  revisionIds: number[];
  attachmentIds: number[];
  materialDetailIds: number[];
  faultCaseDetailIds: number[];
  reviewIds: number[];
  documentIds: number[];
  documentCaseDetailIds: number[];
  equipmentModelIds: number[];
  /** 第三方登录绑定：1:1 从属于已核验账号，只登记数据库真实生成 ID */
  thirdPartyAuthIds: number[];
  /** 验证记录：必须登记创建返回的真实 ID，不能按目标账号/类型整批接管 */
  verificationRecordIds: number[];
  /** 维修申请：登记实际创建 ID，并核验客户/型号/接单工程师关系 */
  repairRequestIds: number[];
  /** 工程师回复：登记实际创建 ID，并核验父申请与参与人关系 */
  engineerResponseIds: number[];
  /**
   * 工程师自助注册申请：登记实际创建 ID，并核验申请人/目标组织/申请说明。
   * 申请行对账号与组织均为 FK RESTRICT，必须先于它们删除，否则账号/组织回收会被外键阻断。
   */
  engineerRegistrationApplicationIds: number[];
  /**
   * 按类别登记的最小预期事实；每个已登记 ID 必须有对应事实，
   * 缺失即失败关闭，绝不回退为“只按 ID 删除”。
   */
  facts: OwnedResourceFacts;
}

/**
 * 残留账号的完整指纹：自然键只用于定位，以下字段必须逐项匹配才允许回收。
 * fixture 账号可用 `toResidueAccountFingerprint` 从 `TestAccountConfig` 生成；
 * 规格内临时账号（如管理员新建用户）显式提供其真实字段。
 */
export interface ResidueAccountFingerprint {
  readonly loginName?: string | null;
  readonly loginEmail: string;
  readonly status: number | string;
  readonly identityHint: string | null;
  readonly nickname: string;
  readonly accessGroup: readonly string[];
  /**
   * `meta_digest` 是加密存储列（原始查询只能看到密文），调用方若持有期望密文可显式传入；
   * 未提供时按“非空密文存在”校验（角色集合已由 `accessGroup` 全量匹配）。
   */
  readonly metaDigest?: string | null;
}

/** fixture 账号 → 残留指纹（昵称/metaDigest 由 createTestAccount 固定生成）。 */
export const toResidueAccountFingerprint = (
  config: TestAccountConfig,
): ResidueAccountFingerprint => ({
  loginName: config.loginName,
  loginEmail: config.loginEmail,
  status: config.status,
  identityHint: config.identityType,
  nickname: `${config.loginName}_nickname`,
  accessGroup: config.accessGroup,
});

/** 残留机型指纹：按 model_code 定位，字段全部匹配才回收（固定 id 不构成归属证明）。 */
export interface ResidueEquipmentModelFingerprint {
  readonly modelCode: string;
  readonly modelName: string;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

export const createOwnedResourceLedger = (): OwnedResourceLedger => ({
  organizationIds: [],
  accountIds: [],
  membershipIds: [],
  submissionIds: [],
  revisionIds: [],
  attachmentIds: [],
  materialDetailIds: [],
  faultCaseDetailIds: [],
  reviewIds: [],
  documentIds: [],
  documentCaseDetailIds: [],
  equipmentModelIds: [],
  thirdPartyAuthIds: [],
  verificationRecordIds: [],
  repairRequestIds: [],
  engineerResponseIds: [],
  engineerRegistrationApplicationIds: [],
  facts: {
    organization: new Map(),
    account: new Map(),
    membership: new Map(),
    document: new Map(),
    equipmentModel: new Map(),
    thirdPartyAuth: new Map(),
    verificationRecord: new Map(),
    repairRequest: new Map(),
    engineerResponse: new Map(),
    engineerRegistrationApplication: new Map(),
  },
});

/**
 * 残留第三方绑定指纹：账号自然键只用于定位，绑定 `provider + provider_user_id`
 * 与 `union_id` 必须逐项匹配；外部账号的同 provider 绑定绝不被接管。
 */
export interface ResidueThirdPartyAuthFingerprint {
  readonly accountLoginName: string;
  readonly provider: string;
  readonly providerUserId: string;
  readonly unionId: string | null;
}

/**
 * 残留验证记录指纹：必须至少给出目标账号或签发账号之一，并同时匹配记录类型
 * 与载荷内容；不能只按“目标账号是测试账号”或“类型是 PASSWORD_RESET”整批接管。
 */
export interface ResidueVerificationRecordFingerprint {
  readonly type: string;
  readonly targetAccountLoginName?: string | null;
  readonly issuedByAccountLoginName?: string | null;
  readonly payload: Record<string, unknown> | null;
}

/**
 * 残留维修申请指纹：`request_no` 只用于定位，客户账号、型号与全部不可变正文
 * 必须逐字段匹配；外部客户/型号的同编号记录拒绝接管。
 */
export interface ResidueRepairRequestFingerprint {
  readonly requestNo: string;
  readonly customerAccountLoginName: string;
  readonly equipmentModelCode: string;
  readonly errorCode: string;
  readonly faultDescription: string;
  readonly contentMd: string;
}

/**
 * 残留工程师回复指纹：定位到父申请后仍要求工程师账号与正文/状态逐项匹配。
 * 回复没有业务自然键，正文与状态即内容指纹。
 */
export interface ResidueEngineerResponseFingerprint {
  readonly requestNo: string;
  readonly engineerAccountLoginName: string;
  readonly responseText: string;
  readonly resolutionStatus: string;
}

const assertPositiveId = (category: OwnedResourceCategory, id: number): void => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`清理资源登记失败：${category} ID 必须为正整数，收到 ${String(id)}`);
  }
};

/**
 * 登记数据库真实生成 ID；只接受正整数并按类别去重。
 *
 * 需要预期事实的类别必须同时传入事实（R02）；调用方不得只登记 ID 后依赖清理器豁免核验。
 */
export function recordOwnedResource<C extends FactBearingCategory>(
  ledger: OwnedResourceLedger,
  category: C,
  id: number,
  facts: OwnedFactsByCategory[C],
): number;
export function recordOwnedResource(
  ledger: OwnedResourceLedger,
  category: Exclude<OwnedResourceCategory, FactBearingCategory>,
  id: number,
): number;
export function recordOwnedResource(
  ledger: OwnedResourceLedger,
  category: OwnedResourceCategory,
  id: number,
  facts?: OwnedFactsByCategory[FactBearingCategory],
): number {
  assertPositiveId(category, id);
  const key = LEDGER_KEY_BY_CATEGORY[category];
  const ids = ledger[key];
  if (!ids.includes(id)) {
    ids.push(id);
  }
  if (facts !== undefined) {
    if (!(category in ledger.facts)) {
      throw new Error(`清理资源登记失败：类别 ${category} 不接受预期事实登记`);
    }
    const factsById = ledger.facts[category as FactBearingCategory] as unknown as Map<
      number,
      OwnedFactsByCategory[FactBearingCategory]
    >;
    factsById.set(id, cloneFacts(facts));
  }
  return id;
}

/**
 * 受控写入成功后显式更新预期事实（R02）。
 *
 * 只允许更新已登记资源；禁止在清理阶段用数据库当前值反填，也禁止为未登记 ID 凭空创建预期。
 */
export function updateOwnedExpectation<C extends FactBearingCategory>(
  ledger: OwnedResourceLedger,
  category: C,
  id: number,
  patch: Partial<OwnedFactsByCategory[C]>,
): void {
  assertPositiveId(category, id);
  const factsById = ledger.facts[category] as Map<number, OwnedFactsByCategory[C]>;
  const current = factsById.get(id);
  if (current === undefined) {
    throw new Error(`清理预期更新失败：${category} ${id} 未登记预期事实，拒绝用猜测值补登记`);
  }
  factsById.set(id, cloneFacts({ ...cloneFacts(current), ...cloneFacts(patch) }));
}

const toIdList = (ids: readonly number[]): number[] => [...new Set(ids)].filter((id) => id > 0);

/**
 * 台账事实必须与创建输入/补丁完全隔离（N02）。
 *
 * 只保存深拷贝，不保存调用方的根对象、数组或 payload 嵌套引用：
 * 创建后修改输入对象、patch 对象或另一个台账，都不得静默改写本台账的预期。
 */
const cloneFacts = <T>(facts: T): T => structuredClone(facts);

const inClause = (values: readonly (string | number)[]): string => values.map(() => '?').join(', ');

const asNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`清理预检失败：数据库返回了非整数 ID（${String(value)}）`);
  }
  return parsed;
};

const normalizeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/**
 * JSON 列不保证键序：预检按“对象键排序、数组保序”的规范化形式做深比较，
 * 否则同一载荷因 MySQL JSON 归一化键序就会被误判为事实漂移。
 */
const canonicalJson = (value: unknown): unknown => {
  const normalized = normalizeJson(value);
  if (Array.isArray(normalized)) {
    return normalized.map(canonicalJson);
  }
  if (normalized !== null && typeof normalized === 'object') {
    const entries = Object.entries(normalized as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalJson(entry)]));
  }
  return normalized;
};

const sameJson = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(canonicalJson(actual)) === JSON.stringify(canonicalJson(expected));

const conflict = (helper: string, category: string, ref: string, reason: string): never => {
  throw new Error(`[${helper}] 阶段=归属预检 拒绝删除：${category} ${ref} ${reason}`);
};

interface CleanupPlan {
  organizationIds: number[];
  accountIds: number[];
  membershipIds: number[];
  submissionIds: number[];
  revisionIds: number[];
  attachmentIds: number[];
  materialDetailIds: number[];
  faultCaseDetailIds: number[];
  reviewIds: number[];
  documentIds: number[];
  documentCaseDetailIds: number[];
  equipmentModelIds: number[];
  thirdPartyAuthIds: number[];
  verificationRecordIds: number[];
  repairRequestIds: number[];
  engineerResponseIds: number[];
  engineerRegistrationApplicationIds: number[];
}

const emptyPlan = (): CleanupPlan => ({
  organizationIds: [],
  accountIds: [],
  membershipIds: [],
  submissionIds: [],
  revisionIds: [],
  attachmentIds: [],
  materialDetailIds: [],
  faultCaseDetailIds: [],
  reviewIds: [],
  documentIds: [],
  documentCaseDetailIds: [],
  equipmentModelIds: [],
  thirdPartyAuthIds: [],
  verificationRecordIds: [],
  repairRequestIds: [],
  engineerResponseIds: [],
  engineerRegistrationApplicationIds: [],
});

const hasAnyResource = (plan: CleanupPlan): boolean =>
  Object.values(plan).some((ids) => ids.length > 0);

const addIds = (target: number[], ids: readonly number[]): void => {
  for (const id of ids) {
    if (!target.includes(id)) {
      target.push(id);
    }
  }
};

interface OrganizationRow {
  id: number;
  organization_code: string;
  name: string;
  kind: string;
  status: string;
}

interface EngineerRegistrationApplicationRow {
  id: number;
  account_id: number;
  organization_id: number;
  application_note: string | null;
}

interface AccountRow {
  id: number;
  login_name: string | null;
  login_email: string | null;
  status: unknown;
  identity_hint: string | null;
  user_info_id: number | null;
  nickname: string | null;
  user_info_email: string | null;
  access_group: unknown;
  meta_digest: unknown;
  user_state: string | null;
}

interface EquipmentModelRow {
  id: number;
  model_code: string;
  model_name: string;
  enabled: unknown;
  sort_order: unknown;
}

interface MembershipRow {
  id: number;
  organization_id: number;
  account_id: number;
  member_role: string;
  status: string;
}

interface SubmissionRow {
  id: number;
  owner_organization_id: number;
  submitted_by_account_id: number;
}

interface RevisionRow {
  id: number;
  submission_id: number;
  attachment_id: number | null;
  confirmed_by_account_id: number;
}

interface AttachmentRow {
  id: number;
  submission_id: number;
  uploaded_by_account_id: number;
}

interface ReviewRow {
  id: number;
  submission_id: number;
  revision_id: number | null;
  reviewed_by_account_id: number;
}

interface DetailRow {
  submission_id: number;
  equipment_model_id: number | null;
}

interface DocumentRow {
  id: number;
  owner_organization_id: number;
  created_by_account_id: number;
  updated_by_account_id: number | null;
  source_submission_id: number | null;
  source_revision_id: number | null;
  equipment_model_id: number | null;
}

interface DocumentCaseDetailRow {
  document_id: number;
}

interface ThirdPartyAuthRow {
  id: number;
  account_id: number;
  provider: string;
  provider_user_id: string;
  union_id: string | null;
}

interface VerificationRecordRow {
  id: number;
  type: string;
  target_account_id: number | null;
  subject_type: string | null;
  subject_id: number | null;
  payload: unknown;
  issued_by_account_id: number | null;
  consumed_by_account_id: number | null;
}

interface RepairRequestRow {
  id: number;
  request_no: string;
  customer_account_id: number;
  equipment_model_id: number;
  error_code: string;
  fault_description: string;
  content_md: string;
  is_accepted: unknown;
  accepted_by_engineer_account_id: number | null;
  deprecated: unknown;
}

interface EngineerResponseRow {
  id: number;
  request_id: number;
  engineer_account_id: number;
  customer_account_id: number;
  resolution_status: string;
  response_text: string;
}

/**
 * 残留恢复：自然键只能定位候选，逐字段指纹匹配通过后才把精确 ID 并入删除集合。
 * 匹配失败即冲突，绝不接管同名异主账号/组织。
 */
interface ResidueResolution {
  readonly retainedAccountIds: number[];
  readonly accountIdByLoginName: Map<string, number>;
  readonly equipmentModelIdByCode: Map<string, number>;
}

const resolveResidue = async (
  manager: EntityManager,
  residue: NonNullable<Parameters<typeof runGuardedSpecCleanup>[0]['residue']>,
  retainedAccounts: readonly ResidueAccountFingerprint[],
  helper: string,
  plan: CleanupPlan,
): Promise<ResidueResolution> => {
  const organizations = residue.organizations ?? [];
  const accounts = [...(residue.accounts ?? []), ...retainedAccounts];
  const equipmentModels = residue.equipmentModels ?? [];
  const retainedLoginKeys = new Set(
    retainedAccounts.flatMap((spec) => [spec.loginName, spec.loginEmail]).filter(Boolean),
  );
  const retainedAccountIds: number[] = [];
  const accountIdByLoginName = new Map<string, number>();
  const equipmentModelIdByCode = new Map<string, number>();

  if (organizations.length > 0) {
    const codes = [...new Set(organizations.map((spec) => spec.organizationCode))];
    const rows = await manager.query(
      `SELECT id, organization_code, name, kind, status
         FROM organization
        WHERE organization_code IN (${inClause(codes)})
        FOR UPDATE`,
      codes,
    );
    const rowByCode = new Map(
      (rows as OrganizationRow[]).map((row) => [row.organization_code, row]),
    );

    for (const spec of organizations) {
      const row = rowByCode.get(spec.organizationCode);
      if (!row) {
        continue;
      }
      if (row.name !== spec.name || row.kind !== spec.kind || row.status !== 'ACTIVE') {
        conflict(
          helper,
          'organization',
          spec.organizationCode,
          `已存在但指纹不符（name=${row.name}, kind=${row.kind}, status=${row.status}），拒绝接管`,
        );
      }
      addIds(plan.organizationIds, [asNumber(row.id)]);
    }
  }

  if (accounts.length > 0) {
    const loginNames = [
      ...new Set(accounts.map((spec) => spec.loginName).filter((name): name is string => !!name)),
    ];
    const loginEmails = [...new Set(accounts.map((spec) => spec.loginEmail).filter(Boolean))];
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (loginNames.length > 0) {
      conditions.push(`a.login_name IN (${inClause(loginNames)})`);
      params.push(...loginNames);
    }
    if (loginEmails.length > 0) {
      conditions.push(`a.login_email IN (${inClause(loginEmails)})`);
      params.push(...loginEmails);
    }
    if (conditions.length === 0) {
      return { retainedAccountIds, accountIdByLoginName, equipmentModelIdByCode };
    }

    const rows = await manager.query(
      `SELECT a.id, a.login_name, a.login_email, a.status, a.identity_hint,
              ui.nickname, ui.email AS user_info_email, ui.access_group, ui.meta_digest, ui.user_state
         FROM base_user_account a
         LEFT JOIN base_user_info ui ON ui.account_id = a.id
        WHERE ${conditions.join(' OR ')}
        FOR UPDATE`,
      params,
    );

    const rowsByLoginName = new Map<string, AccountRow[]>();
    const rowsByLoginEmail = new Map<string, AccountRow[]>();
    for (const row of rows as AccountRow[]) {
      if (row.login_name) {
        rowsByLoginName.set(row.login_name, [...(rowsByLoginName.get(row.login_name) ?? []), row]);
      }
      if (row.login_email) {
        rowsByLoginEmail.set(row.login_email, [
          ...(rowsByLoginEmail.get(row.login_email) ?? []),
          row,
        ]);
      }
    }

    for (const spec of accounts) {
      const candidates = [
        ...(spec.loginName ? (rowsByLoginName.get(spec.loginName) ?? []) : []),
        ...(rowsByLoginEmail.get(spec.loginEmail) ?? []),
      ]
        .filter(
          (row, index, all) =>
            all.findIndex((item) => Number(item.id) === Number(row.id)) === index,
        )
        // 残留指纹只服务于“上一轮崩溃留下的未知行”。已由创建证据登记的账号
        // 由 verifyOwnedExpectations 在删除前核对其最小预期事实（R02），
        // 合法受控变更必须先显式 updateOwnedExpectation；这里不再让 ID 豁免任何核验。
        .filter((row) => !plan.accountIds.includes(Number(row.id)));

      if (candidates.length === 0) {
        continue;
      }
      if (candidates.length > 1) {
        conflict(
          helper,
          'account',
          spec.loginName ?? spec.loginEmail,
          `自然键命中 ${candidates.length} 个不同账号（${candidates.map((row) => String(row.id)).join(', ')}），拒绝猜测`,
        );
      }

      const row = candidates[0];
      const mismatches: string[] = [];
      if ((row.login_name ?? null) !== (spec.loginName ?? null)) mismatches.push('login_name');
      if (row.login_email !== spec.loginEmail) mismatches.push('login_email');
      if (String(row.status) !== String(spec.status)) mismatches.push('status');
      if (row.identity_hint !== spec.identityHint) mismatches.push('identity_hint');
      if (row.nickname !== spec.nickname) mismatches.push('nickname');
      if (row.user_info_email !== spec.loginEmail) mismatches.push('user_info.email');
      if (!sameJson(row.access_group, spec.accessGroup)) mismatches.push('access_group');
      if (spec.metaDigest === undefined) {
        // 加密列无法由明文推导：只要求存在非空密文；角色事实由 access_group 全量匹配保证。
        if (typeof row.meta_digest !== 'string' || row.meta_digest.length === 0) {
          mismatches.push('meta_digest');
        }
      } else if ((row.meta_digest ?? null) !== spec.metaDigest) {
        mismatches.push('meta_digest');
      }
      if (row.user_state !== 'ACTIVE') mismatches.push('user_state');

      if (mismatches.length > 0) {
        conflict(
          helper,
          'account',
          spec.loginName ?? spec.loginEmail,
          `已存在但账号/用户信息指纹不符（${mismatches.join(', ')}），拒绝接管`,
        );
      }
      const isRetained =
        (spec.loginName !== null &&
          spec.loginName !== undefined &&
          retainedLoginKeys.has(spec.loginName)) ||
        retainedLoginKeys.has(spec.loginEmail);
      if (!isRetained) {
        addIds(plan.accountIds, [asNumber(row.id)]);
        if (spec.loginName) {
          accountIdByLoginName.set(spec.loginName, asNumber(row.id));
        }
      } else {
        addIds(retainedAccountIds, [asNumber(row.id)]);
      }
    }
  }

  if (equipmentModels.length > 0) {
    const modelCodes = [...new Set(equipmentModels.map((spec) => spec.modelCode))];
    const rows = await manager.query(
      `SELECT id, model_code, model_name, enabled, sort_order
         FROM equipment_model
        WHERE model_code IN (${inClause(modelCodes)})
        FOR UPDATE`,
      modelCodes,
    );
    const rowByCode = new Map((rows as EquipmentModelRow[]).map((row) => [row.model_code, row]));

    for (const spec of equipmentModels) {
      const row = rowByCode.get(spec.modelCode);
      if (!row) {
        continue;
      }
      if (plan.equipmentModelIds.includes(asNumber(row.id))) {
        // 本轮已登记型号由 verifyOwnedExpectations 核对其登记事实后才会删除；
        // 这里仅记录自然键映射，不再以“ID 已登记”跳过任何核验。
        equipmentModelIdByCode.set(spec.modelCode, asNumber(row.id));
        continue;
      }
      const enabled = row.enabled === true || Number(row.enabled) === 1;
      if (
        row.model_name !== spec.modelName ||
        enabled !== spec.enabled ||
        Number(row.sort_order) !== spec.sortOrder
      ) {
        conflict(
          helper,
          'equipmentModel',
          spec.modelCode,
          `已存在但指纹不符（model_name=${row.model_name}, enabled=${String(row.enabled)}, sort_order=${String(row.sort_order)}），拒绝接管`,
        );
      }
      addIds(plan.equipmentModelIds, [asNumber(row.id)]);
      equipmentModelIdByCode.set(spec.modelCode, asNumber(row.id));
    }
  }

  await resolveSpecialResidue(
    manager,
    residue,
    helper,
    plan,
    accountIdByLoginName,
    equipmentModelIdByCode,
  );

  return { retainedAccountIds, accountIdByLoginName, equipmentModelIdByCode };
};

/**
 * 残留的第三方绑定 / 验证记录 / 维修申请 / 工程师回复：仍按“自然键定位候选 →
 * 逐字段指纹 → 父链核验”的顺序进行，任何一条无法证明归属的候选都不接管。
 *
 * 这些类别不能因为“账号是本轮账号”就整批删除：
 * - 验证记录只按登记 ID 或完整 (type, target, payload) 指纹接管；
 * - 第三方绑定仅在该账号已被完整核验后按 provider 指纹接管；
 * - 维修申请按 request_no 定位后，客户/型号/正文全部匹配才接管；
 * - 工程师回复按父申请 + 工程师账号 + 正文/状态指纹接管。
 */
const resolveSpecialResidue = async (
  manager: EntityManager,
  residue: NonNullable<Parameters<typeof runGuardedSpecCleanup>[0]['residue']>,
  helper: string,
  plan: CleanupPlan,
  accountIdByLoginName: ReadonlyMap<string, number>,
  equipmentModelIdByCode: ReadonlyMap<string, number>,
): Promise<void> => {
  const thirdPartyAuths = residue.thirdPartyAuths ?? [];
  if (thirdPartyAuths.length > 0) {
    const accountIds = [
      ...new Set(
        thirdPartyAuths
          .map((spec) => accountIdByLoginName.get(spec.accountLoginName))
          .filter((id): id is number => id !== undefined),
      ),
    ];
    if (accountIds.length > 0) {
      const rows: ThirdPartyAuthRow[] = await manager.query(
        `SELECT id, account_id, provider, provider_user_id, union_id
           FROM base_third_party_auth
          WHERE account_id IN (${inClause(accountIds)})
          FOR UPDATE`,
        accountIds,
      );
      for (const spec of thirdPartyAuths) {
        const accountId = accountIdByLoginName.get(spec.accountLoginName);
        if (accountId === undefined) {
          continue;
        }
        const candidates = rows.filter(
          (row) =>
            !plan.thirdPartyAuthIds.includes(asNumber(row.id)) &&
            asNumber(row.account_id) === accountId &&
            row.provider === spec.provider,
        );
        if (candidates.length === 0) {
          continue;
        }
        if (candidates.length > 1) {
          conflict(
            helper,
            'thirdPartyAuth',
            spec.providerUserId,
            '同一账号/provider 命中多条绑定，拒绝猜测',
          );
        }
        const row = candidates[0];
        if (row.provider_user_id !== spec.providerUserId || row.union_id !== spec.unionId) {
          conflict(
            helper,
            'thirdPartyAuth',
            spec.providerUserId,
            `已存在但指纹不符（provider_user_id=${row.provider_user_id}, union_id=${String(row.union_id)}），拒绝接管`,
          );
        }
        addIds(plan.thirdPartyAuthIds, [asNumber(row.id)]);
      }
    }
  }

  const verificationRecords = residue.verificationRecords ?? [];
  if (verificationRecords.length > 0) {
    const targetIds = [
      ...new Set(
        verificationRecords
          .map((spec) =>
            spec.targetAccountLoginName
              ? accountIdByLoginName.get(spec.targetAccountLoginName)
              : undefined,
          )
          .filter((id): id is number => id !== undefined),
      ),
    ];
    const issuedByIds = [
      ...new Set(
        verificationRecords
          .map((spec) =>
            spec.issuedByAccountLoginName
              ? accountIdByLoginName.get(spec.issuedByAccountLoginName)
              : undefined,
          )
          .filter((id): id is number => id !== undefined),
      ),
    ];
    if (targetIds.length > 0 || issuedByIds.length > 0) {
      const conditions: string[] = [];
      const params: number[] = [];
      if (targetIds.length > 0) {
        conditions.push(`target_account_id IN (${inClause(targetIds)})`);
        params.push(...targetIds);
      }
      if (issuedByIds.length > 0) {
        conditions.push(`issued_by_account_id IN (${inClause(issuedByIds)})`);
        params.push(...issuedByIds);
      }
      const rows: VerificationRecordRow[] = await manager.query(
        `SELECT id, type, target_account_id, subject_type, subject_id, payload,
                issued_by_account_id, consumed_by_account_id
           FROM base_verification_record
          WHERE ${conditions.join(' OR ')}
          FOR UPDATE`,
        params,
      );
      for (const spec of verificationRecords) {
        const targetId = spec.targetAccountLoginName
          ? accountIdByLoginName.get(spec.targetAccountLoginName)
          : undefined;
        const issuedById = spec.issuedByAccountLoginName
          ? accountIdByLoginName.get(spec.issuedByAccountLoginName)
          : undefined;
        if (spec.targetAccountLoginName && targetId === undefined) {
          continue;
        }
        if (spec.issuedByAccountLoginName && issuedById === undefined) {
          continue;
        }
        if (targetId === undefined && issuedById === undefined) {
          continue;
        }
        const targetCandidates = rows.filter(
          (row) =>
            !plan.verificationRecordIds.includes(asNumber(row.id)) &&
            row.type === spec.type &&
            (targetId === undefined || asNumber(row.target_account_id) === targetId) &&
            (issuedById === undefined || asNumber(row.issued_by_account_id) === issuedById),
        );
        if (targetCandidates.length === 0) {
          continue;
        }
        const candidates = targetCandidates.filter((row) => sameJson(row.payload, spec.payload));
        if (candidates.length === 0) {
          conflict(
            helper,
            'verificationRecord',
            spec.type,
            '存在同类型记录但载荷指纹不符，拒绝接管',
          );
        }
        if (candidates.length > 1) {
          conflict(
            helper,
            'verificationRecord',
            spec.type,
            `命中 ${candidates.length} 条同指纹记录，拒绝猜测`,
          );
        }
        addIds(plan.verificationRecordIds, [asNumber(candidates[0].id)]);
      }
    }
  }

  const repairRequests = residue.repairRequests ?? [];
  const requestIdByNo = new Map<string, number>();
  if (repairRequests.length > 0) {
    const requestNos = [...new Set(repairRequests.map((spec) => spec.requestNo))];
    const rows: RepairRequestRow[] = await manager.query(
      `SELECT id, request_no, customer_account_id, equipment_model_id, error_code,
              fault_description, content_md, is_accepted, accepted_by_engineer_account_id, deprecated
         FROM repair_request
        WHERE request_no IN (${inClause(requestNos)})
        FOR UPDATE`,
      requestNos,
    );
    for (const spec of repairRequests) {
      const row = rows.find(
        (candidate) =>
          !plan.repairRequestIds.includes(asNumber(candidate.id)) &&
          candidate.request_no === spec.requestNo,
      );
      if (!row) {
        continue;
      }
      const customerId = accountIdByLoginName.get(spec.customerAccountLoginName);
      const modelId = equipmentModelIdByCode.get(spec.equipmentModelCode);
      if (customerId === undefined || modelId === undefined) {
        conflict(
          helper,
          'repairRequest',
          spec.requestNo,
          '申请仍存在但客户账号/型号未通过指纹核验，拒绝接管',
        );
      }
      if (
        asNumber(row.customer_account_id) !== customerId ||
        asNumber(row.equipment_model_id) !== modelId ||
        row.error_code !== spec.errorCode ||
        row.fault_description !== spec.faultDescription ||
        row.content_md !== spec.contentMd
      ) {
        conflict(
          helper,
          'repairRequest',
          spec.requestNo,
          '已存在但客户/型号/正文指纹不符，拒绝接管',
        );
      }
      addIds(plan.repairRequestIds, [asNumber(row.id)]);
      requestIdByNo.set(spec.requestNo, asNumber(row.id));
    }
  }

  const engineerResponses = residue.engineerResponses ?? [];
  if (engineerResponses.length > 0) {
    const requestIds = [
      ...new Set(
        engineerResponses
          .map((spec) => requestIdByNo.get(spec.requestNo))
          .filter((id): id is number => id !== undefined),
      ),
    ];
    if (requestIds.length > 0) {
      const rows: EngineerResponseRow[] = await manager.query(
        `SELECT id, request_id, engineer_account_id, customer_account_id,
                resolution_status, response_text
           FROM engineer_response
          WHERE request_id IN (${inClause(requestIds)})
          FOR UPDATE`,
        requestIds,
      );
      for (const spec of engineerResponses) {
        const requestId = requestIdByNo.get(spec.requestNo);
        const engineerId = accountIdByLoginName.get(spec.engineerAccountLoginName);
        if (requestId === undefined || engineerId === undefined) {
          continue;
        }
        const requestCandidates = rows.filter(
          (row) =>
            !plan.engineerResponseIds.includes(asNumber(row.id)) &&
            asNumber(row.request_id) === requestId,
        );
        if (requestCandidates.length === 0) {
          continue;
        }
        const candidates = requestCandidates.filter(
          (row) =>
            asNumber(row.engineer_account_id) === engineerId &&
            row.response_text === spec.responseText &&
            row.resolution_status === spec.resolutionStatus,
        );
        if (candidates.length === 0) {
          conflict(
            helper,
            'engineerResponse',
            spec.requestNo,
            '父申请下存在未声明的回复，拒绝接管',
          );
        }
        if (candidates.length > 1) {
          conflict(
            helper,
            'engineerResponse',
            spec.requestNo,
            `父申请 ${spec.requestNo} 命中 ${candidates.length} 条同指纹回复，拒绝猜测`,
          );
        }
        addIds(plan.engineerResponseIds, [asNumber(candidates[0].id)]);
      }
    }
  }
};

/** 根行加锁：阻断预检后新增入向引用的窗口。 */
const lockExistingRows = async (
  manager: EntityManager,
  table: string,
  ids: readonly number[],
): Promise<void> => {
  if (ids.length === 0) {
    return;
  }
  await manager.query(`SELECT id FROM ${table} WHERE id IN (${inClause(ids)}) FOR UPDATE`, ids);
};

const FACT_BEARING_CATEGORIES: readonly FactBearingCategory[] = [
  'organization',
  'account',
  'membership',
  'document',
  'equipmentModel',
  'thirdPartyAuth',
  'verificationRecord',
  'repairRequest',
  'engineerResponse',
  'engineerRegistrationApplication',
];

/**
 * 把 source 台账中已登记的真实 ID 及其预期事实合并到 target。
 *
 * 只用于“同一批受控资源需要登记到多个台账”（用例台账 → 规格兜底台账），
 * 不改变事实来源，也不允许用清理阶段的当前数据库值回填。
 */
export const mergeOwnedResourceLedger = (
  target: OwnedResourceLedger,
  source: OwnedResourceLedger,
): void => {
  for (const category of Object.keys(LEDGER_KEY_BY_CATEGORY) as OwnedResourceCategory[]) {
    const targetIds = target[LEDGER_KEY_BY_CATEGORY[category]];
    for (const id of source[LEDGER_KEY_BY_CATEGORY[category]]) {
      if (!targetIds.includes(id)) {
        targetIds.push(id);
      }
    }
  }
  for (const category of FACT_BEARING_CATEGORIES) {
    const from = source.facts[category] as unknown as Map<number, unknown>;
    const to = target.facts[category] as unknown as Map<number, unknown>;
    for (const [id, facts] of from) {
      to.set(id, cloneFacts(facts));
    }
  }
};

/**
 * 每个已登记 ID 都必须有最小预期事实；缺事实时在第一条 DELETE 前失败关闭（R02）。
 * 不接受 `skipFingerprint` / `trustOwnedId` 之类的豁免。
 */
const assertOwnedFactsComplete = (owned: OwnedResourceLedger, helper: string): void => {
  for (const category of FACT_BEARING_CATEGORIES) {
    const ids = owned[LEDGER_KEY_BY_CATEGORY[category]] as readonly number[];
    for (const id of ids) {
      if (!owned.facts[category].has(id)) {
        throw new Error(
          `[${helper}] 阶段=归属预检 拒绝删除：${category} ${id} 缺少必要预期事实，` +
            '拒绝仅按 ID 删除',
        );
      }
    }
  }
};

const nullableNumberEquals = (actual: unknown, expected: number | null): boolean =>
  expected === null
    ? actual === null || actual === undefined
    : actual !== null && actual !== undefined && asNumber(actual) === expected;

const boolOfDb = (value: unknown): boolean => value === true || Number(value) === 1;

/**
 * 在删除事务内锁定本轮登记资源并逐项核对预期事实（R02）。
 *
 * - 事实来自受控创建输入，不由清理阶段读取当前值反填；
 * - 行已不存在视为“已回收”，保持幂等（业务用例可能已先行删除）；
 * - 任一关键字段漂移即冲突，且发生在第一条 DELETE 之前。
 */
const verifyOwnedExpectations = async (
  manager: EntityManager,
  owned: OwnedResourceLedger,
  helper: string,
): Promise<void> => {
  const drift = (category: string, id: number, keys: readonly string[]): never =>
    conflict(
      helper,
      category,
      String(id),
      `本轮登记事实漂移（${keys.join(', ')}），拒绝按已登记 ID 直接删除`,
    );

  if (owned.facts.organization.size > 0) {
    const ids = [...owned.facts.organization.keys()];
    const rows: OrganizationRow[] = await manager.query(
      `SELECT id, organization_code, name, kind, status
         FROM organization
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.organization) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (row.organization_code !== expected.organizationCode) mismatches.push('organization_code');
      if (row.name !== expected.name) mismatches.push('name');
      if (row.kind !== expected.kind) mismatches.push('kind');
      if (row.status !== expected.status) mismatches.push('status');
      if (mismatches.length > 0) drift('organization', id, mismatches);
    }
  }

  if (owned.facts.account.size > 0) {
    const ids = [...owned.facts.account.keys()];
    const rows: AccountRow[] = await manager.query(
      `SELECT a.id, a.login_name, a.login_email, a.status, a.identity_hint,
              ui.id AS user_info_id, ui.nickname, ui.email AS user_info_email,
              ui.access_group, ui.meta_digest, ui.user_state
         FROM base_user_account a
         LEFT JOIN base_user_info ui ON ui.account_id = a.id
        WHERE a.id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.account) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if ((row.login_name ?? null) !== expected.loginName) mismatches.push('login_name');
      if (row.login_email !== expected.loginEmail) mismatches.push('login_email');
      if (String(row.status) !== String(expected.status)) mismatches.push('status');
      if (row.identity_hint !== expected.identityHint) mismatches.push('identity_hint');
      if (!sameJson(row.access_group, expected.accessGroup)) mismatches.push('access_group');
      // N01：账号字段与用户资料字段必须分别比对；资料缺失本身即漂移，不允许静默跳过。
      if (row.user_info_id === null || row.user_info_id === undefined) {
        mismatches.push('user_info(缺失)');
      } else {
        if (row.nickname !== expected.nickname) mismatches.push('user_info.nickname');
        if (row.user_info_email !== expected.userInfoEmail) mismatches.push('user_info.email');
        if (String(row.user_state) !== String(expected.userState)) {
          mismatches.push('user_info.user_state');
        }
      }
      if (mismatches.length > 0) drift('account', id, mismatches);
    }
  }

  if (owned.facts.membership.size > 0) {
    const ids = [...owned.facts.membership.keys()];
    const rows: MembershipRow[] = await manager.query(
      `SELECT id, organization_id, account_id, member_role, status
         FROM organization_membership
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.membership) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (asNumber(row.organization_id) !== expected.organizationId) {
        mismatches.push('organization_id');
      }
      if (asNumber(row.account_id) !== expected.accountId) mismatches.push('account_id');
      if (row.member_role !== expected.memberRole) mismatches.push('member_role');
      if (row.status !== expected.status) mismatches.push('status');
      if (mismatches.length > 0) drift('membership', id, mismatches);
    }
  }

  if (owned.facts.document.size > 0) {
    const ids = [...owned.facts.document.keys()];
    const rows: DocumentRow[] = await manager.query(
      `SELECT id, owner_organization_id, created_by_account_id, updated_by_account_id,
              source_submission_id, source_revision_id, equipment_model_id
         FROM reference_document
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.document) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (asNumber(row.owner_organization_id) !== expected.ownerOrganizationId) {
        mismatches.push('owner_organization_id');
      }
      if (asNumber(row.created_by_account_id) !== expected.createdByAccountId) {
        mismatches.push('created_by_account_id');
      }
      if (!nullableNumberEquals(row.source_submission_id, expected.sourceSubmissionId)) {
        mismatches.push('source_submission_id');
      }
      if (!nullableNumberEquals(row.source_revision_id, expected.sourceRevisionId)) {
        mismatches.push('source_revision_id');
      }
      if (!nullableNumberEquals(row.equipment_model_id, expected.equipmentModelId)) {
        mismatches.push('equipment_model_id');
      }
      if (mismatches.length > 0) drift('document', id, mismatches);
    }
  }

  if (owned.facts.equipmentModel.size > 0) {
    const ids = [...owned.facts.equipmentModel.keys()];
    const rows: EquipmentModelRow[] = await manager.query(
      `SELECT id, model_code, model_name, enabled, sort_order
         FROM equipment_model
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.equipmentModel) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (row.model_code !== expected.modelCode) mismatches.push('model_code');
      if (row.model_name !== expected.modelName) mismatches.push('model_name');
      if (boolOfDb(row.enabled) !== expected.enabled) mismatches.push('enabled');
      if (Number(row.sort_order) !== expected.sortOrder) mismatches.push('sort_order');
      if (mismatches.length > 0) drift('equipmentModel', id, mismatches);
    }
  }

  if (owned.facts.thirdPartyAuth.size > 0) {
    const ids = [...owned.facts.thirdPartyAuth.keys()];
    const rows: ThirdPartyAuthRow[] = await manager.query(
      `SELECT id, account_id, provider, provider_user_id, union_id
         FROM base_third_party_auth
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.thirdPartyAuth) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (asNumber(row.account_id) !== expected.accountId) mismatches.push('account_id');
      if (row.provider !== expected.provider) mismatches.push('provider');
      if (row.provider_user_id !== expected.providerUserId) mismatches.push('provider_user_id');
      if ((row.union_id ?? null) !== expected.unionId) mismatches.push('union_id');
      if (mismatches.length > 0) drift('thirdPartyAuth', id, mismatches);
    }
  }

  if (owned.facts.verificationRecord.size > 0) {
    const ids = [...owned.facts.verificationRecord.keys()];
    const rows: VerificationRecordRow[] = await manager.query(
      `SELECT id, type, target_account_id, subject_type, subject_id, payload,
              issued_by_account_id, consumed_by_account_id
         FROM base_verification_record
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.verificationRecord) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (row.type !== expected.type) mismatches.push('type');
      if (!nullableNumberEquals(row.target_account_id, expected.targetAccountId)) {
        mismatches.push('target_account_id');
      }
      if ((row.subject_type ?? null) !== expected.subjectType) mismatches.push('subject_type');
      if (!nullableNumberEquals(row.subject_id, expected.subjectId)) mismatches.push('subject_id');
      if (!nullableNumberEquals(row.issued_by_account_id, expected.issuedByAccountId)) {
        mismatches.push('issued_by_account_id');
      }
      if (!sameJson(row.payload, expected.payload)) mismatches.push('payload');
      if (mismatches.length > 0) drift('verificationRecord', id, mismatches);
    }
  }

  if (owned.facts.repairRequest.size > 0) {
    const ids = [...owned.facts.repairRequest.keys()];
    const rows: RepairRequestRow[] = await manager.query(
      `SELECT id, request_no, customer_account_id, equipment_model_id, error_code,
              fault_description, content_md, is_accepted, accepted_by_engineer_account_id, deprecated
         FROM repair_request
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.repairRequest) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (row.request_no !== expected.requestNo) mismatches.push('request_no');
      if (asNumber(row.customer_account_id) !== expected.customerAccountId) {
        mismatches.push('customer_account_id');
      }
      if (asNumber(row.equipment_model_id) !== expected.equipmentModelId) {
        mismatches.push('equipment_model_id');
      }
      if (row.error_code !== expected.errorCode) mismatches.push('error_code');
      if (row.fault_description !== expected.faultDescription) mismatches.push('fault_description');
      if (mismatches.length > 0) drift('repairRequest', id, mismatches);
    }
  }

  if (owned.facts.engineerResponse.size > 0) {
    const ids = [...owned.facts.engineerResponse.keys()];
    const rows: EngineerResponseRow[] = await manager.query(
      `SELECT id, request_id, engineer_account_id, customer_account_id,
              resolution_status, response_text
         FROM engineer_response
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.engineerResponse) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (asNumber(row.request_id) !== expected.requestId) mismatches.push('request_id');
      if (asNumber(row.engineer_account_id) !== expected.engineerAccountId) {
        mismatches.push('engineer_account_id');
      }
      if (asNumber(row.customer_account_id) !== expected.customerAccountId) {
        mismatches.push('customer_account_id');
      }
      if (row.response_text !== expected.responseText) mismatches.push('response_text');
      if (row.resolution_status !== expected.resolutionStatus) {
        mismatches.push('resolution_status');
      }
      if (mismatches.length > 0) drift('engineerResponse', id, mismatches);
    }
  }

  if (owned.facts.engineerRegistrationApplication.size > 0) {
    const ids = [...owned.facts.engineerRegistrationApplication.keys()];
    const rows: EngineerRegistrationApplicationRow[] = await manager.query(
      `SELECT id, account_id, organization_id, application_note
         FROM engineer_registration_application
        WHERE id IN (${inClause(ids)})
        FOR UPDATE`,
      ids,
    );
    const rowById = new Map(rows.map((row) => [asNumber(row.id), row]));
    for (const [id, expected] of owned.facts.engineerRegistrationApplication) {
      const row = rowById.get(id);
      if (!row) {
        continue;
      }
      const mismatches: string[] = [];
      if (asNumber(row.account_id) !== expected.accountId) mismatches.push('account_id');
      if (asNumber(row.organization_id) !== expected.organizationId) {
        mismatches.push('organization_id');
      }
      if ((row.application_note ?? null) !== expected.applicationNote) {
        mismatches.push('application_note');
      }
      if (mismatches.length > 0) drift('engineerRegistrationApplication', id, mismatches);
    }
  }
};

/**
 * 第三方绑定 / 验证记录 / 维修申请 / 工程师回复的本轮归属核验与从属扩图。
 *
 * - 已登记 ID 只核实存在性与关联事实；不存在的行视为已删除；
 * - 关联查询只用于发现引用，不构成删除授权（R01）：
 *   账号下的第三方绑定、申请下的工程师回复必须已由本轮登记或严格残留指纹纳入，
 *   否则在第一条 DELETE 前冲突，绝不按账号/申请自动扩图；
 * - 验证记录、维修申请必须由调用方显式登记或残留指纹证明，绝不按账号整批接管；
 * - 工程师回复只能出现在本轮申请下，且工程师/客户都必须是本轮账号。
 */
const collectSpecialOwnedGraph = async (
  manager: EntityManager,
  plan: CleanupPlan,
  helper: string,
): Promise<void> => {
  const accountIds = plan.accountIds;
  const modelIds = plan.equipmentModelIds;

  await lockExistingRows(manager, 'base_third_party_auth', plan.thirdPartyAuthIds);
  await lockExistingRows(manager, 'base_verification_record', plan.verificationRecordIds);
  await lockExistingRows(manager, 'repair_request', plan.repairRequestIds);
  await lockExistingRows(manager, 'engineer_response', plan.engineerResponseIds);

  if (plan.thirdPartyAuthIds.length > 0) {
    const rows: ThirdPartyAuthRow[] = await manager.query(
      `SELECT id, account_id, provider, provider_user_id, union_id
         FROM base_third_party_auth
        WHERE id IN (${inClause(plan.thirdPartyAuthIds)})
        FOR UPDATE`,
      plan.thirdPartyAuthIds,
    );
    for (const row of rows) {
      if (!accountIds.includes(asNumber(row.account_id))) {
        conflict(helper, 'thirdPartyAuth', String(row.id), '绑定账号不在本轮范围，拒绝删除');
      }
    }
  }

  if (accountIds.length > 0) {
    const bindings: ThirdPartyAuthRow[] = await manager.query(
      `SELECT id, account_id, provider, provider_user_id, union_id
         FROM base_third_party_auth
        WHERE account_id IN (${inClause(accountIds)})
        FOR UPDATE`,
      accountIds,
    );
    for (const row of bindings) {
      const bindingId = asNumber(row.id);
      // R01：关联查询只用于发现引用；未登记（且无严格残留指纹）的绑定不是本轮资源。
      if (!plan.thirdPartyAuthIds.includes(bindingId)) {
        conflict(
          helper,
          'thirdPartyAuth',
          String(bindingId),
          `本轮账号的 ${row.provider} 绑定未登记归属证据，关联关系不是删除授权，拒绝删除`,
        );
      }
    }
  }

  if (plan.verificationRecordIds.length > 0) {
    const rows: VerificationRecordRow[] = await manager.query(
      `SELECT id, type, target_account_id, subject_type, subject_id, payload,
              issued_by_account_id, consumed_by_account_id
         FROM base_verification_record
        WHERE id IN (${inClause(plan.verificationRecordIds)})
        FOR UPDATE`,
      plan.verificationRecordIds,
    );
    for (const row of rows) {
      const refs = [
        row.target_account_id,
        row.issued_by_account_id,
        row.consumed_by_account_id,
        row.subject_type === 'ACCOUNT' ? row.subject_id : null,
      ].filter((id): id is number => id !== null && id !== undefined);
      for (const ref of refs) {
        if (!accountIds.includes(asNumber(ref))) {
          conflict(
            helper,
            'verificationRecord',
            String(row.id),
            '验证记录关联账号不在本轮范围，拒绝删除',
          );
        }
      }
    }
  }

  if (plan.repairRequestIds.length > 0) {
    const rows = await manager.query(
      `SELECT id, request_no, customer_account_id, equipment_model_id, error_code,
              fault_description, content_md, is_accepted, accepted_by_engineer_account_id, deprecated
         FROM repair_request
        WHERE id IN (${inClause(plan.repairRequestIds)})
        FOR UPDATE`,
      plan.repairRequestIds,
    );
    for (const row of rows) {
      if (!accountIds.includes(asNumber(row.customer_account_id))) {
        conflict(helper, 'repairRequest', String(row.id), '客户账号不在本轮范围，拒绝删除');
      }
      if (!modelIds.includes(asNumber(row.equipment_model_id))) {
        conflict(helper, 'repairRequest', String(row.id), '设备型号不在本轮范围，拒绝删除');
      }
      if (
        row.accepted_by_engineer_account_id !== null &&
        !accountIds.includes(asNumber(row.accepted_by_engineer_account_id))
      ) {
        conflict(helper, 'repairRequest', String(row.id), '接单工程师不在本轮范围，拒绝删除');
      }
    }
  }

  if (plan.engineerResponseIds.length > 0) {
    const rows = await manager.query(
      `SELECT id, request_id, engineer_account_id, customer_account_id,
              resolution_status, response_text
         FROM engineer_response
        WHERE id IN (${inClause(plan.engineerResponseIds)})
        FOR UPDATE`,
      plan.engineerResponseIds,
    );
    for (const row of rows) {
      if (!plan.repairRequestIds.includes(asNumber(row.request_id))) {
        conflict(helper, 'engineerResponse', String(row.id), '父申请不在本轮范围，拒绝删除');
      }
      if (!accountIds.includes(asNumber(row.engineer_account_id))) {
        conflict(helper, 'engineerResponse', String(row.id), '工程师账号不在本轮范围，拒绝删除');
      }
      if (!accountIds.includes(asNumber(row.customer_account_id))) {
        conflict(helper, 'engineerResponse', String(row.id), '客户账号不在本轮范围，拒绝删除');
      }
    }
  }

  if (plan.repairRequestIds.length > 0) {
    const parents: RepairRequestRow[] = await manager.query(
      `SELECT id, customer_account_id
         FROM repair_request
        WHERE id IN (${inClause(plan.repairRequestIds)})
        FOR UPDATE`,
      plan.repairRequestIds,
    );
    const customerByRequestId = new Map(
      parents.map((row) => [asNumber(row.id), asNumber(row.customer_account_id)]),
    );
    const responses: EngineerResponseRow[] = await manager.query(
      `SELECT id, request_id, engineer_account_id, customer_account_id,
              resolution_status, response_text
         FROM engineer_response
        WHERE request_id IN (${inClause(plan.repairRequestIds)})
        FOR UPDATE`,
      plan.repairRequestIds,
    );
    for (const row of responses) {
      const parentCustomerId = customerByRequestId.get(asNumber(row.request_id));
      if (parentCustomerId === undefined) {
        conflict(helper, 'engineerResponse', String(row.id), '父申请不存在，拒绝删除');
      }
      if (
        asNumber(row.customer_account_id) !== parentCustomerId ||
        !accountIds.includes(asNumber(row.engineer_account_id))
      ) {
        conflict(
          helper,
          'engineerResponse',
          String(row.id),
          '回复参与人不在本轮范围或与父申请客户不一致，拒绝删除',
        );
      }
      // R01：即使参与人相同，未登记的回复也不能随父申请自动接管。
      if (!plan.engineerResponseIds.includes(asNumber(row.id))) {
        conflict(
          helper,
          'engineerResponse',
          String(row.id),
          '本轮申请存在未登记的工程师回复，关联关系不是删除授权，拒绝删除',
        );
      }
    }
  }
};

const collectOwnedGraph = async (
  manager: EntityManager,
  plan: CleanupPlan,
  membershipAccountIds: readonly number[],
  helper: string,
): Promise<void> => {
  const orgIds = plan.organizationIds;
  const accountIds = plan.accountIds;
  const modelIds = plan.equipmentModelIds;

  await lockExistingRows(manager, 'organization', orgIds);
  await lockExistingRows(manager, 'base_user_account', accountIds);
  await lockExistingRows(manager, 'equipment_model', modelIds);

  await collectSpecialOwnedGraph(manager, plan, helper);

  if (orgIds.length > 0 || accountIds.length > 0 || membershipAccountIds.length > 0) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (orgIds.length > 0) {
      conditions.push(`organization_id IN (${inClause(orgIds)})`);
      params.push(...orgIds);
    }
    if (accountIds.length > 0) {
      // 双向核验：owned 账号在范围外组织的成员关系必须在第一条 DELETE 前暴露，
      // 不能依赖删除账号时的外键兜底。retainedAccounts 不删除账号，故不参与此方向。
      conditions.push(`account_id IN (${inClause(accountIds)})`);
      params.push(...accountIds);
    }
    const rows =
      conditions.length === 0
        ? []
        : await manager.query(
            `SELECT id, organization_id, account_id
               FROM organization_membership
              WHERE ${conditions.join(' OR ')}
              FOR UPDATE`,
            params,
          );

    for (const row of rows as MembershipRow[]) {
      if (
        !orgIds.includes(asNumber(row.organization_id)) ||
        !membershipAccountIds.includes(asNumber(row.account_id))
      ) {
        conflict(
          helper,
          'membership',
          String(row.id),
          '成员关系指向本轮范围外的组织或账号，拒绝删除并视为外部引用',
        );
      }
      addIds(plan.membershipIds, [asNumber(row.id)]);
    }

    const submissionConditions: string[] = [];
    const submissionParams: unknown[] = [];
    if (orgIds.length > 0) {
      submissionConditions.push(`owner_organization_id IN (${inClause(orgIds)})`);
      submissionParams.push(...orgIds);
    }
    if (accountIds.length > 0) {
      submissionConditions.push(`submitted_by_account_id IN (${inClause(accountIds)})`);
      submissionParams.push(...accountIds);
    }
    // R25-01：retained-only 时 orgIds/accountIds 均空，本查询自身没有任何条件。
    // 必须整段跳过，不能生成 `WHERE  FOR UPDATE`；其余图收集仍按下面各自的
    // 条件集合独立执行（不得在此提前 return）。
    if (submissionConditions.length > 0) {
      const submissions = await manager.query(
        `SELECT id, owner_organization_id, submitted_by_account_id
           FROM content_submission
          WHERE ${submissionConditions.join(' OR ')}
          FOR UPDATE`,
        submissionParams,
      );

      for (const row of submissions as SubmissionRow[]) {
        if (
          !orgIds.includes(asNumber(row.owner_organization_id)) ||
          !accountIds.includes(asNumber(row.submitted_by_account_id))
        ) {
          conflict(
            helper,
            'submission',
            String(row.id),
            '投稿归属组织或投稿人不在本轮范围，拒绝删除',
          );
        }
        addIds(plan.submissionIds, [asNumber(row.id)]);
      }
    }
  }

  if (plan.submissionIds.length > 0) {
    const submissionIds = plan.submissionIds;
    await lockExistingRows(manager, 'content_submission', submissionIds);

    const revisions = await manager.query(
      `SELECT id, submission_id, attachment_id, confirmed_by_account_id
         FROM content_submission_revision
        WHERE submission_id IN (${inClause(submissionIds)})
        FOR UPDATE`,
      submissionIds,
    );
    for (const row of revisions as RevisionRow[]) {
      if (!accountIds.includes(asNumber(row.confirmed_by_account_id))) {
        conflict(helper, 'revision', String(row.id), '确认人账号不在本轮范围，拒绝删除');
      }
      addIds(plan.revisionIds, [asNumber(row.id)]);
    }

    const attachments = await manager.query(
      `SELECT id, submission_id, uploaded_by_account_id
         FROM content_submission_attachment
        WHERE submission_id IN (${inClause(submissionIds)})
        FOR UPDATE`,
      submissionIds,
    );
    for (const row of attachments as AttachmentRow[]) {
      if (!accountIds.includes(asNumber(row.uploaded_by_account_id))) {
        conflict(helper, 'attachment', String(row.id), '上传人账号不在本轮范围，拒绝删除');
      }
      addIds(plan.attachmentIds, [asNumber(row.id)]);
    }

    const reviews = await manager.query(
      `SELECT id, submission_id, revision_id, reviewed_by_account_id
         FROM content_submission_review
        WHERE submission_id IN (${inClause(submissionIds)})
        FOR UPDATE`,
      submissionIds,
    );
    for (const row of reviews as ReviewRow[]) {
      if (!accountIds.includes(asNumber(row.reviewed_by_account_id))) {
        conflict(helper, 'review', String(row.id), '审核人账号不在本轮范围，拒绝删除');
      }
      addIds(plan.reviewIds, [asNumber(row.id)]);
    }

    for (const table of ['material_submission_detail', 'fault_case_submission_detail'] as const) {
      const details = await manager.query(
        `SELECT submission_id, equipment_model_id
           FROM ${table}
          WHERE submission_id IN (${inClause(submissionIds)})
          FOR UPDATE`,
        submissionIds,
      );
      addIds(
        table === 'material_submission_detail' ? plan.materialDetailIds : plan.faultCaseDetailIds,
        (details as DetailRow[]).map((row) => asNumber(row.submission_id)),
      );
    }
  }

  if (orgIds.length > 0 || accountIds.length > 0 || plan.submissionIds.length > 0) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (orgIds.length > 0) {
      conditions.push(`owner_organization_id IN (${inClause(orgIds)})`);
      params.push(...orgIds);
    }
    if (accountIds.length > 0) {
      conditions.push(`created_by_account_id IN (${inClause(accountIds)})`);
      params.push(...accountIds);
    }
    if (plan.submissionIds.length > 0) {
      conditions.push(`source_submission_id IN (${inClause(plan.submissionIds)})`);
      params.push(...plan.submissionIds);
    }
    const documents = await manager.query(
      `SELECT id, owner_organization_id, created_by_account_id, updated_by_account_id,
              source_submission_id, source_revision_id, equipment_model_id
         FROM reference_document
        WHERE ${conditions.join(' OR ')}
        FOR UPDATE`,
      params,
    );

    for (const row of documents as DocumentRow[]) {
      const documentId = asNumber(row.id);
      if (!orgIds.includes(asNumber(row.owner_organization_id))) {
        conflict(
          helper,
          'document',
          String(documentId),
          '归属组织不在本轮范围（含来源投稿跨组织），拒绝删除',
        );
      }
      if (!accountIds.includes(asNumber(row.created_by_account_id))) {
        conflict(helper, 'document', String(documentId), '创建人账号不在本轮范围，拒绝删除');
      }
      if (
        row.updated_by_account_id !== null &&
        !accountIds.includes(asNumber(row.updated_by_account_id))
      ) {
        conflict(helper, 'document', String(documentId), '更新人账号不在本轮范围，拒绝删除');
      }
      if (
        row.source_submission_id !== null &&
        !plan.submissionIds.includes(asNumber(row.source_submission_id))
      ) {
        conflict(helper, 'document', String(documentId), '来源投稿不在本轮范围，拒绝删除');
      }
      if (
        row.source_revision_id !== null &&
        !plan.revisionIds.includes(asNumber(row.source_revision_id))
      ) {
        conflict(helper, 'document', String(documentId), '来源版本不在本轮范围，拒绝删除');
      }
      addIds(plan.documentIds, [documentId]);
    }

    if (plan.documentIds.length > 0) {
      await lockExistingRows(manager, 'reference_document', plan.documentIds);
      const caseDetails = await manager.query(
        `SELECT document_id
           FROM reference_document_case_detail
          WHERE document_id IN (${inClause(plan.documentIds)})
          FOR UPDATE`,
        plan.documentIds,
      );
      addIds(
        plan.documentCaseDetailIds,
        (caseDetails as DocumentCaseDetailRow[]).map((row) => asNumber(row.document_id)),
      );
    }
  }

  await assertReferenceClosure(manager, plan, helper);
};

/** 检查集合外入向引用；任何一条都拒绝删除，不做“顺便一起删”。 */
const assertReferenceClosure = async (
  manager: EntityManager,
  plan: CleanupPlan,
  helper: string,
): Promise<void> => {
  const accountIds = plan.accountIds;
  if (accountIds.length > 0) {
    const placeholders = inClause(accountIds);
    const externalReferences: Array<{
      label: string;
      sql: string;
      requirePlanKey?: keyof CleanupPlan;
    }> = [
      {
        label: '附件上传人',
        sql: `SELECT id FROM content_submission_attachment WHERE uploaded_by_account_id IN (${placeholders})`,
        requirePlanKey: 'attachmentIds',
      },
      {
        label: '版本确认人',
        sql: `SELECT id FROM content_submission_revision WHERE confirmed_by_account_id IN (${placeholders})`,
        requirePlanKey: 'revisionIds',
      },
      {
        label: '审核人',
        sql: `SELECT id FROM content_submission_review WHERE reviewed_by_account_id IN (${placeholders})`,
        requirePlanKey: 'reviewIds',
      },
      {
        label: '资料更新人',
        sql: `SELECT id FROM reference_document WHERE updated_by_account_id IN (${placeholders})`,
        requirePlanKey: 'documentIds',
      },
    ];

    for (const reference of externalReferences) {
      const rows = await manager.query(reference.sql, accountIds);
      for (const row of rows) {
        const id = asNumber(row.id);
        if (!reference.requirePlanKey || !plan[reference.requirePlanKey].includes(id)) {
          conflict(
            helper,
            reference.label,
            String(id),
            '引用了本轮账号但不在本轮删除范围，拒绝删除',
          );
        }
      }
    }

    const planAwareReferences: Array<{
      label: string;
      sql: string;
      params: unknown[];
      planKey: keyof CleanupPlan;
    }> = [
      {
        label: '验证记录',
        sql: `SELECT id FROM base_verification_record
               WHERE target_account_id IN (${placeholders})
                  OR issued_by_account_id IN (${placeholders})
                  OR consumed_by_account_id IN (${placeholders})
                  OR (subject_type = 'ACCOUNT' AND subject_id IN (${placeholders}))`,
        params: [...accountIds, ...accountIds, ...accountIds, ...accountIds],
        planKey: 'verificationRecordIds',
      },
      {
        label: '维修申请',
        sql: `SELECT id FROM repair_request
               WHERE customer_account_id IN (${placeholders})
                  OR accepted_by_engineer_account_id IN (${placeholders})
                  OR handling_recorded_by_account_id IN (${placeholders})`,
        params: [...accountIds, ...accountIds, ...accountIds],
        planKey: 'repairRequestIds',
      },
      {
        label: '工程师回复',
        sql: `SELECT id FROM engineer_response
               WHERE engineer_account_id IN (${placeholders})
                  OR customer_account_id IN (${placeholders})`,
        params: [...accountIds, ...accountIds],
        planKey: 'engineerResponseIds',
      },
    ];

    for (const reference of planAwareReferences) {
      const rows = await manager.query(reference.sql, reference.params);
      for (const row of rows) {
        const id = asNumber(row.id);
        if (!plan[reference.planKey].includes(id)) {
          conflict(
            helper,
            reference.label,
            String(id),
            '引用了本轮账号但不在本轮删除范围，拒绝删除',
          );
        }
      }
    }

    for (const table of ['ai_conversation', 'ai_report'] as const) {
      const rows = await manager.query(
        `SELECT id FROM ${table} WHERE engineer_account_id IN (${placeholders}) LIMIT 1`,
        accountIds,
      );
      if (rows.length > 0) {
        conflict(helper, table, String(rows[0].id), '外部 AI 记录引用了本轮账号，拒绝删除');
      }
    }

    // 工程师注册申请对账号（申请人 / 审核人）与组织均为 FK RESTRICT：
    // 引用本轮账号但未登记的申请一律先于删除失败关闭，不做按账号自动扩图。
    const accountApplications: EngineerRegistrationApplicationRow[] = await manager.query(
      `SELECT id, account_id, organization_id, application_note
         FROM engineer_registration_application
        WHERE account_id IN (${placeholders})
           OR reviewed_by_account_id IN (${placeholders})`,
      [...accountIds, ...accountIds],
    );
    for (const row of accountApplications) {
      if (!plan.engineerRegistrationApplicationIds.includes(asNumber(row.id))) {
        conflict(
          helper,
          'engineerRegistrationApplication',
          String(row.id),
          '工程师注册申请引用了本轮账号但未登记归属证据，关联关系不是删除授权，拒绝删除',
        );
      }
    }

    // 维修报告链路（报告 / 附件 / 冻结版本 / 审核）本轮没有删除能力，也从不登记。
    // 只要其中任一账号字段引用了本轮待删账号，就在第一条 DELETE 前失败关闭。
    const reportAccountReferences: Array<{
      label: string;
      sql: string;
      paramGroups: number;
    }> = [
      {
        label: 'maintenance_report 工程师/创建人/更新人',
        sql: `SELECT id FROM maintenance_report
               WHERE maintenance_engineer_account_id IN (${placeholders})
                  OR created_by_account_id IN (${placeholders})
                  OR updated_by_account_id IN (${placeholders})`,
        paramGroups: 3,
      },
      {
        label: 'maintenance_report_attachment 上传人',
        sql: `SELECT id FROM maintenance_report_attachment
               WHERE uploaded_by_account_id IN (${placeholders})`,
        paramGroups: 1,
      },
      {
        label: 'maintenance_report_version 提交人',
        sql: `SELECT id FROM maintenance_report_version
               WHERE submitted_by_account_id IN (${placeholders})`,
        paramGroups: 1,
      },
      {
        label: 'maintenance_report_review 审核人',
        sql: `SELECT id FROM maintenance_report_review
               WHERE reviewed_by_account_id IN (${placeholders})`,
        paramGroups: 1,
      },
    ];
    for (const reference of reportAccountReferences) {
      const rows = await manager.query(
        reference.sql,
        Array.from({ length: reference.paramGroups }, () => accountIds).flat(),
      );
      if (rows.length > 0) {
        conflict(helper, reference.label, String(rows[0].id), '引用了本轮账号，拒绝删除');
      }
    }
  }

  if (plan.organizationIds.length > 0) {
    const orgPlaceholders = inClause(plan.organizationIds);
    const orgApplications: EngineerRegistrationApplicationRow[] = await manager.query(
      `SELECT id, account_id, organization_id, application_note
         FROM engineer_registration_application
        WHERE organization_id IN (${orgPlaceholders})`,
      plan.organizationIds,
    );
    for (const row of orgApplications) {
      if (!plan.engineerRegistrationApplicationIds.includes(asNumber(row.id))) {
        conflict(
          helper,
          'engineerRegistrationApplication',
          String(row.id),
          '工程师注册申请引用了本轮组织但未登记归属证据，拒绝删除',
        );
      }
    }

    // 组织是维修报告与本地安装映射的父记录；两类引用都不在本轮删除范围内。
    const reportRows = await manager.query(
      `SELECT id FROM maintenance_report WHERE owner_organization_id IN (${orgPlaceholders})`,
      plan.organizationIds,
    );
    if (reportRows.length > 0) {
      conflict(
        helper,
        'maintenance_report.owner_organization_id',
        String(reportRows[0].id),
        '维修报告引用了本轮组织，拒绝删除',
      );
    }

    const localInstallationRows = await manager.query(
      `SELECT id FROM local_installation WHERE organization_id IN (${orgPlaceholders})`,
      plan.organizationIds,
    );
    if (localInstallationRows.length > 0) {
      conflict(
        helper,
        'local_installation.organization_id',
        String(localInstallationRows[0].id),
        '本地安装映射引用了本轮组织，拒绝删除',
      );
    }

    // owner_organization_id 是 26 号迁移新增的外键；工单只有在登记集合内才允许随组织删除。
    const ownerRequests = await manager.query(
      `SELECT id FROM repair_request WHERE owner_organization_id IN (${orgPlaceholders})`,
      plan.organizationIds,
    );
    for (const row of ownerRequests) {
      const id = asNumber(row.id);
      if (!plan.repairRequestIds.includes(id)) {
        conflict(
          helper,
          'repair_request.owner_organization_id',
          String(id),
          '工单引用了本轮组织但未登记归属证据，拒绝删除',
        );
      }
    }
  }

  if (plan.repairRequestIds.length > 0) {
    const requestPlaceholders = inClause(plan.repairRequestIds);
    for (const table of ['ai_conversation', 'ai_report'] as const) {
      const rows = await manager.query(
        `SELECT id FROM ${table} WHERE request_id IN (${requestPlaceholders}) LIMIT 1`,
        plan.repairRequestIds,
      );
      if (rows.length > 0) {
        conflict(
          helper,
          table,
          String(rows[0].id),
          'AI 记录引用了本轮维修申请但未登记为本轮资源，拒绝删除',
        );
      }
    }

    const externalResponses = await manager.query(
      `SELECT id FROM engineer_response WHERE request_id IN (${requestPlaceholders})`,
      plan.repairRequestIds,
    );
    for (const row of externalResponses) {
      const id = asNumber(row.id);
      if (!plan.engineerResponseIds.includes(id)) {
        conflict(helper, 'engineerResponse', String(id), '回复不属于本轮登记集合，拒绝删除');
      }
    }

    // 维修报告以 repair_request_id 为唯一父引用；本轮没有报告删除能力，一律拒绝。
    const reportRows = await manager.query(
      `SELECT id FROM maintenance_report WHERE repair_request_id IN (${requestPlaceholders})`,
      plan.repairRequestIds,
    );
    if (reportRows.length > 0) {
      conflict(
        helper,
        'maintenance_report.repair_request_id',
        String(reportRows[0].id),
        '维修报告引用了本轮工单且未登记为本轮资源，拒绝删除',
      );
    }
  }

  if (plan.revisionIds.length > 0) {
    const rows = await manager.query(
      `SELECT id FROM reference_document WHERE source_revision_id IN (${inClause(plan.revisionIds)})`,
      plan.revisionIds,
    );
    for (const row of rows) {
      if (!plan.documentIds.includes(asNumber(row.id))) {
        conflict(helper, 'revision', String(row.id), '被本轮范围外的资料引用，拒绝删除');
      }
    }
  }

  if (plan.attachmentIds.length > 0) {
    const rows = await manager.query(
      `SELECT id FROM content_submission_revision WHERE attachment_id IN (${inClause(plan.attachmentIds)})`,
      plan.attachmentIds,
    );
    for (const row of rows) {
      if (!plan.revisionIds.includes(asNumber(row.id))) {
        conflict(helper, 'attachment', String(row.id), '被本轮范围外的版本引用，拒绝删除');
      }
    }
  }

  if (plan.equipmentModelIds.length > 0) {
    const modelIds = plan.equipmentModelIds;
    const placeholders = inClause(modelIds);
    const checks: Array<{ table: string; label: string; sql: string; params: unknown[] }> = [
      {
        table: 'material_submission_detail',
        label: 'material_submission_detail.equipment_model_id',
        sql: `SELECT submission_id AS id FROM material_submission_detail WHERE equipment_model_id IN (${placeholders})`,
        params: modelIds,
      },
      {
        table: 'fault_case_submission_detail',
        label: 'fault_case_submission_detail.equipment_model_id',
        sql: `SELECT submission_id AS id FROM fault_case_submission_detail WHERE equipment_model_id IN (${placeholders})`,
        params: modelIds,
      },
      {
        table: 'reference_document',
        label: 'reference_document.equipment_model_id',
        sql: `SELECT id FROM reference_document WHERE equipment_model_id IN (${placeholders})`,
        params: modelIds,
      },
      {
        table: 'repair_request',
        label: 'repair_request.equipment_model_id',
        sql: `SELECT id FROM repair_request WHERE equipment_model_id IN (${placeholders})`,
        params: modelIds,
      },
      {
        table: 'maintenance_report',
        label: 'maintenance_report.equipment_model_id',
        sql: `SELECT id FROM maintenance_report WHERE equipment_model_id IN (${placeholders})`,
        params: modelIds,
      },
    ];

    for (const check of checks) {
      const rows = await manager.query(check.sql, check.params);
      for (const row of rows) {
        const id = asNumber(row.id);
        const inside =
          check.table === 'material_submission_detail'
            ? plan.materialDetailIds.includes(id)
            : check.table === 'fault_case_submission_detail'
              ? plan.faultCaseDetailIds.includes(id)
              : check.table === 'reference_document'
                ? plan.documentIds.includes(id)
                : check.table === 'repair_request'
                  ? plan.repairRequestIds.includes(id)
                  : false;
        if (!inside) {
          conflict(helper, check.label, String(id), '范围外记录引用了本轮机型，拒绝删除');
        }
      }
    }
  }
};

const deleteByIds = async (
  manager: EntityManager,
  table: string,
  ids: readonly number[],
): Promise<void> => {
  if (ids.length === 0) {
    return;
  }
  await manager.query(`DELETE FROM ${table} WHERE id IN (${inClause(ids)})`, ids);
};

const deleteVerifiedPlan = async (manager: EntityManager, plan: CleanupPlan): Promise<void> => {
  // 维修链路先于账号/型号删除（FK RESTRICT：回复 → 申请 → 型号 → user_info → 账号）。
  await deleteByIds(manager, 'engineer_response', plan.engineerResponseIds);
  await deleteByIds(manager, 'repair_request', plan.repairRequestIds);
  await deleteByIds(manager, 'base_verification_record', plan.verificationRecordIds);
  await deleteByIds(manager, 'base_third_party_auth', plan.thirdPartyAuthIds);
  await deleteByIds(manager, 'content_submission_review', plan.reviewIds);
  if (plan.documentCaseDetailIds.length > 0) {
    await manager.query(
      `DELETE FROM reference_document_case_detail WHERE document_id IN (${inClause(plan.documentCaseDetailIds)})`,
      plan.documentCaseDetailIds,
    );
  }
  await deleteByIds(manager, 'reference_document', plan.documentIds);
  await deleteByIds(manager, 'content_submission_revision', plan.revisionIds);
  await deleteByIds(manager, 'content_submission_attachment', plan.attachmentIds);
  if (plan.materialDetailIds.length > 0) {
    await manager.query(
      `DELETE FROM material_submission_detail WHERE submission_id IN (${inClause(plan.materialDetailIds)})`,
      plan.materialDetailIds,
    );
  }
  if (plan.faultCaseDetailIds.length > 0) {
    await manager.query(
      `DELETE FROM fault_case_submission_detail WHERE submission_id IN (${inClause(plan.faultCaseDetailIds)})`,
      plan.faultCaseDetailIds,
    );
  }
  await deleteByIds(manager, 'content_submission', plan.submissionIds);
  // 申请行对账号/组织均为 FK RESTRICT，必须先于成员关系与账号/组织删除。
  await deleteByIds(
    manager,
    'engineer_registration_application',
    plan.engineerRegistrationApplicationIds,
  );
  await deleteByIds(manager, 'organization_membership', plan.membershipIds);
  await deleteByIds(manager, 'organization', plan.organizationIds);
  if (plan.accountIds.length > 0) {
    await manager.query(
      `DELETE FROM base_user_info WHERE account_id IN (${inClause(plan.accountIds)})`,
      plan.accountIds,
    );
  }
  await deleteByIds(manager, 'base_user_account', plan.accountIds);
  await deleteByIds(manager, 'equipment_model', plan.equipmentModelIds);
};

/**
 * 门禁通过后，再执行调用方提供的归属范围清理回调。
 *
 * @param params.cleanup 必须自带归属 WHERE；门禁失败时该回调不会被调用（第一条删除前拒绝）。
 * @param params.helper 失败消息前缀，标明是哪个规格的哪个阶段（beforeAll 预清理 / afterAll 收尾）。
 */
export const runGuardedScopedCleanup = async (params: {
  readonly dataSource: DataSource;
  readonly cleanup: (dataSource: DataSource) => Promise<void>;
  readonly helper: string;
  /** 显式预期目标库；缺省时取 DataSource.options.database（N04）。 */
  readonly expectedDatabase?: string;
}): Promise<void> => {
  const { dataSource, cleanup, helper, expectedDatabase } = params;

  try {
    assertPhysicalCleanupConsent();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=清理许可门禁 拒绝执行删除：${detail}`, { cause: error });
  }

  await assertDataSourceOnAllowedE2eDatabase(dataSource, expectedDatabase);

  await cleanup(dataSource);
};

/**
 * 组合体：本轮规格的窄范围清理。
 *
 * - `owned`：本轮创建并登记的真实 ID（beforeAll 造数、afterAll 回收）；
 * - `residue`：上次中断残留的已知测试指纹，只用于定位候选，逐字段匹配后才纳入；
 * - 两者都为空时纯 no-op，不开启事务、不执行任何 DELETE；
 * - 预检与删除同事务，任何归属/引用冲突都会在第一条 DELETE 前失败。
 */
export const runGuardedSpecCleanup = async (params: {
  readonly dataSource: DataSource;
  readonly helper: string;
  readonly owned?: OwnedResourceLedger;
  readonly residue?: {
    readonly organizations?: readonly TestOrganizationSpec[];
    readonly accounts?: readonly ResidueAccountFingerprint[];
    readonly equipmentModels?: readonly ResidueEquipmentModelFingerprint[];
    readonly thirdPartyAuths?: readonly ResidueThirdPartyAuthFingerprint[];
    readonly verificationRecords?: readonly ResidueVerificationRecordFingerprint[];
    readonly repairRequests?: readonly ResidueRepairRequestFingerprint[];
    readonly engineerResponses?: readonly ResidueEngineerResponseFingerprint[];
  };
  /**
   * 由相邻守护清理步骤拥有、仅用于归属核验的账号指纹（不纳入本事务删除）。
   * 用于 10 组“组织链 + fixture 账号分两步”的组合清理。
   */
  readonly retainedAccounts?: readonly ResidueAccountFingerprint[];
  /** 显式预期目标库；缺省时取 DataSource.options.database（N04）。 */
  readonly expectedDatabase?: string;
}): Promise<void> => {
  const { dataSource, helper, owned, residue, retainedAccounts = [], expectedDatabase } = params;

  try {
    assertPhysicalCleanupConsent();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=清理许可门禁 拒绝执行删除：${detail}`, { cause: error });
  }

  const expected = resolveExpectedE2eDatabase(dataSource, expectedDatabase);
  await assertDataSourceOnAllowedE2eDatabase(dataSource, expected);

  if (owned) {
    // R02：先做纯内存的完整性检查，缺事实时不开启事务、不执行任何 DELETE。
    assertOwnedFactsComplete(owned, helper);
  }

  const plan = emptyPlan();
  if (owned) {
    plan.organizationIds = toIdList(owned.organizationIds);
    plan.accountIds = toIdList(owned.accountIds);
    plan.membershipIds = toIdList(owned.membershipIds);
    plan.submissionIds = toIdList(owned.submissionIds);
    plan.revisionIds = toIdList(owned.revisionIds);
    plan.attachmentIds = toIdList(owned.attachmentIds);
    plan.materialDetailIds = toIdList(owned.materialDetailIds);
    plan.faultCaseDetailIds = toIdList(owned.faultCaseDetailIds);
    plan.reviewIds = toIdList(owned.reviewIds);
    plan.documentIds = toIdList(owned.documentIds);
    plan.documentCaseDetailIds = toIdList(owned.documentCaseDetailIds);
    plan.equipmentModelIds = toIdList(owned.equipmentModelIds);
    plan.thirdPartyAuthIds = toIdList(owned.thirdPartyAuthIds);
    plan.verificationRecordIds = toIdList(owned.verificationRecordIds);
    plan.repairRequestIds = toIdList(owned.repairRequestIds);
    plan.engineerResponseIds = toIdList(owned.engineerResponseIds);
    plan.engineerRegistrationApplicationIds = toIdList(owned.engineerRegistrationApplicationIds);
  }

  const residueHasCandidates =
    (residue?.organizations?.length ?? 0) > 0 ||
    (residue?.accounts?.length ?? 0) > 0 ||
    (residue?.equipmentModels?.length ?? 0) > 0 ||
    (residue?.thirdPartyAuths?.length ?? 0) > 0 ||
    (residue?.verificationRecords?.length ?? 0) > 0 ||
    (residue?.repairRequests?.length ?? 0) > 0 ||
    (residue?.engineerResponses?.length ?? 0) > 0 ||
    retainedAccounts.length > 0;
  if (!residueHasCandidates && !hasAnyResource(plan)) {
    return;
  }

  await dataSource.transaction(async (manager) => {
    // N04：实际删除连接（同一事务 manager）必须再次核对预期库名，
    // 不能只依赖连接池另一条连接上的入口校验。
    await assertManagerOnExpectedE2eDatabase(manager, expected);
    if (owned) {
      // R02：同一事务内锁定登记资源并核对预期事实，任何漂移都先于第一条 DELETE 失败。
      await verifyOwnedExpectations(manager, owned, helper);
    }
    let retainedAccountIds: number[] = [];
    if (residueHasCandidates) {
      const resolved = await resolveResidue(manager, residue ?? {}, retainedAccounts, helper, plan);
      retainedAccountIds = resolved.retainedAccountIds;
    }
    await collectOwnedGraph(manager, plan, [...plan.accountIds, ...retainedAccountIds], helper);
    if (!hasAnyResource(plan)) {
      return;
    }
    await deleteVerifiedPlan(manager, plan);
  });
};

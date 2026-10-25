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
import { assertDataSourceOnAllowedE2eDatabase, assertPhysicalCleanupConsent } from './e2e-db-guard';
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
  | 'equipmentModel';

const LEDGER_KEY_BY_CATEGORY: Record<OwnedResourceCategory, keyof OwnedResourceLedger> = {
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
});

/** 登记数据库真实生成 ID；只接受正整数并按类别去重。 */
export const recordOwnedResource = (
  ledger: OwnedResourceLedger,
  category: OwnedResourceCategory,
  id: number,
): number => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`清理资源登记失败：${category} ID 必须为正整数，收到 ${String(id)}`);
  }
  const key = LEDGER_KEY_BY_CATEGORY[category];
  const ids = ledger[key];
  if (!ids.includes(id)) {
    ids.push(id);
  }
  return id;
};

const toIdList = (ids: readonly number[]): number[] => [...new Set(ids)].filter((id) => id > 0);

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

const sameJson = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(normalizeJson(actual)) === JSON.stringify(expected);

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

interface AccountRow {
  id: number;
  login_name: string | null;
  login_email: string | null;
  status: unknown;
  identity_hint: string | null;
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

/**
 * 残留恢复：自然键只能定位候选，逐字段指纹匹配通过后才把精确 ID 并入删除集合。
 * 匹配失败即冲突，绝不接管同名异主账号/组织。
 */
const resolveResidue = async (
  manager: EntityManager,
  residue: NonNullable<Parameters<typeof runGuardedSpecCleanup>[0]['residue']>,
  retainedAccounts: readonly ResidueAccountFingerprint[],
  helper: string,
  plan: CleanupPlan,
): Promise<number[]> => {
  const organizations = residue.organizations ?? [];
  const accounts = [...(residue.accounts ?? []), ...retainedAccounts];
  const equipmentModels = residue.equipmentModels ?? [];
  const retainedLoginKeys = new Set(
    retainedAccounts.flatMap((spec) => [spec.loginName, spec.loginEmail]).filter(Boolean),
  );
  const retainedAccountIds: number[] = [];

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
      return retainedAccountIds;
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
      ].filter(
        (row, index, all) => all.findIndex((item) => Number(item.id) === Number(row.id)) === index,
      );

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
    }
  }

  return retainedAccountIds;
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

    const externalTables: Array<{ table: string; columns: readonly string[] }> = [
      {
        table: 'repair_request',
        columns: ['customer_account_id', 'accepted_by_engineer_account_id'],
      },
      { table: 'ai_conversation', columns: ['engineer_account_id'] },
      { table: 'ai_report', columns: ['engineer_account_id'] },
      { table: 'engineer_response', columns: ['engineer_account_id', 'customer_account_id'] },
    ];
    for (const entry of externalTables) {
      const conditions = entry.columns
        .map((column) => `${column} IN (${placeholders})`)
        .join(' OR ');
      const params = entry.columns.flatMap(() => accountIds);
      const rows = await manager.query(
        `SELECT id FROM ${entry.table} WHERE ${conditions} LIMIT 1`,
        params,
      );
      if (rows.length > 0) {
        conflict(helper, entry.table, String(rows[0].id), '外部业务记录引用了本轮账号，拒绝删除');
      }
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
}): Promise<void> => {
  const { dataSource, cleanup, helper } = params;

  try {
    assertPhysicalCleanupConsent();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=清理许可门禁 拒绝执行删除：${detail}`, { cause: error });
  }

  await assertDataSourceOnAllowedE2eDatabase(dataSource);

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
  };
  /**
   * 由相邻守护清理步骤拥有、仅用于归属核验的账号指纹（不纳入本事务删除）。
   * 用于 10 组“组织链 + fixture 账号分两步”的组合清理。
   */
  readonly retainedAccounts?: readonly ResidueAccountFingerprint[];
}): Promise<void> => {
  const { dataSource, helper, owned, residue, retainedAccounts = [] } = params;

  try {
    assertPhysicalCleanupConsent();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=清理许可门禁 拒绝执行删除：${detail}`, { cause: error });
  }

  await assertDataSourceOnAllowedE2eDatabase(dataSource);

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
  }

  const residueHasCandidates =
    (residue?.organizations?.length ?? 0) > 0 ||
    (residue?.accounts?.length ?? 0) > 0 ||
    (residue?.equipmentModels?.length ?? 0) > 0 ||
    retainedAccounts.length > 0;
  if (!residueHasCandidates && !hasAnyResource(plan)) {
    return;
  }

  await dataSource.transaction(async (manager) => {
    let retainedAccountIds: number[] = [];
    if (residueHasCandidates) {
      retainedAccountIds = await resolveResidue(
        manager,
        residue ?? {},
        retainedAccounts,
        helper,
        plan,
      );
    }
    await collectOwnedGraph(manager, plan, [...plan.accountIds, ...retainedAccountIds], helper);
    if (!hasAnyResource(plan)) {
      return;
    }
    await deleteVerifiedPlan(manager, plan);
  });
};

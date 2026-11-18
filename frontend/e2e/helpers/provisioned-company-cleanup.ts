// e2e/helpers/provisioned-company-cleanup.ts
//
// 「新增公司并开通二级管理员」（S4）真实联调用例的共享夹具工具：
//
// - `provisionCompanyViaApi`：以一级管理员身份经真实 GraphQL 开通公司与二级管理员，
//   只返回响应中的真实主键与本次一次性口令（口令由调用方即用即弃，不写入证据）；
// - `cleanupProvisionedCompany`：按**响应返回的真实主键**在单一事务内清理本轮开通数据
//   （审计 → 开通请求 → 成员关系 → 资料 → 账号 → 公司），先全量核验再首删；
// - `readProvisionedCompanyResidue`：清理后逐表核对残留为 0；
// - `attemptPasswordLogin`：真实登录入口的裸调用，用于验证补发后旧口令立即失效。
//
// 安全边界：
// - 只按本轮登记的真实主键删除，禁止按公司名/编号前缀/登录名扫描；
// - 首删前校验公司编号与名称、账号登录名、开通请求归属、成员关系/资料各恰一行，
//   并拒绝本公司下存在账外成员/账外资料/账外开通请求；
// - 任何断言不通过时事务立即中止，不会执行任何 DELETE；
// - 口令不进入日志与断言消息。

import { DEDICATED_E2E_DB_NAME } from '../../e2e-real/dedicated-e2e-environment';

import { renderGuardedAssertion } from './dedicated-account-cleanup';
import {
  BACKEND_GRAPHQL,
  mysqlQuery,
  readBackendEnv,
  realGraphqlCall,
  runGuardedFixtureWrite,
} from './real-backend';

/** 本轮开通公司 + 二级管理员的精确事实（全部来自创建响应） */
export interface ProvisionedCompanyFacts {
  readonly organizationId: number;
  readonly organizationCode: string;
  readonly organizationName: string;
  readonly adminAccountId: number;
  readonly adminLoginName: string;
  readonly provisioningRequestId: number;
}

/** 清理后逐表残留计数（全部必须为 0） */
export interface ProvisionedCompanyResidue {
  readonly account: number;
  readonly audit: number;
  readonly membership: number;
  readonly organization: number;
  readonly provisioningRequest: number;
  readonly userInfo: number;
}

const SQL_LITERAL_PATTERN = /^[^'\\]{1,4096}$/u;

const ADMIN_PROVISION_COMPANY_MUTATION = `
  mutation AdminProvisionCompany($input: AdminCreateOrganizationInput!) {
    adminProvisionCompany(input: $input) {
      organization { id organizationCode name }
      provisionedAdmin { accountId loginName nickname mustChangePassword }
      submission { submissionId replayed }
      temporaryPassword
    }
  }
`;

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) {
      accessToken
      restriction
    }
  }
`;

type ProvisioningPayload = {
  organization?: { id?: number; organizationCode?: string; name?: string };
  provisionedAdmin?: {
    accountId?: number;
    loginName?: string;
    mustChangePassword?: boolean;
  };
  submission?: { submissionId?: number | null; replayed?: boolean };
  temporaryPassword?: string | null;
};

function assertPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 不是可信正整数，拒绝继续：${JSON.stringify(value)}`);
  }

  return value;
}

function assertSqlLiteral(value: string, label: string): void {
  if (!SQL_LITERAL_PATTERN.test(value)) {
    throw new Error(`${label} 未通过 SQL 字面量白名单，拒绝拼接：${JSON.stringify(value)}`);
  }
}

function assertFacts(facts: ProvisionedCompanyFacts): void {
  assertPositiveInteger(facts.organizationId, '公司主键');
  assertPositiveInteger(facts.adminAccountId, '二级管理员账号主键');
  assertPositiveInteger(facts.provisioningRequestId, '开通请求主键');
  assertSqlLiteral(facts.organizationCode, '公司编号');
  assertSqlLiteral(facts.organizationName, '公司名称');
  assertSqlLiteral(facts.adminLoginName, '管理员登录名');
}

/**
 * 与后端 `maskLoginName()` 同口径的脱敏值：首字符 + `***` + 末字符，长度 ≤2 只留首字符。
 *
 * 前端只允许展示脱敏登录名，断言必须按同一规则计算期望值；空串回退为 `(空)`。
 */
export function maskLoginName(loginName: string): string {
  const trimmed = loginName.trim();

  if (trimmed.length === 0) {
    return '(空)';
  }

  if (trimmed.length <= 2) {
    return `${trimmed.slice(0, 1)}***`;
  }

  return `${trimmed.slice(0, 1)}***${trimmed.slice(-1)}`;
}

/** 从开通响应提取并校验清理所需事实；字段缺失/形态异常直接拒绝登记 */
export function readProvisionedCompanyFacts(payload: unknown): {
  facts: ProvisionedCompanyFacts;
  temporaryPassword: string;
  replayed: boolean;
} {
  const candidate = payload as ProvisioningPayload | null | undefined;
  const organization = candidate?.organization;
  const admin = candidate?.provisionedAdmin;
  const submission = candidate?.submission;
  const temporaryPassword = candidate?.temporaryPassword;

  if (
    organization === undefined ||
    admin === undefined ||
    submission === undefined ||
    typeof organization.name !== 'string' ||
    organization.name === '' ||
    typeof organization.organizationCode !== 'string' ||
    organization.organizationCode === '' ||
    typeof admin.loginName !== 'string' ||
    admin.loginName === ''
  ) {
    throw new Error('开通响应缺少可核验的公司/管理员事实，拒绝登记清理边界');
  }

  if (submission.replayed !== false) {
    throw new Error('开通响应被判定为回放，首次创建事实不成立，拒绝登记');
  }

  if (typeof temporaryPassword !== 'string' || temporaryPassword === '') {
    throw new Error('开通响应未返回一次性临时密码，拒绝继续');
  }

  return {
    facts: {
      adminAccountId: assertPositiveInteger(admin.accountId, '二级管理员账号主键'),
      adminLoginName: admin.loginName,
      organizationCode: organization.organizationCode,
      organizationId: assertPositiveInteger(organization.id, '公司主键'),
      organizationName: organization.name,
      provisioningRequestId: assertPositiveInteger(submission.submissionId, '开通请求主键'),
    },
    replayed: false,
    temporaryPassword,
  };
}

/**
 * 以一级管理员身份经真实 GraphQL 开通公司与二级管理员。
 *
 * 仅用于需要独立二级管理员夹具的用例；调用方必须先临时设置一级等级与恢复等级。
 */
export async function provisionCompanyViaApi(
  env: Record<string, string>,
  input: {
    readonly contactPhone: string;
    readonly isServiceProvider: boolean;
    readonly name: string;
    readonly operatorLogin: string;
    readonly submissionKey: string;
  },
): Promise<{ facts: ProvisionedCompanyFacts; temporaryPassword: string }> {
  const { body } = await realGraphqlCall(
    env,
    ADMIN_PROVISION_COMPANY_MUTATION,
    {
      input: {
        address: null,
        contactEmail: null,
        contactName: null,
        contactPhone: input.contactPhone,
        isServiceProvider: input.isServiceProvider,
        name: input.name,
        remark: null,
        shortName: null,
        status: 'ACTIVE',
        submissionKey: input.submissionKey,
      },
    },
    input.operatorLogin,
  );
  const response = body as {
    data?: { adminProvisionCompany?: unknown };
    errors?: Array<{ message?: string }>;
  };

  if (Array.isArray(response.errors) && response.errors.length > 0) {
    // GraphQL 错误消息不含口令；只带 message，便于定位拒绝原因
    throw new Error(
      `开通请求返回 GraphQL 错误，拒绝登记：${JSON.stringify(
        response.errors.map((item) => item.message ?? ''),
      )}`,
    );
  }

  const payload = response.data?.adminProvisionCompany;
  const { facts, temporaryPassword } = readProvisionedCompanyFacts(payload);

  if (facts.organizationName !== input.name) {
    throw new Error('开通响应公司名称与请求不一致，拒绝登记');
  }

  return { facts, temporaryPassword };
}

/**
 * 按登记事实回收本轮开通数据：单一事务内先绑定所有权并逐表核验，再按主键删除。
 *
 * 删除顺序由外键 RESTRICT 决定：审计 → 开通请求 → 成员关系 → 资料 → 账号 → 公司。
 * 任何前置断言失败都在首次 DELETE 之前中止（标记 `pc_*`），不会留下部分删除。
 */
export function cleanupProvisionedCompany(facts: ProvisionedCompanyFacts): void {
  assertFacts(facts);

  const organizationId = facts.organizationId;
  const accountId = facts.adminAccountId;
  const requestId = facts.provisioningRequestId;

  const statements: string[] = [
    'START TRANSACTION',
    'SET @pc_database = DATABASE()',
    ...renderGuardedAssertion(
      'pc_database',
      `@pc_database = '${DEDICATED_E2E_DB_NAME}'`,
      'pc_database_must_equal_strict_dedicated_e2e',
    ),
    `SELECT id INTO @pc_org_row FROM organization WHERE id = ${organizationId} AND organization_code = '${facts.organizationCode}' AND name = '${facts.organizationName}' FOR UPDATE`,
    ...renderGuardedAssertion(
      'pc_org',
      `@pc_org_row = ${organizationId}`,
      'pc_org_binding_mismatch',
    ),
    `SELECT id INTO @pc_account_row FROM base_user_account WHERE id = ${accountId} AND login_name = '${facts.adminLoginName}' FOR UPDATE`,
    ...renderGuardedAssertion(
      'pc_account',
      `@pc_account_row = ${accountId}`,
      'pc_account_binding_mismatch',
    ),
    `SELECT COUNT(*) INTO @pc_request_count FROM admin_organization_provisioning_request WHERE id = ${requestId} AND organization_id = ${organizationId} AND admin_account_id = ${accountId}`,
    ...renderGuardedAssertion(
      'pc_request',
      '@pc_request_count = 1',
      'pc_provisioning_request_mismatch',
    ),
    `SELECT COUNT(*) INTO @pc_membership_count FROM organization_membership WHERE organization_id = ${organizationId} AND account_id = ${accountId}`,
    ...renderGuardedAssertion(
      'pc_membership',
      '@pc_membership_count = 1',
      'pc_membership_mismatch',
    ),
    `SELECT COUNT(*) INTO @pc_user_info_count FROM base_user_info WHERE account_id = ${accountId} AND customer_organization_id = ${organizationId}`,
    ...renderGuardedAssertion('pc_user_info', '@pc_user_info_count = 1', 'pc_user_info_mismatch'),
    `SELECT COUNT(*) INTO @pc_other_membership FROM organization_membership WHERE organization_id = ${organizationId} AND account_id <> ${accountId}`,
    ...renderGuardedAssertion(
      'pc_other_membership',
      '@pc_other_membership = 0',
      'pc_unregistered_membership',
    ),
    `SELECT COUNT(*) INTO @pc_other_user_info FROM base_user_info WHERE customer_organization_id = ${organizationId} AND account_id <> ${accountId}`,
    ...renderGuardedAssertion(
      'pc_other_user_info',
      '@pc_other_user_info = 0',
      'pc_unregistered_user_info',
    ),
    `SELECT COUNT(*) INTO @pc_other_request FROM admin_organization_provisioning_request WHERE organization_id = ${organizationId} AND id <> ${requestId}`,
    ...renderGuardedAssertion(
      'pc_other_request',
      '@pc_other_request = 0',
      'pc_unregistered_provisioning_request',
    ),
    // 公司为本轮新建：组织维度审计只可能来自本轮补发/重置，按组织精确删除
    `DELETE FROM management_audit_event WHERE organization_id = ${organizationId}`,
    `DELETE FROM admin_organization_provisioning_request WHERE id = ${requestId} AND organization_id = ${organizationId} AND admin_account_id = ${accountId}`,
    'SET @pc_deleted = ROW_COUNT()',
    ...renderGuardedAssertion(
      'pc_delete_request',
      '@pc_deleted = 1',
      'pc_delete_request_rows_mismatch',
    ),
    `DELETE FROM organization_membership WHERE organization_id = ${organizationId} AND account_id = ${accountId}`,
    'SET @pc_deleted = ROW_COUNT()',
    ...renderGuardedAssertion(
      'pc_delete_membership',
      '@pc_deleted = 1',
      'pc_delete_membership_rows_mismatch',
    ),
    `DELETE FROM base_user_info WHERE account_id = ${accountId} AND customer_organization_id = ${organizationId}`,
    'SET @pc_deleted = ROW_COUNT()',
    ...renderGuardedAssertion(
      'pc_delete_user_info',
      '@pc_deleted = 1',
      'pc_delete_user_info_rows_mismatch',
    ),
    `DELETE FROM base_user_account WHERE id = ${accountId} AND login_name = '${facts.adminLoginName}'`,
    'SET @pc_deleted = ROW_COUNT()',
    ...renderGuardedAssertion(
      'pc_delete_account',
      '@pc_deleted = 1',
      'pc_delete_account_rows_mismatch',
    ),
    `DELETE FROM organization WHERE id = ${organizationId} AND organization_code = '${facts.organizationCode}'`,
    'SET @pc_deleted = ROW_COUNT()',
    ...renderGuardedAssertion(
      'pc_delete_organization',
      '@pc_deleted = 1',
      'pc_delete_organization_rows_mismatch',
    ),
    `SET @pc_residual = (SELECT COUNT(*) FROM management_audit_event WHERE organization_id = ${organizationId}) + (SELECT COUNT(*) FROM admin_organization_provisioning_request WHERE organization_id = ${organizationId}) + (SELECT COUNT(*) FROM organization_membership WHERE organization_id = ${organizationId}) + (SELECT COUNT(*) FROM base_user_info WHERE customer_organization_id = ${organizationId}) + (SELECT COUNT(*) FROM base_user_account WHERE id = ${accountId}) + (SELECT COUNT(*) FROM organization WHERE id = ${organizationId})`,
    ...renderGuardedAssertion('pc_residual', '@pc_residual = 0', 'pc_residual_rows_remaining'),
    'COMMIT',
  ];

  runGuardedFixtureWrite(readBackendEnv(), statements.join('; '));
}

/** 清理后残留计数：六张表全部必须为 0，供用例末尾显式断言 */
export function readProvisionedCompanyResidue(
  facts: ProvisionedCompanyFacts,
): ProvisionedCompanyResidue {
  assertFacts(facts);

  const value = (sql: string): number => Number(mysqlQuery(sql));

  return {
    account: value(`SELECT COUNT(*) FROM base_user_account WHERE id = ${facts.adminAccountId}`),
    audit: value(
      `SELECT COUNT(*) FROM management_audit_event WHERE organization_id = ${facts.organizationId}`,
    ),
    membership: value(
      `SELECT COUNT(*) FROM organization_membership WHERE organization_id = ${facts.organizationId}`,
    ),
    organization: value(`SELECT COUNT(*) FROM organization WHERE id = ${facts.organizationId}`),
    provisioningRequest: value(
      `SELECT COUNT(*) FROM admin_organization_provisioning_request WHERE organization_id = ${facts.organizationId}`,
    ),
    userInfo: value(
      `SELECT COUNT(*) FROM base_user_info WHERE customer_organization_id = ${facts.organizationId}`,
    ),
  };
}

/** 二级管理员绑定事实（只读核验：等级、状态、强制改密、组织管理员成员关系） */
export function readProvisionedAdminFacts(accountId: number): {
  readonly adminLevel: string;
  readonly loginName: string;
  readonly memberRole: string;
  readonly membershipStatus: string;
  readonly mustChangePassword: string;
  readonly status: string;
} {
  assertPositiveInteger(accountId, '二级管理员账号主键');

  const row = mysqlQuery(
    `SELECT COALESCE(login_name, '<NULL>'), status, COALESCE(admin_level, 'NULL'), must_change_password FROM base_user_account WHERE id = ${accountId}`,
  );

  if (row === '') {
    throw new Error(`base_user_account 未返回 id=${accountId} 的行`);
  }

  const [loginName, status, adminLevel, mustChangePassword] = row.split('\t');
  const membership = mysqlQuery(
    `SELECT member_role, status FROM organization_membership WHERE account_id = ${accountId}`,
  );
  const [memberRole, membershipStatus] =
    membership === '' ? ['<NONE>', '<NONE>'] : membership.split('\t');

  return {
    adminLevel,
    loginName,
    memberRole,
    membershipStatus,
    mustChangePassword,
    status,
  };
}

/**
 * 真实登录入口的裸调用（不抛错）：返回令牌与首个错误大类。
 *
 * 供「补发后旧口令立即失效、新口令可签发受限会话」的 API 级断言使用。
 */
export async function attemptPasswordLogin(
  loginName: string,
  loginPassword: string,
  allowRestrictedSession = false,
): Promise<{ accessToken: string | null; code: string | null }> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({
      query: LOGIN_MUTATION,
      variables: {
        input: {
          allowRestrictedSession,
          audience: 'SSTSWEB',
          loginName,
          loginPassword,
          type: 'PASSWORD',
        },
      },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const body = (await response.json()) as {
    data?: { login?: { accessToken?: string | null } };
    errors?: Array<{ extensions?: { code?: string } }>;
  };

  return {
    accessToken: body.data?.login?.accessToken ?? null,
    code: body.errors?.[0]?.extensions?.code ?? null,
  };
}

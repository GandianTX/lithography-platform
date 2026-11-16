// e2e/helpers/registration-round-cleanup.ts
//
// 注册手填公司名真实浏览器规格的「按实际 ID 台账」清理实现。
//
// 背景（B 复审 P1）：旧收尾按登录邮箱、同名未受管公司名称、编码前缀 LIKE 删除，
// 未要求目标是本轮真实创建的 ID——同库中他人预置的同名/同前缀行会被直接删除，
// 且前缀里的下划线在 LIKE 中是通配符。
//
// 现在的安全边界：
// - 受管夹具公司、手填公司、账号、资料、成员关系全部按**数据库真实生成 ID** 登记；
// - 公司插入拿到 `LAST_INSERT_ID()` 即先按已知预期入账，再回读核验（回读失败不丢 ID）；
// - 账号 ID 来自真实注册响应，资料/成员关系/手填公司由归属事实（account_id →
//   customer_organization_id ↔ organization_id）定位并逐字段核验；
// - 空台账直接 no-op，不启动 mysql；成功清理后台账立即释放，避免重复删除误报；
// - 入口复用 real-backend 的显式许可 + 严格专用库名 + 实际 DATABASE() 门；
// - 生成单一事务脚本：先全量 FOR UPDATE 锁定核验、再核对集合外引用与
//   **台账内子表的账外子行**（base_user_info / organization_membership /
//   engineer_registration_application）均为 0，全部通过后才按「申请 → 成员关系 →
//   资料 → 账号 → 自有未受管公司 → 受管夹具公司」逐条删除（ROW_COUNT=1），
//   最后核对全批残留为 0 并 COMMIT。

import { DEDICATED_E2E_DB_NAME } from '../../e2e-real/dedicated-e2e-environment';

import { renderGuardedAssertion } from './dedicated-account-cleanup';
import { mysqlQuery, readBackendEnv, runGuardedFixtureWrite } from './real-backend';

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const ENUM_TOKEN_PATTERN = /^[A-Z_]{1,32}$/;
const CLEANUP_IN_SET_TABLES: readonly string[] = [
  'base_user_account',
  'base_user_info',
  'organization_membership',
];

export interface RegistrationRoundOrganizationFacts {
  readonly id: number;
  readonly organizationCode: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly isManagedCompany: boolean;
  readonly isServiceProvider: boolean;
}

export interface RegistrationRoundAccountFacts {
  readonly id: number;
  /** 客户自助注册不填登录名，库内为 NULL（绑定与删除都必须按 IS NULL 处理） */
  readonly loginName: string | null;
  readonly loginEmail: string;
}

export interface RegistrationRoundUserInfoFacts {
  readonly id: number;
  readonly accountId: number;
  readonly email: string;
  readonly customerOrganizationId: number | null;
}

export interface RegistrationRoundMembershipFacts {
  readonly id: number;
  readonly accountId: number;
  readonly organizationId: number;
}

/** 本轮经真实注册入口产生的工程师待审申请：删除只认登记的真实主键 */
export interface RegistrationRoundApplicationFacts {
  readonly id: number;
  readonly accountId: number;
}

/** 本轮创建并登记的资源台账（清理由此精确推导，禁止再按名称/前缀扫描）。 */
export interface RegistrationRoundLedger {
  organizations: RegistrationRoundOrganizationFacts[];
  accounts: RegistrationRoundAccountFacts[];
  userInfos: RegistrationRoundUserInfoFacts[];
  memberships: RegistrationRoundMembershipFacts[];
  applications: RegistrationRoundApplicationFacts[];
  /**
   * 仅被本轮资料/成员关系引用、但**不属于本轮创建**的公司（例如 seed 可信公司）。
   * 它们只用于放行子行的归属事实，永不进入删除脚本。
   */
  retainedOrganizationIds: number[];
}

export const createRegistrationRoundLedger = (): RegistrationRoundLedger => ({
  organizations: [],
  accounts: [],
  userInfos: [],
  memberships: [],
  applications: [],
  retainedOrganizationIds: [],
});

export interface RegistrationRoundOrganizationInput {
  readonly organizationCode: string;
  readonly name: string;
  readonly kind: 'CLIENT' | 'PEER';
  readonly isManagedCompany: boolean;
  readonly isServiceProvider?: boolean;
  readonly status?: string;
}

/** 外部引用列：集合外任何对这些列指向本轮 ID 的行都必须为 0。 */
export interface RegistrationRoundCleanupReference {
  readonly table: string;
  readonly column: string;
}

export interface RegistrationRoundReferences {
  readonly account: readonly RegistrationRoundCleanupReference[];
  readonly organization: readonly RegistrationRoundCleanupReference[];
  /**
   * 台账内子表（base_user_info / organization_membership）指向本轮父行的边：
   * 只允许**实际登记且父子事实一致**的子行，其余子行必须在首删前明确拒绝。
   */
  readonly inSet?: readonly RegistrationRoundInSetReference[];
}

/** 台账内子表的引用边：注明父行属于账号还是公司 */
export interface RegistrationRoundInSetReference extends RegistrationRoundCleanupReference {
  readonly target: 'account' | 'organization';
}

/** 台账内可产生「指向本轮父行」子行的表 */
const IN_SET_CHILD_TABLES: readonly string[] = [
  'base_user_info',
  'engineer_registration_application',
  'organization_membership',
];

/** 可注入依赖：单测据此覆盖空台账、许可、库名、写入失败等反向场景。 */
export interface RegistrationRoundCleanupDeps {
  readonly readEnv: () => Record<string, string>;
  readonly query: (sql: string) => string;
  readonly write: (env: Record<string, string>, sql: string) => string;
  readonly discoverReferences: (query: (sql: string) => string) => RegistrationRoundReferences;
}

const defaultDeps: RegistrationRoundCleanupDeps = {
  discoverReferences: (query) => discoverRegistrationRoundReferences(query),
  query: mysqlQuery,
  readEnv: readBackendEnv,
  write: runGuardedFixtureWrite,
};

const assertPositiveInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} 未通过正整数校验，拒绝执行：${JSON.stringify(value)}`);
  }
  return value;
};

const assertEnumToken = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !ENUM_TOKEN_PATTERN.test(value)) {
    throw new Error(`${field} 不是受控枚举，拒绝执行：${JSON.stringify(value)}`);
  }
  return value;
};

const assertTextField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} 为空或非字符串，拒绝执行：${JSON.stringify(value)}`);
  }
  return value;
};

const utf8Hex = (value: string): string => Buffer.from(value, 'utf8').toString('hex').toUpperCase();

const hexEquals = (column: string, value: string): string => `HEX(${column}) = '${utf8Hex(value)}'`;

const booleanLiteral = (value: unknown, field: string): string => {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} 必须为布尔值，拒绝执行：${JSON.stringify(value)}`);
  }
  return value ? '1' : '0';
};

const parseTabRows = (output: string): string[][] =>
  output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));

const requireSingleRow = (output: string, description: string): string[] => {
  const rows = parseTabRows(output);
  if (rows.length !== 1) {
    throw new Error(
      `${description} 应恰好命中 1 行，实际 ${rows.length} 行：${JSON.stringify(output)}`,
    );
  }
  return rows[0];
};

const parseNullableText = (value: string | undefined, field: string): string | null => {
  if (value === undefined || value === 'NULL') {
    return null;
  }
  return assertTextField(value, field);
};

const parseNullableInteger = (value: string | undefined, field: string): number | null => {
  if (value === undefined || value === 'NULL') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} 不是正整数或 NULL，拒绝执行：${JSON.stringify(value)}`);
  }
  return parsed;
};

/** 台账是否为空：为空时清理必须完全 no-op，不读取环境也不启动 mysql。 */
export const isRegistrationRoundLedgerEmpty = (ledger: RegistrationRoundLedger): boolean =>
  ledger.organizations.length === 0 &&
  ledger.accounts.length === 0 &&
  ledger.userInfos.length === 0 &&
  ledger.memberships.length === 0 &&
  ledger.applications.length === 0;

export function registerRegistrationRoundOrganization(
  ledger: RegistrationRoundLedger,
  facts: RegistrationRoundOrganizationFacts,
): void {
  assertPositiveInteger(facts.id, '公司 ID');
  assertTextField(facts.organizationCode, '公司编码');
  assertTextField(facts.name, '公司名称');
  assertEnumToken(facts.kind, '公司类别');
  assertEnumToken(facts.status, '公司状态');
  booleanLiteral(facts.isManagedCompany, '受管标记');
  booleanLiteral(facts.isServiceProvider, '服务商标记');

  if (ledger.organizations.some((item) => item.id === facts.id)) {
    throw new Error(`公司台账登记被拒绝：ID ${facts.id} 重复登记`);
  }
  ledger.organizations.push({ ...facts });
}

export function registerRegistrationRoundAccount(
  ledger: RegistrationRoundLedger,
  facts: RegistrationRoundAccountFacts,
): void {
  assertPositiveInteger(facts.id, '账号 ID');
  if (facts.loginName !== null) {
    assertTextField(facts.loginName, '登录名');
  }
  assertTextField(facts.loginEmail, '登录邮箱');

  if (ledger.accounts.some((item) => item.id === facts.id)) {
    throw new Error(`账号台账登记被拒绝：ID ${facts.id} 重复登记`);
  }
  ledger.accounts.push({ ...facts });
}

export function registerRegistrationRoundUserInfo(
  ledger: RegistrationRoundLedger,
  facts: RegistrationRoundUserInfoFacts,
): void {
  assertPositiveInteger(facts.id, '资料 ID');
  assertPositiveInteger(facts.accountId, '资料归属账号 ID');
  assertTextField(facts.email, '资料邮箱');
  if (facts.customerOrganizationId !== null) {
    assertPositiveInteger(facts.customerOrganizationId, '资料归属公司 ID');
  }

  if (ledger.userInfos.some((item) => item.id === facts.id)) {
    throw new Error(`资料台账登记被拒绝：ID ${facts.id} 重复登记`);
  }
  ledger.userInfos.push({ ...facts });
}

export function registerRegistrationRoundMembership(
  ledger: RegistrationRoundLedger,
  facts: RegistrationRoundMembershipFacts,
): void {
  assertPositiveInteger(facts.id, '成员关系 ID');
  assertPositiveInteger(facts.accountId, '成员关系账号 ID');
  assertPositiveInteger(facts.organizationId, '成员关系公司 ID');

  if (ledger.memberships.some((item) => item.id === facts.id)) {
    throw new Error(`成员关系台账登记被拒绝：ID ${facts.id} 重复登记`);
  }
  ledger.memberships.push({ ...facts });
}

export function registerRegistrationRoundApplication(
  ledger: RegistrationRoundLedger,
  facts: RegistrationRoundApplicationFacts,
): void {
  assertPositiveInteger(facts.id, '申请 ID');
  assertPositiveInteger(facts.accountId, '申请归属账号 ID');

  if (ledger.applications.some((item) => item.id === facts.id)) {
    throw new Error(`申请台账登记被拒绝：ID ${facts.id} 重复登记`);
  }
  ledger.applications.push({ ...facts });
}

/**
 * 登记「只被引用、不删除」的外部公司（seed 可信公司等）。
 *
 * 只影响台账完整性校验：资料 / 成员关系允许归属到这些公司，但删除脚本只按
 * `organizations` 里的本轮创建行生成，保留公司永远不会出现在任何 DELETE 中。
 */
export function retainRegistrationRoundOrganization(
  ledger: RegistrationRoundLedger,
  organizationId: number,
): void {
  const id = assertPositiveInteger(organizationId, '保留公司 ID');

  if (ledger.organizations.some((item) => item.id === id)) {
    throw new Error(`保留公司 ${id} 已登记为本轮可删除公司，拒绝重复登记`);
  }
  if (!ledger.retainedOrganizationIds.includes(id)) {
    ledger.retainedOrganizationIds.push(id);
  }
}

/**
 * 按登记的账号 ID 回读 `base_user_info` 真实 ID 与归属事实（只读）。
 *
 * 账号注册成功后立即调用并登记，避免清理阶段把「父账号下所有资料行」当成夹具。
 */
export function readRegistrationRoundUserInfoByAccountId(
  accountId: number,
  deps: Pick<RegistrationRoundCleanupDeps, 'query'> = defaultDeps,
): RegistrationRoundUserInfoFacts {
  assertPositiveInteger(accountId, '资料回读账号 ID');

  const row = requireSingleRow(
    deps.query(
      [
        'SELECT id, account_id, email, COALESCE(customer_organization_id, 0)',
        'FROM base_user_info',
        `WHERE account_id = ${accountId}`,
      ].join(' '),
    ),
    `账号 ${accountId} 的资料行`,
  );
  const customerOrganizationId = Number(row[3]);

  return {
    accountId: Number(row[1]),
    customerOrganizationId: customerOrganizationId === 0 ? null : customerOrganizationId,
    email: row[2],
    id: Number(row[0]),
  };
}

/**
 * 按「账号 + 公司 + 角色 + 状态」窄条件回读**唯一**成员关系真实 ID（只读）。
 *
 * 登记证据只能是调用处已知的目标事实：成员关系在注册事务内由业务写入，
 * 因此必须先按已知账号与目标公司定位，再在结果唯一时登记真实主键。
 * 按账号回读全量成员行会把「同账号下其它成员关系」一并吸收进台账，
 * 首删前的预检只看成员主键是否登记，因此无法识别这类误收行（第三轮 P1）。
 * 零行（业务未写入）或多行（与预期不符）一律失败关闭，由调用方保留不明行。
 */
export function readRegistrationRoundMembershipByScope(
  scope: {
    accountId: number;
    memberRole: string;
    organizationId: number;
    status: string;
  },
  deps: Pick<RegistrationRoundCleanupDeps, 'query'> = defaultDeps,
): RegistrationRoundMembershipFacts {
  const accountId = assertPositiveInteger(scope.accountId, '成员关系回读账号 ID');
  const organizationId = assertPositiveInteger(scope.organizationId, '成员关系回读公司 ID');
  const memberRole = assertEnumToken(scope.memberRole, '成员关系角色');
  const status = assertEnumToken(scope.status, '成员关系状态');

  const row = requireSingleRow(
    deps.query(
      [
        'SELECT id, account_id, organization_id',
        'FROM organization_membership',
        `WHERE account_id = ${accountId}`,
        `AND organization_id = ${organizationId}`,
        `AND member_role = '${memberRole}'`,
        `AND status = '${status}'`,
      ].join(' '),
    ),
    `账号 ${accountId} 在组织 ${organizationId} 的 ${memberRole}/${status} 成员关系`,
  );

  return {
    accountId: Number(row[1]),
    id: Number(row[0]),
    organizationId: Number(row[2]),
  };
}

/**
 * 插入一条受管/未受管公司并**立即**按 `LAST_INSERT_ID()` 登记真实 ID。
 *
 * 仅接受代码内构造的输入；SQL 文本值一律经 HEX 绑定，不做字符串拼接转义。
 */
export function insertRegistrationRoundOrganization(
  ledger: RegistrationRoundLedger,
  input: RegistrationRoundOrganizationInput,
  deps: Pick<RegistrationRoundCleanupDeps, 'readEnv' | 'query' | 'write'> = defaultDeps,
): number {
  assertTextField(input.organizationCode, '公司编码');
  assertTextField(input.name, '公司名称');
  assertEnumToken(input.kind, '公司类别');
  const status = input.status ?? 'ACTIVE';
  assertEnumToken(status, '公司状态');
  const isManaged = booleanLiteral(input.isManagedCompany, '受管标记');
  const isServiceProvider = booleanLiteral(input.isServiceProvider ?? false, '服务商标记');

  const env = deps.readEnv();
  const output = deps.write(
    env,
    [
      `INSERT INTO organization (organization_code, name, kind, status, is_managed_company, is_service_provider) VALUES (CONVERT(UNHEX('${utf8Hex(input.organizationCode)}') USING utf8mb4), CONVERT(UNHEX('${utf8Hex(input.name)}') USING utf8mb4), '${input.kind}', '${status}', ${isManaged}, ${isServiceProvider})`,
      'SELECT LAST_INSERT_ID()',
    ].join('; '),
  );

  const id = Number(requireSingleRow(output, '公司插入后 LAST_INSERT_ID()')[0]);
  assertPositiveInteger(id, '公司插入返回 ID');

  // P2-01：拿到真实生成 ID 就**先登记**已知预期事实，再回读核验。
  // 回读这一独立查询失败（连接中断、字段漂移）不得丢掉已创建的 ID，否则该行会
  // 永久留在库里；删除侧在事务内按 FOR UPDATE 绑定全部事实并断言命中 1 行，
  // 事实不符会在首删前明确拒绝，因此先入账不会放大删除范围。
  const expectedFacts: RegistrationRoundOrganizationFacts = {
    id,
    isManagedCompany: input.isManagedCompany,
    isServiceProvider: input.isServiceProvider ?? false,
    kind: input.kind,
    name: input.name,
    organizationCode: input.organizationCode,
    status,
  };
  registerRegistrationRoundOrganization(ledger, expectedFacts);

  const row = requireSingleRow(
    deps.query(
      [
        'SELECT id, organization_code, name, kind, status, is_managed_company, is_service_provider',
        'FROM organization',
        `WHERE id = ${id} AND ${hexEquals('organization_code', input.organizationCode)} AND ${hexEquals('name', input.name)}`,
        `AND kind = '${input.kind}' AND status = '${status}'`,
        `AND is_managed_company = ${isManaged} AND is_service_provider = ${isServiceProvider}`,
      ].join(' '),
    ),
    `公司插入后核验（ID ${id}）`,
  );

  const actualFacts: RegistrationRoundOrganizationFacts = {
    id: Number(row[0]),
    isManagedCompany: Number(row[5]) === 1,
    isServiceProvider: Number(row[6]) === 1,
    kind: row[3],
    name: row[2],
    organizationCode: row[1],
    status: row[4],
  };
  const drifted = (
    Object.keys(expectedFacts) as Array<keyof RegistrationRoundOrganizationFacts>
  ).filter((key) => actualFacts[key] !== expectedFacts[key]);
  if (drifted.length > 0) {
    throw new Error(
      `公司回读核验不符（ID ${id}）：字段 ${drifted.join(', ')} 与插入事实不一致，拒绝继续；已登记的真实 ID 保留在台账，删除侧会再次拒绝`,
    );
  }

  return id;
}

/**
 * 由真实注册响应的 accountId + 已知登录邮箱定位并核验账号、资料、成员关系与手填公司。
 *
 * 手填公司不按名称定位：先取资料 `customer_organization_id` 与成员关系 `organization_id`，
 * 两者必须相同，再按该真实 ID 核验名称/未受管/状态。这样同库中同名的他人未受管公司
 * 永远不会被误认为本轮资源。
 */
export function locateRegistrationRoundAccount(
  ledger: RegistrationRoundLedger,
  input: {
    readonly accountId: unknown;
    readonly loginEmail: string;
    readonly expectedSelfFilledName: string;
  },
  deps: Pick<RegistrationRoundCleanupDeps, 'query'> = defaultDeps,
): { readonly accountId: number; readonly selfFilledOrganizationId: number } {
  const accountId = assertPositiveInteger(input.accountId, '注册响应账号 ID');
  assertTextField(input.loginEmail, '已知登录邮箱');
  assertTextField(input.expectedSelfFilledName, '已知手填公司名称');

  const accountRow = requireSingleRow(
    deps.query(
      [
        'SELECT id, login_name, login_email FROM base_user_account',
        `WHERE id = ${accountId} AND ${hexEquals('login_email', input.loginEmail)}`,
      ].join(' '),
    ),
    `注册账号核验（ID ${accountId}）`,
  );

  // 账号核验通过即登记：即使后续资料/成员核验失败，这个真实 ID 也不会丢失，
  // afterAll 仍会尝试按台账清理；删除被外键拒绝时整批回滚并上抛，绝不静默泄漏。
  registerRegistrationRoundAccount(ledger, {
    id: Number(accountRow[0]),
    loginEmail: accountRow[2],
    loginName: parseNullableText(accountRow[1], '登录名'),
  });

  const userInfoRow = requireSingleRow(
    deps.query(
      [
        'SELECT id, email, customer_organization_id FROM base_user_info',
        `WHERE account_id = ${accountId} AND ${hexEquals('email', input.loginEmail)}`,
      ].join(' '),
    ),
    `注册资料核验（account ${accountId}）`,
  );
  const userInfoId = assertPositiveInteger(Number(userInfoRow[0]), '资料 ID');
  const customerOrganizationId = parseNullableInteger(
    userInfoRow[2],
    '资料 customer_organization_id',
  );
  if (customerOrganizationId === null) {
    throw new Error(
      `注册资料核验失败：account ${accountId} 的 customer_organization_id 为空，无法定位本轮手填公司，拒绝登记`,
    );
  }

  const membershipRow = requireSingleRow(
    deps.query(
      [
        'SELECT id, organization_id FROM organization_membership',
        `WHERE account_id = ${accountId}`,
      ].join(' '),
    ),
    `注册成员关系核验（account ${accountId}）`,
  );
  const membershipId = assertPositiveInteger(Number(membershipRow[0]), '成员关系 ID');
  const membershipOrganizationId = assertPositiveInteger(
    Number(membershipRow[1]),
    '成员关系公司 ID',
  );

  if (membershipOrganizationId !== customerOrganizationId) {
    throw new Error(
      `注册归属核验失败：account ${accountId} 的资料归属 ${customerOrganizationId} 与成员关系公司 ${membershipOrganizationId} 不一致，拒绝登记`,
    );
  }

  const organizationRow = requireSingleRow(
    deps.query(
      [
        'SELECT id, organization_code, name, kind, status, is_managed_company, is_service_provider',
        'FROM organization',
        `WHERE id = ${customerOrganizationId} AND ${hexEquals('name', input.expectedSelfFilledName)}`,
        "AND status = 'ACTIVE' AND is_managed_company = 0",
      ].join(' '),
    ),
    `手填公司核验（ID ${customerOrganizationId}）`,
  );

  registerRegistrationRoundUserInfo(ledger, {
    id: userInfoId,
    accountId,
    email: userInfoRow[1],
    customerOrganizationId,
  });
  registerRegistrationRoundMembership(ledger, {
    id: membershipId,
    accountId,
    organizationId: membershipOrganizationId,
  });
  registerRegistrationRoundOrganization(ledger, {
    id: Number(organizationRow[0]),
    organizationCode: organizationRow[1],
    name: organizationRow[2],
    kind: organizationRow[3],
    status: organizationRow[4],
    isManagedCompany: Number(organizationRow[5]) === 1,
    isServiceProvider: Number(organizationRow[6]) === 1,
  });

  return { accountId, selfFilledOrganizationId: customerOrganizationId };
}

/** 读取单条公司事实（哨兵不变核验用）；不存在即失败关闭。 */
export function readRegistrationRoundOrganization(
  organizationId: number,
  deps: Pick<RegistrationRoundCleanupDeps, 'query'> = defaultDeps,
): RegistrationRoundOrganizationFacts {
  const id = assertPositiveInteger(organizationId, '公司 ID');
  const row = requireSingleRow(
    deps.query(
      [
        'SELECT id, organization_code, name, kind, status, is_managed_company, is_service_provider',
        'FROM organization',
        `WHERE id = ${id}`,
      ].join(' '),
    ),
    `公司事实回读（ID ${id}）`,
  );

  return {
    id: Number(row[0]),
    organizationCode: row[1],
    name: row[2],
    kind: row[3],
    status: row[4],
    isManagedCompany: Number(row[5]) === 1,
    isServiceProvider: Number(row[6]) === 1,
  };
}

/**
 * 从真实 schema 发现集合外引用：
 * - 实际 FK：`information_schema.KEY_COLUMN_USAGE`；
 * - 已知逻辑引用：列名以 `_account_id` / `_organization_id` 结尾（无 FK 声明也会被计入）。
 * 集合内三张表自身的引用不计；任何指向 `base_user_info` / `organization_membership`
 * 的外部 FK 都视为不支持并失败关闭。
 */
export function discoverRegistrationRoundReferences(
  query: (sql: string) => string = mysqlQuery,
): RegistrationRoundReferences {
  const rows = parseTabRows(
    query(
      [
        'SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME',
        'FROM information_schema.KEY_COLUMN_USAGE kcu',
        "JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = kcu.TABLE_SCHEMA AND t.TABLE_NAME = kcu.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'",
        'WHERE kcu.TABLE_SCHEMA = DATABASE()',
        "AND kcu.REFERENCED_TABLE_NAME IN ('base_user_account', 'organization', 'base_user_info', 'organization_membership')",
        'ORDER BY kcu.TABLE_NAME, kcu.COLUMN_NAME',
      ].join(' '),
    ),
  );

  const account = new Map<string, RegistrationRoundCleanupReference>();
  const organization = new Map<string, RegistrationRoundCleanupReference>();
  const inSet = new Map<string, RegistrationRoundInSetReference>();

  for (const row of rows) {
    const [table, column, referencedTable] = row;
    if (!SQL_IDENTIFIER_PATTERN.test(table ?? '') || !SQL_IDENTIFIER_PATTERN.test(column ?? '')) {
      throw new Error(`引用闭包发现非法标识符，拒绝继续：${JSON.stringify(row)}`);
    }
    if (IN_SET_CHILD_TABLES.includes(table)) {
      // 台账内子表：不再整体跳过（P2-02）。改为记录具体边，由清理脚本在首删前
      // 只放行已登记子行，任何账外子行都明确拒绝。
      inSet.set(`${table}.${column}`, {
        column,
        table,
        target: referencedTable === 'base_user_account' ? 'account' : 'organization',
      });
      continue;
    }
    if (CLEANUP_IN_SET_TABLES.includes(table)) {
      continue;
    }
    if (referencedTable === 'base_user_info' || referencedTable === 'organization_membership') {
      throw new Error(
        `引用闭包发现未受支持的引用目标 ${JSON.stringify(referencedTable)}（${table}.${column}），拒绝继续`,
      );
    }
    const target = referencedTable === 'base_user_account' ? account : organization;
    target.set(`${table}.${column}`, { column, table });
  }

  // 逻辑引用（无 FK 声明）：列名以 _account_id / _organization_id 结尾即计入。
  const logical = parseTabRows(
    query(
      [
        'SELECT c.TABLE_NAME, c.COLUMN_NAME FROM information_schema.COLUMNS c',
        "JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'",
        'WHERE c.TABLE_SCHEMA = DATABASE()',
        "AND (c.COLUMN_NAME = 'account_id' OR c.COLUMN_NAME LIKE '%!_account!_id' ESCAPE '!'",
        "OR c.COLUMN_NAME = 'organization_id' OR c.COLUMN_NAME LIKE '%!_organization!_id' ESCAPE '!')",
        'ORDER BY c.TABLE_NAME, c.COLUMN_NAME',
      ].join(' '),
    ),
  );

  for (const row of logical) {
    const [table, column] = row;
    if (!SQL_IDENTIFIER_PATTERN.test(table ?? '') || !SQL_IDENTIFIER_PATTERN.test(column ?? '')) {
      throw new Error(`逻辑引用发现非法标识符，拒绝继续：${JSON.stringify(row)}`);
    }
    if (IN_SET_CHILD_TABLES.includes(table)) {
      const isAccountColumn = /(^|_)account_id$/.test(column);
      inSet.set(`${table}.${column}`, {
        column,
        table,
        target: isAccountColumn ? 'account' : 'organization',
      });
      continue;
    }
    if (CLEANUP_IN_SET_TABLES.includes(table)) {
      continue;
    }
    const isAccountColumn = /(^|_)account_id$/.test(column);
    const target = isAccountColumn ? account : organization;
    target.set(`${table}.${column}`, { column, table });
  }

  const sortReferences = (
    items: RegistrationRoundCleanupReference[],
  ): RegistrationRoundCleanupReference[] =>
    items.sort((left, right) =>
      `${left.table}.${left.column}`.localeCompare(`${right.table}.${right.column}`),
    );

  return {
    account: sortReferences([...account.values()]),
    inSet: [...inSet.values()].sort((left, right) =>
      `${left.table}.${left.column}`.localeCompare(`${right.table}.${right.column}`),
    ),
    organization: sortReferences([...organization.values()]),
  };
}

const assertLedgerIntegrity = (ledger: RegistrationRoundLedger): void => {
  const accountIds = new Set(
    ledger.accounts.map((item) => assertPositiveInteger(item.id, '账号 ID')),
  );
  const organizationIds = new Set([
    ...ledger.organizations.map((item) => assertPositiveInteger(item.id, '公司 ID')),
    ...ledger.retainedOrganizationIds.map((id) => assertPositiveInteger(id, '保留公司 ID')),
  ]);

  for (const membership of ledger.memberships) {
    assertPositiveInteger(membership.id, '成员关系 ID');
    if (!accountIds.has(membership.accountId)) {
      throw new Error(
        `台账预检失败：成员关系 ${membership.id} 的账号 ${membership.accountId} 未登记，拒绝清理`,
      );
    }
    if (!organizationIds.has(membership.organizationId)) {
      throw new Error(
        `台账预检失败：成员关系 ${membership.id} 的公司 ${membership.organizationId} 未登记，拒绝清理`,
      );
    }
  }

  for (const userInfo of ledger.userInfos) {
    assertPositiveInteger(userInfo.id, '资料 ID');
    if (!accountIds.has(userInfo.accountId)) {
      throw new Error(
        `台账预检失败：资料 ${userInfo.id} 的账号 ${userInfo.accountId} 未登记，拒绝清理`,
      );
    }
    if (
      userInfo.customerOrganizationId !== null &&
      !organizationIds.has(userInfo.customerOrganizationId)
    ) {
      throw new Error(
        `台账预检失败：资料 ${userInfo.id} 的归属公司 ${userInfo.customerOrganizationId} 未登记，拒绝清理`,
      );
    }
  }

  for (const application of ledger.applications) {
    assertPositiveInteger(application.id, '申请 ID');
    if (!accountIds.has(application.accountId)) {
      throw new Error(
        `台账预检失败：申请 ${application.id} 的账号 ${application.accountId} 未登记，拒绝清理`,
      );
    }
  }
};

const referenceSum = (
  id: number,
  references: readonly RegistrationRoundCleanupReference[],
): string =>
  references
    .map(({ table, column }) => `(SELECT COUNT(*) FROM \`${table}\` WHERE \`${column}\` = ${id})`)
    .join(' + ');

/**
 * 生成整批清理脚本（单一 MySQL 会话 / 单事务 / 单 COMMIT）。
 * 空台账返回空串，调用方不得据此启动 mysql。
 */
export function buildRegistrationRoundCleanupScript(
  ledger: RegistrationRoundLedger,
  references: RegistrationRoundReferences,
  expectedDatabase: string,
): string {
  if (isRegistrationRoundLedgerEmpty(ledger)) {
    return '';
  }
  if (!SQL_IDENTIFIER_PATTERN.test(expectedDatabase)) {
    throw new Error(`目标库名未通过标识符校验，拒绝清理：${JSON.stringify(expectedDatabase)}`);
  }
  assertLedgerIntegrity(ledger);

  const statements: string[] = [
    'START TRANSACTION',
    'SET @rc_database = DATABASE()',
    ...renderGuardedAssertion(
      'rc_database',
      `@rc_database = '${expectedDatabase}'`,
      'rc_database_must_equal_strict_dedicated_e2e',
    ),
  ];

  // 第一阶段：按真实 ID 锁定并核对全部绑定，任何不符都在首删前中止。
  for (const application of ledger.applications) {
    const name = `rc_app_${application.id}`;
    statements.push(
      `SELECT id INTO @${name}_row FROM engineer_registration_application WHERE id = ${application.id} AND account_id = ${application.accountId} FOR UPDATE`,
      ...renderGuardedAssertion(
        name,
        `@${name}_row = ${application.id}`,
        `${name}_binding_mismatch`,
      ),
    );
  }

  for (const membership of ledger.memberships) {
    const name = `rc_mem_${membership.id}`;
    statements.push(
      `SELECT id INTO @${name}_row FROM organization_membership WHERE id = ${membership.id} AND account_id = ${membership.accountId} AND organization_id = ${membership.organizationId} FOR UPDATE`,
      ...renderGuardedAssertion(
        name,
        `@${name}_row = ${membership.id}`,
        `${name}_binding_mismatch`,
      ),
    );
  }

  for (const userInfo of ledger.userInfos) {
    const name = `rc_ui_${userInfo.id}`;
    const organizationCondition =
      userInfo.customerOrganizationId === null
        ? 'customer_organization_id IS NULL'
        : `customer_organization_id = ${userInfo.customerOrganizationId}`;
    statements.push(
      `SELECT id INTO @${name}_row FROM base_user_info WHERE id = ${userInfo.id} AND account_id = ${userInfo.accountId} AND ${hexEquals('email', userInfo.email)} AND ${organizationCondition} FOR UPDATE`,
      ...renderGuardedAssertion(name, `@${name}_row = ${userInfo.id}`, `${name}_binding_mismatch`),
    );
  }

  for (const account of ledger.accounts) {
    const name = `rc_acct_${account.id}`;
    const loginNameCondition =
      account.loginName === null
        ? 'login_name IS NULL'
        : hexEquals('login_name', account.loginName);
    statements.push(
      `SELECT id INTO @${name}_row FROM base_user_account WHERE id = ${account.id} AND ${loginNameCondition} AND ${hexEquals('login_email', account.loginEmail)} FOR UPDATE`,
      ...renderGuardedAssertion(name, `@${name}_row = ${account.id}`, `${name}_binding_mismatch`),
    );
  }

  for (const organization of ledger.organizations) {
    const name = `rc_org_${organization.id}`;
    statements.push(
      `SELECT id INTO @${name}_row FROM organization WHERE id = ${organization.id} AND ${hexEquals('organization_code', organization.organizationCode)} AND ${hexEquals('name', organization.name)} AND kind = '${assertEnumToken(organization.kind, '公司类别')}' AND status = '${assertEnumToken(organization.status, '公司状态')}' AND is_managed_company = ${booleanLiteral(organization.isManagedCompany, '受管标记')} AND is_service_provider = ${booleanLiteral(organization.isServiceProvider, '服务商标记')} FOR UPDATE`,
      ...renderGuardedAssertion(
        name,
        `@${name}_row = ${organization.id}`,
        `${name}_binding_mismatch`,
      ),
    );
  }

  // 第二阶段：集合外引用必须为 0（仍在首删之前）。
  const externalTermOf = (
    id: number,
    references: readonly RegistrationRoundCleanupReference[],
  ): string => {
    const sum = referenceSum(id, references);
    return sum === '' ? '0' : `(${sum})`;
  };
  const accountExternal = ledger.accounts
    .map((account) => externalTermOf(account.id, references.account))
    .join(' + ');
  const organizationExternal = ledger.organizations
    .map((organization) => externalTermOf(organization.id, references.organization))
    .join(' + ');
  const externalTerms = [accountExternal, organizationExternal].filter((term) => term.length > 0);
  const externalTotal = externalTerms.length > 0 ? externalTerms.join(' + ') : '0';

  statements.push(
    `SET @rc_external_refs = ${externalTotal}`,
    ...renderGuardedAssertion(
      'rc_external',
      '@rc_external_refs = 0',
      'rc_unregistered_external_references',
    ),
  );

  // 第二阶段之二（P2-02）：台账内子表（base_user_info / organization_membership）
  // 至少有 RESTRICT 外键指向本轮父行，但旧实现把这些表整体排除在预检之外，
  // 账外子行只能由「第四条 DELETE 的 1451」兜底——那不是预检，前序 DELETE 已执行。
  // 现在按「具体边 + 父行 ID + 已登记子行 ID」核对：只放行实际登记的子行，
  // 任何账外子行都在首删前明确拒绝（父行已加锁，外部会话插入子行会被 FK 共享锁挡住）。
  const registeredChildIdsOf = (table: string): number[] => {
    if (table === 'base_user_info') {
      return ledger.userInfos.map((item) => item.id);
    }
    if (table === 'organization_membership') {
      return ledger.memberships.map((item) => item.id);
    }
    if (table === 'engineer_registration_application') {
      return ledger.applications.map((item) => item.id);
    }
    return [];
  };

  const inSetReferences = references.inSet ?? [];
  for (const [index, reference] of inSetReferences.entries()) {
    const parentIds =
      reference.target === 'account'
        ? ledger.accounts.map((account) => account.id)
        : ledger.organizations.map((organization) => organization.id);
    if (parentIds.length === 0) {
      continue;
    }
    const excluded = registeredChildIdsOf(reference.table);
    const exclusion = excluded.length > 0 ? ` AND id NOT IN (${excluded.join(', ')})` : '';
    const terms = parentIds.map(
      (id) =>
        `(SELECT COUNT(*) FROM \`${reference.table}\` WHERE \`${reference.column}\` = ${id}${exclusion})`,
    );
    // MySQL 用户变量名上限 64 字符：`rc_inset_<table>_<column>` 在长表名下会超限
    // （ERROR 3061 直接让整批清理失败）。变量名改用序号短名，拒绝标记仍保留完整边名。
    const name = `rc_inset_${index}`;
    statements.push(
      `SET @${name}_count = ${terms.join(' + ')}`,
      ...renderGuardedAssertion(
        name,
        `@${name}_count = 0`,
        `rc_unregistered_in_set_${reference.table}_${reference.column}`,
      ),
    );
  }

  // 第三阶段：删除。申请 → 成员关系 → 资料 → 账号 → 自有未受管公司 → 受管夹具公司。
  for (const application of ledger.applications) {
    const name = `rc_app_${application.id}`;
    statements.push(
      `DELETE FROM engineer_registration_application WHERE id = ${application.id} AND account_id = ${application.accountId}`,
      'SET @rc_deleted = ROW_COUNT()',
      ...renderGuardedAssertion(
        `${name}_delete`,
        '@rc_deleted = 1',
        `${name}_delete_rows_mismatch`,
      ),
    );
  }

  for (const membership of ledger.memberships) {
    const name = `rc_mem_${membership.id}`;
    statements.push(
      `DELETE FROM organization_membership WHERE id = ${membership.id} AND account_id = ${membership.accountId} AND organization_id = ${membership.organizationId}`,
      'SET @rc_deleted = ROW_COUNT()',
      ...renderGuardedAssertion(
        `${name}_delete`,
        '@rc_deleted = 1',
        `${name}_delete_rows_mismatch`,
      ),
    );
  }

  for (const userInfo of ledger.userInfos) {
    const name = `rc_ui_${userInfo.id}`;
    statements.push(
      `DELETE FROM base_user_info WHERE id = ${userInfo.id} AND account_id = ${userInfo.accountId}`,
      'SET @rc_deleted = ROW_COUNT()',
      ...renderGuardedAssertion(
        `${name}_delete`,
        '@rc_deleted = 1',
        `${name}_delete_rows_mismatch`,
      ),
    );
  }

  for (const account of ledger.accounts) {
    const name = `rc_acct_${account.id}`;
    const loginNameCondition =
      account.loginName === null
        ? 'login_name IS NULL'
        : hexEquals('login_name', account.loginName);
    statements.push(
      `DELETE FROM base_user_account WHERE id = ${account.id} AND ${loginNameCondition}`,
      'SET @rc_deleted = ROW_COUNT()',
      ...renderGuardedAssertion(
        `${name}_delete`,
        '@rc_deleted = 1',
        `${name}_delete_rows_mismatch`,
      ),
    );
  }

  const orderedOrganizations = [
    ...ledger.organizations.filter((organization) => !organization.isManagedCompany),
    ...ledger.organizations.filter((organization) => organization.isManagedCompany),
  ];
  for (const organization of orderedOrganizations) {
    const name = `rc_org_${organization.id}`;
    statements.push(
      `DELETE FROM organization WHERE id = ${organization.id} AND ${hexEquals('organization_code', organization.organizationCode)} AND is_managed_company = ${booleanLiteral(organization.isManagedCompany, '受管标记')}`,
      'SET @rc_deleted = ROW_COUNT()',
      ...renderGuardedAssertion(
        `${name}_delete`,
        '@rc_deleted = 1',
        `${name}_delete_rows_mismatch`,
      ),
    );
  }

  // 第四阶段：全批残留必须为 0，然后才 COMMIT。
  const residueTerms = [
    ...ledger.applications.map(
      ({ id }) => `(SELECT COUNT(*) FROM engineer_registration_application WHERE id = ${id})`,
    ),
    ...ledger.memberships.map(
      ({ id }) => `(SELECT COUNT(*) FROM organization_membership WHERE id = ${id})`,
    ),
    ...ledger.userInfos.map(({ id }) => `(SELECT COUNT(*) FROM base_user_info WHERE id = ${id})`),
    ...ledger.accounts.map(({ id }) => `(SELECT COUNT(*) FROM base_user_account WHERE id = ${id})`),
    ...ledger.organizations.map(({ id }) => `(SELECT COUNT(*) FROM organization WHERE id = ${id})`),
  ];

  statements.push(
    `SET @rc_residue = ${residueTerms.join(' + ')}`,
    ...renderGuardedAssertion('rc_residue', '@rc_residue = 0', 'rc_residue_must_be_zero'),
    'COMMIT',
  );

  return statements.join('; ');
}

/**
 * 确认释放台账：已成功清理的一批真实 ID 不再持有资源。
 * 释放后 afterAll / 重试不会再对同一批 ID 重复删除（重复删除会因 ROW_COUNT=0
 * 触发 `*_delete_rows_mismatch`，把已完成的清理误报成失败）。
 */
export function releaseRegistrationRoundLedger(ledger: RegistrationRoundLedger): void {
  ledger.organizations.length = 0;
  ledger.accounts.length = 0;
  ledger.userInfos.length = 0;
  ledger.memberships.length = 0;
  ledger.applications.length = 0;
  ledger.retainedOrganizationIds.length = 0;
}

/**
 * 执行本轮台账清理：空台账 no-op；否则走统一受保护写入门并执行单事务脚本。
 * 清理失败必须上抛（由 afterAll 让用例失败），不得静默吞掉；成功后台账立即释放。
 */
export function cleanupRegistrationRound(
  ledger: RegistrationRoundLedger,
  deps: RegistrationRoundCleanupDeps = defaultDeps,
): void {
  if (isRegistrationRoundLedgerEmpty(ledger)) {
    return;
  }

  const env = deps.readEnv();
  const script = buildRegistrationRoundCleanupScript(
    ledger,
    deps.discoverReferences(deps.query),
    DEDICATED_E2E_DB_NAME,
  );
  if (script.length === 0) {
    return;
  }
  deps.write(env, script);
  // 脚本是单事务：写入正常返回即代表整批已删除并 COMMIT。
  releaseRegistrationRoundLedger(ledger);
}

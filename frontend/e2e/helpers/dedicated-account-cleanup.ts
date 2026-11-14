// e2e/helpers/dedicated-account-cleanup.ts
// 专用账号物理清理 helper（R4 修正轮）：真实改密用例经 adminCreateUser 创建的
// 一次性 ENGINEER 账号，在 finally 中按本次 accountId + dedicatedLoginName 精确删除
// 该账号及全部关联记录。
//
// R4 改进要点（Review 阻塞项修复）：
// - 清理目标从「仅按 ID」收紧为「ID + 登录名」双因子绑定：事务内先断言
//   base_user_account.id 与 login_name 唯一匹配，不匹配立即回滚并拒绝删除；
// - 登录名必须命中专用账号白名单（e2e-pw-<纯数字>），杜绝外部字符串拼接进 SQL；
// - 新增 API/SQL 同库探针 assertApiSqlSameDatabase：SQL 写入唯一哨兵 → 经真实 API
//   读回 → 两者必须完全一致，且无论成败都精确恢复哨兵；探针失败禁止执行 adminCreateUser。
//
// R4 复核修正轮（探针原值精确恢复）：
// - 原昵称读取改为「nickname IS NULL 标志 + HEX(nickname)」两步：原值以十六进制
//   字节读出，恢复经 UNHEX 还原——单引号、反斜杠、前后空白与内部换行都不再进入
//   SQL 字符串字面量；NULL（batch 模式打印字面量 NULL）与空串（HEX 为空）分别可辨，
//   不再经 IFNULL/trim 丢失精度；恢复前对 hex 与哨兵做格式校验，拼接输入全部受控。
//
// 安全边界（沿用 R3）：
// - 不再自建平行安全门，统一复用 real-backend.assertPhysicalCleanupAllowed()；
// - 使用独立 E2E 数据库（DB_NAME 必须含 e2e/test 段），授权缺失时直接失败（R4：不再 skip）；
// - 单一事务包裹 DELETE + 残留核对，失败回滚；密码经 MYSQL_PWD 注入，不出现在进程参数。
//
// 终审 I3（按明确台账与引用闭包执行）：
// - 入参由「账号 ID + 格式匹配登录名」收紧为本次创建的完整资源记录
//   （ID、登录名、角色、组织、预期资料、成员关系与资料主键）；
// - 创建响应一到即登记 ID，再回读核验；核验失败保留登记项并失败关闭；
// - 删除入口独立要求显式许可 + 严格专用库名，并在执行 DELETE 的同一 MySQL 会话内
//   复核 DATABASE()、FOR UPDATE 锁定并核对绑定、检查集合外引用；
// - 只删本轮创建的成员关系 / 资料 / 账号；AI、工单、资料等账外引用在首删前明确拒绝。

import { execFileSync } from 'node:child_process';

import { DEDICATED_E2E_DB_NAME } from '../../e2e-real/dedicated-e2e-environment';

import {
  assertPhysicalCleanupAllowed,
  mysqlQuery,
  readBackendEnv,
  realGraphqlCall,
} from './real-backend';

/** 专用账号登录名白名单：adminCreateUser 生成的 e2e-pw-<时间戳纯数字> 形态 */
export const DEDICATED_LOGIN_NAME_PATTERN = /^e2e-pw-\d{12,16}$/;

/** 同库探针使用的种子账号（mock seed 官方账号，禁止在探针中改动除 nickname 外的字段） */
export const PROBE_LOGIN_NAME = 'mock_customer_alpha';

/** myAccountSettings 的最小读形状（只取探针断言所需字段） */
const PROBE_MY_ACCOUNT_SETTINGS_QUERY = `
  query ProbeApiSqlSameDatabase {
    myAccountSettings {
      loginName
      nickname
    }
  }
`;

/**
 * 在任何专用账号写入之前完成清理授权、目标数据库和连接预检。
 * 物理删除授权统一复用 shared helper：必须显式 opt-in，且 DB_NAME 必须含 e2e/test 段。
 */
export function preflightDedicatedAccountCleanup(): void {
  const env = readBackendEnv();
  assertPhysicalCleanupAllowed(env);
  const actualDatabase = mysqlQuery('SELECT DATABASE()');
  if (actualDatabase !== env.DB_NAME) {
    throw new Error(
      `数据库连接目标不一致：配置为 ${JSON.stringify(env.DB_NAME)}，实际为 ${JSON.stringify(actualDatabase)}`,
    );
  }
}

function probeAccountSqlWhere(): string {
  return `WHERE account_id = (SELECT id FROM base_user_account WHERE login_name = '${PROBE_LOGIN_NAME}')`;
}

/** 同库探针哨兵格式：生成后立即自检，杜绝非受控字符进入 SQL 拼接 */
const SENTINEL_PATTERN = /^e2e-probe-\d{13}-[a-z0-9]{1,6}$/;

/** 恢复用 HEX(nickname) 合法形态：大写十六进制；空串原值单列为 '' 分支 */
const HEX_NICKNAME_PATTERN = /^[0-9A-F]+$/;

/**
 * API/SQL 同库绑定探针（R4 新增）：证明「SQL helper 连接的库」与「API 后端读取的库」是同一个。
 *
 * 仅 SELECT DATABASE() 一致或 /health 可达都不再视为同库证明。流程：
 * 1. SQL 侧确认实际连接库等于配置库；
 * 2. 对探针账号 nickname 写入唯一哨兵（UPDATE base_user_info）；
 * 3. 经真实 API（myAccountSettings）读回该值；
 * 4. API 值必须与 SQL 哨兵完全一致；
 * 5. 无论成败都精确恢复原值（NULL/UNHEX 字节级还原，见文件头「复核修正轮」）；
 * 6. 失败直接抛错——调用方在探针通过前不得执行 adminCreateUser。
 */
export async function assertApiSqlSameDatabase(env = readBackendEnv()): Promise<void> {
  // 探针会写入哨兵值，因此与物理清理共用同一授权门（显式 opt-in + 测试库名校验）
  assertPhysicalCleanupAllowed(env);
  const actualDatabase = mysqlQuery('SELECT DATABASE()');
  if (actualDatabase !== env.DB_NAME) {
    throw new Error(
      `数据库连接目标不一致：配置为 ${JSON.stringify(env.DB_NAME)}，实际为 ${JSON.stringify(actualDatabase)}`,
    );
  }

  // 原值读取两步：先取 NULL 标志（batch 模式输出 0/1，多行即数据异常），再取
  // HEX(nickname)（NULL 打印为字面量 NULL；空串 HEX 为空输出）。原值字节不进入
  // 任何 SQL 字符串字面量。
  const isNullRows = mysqlQuery(
    `SELECT nickname IS NULL FROM base_user_info ${probeAccountSqlWhere()}`,
  );
  const isNullLines = isNullRows.split('\n').map((line) => line.trim());
  if (isNullLines.length !== 1 || (isNullLines[0] !== '0' && isNullLines[0] !== '1')) {
    throw new Error(
      `同库探针账号数据异常：${PROBE_LOGIN_NAME} 应恰好对应一行 base_user_info 且 nickname 状态可辨，实际返回 ${JSON.stringify(isNullRows)}`,
    );
  }
  const nicknameIsNull = isNullLines[0] === '1';

  const hexRows = mysqlQuery(`SELECT HEX(nickname) FROM base_user_info ${probeAccountSqlWhere()}`);
  const hexLines = hexRows.split('\n').map((line) => line.trim());
  if (hexLines.length !== 1) {
    throw new Error(
      `同库探针账号数据异常：HEX(nickname) 应恰好返回一行，实际返回 ${JSON.stringify(hexRows)}`,
    );
  }
  const nicknameHex = hexLines[0];
  if (nicknameIsNull && nicknameHex !== 'NULL') {
    throw new Error(
      `同库探针账号数据异常：nickname IS NULL=1 但 HEX(nickname) 返回 ${JSON.stringify(nicknameHex)}`,
    );
  }
  if (
    !nicknameIsNull &&
    (nicknameHex === 'NULL' || (nicknameHex !== '' && !HEX_NICKNAME_PATTERN.test(nicknameHex)))
  ) {
    throw new Error(
      `同库探针账号数据异常：HEX(nickname) 返回非十六进制值 ${JSON.stringify(nicknameHex)}`,
    );
  }

  const sentinel = `e2e-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!SENTINEL_PATTERN.test(sentinel)) {
    throw new Error(`同库探针哨兵生成异常，拒绝写库：${JSON.stringify(sentinel)}`);
  }

  mysqlQuery(`UPDATE base_user_info SET nickname = '${sentinel}' ${probeAccountSqlWhere()}`);

  try {
    const { status, body } = await realGraphqlCall(
      env,
      PROBE_MY_ACCOUNT_SETTINGS_QUERY,
      {},
      PROBE_LOGIN_NAME,
    );
    const data = body as { data?: { myAccountSettings?: { nickname?: string } }; errors?: unknown };

    if (status !== 200 || !data.data?.myAccountSettings || data.errors) {
      throw new Error(
        `同库探针 API 读取失败（status=${status}），无法证明 API 后端与 SQL helper 指向同一库：${JSON.stringify(body).slice(0, 500)}`,
      );
    }

    const apiNickname = data.data.myAccountSettings.nickname;
    if (apiNickname !== sentinel) {
      throw new Error(
        `API/SQL 未指向同一数据库：SQL 哨兵为 ${JSON.stringify(sentinel)}，API 读回 ${JSON.stringify(apiNickname)}。禁止在业务写入前继续执行。`,
      );
    }
  } finally {
    // 无论成败都精确恢复原值：NULL → SET nickname = NULL；空串原值 → ''；
    // 其余 → UNHEX 字节级还原（hex 已通过 ^[0-9A-F]+$ 校验，拼接输入受控）
    const restoreExpression = nicknameIsNull
      ? 'NULL'
      : nicknameHex === ''
        ? "''"
        : `UNHEX('${nicknameHex}')`;
    mysqlQuery(
      `UPDATE base_user_info SET nickname = ${restoreExpression} ${probeAccountSqlWhere()}`,
    );
  }
}

// ---- 本轮创建资源台账与引用闭包清理（终审 I3） ----

/** 专用账号可写角色：与 adminCreateUser 允许绑定的成员角色同口径 */
export type DedicatedAccountRole = 'ENGINEER' | 'CUSTOMER';

/**
 * 创建专用账号时由调用方给定的预期事实（全部来自创建输入与既有业务语义，
 * 不从数据库回读现值充当授权）。
 */
export interface DedicatedAccountExpectation {
  readonly loginName: string;
  readonly role: DedicatedAccountRole;
  readonly organizationId: number;
  readonly nickname: string;
  readonly userInfoEmail: string | null;
  readonly userState: string;
  readonly accessGroup: readonly string[];
}

/** 创建后回读定位到的从属主键：资料与成员关系各一行 */
export interface DedicatedAccountCreationFacts {
  readonly membershipId: number;
  readonly userInfoId: number;
}

/**
 * 本轮登记的专用账号。
 *
 * - `id` 来自 adminCreateUser 的成功响应，一收到响应即登记，早于任何后续断言；
 * - `facts` 为创建后回读并逐字段核验通过的从属主键；为空表示核验失败，
 *   清理入口会拒绝删除并保留诊断——绝不退化为按登录名扫描猜测归属。
 */
export interface RegisteredDedicatedAccount extends DedicatedAccountExpectation {
  readonly id: number;
  readonly facts: DedicatedAccountCreationFacts | null;
}

/** 引用闭包需要核对的外部列（集合外引用必须在首删前发现） */
export interface DedicatedCleanupReferenceColumn {
  readonly table: string;
  readonly column: string;
}

const DEDICATED_ACCOUNT_ROLES: readonly DedicatedAccountRole[] = ['ENGINEER', 'CUSTOMER'];
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const ENUM_TOKEN_PATTERN = /^[A-Z_]{1,32}$/;
const SAFE_LOGIN_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/i;
const NICKNAME_MAX_LENGTH = 50;
const USER_INFO_EMAIL_MAX_LENGTH = 50;

/** 清理集合内的三张表：其余任何对本轮账号的引用都属于账外引用 */
const CLEANUP_IN_SET_TABLES: readonly string[] = [
  'base_user_account',
  'base_user_info',
  'organization_membership',
];

/**
 * 已知的逻辑引用（不依赖数据库 FK 声明）：这些正是旧「推导式删除」曾一并清掉的业务表，
 * 现在改为首删前显式拒绝，而不是替调用方删除。
 */
const LOGICAL_ACCOUNT_REFERENCES: readonly DedicatedCleanupReferenceColumn[] = [
  { column: 'customer_account_id', table: 'engineer_response' },
  { column: 'engineer_account_id', table: 'engineer_response' },
  { column: 'engineer_account_id', table: 'ai_conversation' },
  { column: 'engineer_account_id', table: 'ai_report' },
  { column: 'customer_account_id', table: 'repair_request' },
  { column: 'accepted_by_engineer_account_id', table: 'repair_request' },
  { column: 'created_by_account_id', table: 'reference_document' },
  { column: 'updated_by_account_id', table: 'reference_document' },
];

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} 未通过正整数校验，拒绝执行：${JSON.stringify(value)}`);
  }

  return value;
}

function utf8Hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex').toUpperCase();
}

/**
 * 校验本轮预期事实：登录名、角色、组织、昵称列宽、资料邮箱列宽、账号状态与访问分组。
 * 任何一项不合法都在访问数据库之前失败。
 */
function assertDedicatedAccountExpectation(expectation: DedicatedAccountExpectation): void {
  if (!DEDICATED_LOGIN_NAME_PATTERN.test(expectation.loginName)) {
    throw new Error(
      `专用账号登录名未通过白名单校验，拒绝登记：${JSON.stringify(expectation.loginName)}`,
    );
  }
  if (!DEDICATED_ACCOUNT_ROLES.includes(expectation.role)) {
    throw new Error(
      `专用账号角色不在可写角色集合内，拒绝登记：${JSON.stringify(expectation.role)}`,
    );
  }
  assertPositiveInteger(expectation.organizationId, '专用账号预期组织 ID');
  if (
    typeof expectation.nickname !== 'string' ||
    expectation.nickname.length === 0 ||
    expectation.nickname.length > NICKNAME_MAX_LENGTH
  ) {
    throw new Error(
      `专用账号预期昵称长度非法（1-${NICKNAME_MAX_LENGTH}），拒绝登记：${JSON.stringify(expectation.nickname)}`,
    );
  }
  if (
    expectation.userInfoEmail !== null &&
    (typeof expectation.userInfoEmail !== 'string' ||
      expectation.userInfoEmail.length > USER_INFO_EMAIL_MAX_LENGTH)
  ) {
    throw new Error(
      `专用账号预期资料邮箱长度非法（<=${USER_INFO_EMAIL_MAX_LENGTH} 或 null），拒绝登记：${JSON.stringify(expectation.userInfoEmail)}`,
    );
  }
  if (!ENUM_TOKEN_PATTERN.test(expectation.userState)) {
    throw new Error(
      `专用账号预期账号状态不是受控枚举，拒绝登记：${JSON.stringify(expectation.userState)}`,
    );
  }
  if (
    expectation.accessGroup.length !== 1 ||
    !expectation.accessGroup.every((group) => ENUM_TOKEN_PATTERN.test(group))
  ) {
    throw new Error(
      `专用账号预期访问分组必须是单元素受控枚举数组，拒绝登记：${JSON.stringify(expectation.accessGroup)}`,
    );
  }
}

/**
 * 读取管理员当前有效组织 ID（创建专用账号时 adminCreateUser 会绑定该组织）。
 * 只接受安全登录名参数；必须恰好命中一行 ACTIVE 成员关系。
 */
export function readActingOrganizationId(loginName: string): number {
  if (!SAFE_LOGIN_NAME_PATTERN.test(loginName)) {
    throw new Error(`管理员登录名未通过格式校验，拒绝查询：${JSON.stringify(loginName)}`);
  }

  const rows = mysqlQuery(
    [
      'SELECT organization_id FROM organization_membership',
      "WHERE status = 'ACTIVE'",
      `AND account_id = (SELECT id FROM base_user_account WHERE login_name = '${loginName}')`,
    ].join(' '),
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length !== 1 || !/^\d+$/.test(rows[0])) {
    throw new Error(
      `管理员 ${JSON.stringify(loginName)} 的有效组织不唯一，无法据此核验专用账号归属：${JSON.stringify(rows)}`,
    );
  }

  return Number(rows[0]);
}

/**
 * 创建后回读并核验本次创建的账号、资料与成员关系（终审 I3 第 1 项）。
 *
 * 预期值全部来自创建输入；回读只用于**定位从属主键**与**确认实际写入等于预期**。
 * 实际关联多于预期（例如额外成员关系）或关键字段不符时抛错，绝不接受现值作为授权。
 */
export function readDedicatedAccountCreationFacts(
  account: RegisteredDedicatedAccount,
): DedicatedAccountCreationFacts {
  const id = assertPositiveInteger(account.id, '专用账号 ID');
  const idText = String(id);

  const rows = mysqlQuery(
    [
      `SELECT 'ACCOUNT', CAST(id AS CHAR), login_name, identity_hint, '', '', '' FROM base_user_account WHERE id = ${idText}`,
      `SELECT 'USER_INFO', CAST(id AS CHAR), HEX(nickname), IFNULL(HEX(email), 'NULL'), user_state, CAST(JSON_LENGTH(access_group) AS CHAR), IFNULL(JSON_UNQUOTE(JSON_EXTRACT(access_group, '$[0]')), 'NULL') FROM base_user_info WHERE account_id = ${idText}`,
      `SELECT 'MEMBERSHIP', CAST(id AS CHAR), CAST(organization_id AS CHAR), member_role, status, '', '' FROM organization_membership WHERE account_id = ${idText}`,
    ].join('; '),
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'));

  const pick = (kind: string): string[][] => rows.filter((row) => row[0] === kind);

  const accounts = pick('ACCOUNT');
  if (accounts.length !== 1) {
    throw new Error(
      `专用账号创建事实核验失败：账号 ${idText} 期望恰好 1 行 base_user_account，实际 ${accounts.length} 行`,
    );
  }
  const [, accountIdText, actualLoginName, identityHint] = accounts[0];
  const accountMismatches: string[] = [];

  if (Number(accountIdText) !== id) {
    accountMismatches.push('id');
  }
  if (actualLoginName !== account.loginName) {
    accountMismatches.push('login_name');
  }
  if (identityHint !== account.role) {
    accountMismatches.push('identity_hint');
  }
  if (accountMismatches.length > 0) {
    throw new Error(
      `专用账号创建事实核验失败：账号 ${idText} 字段不符（${accountMismatches.join(', ')}）`,
    );
  }

  const userInfos = pick('USER_INFO');
  if (userInfos.length !== 1) {
    throw new Error(
      `专用账号创建事实核验失败：账号 ${idText} 期望恰好 1 行 base_user_info，实际 ${userInfos.length} 行`,
    );
  }
  const [, userInfoIdText, nicknameHex, emailHex, userState, accessGroupLength, firstGroup] =
    userInfos[0];
  const userInfoMismatches: string[] = [];

  if (nicknameHex !== utf8Hex(account.nickname)) {
    userInfoMismatches.push('nickname');
  }
  if (
    account.userInfoEmail === null
      ? emailHex !== 'NULL'
      : emailHex !== utf8Hex(account.userInfoEmail)
  ) {
    userInfoMismatches.push('email');
  }
  if (userState !== account.userState) {
    userInfoMismatches.push('user_state');
  }
  if (Number(accessGroupLength) !== 1 || firstGroup !== account.accessGroup[0]) {
    userInfoMismatches.push('access_group');
  }
  if (userInfoMismatches.length > 0) {
    throw new Error(
      `专用账号创建事实核验失败：账号 ${idText} 的资料字段不符（${userInfoMismatches.join(', ')}）`,
    );
  }

  const memberships = pick('MEMBERSHIP');
  if (memberships.length !== 1) {
    throw new Error(
      `专用账号创建事实核验失败：账号 ${idText} 的组织成员关系期望恰好 1 行，实际 ${memberships.length} 行（多于预期即拒绝，不按登录名猜测归属）`,
    );
  }
  const [, membershipIdText, organizationIdText, memberRole, membershipStatus] = memberships[0];
  const membershipMismatches: string[] = [];

  if (Number(organizationIdText) !== account.organizationId) {
    membershipMismatches.push('organization_id');
  }
  if (memberRole !== account.role) {
    membershipMismatches.push('member_role');
  }
  if (membershipStatus !== 'ACTIVE') {
    membershipMismatches.push('status');
  }
  if (membershipMismatches.length > 0) {
    throw new Error(
      `专用账号创建事实核验失败：账号 ${idText} 的成员关系字段不符（${membershipMismatches.join(', ')}）`,
    );
  }

  return {
    membershipId: assertPositiveInteger(Number(membershipIdText), '成员关系 ID'),
    userInfoId: assertPositiveInteger(Number(userInfoIdText), '资料 ID'),
  };
}

/**
 * 从数据库真实 schema 发现所有引用本轮清理三张表的外部列（排除集合内表自身的引用）。
 * 只接受单列 FK；出现无法映射的引用列即失败关闭。
 */
export function readDedicatedCleanupReferenceColumns(): DedicatedCleanupReferenceColumn[] {
  const output = mysqlQuery(
    [
      'SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME',
      'FROM information_schema.KEY_COLUMN_USAGE kcu',
      'WHERE kcu.TABLE_SCHEMA = DATABASE()',
      "AND kcu.REFERENCED_TABLE_NAME IN ('base_user_account', 'base_user_info', 'organization_membership')",
      'ORDER BY kcu.TABLE_NAME, kcu.COLUMN_NAME',
    ].join(' '),
  );

  const columns: DedicatedCleanupReferenceColumn[] = [];

  for (const line of output
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [table, column, referencedTable, referencedColumn] = line.split('\t');

    if (!SQL_IDENTIFIER_PATTERN.test(table) || !SQL_IDENTIFIER_PATTERN.test(column)) {
      throw new Error(`引用闭包发现非法标识符，拒绝继续：${JSON.stringify(line)}`);
    }
    if (CLEANUP_IN_SET_TABLES.includes(table)) {
      continue;
    }
    if (referencedTable !== 'base_user_account' || referencedColumn !== 'id') {
      throw new Error(
        `引用闭包发现未受支持的引用目标 ${JSON.stringify(referencedTable)}.${JSON.stringify(referencedColumn)}（${table}.${column}），拒绝继续`,
      );
    }

    columns.push({ column, table });
  }

  return columns;
}

/** 一条 SQL 断言：条件不成立时执行一条必然失败的 SELECT，使 mysql 客户端在该语句处中止 */
function renderGuardedAssertion(name: string, condition: string, marker: string): string[] {
  return [
    `SET @${name}_ok = IF(${condition}, 1, 0)`,
    `SET @${name}_sql = IF(@${name}_ok = 1, 'SELECT 1', 'SELECT ${marker}')`,
    `PREPARE ${name}_stmt FROM @${name}_sql`,
    `EXECUTE ${name}_stmt`,
    `DEALLOCATE PREPARE ${name}_stmt`,
  ];
}

/** 本次清理目标的单行描述：接手人据此一眼确认预期目标 */
export function describeDedicatedAccountCleanupTarget(
  account: RegisteredDedicatedAccount,
  database: string,
): string {
  const facts = account.facts;

  return [
    `账号 ${account.id}（${account.loginName}）`,
    `角色 ${account.role}`,
    `组织 ${account.organizationId}`,
    `成员 ${facts === null ? '未核验' : facts.membershipId}`,
    `资料 ${facts === null ? '未核验' : facts.userInfoId}`,
    `目标库 ${database}`,
  ].join(' / ');
}

/**
 * 生成清理脚本（单一 MySQL 会话、单一事务）：
 *
 * START TRANSACTION
 * → 同会话 DATABASE() 必须等于严格专用库
 * → FOR UPDATE 锁定并核对账号（login_name + identity_hint）/ 资料 / 成员关系绑定
 * → 集合外引用（实际 schema FK + 已知逻辑引用）必须为 0
 * → 仅按已核验主键删除成员关系、资料、账号（逐条 ROW_COUNT=1）
 * → 本轮残留必须为 0
 * → COMMIT
 *
 * 任一断言不成立时，`EXECUTE` 处触发 SQL 错误；mysql 客户端在 batch 模式下遇到错误即退出，
 * 事务随连接关闭回滚，后续 DELETE 与 COMMIT 不会执行。
 */
export function buildDedicatedAccountCleanupScript(
  account: RegisteredDedicatedAccount,
  references: readonly DedicatedCleanupReferenceColumn[],
  expectedDatabase: string,
): string {
  assertDedicatedAccountExpectation(account);

  const facts = account.facts;

  if (facts === null) {
    throw new Error(
      `专用账号 ${account.id}（${account.loginName}）缺少创建后核验事实，拒绝清理：${describeDedicatedAccountCleanupTarget(account, expectedDatabase)}`,
    );
  }

  if (!SQL_IDENTIFIER_PATTERN.test(expectedDatabase)) {
    throw new Error(`目标库名未通过标识符校验，拒绝清理：${JSON.stringify(expectedDatabase)}`);
  }

  const id = String(assertPositiveInteger(account.id, '专用账号 ID'));
  const userInfoId = String(assertPositiveInteger(facts.userInfoId, '资料 ID'));
  const membershipId = String(assertPositiveInteger(facts.membershipId, '成员关系 ID'));
  const organizationId = String(account.organizationId);
  const loginName = account.loginName;
  const role = account.role;
  const emailCondition =
    account.userInfoEmail === null
      ? 'email IS NULL'
      : `HEX(email) = '${utf8Hex(account.userInfoEmail)}'`;
  const accessGroupJson = `["${account.accessGroup.join('","')}"]`;

  // 集合外引用：实际 schema FK + 已知逻辑引用（去重），任何一条非零都拒绝删除
  const referenceChecks = new Map<string, string>();

  for (const reference of references) {
    referenceChecks.set(
      `${reference.table}.${reference.column}`,
      `(SELECT COUNT(*) FROM \`${reference.table}\` WHERE \`${reference.column}\` = ${id})`,
    );
  }
  for (const reference of LOGICAL_ACCOUNT_REFERENCES) {
    referenceChecks.set(
      `${reference.table}.${reference.column}`,
      `(SELECT COUNT(*) FROM \`${reference.table}\` WHERE \`${reference.column}\` = ${id})`,
    );
  }
  referenceChecks.set(
    'ai_message.conversation_id',
    `(SELECT COUNT(*) FROM ai_message WHERE conversation_id IN (SELECT id FROM ai_conversation WHERE engineer_account_id = ${id}))`,
  );

  const externalReferenceSum = [...referenceChecks.values()].join(' + ');

  const statements: string[] = [
    'START TRANSACTION',
    'SET @dedicated_cleanup_database = DATABASE()',
    ...renderGuardedAssertion(
      'dedicated_cleanup_database',
      `@dedicated_cleanup_database = '${expectedDatabase}'`,
      'dedicated_cleanup_database_must_equal_strict_dedicated_e2e',
    ),
    `SELECT id INTO @dedicated_cleanup_account_row FROM base_user_account WHERE id = ${id} AND login_name = '${loginName}' AND identity_hint = '${role}' FOR UPDATE`,
    ...renderGuardedAssertion(
      'dedicated_cleanup_account',
      `@dedicated_cleanup_account_row = ${id}`,
      'dedicated_cleanup_account_binding_login_name_and_identity_hint_must_match_exactly_one',
    ),
    `SET @dedicated_cleanup_user_info_count = (SELECT COUNT(*) FROM base_user_info WHERE account_id = ${id})`,
    ...renderGuardedAssertion(
      'dedicated_cleanup_user_info_count',
      '@dedicated_cleanup_user_info_count = 1',
      'dedicated_cleanup_user_info_must_be_exactly_one',
    ),
    `SELECT id INTO @dedicated_cleanup_user_info_row FROM base_user_info WHERE id = ${userInfoId} AND account_id = ${id} AND HEX(nickname) = '${utf8Hex(account.nickname)}' AND ${emailCondition} AND user_state = '${account.userState}' AND JSON_EXTRACT(access_group, '$') = CAST('${accessGroupJson}' AS JSON) FOR UPDATE`,
    ...renderGuardedAssertion(
      'dedicated_cleanup_user_info',
      `@dedicated_cleanup_user_info_row = ${userInfoId}`,
      'dedicated_cleanup_user_info_binding_must_match_exactly_one',
    ),
    `SET @dedicated_cleanup_membership_count = (SELECT COUNT(*) FROM organization_membership WHERE account_id = ${id})`,
    ...renderGuardedAssertion(
      'dedicated_cleanup_membership_count',
      '@dedicated_cleanup_membership_count = 1',
      'dedicated_cleanup_membership_must_be_exactly_one',
    ),
    `SELECT id INTO @dedicated_cleanup_membership_row FROM organization_membership WHERE id = ${membershipId} AND account_id = ${id} AND organization_id = ${organizationId} AND member_role = '${role}' AND status = 'ACTIVE' FOR UPDATE`,
    ...renderGuardedAssertion(
      'dedicated_cleanup_membership',
      `@dedicated_cleanup_membership_row = ${membershipId}`,
      'dedicated_cleanup_membership_binding_must_match_exactly_one',
    ),
    `SET @dedicated_cleanup_external_refs = ${externalReferenceSum}`,
    ...renderGuardedAssertion(
      'dedicated_cleanup_external',
      '@dedicated_cleanup_external_refs = 0',
      'dedicated_cleanup_unregistered_external_references',
    ),
    `DELETE FROM organization_membership WHERE id = ${membershipId} AND account_id = ${id} AND organization_id = ${organizationId} AND member_role = '${role}'`,
    'SET @dedicated_cleanup_deleted_membership = ROW_COUNT()',
    ...renderGuardedAssertion(
      'dedicated_cleanup_membership_delete',
      '@dedicated_cleanup_deleted_membership = 1',
      'dedicated_cleanup_membership_delete_must_affect_exactly_one_row',
    ),
    `DELETE FROM base_user_info WHERE id = ${userInfoId} AND account_id = ${id}`,
    'SET @dedicated_cleanup_deleted_user_info = ROW_COUNT()',
    ...renderGuardedAssertion(
      'dedicated_cleanup_user_info_delete',
      '@dedicated_cleanup_deleted_user_info = 1',
      'dedicated_cleanup_user_info_delete_must_affect_exactly_one_row',
    ),
    `DELETE FROM base_user_account WHERE id = ${id} AND login_name = '${loginName}'`,
    'SET @dedicated_cleanup_deleted_account = ROW_COUNT()',
    ...renderGuardedAssertion(
      'dedicated_cleanup_account_delete',
      '@dedicated_cleanup_deleted_account = 1',
      'dedicated_cleanup_account_delete_must_affect_exactly_one_row',
    ),
    `SET @dedicated_cleanup_residue = (SELECT COUNT(*) FROM base_user_account WHERE id = ${id}) + (SELECT COUNT(*) FROM base_user_info WHERE account_id = ${id}) + (SELECT COUNT(*) FROM organization_membership WHERE account_id = ${id})`,
    ...renderGuardedAssertion(
      'dedicated_cleanup_residue',
      '@dedicated_cleanup_residue = 0',
      'dedicated_cleanup_residue_must_be_zero',
    ),
    'COMMIT',
  ];

  return statements.join('; ');
}

/**
 * 在单一 MySQL 会话中执行清理脚本；错误原文（含被拒的断言标记）回传调用方，
 * 但密码在错误文本中被脱敏。脚本一旦被拒，mysql 立即退出，后续语句不执行。
 */
function runDedicatedCleanupScript(sql: string, env: Record<string, string>): void {
  try {
    execFileSync(
      'mysql',
      [
        '-h',
        env.DB_HOST,
        '-P',
        env.DB_PORT,
        `-u${env.DB_USER}`,
        env.DB_NAME,
        '-N',
        '-B',
        '-e',
        sql,
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, MYSQL_PWD: env.DB_PASS },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const rawStderr = (error as { stderr?: unknown }).stderr;
    const stderr = Buffer.isBuffer(rawStderr)
      ? rawStderr.toString('utf-8')
      : typeof rawStderr === 'string'
        ? rawStderr
        : '';
    const secret = env.DB_PASS ?? '';
    const redacted = secret === '' ? stderr : stderr.split(secret).join('***');

    throw new Error(
      `专用账号清理脚本被拒绝执行（目标库 ${JSON.stringify(env.DB_NAME)}）：${redacted.trim().split('\n').slice(-3).join(' | ')}`,
      { cause: error },
    );
  }
}

/**
 * 按本轮登记的资源记录执行物理清理（终审 I3 第 2/3 项）。
 *
 * 安全门顺序：入参校验 → 显式 opt-in → 严格专用库名 → 同会话 DATABASE() 复核 →
 * 锁定并核对绑定 → 集合外引用为 0 → 仅删成员/资料/账号 → 残留为 0 → 提交。
 * 不再推导式删除 AI、工单、资料等业务表；这类账外引用在首删前被明确拒绝。
 */
export function deleteE2EDedicatedAccount(account: RegisteredDedicatedAccount): void {
  const env = readBackendEnv();
  const target = describeDedicatedAccountCleanupTarget(account, env.DB_NAME ?? '');

  assertDedicatedAccountExpectation(account);
  if (account.facts === null) {
    throw new Error(`专用账号缺少创建后核验事实，拒绝清理：${target}`);
  }
  assertPositiveInteger(account.id, '专用账号 ID');
  assertPositiveInteger(account.facts.userInfoId, '资料 ID');
  assertPositiveInteger(account.facts.membershipId, '成员关系 ID');

  // 显式许可 + 测试库命名（先于任何数据库进程）
  assertPhysicalCleanupAllowed(env);

  // 严格专用库名：不允许「含 e2e/test 段的任意库」，必须是本轮专用入口解析出的库
  if (env.DB_NAME !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `专用账号清理目标库被拒绝：${JSON.stringify(env.DB_NAME)} ≠ 严格专用库 ${JSON.stringify(DEDICATED_E2E_DB_NAME)}，拒绝物理删除（${target}）`,
    );
  }

  const references = readDedicatedCleanupReferenceColumns();
  const script = buildDedicatedAccountCleanupScript(account, references, DEDICATED_E2E_DB_NAME);

  runDedicatedCleanupScript(script, env);
}

/** 专用账号清理残留读数：主记录 / userInfo 孤儿 / 已知关联业务表 */
export interface DedicatedAccountCleanupResidue {
  readonly account: number;
  readonly relatedBusiness: number;
  readonly userInfo: number;
}

/** 精确统计主记录、userInfo 孤儿和已知关联业务表残留；这是只读核对。 */
export function readDedicatedAccountCleanupResidue(
  accountId: number,
): DedicatedAccountCleanupResidue {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(`残留核对账号 ID 未通过正整数校验：${JSON.stringify(accountId)}`);
  }

  const id = String(accountId);
  // 三条语句：前两条单值 SELECT 以分号分隔；第三条是**一条完整**的连续加法 SELECT
  // （加法项之间只有换行，绝不允许 `+;` 截断表达式——R3 真实改密轮曾因此 ERROR 1064）。
  const rows = mysqlQuery(
    [
      `SELECT COUNT(*) FROM base_user_account WHERE id = ${id}`,
      `SELECT COUNT(*) FROM base_user_info WHERE account_id = ${id}`,
      `SELECT (SELECT COUNT(*) FROM organization_membership WHERE account_id = ${id}) +
              (SELECT COUNT(*) FROM engineer_response WHERE customer_account_id = ${id} OR engineer_account_id = ${id}) +
              (SELECT COUNT(*) FROM ai_message WHERE conversation_id IN (SELECT id FROM ai_conversation WHERE engineer_account_id = ${id})) +
              (SELECT COUNT(*) FROM ai_report WHERE engineer_account_id = ${id}) +
              (SELECT COUNT(*) FROM ai_conversation WHERE engineer_account_id = ${id}) +
              (SELECT COUNT(*) FROM repair_request WHERE customer_account_id = ${id} OR accepted_by_engineer_account_id = ${id}) +
              (SELECT COUNT(*) FROM reference_document WHERE created_by_account_id = ${id})`,
    ].join('; '),
  )
    .split('\n')
    .map((value) => Number(value));

  if (rows.length !== 3 || rows.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`专用账号残留核对返回异常：${JSON.stringify(rows)}`);
  }

  return { account: rows[0], userInfo: rows[1], relatedBusiness: rows[2] };
}

/** 按登录名精确统计账号数（只读）：用于断言「无关哨兵账号保持不变」。 */
export function readAccountCountByLoginName(loginName: string): number {
  if (!/^[a-z0-9_-]{1,64}$/i.test(loginName)) {
    throw new Error(`登录名参数未通过格式校验，拒绝查询：${JSON.stringify(loginName)}`);
  }

  const value = Number(
    mysqlQuery(`SELECT COUNT(*) FROM base_user_account WHERE login_name = '${loginName}'`),
  );

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`按登录名统计账号数返回异常：${JSON.stringify(value)}`);
  }

  return value;
}

// ---- 账号创建登记与逐账号清理编排（终审 I3） ----

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从 adminCreateUser 成功响应体解析数据库生成 ID（正整数校验后返回）。
 * 响应缺失 / 非正整数 ID 一律抛错——调用方据此判定「创建未成功、无可登记目标」。
 */
export function readCreatedDedicatedAccountId(responseBody: unknown): number {
  const id = (responseBody as { data?: { adminCreateUser?: { id?: unknown } } }).data
    ?.adminCreateUser?.id;

  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`专用账号创建失败：${JSON.stringify(responseBody).slice(0, 300)}`);
  }

  return id;
}

/**
 * 创建响应登记（终审 I3 第 1 项）：
 *
 * 1. 校验预期事实与创建响应中的精确 ID；
 * 2. **先**把「ID + 约定登录名 + 角色 + 组织 + 预期资料」登记进本轮清单——登记不依赖任何
 *    后续步骤，故后续核验失败或业务断言失败都不会让该 ID 从清理视野消失；
 * 3. 再回读数据库定位成员关系与资料主键，并逐字段核验实际写入等于预期。
 *
 * 核验失败时登记项保留（facts 为空）并抛出诊断：清理入口会拒绝删除未核验账号，
 * 绝不放宽为按登录名扫描后删除。
 */
export function registerCreatedDedicatedAccount(
  registry: RegisteredDedicatedAccount[],
  responseBody: unknown,
  expectation: DedicatedAccountExpectation,
): RegisteredDedicatedAccount {
  assertDedicatedAccountExpectation(expectation);

  const pending: RegisteredDedicatedAccount = {
    ...expectation,
    facts: null,
    id: readCreatedDedicatedAccountId(responseBody),
  };

  // 先登记精确 ID，再核验事实：核验失败也不能丢失清理边界
  registry.push(pending);

  const verified: RegisteredDedicatedAccount = {
    ...pending,
    facts: readDedicatedAccountCreationFacts(pending),
  };

  registry[registry.length - 1] = verified;

  return verified;
}

/**
 * 逐账号独立清理并聚合报告（终审 I3）：
 * - 每个账号的「按登记记录物理删除」与「精确 ID 残留核对」各自 try/catch——某个账号失败不阻断后续账号；
 * - 删除错误与残留核对错误分别记录，残留非零单列为失败；
 * - 汇总后一次性抛错（含全部失败信息），供调用方与主流程错误一并报告；全部成功（零残留）时不抛错。
 *
 * deleteAccount / readResidue 可注入以便单测；默认复用真实受保护实现。
 */
export function cleanupRegisteredDedicatedAccounts(
  accounts: readonly RegisteredDedicatedAccount[],
  deleteAccount: (account: RegisteredDedicatedAccount) => void = deleteE2EDedicatedAccount,
  readResidue: (id: number) => DedicatedAccountCleanupResidue = readDedicatedAccountCleanupResidue,
): void {
  const failures: string[] = [];

  for (const account of accounts) {
    const { id, loginName } = account;

    try {
      deleteAccount(account);
    } catch (error) {
      failures.push(`账号 ${id}（${loginName}）物理删除失败：${toErrorMessage(error)}`);
    }

    try {
      const residue = readResidue(id);

      if (residue.account !== 0 || residue.userInfo !== 0 || residue.relatedBusiness !== 0) {
        failures.push(`账号 ${id}（${loginName}）清理后仍有残留：${JSON.stringify(residue)}`);
      }
    } catch (error) {
      failures.push(`账号 ${id}（${loginName}）残留核对失败：${toErrorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`专用账号清理失败——${failures.join('；')}`);
  }
}

/**
 * 收尾清理步骤：裸函数按出现序号命名；带标签对象用于在多重失败诊断中区分各步骤
 * （例如「账号清理」与「关闭浏览器上下文」）。
 */
export type CleanupStep =
  | (() => Promise<void> | void)
  | { readonly label: string; readonly run: () => Promise<void> | void };

/** 规范化清理步骤为「标签 + 执行体」；裸函数标签为 null（按序号呈现，避免冗余括号） */
function normalizeCleanupStep(step: CleanupStep): {
  readonly label: string | null;
  readonly run: () => Promise<void> | void;
} {
  return typeof step === 'function'
    ? { label: null, run: step }
    : { label: step.label, run: step.run };
}

/**
 * 主流程 + 收尾步骤的执行包装（最小修复计划 P2）：主流程错误先保留，收尾步骤逐个独立执行。
 * - 每个收尾步骤各自 try/catch 且**无条件 await**：任一步失败都不阻断后续（账号清理失败时
 *   `context.close()` 仍被尝试）；每步错误独立收集，互不覆盖；
 * - 仅一项失败时抛出原始错误（保留原始诊断信息）；多项失败时聚合，错误文本按步骤标签区分；
 * - 不使用 `finally` 之后的断言报告清理失败——主流程抛错时该断言会被跳过，清理错误将被吞掉。
 */
export async function runWithCleanup(
  body: () => Promise<void>,
  ...cleanups: CleanupStep[]
): Promise<void> {
  let primaryError: unknown = null;

  try {
    await body();
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: Array<{
    readonly error: unknown;
    readonly label: string | null;
    readonly order: number;
  }> = [];

  for (const [index, step] of cleanups.entries()) {
    const { label, run } = normalizeCleanupStep(step);

    try {
      // 无条件 await：前一步即使同步抛错，也不跳过后续步骤（关闭上下文必须被尝试）
      await run();
    } catch (error) {
      cleanupErrors.push({ error, label, order: index + 1 });
    }
  }

  const hasPrimary = primaryError !== null;

  if (!hasPrimary && cleanupErrors.length === 0) {
    return;
  }

  // 仅一项失败：抛原始错误，保留原始诊断信息
  if (!hasPrimary && cleanupErrors.length === 1) {
    throw cleanupErrors[0].error;
  }
  if (hasPrimary && cleanupErrors.length === 0) {
    throw primaryError;
  }

  // 多项失败：聚合，主错误在前，收尾各步骤按标签区分，彼此不覆盖
  const segments: string[] = [];

  if (hasPrimary) {
    segments.push(`主流程失败：${toErrorMessage(primaryError)}`);
  }

  const detail = cleanupErrors
    .map(({ error, label, order }) =>
      label === null
        ? `清理步骤 ${order} 失败：${toErrorMessage(error)}`
        : `清理步骤 ${order}（${label}）失败：${toErrorMessage(error)}`,
    )
    .join('；');

  segments.push(`${hasPrimary ? '此外清理失败' : '清理失败'}——${detail}`);

  throw new Error(segments.join('；'));
}

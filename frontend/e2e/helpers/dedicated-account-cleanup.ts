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

/**
 * 按「ID + 登录名」双因子绑定物理删除专用账号及其全部关联记录（R4 修正轮）。
 *
 * 单一事务：START TRANSACTION → 唯一绑定断言（id + login_name）→ 子表到主表精确 DELETE
 * → 残留核对 → COMMIT。绑定断言失败会让 MySQL 客户端在 DELETE 前报错退出，事务自动回滚：
 * 不存在「仅按 ID 继续删除」的路径。
 */
export function deleteE2EDedicatedAccountById(accountId: number, dedicatedLoginName: string): void {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(`物理清理目标账号 ID 未通过正整数校验，拒绝执行：${JSON.stringify(accountId)}`);
  }
  if (!DEDICATED_LOGIN_NAME_PATTERN.test(dedicatedLoginName)) {
    throw new Error(
      `物理清理目标登录名未通过专用账号白名单校验，拒绝执行：${JSON.stringify(dedicatedLoginName)}`,
    );
  }

  const env = readBackendEnv();
  assertPhysicalCleanupAllowed(env);

  const id = String(accountId);
  const loginName = dedicatedLoginName;

  mysqlQuery(
    [
      'START TRANSACTION',
      // R4：清理前必须确认 id 与登录名唯一绑定；不匹配即中止（SELECT 语句报错使 mysql 退出，
      // 连接关闭触发回滚），杜绝同 ID 异名账号被误删
      `SET @dedicated_cleanup_bound = (SELECT COUNT(*) FROM base_user_account WHERE id = ${id} AND login_name = '${loginName}')`,
      "SET @dedicated_cleanup_binding = IF(@dedicated_cleanup_bound = 1, 'SELECT 1', 'SELECT dedicated_account_binding_id_and_login_name_must_match_exactly_one')",
      'PREPARE dedicated_cleanup_binding_check FROM @dedicated_cleanup_binding',
      'EXECUTE dedicated_cleanup_binding_check',
      'DEALLOCATE PREPARE dedicated_cleanup_binding_check',
      `DELETE FROM engineer_response WHERE customer_account_id = ${id} OR engineer_account_id = ${id}`,
      `DELETE FROM ai_message WHERE conversation_id IN (SELECT id FROM ai_conversation WHERE engineer_account_id = ${id})`,
      `DELETE FROM ai_report WHERE engineer_account_id = ${id}`,
      `DELETE FROM ai_conversation WHERE engineer_account_id = ${id}`,
      `DELETE FROM repair_request WHERE customer_account_id = ${id} OR accepted_by_engineer_account_id = ${id}`,
      `DELETE FROM reference_document WHERE created_by_account_id = ${id}`,
      // adminCreateUser 会为账号写入组织成员关系（FK ON DELETE RESTRICT），
      // 必须在主记录前删除，否则整个清理事务被外键拒绝而回滚
      `DELETE FROM organization_membership WHERE account_id = ${id}`,
      `DELETE FROM base_user_info WHERE account_id = ${id}`,
      `DELETE FROM base_user_account WHERE id = ${id}`,
      `SET @dedicated_cleanup_residue = (SELECT COUNT(*) FROM base_user_account WHERE id = ${id}) + (SELECT COUNT(*) FROM base_user_info WHERE account_id = ${id}) + (SELECT COUNT(*) FROM organization_membership WHERE account_id = ${id}) + (SELECT COUNT(*) FROM engineer_response WHERE customer_account_id = ${id} OR engineer_account_id = ${id}) + (SELECT COUNT(*) FROM ai_message WHERE conversation_id IN (SELECT id FROM ai_conversation WHERE engineer_account_id = ${id})) + (SELECT COUNT(*) FROM ai_report WHERE engineer_account_id = ${id}) + (SELECT COUNT(*) FROM ai_conversation WHERE engineer_account_id = ${id}) + (SELECT COUNT(*) FROM repair_request WHERE customer_account_id = ${id} OR accepted_by_engineer_account_id = ${id}) + (SELECT COUNT(*) FROM reference_document WHERE created_by_account_id = ${id})`,
      "SET @dedicated_cleanup_assertion = IF(@dedicated_cleanup_residue = 0, 'SELECT 1', 'SELECT dedicated_cleanup_residue_must_be_zero')",
      'PREPARE dedicated_cleanup_check FROM @dedicated_cleanup_assertion',
      'EXECUTE dedicated_cleanup_check',
      'DEALLOCATE PREPARE dedicated_cleanup_check',
      'COMMIT',
    ].join('; '),
  );
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

// ---- 账号创建登记与逐账号清理编排（最小修复计划 P1/P2） ----

/** 本轮登记的专用账号（精确 ID + 专用登录名双因子）：逐账号清理的唯一删除边界 */
export interface RegisteredDedicatedAccount {
  readonly id: number;
  readonly loginName: string;
}

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
 * 创建响应登记（最小修复计划 P1）：校验专用登录名白名单与创建响应中的精确 ID 后，
 * **立即**登记到本轮清理清单并返回登记项。
 *
 * 调用方必须在任何后续列表查询 / 字段断言 / 弹窗关闭等待之前调用本函数——登记不依赖任何
 * 后续步骤，故后续失败不会回滚登记：精确 ID 始终可被清理看见（不按标题 / 反查猜测归属）。
 */
export function registerCreatedDedicatedAccount(
  registry: RegisteredDedicatedAccount[],
  responseBody: unknown,
  loginName: string,
): RegisteredDedicatedAccount {
  if (!DEDICATED_LOGIN_NAME_PATTERN.test(loginName)) {
    throw new Error(`专用账号登记登录名未通过白名单校验，拒绝登记：${JSON.stringify(loginName)}`);
  }

  const entry: RegisteredDedicatedAccount = {
    id: readCreatedDedicatedAccountId(responseBody),
    loginName,
  };

  registry.push(entry);

  return entry;
}

/**
 * 逐账号独立清理并聚合报告（最小修复计划 P2）：
 * - 每个账号的「精确删除」与「精确 ID 残留核对」各自 try/catch——某个账号失败不阻断后续账号；
 * - 删除错误与残留核对错误分别记录，残留非零单列为失败；
 * - 汇总后一次性抛错（含全部失败信息），供调用方与主流程错误一并报告；全部成功（零残留）时不抛错。
 *
 * deleteAccount / readResidue 可注入以便单测；默认复用真实受保护实现。
 */
export function cleanupRegisteredDedicatedAccounts(
  accounts: readonly RegisteredDedicatedAccount[],
  deleteAccount: (id: number, loginName: string) => void = deleteE2EDedicatedAccountById,
  readResidue: (id: number) => DedicatedAccountCleanupResidue = readDedicatedAccountCleanupResidue,
): void {
  const failures: string[] = [];

  for (const { id, loginName } of accounts) {
    try {
      deleteAccount(id, loginName);
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

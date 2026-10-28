// test/utils/e2e-db-guard.ts

/**
 * E2E 目标数据库硬性守卫（0918 P0 决策 / codex review M-02）。
 *
 * 目的：任何会写库/删库的 E2E 动作（global-setup 全库 TRUNCATE、spec 夹具删除）
 * 之前，都必须先确认「实际连接的库」属于明确允许的 E2E 隔离库白名单。
 * 该校验是**不可跳过**的安全前置：E2E_SKIP_INFRA_CHECKS / E2E_SKIP_DB_CLEANUP
 * 等开关最多跳过健康检查或全库 TRUNCATE，绝不能绕过库名校验、允许在未验证库上删数据。
 */
import type { DataSource, EntityManager } from 'typeorm';

/**
 * 物理删除的显式清理许可开关名。
 * 必须由执行者在启动前显式设置为 1：代码中不提供默认值，也不写入任何 npm script。
 */
export const E2E_PHYSICAL_CLEANUP_CONSENT_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';

/**
 * 第二道独立门禁（纯校验）：物理删除前必须存在显式清理许可。
 *
 * 与库名白名单相互独立：本函数刻意不读取库名，`assertAllowedE2eDatabase` 也刻意不读取
 * 本开关。两道门禁任一缺失都必须失败关闭，任何开关都不能替代或绕过另一道门禁。
 */
export const assertPhysicalCleanupConsent = (): void => {
  if (process.env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV] !== '1') {
    throw new Error(
      `拒绝执行物理删除：缺少显式清理许可 ${E2E_PHYSICAL_CLEANUP_CONSENT_ENV}=1。` +
        `该开关必须由执行者在启动前显式设置为 1（不提供默认值，也不写入 npm script）；` +
        `它与 E2E 库名白名单是两道互相独立的门禁，任一门禁缺失都必须在第一条删除语句前失败关闭。`,
    );
  }
};

/** 允许被 E2E 操作的库名白名单（逗号分隔，大小写不敏感；默认仅隔离测试库）。 */
export const resolveAllowedE2eDatabases = (): string[] => {
  const raw = process.env.E2E_ALLOWED_DB_NAMES || 'lithography_e2e';
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
};

/**
 * 纯校验：目标库必须属于白名单，否则抛错。不触碰任何数据，可安全前置调用。
 */
export const assertAllowedE2eDatabase = (currentDatabase: string): void => {
  const normalized = (currentDatabase ?? '').trim().toLowerCase();
  const allowed = resolveAllowedE2eDatabases();
  if (!normalized || !allowed.includes(normalized)) {
    throw new Error(
      `拒绝在 E2E 目标库上执行破坏性操作：当前库 "${normalized || '(未知)'}" 不在允许的 E2E 库白名单 [${allowed.join(', ')}] 内。` +
        `该库名校验为硬性前置，E2E_SKIP_INFRA_CHECKS / E2E_SKIP_DB_CLEANUP 等开关均无法绕过；` +
        `请确认 .env.e2e 的 DB_NAME 指向隔离测试库。`,
    );
  }
};

/**
 * 解析本次操作的**预期**目标库（N04）。
 *
 * 来源只有两种，且必须显式存在：
 * 1. 调用契约显式传入的 `expectedDatabase`；
 * 2. 已配置 DataSource 的 `options.database`。
 *
 * 绝不以当前 `SELECT DATABASE()` 的结果回填预期，也不回落到个人环境文件或默认库。
 */
export const resolveExpectedE2eDatabase = (
  ds: Pick<DataSource, 'options'>,
  explicitExpectedDatabase?: string,
): string => {
  const explicit = explicitExpectedDatabase?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit.toLowerCase();
  }
  const configured = ds.options?.database;
  const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : '';
  if (!normalized) {
    throw new Error(
      '拒绝执行破坏性操作：无法确定预期目标库（调用契约未显式传入 expectedDatabase，' +
        'DataSource.options.database 也为空）。预期缺失即失败关闭，不允许回落默认库。',
    );
  }
  return normalized;
};

/** 预期库与实际库各自核验白名单，并要求两者完全一致（N04）。 */
export const assertExpectedMatchesActualE2eDatabase = (
  expectedDatabase: string,
  actualDatabase: string,
): void => {
  const expected = (expectedDatabase ?? '').trim().toLowerCase();
  const actual = (actualDatabase ?? '').trim().toLowerCase();
  const allowed = resolveAllowedE2eDatabases();

  if (!expected || !allowed.includes(expected)) {
    throw new Error(
      `拒绝执行破坏性操作：预期目标库 "${expected || '(缺失)'}" 不在允许的 E2E 库白名单 [${allowed.join(', ')}] 内。` +
        '预期库必须显式配置且在白名单内，两库都允许也不能互相替代。',
    );
  }
  if (!actual || !allowed.includes(actual)) {
    throw new Error(
      `拒绝在 E2E 目标库上执行破坏性操作：实际连接库 "${actual || '(未知)'}" 不在允许的 E2E 库白名单 [${allowed.join(', ')}] 内。` +
        '该库名校验为硬性前置，E2E_SKIP_INFRA_CHECKS / E2E_SKIP_DB_CLEANUP 等开关均无法绕过。',
    );
  }
  if (actual !== expected) {
    throw new Error(
      `拒绝执行破坏性操作：预期目标库 "${expected}" 与实际连接库 "${actual}" 不一致。` +
        '两个库即使都允许，也不得互相替代；请确认清理连接与配 DataSource 指向同一 E2E 库。',
    );
  }
};

const readActualDatabase = async (query: (sql: string) => Promise<unknown>): Promise<string> => {
  const rows = (await query('SELECT DATABASE() AS current_database')) as Array<{
    current_database: string | null;
  }>;
  return (rows[0]?.current_database ?? '').trim().toLowerCase();
};

/**
 * 读取给定 DataSource 实际连接的库，并与本次预期目标逐项核验（仅 SELECT DATABASE()，不写数据）。
 * 入口快速拒绝使用；事务内的同一清理连接仍需调用 `assertManagerOnExpectedE2eDatabase`。
 */
export const assertDataSourceOnAllowedE2eDatabase = async (
  ds: DataSource,
  explicitExpectedDatabase?: string,
): Promise<string> => {
  const expected = resolveExpectedE2eDatabase(ds, explicitExpectedDatabase);
  const actual = await readActualDatabase((sql) => ds.query(sql));
  assertExpectedMatchesActualE2eDatabase(expected, actual);
  return actual;
};

/**
 * 在事务/清理所用的同一 manager 会话上核验实际库名（N04）。
 * 不允许只在连接池另一条连接上查询库名后，替实际删除连接作证明。
 */
export const assertManagerOnExpectedE2eDatabase = async (
  manager: EntityManager,
  expectedDatabase: string,
): Promise<string> => {
  const actual = await readActualDatabase((sql) => manager.query(sql));
  assertExpectedMatchesActualE2eDatabase(expectedDatabase, actual);
  return actual;
};

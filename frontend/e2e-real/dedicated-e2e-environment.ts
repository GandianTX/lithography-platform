// e2e-real/dedicated-e2e-environment.ts
// 专用账号设置真实联调的唯一数据库连接配置源（R4 复核修正轮 P1）。
//
// 职责：一次性解析并校验完整五项数据库连接（DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME），
// 供四条链路共享同一份值，杜绝第二套配置源：
// 1. baseline Migration（migration:drill:empty-db 子进程）；
// 2. Mock Seed（seed:mock 子进程）；
// 3. Playwright 专用后端 webServer；
// 4. 测试内 SQL helper / 物理清理 helper（经进程环境写入）。
//
// 失败关闭策略（校验完成前不得启动 Migration、Seed 或任何删除操作）：
// - DB_NAME 必须等于团队默认专用库 lithography_e2e，或命中白名单的本地隔离覆盖
//   （E2E_DEDICATED_DB_NAME，见 resolveDedicatedE2EDbName）；
// - DB_HOST / DB_USER / DB_PASS 不得为空，DB_PORT 必须是合法端口；
// - E2E_ALLOW_PHYSICAL_CLEANUP 必须由调用者显式设置为 1（不入 npm script）；
// - 外部继承的 MIGRATION_DRILL_DATABASE（指向其他库）、MIGRATION_DRILL_CREATE_TEMP_DB=true、
//   MIGRATION_DRILL_DOTENV / SEED_DOTENV（第二套配置源）直接拒绝；
// - 密码不得写入日志或错误文本。
//
// DB 值来源：进程环境优先（空白值忽略），backend env/.env.development 作为回退
// （本地文件，不入库；与后端 webServer / SQL helper 读同一文件，语义一致）。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 团队默认专用库：共享配置的唯一默认目标 */
export const DEDICATED_E2E_DB_NAME_DEFAULT = 'lithography_e2e';

/**
 * 本机隔离库覆盖变量：默认不设置；确需把共享入口指向另一套专用库时，
 * 只能在可复核的本地执行入口（进程环境）中声明，不写入任何共享配置或文档默认值。
 * 覆盖值仍须命中团队命名白名单，并与连接一致性、只读探针、清理授权门逐项复核。
 */
export const DEDICATED_E2E_DB_NAME_OVERRIDE_ENV = 'E2E_DEDICATED_DB_NAME';

/** 白名单：团队默认库，或团队命名约定下另一套专用 E2E 库（不含开发库/演练库） */
const DEDICATED_E2E_DB_NAME_PATTERN = /^lithography(?:_[a-z0-9]+)*_e2e$/;

/** 本轮实际使用的专用库名（模块加载时解析一次，所有消费者共享同一值） */
export const DEDICATED_E2E_DB_NAME = resolveDedicatedE2EDbName();

export const DEDICATED_BACKEND_ORIGIN = 'http://127.0.0.1:3100';

/** 物理清理显式授权变量：只能由执行者在启动前设置，不提供默认值 */
export const DEDICATED_E2E_PHYSICAL_CLEANUP_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';

/**
 * 专用入口的失败关闭严格模式开关：由专用 playwright 配置在加载时显式注入（值为 '1'），
 * 不由执行者手工设置，避免漏设后静默退回 skip。普通默认入口不注入该变量，
 * 继续保持「无本地后端时 skip」的既有语义。
 */
export const DEDICATED_E2E_STRICT_MODE_ENV = 'E2E_REAL_BACKEND_STRICT';

/** 统一注入子进程的五项数据库连接键（与 backend database.config / SQL helper 同口径） */
export const DEDICATED_DB_CONNECTION_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASS',
  'DB_NAME',
] as const;

/**
 * 会改变破坏性子进程目标库或配置源的变量：
 * - MIGRATION_DRILL_DATABASE 优先级高于 DB_NAME，继承即可能把 Migration 指向其他库；
 * - MIGRATION_DRILL_CREATE_TEMP_DB=true 会让 Migration 另建临时库；
 * - MIGRATION_DRILL_DOTENV / SEED_DOTENV 会引入第二套 dotenv 配置源。
 * 外部继承时失败关闭；构造子进程环境时先删除再显式重设。
 */
export const DB_TARGET_MUTATING_KEYS = [
  'MIGRATION_DRILL_DATABASE',
  'MIGRATION_DRILL_CREATE_TEMP_DB',
  'MIGRATION_DRILL_DOTENV',
  'SEED_DOTENV',
] as const;

export interface DedicatedE2EDatabaseConfig {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  /** 仅在内存与子进程环境间传递；绝不允许进入日志或错误文本 */
  readonly pass: string;
  readonly name: string;
}

const BACKEND_ENV_FILE = fileURLToPath(
  new URL('../../backend/env/.env.development', import.meta.url),
);

/** 解析后端 env 文件的 KEY=VALUE 行（与 e2e/helpers/real-backend.readBackendEnv 同口径） */
function parseBackendEnvFileValues(): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const line of readFileSync(BACKEND_ENV_FILE, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      entries[match[1]] = match[2];
    }
  }

  return entries;
}

function readProcessValue(env: NodeJS.ProcessEnv | Record<string, string>, key: string): string {
  const value = env[key];
  return value !== undefined && value.trim() !== '' ? value : '';
}

/** 读取后端 env 文件；本地文件缺失或不可读时按「未提供」处理 */
function readBackendEnvFileValuesSafe(): Record<string, string> {
  try {
    return parseBackendEnvFileValues();
  } catch {
    return {};
  }
}

/**
 * 解析本轮专用库名：团队默认值 + 受控的本地隔离覆盖。
 *
 * - 未声明 `E2E_DEDICATED_DB_NAME` 时使用团队默认库 `lithography_e2e`；
 * - 覆盖只来自进程环境（本地执行入口），不读取未入库文件，避免本机差异进入共享配置；
 * - 覆盖值必须命中团队命名白名单（`lithography[_<段>]*_e2e`），开发库/演练库一律拒绝；
 * - 解析结果参与五项连接一致性、baseline/seed 目标、只读探针与清理授权门的全部复核。
 */
export function resolveDedicatedE2EDbName(
  env: NodeJS.ProcessEnv | Record<string, string> = process.env,
): string {
  const override = readProcessValue(env, DEDICATED_E2E_DB_NAME_OVERRIDE_ENV);

  if (override === '') {
    return DEDICATED_E2E_DB_NAME_DEFAULT;
  }

  if (!DEDICATED_E2E_DB_NAME_PATTERN.test(override)) {
    throw new Error(
      `专用 E2E 库名覆盖被拒绝：${DEDICATED_E2E_DB_NAME_OVERRIDE_ENV}=${JSON.stringify(override)} 未命中团队白名单（默认 ${JSON.stringify(DEDICATED_E2E_DB_NAME_DEFAULT)}）`,
    );
  }

  return override;
}

function assertValidPort(port: string): void {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error(
      `专用 E2E 数据库配置非法：DB_PORT=${JSON.stringify(port)} 不是 1-65535 范围内的合法端口`,
    );
  }
}

/**
 * 一次性解析并校验专用 E2E 数据库连接（进程 env 优先，backend env 文件回退）。
 * 校验失败直接抛错；密码不出现在任何错误文本中。
 */
export function resolveDedicatedE2EDatabase(
  env: NodeJS.ProcessEnv | Record<string, string> = process.env,
): DedicatedE2EDatabaseConfig {
  // 失败关闭：外部继承的目标库可变变量先于任何连接使用被拒绝
  const drillDatabase = readProcessValue(env, 'MIGRATION_DRILL_DATABASE');
  if (drillDatabase !== '' && drillDatabase !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `检测到外部 MIGRATION_DRILL_DATABASE=${JSON.stringify(drillDatabase)}，会把 baseline Migration 指向 ${JSON.stringify(DEDICATED_E2E_DB_NAME)} 之外的库，拒绝执行`,
    );
  }

  if (readProcessValue(env, 'MIGRATION_DRILL_CREATE_TEMP_DB') === 'true') {
    throw new Error(
      '检测到外部 MIGRATION_DRILL_CREATE_TEMP_DB=true，会让 baseline Migration 另建临时库而非使用专用库，拒绝执行',
    );
  }

  for (const key of ['MIGRATION_DRILL_DOTENV', 'SEED_DOTENV'] as const) {
    if (readProcessValue(env, key) !== '') {
      throw new Error(`检测到外部 ${key}，会为破坏性子进程引入第二套 dotenv 配置源，拒绝执行`);
    }
  }

  // 文件是本地文件不入库；仅当进程 env 未提供完整五项时才因缺失失败（见下方校验）
  const fileValues = readBackendEnvFileValuesSafe();

  const resolve = (key: (typeof DEDICATED_DB_CONNECTION_KEYS)[number]): string =>
    readProcessValue(env, key) || fileValues[key] || '';

  const config: DedicatedE2EDatabaseConfig = {
    host: resolve('DB_HOST'),
    port: resolve('DB_PORT'),
    user: resolve('DB_USER'),
    pass: resolve('DB_PASS'),
    name: resolve('DB_NAME'),
  };

  if (config.name !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `专用真实联调必须以 ${JSON.stringify(DEDICATED_E2E_DB_NAME)} 为目标库（DB_NAME 进程级覆盖），实际为 ${JSON.stringify(config.name)}`,
    );
  }

  if (config.host === '' || config.user === '' || config.pass === '') {
    const missing = [
      config.host === '' ? 'DB_HOST' : null,
      config.user === '' ? 'DB_USER' : null,
      config.pass === '' ? 'DB_PASS' : null,
    ].filter((key): key is string => key !== null);

    throw new Error(
      `专用 E2E 数据库配置不完整：${missing.join(', ')} 为空（进程环境或 backend env 文件均未提供）`,
    );
  }

  assertValidPort(config.port);

  return config;
}

/**
 * 构造破坏性子进程环境的基础覆盖面：
 * 删除继承的可改变目标库变量与全部 DB 连接键，再显式传入统一校验后的五项连接。
 * 不修改 process.env，返回全新对象。
 */
export function buildDedicatedChildProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  database: DedicatedE2EDatabaseConfig,
): Record<string, string> {
  // 先剥离 undefined 值（NodeJS.ProcessEnv 允许 string | undefined），再删除继承键
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  for (const key of [...DB_TARGET_MUTATING_KEYS, ...DEDICATED_DB_CONNECTION_KEYS]) {
    delete childEnv[key];
  }

  return {
    ...childEnv,
    DB_HOST: database.host,
    DB_PORT: database.port,
    DB_USER: database.user,
    DB_PASS: database.pass,
    DB_NAME: database.name,
  };
}

/** Migration 子进程：统一连接 + 显式锁定目标库（库名不含 test/drill/ci，按脚本要求授权） */
export function buildMigrationChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  database: DedicatedE2EDatabaseConfig,
): Record<string, string> {
  return {
    ...buildDedicatedChildProcessEnv(baseEnv, database),
    MIGRATION_DRILL_DATABASE: DEDICATED_E2E_DB_NAME,
    MIGRATION_DRILL_CREATE_TEMP_DB: 'false',
    MIGRATION_DRILL_ALLOW_NON_TEST_DB: 'true',
  };
}

/** Seed 子进程：统一连接 + 显式授权（库名不含 test/drill/dev/local，按脚本要求授权） */
export function buildSeedChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  database: DedicatedE2EDatabaseConfig,
): Record<string, string> {
  return {
    ...buildDedicatedChildProcessEnv(baseEnv, database),
    SEED_ALLOW_NON_TEST_DB: 'true',
  };
}

type SyncRunner = (file: string, args: readonly string[]) => string;

/**
 * 构造底层错误的脱敏副本：message 中的密码替换为 ***。
 * 探针错误的 cause 链绝不允许出现未脱敏文本，因此不能用原始 error 直接挂 cause。
 */
function sanitizedErrorCopy(error: unknown, secret: string): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = secret === '' ? rawMessage : rawMessage.split(secret).join('***');

  return new Error(sanitizedMessage);
}

/**
 * 只读连接探针：在第一个破坏性子进程启动前确认实际连接目标。
 * - host：由 mysql CLI 按 -h 实际建立 TCP 连接证明（连错主机连不上即失败）；
 * - port / DATABASE()：以服务器侧回读 @@port / DATABASE() 严格比对，杜绝客户端
 *   与服务器对同一连接的认知偏差；
 * - 密码经 MYSQL_PWD 注入（不出现在进程参数、输出或错误文本中）。
 * 探针失败或返回其他数据库时抛错，Migration/Seed 均不得启动。
 */
export function probeDedicatedDatabaseConnection(
  database: DedicatedE2EDatabaseConfig,
  run: SyncRunner = (file, args) =>
    execFileSync(file, args, {
      encoding: 'utf-8',
      env: { ...process.env, MYSQL_PWD: database.pass },
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
): void {
  let output: string;

  try {
    output = run('mysql', [
      '-h',
      database.host,
      '-P',
      database.port,
      `-u${database.user}`,
      database.name,
      '-N',
      '-B',
      '-e',
      'SELECT DATABASE(), @@port, @@hostname',
    ]);
  } catch (error: unknown) {
    // 底层错误原文可能意外包含密码：按安全要求以脱敏副本作为 cause，
    // 保证新错误的 message 与整条 cause 链都不含密码；原始堆栈不保留。
    const sanitizedError = sanitizedErrorCopy(error, database.pass);
    // preserve-caught-error 要求挂原始 error，此处安全要求优先，定向豁免
    throw new Error(
      `专用 E2E 只读连接探针失败（host=${database.host} port=${database.port} db=${database.name}），拒绝启动 Migration/Seed：${sanitizedError.message.split('\n')[0]}`,
      // eslint-disable-next-line preserve-caught-error -- 原始 error 可能含密码，必须以脱敏副本作为 cause
      { cause: sanitizedError },
    );
  }

  const firstLine = output.trim().split('\n')[0] ?? '';
  const [actualDatabase, actualPort] = firstLine.split('\t').map((value) => value.trim());

  if (actualDatabase !== database.name || actualPort !== database.port) {
    throw new Error(
      `专用 E2E 只读连接探针目标不一致：配置 db=${database.name} port=${database.port}，实际 db=${JSON.stringify(actualDatabase)} port=${JSON.stringify(actualPort)}，拒绝启动 Migration/Seed`,
    );
  }
}

// e2e-real/global-setup.ts
// 多个专用隔离真实 E2E Playwright 配置共用的全局前置：
//
// 1. 硬失败门：物理清理授权（E2E_ALLOW_PHYSICAL_CLEANUP=1）缺失、目标库不合法或
//    与专用库不一致时，联调链路直接失败，不得 skip 掩盖；
// 2. 唯一配置源：五项数据库连接（DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME）由
//    dedicated-e2e-environment 一次性解析并校验，Migration、Seed、专用后端 webServer
//    与测试内 SQL helper 全部消费同一份值；外部继承的 MIGRATION_DRILL_DATABASE /
//    MIGRATION_DRILL_CREATE_TEMP_DB=true / MIGRATION_DRILL_DOTENV / SEED_DOTENV
//    直接失败关闭，绝不触碰 lithography_drill 或其他数据库；
// 3. 只对专用独立库 lithography_e2e 执行 baseline Migration（官方空库演练脚本：
//    清空表 → 全量迁移 → 结构校验）与官方 Mock Seed；第一个破坏性子进程启动前
//    执行一次只读连接探针，确认实际连接的库与端口与已校验配置一致；
// 4. 专用后端由 playwright 配置的 webServer 以进程级环境变量启动
//    （APP_PORT=3100 / 完整五项 DB 连接 / NODE_ENV=development），不修改任何 .env；
// 5. npm 子进程经 process.execPath + process.env.npm_execpath 启动 npm CLI，
//    Linux / macOS / Windows 共用同一条实现；
// 6. 专用库跨进程执行锁：实现抽取到 `e2e/helpers/execution-lock.ts`（可单测，
//    含真实多进程竞争回归）。锁文件落在 os.tmpdir()，owner 为 {pid, startedAt, token}；
//    载荷先完整写盘再原子发布，废弃锁经「凭证目录 + token CAS 复核 + 原子覆盖」接管，
//    释放只删除 token 一致的那把锁且严格一次性。持锁进程仍在运行则硬失败，避免两条
//    链路同时对同一专用库执行 Migration/Seed 与物理清理。**setup 自身失败时自行释放锁**
//    （Playwright 不会调用抛错 setup 的返回值），setup 与释放同时失败则抛 AggregateError。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireExecutionLock } from '../e2e/helpers/execution-lock';
import { assertPhysicalCleanupAllowed, readBackendEnv } from '../e2e/helpers/real-backend';

import {
  buildMigrationChildEnv,
  buildSeedChildEnv,
  DEDICATED_BACKEND_ORIGIN,
  DEDICATED_DB_CONNECTION_KEYS,
  DEDICATED_E2E_DB_NAME,
  type DedicatedE2EDatabaseConfig,
  probeDedicatedDatabaseConnection,
  resolveDedicatedE2EDatabase,
} from './dedicated-e2e-environment';

// 常量收口于专用配置模块；此处 re-export 维持既有 import 路径兼容
export { DEDICATED_BACKEND_ORIGIN, DEDICATED_E2E_DB_NAME };

const BACKEND_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'backend',
);

/** 定位 npm CLI：只能经 npm run 启动（npm_execpath 由 npm 自身注入） */
function resolveNpmCliInvocation(): { command: string; baseArgs: string[] } {
  const npmCliPath = process.env.npm_execpath?.trim();

  if (npmCliPath === undefined || npmCliPath === '') {
    throw new Error(
      '无法定位 npm CLI（process.env.npm_execpath 缺失）：global setup 必须经 npm run 启动，拒绝猜测 npm 可执行文件路径',
    );
  }

  return { command: process.execPath, baseArgs: [npmCliPath, 'run'] };
}

function runBackendScript(script: string, extraEnv: Record<string, string>): void {
  const { command, baseArgs } = resolveNpmCliInvocation();

  execFileSync(command, [...baseArgs, script], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
}

/** DB 环境键 → 专用配置字段的映射（readBackendEnv 与 DedicatedE2EDatabaseConfig 对齐用） */
const DB_KEY_TO_CONFIG_FIELD: Record<
  (typeof DEDICATED_DB_CONNECTION_KEYS)[number],
  keyof DedicatedE2EDatabaseConfig
> = {
  DB_HOST: 'host',
  DB_NAME: 'name',
  DB_PASS: 'pass',
  DB_PORT: 'port',
  DB_USER: 'user',
};

/**
 * 配置同一性检查：SQL helper（readBackendEnv：文件值 + 进程覆盖）解析出的五项连接
 * 必须与专用配置模块的校验结果完全一致，防止未来两条解析路径语义漂移后
 * 「Migration/Seed 与 SQL 清理打到不同库」。
 */
function assertSqlHelperConfigurationConsistency(dedicated: DedicatedE2EDatabaseConfig): void {
  const helperEnv = readBackendEnv();

  for (const key of DEDICATED_DB_CONNECTION_KEYS) {
    if (helperEnv[key] !== dedicated[DB_KEY_TO_CONFIG_FIELD[key]]) {
      // 错误文本只报告键名，绝不回显值（DB_PASS 可能是明文密码）
      throw new Error(
        `专用真实联调配置不一致：SQL helper 的 ${key} 与专用配置模块解析值不同，拒绝启动 Migration/Seed`,
      );
    }
  }
}

// 返回值即 Playwright teardown：本轮结束时释放专用库执行锁
export default function globalSetup(): () => void {
  // 授权缺失 / 库名不合法：直接失败（不得以 skip 掩盖）
  assertPhysicalCleanupAllowed(readBackendEnv());

  // 一次性解析并校验专用配置（含失败关闭策略），校验完成前不启动任何破坏性子进程
  const dedicated = resolveDedicatedE2EDatabase();

  // 拿下专用库执行锁后，才允许进入本轮的 Migration/Seed/物理清理窗口；
  // teardown 由 Playwright 在本轮结束时调用，正常退出即释放锁
  const releaseExecutionLock = acquireExecutionLock(dedicated.name);

  try {
    // 将完整五项连接写入当前 Playwright 测试进程环境：SQL helper（readBackendEnv）
    // 与测试内物理清理 helper 由此读取到与 Migration/Seed/webServer 完全相同的值
    process.env.DB_HOST = dedicated.host;
    process.env.DB_PORT = dedicated.port;
    process.env.DB_USER = dedicated.user;
    process.env.DB_PASS = dedicated.pass;
    process.env.DB_NAME = dedicated.name;

    assertSqlHelperConfigurationConsistency(dedicated);

    // 第一个破坏性子进程之前的只读连接探针：确认实际连接的库与端口与配置一致
    probeDedicatedDatabaseConnection(dedicated);

    // 官方 baseline：空库演练脚本（清空 lithography_e2e 全部表 → 全量迁移 → 结构校验）。
    // 五项连接经子进程环境显式锁定，dotenv 不覆盖已存在的进程变量，故绝不影响
    // lithography_drill 或其他库；DB 名不含 test/drill/ci 段，按脚本要求显式授权。
    runBackendScript('migration:drill:empty-db', buildMigrationChildEnv(process.env, dedicated));

    // 官方 Mock Seed：与 migration 完全相同的五项连接（lithography_e2e）。库名不含
    // test/drill/dev/local 段，按 seed 脚本自身安全门的要求以进程级变量显式授权。
    runBackendScript('seed:mock', buildSeedChildEnv(process.env, dedicated));
  } catch (setupError) {
    // setup 抛错时 Playwright 不会调用其返回值，故必须在此自行释放：否则一次失败的
    // setup 会把执行锁永久留在 tmpdir，此后所有联调都以「已有真实联调在执行」莫名失败。
    let releaseError: unknown;

    try {
      releaseExecutionLock();
    } catch (error) {
      releaseError = error;
    }

    if (releaseError !== undefined) {
      throw new AggregateError(
        [setupError, releaseError],
        '专用库真实联调 global setup 失败，且释放执行锁同样失败（锁可能仍残留在临时目录）',
        { cause: setupError },
      );
    }

    throw setupError;
  }

  return releaseExecutionLock;
}

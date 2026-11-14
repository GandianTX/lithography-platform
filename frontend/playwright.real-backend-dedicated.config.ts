// playwright.real-backend-dedicated.config.ts
// 四个真实后端 E2E spec（admin-document-database-real / reference-document-real /
// repair-request-manage-real / repair-request-create-real）的专用隔离联调入口。
//
// 为什么需要专用入口：默认配置（playwright.config.ts）的浏览器与 SQL helper 指向本地开发后端
// （127.0.0.1:3000）与共享开发库 lithography_drill，而这四条 spec 会真实创建 / 软删行并上传文件；
// 共享开发库不满足物理清理的授权与命名门（assertPhysicalCleanupAllowed），测试数据只能软删后
// 留在开发库里。本入口把它们固定到与开发库完全隔离的 lithography_e2e，并复用既有专用配置模块
// 与全局前置，不新增第二套配置源。
//
// 与既有专用配置（playwright.account-settings-real / playwright.engineer-repair-request-real）
// 同一模式：
// - 完整五项 DB 连接统一由 e2e-real/dedicated-e2e-environment.ts 解析并校验，DB_NAME 必须严格
//   等于 lithography_e2e，否则配置加载即失败（校验完成前不会启动任何破坏性子进程）；
// - 专用后端 3100（reuseExistingServer: false，绝不复用开发后端 3000）、专用前端 4174
//   （strictPort，DEV_API_PROXY_TARGET 指向 3100，VITE_GRAPHQL_ENDPOINT 置空走同源代理）；
//   浏览器 / Node GraphQL helper / SQL helper 三者同源，并由 real-backend helper 的
//   assertDedicatedLinkDatabaseConsistency 复查「后端指向专用时 SQL 库必须是专用库」；
// - globalSetup（e2e-real/global-setup.ts）只对 lithography_e2e 执行 baseline Migration 与
//   官方 Mock Seed，库名不符或缺授权即硬失败；
// - 失败关闭：本入口显式注入 E2E_REAL_BACKEND_STRICT=1，四条 spec 统一走 real-backend helper 的
//   resolveRealBackendPrerequisite 预检；后端不可达 / 登录失败 / 通道或配置缺失时直接抛错让用例
//   failed，绝不 skip。普通默认入口不注入该变量，保留既有「无本地后端时 skip」语义；
// - 物理清理与专用库访问同样要求执行者显式授权，授权变量不写入 npm script：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:real-backend-dedicated
// - 覆盖范围：e2e/ 下全部需要真实后端或写库的四条 spec。`repair-request-manage.spec.ts`
//   是纯 mock 守卫用例（本轮整改 P2 已把其中的 route.continue() 改为失败关闭），
//   不依赖真实后端，故不进入本入口，由 mock-only 组执行；`engineer-repair-request-real.spec.ts`
//   有独立专用入口（playwright.engineer-repair-request-real.config.ts），同样不在此重复。
import { defineConfig } from '@playwright/test';

import {
  DEDICATED_BACKEND_ORIGIN,
  DEDICATED_E2E_DB_NAME,
  DEDICATED_E2E_STRICT_MODE_ENV,
  resolveDedicatedE2EDatabase,
} from './e2e-real/dedicated-e2e-environment';

/**
 * 专用目标注入（与 account-settings-real 同口径）：外部未设置时写入专用值；外部已设置且与
 * 专用值冲突则硬失败，不做静默覆盖——静默覆盖会让执行者「以为打到了别的库」而实际落在专用库，
 * 也会让 real-backend helper 的库名一致性守卫永久不可触发。
 */
function injectDedicatedEnvOrThrow(key: string, dedicatedValue: string): void {
  const inherited = process.env[key]?.trim();

  if (inherited !== undefined && inherited !== '' && inherited !== dedicatedValue) {
    throw new Error(
      `专用真实联调拒绝启动：环境变量 ${key} 已被外部设置为非专用目标（与专用配置冲突）；` +
        '请移除该变量后重试，或将其改为专用值（专用库 / 专用后端来源）',
    );
  }

  process.env[key] = dedicatedValue;
}

injectDedicatedEnvOrThrow('DB_NAME', DEDICATED_E2E_DB_NAME);
injectDedicatedEnvOrThrow('E2E_BACKEND_ORIGIN', DEDICATED_BACKEND_ORIGIN);

/**
 * 严格模式开关注入：专用入口必须失败关闭（后端/登录/通道异常一律 failed，不得 skip），
 * 由本配置显式开启，不依赖执行者手工设置一个容易漏掉的变量。外部显式设为非 '1' 值
 * 视为试图关闭失败关闭，直接拒绝启动。
 */
const inheritedStrictMode = process.env[DEDICATED_E2E_STRICT_MODE_ENV]?.trim();

if (
  inheritedStrictMode !== undefined &&
  inheritedStrictMode !== '' &&
  inheritedStrictMode !== '1'
) {
  throw new Error(
    `专用真实联调拒绝启动：环境变量 ${DEDICATED_E2E_STRICT_MODE_ENV} 已被外部设置为非严格值；` +
      '专用入口必须失败关闭（前提不满足即 failed，不得 skip），请移除该变量后重试',
  );
}

process.env[DEDICATED_E2E_STRICT_MODE_ENV] = '1';

// 配置加载时即完成一次专用数据库连接解析与校验（含失败关闭策略）：
// 任何消费者（webServer、global-setup、SQL helper）都以这一份解析结果为准。
const dedicatedDatabase = resolveDedicatedE2EDatabase();

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  globalSetup: './e2e-real/global-setup.ts',
  outputDir: './test-results/real-backend-dedicated',
  reporter: [['list']],
  retries: 0,
  testDir: './e2e',
  // 只收集这四条真实后端用例；同目录其余 spec（mock 组、工程师专用真实链路）不进入本次运行
  testMatch: [
    '**/admin-document-database-real.spec.ts',
    '**/reference-document-real.spec.ts',
    '**/repair-request-manage-real.spec.ts',
    '**/repair-request-create-real.spec.ts',
  ],
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // nest build 实际产物布局为 dist/src/bootstraps/api/main.js
      command: 'cd ../backend && npm run build:api && node dist/src/bootstraps/api/main',
      env: {
        APP_PORT: '3100',
        DB_HOST: dedicatedDatabase.host,
        DB_NAME: DEDICATED_E2E_DB_NAME,
        DB_PASS: dedicatedDatabase.pass,
        DB_PORT: dedicatedDatabase.port,
        DB_USER: dedicatedDatabase.user,
        NODE_ENV: 'development',
        TZ: 'Asia/Shanghai',
      },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'ignore',
      timeout: 300_000,
      url: `${DEDICATED_BACKEND_ORIGIN}/health`,
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 4174 --strictPort',
      env: {
        // 故障验收可显式指向不可达的本地端口；仅改变代理，不改变专用数据库或清理门禁。
        DEV_API_PROXY_TARGET:
          process.env.E2E_REAL_FRONTEND_PROXY_TARGET || DEDICATED_BACKEND_ORIGIN,
        VITE_GRAPHQL_ENDPOINT: '',
      },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'ignore',
      timeout: 120_000,
      url: 'http://127.0.0.1:4174',
    },
  ],
  workers: 1,
});

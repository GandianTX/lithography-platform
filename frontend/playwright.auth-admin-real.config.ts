// playwright.auth-admin-real.config.ts
// 登录与管理员用户管理真实联调入口（PR6 S4）：仅服务隔离库真实登录 / 管理员链路，
// 普通 Playwright 配置（playwright.config.ts）保持不变。
//
// 与普通配置的差别（与 playwright.account-settings-real.config.ts 同一模式）：
// - 专用后端：webServer 以进程级环境变量启动真实后端（APP_PORT=3100、完整五项
//   DB 连接经专用配置模块统一解析注入、NODE_ENV=development），先 build 后运行；
//   端口被占用时 Playwright 报错终止（reuseExistingServer: false），不复用
//   127.0.0.1:3000 开发后端；真实 Token 自然过期所需的短有效期只做**专用进程级覆盖**
//   （JWT_EXPIRES_IN，可由 E2E_AUTH_ADMIN_JWT_EXPIRES_IN 提供，默认 60s——须短到
//   可在单条用例内等到自然过期，且长到足以支撑其余 UI 场景；仅作用于本次专用后端
//   进程），绝不改写任何 .env，也不伪造 Token；
// - 专用前端：独立 vite dev server（4174，strictPort），VITE_GRAPHQL_ENDPOINT 进程级
//   置空 → 应用走同源 /graphql，由 DEV_API_PROXY_TARGET 指向专用后端 3100；
//   浏览器、Node GraphQL helper（E2E_BACKEND_ORIGIN，由本配置注入）与 SQL helper
//   （完整五项 DB 连接，经 global-setup 写入测试进程环境）全部指向同一专用后端与
//   同一独立 E2E 库；
// - 全局前置（e2e-real/global-setup.ts）只对 lithography_e2e 执行 baseline Migration 与
//   官方 Mock Seed，授权缺失时硬失败；
// - 专用入口下进程级环境变量由本配置在**外部未设置时**注入（DB_NAME /
//   E2E_BACKEND_ORIGIN），外部若已设置且指向非专用目标则硬失败（不静默覆盖）；
// - 运行方式（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:auth-admin-real
import { defineConfig } from '@playwright/test';

import {
  DEDICATED_BACKEND_ORIGIN,
  DEDICATED_E2E_DB_NAME,
  resolveDedicatedE2EDatabase,
} from './e2e-real/dedicated-e2e-environment';

/**
 * 专用目标注入：外部**未设置**时写入专用值；外部已设置且与专用值冲突则硬失败，
 * 不做静默覆盖——静默覆盖会让操作者「以为打到了别的库」而实际落在专用库。
 * 必须早于 resolveDedicatedE2EDatabase()：该函数以「进程环境优先、backend env 文件回退」
 * 解析 DB_NAME，而 env 文件的回退值不是专用库，晚注入会先被失败关闭拦下。
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

// 配置加载时即完成一次专用数据库连接解析与校验（含失败关闭策略）：
// 任何消费者（webServer、global-setup、SQL helper）都以这一份解析结果为准。
const dedicatedDatabase = resolveDedicatedE2EDatabase();

// 真实 Token 自然过期：仓库不存在按请求可控有效期能力，只做专用进程级覆盖。
// 仅作用于本次专用后端进程，不改写 .env、不签发伪造 Token。
const dedicatedJwtExpiresIn = process.env.E2E_AUTH_ADMIN_JWT_EXPIRES_IN?.trim() || '60s';

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  globalSetup: './e2e-real/global-setup.ts',
  outputDir: './test-results/auth-admin-real',
  reporter: [['list']],
  retries: 0,
  testDir: './e2e-real',
  // e2e-real 目录同时承载 vitest 单测与其他专用入口 spec，本入口只收集登录/管理真实用例
  testMatch: ['**/auth-admin-real.spec.ts'],
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
        JWT_EXPIRES_IN: dedicatedJwtExpiresIn,
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
        DEV_API_PROXY_TARGET: DEDICATED_BACKEND_ORIGIN,
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

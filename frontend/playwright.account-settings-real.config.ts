// playwright.account-settings-real.config.ts
// 专用账号设置真实联调入口（R4 修正轮 P1-1）：仅服务真实账号设置联调，
// 普通 Playwright 配置（playwright.config.ts）保持不变。
//
// 与普通配置的差别：
// - 专用后端：webServer 以进程级环境变量启动真实后端（APP_PORT=3100、完整五项
//   DB 连接经专用配置模块统一解析注入、NODE_ENV=development），先 build 后运行；
//   端口被占用时 Playwright 报错终止（reuseExistingServer: false），不复用
//   127.0.0.1:3000 开发后端；
// - 专用前端：独立 vite dev server（4174，strictPort），VITE_GRAPHQL_ENDPOINT 进程级
//   置空 → 应用走同源 /graphql，由 DEV_API_PROXY_TARGET 指向专用后端 3100；
//   浏览器、Node GraphQL helper（E2E_BACKEND_ORIGIN，由本配置注入）与 SQL helper
//   （完整五项 DB 连接，经 global-setup 写入测试进程环境）全部指向同一专用后端与
//   同一独立 E2E 库；
// - 全局前置（global-setup.ts）只对 lithography_e2e 执行 baseline Migration 与官方
//   Mock Seed，授权缺失时硬失败；
// - 专用入口下进程级环境变量由本配置在**外部未设置时**注入（DB_NAME /
//   E2E_BACKEND_ORIGIN），不再依赖 npm script 的 cross-env：浏览器、Node GraphQL
//   helper（E2E_BACKEND_ORIGIN）与 SQL helper（DB_NAME 等五项连接，经 global-setup
//   写入测试进程环境）由此共享同一专用后端与同一独立 E2E 库；外部若已设置且指向
//   非专用目标则硬失败（不静默覆盖）；RUN_ID 级数据隔离由各 spec 自行保证；
// - 运行方式（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:pr5-real
//   （账号设置联调：E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:account-real）
// - 需要录制流程视频时追加 E2E_VIDEO=on（默认关闭，避免日常回归产生大量媒体文件）。
import { defineConfig } from '@playwright/test';

import {
  DEDICATED_BACKEND_ORIGIN,
  DEDICATED_E2E_DB_NAME,
  resolveDedicatedE2EDatabase,
} from './e2e-real/dedicated-e2e-environment';

/**
 * 专用目标注入（D5-2）：外部**未设置**时写入专用值；外部已设置且与专用值冲突则硬失败，
 * 不做静默覆盖——静默覆盖会让操作者「以为打到了别的库」而实际落在专用库，并使
 * assertPr5DedicatedEnvironment 的 DB_NAME 维度守卫永久不可触发。
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

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  globalSetup: './e2e-real/global-setup.ts',
  outputDir: './test-results/account-settings-real',
  reporter: [['list']],
  retries: 0,
  testDir: './e2e-real',
  // e2e-real 目录同时承载 vitest 单测（如专用配置模块 spec），Playwright 只收集真实用例；
  // 两个专用入口共用同一套 webServer / global-setup，故 testMatch 并列，
  // 需要单独执行时以命令行位置参数定位（见 package.json 的两个 npm script）。
  testMatch: ['**/account-settings-real.spec.ts', '**/pr5-real-flow.spec.ts'],
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    video: process.env.E2E_VIDEO === 'on' ? 'on' : 'off',
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

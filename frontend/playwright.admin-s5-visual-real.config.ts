// playwright.admin-s5-visual-real.config.ts
// 任务 08 · S5 管理端三页视觉复验入口：与 playwright.admin-user-management-real.config.ts
// 同一专用库 runner 模式，只收集 admin-s5-visual-real.spec.ts。
//
// - 专用后端：webServer 以进程级环境变量启动真实后端（APP_PORT=3100、完整五项 DB
//   连接经专用配置模块统一解析注入、NODE_ENV=development），先 build 后运行；
//   端口被占用时 Playwright 报错终止（reuseExistingServer: false）；
// - 专用前端：独立 vite dev server（4174，strictPort），VITE_GRAPHQL_ENDPOINT 进程级
//   置空 → 应用走同源 /graphql，由 DEV_API_PROXY_TARGET 指向专用后端 3100；
// - 全局前置（e2e-real/global-setup.ts）只对专用库执行 baseline Migration 与官方
//   Mock Seed，授权缺失时硬失败；
// - 本套用例为**只读采集**，不验证「重置为默认密码」成功链路，因此**不**要求
//   ADMIN_DEFAULT_RESET_PASSWORD，也不把它透传给后端进程；
// - 运行方式（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_DEDICATED_DB_NAME=lithography_work_e2e \
//     npm run test:e2e:admin-s5-visual-real
import { defineConfig } from '@playwright/test';

import {
  DEDICATED_BACKEND_ORIGIN,
  DEDICATED_E2E_DB_NAME,
  resolveDedicatedE2EDatabase,
} from './e2e-real/dedicated-e2e-environment';

/**
 * 专用目标注入：外部**未设置**时写入专用值；外部已设置且与专用值冲突则硬失败。
 * 必须早于 resolveDedicatedE2EDatabase()：该函数以「进程环境优先、backend env 文件
 * 回退」解析 DB_NAME，晚注入会先被失败关闭拦下。
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

// 配置加载时即完成一次专用数据库连接解析与校验（含失败关闭策略）
const dedicatedDatabase = resolveDedicatedE2EDatabase();

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  globalSetup: './e2e-real/global-setup.ts',
  outputDir: './test-results/admin-s5-visual-real',
  reporter: [['list']],
  retries: 0,
  testDir: './e2e-real',
  testMatch: ['**/admin-s5-visual-real.spec.ts'],
  timeout: 300_000,
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

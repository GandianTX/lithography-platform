// playwright.admin-user-management-real.config.ts
// 普通用户管理（任务 08 · S4）隔离库真实联调入口：与 playwright.admin-engineer-approval-real.config.ts
// 同一模式，只收集 admin-user-management-real.spec.ts。
//
// - 专用后端：webServer 以进程级环境变量启动真实后端（APP_PORT=3100、完整五项 DB
//   连接经专用配置模块统一解析注入、NODE_ENV=development），先 build 后运行；
//   端口被占用时 Playwright 报错终止（reuseExistingServer: false）；
// - 专用前端：独立 vite dev server（4174，strictPort），VITE_GRAPHQL_ENDPOINT 进程级
//   置空 → 应用走同源 /graphql，由 DEV_API_PROXY_TARGET 指向专用后端 3100；
// - 全局前置（e2e-real/global-setup.ts）只对专用库执行 baseline Migration 与官方
//   Mock Seed，授权缺失时硬失败；
// - 默认路径：本套用例要验证「重置为系统默认密码」完整链路，因此
//   ADMIN_DEFAULT_RESET_PASSWORD 必须在配置加载期显式提供（缺失即硬失败），
//   并显式透传给专用后端进程；不写入任何 tracked 文件；
// - 运行方式（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 ADMIN_DEFAULT_RESET_PASSWORD='<合成默认密码>' \
//     npm run test:e2e:admin-user-management-real
//   若本机专用库不是默认 lithography_e2e，追加 E2E_DEDICATED_DB_NAME=<白名单库>。
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

/**
 * 默认重置密码：本套用例以「管理员重置为系统默认密码 + 强制首次改密」为验收主线，
 * 配置缺失时重置入口会按设计失败关闭（INTERNAL_SERVER_ERROR），无法覆盖成功链路。
 * 因此这里在启动期就硬失败，避免把配置问题伪装成用例失败。
 */
const defaultResetPassword = process.env.ADMIN_DEFAULT_RESET_PASSWORD?.trim() ?? '';

if (defaultResetPassword === '') {
  throw new Error(
    '专用真实联调拒绝启动：必须显式设置 ADMIN_DEFAULT_RESET_PASSWORD（合成默认密码），' +
      '用例需要验证「重置为系统默认密码」的成功链路',
  );
}

// 配置加载时即完成一次专用数据库连接解析与校验（含失败关闭策略）
const dedicatedDatabase = resolveDedicatedE2EDatabase();

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  globalSetup: './e2e-real/global-setup.ts',
  outputDir: './test-results/admin-user-management-real',
  reporter: [['list']],
  retries: 0,
  testDir: './e2e-real',
  testMatch: ['**/admin-user-management-real.spec.ts'],
  timeout: 180_000,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // nest build 实际产物布局为 dist/src/bootstraps/api/main.js
      command: 'cd ../backend && npm run build:api && node dist/src/bootstraps/api/main',
      env: {
        ADMIN_DEFAULT_RESET_PASSWORD: defaultResetPassword,
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

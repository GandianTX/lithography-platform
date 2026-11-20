// playwright.ai-diagnosis-real.config.ts
// 任务05 S3.3 专用入口：AI 诊断工作区 · 真实后端 + 真实浏览器联调。
//
// 与默认 mock-only 入口隔离：
// - 独立端口（前端默认 4176），避免与默认入口的 4173 复用同一 dev server；
// - DEV_API_PROXY_TARGET 指向真实后端（默认 127.0.0.1:3005 开发库）；
// - 凭据只从环境变量读取，不入库；缺失时用例自动 skip。

import { defineConfig } from '@playwright/test';

import { C2_GRAPHQL_PATH, resolveC2Target } from './e2e/helpers/c2-target';

const c2 = resolveC2Target();
if (c2.kind === 'invalid') {
  throw new Error(`[c2-target] ${c2.reason}`);
}

const frontendPort = Number(process.env.AI_E2E_FRONTEND_PORT ?? 4176);
const backendTarget =
  c2.kind === 'enabled'
    ? c2.backendUrl
    : (process.env.AI_E2E_BACKEND_URL ?? 'http://127.0.0.1:3005');

export default defineConfig({
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  // C2 会在首个业务请求前核对「后端就是本轮启动器启动的实例」，不满足则整轮失败
  globalSetup: './e2e/helpers/c2-target-guard.ts',
  reporter: 'list',
  retries: 0,
  testDir: './e2e',
  testMatch: [
    '**/ai-diagnosis-real-backend.spec.ts',
    '**/ai-conversation-admin-real-backend.spec.ts',
  ],
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
    env: {
      DEV_API_PROXY_TARGET: backendTarget,
      ...(c2.kind === 'enabled' ? { VITE_GRAPHQL_ENDPOINT: C2_GRAPHQL_PATH } : {}),
    },
    // C2 由 Playwright 独占启动前端，保证健康和业务代理采用同一配置。
    reuseExistingServer: c2.kind !== 'enabled',
    timeout: 60_000,
    url: `http://127.0.0.1:${frontendPort}`,
  },
});

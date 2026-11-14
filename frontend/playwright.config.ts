// playwright.config.ts

import { defineConfig } from '@playwright/test';

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  reporter: 'list',
  retries: 0,
  testDir: './e2e',
  // 默认入口只跑 mock-only：不连真实后端、不写共享开发库 lithography_drill。
  // - helpers/ 是共享工具（含 vitest 单测，如 real-backend 白名单 helper），不是 Playwright 用例；
  // - 下列真实/写库 spec 一律由专用隔离入口收集（playwright.real-backend-dedicated.config.ts，
  //   固定 lithography_e2e + 专用 3100/4174），普通入口不启动真实后端也不继承清理授权。
  //   repair-request-create.spec.ts 已拆为 mock-only（本入口收集）与
  //   repair-request-create-real.spec.ts（专用入口收集）两个文件，真实写入用例不再混在默认入口；
  // - engineer-repair-request-real.spec.ts 有独立专用入口，同样不在普通入口收集。
  testIgnore: [
    '**/helpers/**',
    '**/engineer-repair-request-real.spec.ts',
    '**/admin-document-database-real.spec.ts',
    '**/reference-document-real.spec.ts',
    '**/repair-request-manage-real.spec.ts',
    '**/repair-request-create-real.spec.ts',
  ],
  timeout: 20_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: 'http://127.0.0.1:4173',
  },
});

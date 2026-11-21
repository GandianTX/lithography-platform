// playwright.v44-visual.config.ts
//
// V44 原型对照专用入口（任务 05 · S4 / 独立验收 P2-2）。
//
// 为什么不放在默认入口：原型 HTML 是本机外部资料（gitignored，不入库），
// 默认 `npm run test:e2e` 是普通 mock 回归，既不应要求该文件存在，
// 也不应自动覆盖 `docs/plan` 下的历史证据。
//
// 用法：
//   AI_V44_PROTOTYPE_HTML=/abs/path/to/原型.html \
//   AI_V44_EVIDENCE_DIR=/abs/path/to/新证据目录 \
//   npm run test:e2e:v44-visual
//
// 预检失败（原型缺失 / 哈希不符 / 证据目录非空）会以非零退出码明确报错。

import { defineConfig } from '@playwright/test';

const DEV_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  reporter: 'list',
  retries: 0,
  testDir: './e2e-prototype',
  timeout: 120_000,
  use: {
    baseURL: DEV_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${DEV_PORT} --strictPort`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: DEV_URL,
  },
});

// playwright.credential-probe-users.config.ts
//
// 由用户管理正式配置派生的**真实失败探针**配置，只用于
// `verify:credential-artifact-isolation`。它保留正式配置的证据策略与隔离调用，
// 仅替换收集范围并移除真实 webServer/globalSetup；不连后端、不写数据库。
//
// 负对照：设置 CREDENTIAL_PROBE_SKIP_ISOLATION=1 会撤掉本探针的隔离
// （该开关只存在于探针配置，正式配置不识别它）。

import './e2e-real/credential-probes/probe-environment';

import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.admin-user-management-real.config';

if (process.env.CREDENTIAL_PROBE_SKIP_ISOLATION === '1') {
  delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
}

export default defineConfig({
  ...baseConfig,
  globalSetup: undefined,
  outputDir:
    process.env.CREDENTIAL_PROBE_OUTPUT_DIR?.trim() || './test-results/credential-probe-users',
  reporter: [['list']],
  testDir: './e2e-real/credential-probes',
  testMatch: ['**/credential-artifact.probe.spec.ts'],
  use: { ...baseConfig.use },
  webServer: undefined,
});

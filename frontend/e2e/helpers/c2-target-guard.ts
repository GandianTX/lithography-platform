// e2e/helpers/c2-target-guard.ts
// 任务05 C2 目标守卫（Playwright globalSetup）。
//
// 与 C2 用例共用 `resolveC2Target()` / `assertC2Runtime()`：
// - 未启用且无 C2 残留变量：直接放行（C2 用例自身 skip）；
// - 半启用（有 C2 变量但无 AI_E2E_C2=1）或启用后缺项：整轮失败，不产生任何业务请求；
// - 启用后核对浏览器 baseURL、同源代理实例标识与直连 uptime。

import type { FullConfig } from '@playwright/test';

import { assertC2Runtime, resolveC2Target } from './c2-target';

export default async function c2TargetGuard(config: FullConfig): Promise<void> {
  const resolution = resolveC2Target();
  if (resolution.kind === 'disabled') {
    return;
  }
  if (resolution.kind === 'invalid') {
    throw new Error(`[c2-target-guard] ${resolution.reason}`);
  }

  const baseURL = String(config.projects[0]?.use?.baseURL ?? '');
  const { browserHealth, directHealth } = await assertC2Runtime({ baseURL, resolution });

  process.stdout.write(
    `[c2-target-guard] ok baseURL=${baseURL} api=${resolution.backendUrl} ` +
      `uptime=${directHealth.uptimeSeconds}s tag=${String(browserHealth.instanceTag)} ` +
      `db=${resolution.target.databaseNameHash} dbInstance=${resolution.target.databaseInstanceHash} ` +
      `redis=${resolution.target.redisInstanceHash} providerPort=${resolution.target.providerPort}\n`,
  );
}

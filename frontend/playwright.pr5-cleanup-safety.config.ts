// playwright.pr5-cleanup-safety.config.ts
// PR5 清理安全集成组入口（Codex 结束报告复验计划 P2-2 / S3 §4.1）。
//
// 与既有真实联调配置（playwright.account-settings-real.config.ts）的关键差别：
// - **不引用** global-setup.ts：该 setup 会 TRUNCATE 全表并重跑 baseline Migration / Mock Seed，
//   会主动消除碰撞、旧残留与非本轮引用，正是本组要真实检验的对象。本组只做
//   环境门 + schema 只读检查 + 数据库执行锁（由 spec 的 beforeAll 承担）；
// - **不启动浏览器与 Web 服务**：本组只针对真实 MySQL 与隔离文件系统，不经过 HTTP/UI；
// - testMatch 只收集清理安全 spec，绝不并入普通 unit 或默认无授权 E2E；
// - workers: 1（串行，避免与本组自身的执行锁与反例造数交叉）。
//
// 运行入口（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 DB_NAME=lithography_e2e npm run test:e2e:pr5-cleanup-safety
import { defineConfig } from '@playwright/test';

import { DEDICATED_E2E_DB_NAME } from './e2e-real/dedicated-e2e-environment';

/**
 * 目标库注入（与专用真实联调同口径）：外部**未设置**时写入专用库；外部已设置且与专用库
 * 冲突则硬失败，不做静默覆盖——避免操作者「以为打到了别的库」而实际落在专用库，
 * 也避免 assertPr5CleanupSafetyEnvironment 的 DB_NAME 维度守卫被静默绕过。
 */
function injectDedicatedDbNameOrThrow(): void {
  const inherited = process.env.DB_NAME?.trim();

  if (inherited !== undefined && inherited !== '' && inherited !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `PR5 清理安全集成组拒绝启动：环境变量 DB_NAME 已被外部设置为非专用库 ` +
        `（当前 ${JSON.stringify(inherited)}，期望 ${JSON.stringify(DEDICATED_E2E_DB_NAME)}）；` +
        '请移除该变量后重试，或将其改为专用库',
    );
  }

  process.env.DB_NAME = DEDICATED_E2E_DB_NAME;
}

injectDedicatedDbNameOrThrow();

export default defineConfig({
  fullyParallel: false,
  outputDir: './test-results/pr5-cleanup-safety',
  reporter: [['list']],
  retries: 0,
  testDir: './e2e-real',
  testMatch: ['**/pr5-cleanup-safety.spec.ts'],
  timeout: 120_000,
  workers: 1,
});

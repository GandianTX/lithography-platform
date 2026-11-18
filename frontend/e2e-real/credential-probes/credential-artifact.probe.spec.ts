// e2e-real/credential-probes/credential-artifact.probe.spec.ts
//
// 真实失败探针：只用于证明凭据专用 runner 的失败附件隔离实际生效。
//
// 本规格**刻意失败**，不得进入默认/综合收集：
// - 默认 playwright.config.ts 的 testDir 是 ./e2e；
// - 两个正式专用配置的 testMatch 各自只匹配一个业务规格；
// - vitest.config.ts 的 include 是白名单。
//
// 哨兵由运行时拼出（或由验证脚本经 env 注入），源码、标题和断言文本都不含完整值。
// 页面渲染只读输入框，模拟凭据弹窗里的 readonly 口令框；随后强制断言失败，
// 让 Playwright 走真实的 error-context 生成路径。

import { expect, test } from '@playwright/test';

test('失败附件不得写入只读凭据框哨兵', async ({ page }) => {
  const sentinel =
    process.env.CREDENTIAL_PROBE_SENTINEL?.trim() ||
    ['NONSECRET', 'PROBE', Date.now().toString(36), Math.random().toString(36).slice(2)].join('_');

  await page.setContent(`
    <main>
      <div role="dialog" aria-label="凭据弹窗">
        <label for="credential-probe-password">临时密码</label>
        <input id="credential-probe-password" readonly value="${sentinel}" />
      </div>
    </main>
  `);

  await expect(page.locator('#credential-probe-password')).toHaveValue(sentinel);

  // 刻意失败：验证失败附件路径本身，而不是业务断言
  expect(true).toBe(false);
});

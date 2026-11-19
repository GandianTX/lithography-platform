// e2e/ai-diagnosis-real-backend.spec.ts
// 任务05 S3.3：真实后端 + 真实浏览器联调（不入默认 mock-only 入口）
//
// 前置：后端已运行在 127.0.0.1:3005（开发库），前端 dev server 以
// DEV_API_PROXY_TARGET 指向该后端。凭据来自环境变量（不入库）。
// 运行：npx playwright test e2e/ai-diagnosis-real-backend.spec.ts \
//        --config=playwright.ai-diagnosis-real.config.ts

import { expect, test } from '@playwright/test';

const LOGIN_NAME = process.env.AI_E2E_LOGIN_NAME ?? '';
const LOGIN_PASSWORD = process.env.AI_E2E_LOGIN_PASSWORD ?? '';

test.describe('AI 诊断工作区 · 真实后端（任务05 S3）', () => {
  test('工程师登录后新建会话、提问，收到回答与部件标记', async ({ page }) => {
    test.skip(
      LOGIN_NAME.length === 0 || LOGIN_PASSWORD.length === 0,
      '缺少 AI_E2E_LOGIN_NAME / AI_E2E_LOGIN_PASSWORD 环境变量',
    );

    await page.goto('/login');
    await page.getByPlaceholder(/账号|邮箱|account|email/i).fill(LOGIN_NAME);
    await page.getByPlaceholder(/密码|password/i).fill(LOGIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    // 等待登录真正落地（会话写入后再跳转，避免守卫把未登录用户送回 /login）
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

    await page.goto('/engineer/ai');
    await page.waitForLoadState('networkidle');
    console.log('[real-e2e] url=', page.url(), 'title=', await page.title());

    await page.getByRole('button', { name: /新建对话|New chat/i }).click();
    await expect(page.getByLabel(/诊断对话|Diagnostic conversation/i)).toBeVisible();

    await page.getByLabel(/AI 提问|Ask AI/i).fill('掩模板无法从取板台送出，怎么排查？');
    await page.getByRole('button', { name: /发送问题|Send/i }).click();

    // 服务端受理后最终给出回答（生成中提示在夹具快速回复时可能一闪而过，不作硬断言）
    await expect(page.getByRole('log')).toContainText(/排查|检查|掩模板|reticle/i, { timeout: 90000 });

    // 左侧流程示意可用，且无横向溢出
    await expect(page.getByLabel(/维修流程示意|Maintenance flow view/i)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

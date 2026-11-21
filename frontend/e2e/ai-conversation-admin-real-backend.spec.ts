// e2e/ai-conversation-admin-real-backend.spec.ts
// 任务05 S5-F6：管理员只读与授权导出的「真实后端」联通用例（与 mock-only 入口隔离）。
//
// 前置：后端运行在 AI_E2E_BACKEND_URL（默认 127.0.0.1:3005），前端 dev server 由
// playwright.ai-diagnosis-real.config.ts 以 DEV_API_PROXY_TARGET 指向该后端。
// 凭据只来自环境变量，缺失时自动 skip。

import { expect, test } from '@playwright/test';

const ADMIN_LOGIN = process.env.AI_E2E_ADMIN_LOGIN_NAME ?? '';
const ADMIN_PASSWORD = process.env.AI_E2E_ADMIN_LOGIN_PASSWORD ?? '';
const skipReason = '缺少 AI_E2E_ADMIN_LOGIN_NAME / AI_E2E_ADMIN_LOGIN_PASSWORD 环境变量';

test.describe('AI 会话记录 · 真实后端（任务05 S5-F6）', () => {
  test.skip(ADMIN_LOGIN.length === 0 || ADMIN_PASSWORD.length === 0, skipReason);

  test('二级管理员：本公司会话可见、只读问答可打开、授权导出产出 PDF', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder(/账号|邮箱|account|email/i).fill(ADMIN_LOGIN);
    await page.getByPlaceholder(/密码|password/i).fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

    await page.goto('/admin/ai-conversations');
    await page.waitForLoadState('networkidle');

    // 入口可达且为本公司数据（二级管理员页面，非一级专属的文档库）
    await expect(page.getByRole('heading', { name: /AI 会话记录/ })).toBeVisible();
    const rows = page.locator('tbody tr');
    await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0);

    // 只读问答弹层：打开后应渲染逐轮问答，且不给编辑入口
    await page.getByRole('button', { name: '查看问答' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/会话问答（只读）/);
    await expect
      .poll(async () => (await dialog.innerText()).length, { timeout: 30_000 })
      .toBeGreaterThan(50);
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // 授权导出：按列表记录的固定版本产出 PDF，并在界面给出提示
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: '导出 PDF' }).first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^ai-conversation-\d+-v\d+\.pdf$/);
    await expect(page.locator('main')).toContainText(/已导出.*内容版本 v\d+/);

    // 三视口基线中的桌面宽度下不出现横向溢出
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

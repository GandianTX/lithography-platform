// e2e/ai-diagnosis-real-backend.spec.ts
// 任务05 S3.3：真实后端 + 真实浏览器联调（不入默认 mock-only 入口）
//
// 前置：后端已运行在 127.0.0.1:3005（开发库），前端 dev server 以
// DEV_API_PROXY_TARGET 指向该后端。凭据来自环境变量（不入库）。
// 运行：npx playwright test e2e/ai-diagnosis-real-backend.spec.ts \
//        --config=playwright.ai-diagnosis-real.config.ts

import { expect, type Page,test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const LOGIN_NAME = process.env.AI_E2E_LOGIN_NAME ?? '';
const LOGIN_PASSWORD = process.env.AI_E2E_LOGIN_PASSWORD ?? '';
const MYSQL_CNF = process.env.AI_E2E_MYSQL_CNF ?? '';
const MYSQL_DB = process.env.AI_E2E_DB ?? '';

async function loginAsEngineer(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder(/账号|邮箱|account|email/i).fill(LOGIN_NAME);
  await page.getByPlaceholder(/密码|password/i).fill(LOGIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

/** 把指定轮次改成失败（真实库夹具），用于在浏览器里走正式「重试本轮」入口 */
function markTurnFailed(questionUuid: string) {
  const sql = [
    `SET @q := '${questionUuid}';`,
    `SET @a := (SELECT answer_message_id FROM ai_message_analysis WHERE question_uuid = @q);`,
    `UPDATE ai_message_analysis SET status='FAILED', failure_reason='fixture-c2', completed_at=NOW(3), answer_message_id=NULL WHERE question_uuid=@q;`,
    `DELETE FROM ai_message WHERE id = @a;`,
    `UPDATE ai_workflow_context SET status='FAILED', error_code='fixture_c2', updated_at=NOW(3) WHERE biz_sub_key=@q;`,
  ].join(' ');
  execFileSync('mysql', [`--defaults-file=${MYSQL_CNF}`, '-D', MYSQL_DB, '-e', sql], {
    stdio: 'inherit',
  });
}

test.describe('AI 诊断工作区 · 真实后端（任务05 S3）', () => {
  test('工程师登录后新建会话、提问，收到回答与部件标记', async ({ page }) => {
    test.skip(
      LOGIN_NAME.length === 0 || LOGIN_PASSWORD.length === 0,
      '缺少 AI_E2E_LOGIN_NAME / AI_E2E_LOGIN_PASSWORD 环境变量',
    );

    await loginAsEngineer(page);

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

  test('C2：早轮失败后点重试，沿用原问题 UUID 且最终成功', async ({ page }) => {
    test.skip(MYSQL_CNF.length === 0 || MYSQL_DB.length === 0, '缺少 AI_E2E_MYSQL_CNF / AI_E2E_DB');

    await loginAsEngineer(page);
    await page.goto('/engineer/ai');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /新建对话|New chat/i }).click();

    let questionUuid = '';
    page.on('response', async (response) => {
      if (!response.url().includes('/graphql')) return;
      const post = response.request().postData() ?? '';
      if (!post.includes('submitAiQuestion')) return;
      const body = (await response.json().catch(() => null)) as {
        data?: { submitAiQuestion?: { questionUuid?: string } };
      } | null;
      questionUuid = body?.data?.submitAiQuestion?.questionUuid ?? '';
    });

    await page.getByLabel(/AI 提问|Ask AI/i).fill('C2 失败轮次重试用例');
    await page.getByRole('button', { name: /发送问题|Send/i }).click();
    await expect(page.getByRole('log')).toContainText(/已保存|已收到问题/i, { timeout: 90_000 });
    await expect.poll(() => questionUuid, { timeout: 10_000 }).not.toBe('');

    // 真实库夹具：把该轮改成失败（等价于模型两次失败后的终态），再走正式重试入口
    markTurnFailed(questionUuid);

    await page.reload();
    await page.getByRole('button', { name: /历史会话|History/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button')
      .filter({ hasText: '#' })
      .first()
      .click();

    const retry = page.getByRole('button', { name: /重试本轮|Retry/i }).first();
    await expect(retry).toBeVisible({ timeout: 30_000 });

    const retryBodies: string[] = [];
    page.on('request', (request) => {
      const post = request.postData();
      if (post !== null && post.includes('retryAiQuestion')) retryBodies.push(post);
    });

    await retry.click();
    await expect.poll(() => retryBodies.join('\n'), { timeout: 30_000 }).toContain(questionUuid);
    await expect(page.getByRole('log')).toContainText(/已保存/i, { timeout: 90_000 });
    await expect(page.getByRole('button', { name: /重试本轮|Retry/i })).toHaveCount(0, {
      timeout: 90_000,
    });
  });

  test('C4：旧轮状态响应迟到时不覆盖新会话画面', async ({ page }) => {
    await loginAsEngineer(page);
    await page.goto('/engineer/ai');
    await page.waitForLoadState('networkidle');

    // 只延迟状态查询响应，模拟旧轮图形/状态迟到；真实受理链路不变
    await page.route('**/graphql', async (route) => {
      const post = route.request().postData() ?? '';
      if (post.includes('aiQuestionStatus')) {
        await new Promise((resolve) => setTimeout(resolve, 3500));
      }
      return route.fallback();
    });

    await page.getByRole('button', { name: /新建对话|New chat/i }).click();
    await page.getByLabel(/AI 提问|Ask AI/i).fill('C4 旧轮迟到响应用例');
    await page.getByRole('button', { name: /发送问题|Send/i }).click();
    await expect(page.getByRole('log')).toContainText(/已收到问题|已保存/i, { timeout: 60_000 });

    // 旧轮状态仍在路上时切到新会话
    await page.getByRole('button', { name: /新建对话|New chat/i }).click();
    const log = page.getByRole('log');
    await expect(log).toContainText(/暂无数据|还没有提问/i, { timeout: 15_000 });
    await expect(log).not.toContainText('C4 旧轮迟到响应用例');

    // 迟到的旧响应返回后，新会话画面不被回填
    await page.waitForTimeout(5000);
    await expect(log).not.toContainText('C4 旧轮迟到响应用例');
    await expect(log).toContainText(/暂无数据|还没有提问/i);
  });
});

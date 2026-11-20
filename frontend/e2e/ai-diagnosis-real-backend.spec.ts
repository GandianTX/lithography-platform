// e2e/ai-diagnosis-real-backend.spec.ts
// 任务05 S3.3：真实后端 + 真实浏览器联调（不入默认 mock-only 入口）
//
// 前置：后端由隔离启动器启动，前端 dev server 以 DEV_API_PROXY_TARGET 指向该后端。
// 凭据与 C2 夹具标识只从环境变量读取，不入库。
// 运行：npx playwright test e2e/ai-diagnosis-real-backend.spec.ts \
//        --config=playwright.ai-diagnosis-real.config.ts
//
// C2 的早轮失败由 loopback 故障 provider 通过正式模型调用路径产生：
// 浏览器进程不持有数据库写权限，测试也不直接改 analysis / workflow 状态。

import { expect, type Page,test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { assertC2Runtime, resolveC2Target } from './helpers/c2-target';

const LOGIN_NAME = process.env.AI_E2E_LOGIN_NAME ?? '';
const LOGIN_PASSWORD = process.env.AI_E2E_LOGIN_PASSWORD ?? '';
const AUTH_SESSION_KEY = 'lithography-platform.auth-session.v1';
const FIXTURE_REPLY_MARK = 'C2 故障夹具回复';

interface ConversationTurn {
  readonly analysisStatus: string;
  readonly answer: { readonly text: string } | null;
  readonly failureReason: string | null;
  readonly question: { readonly text: string } | null;
  readonly questionUuid: string;
  readonly turnNo: number | null;
}

interface ConversationDetail {
  readonly contentVersion: number;
  readonly id: number;
  readonly turns: ConversationTurn[];
}

interface ConversationDetailResponse {
  readonly data?: { readonly myAiConversation?: ConversationDetail };
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
}

async function loginAsEngineer(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder(/账号|邮箱|account|email/i).fill(LOGIN_NAME);
  await page.getByPlaceholder(/密码|password/i).fill(LOGIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

/** 用应用自身的会话凭证走正式 GraphQL 查询，读回会话真实状态 */
async function readConversation(page: Page, conversationId: number): Promise<ConversationDetail> {
  const response = await page.evaluate(
    async ({ id, key }) => {
      const stored = sessionStorage.getItem(key);
      const token = stored === null ? '' : (JSON.parse(stored) as { accessToken?: string }).accessToken;
      const result = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          query:
            'query($input: AiConversationIdInput!){ myAiConversation(input:$input){ id contentVersion turns { ' +
            'questionUuid turnNo analysisStatus failureReason question { text } answer { text } } } }',
          variables: { input: { conversationId: id } },
        }),
      });
      return (await result.json()) as ConversationDetailResponse;
    },
    { id: conversationId, key: AUTH_SESSION_KEY },
  );

  const detail = response.data?.myAiConversation;
  if (!detail) {
    throw new Error(`读取会话 ${conversationId} 失败：${JSON.stringify(response.errors ?? [])}`);
  }
  return detail;
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

  test('C2：早轮正式失败、末轮成功，重试沿用原 UUID 并成功', async ({ page }) => {
    const resolution = resolveC2Target();
    if (resolution.kind === 'invalid') {
      throw new Error(`[c2] ${resolution.reason}`);
    }
    test.skip(resolution.kind === 'disabled', '未启用 C2（未提供任何 C2 专有变量）');
    if (resolution.kind !== 'enabled') {
      return;
    }

    // 登录前核验：即使误用其他 Playwright 配置单独收集本 spec，也不能仅凭故障变量进入登录
    await assertC2Runtime({
      baseURL: String(test.info().project.use.baseURL ?? ''),
      resolution,
    });

    await loginAsEngineer(page);
    await page.goto('/engineer/ai');
    await page.waitForLoadState('networkidle');

    let conversationId = 0;
    const submitUuids: string[] = [];
    page.on('response', async (response) => {
      if (!response.url().includes('/graphql')) return;
      const post = response.request().postData() ?? '';
      const body = (await response.json().catch(() => null)) as {
        data?: {
          createAiConversation?: { id?: number };
          submitAiQuestion?: { questionUuid?: string };
        };
      } | null;
      if (post.includes('createAiConversation') && body?.data?.createAiConversation?.id) {
        conversationId = Number(body.data.createAiConversation.id);
      }
      const submitted = body?.data?.submitAiQuestion?.questionUuid;
      if (post.includes('submitAiQuestion') && submitted) {
        submitUuids.push(submitted);
      }
    });

    await page.getByRole('button', { name: /新建对话|New chat/i }).click();
    await expect.poll(() => conversationId, { timeout: 30_000 }).toBeGreaterThan(0);

    // 第 1 问：故障 provider 对该问题稳定失败，Worker 走完正式重试后落 FAILED
    const failQuestion = `${resolution.failToken} 第一问：取板台真空报警时如何排查？`;
    await page.getByLabel(/AI 提问|Ask AI/i).fill(failQuestion);
    await page.getByRole('button', { name: /发送问题|Send/i }).click();
    await expect.poll(() => submitUuids.length, { timeout: 30_000 }).toBe(1);
    const firstUuid = submitUuids[0];

    const firstTurn = page.getByRole('log').locator('article').filter({ hasText: resolution.failToken });
    // 重试入口只在「正式 FAILED 且无回答」时出现，等价于等待正式失败落库
    await expect(firstTurn.getByRole('button')).toBeVisible({ timeout: 120_000 });

    // 第 2 问：同一会话成功，用于验证末轮状态不被早轮重试破坏
    const okQuestion = `${resolution.okTag} 第二问：定位激光异常时如何确认状态？`;
    await page.getByLabel(/AI 提问|Ask AI/i).fill(okQuestion);
    await page.getByRole('button', { name: /发送问题|Send/i }).click();
    await expect.poll(() => submitUuids.length, { timeout: 30_000 }).toBe(2);
    const secondUuid = submitUuids[1];
    expect(secondUuid).not.toBe(firstUuid);

    const secondTurn = page.getByRole('log').locator('article').filter({ hasText: resolution.okTag });
    await expect(secondTurn).toContainText(FIXTURE_REPLY_MARK, { timeout: 120_000 });

    const beforeRetry = await readConversation(page, conversationId);
    expect(beforeRetry.turns).toHaveLength(2);
    expect(beforeRetry.turns[0].questionUuid).toBe(firstUuid);
    expect(beforeRetry.turns[0].analysisStatus).toBe('FAILED');
    expect(beforeRetry.turns[1].questionUuid).toBe(secondUuid);
    expect(beforeRetry.turns[1].analysisStatus).toBe('SUCCEEDED');

    // 刷新后按本轮会话 ID 精确选中（不依赖「最近一条」）
    await page.reload();
    await page.getByRole('button', { name: /历史会话|History/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(`#${conversationId}\\b`) })
      .click();
    await expect(page.getByRole('log').locator('article')).toHaveCount(2, { timeout: 30_000 });

    const selectedFirstTurn = page
      .getByRole('log')
      .locator('article')
      .filter({ hasText: resolution.failToken });
    await expect(selectedFirstTurn.getByRole('button')).toBeVisible({ timeout: 30_000 });

    const beforeResume = await readConversation(page, conversationId);

    const retryBodies: string[] = [];
    const submitBodiesAfterRetry: string[] = [];
    page.on('request', (request) => {
      const post = request.postData();
      if (post === null) return;
      if (post.includes('retryAiQuestion')) retryBodies.push(post);
      if (post.includes('submitAiQuestion')) submitBodiesAfterRetry.push(post);
    });

    // 放行该问题的故障后再触发正式重试：新执行走正式模型路径成功
    const releaseResponse = await fetch(`${resolution.controlUrl}/__control/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resolution.failToken }),
    });
    expect(releaseResponse.ok).toBe(true);

    await selectedFirstTurn.getByRole('button').click();
    await expect.poll(() => retryBodies.join('\n'), { timeout: 30_000 }).toContain(firstUuid);
    expect(retryBodies.join('\n')).toContain(`"conversationId":${conversationId}`);
    expect(submitBodiesAfterRetry).toHaveLength(0);

    await expect(selectedFirstTurn).toContainText(FIXTURE_REPLY_MARK, { timeout: 120_000 });

    const afterResume = await readConversation(page, conversationId);
    expect(afterResume.turns.map((turn) => turn.questionUuid)).toEqual([firstUuid, secondUuid]);
    expect(afterResume.turns[0].analysisStatus).toBe('SUCCEEDED');
    expect(afterResume.turns[0].answer?.text).toContain(FIXTURE_REPLY_MARK);
    expect(afterResume.turns[1].analysisStatus).toBe('SUCCEEDED');
    expect(afterResume.turns[1].answer?.text).toBe(beforeRetry.turns[1].answer?.text);

    // 第 1 问容器内只应有「问题 + 一条新回答」
    await expect(selectedFirstTurn.locator('p')).toHaveCount(2);

    const statesPath = test.info().outputPath('c2-turn-states.json');
    const statesBody = JSON.stringify(
      {
        afterResume,
        beforeResume,
        beforeRetry,
        conversationId,
        firstUuid,
        secondUuid,
      },
      null,
      2,
    );
    writeFileSync(statesPath, statesBody);
    await test.info().attach('c2-turn-states.json', {
      contentType: 'application/json',
      path: statesPath,
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
    // 真实入口的回复由本轮 provider 返回，按回复正文判定「已产生回答」
    await expect(page.getByRole('log')).toContainText(/已处理问题|已保存/i, { timeout: 60_000 });

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

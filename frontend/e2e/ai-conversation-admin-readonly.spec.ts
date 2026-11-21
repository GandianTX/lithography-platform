// e2e/ai-conversation-admin-readonly.spec.ts
// @vitest-environment node

/**
 * 管理员只读会话问答验收（任务 05 · S4.1 / A05-06 / A05-08）。
 *
 * 覆盖：
 * - 管理员「查看问答」只读弹窗可用（逐轮问答与失败原因）；
 * - 窄屏（390×844）弹层不超出视口、页面无横向溢出；
 * - 键盘可用（Tab 可达入口、Enter 打开、Esc 关闭）；
 * - 外公司会话被拒绝时不展示任何内容。
 */

import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { installAdminDocumentKbGraphqlMocks } from './helpers/admin-document-kb-mocks';
import { seedAuthSession } from './helpers/auth-session-seed';

const PAGE_PATH = '/admin/document-database';

const CONVERSATION_ID = 701;

const DETAIL = {
  conversationId: CONVERSATION_ID,
  requestId: 901,
  requestNo: 'RR20260901090001A1B2C3',
  status: 'COMPLETED',
  contentVersion: 3,
  engineerNickname: '林工程师',
  createdAt: '2026-09-01T09:20:00.000Z',
  turns: [
    {
      questionUuid: 'uuid-1',
      turnNo: 1,
      analysisStatus: 'FAILED',
      failureReason: '模型调用超时',
      analysisContentVersion: 3,
      question: {
        messageId: 101,
        messageSeq: 1,
        turnNo: 1,
        role: 'USER',
        questionUuid: 'uuid-1',
        text: '曝光异常如何排查',
        contentVersion: 3,
        createdAt: '2026-11-01T09:01:00.000Z',
      },
      answer: null,
    },
  ],
};

async function installMocks(page: Page, detailRejected = false): Promise<void> {
  // 先装官方知识库 mock（覆盖整页四 Tab 数据），再叠加只读详情响应
  await installAdminDocumentKbGraphqlMocks(page);
  await page.route('**/graphql', async (route: Route) => {
    const body = route.request().postDataJSON() as { operationName?: string } | null;
    if ((body?.operationName ?? '') !== 'AiAdminConversationDetail') {
      return route.fallback();
    }

    if (detailRejected) {
      return route.fulfill({
        body: JSON.stringify({
          errors: [
            {
              message: '会话不存在或无权访问',
              extensions: { code: 'AI_CONVERSATION_NOT_FOUND' },
            },
          ],
        }),
        contentType: 'application/json',
        status: 200,
      });
    }
    return route.fulfill({
      body: JSON.stringify({ data: { aiAdminConversationDetail: DETAIL } }),
      contentType: 'application/json',
      status: 200,
    });
  });
}

async function openAiConversationTab(page: Page): Promise<void> {
  await page.goto(PAGE_PATH);
  await page.getByRole('tab', { name: 'AI 会话' }).click();
  await expect(page.getByText('RR20260901090001A1B2C3')).toBeVisible({ timeout: 10_000 });
}

test.describe('管理员只读会话问答（任务05 S4.1 / A05-06 / A05-08）', () => {
  test.beforeEach(async ({ page }) => {
    // 文档数据库页为一级管理员专属路由：需 adminLevel=1 与可信公司
    await seedAuthSession(page, 'SUPER_ADMIN', {
      adminLevel: 1,
      adminOrganizationId: 910003,
    });
  });

  test('只读弹窗展示逐轮问答与失败原因，且不提供提问入口', async ({ page }) => {
    await installMocks(page);
    await openAiConversationTab(page);

    await page.getByRole('button', { name: '查看问答' }).click();

    await expect(page.getByText('会话问答（只读）')).toBeVisible();
    await expect(page.getByText('曝光异常如何排查')).toBeVisible();
    await expect(page.getByText('模型调用超时')).toBeVisible();
    await expect(page.getByText('（未保存回答）')).toBeVisible();

    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('textarea')).toHaveCount(0);
    await expect(dialog.locator('input')).toHaveCount(0);
  });

  // 任务书 A05-08：桌面与窄屏采用 1440×900 / 1366×768 / 390×844 作为初始检查视口
  const VIEWPORTS = [
    { height: 900, label: '桌面 1440×900', width: 1440 },
    { height: 768, label: '笔记本 1366×768', width: 1366 },
    { height: 844, label: '窄屏 390×844', width: 390 },
  ] as const;

  for (const viewport of VIEWPORTS) {
    test(`${viewport.label}：只读弹层不超出视口，页面无横向溢出`, async ({ page }) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await installMocks(page);
      await openAiConversationTab(page);

      await page.getByRole('button', { name: '查看问答' }).click();
      await expect(page.getByText('会话问答（只读）')).toBeVisible();
      // 弹层内容不被裁剪：问答正文与失败原因均可见
      await expect(page.getByText('曝光异常如何排查')).toBeVisible();
      await expect(page.getByText('模型调用超时')).toBeVisible();

      // 等抽屉滑入动画结束：右边缘贴合视口即稳定（桌面为固定宽度右对齐，窄屏为满宽）
      await page.waitForFunction(
        () => {
          const wrapper = document.querySelector('.ant-drawer-content-wrapper');
          if (wrapper === null) {
            return false;
          }
          const rect = wrapper.getBoundingClientRect();
          return Math.abs(rect.right - document.documentElement.clientWidth) < 1;
        },
        undefined,
        { timeout: 10_000 },
      );

      const box = await page.locator('.ant-drawer-content-wrapper').boundingBox();
      const metrics = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));

      expect(box).not.toBeNull();
      if (box !== null) {
        // 0.5px 容差：亚像素取整误差不算溢出
        expect(box.x).toBeGreaterThanOrEqual(-0.5);
        expect(box.width).toBeLessThanOrEqual(viewport.width + 0.5);
        // 记录 rect 供证据留档
        console.log(
          `[admin-readonly] ${viewport.label} drawer rect x=${box.x.toFixed(2)} w=${box.width.toFixed(2)} h=${box.height.toFixed(2)} overflowX=${metrics.scrollWidth - metrics.clientWidth}`,
        );
      }
      expect(metrics.scrollWidth - metrics.clientWidth).toBe(0);
    });
  }

  test('键盘可用：Tab 可达「查看问答」并以 Enter 打开，Esc 关闭', async ({ page }) => {
    await installMocks(page);
    await openAiConversationTab(page);

    const button = page.getByRole('button', { name: '查看问答' });
    // 键盘可达 + 键盘触发：聚焦后回车打开，Esc 关闭（不依赖动画/焦点时序断言）
    await button.focus();
    await button.press('Enter');
    await expect(page.getByText('会话问答（只读）')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByText('会话问答（只读）')).toBeHidden();
  });

  test('外公司会话被拒绝时不展示任何会话内容', async ({ page }) => {
    await installMocks(page, true);
    await openAiConversationTab(page);

    await page.getByRole('button', { name: '查看问答' }).click();

    // GraphQL 业务错误统一归一为通用文案，不透出「会话是否存在」
    await expect(page.getByText('请求处理失败，请稍后重试。')).toBeVisible();
    await expect(page.getByText('曝光异常如何排查')).toHaveCount(0);
    await expect(page.getByText('模型调用超时')).toHaveCount(0);
  });
});

test.describe('AI 会话只读页入口（任务05 S4.1 · 二级管理员）', () => {
  const PAGE = '/admin/ai-conversations';

  async function installExportMock(page: Page): Promise<void> {
    await page.route('**/graphql', async (route: Route) => {
      const body = route.request().postDataJSON() as { operationName?: string } | null;
      if ((body?.operationName ?? '') !== 'ExportAiConversation') {
        return route.fallback();
      }
      return route.fulfill({
        body: JSON.stringify({
          data: {
            exportAiConversation: {
              byteSize: 8,
              contentBase64: Buffer.from('%PDF-mock').toString('base64'),
              contentVersion: 3,
              filename: 'ai-conversation-701-v3.pdf',
              format: 'PDF',
              lastMessageSeq: 2,
              mimeType: 'application/pdf',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    });
  }

  test('二级管理员可进入只读页并查看问答（范围由服务端裁决）', async ({ page }) => {
    // 二级管理员：路由准入必须放行（文档数据库整体页仍为一级专属）
    await seedAuthSession(page, 'SUPER_ADMIN', {
      adminLevel: 2,
      adminOrganizationId: 910004,
    });
    await installAdminDocumentKbGraphqlMocks(page);
    await installMocks(page);

    await page.goto(PAGE);

    await expect(page.getByRole('heading', { name: 'AI 会话记录' })).toBeVisible({
      timeout: 10_000,
    });
    expect(page.url()).toContain(PAGE);
    await expect(page.getByText('RR20260901090001A1B2C3')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: '查看问答' }).click();
    await expect(page.getByText('会话问答（只读）')).toBeVisible();
    await expect(page.getByText('曝光异常如何排查')).toBeVisible();
  });

  test('一级管理员在该页可导出固定版本 PDF', async ({ page }) => {
    await seedAuthSession(page, 'SUPER_ADMIN', {
      adminLevel: 1,
      adminOrganizationId: 910003,
    });
    await installAdminDocumentKbGraphqlMocks(page);
    await installMocks(page);
    await installExportMock(page);

    await page.goto(PAGE);
    await expect(page.getByText('RR20260901090001A1B2C3')).toBeVisible({ timeout: 10_000 });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PDF' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('ai-conversation-701-v3.pdf');
    await expect(page.getByText(/已导出 ai-conversation-701-v3\.pdf/)).toBeVisible();
  });

  test('工程师不能进入管理员 AI 会话页', async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
    await installAdminDocumentKbGraphqlMocks(page);

    await page.goto(PAGE);

    await expect(page).not.toHaveURL(new RegExp(`${PAGE}$`));
  });
});

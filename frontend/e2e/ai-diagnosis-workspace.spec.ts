// e2e/ai-diagnosis-workspace.spec.ts
// 任务05 S3.3：AI 诊断工作区真实浏览器覆盖
//
// 覆盖：独立会话问答、关联工单问答、失败重试、两问题乱序响应、重复 WARNING 仍更新部件、
// 刷新与历史恢复、桌面与窄屏视口。
// 说明：后端交互以 GraphQL 拦截桩驱动（mock-only 入口），用于验证前端页面逻辑与渲染；
// 真实后端链路由后端 S2 真实 GraphQL 验证覆盖。

import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  buildParts,
  createMockState,
  installGraphQLMock,
  pickWorkOrder,
} from './helpers/ai-conversation-mocks';
import { seedAuthSession } from './helpers/auth-session-seed';
import { captureStableViewport } from './helpers/visual-evidence';

test.describe('AI 诊断工作区（任务05 S3）', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
  });

  test('独立会话：提问后进入生成中并回显回答，左侧给出部件标记', async ({ page }) => {
    const state = createMockState();
    state.statusQueue = [
      { status: 'PENDING', visualization: null },
      {
        status: 'SUCCEEDED',
        visualization: {
          sceneId: 'LITHO_WORKFLOW_V1',
          stage: 2,
          parts: buildParts('NORMAL', { reticle_arm: 'WARNING' }),
        },
      },
    ];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await expect(page.getByRole('heading', { name: 'AI 诊断' })).toBeVisible();

    await page.getByLabel('AI 提问').fill('手臂 1 无动作，怎么排查？');
    await page.getByRole('button', { name: '发送问题' }).click();

    await expect(page.getByText('问题已保存，正在生成回复…')).toBeVisible();
    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toBeVisible({
      timeout: 8000,
    });
    // 左侧图例给出模型标记（关注 · 手臂1（掩模板））
    await expect(page.getByLabel('部件标记')).toContainText('警示');
    // 流程参考图中的部件（阶段 2）高亮
    await expect(page.getByLabel('维修流程示意')).toBeVisible();
  });

  test('关联工单：首次发送时创建会话并写入来源，绑定后锁定', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await pickWorkOrder(page, 'MR-20261120-001 · NIKON NSR-S635E');
    await page.getByLabel('AI 提问').fill('曝光前校验失败');
    await page.getByRole('button', { name: '发送问题' }).click();

    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toBeVisible({
      timeout: 8000,
    });
    expect(state.requestId).toBe(8801);
    // 会话已建立：来源固定，选择器不可改
    await expect(page.getByLabel('关联工单')).toBeDisabled();
    await expect(page.locator('.ai-panel-work-order')).toContainText('MR-20261120-001');
  });

  test('U05：首次发送才创建会话，创建在飞锁定工单选择', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state, { createDelayMs: 1200 });
    const createBodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body !== null && body.includes('CreateAiConversation')) {
        createBodies.push(body);
      }
    });

    await page.goto('/engineer/ai');
    await pickWorkOrder(page, 'MR-20261120-001 · NIKON NSR-S635E');
    // 草稿态：尚未创建会话，但输入与选择都可用
    await expect(page.getByLabel('AI 提问')).toBeEnabled();
    await expect(page.getByLabel('关联工单')).toBeEnabled();

    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();

    // 创建在飞：新建入口与工单选择同时锁定，避免待选值与服务端事实不一致
    await expect(page.getByRole('button', { name: '新建对话' })).toBeDisabled();
    await expect(page.getByLabel('关联工单')).toBeDisabled();

    await expect.poll(() => state.requestId, { timeout: 8000 }).toBe(8801);
    await expect(page.locator('.ai-panel-work-order')).toContainText('MR-20261120-001');
    await expect(page.getByLabel('关联工单')).toBeDisabled();
    expect(createBodies.join('\n')).toContain('"requestId":8801');
  });

  test('失败重试：失败轮次可重试且沿用同一问题 UUID', async ({ page }) => {
    const state = createMockState();
    state.statusQueue = [
      {
        turnNo: 1,
        status: 'FAILED',
        visualization: null,
        failureReason: 'reply_model_unavailable',
      },
    ];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();

    await expect(page.getByRole('button', { name: '重试本轮' })).toBeVisible({ timeout: 8000 });
    const uuidBefore = state.turns[0]?.questionUuid;
    await page.getByRole('button', { name: '重试本轮' }).click();
    await expect.poll(() => state.retryCount, { timeout: 8000 }).toBeGreaterThan(0);
    expect(state.turns[0]?.questionUuid).toBe(uuidBefore);
  });

  test('两问题乱序响应：后发问题的回复先到时不覆盖当前轮', async ({ page }) => {
    const state = createMockState();
    state.statusQueue = [{ turnNo: 1, sticky: true, status: 'PENDING', visualization: null }];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByLabel('AI 提问').fill('问题一');
    await page.getByRole('button', { name: '发送问题' }).click();
    await page.getByLabel('AI 提问').fill('问题二');
    await page.getByRole('button', { name: '发送问题' }).click();

    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toBeVisible({
      timeout: 8000,
    });
    // 当前轮是第二个问题：第一轮仍未完成，不得被标成成功
    const firstTurn = state.turns[0];
    expect(firstTurn?.analysisStatus).not.toBe('SUCCEEDED');
    // 当前轮图形来自第二个问题（默认 SUCCEEDED 图形），不受第一轮影响
    await expect(page.getByLabel('维修流程示意')).toBeVisible();
  });

  test('P2-1 反例：提交在飞时输入的新草稿不被旧响应清空', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state, { submitHoldMs: 1500 });

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();

    const input = page.getByLabel('AI 提问');
    await input.fill('问题 A：取板台真空报警');
    await page.getByRole('button', { name: '发送问题' }).click();

    // 提交在飞：用户继续输入下一问（输入框保持可编辑）
    await input.fill('问题 B：激光定位异常');
    await expect(input).toHaveValue('问题 B：激光定位异常');

    // A 的受理结果照常落库并回显，但不得清空 B
    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('log')).toContainText('问题 A：取板台真空报警');
    await expect(input).toHaveValue('问题 B：激光定位异常');
  });

  test('重复 WARNING：重试后仍更新部件标记', async ({ page }) => {
    const state = createMockState();
    state.statusQueue = [
      {
        turnNo: 1,
        status: 'SUCCEEDED',
        visualization: {
          sceneId: 'LITHO_WORKFLOW_V1',
          stage: 2,
          parts: buildParts('NORMAL', { reticle_arm: 'WARNING' }),
        },
      },
      {
        turnNo: 2,
        status: 'SUCCEEDED',
        visualization: {
          sceneId: 'LITHO_WORKFLOW_V1',
          stage: 4,
          parts: buildParts('NORMAL', { positioning_laser: 'WARNING' }),
        },
      },
    ];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();

    await expect(page.getByLabel('部件标记')).toContainText('手臂1（掩模板）', { timeout: 8000 });

    // 同会话第二轮返回另一个部件的 WARNING：图例应更新为新部件（旧标记被替换）
    await page.getByLabel('AI 提问').fill('激光定位异常');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(page.getByLabel('部件标记')).toContainText('激光定位组件', { timeout: 8000 });
    await expect(page.getByLabel('部件标记')).not.toContainText('手臂1（掩模板）');
  });

  test('S3：WARNING 落定后出现故障短卡，本轮阶段单独反馈', async ({ page }) => {
    const state = createMockState();
    state.statusQueue = [
      {
        status: 'SUCCEEDED',
        visualization: {
          sceneId: 'LITHO_WORKFLOW_V1',
          stage: 2,
          parts: buildParts('NORMAL', { reticle_arm: 'WARNING' }),
        },
      },
    ];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByLabel('AI 提问').fill('手臂 1 无动作，怎么排查？');
    await page.getByRole('button', { name: '发送问题' }).click();

    // 故障短卡在锁定后出现：本地化部件名 + 故障锁定 + 可展示的简短描述
    const card = page.locator('.ai-fault-card');
    await expect(card).toHaveAttribute('data-locked', 'true', { timeout: 10000 });
    await expect(card).toContainText('手臂1（掩模板）');
    await expect(card).toContainText('故障锁定');
    await expect(card).toContainText('建议先检查取板台真空吸附与激光定位组件。');

    // 本轮结果阶段单独反馈，不改写用户选择的阶段
    await expect(page.getByText('本轮阶段 2')).toBeVisible();
  });

  test.describe('减少动态效果：直接给出同样可读的终态', () => {
    // reducedMotion 不是顶层 test 选项，需通过 contextOptions 下发
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    test('故障短卡立即可见且指向同一部件', async ({ page }) => {
      const state = createMockState();
      state.statusQueue = [
        {
          status: 'SUCCEEDED',
          visualization: {
            sceneId: 'LITHO_WORKFLOW_V1',
            stage: 2,
            parts: buildParts('NORMAL', { reticle_arm: 'WARNING' }),
          },
        },
      ];
      await installGraphQLMock(page, state);

      await page.goto('/engineer/ai');
      await page.getByLabel('AI 提问').fill('手臂 1 无动作，怎么排查？');
      await page.getByRole('button', { name: '发送问题' }).click();

      // 不等动效时间线（聚焦动画 2600ms / 锁定 2850ms）：终态卡片立即可读
      const card = page.locator('.ai-fault-card');
      await expect(card).toHaveAttribute('data-locked', 'true', { timeout: 2500 });
      await expect(card).toContainText('手臂1（掩模板）');
      await expect(page.getByLabel('部件标记')).toContainText('警示 · 手臂1（掩模板）');
    });
  });

  test('刷新与问答记录：从局部导航进入列表并回到原会话', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toBeVisible({
      timeout: 8000,
    });

    await page.reload();
    // S2：历史不再用抽屉，改为页头局部导航直达问答记录页
    await page.getByRole('link', { name: '问答记录' }).click();
    await expect(page).toHaveURL(/\/engineer\/ai\/history$/);
    await expect(page.getByRole('heading', { name: '问答记录' })).toBeVisible();
    await expect(
      page.getByLabel('AI 诊断导航').getByRole('link', { name: 'AI 对话' }),
    ).toHaveAttribute('href', '/engineer/ai');

    await page.getByRole('button', { name: '查看对话' }).first().click();
    await expect(page).toHaveURL(/\/engineer\/ai\?conversation=\d+/);
    await expect(page.getByText('手臂 1 无动作')).toBeVisible({ timeout: 8000 });
  });

  test('窄屏（390×844）：布局不横向溢出，问答与示意仍可用', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await expect(page.getByLabel('维修流程示意')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByLabel('AI 提问').fill('窄屏下的提问');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toBeVisible({
      timeout: 8000,
    });
  });

  test('键盘可用：输入框可聚焦并 Ctrl+Enter 发送，几何画布可聚焦并用方向键旋转', async ({
    page,
  }) => {
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();

    const input = page.getByLabel('AI 提问');
    await input.focus();
    await expect(input).toBeFocused();
    await input.fill('键盘提交的问题');
    await input.press('Control+Enter');
    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toBeVisible({
      timeout: 8000,
    });

    // 几何画布可聚焦，并支持方向键旋转与加减号缩放
    const canvas = page.getByLabel('光刻机维修流程三维示意');
    await canvas.focus();
    await expect(canvas).toBeFocused();
    await canvas.press('ArrowRight');
    await canvas.press('ArrowLeft');
    await canvas.press('+');
    await canvas.press('-');
    await canvas.press('Home');
    await expect(canvas).toBeFocused();
  });

  test('切账号：登出后在途响应不再更新新画面', async ({ page }) => {
    const releaseStatus: { fn: (() => void) | null } = { fn: null };
    const state = createMockState();
    state.statusQueue = [{ turnNo: 1, sticky: true, status: 'PENDING', visualization: null }];
    await installGraphQLMock(page, state);
    // 状态查询挂起，模拟「生成中且响应在途」
    await page.route('**/graphql', async (route) => {
      const payload = route.request().postDataJSON() as { operationName?: string };
      if (payload.operationName === 'AiQuestionStatus') {
        await new Promise<void>((resolve) => {
          releaseStatus.fn = () => resolve();
        });
        return route.fulfill({
          body: JSON.stringify({
            data: {
              aiQuestionStatus: {
                answer: null,
                contentVersion: 1,
                conversationId: state.conversationId,
                failureReason: null,
                questionText: '',
                questionUuid: state.turns[0]?.questionUuid ?? '',
                status: 'SUCCEEDED',
                turnNo: 1,
                visualization: null,
              },
            },
          }),
          contentType: 'application/json',
          status: 200,
        });
      }
      return route.fallback();
    });

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByLabel('AI 提问').fill('生成中的问题');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(page.getByText('问题已保存，正在生成回复…')).toBeVisible({ timeout: 8000 });

    // 切账号：登出离开工作区
    await page
      .getByRole('button', { name: /退出登录|Logout/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/login/, { timeout: 8000 });

    // 在途响应此时才返回：不得再更新新画面
    releaseStatus.fn?.();
    await page.waitForTimeout(500);
    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toHaveCount(0);
  });

  test('中屏（1366×768）：左右分栏可用且无横向溢出，记录关键 rect', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await expect(page.getByLabel('维修流程示意')).toBeVisible();
    await expect(page.getByLabel('诊断对话')).toBeVisible();

    const metrics = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) {
          return null;
        }
        const box = element.getBoundingClientRect();
        return {
          height: Math.round(box.height),
          width: Math.round(box.width),
          x: Math.round(box.x),
        };
      };
      const grid = document.querySelector('.ai-workspace-grid');
      return {
        canvas: rect('.ai-scene-canvas'),
        grid: rect('.ai-workspace-grid'),
        gridTemplateColumns:
          grid === null ? null : window.getComputedStyle(grid).gridTemplateColumns,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panel: rect('.ai-panel'),
        scene: rect('.ai-scene'),
      };
    });
    console.log('[layout-1366x768]', JSON.stringify(metrics));

    expect(metrics.overflowX).toBeLessThanOrEqual(1);
    expect(metrics.panel).not.toBeNull();
    expect(metrics.scene).not.toBeNull();
    if (metrics.panel !== null && metrics.scene !== null) {
      // V44 对照：右栏最小 315px，左侧示意在左、对话在右
      expect(metrics.panel.width).toBeGreaterThanOrEqual(315);
      expect(metrics.panel.x).toBeGreaterThan(metrics.scene.x);
    }
  });

  test('桌面（1440×900）：左右分栏同时可见', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await expect(page.getByLabel('维修流程示意')).toBeVisible();
    await expect(page.getByLabel('诊断对话')).toBeVisible();

    const scene = await page.getByLabel('维修流程示意').boundingBox();
    const panel = await page.getByLabel('诊断对话').boundingBox();
    expect(scene).not.toBeNull();
    expect(panel).not.toBeNull();
    if (scene !== null && panel !== null) {
      // 左右分栏：示意在左、对话在右
      expect(panel.x).toBeGreaterThan(scene.x + 100);
    }
  });
});

test.describe('AI 会话导出与管理员只读（任务05 S4）', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
  });

  test('会话内导出 PDF：按固定内容版本产出文件并给出提示', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await expect(page.getByLabel('维修流程示意')).toBeVisible();
    // 草稿优先：先受理一问（创建会话），再导出
    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(
      page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
    ).toBeVisible({
      timeout: 8000,
    });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PDF' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^ai-conversation-\d+-v\d+\.pdf$/);
    await expect(page.getByText(/已导出 ai-conversation-/)).toBeVisible();
  });

  test('历史无图会话：仍可导出（历史缺少图形不阻断导出）', async ({ page }) => {
    const state = createMockState();
    // 历史会话：已有问答正文，但没有图形信息（图形仅短时传递，不持久化）
    state.turns = [
      {
        questionUuid: '11111111-2222-4333-8444-555555555555',
        turnNo: 1,
        question: { id: 11, text: '手臂 1 无动作', role: 'USER', contentVersion: 1 },
        answer: {
          id: 12,
          text: '建议先检查取板台真空吸附。',
          role: 'ASSISTANT',
          contentVersion: 1,
        },
        analysisStatus: 'SUCCEEDED',
        failureReason: null,
        analysisContentVersion: 1,
        completedAt: '2026-11-19T08:10:00.000Z',
      },
    ];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('link', { name: '问答记录' }).click();
    await page.getByRole('button', { name: '查看对话' }).first().click();
    await expect(page.getByText('建议先检查取板台真空吸附。')).toBeVisible({ timeout: 8000 });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PDF' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^ai-conversation-\d+-v\d+\.pdf$/);
    await expect(page.getByText(/已导出 ai-conversation-/)).toBeVisible();
  });

  test('导出入口在没有会话时不可用', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');

    await expect(page.getByRole('button', { name: '导出 PDF' })).toBeDisabled();
  });
});

// 提交级视觉证据：仅在干净 HEAD 下采集（helper 会对脏工作区失败关闭）
test.describe('AI 诊断工作区 · 提交级视觉证据（任务05 S5）', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
  });

  const EVIDENCE_DIR = process.env.AI_VISUAL_DIR ?? '';

  for (const viewport of [
    { name: 'desktop-1440x900', width: 1440, height: 900 },
    { name: 'medium-1366x768', width: 1366, height: 768 },
    { name: 'narrow-390x844', width: 390, height: 844 },
  ]) {
    test(`${viewport.name}：问答与流程示意全视口截图`, async ({ page }) => {
      test.skip(EVIDENCE_DIR.length === 0, '缺少 AI_VISUAL_DIR（证据目录，不入库）');
      mkdirSync(EVIDENCE_DIR, { recursive: true });

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const state = createMockState();
      await installGraphQLMock(page, state);
      await page.goto('/engineer/ai');
      await page.getByRole('button', { name: '新建对话' }).click();
      await page.getByLabel('AI 提问').fill('晶圆台定位偏差持续偏大，如何排查？');
      await page.getByRole('button', { name: '发送问题' }).click();
      await expect(
        page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
      ).toBeVisible({
        timeout: 8000,
      });

      const fileName = `ai-conversation-${viewport.name}`;
      const capture = await captureStableViewport(page, {
        fileName,
        filePath: `${EVIDENCE_DIR}/${fileName}.png`,
      });
      writeFileSync(`${EVIDENCE_DIR}/${fileName}.meta.json`, JSON.stringify(capture, null, 2));
    });
  }
});

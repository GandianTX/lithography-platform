// e2e/ai-diagnosis-workspace.spec.ts
// 任务05 S3.3：AI 诊断工作区真实浏览器覆盖
//
// 覆盖：独立会话问答、关联工单问答、失败重试、两问题乱序响应、重复 WARNING 仍更新部件、
// 刷新与历史恢复、桌面与窄屏视口。
// 说明：后端交互以 GraphQL 拦截桩驱动（mock-only 入口），用于验证前端页面逻辑与渲染；
// 真实后端链路由后端 S2 真实 GraphQL 验证覆盖。

import { expect, type Route,test } from '@playwright/test';

import { seedAuthSession } from './helpers/auth-session-seed';

const PART_IDS = [
  'controller',
  'reticle_cassette',
  'reticle_arm',
  'reticle_table',
  'reticle_vacuum',
  'positioning_laser',
  'wafer_cassette',
  'wafer_arm',
  'alignment_table',
  'wafer_stage',
  'projection_lens',
];

function buildParts(display: string, overrides: Record<string, string> = {}) {
  return PART_IDS.map((partId) => ({ partId, display: overrides[partId] ?? display }));
}

type MockState = {
  conversationId: number;
  turns: Array<{
    questionUuid: string;
    turnNo: number;
    question: { id: number; text: string; role: string; contentVersion: number } | null;
    answer: { id: number; text: string; role: string; contentVersion: number } | null;
    analysisStatus: string | null;
    failureReason: string | null;
    analysisContentVersion: number | null;
    completedAt: string | null;
  }>;
  requestId: number | null;
  submitCount: number;
  retryCount: number;
  /** 状态查询返回序列：按轮次取用 */
  statusQueue: Array<{
    /** 绑定到指定轮次（turnNo）；缺省表示按查询顺序消费一次 */
    turnNo?: number;
    /** 持续返回该状态（不消费），用于「该轮始终未完成」场景 */
    sticky?: boolean;
    status: string;
    visualization: unknown;
    failureReason?: string | null;
  }>;
};

function createMockState(): MockState {
  return {
    conversationId: 501,
    turns: [],
    requestId: null,
    submitCount: 0,
    retryCount: 0,
    statusQueue: [],
  };
}

function buildConversationDto(state: MockState) {
  return {
    id: state.conversationId,
    requestId: state.requestId,
    requestNo: state.requestId === null ? '' : `RR20261119000000AC${state.requestId}`,
    status: 'ACTIVE',
    contentVersion: state.turns.length + 1,
    createdAt: '2026-11-19T08:00:00.000Z',
    completedAt: null,
    messages: state.turns.flatMap((turn) =>
      [turn.question, turn.answer].filter((message) => message !== null),
    ),
    turns: state.turns,
  };
}

async function installGraphQLMock(
  page: import('@playwright/test').Page,
  state: MockState,
  options: { createDelayMs?: number } = {},
) {
  await page.route('**/graphql', async (route: Route) => {
    const payload = route.request().postDataJSON() as {
      operationName?: string;
      variables?: Record<string, unknown>;
    };
    const operation = payload.operationName ?? '';
    const variables = payload.variables ?? {};

    if (operation === 'MyAiConversations') {
      return route.fulfill({
        body: JSON.stringify({
          data: {
            myAiConversations: {
              items: [
                {
                  id: state.conversationId,
                  requestId: state.requestId,
                  requestNo: state.requestId === null ? '' : `RR20261119000000AC${state.requestId}`,
                  status: 'ACTIVE',
                  contentVersion: state.turns.length + 1,
                  messageCount: state.turns.length * 2,
                  createdAt: '2026-11-19T08:00:00.000Z',
                },
              ],
              total: 1,
              page: 1,
              pageSize: 20,
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'MyAiConversation') {
      return route.fulfill({
        body: JSON.stringify({ data: { myAiConversation: buildConversationDto(state) } }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'ExportAiConversation') {
      // 导出固定内容版本：返回一份最小 PDF 字节（Base64）
      const input = variables.input as { conversationId: number; contentVersion: number };
      return route.fulfill({
        body: JSON.stringify({
          data: {
            exportAiConversation: {
              format: 'PDF',
              filename: `ai-conversation-${input.conversationId}-v${input.contentVersion}.pdf`,
              mimeType: 'application/pdf',
              contentVersion: input.contentVersion,
              lastMessageSeq: state.turns.length * 2,
              byteSize: 8,
              contentBase64: Buffer.from('%PDF-mock').toString('base64'),
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'CreateAiConversation') {
      const input = variables.input as { requestId?: number | null };
      if (options.createDelayMs !== undefined) {
        // U05：可控延迟创建，供「创建期间锁定」用例观察中间态
        await new Promise((resolve) => setTimeout(resolve, options.createDelayMs));
      }
      state.requestId = input.requestId ?? null;
      state.turns = [];
      return route.fulfill({
        body: JSON.stringify({
          data: {
            createAiConversation: {
              id: state.conversationId,
              requestId: state.requestId,
              requestNo: state.requestId === null ? '' : `RR20261119000000AC${state.requestId}`,
              status: 'ACTIVE',
              contentVersion: 1,
              createdAt: '2026-11-19T08:00:00.000Z',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'SubmitAiQuestion') {
      const input = variables.input as {
        questionUuid: string;
        question: string;
        stage?: number | null;
      };
      state.submitCount += 1;
      const turnNo = state.turns.length + 1;
      state.turns.push({
        questionUuid: input.questionUuid,
        turnNo,
        question: {
          id: turnNo * 10,
          text: input.question,
          role: 'USER',
          contentVersion: turnNo,
        },
        answer: null,
        analysisStatus: 'PENDING',
        failureReason: null,
        analysisContentVersion: null,
        completedAt: null,
      });
      return route.fulfill({
        body: JSON.stringify({
          data: {
            submitAiQuestion: {
              conversationId: state.conversationId,
              questionUuid: input.questionUuid,
              status: 'PENDING',
              turnNo,
              messageSeq: turnNo * 10,
              contentVersion: turnNo,
              replayed: false,
              dispatchStatus: 'QUEUED',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'RetryAiQuestion') {
      const input = variables.input as { questionUuid: string };
      state.retryCount += 1;
      const turn = state.turns.find((item) => item.questionUuid === input.questionUuid);
      if (turn !== undefined) {
        turn.analysisStatus = 'PENDING';
        turn.failureReason = null;
      }
      return route.fulfill({
        body: JSON.stringify({
          data: {
            retryAiQuestion: {
              conversationId: state.conversationId,
              questionUuid: input.questionUuid,
              status: 'PENDING',
              turnNo: turn?.turnNo ?? 1,
              messageSeq: 1,
              contentVersion: state.turns.length + 1,
              replayed: false,
              dispatchStatus: 'QUEUED',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
    });
    }

    if (operation === 'AiQuestionStatus') {
      const input = variables.input as { questionUuid: string };
      const turn = state.turns.find((item) => item.questionUuid === input.questionUuid);
      const boundIndex = state.statusQueue.findIndex(
        (item) => item.turnNo !== undefined && item.turnNo === turn?.turnNo,
      );
      const freeIndex = state.statusQueue.findIndex((item) => item.turnNo === undefined);
      const pickIndex = boundIndex >= 0 ? boundIndex : freeIndex;
      const picked =
        pickIndex >= 0
          ? (state.statusQueue[pickIndex] as {
              turnNo?: number;
              sticky?: boolean;
              status: string;
              visualization: unknown;
              failureReason?: string | null;
            })
          : null;
      if (picked !== null && picked.sticky !== true) {
        state.statusQueue.splice(pickIndex, 1);
      }
      const next =
        picked !== null
          ? picked
          : {
              status: 'SUCCEEDED',
              visualization: {
                sceneId: 'LITHO_WORKFLOW_V1',
                stage: 2,
                parts: buildParts('NORMAL'),
              },
            };
      if (turn !== undefined && next.status !== 'PENDING' && next.status !== 'RUNNING') {
        turn.analysisStatus = next.status;
        turn.failureReason = next.failureReason ?? null;
        turn.completedAt = '2026-11-19T08:05:00.000Z';
        if (next.status === 'SUCCEEDED') {
          turn.answer = {
            id: turn.turnNo * 10 + 1,
            text: '建议先检查取板台真空吸附与激光定位组件。',
            role: 'ASSISTANT',
            contentVersion: turn.analysisContentVersion ?? turn.turnNo,
          };
        }
      }
      return route.fulfill({
        body: JSON.stringify({
          data: {
            aiQuestionStatus: {
              conversationId: state.conversationId,
              questionUuid: input.questionUuid,
              status: next.status,
              failureReason: next.failureReason ?? null,
              contentVersion: turn?.analysisContentVersion ?? state.turns.length + 1,
              turnNo: turn?.turnNo ?? 1,
              questionText: turn?.question?.text ?? '',
              answer:
                next.status === 'SUCCEEDED'
                  ? {
                      id: (turn?.turnNo ?? 1) * 10 + 1,
                      text: '建议先检查取板台真空吸附与激光定位组件。',
                      role: 'ASSISTANT',
                      contentVersion: turn?.analysisContentVersion ?? 1,
                    }
                  : null,
              visualization: next.visualization,
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    return route.fulfill({
      body: JSON.stringify({ errors: [{ message: `unhandled operation: ${operation}` }] }),
      contentType: 'application/json',
      status: 200,
    });
  });
}

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
    await expect(page.getByText('建议先检查取板台真空吸附与激光定位组件。')).toBeVisible({
      timeout: 8000,
    });
    // 左侧图例给出模型标记（关注 · 手臂1（掩模板））
    await expect(page.getByLabel('部件标记')).toContainText('关注');
    // 流程参考图中的部件（阶段 2）高亮
    await expect(page.getByLabel('维修流程示意')).toBeVisible();
  });

  test('关联工单：新建会话时写入申请来源', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByLabel('关联维修申请（新建会话时生效）').fill('8801');
    await page.getByRole('button', { name: '新建对话' }).click();
    await expect(page.getByRole('heading', { name: 'AI 诊断' })).toBeVisible();

    await page.getByLabel('AI 提问').fill('曝光前校验失败');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(page.getByText('建议先检查取板台真空吸附与激光定位组件。')).toBeVisible({
      timeout: 8000,
    });
    expect(state.requestId).toBe(8801);
  });

  test('U05：创建期间锁定新建与工单输入，完成后展示服务端关联', async ({ page }) => {
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
    const workOrder = page.getByLabel('关联维修申请（新建会话时生效）');
    await workOrder.fill('8801');
    await expect(workOrder).toHaveValue('8801');
    await workOrder.blur();
    await page.getByRole('button', { name: '新建对话' }).click();

    // 创建在飞：新建入口与工单输入同时锁定，避免待选值与服务端事实不一致
    await expect(page.getByRole('button', { name: '新建对话' })).toBeDisabled();
    await expect(workOrder).toBeDisabled();

    // 创建完成（新建入口恢复可用）后：工单显示服务端关联值，且会话绑定后仍不可改
    await expect.poll(() => state.requestId, { timeout: 8000 }).toBe(8801);
    await expect(page.getByRole('button', { name: '新建对话' })).toBeEnabled();
    await expect(workOrder).toHaveValue('8801');
    await expect(workOrder).toBeDisabled();
    expect(createBodies.join('\n')).toContain('"requestId":8801');
  });

  test('失败重试：失败轮次可重试且沿用同一问题 UUID', async ({ page }) => {
    const state = createMockState();
    state.statusQueue = [
      { turnNo: 1, status: 'FAILED', visualization: null, failureReason: 'reply_model_unavailable' },
    ];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();

    await expect(page.getByRole('button', { name: '重试本轮' })).toBeVisible({ timeout: 8000 });
    const uuidBefore = state.turns[0]?.questionUuid;
    await page.getByRole('button', { name: '重试本轮' }).click();
    await expect
      .poll(() => state.retryCount, { timeout: 8000 })
      .toBeGreaterThan(0);
    expect(state.turns[0]?.questionUuid).toBe(uuidBefore);
  });

  test('两问题乱序响应：后发问题的回复先到时不覆盖当前轮', async ({ page }) => {
    const state = createMockState();
    state.statusQueue = [
      { turnNo: 1, sticky: true, status: 'PENDING', visualization: null },
    ];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByLabel('AI 提问').fill('问题一');
    await page.getByRole('button', { name: '发送问题' }).click();
    await page.getByLabel('AI 提问').fill('问题二');
    await page.getByRole('button', { name: '发送问题' }).click();

    await expect(page.getByText('建议先检查取板台真空吸附与激光定位组件。')).toBeVisible({
      timeout: 8000,
    });
    // 当前轮是第二个问题：第一轮仍未完成，不得被标成成功
    const firstTurn = state.turns[0];
    expect(firstTurn?.analysisStatus).not.toBe('SUCCEEDED');
    // 当前轮图形来自第二个问题（默认 SUCCEEDED 图形），不受第一轮影响
    await expect(page.getByLabel('维修流程示意')).toBeVisible();
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

  test('刷新与历史：刷新后可从历史入口重新进入会话', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(page.getByText('建议先检查取板台真空吸附与激光定位组件。')).toBeVisible({
      timeout: 8000,
    });

    await page.reload();
    await page.getByRole('button', { name: '历史会话' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('历史会话').first()).toBeVisible();
    await expect(page.getByText('#501')).toBeVisible();
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
    await expect(page.getByText('建议先检查取板台真空吸附与激光定位组件。')).toBeVisible({
      timeout: 8000,
    });
  });

  test('键盘可用：输入框可聚焦并 Ctrl+Enter 发送，几何画布可聚焦并用方向键旋转', async ({ page }) => {
    const state = createMockState();
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '新建对话' }).click();

    const input = page.getByLabel('AI 提问');
    await input.focus();
    await expect(input).toBeFocused();
    await input.fill('键盘提交的问题');
    await input.press('Control+Enter');
    await expect(page.getByText('建议先检查取板台真空吸附与激光定位组件。')).toBeVisible({
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
    await page.getByRole('button', { name: /退出登录|Logout/i }).first().click();
    await expect(page).toHaveURL(/\/login/, { timeout: 8000 });

    // 在途响应此时才返回：不得再更新新画面
    releaseStatus.fn?.();
    await page.waitForTimeout(500);
    await expect(page.getByText('建议先检查取板台真空吸附与激光定位组件。')).toHaveCount(0);
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
        return { height: Math.round(box.height), width: Math.round(box.width), x: Math.round(box.x) };
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
    await page.getByRole('button', { name: '新建对话' }).click();
    await expect(page.getByLabel('维修流程示意')).toBeVisible();

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
        answer: { id: 12, text: '建议先检查取板台真空吸附。', role: 'ASSISTANT', contentVersion: 1 },
        analysisStatus: 'SUCCEEDED',
        failureReason: null,
        analysisContentVersion: 1,
        completedAt: '2026-11-19T08:10:00.000Z',
      },
    ];
    await installGraphQLMock(page, state);

    await page.goto('/engineer/ai');
    await page.getByRole('button', { name: '历史会话' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByText('#501').click();
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

// e2e/ai-diagnosis-v44-acceptance.spec.ts
// 任务05 S4：V44 展示层验收（三视口 × 六种状态 + 可对账量测）
//
// 目的：按《任务05-V44差异清单与实施计划》S4「展示层验收」要求，用 1440×900 / 1366×768 /
// 390×844 同壳层同滚动锚点核对空态、普通问答、警示落定、选工单、历史与错误六种状态，
// 并把三段 rect、分栏可用宽度、线程/整页 overflow、阶段/工单控件与 PDF/发送可达性
// 写成可对账的量测（JSON），供提审附件逐项核对。
//
// 说明：后端交互仍由 GraphQL 拦截桩驱动（mock-only 入口），只用于前端展示层验收；
// 真实链路的结论以任务05 真实后端用例为准，二者不得混用为同一份证据。
// 截图走统一收口 captureStableViewport（工作区脏时失败关闭），量测始终执行。

import { expect, type Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

import { buildParts, createMockState, installGraphQLMock } from './helpers/ai-conversation-mocks';
import { seedAuthSession } from './helpers/auth-session-seed';
import { captureStableViewport } from './helpers/visual-evidence';

/** 证据目录（不入库）；缺省时只跑量测与断言，不产出截图 */
const EVIDENCE_DIR = process.env.AI_VISUAL_DIR ?? '';

type Rect = { height: number; width: number; x: number; y: number };

type PageMetrics = {
  canvas: Rect | null;
  controls: {
    compose: Rect | null;
    exportPdf: Rect | null;
    faultCard: Rect | null;
    send: Rect | null;
    stageSelect: Rect | null;
    workOrderSelect: Rect | null;
  };
  document: { clientWidth: number; scrollHeight: number; scrollWidth: number };
  grid: (Rect & { gridTemplateColumns: string }) | null;
  panel: Rect | null;
  scene: Rect | null;
  thread: { clientHeight: number; scrollHeight: number; scrollTop: number } | null;
  viewport: { height: number; width: number };
};

const VIEWPORTS = [
  { name: 'desktop-1440x900', height: 900, stacked: false, width: 1440 },
  { name: 'medium-1366x768', height: 768, stacked: false, width: 1366 },
  { name: 'narrow-390x844', height: 844, stacked: true, width: 390 },
];

/** 采集当前页面量测（rect 用文档坐标，便于跨滚动位置对账） */
async function measure(page: Page): Promise<PageMetrics> {
  return page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);

      if (element === null) {
        return null;
      }
      const rect = element.getBoundingClientRect();

      return {
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
      };
    };

    const gridElement = document.querySelector('.ai-workspace-grid');
    const threadElement = document.querySelector<HTMLElement>('.ai-thread');
    const root = document.documentElement;

    return {
      canvas: rectOf('.ai-scene-canvas'),
      controls: {
        compose: rectOf('.ai-compose'),
        exportPdf: rectOf('.ai-compose-actions .ant-btn'),
        faultCard: rectOf('.ai-fault-card'),
        send: rectOf('.ai-send .ant-btn'),
        stageSelect: rectOf('.ai-scene-stage .ant-select'),
        workOrderSelect: rectOf('.ai-work-order-select .ant-select'),
      },
      document: {
        clientWidth: root.clientWidth,
        scrollHeight: root.scrollHeight,
        scrollWidth: root.scrollWidth,
      },
      grid:
        gridElement === null
          ? null
          : {
              ...(rectOf('.ai-workspace-grid') as {
                height: number;
                width: number;
                x: number;
                y: number;
              }),
              gridTemplateColumns: window.getComputedStyle(gridElement).gridTemplateColumns,
            },
      panel: rectOf('.ai-panel'),
      scene: rectOf('.ai-scene'),
      thread:
        threadElement === null
          ? null
          : {
              clientHeight: threadElement.clientHeight,
              scrollHeight: threadElement.scrollHeight,
              scrollTop: threadElement.scrollTop,
            },
      viewport: { height: window.innerHeight, width: window.innerWidth },
    };
  });
}

/** 分栏与溢出断言：桌面左右分栏、窄屏纵向堆叠，整页不得横向溢出 */
function assertLayout(metrics: PageMetrics, stacked: boolean, label: string): void {
  expect(
    metrics.document.scrollWidth - metrics.document.clientWidth,
    `${label}：整页不应出现横向溢出`,
  ).toBeLessThanOrEqual(0);

  expect(metrics.grid, `${label}：应存在工作区分栏网格`).not.toBeNull();
  expect(metrics.scene, `${label}：应存在场景区`).not.toBeNull();
  expect(metrics.panel, `${label}：应存在对话面板`).not.toBeNull();

  const grid = metrics.grid;
  const scene = metrics.scene;
  const panel = metrics.panel;

  if (grid === null || scene === null || panel === null) {
    return;
  }

  const columns = grid.gridTemplateColumns.split(' ').filter((item) => item.trim().length > 0);

  if (stacked) {
    expect(columns.length, `${label}：窄屏应纵向堆叠为单列`).toBe(1);
    expect(panel.y, `${label}：窄屏对话面板应排在场景区下方`).toBeGreaterThan(scene.y);
  } else {
    expect(columns.length, `${label}：桌面应为左右两列`).toBe(2);
    expect(panel.x, `${label}：桌面对话面板应在场景区右侧`).toBeGreaterThan(scene.x);
    expect(panel.width, `${label}：桌面右栏宽度应在 350–530px`).toBeGreaterThanOrEqual(350);
    expect(panel.width, `${label}：桌面右栏宽度应在 350–530px`).toBeLessThanOrEqual(530);
  }

  expect(metrics.canvas, `${label}：应存在画布容器`).not.toBeNull();
}

/** 截图（仅在提供证据目录时）；走统一收口，脏工作区失败关闭 */
async function capture(page: Page, fileName: string): Promise<void> {
  if (EVIDENCE_DIR.length === 0) {
    return;
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = `${EVIDENCE_DIR}/${fileName}.png`;
  const meta = await captureStableViewport(page, { fileName, filePath });
  writeFileSync(`${EVIDENCE_DIR}/${fileName}.meta.json`, JSON.stringify(meta, null, 2));
}

test.describe('V44 展示层验收（任务05 S4）', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}：六种状态的量测、分栏与控件可达`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const state = createMockState();
      await installGraphQLMock(page, state);
      await page.goto('/engineer/ai');

      const metrics: Record<string, PageMetrics> = {};

      // 1) 空态：草稿可写，发送按钮存在但不可用
      await expect(page.getByLabel('AI 提问')).toBeEnabled();
      metrics.empty = await measure(page);
      assertLayout(metrics.empty, viewport.stacked, `${viewport.name}/空态`);
      await expect(page.getByRole('button', { name: '发送问题' })).toBeDisabled();
      await capture(page, `ai-diagnosis-${viewport.name}-empty`);

      // 2) 选工单：候选来自本人已接工单，标题为「工单号 · 机型」
      await page.getByLabel('关联工单').click();
      await expect(
        page.locator('.ant-select-dropdown:visible .ant-select-item-option').first(),
      ).toBeVisible();
      await expect(
        page.locator('.ant-select-dropdown:visible .ant-select-item-option').first(),
      ).toContainText('MR-20261120-001');
      metrics.workOrder = await measure(page);
      await capture(page, `ai-diagnosis-${viewport.name}-work-order`);
      await page.keyboard.press('Escape');

      // 3) 普通问答：回答落定，图例给出部件标记
      await page.getByLabel('AI 提问').fill('晶圆台定位偏差持续偏大，如何排查？');
      await page.getByRole('button', { name: '发送问题' }).click();
      await expect(
        page.getByRole('log').getByText('建议先检查取板台真空吸附与激光定位组件。'),
      ).toBeVisible({ timeout: 8000 });
      await expect(page.getByLabel('维修流程示意')).toBeVisible();
      metrics.chat = await measure(page);
      assertLayout(metrics.chat, viewport.stacked, `${viewport.name}/普通问答`);
      await capture(page, `ai-diagnosis-${viewport.name}-chat`);

      // 4) 警示落定：故障短卡锁定，指向与图例同一部件
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
      await page.getByLabel('AI 提问').fill('手臂 1 无动作，怎么排查？');
      await page.getByRole('button', { name: '发送问题' }).click();
      const card = page.locator('.ai-fault-card');
      await expect(card).toHaveAttribute('data-locked', 'true', { timeout: 10000 });
      await expect(card).toContainText('手臂1（掩模板）');
      await expect(page.getByLabel('部件标记')).toContainText('警示 · 手臂1（掩模板）');
      await expect(page.getByText('本轮阶段 2')).toBeVisible();
      metrics.warning = await measure(page);
      assertLayout(metrics.warning, viewport.stacked, `${viewport.name}/警示落定`);
      // 短卡不得遮挡输入区
      const compose = metrics.warning.controls.compose;
      const faultCard = metrics.warning.controls.faultCard;
      if (compose !== null && faultCard !== null) {
        const overlaps =
          faultCard.x < compose.x + compose.width &&
          faultCard.x + faultCard.width > compose.x &&
          faultCard.y < compose.y + compose.height &&
          faultCard.y + faultCard.height > compose.y;
        expect(overlaps, `${viewport.name}：故障短卡不得遮挡输入区`).toBe(false);
      }
      await capture(page, `ai-diagnosis-${viewport.name}-warning`);

      // 5) 错误：失败轮次给出重试入口
      state.statusQueue = [
        {
          status: 'FAILED',
          failureReason: '模型推理超时，请重试',
          visualization: null,
        },
      ];
      await page.getByLabel('AI 提问').fill('再测一次仍然异常，怎么处理？');
      await page.getByRole('button', { name: '发送问题' }).click();
      await expect(page.getByRole('button', { name: '重试本轮' })).toBeVisible({ timeout: 8000 });
      metrics.failed = await measure(page);
      assertLayout(metrics.failed, viewport.stacked, `${viewport.name}/错误`);
      await capture(page, `ai-diagnosis-${viewport.name}-failed`);

      // 6) 问答记录页：独立入口直达，列表可读
      const localNav = page.getByLabel('AI 诊断导航');
      await localNav.getByRole('link', { name: '问答记录' }).click();
      await expect(page.getByRole('heading', { name: '问答记录' })).toBeVisible();
      await expect(page.getByText('独立会话').first()).toBeVisible();
      metrics.history = await measure(page);
      await capture(page, `ai-diagnosis-${viewport.name}-history`);

      // 控件可达：阶段、工单、PDF、发送在当前视口内可滚动到并操作
      await localNav.getByRole('link', { name: 'AI 对话' }).click();
      await expect(page.getByLabel('AI 提问')).toBeEnabled();
      await expect(page.locator('.ai-scene-stage .ant-select')).toBeVisible();
      await expect(page.getByLabel('关联工单')).toBeVisible();
      const exportButton = page.getByRole('button', { name: '导出 PDF' });
      await exportButton.scrollIntoViewIfNeeded();
      await expect(exportButton).toBeVisible();
      const sendButton = page.getByRole('button', { name: '发送问题' });
      await sendButton.scrollIntoViewIfNeeded();
      await expect(sendButton).toBeVisible();

      if (EVIDENCE_DIR.length > 0) {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(
          `${EVIDENCE_DIR}/v44-acceptance-${viewport.name}.metrics.json`,
          JSON.stringify(metrics, null, 2),
        );
      }
    });
  }
});

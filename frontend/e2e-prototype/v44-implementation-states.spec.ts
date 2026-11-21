// e2e-prototype/v44-implementation-states.spec.ts
// 实现侧多状态证据采集（任务 05 · 余项计划 S1.2 / S1.3）
//
// 状态：空态、普通问答、长文本、WARNING 落定、失败；视口：1920x1080 / 1440x900 /
// 1366x768 / 390x844。每态记录：关键区块 rect、canvas 模型投影包围盒、色面采样
// （像素主色分布），WARNING/失败另记录**动画过程**的相机角度/缩放时间序列。
// 产物写入 AI_V44_EVIDENCE_DIR 指定的全新隔离目录（不覆盖既有证据）。

import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildParts,
  createMockState,
  installGraphQLMock,
  type MockState,
} from '../e2e/helpers/ai-conversation-mocks';
import { seedAuthSession } from '../e2e/helpers/auth-session-seed';

type Viewport = { name: string; width: number; height: number };
type StateName = 'empty' | 'chat' | 'long' | 'warning' | 'failed';

const VIEWPORTS: Viewport[] = [
  { name: 'desktop-1920x1080', width: 1920, height: 1080 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'medium-1366x768', width: 1366, height: 768 },
  { name: 'narrow-390x844', width: 390, height: 844 },
];

const STATES: StateName[] = ['empty', 'chat', 'long', 'warning', 'failed'];

/**
 * 需要额外采一份深色模式变体的状态。
 *
 * V44 原型为亮色单主题（原型内无 dark 主题/开关），实现侧存在 `.dark` 令牌覆盖
 * （frontend/src/index.css），但**没有运行时切换入口**（theme provider 只暴露
 * fontScale），因此深色态只能通过显式注入 `<html class="dark">` 得到，且**只有
 * 实现侧单侧证据、没有原型对照基准**。
 */
const DARK_STATES: StateName[] = ['empty', 'warning'];

const LONG_ANSWER =
  '建议按以下顺序排查取板台链路：1）确认取板台真空吸附压力是否在额定区间，' +
  '并查看最近一次换件记录；2）复核激光定位组件的标定参数是否与当前机型版本一致，' +
  '如近期做过机械调整需重新标定；3）检查手臂 1 掩模板组件的驱动固件版本与告警日志，' +
  '确认是否存在重复的限位信号；4）如以上均正常，请导出该时段的总线报文与时序日志，' +
  '交由维保支持进一步定位。以上排查建议仅覆盖常见工况，若现场伴随异响或真空度骤降，' +
  '应先停机确认安全后再继续。';

/** 本次要写入的全部工件名（预检用，避免覆盖既有证据） */
function artifactNames(): string[] {
  const names: string[] = [];
  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      names.push(`实现-${state}-${viewport.name}.png`);
      if (DARK_STATES.includes(state)) {
        names.push(`实现-${state}-${viewport.name}-dark.png`);
      }
    }
  }
  names.push('implementation-states.json');
  return names;
}

/**
 * 预检：证据目录必填；本次要写的每个工件都不得已存在。
 *
 * 目录可以已存在（同一采集会话内多个采集器共用一个输出根），但**逐个工件**做存在性
 * 检查，避免覆盖历史证据。
 */
function evidenceRoot(): string {
  const raw = process.env.AI_V44_EVIDENCE_DIR;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('缺少 AI_V44_EVIDENCE_DIR：请指定本次证据输出目录（必须为空或不存在）。');
  }
  const root = path.resolve(raw.trim());
  const target = path.join(root, '实现多态');
  mkdirSync(target, { recursive: true });
  const existing = artifactNames().filter((name) => existsSync(path.join(target, name)));
  if (existing.length > 0) {
    throw new Error(
      `证据子目录中已存在本次要写的工件，拒绝覆盖既有证据：${existing.join('、')}（目录：${target}）`,
    );
  }
  return target;
}

function turn(text: string, answerText: string): MockState['turns'][number] {
  return {
    questionUuid: '11111111-2222-4333-8444-555555555555',
    turnNo: 1,
    question: { id: 11, text, role: 'USER', contentVersion: 1 },
    answer: { id: 12, text: answerText, role: 'ASSISTANT', contentVersion: 1 },
    analysisStatus: 'SUCCEEDED',
    failureReason: null,
    analysisContentVersion: 1,
    completedAt: '2026-11-21T08:10:00.000',
  };
}

async function measure(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const canvas = document.querySelector<HTMLCanvasElement>('.ai-scene-canvas canvas');
    let model: { x: number; y: number; width: number; height: number } | null = null;
    let palette: Array<{ rgb: string; count: number }> = [];
    if (canvas !== null) {
      const ctx = canvas.getContext('2d');
      if (ctx !== null) {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const counts = new Map<string, number>();
        let minX = canvas.width;
        let minY = canvas.height;
        let maxX = 0;
        let maxY = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          const px = (i / 4) % canvas.width;
          const py = Math.floor(i / 4 / canvas.width);
          const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
        if (maxX > 0 || maxY > 0) {
          model = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
        }
        palette = [...counts.entries()]
          .map(([rgb, count]) => ({ rgb, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8);
      }
    }
    const camera = canvas === null ? null : canvas.getAttribute('data-camera-angle');
    const rootStyle = window.getComputedStyle(document.documentElement);
    return {
      scrollY: window.scrollY,
      darkClass: document.documentElement.classList.contains('dark'),
      /** 深色令牌取样：用于核对 DOM 令牌已切换（canvas 是否按新令牌重绘见 palette 对照） */
      tokens: {
        workspaceBg: rootStyle.getPropertyValue('--ai-workspace-bg').trim(),
        partNormalTop: rootStyle.getPropertyValue('--ai-geo-part-normal-top').trim(),
        partWarningTop: rootStyle.getPropertyValue('--ai-geo-part-warning-top').trim(),
      },
      layout: {
        scene: rect('.ai-scene'),
        canvasWrap: rect('.ai-scene-canvas'),
        panel: rect('.ai-panel'),
        thread: rect('.ai-thread'),
        compose: rect('.ai-compose'),
        sceneHeader: rect('.ai-scene-header'),
        legend: rect('[aria-label="部件标记"]'),
        faultCard: rect('.ai-fault-card'),
      },
      model,
      palette,
      camera,
    };
  });
}

test.describe('实现侧多状态证据（任务 05 · 余项 S1）', () => {
  test('四视口 × 五状态采集（空态/普通问答/长文本/WARNING/失败）+ 深色模式变体', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const outDir = evidenceRoot();
    const report: Array<Record<string, unknown>> = [];

    const collect = async (state: StateName, viewport: Viewport, dark: boolean) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedAuthSession(page, 'ENGINEER');
      const mock = createMockState();
      if (state === 'chat' || state === 'long') {
        mock.turns = [
          turn(
            '手臂 1 无动作，怎么排查？',
            state === 'long' ? LONG_ANSWER : '建议先检查取板台真空吸附与激光定位组件。',
          ),
        ];
      }
      if (state === 'warning') {
        mock.statusQueue = [
          {
            status: 'SUCCEEDED',
            visualization: {
              sceneId: 'LITHO_WORKFLOW_V1',
              stage: 2,
              parts: buildParts('NORMAL', {
                reticle_arm: 'WARNING',
                reticle_table: 'HIGHLIGHT',
              }),
            },
          },
        ];
      }
      if (state === 'failed') {
        mock.statusQueue = [
          {
            turnNo: 1,
            status: 'FAILED',
            visualization: null,
            failureReason: 'reply_model_unavailable',
          },
        ];
      }
      await installGraphQLMock(page, mock);
      await page.goto(
        state === 'chat' || state === 'long'
          ? `/engineer/ai?conversation=${mock.conversationId}`
          : '/engineer/ai',
      );
      await page.waitForTimeout(1200);

      const cameraTimeline: Array<{
        tMs: number;
        angle: string | null;
        zoom: string | null;
      }> = [];
      if (state === 'warning' || state === 'failed') {
        const started = Date.now();
        await page.getByLabel('AI 提问').fill('手臂 1 无动作，怎么排查？');
        await page.getByRole('button', { name: '发送问题' }).click();
        for (let index = 0; index < 30; index += 1) {
          const sample = await page.evaluate(() => {
            const canvas = document.querySelector('.ai-scene-canvas canvas');
            return {
              angle: canvas === null ? null : canvas.getAttribute('data-camera-angle'),
              zoom: canvas === null ? null : canvas.getAttribute('data-camera-zoom'),
            };
          });
          cameraTimeline.push({
            tMs: Date.now() - started,
            angle: sample.angle,
            zoom: sample.zoom,
          });
          await page.waitForTimeout(120);
        }
        if (state === 'warning') {
          await expect(page.locator('.ai-fault-card')).toHaveAttribute('data-locked', 'true', {
            timeout: 15_000,
          });
        } else {
          await expect(page.getByRole('button', { name: '重试本轮' })).toBeVisible({
            timeout: 15_000,
          });
        }
        await page.waitForTimeout(800);
      } else {
        await page.waitForTimeout(600);
      }

      if (dark) {
        // 深色模式：实现侧无运行时开关（theme provider 只暴露 fontScale），显式注入
        // `<html class="dark">` 覆盖 CSS 令牌；canvas 颜色从 documentElement 上的变量读，
        // 必须触发一次 ResizeObserver → scheduleDraw 才会按深色令牌重绘。
        // 注意：两次 setViewportSize 之间必须留出等待，否则尺寸变更会被合并、
        // ResizeObserver 不触发，canvas 会停留在浅色像素（已实测确认）。
        await page.evaluate(() => {
          document.documentElement.classList.add('dark');
        });
        await page.setViewportSize({ width: viewport.width + 1, height: viewport.height });
        await page.waitForTimeout(400);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForTimeout(600);
      }

      const measured = await measure(page);
      const suffix = dark ? '-dark' : '';
      const file = path.join(outDir, `实现-${state}-${viewport.name}${suffix}.png`);
      await page.screenshot({ path: file });
      report.push({
        state,
        viewport: viewport.name,
        dark,
        file: path.basename(file),
        ...measured,
        cameraTimeline,
      });
    };

    for (const viewport of VIEWPORTS) {
      for (const state of STATES) {
        await collect(state, viewport, false);
        if (DARK_STATES.includes(state)) {
          await collect(state, viewport, true);
        }
      }
    }

    writeFileSync(
      path.join(outDir, 'implementation-states.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    expect(report.length).toBe(VIEWPORTS.length * (STATES.length + DARK_STATES.length));
  });
});

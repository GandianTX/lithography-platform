// e2e-prototype/v44-visual-compare.spec.ts
//
// V44 原型 vs 实现的视觉对照采集（任务 05 · 视觉偏差根因修复 · S4）
//
// 本用例**不在默认 `npm run test:e2e` 收集范围**：它依赖本机外部原型 HTML
// （gitignored 的个人资料），默认 mock 回归不得要求该文件存在。
// 专用入口：npm run test:e2e:v44-visual
//   必填环境变量：
//     AI_V44_PROTOTYPE_HTML  原型 HTML 的绝对路径（file:// 目标）
//     AI_V44_EVIDENCE_DIR    证据输出目录（必须不存在或为空，禁止覆盖既有证据）
//   可选环境变量：
//     AI_V44_PROTOTYPE_SHA256 原型 SHA-256（提供则强制核对，不符即失败）
//
// 同口径要求（计划 1.4.1）：同一浏览器、同一 DPR、同一语言、同一账号角色、
// 同一视口、同一滚动位置下，分别打开原型固定 URL 与实现固定路由，采集：
//   - 关键区块的 DOM rect / computed style / 选择器唯一性；
//   - canvas 内模型投影像素的包围盒（同一算法，两边可比）；
//   - 整页截图与并排叠图（用于目视核对）。

import { chromium, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildParts,
  createMockState,
  installGraphQLMock,
} from '../e2e/helpers/ai-conversation-mocks';
import { seedAuthSession } from '../e2e/helpers/auth-session-seed';
import { prepareStableViewport } from '../e2e/helpers/visual-evidence';

/** 预检：原型路径必填、可读；证据目录必填且不得覆盖既有证据 */
function resolvePrototypeUrl(): string {
  const raw = process.env.AI_V44_PROTOTYPE_HTML;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      '缺少 AI_V44_PROTOTYPE_HTML：请通过环境变量指定 V44 原型 HTML 的绝对路径。' +
        '默认 npm run test:e2e 不收集本用例，请用 npm run test:e2e:v44-visual 运行。',
    );
  }
  const absolute = path.resolve(raw.trim());
  if (!existsSync(absolute)) {
    throw new Error(`AI_V44_PROTOTYPE_HTML 指向的文件不存在：${absolute}`);
  }
  const expected = process.env.AI_V44_PROTOTYPE_SHA256;
  if (expected !== undefined && expected.trim() !== '') {
    const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (actual !== expected.trim().toLowerCase()) {
      throw new Error(
        `原型 SHA-256 不符：期望 ${expected.trim()}，实际 ${actual}（文件：${absolute}）`,
      );
    }
  }
  const url = pathToFileURL(absolute);
  url.hash = '/engineer/ai/chat';
  return url.href;
}

/**
 * 预检：证据目录必填。
 *
 * 目录可以已存在（同一采集会话内多个采集器共用一个输出根），但**本次要写的每个工件**
 * 都必须不存在——避免覆盖历史证据（详见 assertTargetsAbsent）。
 */
function resolveEvidenceDir(): string {
  const raw = process.env.AI_V44_EVIDENCE_DIR;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      '缺少 AI_V44_EVIDENCE_DIR：请通过环境变量指定本次证据输出目录（必须为空或不存在）。',
    );
  }
  const absolute = path.resolve(raw.trim());
  if (!existsSync(absolute)) {
    mkdirSync(absolute, { recursive: true });
  }
  return absolute;
}

/** 预检：本次要写入的工件必须都不存在（拒绝覆盖既有证据） */
function assertTargetsAbsent(dir: string, names: readonly string[]): void {
  const existing = names.filter((name) => existsSync(path.join(dir, name)));
  if (existing.length > 0) {
    throw new Error(
      `证据目录中已存在本次要写的工件，拒绝覆盖既有证据：${existing.join('、')}（目录：${dir}）`,
    );
  }
}

const PROTOTYPE_HTML = resolvePrototypeUrl();
const OUT_DIR = resolveEvidenceDir();

type Viewport = { name: string; width: number; height: number };

/** S4 硬门槛（计划 1.4.1「建议阈值断言」）：模型中心偏差 ≤3%、宽高 ≤5%、区块边界 ≤8px */
const THRESHOLDS = {
  modelCenterRatio: 0.03,
  modelSizeRatio: 0.05,
  layoutDeltaPx: 8,
};

const VIEWPORTS: Viewport[] = [
  { name: 'desktop-1920x1080', width: 1920, height: 1080 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'medium-1366x768', width: 1366, height: 768 },
  { name: 'narrow-390x844', width: 390, height: 844 },
];

const PROTOTYPE_SELECTORS: Record<string, string> = {
  shell: '.ai36-shell',
  scene: '.ai33-scene',
  canvasWrap: '.ai33-canvas-wrap',
  panel: '.ai33-panel',
  sceneHeader: '.ai36-model-header',
  sceneFooter: '.ai36-model-footer',
  thread: '.ai33-thread',
  compose: '.ai33-compose',
  pageHeader: '.ai34-header',
};

const IMPL_SELECTORS: Record<string, string> = {
  shell: '.ai-shell--workspace',
  scene: '.ai-scene',
  canvasWrap: '.ai-scene-canvas',
  panel: '.ai-panel',
  sceneHeader: '.ai-scene-header',
  sceneFooter: '.ai-scene-footer',
  thread: '.ai-thread',
  compose: '.ai-compose',
  pageHeader: '.ai-shell-header',
};

type Metrics = Record<
  string,
  {
    rect: { x: number; y: number; width: number; height: number } | null;
    style: Record<string, string> | null;
    count: number;
  } | null
>;

type ModelBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
};

type ModelDelta = {
  centerX: number;
  centerY: number;
  widthRatio: number;
  heightRatio: number;
};

async function measureLayout(
  page: import('@playwright/test').Page,
  selectors: Record<string, string>,
) {
  return page.evaluate((map) => {
    const result: Record<string, unknown> = {};
    for (const [key, selector] of Object.entries(map)) {
      const element = document.querySelector(selector) as HTMLElement | null;
      const count = document.querySelectorAll(selector).length;
      if (element === null) {
        result[key] = null;
        continue;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      result[key] = {
        rect: {
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        },
        style: {
          display: style.display,
          gridTemplateColumns: style.gridTemplateColumns,
          gridTemplateRows: style.gridTemplateRows,
          padding: style.padding,
          gap: style.gap,
          borderRadius: style.borderRadius,
          backgroundColor: style.backgroundColor,
        },
        count,
      };
    }
    return result as Metrics;
  }, selectors);
}

/** canvas 内非透明像素包围盒 = 模型投影范围（同一算法，两边可比） */
async function measureModelBox(page: import('@playwright/test').Page, selector: string) {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (canvas === null) {
      return null;
    }
    const context = canvas.getContext('2d');
    if (context === null || canvas.width === 0 || canvas.height === 0) {
      return null;
    }
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (data[(y * canvas.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      return null;
    }
    const ratio = window.devicePixelRatio || 1;
    return {
      x: Number((minX / ratio).toFixed(2)),
      y: Number((minY / ratio).toFixed(2)),
      width: Number(((maxX - minX + 1) / ratio).toFixed(2)),
      height: Number(((maxY - minY + 1) / ratio).toFixed(2)),
      canvasWidth: canvas.clientWidth,
      canvasHeight: canvas.clientHeight,
    };
  }, selector);
}

async function capturePrototype(browser: import('@playwright/test').Browser, viewport: Viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(PROTOTYPE_HTML);
  await page.waitForTimeout(1200);
  const layout = await measureLayout(page, PROTOTYPE_SELECTORS);
  const model = await measureModelBox(page, '.ai33-canvas');
  await prepareStableViewport(page, `原型-${viewport.name}`);
  const shot = await page.screenshot({ path: path.join(OUT_DIR, `原型-${viewport.name}.png`) });
  await context.close();
  return { layout, model, shot: shot.toString('base64') };
}

async function captureImplementation(
  browser: import('@playwright/test').Browser,
  viewport: Viewport,
) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await seedAuthSession(page, 'ENGINEER');
  const state = createMockState();
  state.turns = [
    {
      questionUuid: '11111111-2222-4333-8444-555555555555',
      turnNo: 1,
      question: { id: 11, text: '手臂 1 无动作', role: 'USER', contentVersion: 1 },
      answer: {
        id: 12,
        text: '建议先检查取板台真空吸附与激光定位组件。',
        role: 'ASSISTANT',
        contentVersion: 1,
      },
      analysisStatus: 'SUCCEEDED',
      failureReason: null,
      analysisContentVersion: 1,
      completedAt: '2026-11-19T08:10:00.000',
      visualization: { sceneId: 'LITHO_WORKFLOW_V1', stage: 2, parts: buildParts('NORMAL') },
    },
  ] as never;
  await installGraphQLMock(page, state);
  await page.goto('/engineer/ai');
  await page.waitForTimeout(1500);
  const layout = await measureLayout(page, IMPL_SELECTORS);
  const model = await measureModelBox(page, '.ai-scene-canvas canvas');
  await prepareStableViewport(page, `实现-${viewport.name}`);
  const shot = await page.screenshot({ path: path.join(OUT_DIR, `实现-${viewport.name}.png`) });
  await context.close();
  return { layout, model, shot: shot.toString('base64') };
}

/** 并排叠图：左原型、右实现（同一视口） */
async function buildSideBySide(
  browser: import('@playwright/test').Browser,
  viewport: Viewport,
  prototypeShot: string,
  implementationShot: string,
) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const html = `<!doctype html><html><body style="margin:0;font-family:sans-serif;background:#fff">
    <div style="display:flex;gap:8px;padding:8px">
      <figure style="margin:0;flex:1"><figcaption style="font-size:14px;padding:4px">原型</figcaption>
        <img src="data:image/png;base64,${prototypeShot}" style="width:100%;border:1px solid #ccc" /></figure>
      <figure style="margin:0;flex:1"><figcaption style="font-size:14px;padding:4px">实现</figcaption>
        <img src="data:image/png;base64,${implementationShot}" style="width:100%;border:1px solid #ccc" /></figure>
    </div></body></html>`;
  await page.setContent(html);
  await page.waitForTimeout(300);
  await prepareStableViewport(page, `并排-${viewport.name}`);
  await page.screenshot({ path: path.join(OUT_DIR, `并排-${viewport.name}.png`), fullPage: true });
  await context.close();
}

test.describe('V44 原型 vs 实现 · 视觉对照采集', () => {
  test('四视口同口径采集：布局量测 + 模型投影包围盒 + 并排叠图', async () => {
    test.setTimeout(600_000);
    mkdirSync(OUT_DIR, { recursive: true });
    assertTargetsAbsent(OUT_DIR, [
      ...VIEWPORTS.flatMap((viewport) => [
        `原型-${viewport.name}.png`,
        `实现-${viewport.name}.png`,
        `并排-${viewport.name}.png`,
      ]),
      'v44-visual-compare.json',
    ]);
    const browser = await chromium.launch();
    const report: unknown[] = [];

    for (const viewport of VIEWPORTS) {
      const prototype = await capturePrototype(browser, viewport);
      const implementation = await captureImplementation(browser, viewport);
      await buildSideBySide(browser, viewport, prototype.shot, implementation.shot);

      const prototypeModel = prototype.model;
      const implementationModel = implementation.model;
      const delta =
        prototypeModel === null || implementationModel === null
          ? null
          : {
              centerX: Number(
                (
                  prototypeModel.x +
                  prototypeModel.width / 2 -
                  (implementationModel.x + implementationModel.width / 2)
                ).toFixed(2),
              ),
              centerY: Number(
                (
                  prototypeModel.y +
                  prototypeModel.height / 2 -
                  (implementationModel.y + implementationModel.height / 2)
                ).toFixed(2),
              ),
              widthRatio: Number((implementationModel.width / prototypeModel.width).toFixed(4)),
              heightRatio: Number((implementationModel.height / prototypeModel.height).toFixed(4)),
            };

      report.push({
        viewport: viewport.name,
        prototype: { layout: prototype.layout, model: prototypeModel },
        implementation: { layout: implementation.layout, model: implementationModel },
        modelDelta: delta,
      });
    }

    await browser.close();
    writeFileSync(
      path.join(OUT_DIR, 'v44-visual-compare.json'),
      JSON.stringify(report, null, 2),
      'utf8',
    );

    // 采集本身必须成功：原型与实现的场景区、画布与对话面板都要存在且唯一
    for (const entry of report as Array<{
      viewport: string;
      prototype: { layout: Metrics; model: ModelBox | null };
      implementation: { layout: Metrics; model: ModelBox | null };
      modelDelta: ModelDelta | null;
    }>) {
      for (const side of [entry.prototype, entry.implementation]) {
        for (const key of ['shell', 'scene', 'canvasWrap', 'panel', 'sceneHeader', 'sceneFooter']) {
          expect(side.layout[key], `${key} 必须存在且唯一`).not.toBeNull();
          expect(side.layout[key]?.count).toBe(1);
        }
      }

      // 硬门槛 1：模型中心偏差 ≤3%（按原型模型自身尺寸归一，避免小模型被放大）
      const delta = entry.modelDelta;
      expect(delta, `${entry.viewport} 必须能算出模型投影偏差`).not.toBeNull();
      const prototypeModel = entry.prototype.model;
      expect(prototypeModel, `${entry.viewport} 原型模型包围盒必须存在`).not.toBeNull();
      const centerXRatio =
        Math.abs(delta?.centerX ?? Number.POSITIVE_INFINITY) / prototypeModel!.width;
      const centerYRatio =
        Math.abs(delta?.centerY ?? Number.POSITIVE_INFINITY) / prototypeModel!.height;
      expect(
        centerXRatio,
        `${entry.viewport} 模型水平中心偏差应 ≤${THRESHOLDS.modelCenterRatio * 100}%`,
      ).toBeLessThanOrEqual(THRESHOLDS.modelCenterRatio);
      expect(
        centerYRatio,
        `${entry.viewport} 模型垂直中心偏差应 ≤${THRESHOLDS.modelCenterRatio * 100}%`,
      ).toBeLessThanOrEqual(THRESHOLDS.modelCenterRatio);

      // 硬门槛 2：模型投影宽高比偏差 ≤5%
      expect(
        Math.abs((delta?.widthRatio ?? 0) - 1),
        `${entry.viewport} 模型投影宽度比应 ≤${THRESHOLDS.modelSizeRatio * 100}%`,
      ).toBeLessThanOrEqual(THRESHOLDS.modelSizeRatio);
      expect(
        Math.abs((delta?.heightRatio ?? 0) - 1),
        `${entry.viewport} 模型投影高度比应 ≤${THRESHOLDS.modelSizeRatio * 100}%`,
      ).toBeLessThanOrEqual(THRESHOLDS.modelSizeRatio);

      // 硬门槛 3：关键区块的边界位置与高度偏差 ≤8px
      for (const key of [
        'pageHeader',
        'sceneHeader',
        'canvasWrap',
        'sceneFooter',
        'scene',
        'panel',
      ]) {
        const prototypeRect = entry.prototype.layout[key]?.rect;
        const implementationRect = entry.implementation.layout[key]?.rect;
        expect(prototypeRect, `${entry.viewport} 原型 ${key} 必须可量测`).not.toBeNull();
        expect(implementationRect, `${entry.viewport} 实现 ${key} 必须可量测`).not.toBeNull();
        expect(
          Math.abs((implementationRect?.y ?? 0) - (prototypeRect?.y ?? 0)),
          `${entry.viewport} ${key} 顶部位置偏差应 ≤${THRESHOLDS.layoutDeltaPx}px`,
        ).toBeLessThanOrEqual(THRESHOLDS.layoutDeltaPx);
        expect(
          Math.abs((implementationRect?.height ?? 0) - (prototypeRect?.height ?? 0)),
          `${entry.viewport} ${key} 高度偏差应 ≤${THRESHOLDS.layoutDeltaPx}px`,
        ).toBeLessThanOrEqual(THRESHOLDS.layoutDeltaPx);
      }
    }
  });
});

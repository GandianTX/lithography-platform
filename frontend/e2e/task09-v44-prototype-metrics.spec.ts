// frontend/e2e/task09-v44-prototype-metrics.spec.ts

import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * V44 原型页的**三视口实测**（任务 09 第 6 项／A09-12 的对照基准）。
 *
 * 目的：候选侧度量（`task09-visual-metrics.spec.ts`）需要有**同口径**的原型基线，
 * 否则"与 V44 一致"只是没有对照的空话。本规格在**真实 Chromium** 里打开仓内原型
 * （`docs/plan/01-光刻维护平台-DemoV44-中英文切换.html`），量同一组指标：
 * 主标题字号／行高、卡片圆角、卡片体内边距、整页横向溢出。
 *
 * 纪律：
 * - 原型文件在 `docs/plan/` 下（**本地计划目录，不入库**）：文件缺失即**跳过**
 *   并如实说明，不得伪造基线数值；
 * - 只**度量**，不修改原型；
 * - 每个视口只加载一次原型文件（近 30MB 单文件应用，反复整页加载很慢），
 *   三个路由用 hash 路由切换。
 */

const EVIDENCE_DIR = process.env.TASK09_EVIDENCE_DIR ?? '/tmp/task09-evidence';
mkdirSync(EVIDENCE_DIR, { recursive: true });

const PROTOTYPE_PATH = fileURLToPath(
  new URL('../../docs/plan/01-光刻维护平台-DemoV44-中英文切换.html', import.meta.url),
);

const VIEWPORTS = [
  { label: '1440x900', width: 1440, height: 900 },
  { label: '1366x768', width: 1366, height: 768 },
  { label: '390x844', width: 390, height: 844 },
] as const;

/** 原型路由 → 候选页对照关系 */
const ROUTES = [
  {
    label: 'engineer-data-center',
    hash: '#/engineer/data-center',
    candidate: '/engineer/record-packages',
  },
  {
    label: 'engineer-conflicts',
    hash: '#/engineer/conflicts/',
    candidate: '/engineer/sync-conflicts',
  },
  { label: 'local-settings', hash: '#/local/settings', candidate: '/local-settings' },
] as const;

type PrototypeMetric = {
  pageTitleFontSize: string;
  pageTitleLineHeight: string;
  cardRadius: string;
  cardBodyPadding: string;
  cardCount: number;
  documentClientWidth: number;
  documentScrollWidth: number;
};

test.describe('V44 原型页三视口度量（对照基准）', () => {
  test.skip(
    !existsSync(PROTOTYPE_PATH),
    `原型文件不在仓内（docs/plan 被 .gitignore 忽略）：${PROTOTYPE_PATH} —— 本轮无原型基线，如实记为未测`,
  );

  for (const viewport of VIEWPORTS) {
    test(`V44 原型 @ ${viewport.label}：标题／卡片／横溢实测`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const baseUrl = `file://${PROTOTYPE_PATH}`;

      const measured: Record<string, PrototypeMetric> = {};
      for (const route of ROUTES) {
        await page.goto(`${baseUrl}${route.hash}`);
        await page.waitForLoadState('domcontentloaded');
        // 原型是单文件应用：等主标题渲染出来再量
        await page.waitForSelector('.page-title', { timeout: 60_000 });
        await page.waitForTimeout(300);

        const metric = await page.evaluate<PrototypeMetric>(() => {
          const root = document.documentElement;
          const title = document.querySelector('.page-title');
          const titleStyle = title === null ? null : window.getComputedStyle(title);
          const card = document.querySelector('.ant-card');
          const cardStyle = card === null ? null : window.getComputedStyle(card);
          const cardBody = document.querySelector('.ant-card-body');
          const cardBodyStyle = cardBody === null ? null : window.getComputedStyle(cardBody);
          return {
            pageTitleFontSize: titleStyle?.fontSize ?? '',
            pageTitleLineHeight: titleStyle?.lineHeight ?? '',
            cardRadius: cardStyle?.borderRadius ?? '',
            cardBodyPadding: cardBodyStyle?.padding ?? '',
            cardCount: document.querySelectorAll('.ant-card').length,
            documentClientWidth: root.clientWidth,
            documentScrollWidth: root.scrollWidth,
          };
        });
        measured[route.label] = metric;
      }

      writeFileSync(
        `${EVIDENCE_DIR}/v44-prototype-metrics-${viewport.label}.json`,
        JSON.stringify(
          {
            source: PROTOTYPE_PATH,
            viewport: viewport.label,
            routes: ROUTES.map((route) => ({ ...route, metric: measured[route.label] })),
          },
          null,
          2,
        ),
      );

      // 原型在窄屏会整页横溢（任务书明确要求**正式页面**不得横溢）：
      // 这里只记录事实，不把原型的横溢当成候选页的失败判据。
      for (const route of ROUTES) {
        const metric = measured[route.label];
        expect(metric, `${route.label} @ ${viewport.label} 应有度量结果`).not.toBeUndefined();
        expect(
          metric.pageTitleFontSize,
          `${route.label} @ ${viewport.label} 原型主标题应有字号`,
        ).not.toBe('');
      }
    });
  }
});

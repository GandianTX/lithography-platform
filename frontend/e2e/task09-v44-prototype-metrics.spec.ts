// frontend/e2e/task09-v44-prototype-metrics.spec.ts

import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * V44 原型页的**三视口实测**（任务 09 第 11 项的对照基准）。
 *
 * 目的：候选侧度量（`task09-visual-metrics.spec.ts`）需要有**同口径**的原型基线，
 * 否则"与 V44 一致"只是没有对照的空话。本规格在**真实 Chromium** 里打开仓内原型
 * （`docs/plan/01-光刻维护平台-DemoV44-中英文切换.html`），量同一组指标：
 * 主标题字号／行高、卡片圆角、卡片体内边距、卡片纵向间距、整页横向溢出。
 *
 * ── 路由定位的实测更正（第 11 项"定位对应精确 selector"）──
 * 前一版把 `#/engineer/conflicts/` 当作"资料冲突页"基线，实测**该路由并不渲染冲突页**：
 * 直接访问会回落到工程师工作台（`cardCount=0`），带任意 id 则落到"无访问权限"。
 * 原型的冲突页真实入口是 `#/engineer/data-center` 内「处理冲突」按钮，
 * 跳转目标形如 `#/engineer/conflicts/FR-2905`（标题「版本冲突处理」，2 张卡）。
 * 故本规格改为**从真实入口点击进入**后再量，不再用臆测的路由。
 *
 * 纪律：
 * - 原型文件在 `docs/plan/` 下（**本地计划目录，不入库**）：文件缺失即**跳过**
 *   并如实说明，不得伪造基线数值；
 * - 只**度量**，不修改原型；
 * - 每个视口只加载一次原型文件（近 30MB 单文件应用，反复整页加载很慢），
 *   三个路由用 hash 路由切换；冲突页需点击进入，故在原型页面上完成。
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
    label: 'admin-data-center',
    hash: '#/admin/data-center',
    candidate: '/local-backup',
  },
  { label: 'local-settings', hash: '#/local/settings', candidate: '/local-settings' },
] as const;

/**
 * 冲突页：不能直接用 hash 路由进入（会回落工作台或落到无权限），
 * 必须从 `#/engineer/data-center` 的「处理冲突」按钮点击进入。
 */
const CONFLICT_ENTRY = {
  label: 'engineer-conflicts',
  fromHash: '#/engineer/data-center',
  triggerText: '处理冲突',
  candidate: '/engineer/sync-conflicts',
} as const;

type PrototypeMetric = {
  pageTitleFontSize: string;
  pageTitleLineHeight: string;
  cardRadius: string;
  cardBodyPadding: string;
  cardCount: number;
  /** `.page-stack` 的纵向间距（卡片间距） */
  pageStackGap: string;
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

      const readMetrics = async (): Promise<PrototypeMetric> =>
        page.evaluate(() => {
          const root = document.documentElement;
          const title = document.querySelector('.page-title');
          const titleStyle = title === null ? null : window.getComputedStyle(title);
          const card = document.querySelector('.ant-card');
          const cardStyle = card === null ? null : window.getComputedStyle(card);
          const cardBody = document.querySelector('.ant-card-body');
          const cardBodyStyle = cardBody === null ? null : window.getComputedStyle(cardBody);
          const pageStack = document.querySelector('.page-stack');
          return {
            pageTitleFontSize: titleStyle?.fontSize ?? '',
            pageTitleLineHeight: titleStyle?.lineHeight ?? '',
            cardRadius: cardStyle?.borderRadius ?? '',
            cardBodyPadding: cardBodyStyle?.padding ?? '',
            cardCount: document.querySelectorAll('.ant-card').length,
            pageStackGap:
              pageStack === null ? '' : window.getComputedStyle(pageStack).rowGap,
            documentClientWidth: root.clientWidth,
            documentScrollWidth: root.scrollWidth,
          };
        });

      for (const route of ROUTES) {
        await page.goto(`${baseUrl}${route.hash}`);
        await page.waitForLoadState('domcontentloaded');
        // 原型是单文件应用：等主标题渲染出来再量
        await page.waitForSelector('.page-title', { timeout: 60_000 });
        await page.waitForTimeout(300);
        measured[route.label] = await readMetrics();
      }

      // 冲突页：从真实入口点击进入（直接用 hash 路由进不去，见文件头说明）
      await page.goto(`${baseUrl}${CONFLICT_ENTRY.fromHash}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForSelector('.page-title', { timeout: 60_000 });
      await page.waitForTimeout(300);
      const conflictTrigger = page.getByRole('button', { name: CONFLICT_ENTRY.triggerText });
      const triggerCount = await conflictTrigger.count();
      let conflictReachable = true;
      if (triggerCount === 0) {
        // 入口不可达时**如实记录**空度量，不伪造原型基线
        conflictReachable = false;
        measured[CONFLICT_ENTRY.label] = {
          pageTitleFontSize: '',
          pageTitleLineHeight: '',
          cardRadius: '',
          cardBodyPadding: '',
          cardCount: 0,
          pageStackGap: '',
          documentClientWidth: 0,
          documentScrollWidth: 0,
        };
      } else {
        await conflictTrigger.first().click();
        await page.waitForSelector('.page-title', { timeout: 60_000 });
        await page.waitForTimeout(300);
        measured[CONFLICT_ENTRY.label] = await readMetrics();
      }

      writeFileSync(
        `${EVIDENCE_DIR}/v44-prototype-metrics-${viewport.label}.json`,
        JSON.stringify(
          {
            source: PROTOTYPE_PATH,
            viewport: viewport.label,
            routes: [
              ...ROUTES.map((route) => ({ ...route, metric: measured[route.label] })),
              {
                label: CONFLICT_ENTRY.label,
                candidate: CONFLICT_ENTRY.candidate,
                enteredBy: `点击 ${CONFLICT_ENTRY.fromHash} 的「${CONFLICT_ENTRY.triggerText}」按钮`,
                reachable: conflictReachable,
                metric: measured[CONFLICT_ENTRY.label],
              },
            ],
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
        // 卡片体（.ant-card-body）内边距是 G28 的原型侧基线
        expect(
          metric.cardBodyPadding,
          `${route.label} @ ${viewport.label} 原型卡片体应有内边距（.ant-card-body）`,
        ).not.toBe('');
        // 卡片纵向间距（任务书基线 20px）
        expect(
          metric.pageStackGap,
          `${route.label} @ ${viewport.label} 原型 .page-stack 应有纵向间距`,
        ).not.toBe('');
      }
    });
  }
});

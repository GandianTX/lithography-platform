// frontend/e2e/task09-local-pages-visual.spec.ts

import { expect, type Page, type Route,test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

import { seedAuthSession } from './helpers/auth-session-seed';
import { captureStableViewport } from './helpers/visual-evidence';

/**
 * 任务 09 新增页面的**真实浏览器**三视口量测（总计划 S6 第 2 条中可在本环境完成的部分）。
 *
 * 事实与边界：
 * - 本机 **Playwright chromium 已就绪**（`~/.cache/ms-playwright/chromium-1234`），
 *   因此三视口（1440×900／1366×768／390×844）的 computed style、bounding rect、
 *   页面与表格 overflow、截图**可以在本环境采集**（此前"本环境无浏览器"的记录已过期）；
 * - 与 V44 原型的**精确路由／selector 对照**仍做不了：原型 HTML 不在仓库（需维护者提供），
 *   本文件因此只做"实现侧"量测与可用性断言，不伪造原型对照结论；
 * - mock-only：不连真实后端、不写共享库（会话用 sessionStorage 预置，GraphQL 全部拦截）。
 */

/** 证据输出目录（不入库：截图与 JSON 属生成产物） */
const EVIDENCE_DIR = process.env.TASK09_EVIDENCE_DIR ?? '/tmp/task09-evidence';

mkdirSync(EVIDENCE_DIR, { recursive: true });

const VIEWPORTS = [
  { label: '1440x900', width: 1440, height: 900 },
  { label: '1366x768', width: 1366, height: 768 },
  { label: '390x844', width: 390, height: 844 },
] as const;

const PAGES = [
  { label: 'record-packages', path: '/engineer/record-packages' },
  { label: 'sync-conflicts', path: '/engineer/sync-conflicts' },
] as const;

/** 记录包与冲突页用到的 GraphQL 操作（其余操作返回空数据，页面按真实空态渲染） */
async function installLocalRuntimeMocks(page: Page): Promise<void> {
  await page.route('**/graphql', async (route: Route) => {
    const payload = route.request().postDataJSON() as { operationName?: string };
    const operation = payload.operationName ?? '';
    let data: Record<string, unknown> = {};

    if (operation === 'SyncConflicts') {
      data = {
        syncConflicts: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 10,
          truncated: false,
        },
      };
    } else if (operation === 'LocalRuntimeStatus') {
      data = {
        localRuntimeStatus: {
          scope: { role: 'ENGINEER', organizationId: 9, adminLevel: null },
          companies: [],
          authorizations: [],
          tasks: null,
        },
      };
    }

    await route.fulfill({
      body: JSON.stringify({ data }),
      contentType: 'application/json',
      status: 200,
    });
  });
}

test.describe('任务 09 本地页面的三视口可用性', () => {
  for (const target of PAGES) {
    for (const viewport of VIEWPORTS) {
      test(`${target.label} @ ${viewport.label}：无整页横向溢出，页面可读`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await seedAuthSession(page, 'ENGINEER');
        await installLocalRuntimeMocks(page);

        await page.goto(target.path);
        await page.waitForLoadState('domcontentloaded');
        // 视觉证据统一走 helper（含"干净工作区"前置与整页溢出断言），不在 spec 里直接截图
        const evidence = await captureStableViewport(page, {
          fileName: `task09-${target.label}-${viewport.label}.png`,
          filePath: `${EVIDENCE_DIR}/task09-${target.label}-${viewport.label}.png`,
        });

        const metrics = await page.evaluate(() => {
          const root = document.documentElement;
          const tables = Array.from(document.querySelectorAll('table'));
          return {
            documentClientWidth: root.clientWidth,
            documentScrollWidth: root.scrollWidth,
            tableOverflows: tables.map((table) => {
              const parent = table.parentElement;
              if (parent === null) {
                return 0;
              }
              return Math.max(0, table.scrollWidth - parent.clientWidth);
            }),
            headings: Array.from(document.querySelectorAll('h1, h2, h3'))
              .map((node) => (node.textContent ?? '').trim())
              .filter((text) => text.length > 0),
          };
        });

        expect(
          metrics.documentScrollWidth - metrics.documentClientWidth,
          `${target.label} @ ${viewport.label} 不应出现整页横向溢出`,
        ).toBeLessThanOrEqual(0);
        expect(
          evidence.documentScrollWidth - evidence.documentClientWidth,
          `${target.label} @ ${viewport.label} 截图时刻不应出现整页横向溢出`,
        ).toBeLessThanOrEqual(0);
        for (const overflow of metrics.tableOverflows) {
          expect(
            overflow,
            `${target.label} @ ${viewport.label} 表格不应横向溢出容器`,
          ).toBeLessThanOrEqual(0);
        }
        expect(
          metrics.headings.length,
          `${target.label} @ ${viewport.label} 应有可读标题`,
        ).toBeGreaterThan(0);

        // 证据 JSON（视口、滚动、溢出、git SHA）落盘，便于逐张对账
        writeFileSync(
          `${EVIDENCE_DIR}/task09-${target.label}-${viewport.label}.json`,
          JSON.stringify({ ...evidence, metrics }, null, 2),
        );
      });
    }
  }
});

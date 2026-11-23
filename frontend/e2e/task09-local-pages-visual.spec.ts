// frontend/e2e/task09-local-pages-visual.spec.ts

import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

import { seedAuthSession } from './helpers/auth-session-seed';
import {
  installLocalRuntimeMocks,
  TASK09_TABLE_OVERFLOW_POLICY,
  TASK09_VISUAL_PAGES,
  TASK09_VISUAL_VIEWPORTS,
} from './helpers/task09-local-runtime-mocks';
import { buildEvidenceFileName, captureStableViewport } from './helpers/visual-evidence';

/**
 * 任务 09 候选页面的**提交级截图**证据采集。
 *
 * 与 `task09-visual-metrics.spec.ts` 的分工：
 * - 那份规格采集**度量**（computed style／bounding rect／overflow／卡片面基线）并断言，不截图；
 * - 本规格采集**截图**（提交级最终证据）⇒ 必须经 `captureStableViewport`，
 *   它内含**干净工作区守卫**（`assertCleanWorkspaceForEvidence`）：
 *   工作区有未提交改动时**失败关闭**，不得产出伪关联 SHA 的截图。
 *
 * 本轮（第七轮）修复：
 * - 上一轮截图只覆盖**两页**（record-packages／sync-conflicts），而度量覆盖**四页**
 *   ⇒ "度量过的页面"与"截图过的页面"口径不一致（潜在假通过）。
 *   现改为两份规格共用 `helpers/task09-local-runtime-mocks.ts` 的**同一份页面清单**。
 * - 文件名改用基准模板（`frontend/docs/gkj-visual-baseline.md` §1）：
 *   `{区域}-viewport-{宽}x{高}-scale-{档位}-role-{角色}-zoom-100-{日期}-{时分}.png`。
 *
 * 事实与边界：
 * - 本机 Playwright chromium 已就绪，三视口（1440×900／1366×768／390×844）可真实采集；
 * - mock-only：不连真实后端、不写共享库（会话用 sessionStorage 预置，GraphQL 全部拦截）。
 */

const EVIDENCE_DIR = process.env.TASK09_EVIDENCE_DIR ?? '/tmp/task09-evidence';

/** 截图规格采集到的页面度量（与度量规格字段同源，判定口径共用共享 helper） */
type MetricsShape = {
  documentClientWidth: number;
  documentScrollWidth: number;
  tableOverflows: number[];
  headings: string[];
  dataCardCount: number;
};

mkdirSync(EVIDENCE_DIR, { recursive: true });

test.describe('任务 09 候选页面的提交级截图', () => {
  for (const target of TASK09_VISUAL_PAGES) {
    for (const viewport of TASK09_VISUAL_VIEWPORTS) {
      test(`${target.label} @ ${viewport.label}：稳定截图（提交级）`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await seedAuthSession(page, 'ENGINEER');
        const consoleErrors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') {
            consoleErrors.push(message.text().slice(0, 300));
          }
        });
        page.on('pageerror', (error) => {
          consoleErrors.push(`pageerror: ${error.message.slice(0, 300)}`);
        });
        await installLocalRuntimeMocks(page);

        await page.goto(target.path);
        await page.waitForLoadState('domcontentloaded');
        // 等主标题出现（页面内容区渲染完成的判据）
        await page.waitForSelector('h1, h2', { timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(200);

        // 提交级证据命名模板（基准 §1）
        const fileName = buildEvidenceFileName({
          area: `task09-${target.label}`,
          capturedAt: new Date(),
          role: 'engineer',
          viewportLabel: viewport.label,
        });

        // 截图必须经 helper（含"干净工作区"前置与整页溢出断言），不在 spec 里直接截图
        const evidence = await captureStableViewport(page, {
          fileName,
          filePath: `${EVIDENCE_DIR}/${fileName}`,
        });

        const metrics = await page.evaluate<MetricsShape, typeof TASK09_TABLE_OVERFLOW_POLICY>(
          (policy) => {
            const root = document.documentElement;
            const tables = Array.from(document.querySelectorAll('table'));
            return {
              documentClientWidth: root.clientWidth,
              documentScrollWidth: root.scrollWidth,
              // 判定口径与度量规格**同源**（共享 helper）：
              // 表格只允许在自身可横向滚动的容器内超宽；超宽且找不到可滚动祖先才算真实溢出。
              tableOverflows: tables.map((table) => {
                const parent = table.parentElement;
                if (parent === null) {
                  return 0;
                }
                const overflow = Math.max(0, table.scrollWidth - parent.clientWidth);
                if (overflow === 0) {
                  return 0;
                }
                let node: HTMLElement | null = parent;
                let hasScrollableAncestor = false;
                while (node !== null) {
                  const overflowX = window.getComputedStyle(node).overflowX;
                  if (overflowX === 'auto' || overflowX === 'scroll') {
                    hasScrollableAncestor = true;
                    break;
                  }
                  node = node.parentElement;
                }
                // 判定口径同源于共享 helper 的策略常量
                // （Playwright 不能序列化函数参数 ⇒ 浏览器侧内联实现同一口径）
                if (policy.allowScrollableAncestor && hasScrollableAncestor) {
                  return 0;
                }
                return overflow;
              }),
              headings: Array.from(document.querySelectorAll('h1, h2, h3'))
                .map((node) => (node.textContent ?? '').trim())
                .filter((text) => text.length > 0),
              dataCardCount: document.querySelectorAll('.data-card').length,
            };
          },
          TASK09_TABLE_OVERFLOW_POLICY,
        );

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

        // 卡片面声明与度量规格同源（REQUIRED 缺失即失败；NONE 显式断言为 0）
        if (target.card === 'REQUIRED') {
          expect(
            metrics.dataCardCount,
            `${target.label} @ ${viewport.label} 应存在公共卡片面 .data-card（${target.cardNote}）`,
          ).toBeGreaterThan(0);
        } else {
          expect(
            metrics.dataCardCount,
            `${target.label} @ ${viewport.label} 声明为无卡片面（${target.cardNote}）`,
          ).toBe(0);
        }

        // 截图证据不得带未预期的控制台错误（页面失真时截图不可作为证据）
        expect(
          consoleErrors,
          `${target.label} @ ${viewport.label} 不应有控制台错误或页面异常`,
        ).toEqual([]);

        // 证据 JSON（视口、滚动、溢出、git SHA）落盘，便于逐张对账
        writeFileSync(
          `${EVIDENCE_DIR}/${fileName.replace(/\.png$/, '.json')}`,
          JSON.stringify(
            {
              ...evidence,
              page: target.path,
              consoleErrors,
              metrics,
              cardExpectation: target.card,
              cardNote: target.cardNote,
              v44Counterpart: target.v44Counterpart,
            },
            null,
            2,
          ),
        );
      });
    }
  }
});

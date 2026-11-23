// frontend/e2e/task09-visual-metrics.spec.ts

import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

import { seedAuthSession } from './helpers/auth-session-seed';
import {
  installLocalRuntimeMocks,
  TASK09_TABLE_OVERFLOW_POLICY,
  TASK09_VISUAL_PAGES,
  TASK09_VISUAL_VIEWPORTS,
} from './helpers/task09-local-runtime-mocks';

/**
 * 任务 09 四类页面的**三视口度量**（总计划第 14 项）。
 *
 * 与 `task09-local-pages-visual.spec.ts` 的分工：
 * - 那份规格采集**截图**（提交级证据），因此带"干净工作区"前置守卫：
 *   工作区有未提交改动时**必须失败**（不得产出伪关联 SHA 的截图）；
 * - 本规格只采集**度量**（computed style／bounding rect／overflow／标题层级）并**断言**，
 *   **不截图**，因此不受该守卫约束，可在未提交工作区运行；
 * - 两者合起来覆盖第 14 项要求的"度量可复核"与"截图需提交级干净工作区"。
 *
 * ── 上一轮的"假通过"与本轮的修法 ──
 * 上一轮用 `.ant-card-body` 量"卡片内边距／圆角"，而候选页**从不渲染** antd Card
 * （卡片语言真源是 `src/index.css` 的 `.data-card`／`--panel-*` token），
 * 于是选择器落空 ⇒ 度量为空串 ⇒ 断言"元素缺失也通过"（假通过）。
 * 本轮改为：
 * 1. 量**真实卡片面** `.data-card`（本仓卡片语言真源）；
 * 2. 每页**显式声明**是否应当存在卡片面（`REQUIRED` / `NONE`）：
 *    - `REQUIRED`：卡片缺失即**失败**（不再允许空值通过）；
 *    - `NONE`：显式断言"无卡片面"，并把理由写进证据（属**明确不适用**，不是静默跳过）；
 * 3. 把 **V44 原型基线**与**本仓卡片语言基线**同时写进证据文件，
 *    差异（卡片内边距 24px vs 16px）**显式登记**，不靠空值蒙混。
 *
 * 度量口径（V44 对照）：
 * - 主标题字号／行高（原型：24px／32px）；
 * - 卡片内边距与圆角（原型 `.ant-card-body` 24px／`.ant-card` 14px；
 *   本仓 `.data-card` 16px／14px，基线真源见 `src/index.css` 的 `--panel-*`）；
 * - 表单头与表格容器宽度（表格只在自身容器内横向滚动，**页面不得横溢**）；
 * - 三个视口：1440×900／1366×768／390×844。
 *
 * mock-only：不连真实后端、不写共享开发库（会话用 sessionStorage 预置，GraphQL 全部拦截）。
 */

const EVIDENCE_DIR = process.env.TASK09_EVIDENCE_DIR ?? '/tmp/task09-evidence';
mkdirSync(EVIDENCE_DIR, { recursive: true });

/** V44 原型（`docs/plan/01-光刻维护平台-DemoV44-中英文切换.html`）实测基线 */
const V44_BASELINE = {
  pageTitleFontSize: '24px',
  pageTitleLineHeight: '32px',
  cardRadius: '14px',
  cardBodyPadding: '24px',
} as const;

/** 本仓卡片语言基线（`src/index.css` 的 `.data-card` / `--panel-*` token 真源） */
const CANDIDATE_CARD_BASELINE = {
  selector: '.data-card',
  radius: '14px',
  padding: '16px',
} as const;

type Metric = {
  documentClientWidth: number;
  documentScrollWidth: number;
  tableOverflows: number[];
  headings: string[];
  titleFontSize: string;
  titleLineHeight: string;
  /** 公共卡片面（.data-card）数量 */
  cardCount: number;
  /** 首张公共卡片面的内边距与圆角 */
  cardPadding: string;
  cardRadius: string;
  /** antd Card 面数量（候选页按设计为 0，用于说明上一轮为何量不到） */
  antdCardBodyCount: number;
};

test.describe('任务 09 四类页面的三视口度量', () => {
  for (const target of TASK09_VISUAL_PAGES) {
    for (const viewport of TASK09_VISUAL_VIEWPORTS) {
      test(`${target.label} @ ${viewport.label}：度量与溢出断言`, async ({ page }) => {
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

        const metrics = await page.evaluate<Metric, typeof TASK09_TABLE_OVERFLOW_POLICY>(
          (policy) => {
            const root = document.documentElement;
            const tables = Array.from(document.querySelectorAll('table'));
            const title = document.querySelector('h1, h2');
            const titleStyle = title === null ? null : window.getComputedStyle(title);
            const cards = Array.from(document.querySelectorAll('.data-card'));
            const card = cards[0] ?? null;
            const cardStyle = card === null ? null : window.getComputedStyle(card);
            return {
              documentClientWidth: root.clientWidth,
              documentScrollWidth: root.scrollWidth,
              // 表格只允许在**自身可横向滚动的容器内**超宽（窄屏按 V44 要求：
              // 表格在自身容器横向滚动，页面不横溢）⇒ 记录"是否找到可滚动祖先"。
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
              titleFontSize: titleStyle?.fontSize ?? '',
              titleLineHeight: titleStyle?.lineHeight ?? '',
              cardCount: cards.length,
              cardPadding: cardStyle?.padding ?? '',
              cardRadius: cardStyle?.borderRadius ?? '',
              antdCardBodyCount: document.querySelectorAll('.ant-card-body').length,
            };
          },
          TASK09_TABLE_OVERFLOW_POLICY,
        );

        // 页面不得整页横溢（窄屏尤其）
        expect(
          metrics.documentScrollWidth - metrics.documentClientWidth,
          `${target.label} @ ${viewport.label} 不应出现整页横向溢出`,
        ).toBeLessThanOrEqual(0);
        // 表格只在自身容器内滚动，不得溢出容器
        for (const overflow of metrics.tableOverflows) {
          expect(
            overflow,
            `${target.label} @ ${viewport.label} 表格不应横向溢出容器`,
          ).toBeLessThanOrEqual(0);
        }
        expect(
          metrics.headings.length,
          `${target.label} @ ${viewport.label} 应有可读标题（控制台错误：${consoleErrors.slice(0, 2).join(' | ')}）`,
        ).toBeGreaterThan(0);
        // 主标题字号／行高与 V44 基线一致
        expect(
          metrics.titleFontSize,
          `${target.label} @ ${viewport.label} 主标题字号应与 V44 基线一致`,
        ).toBe(V44_BASELINE.pageTitleFontSize);
        expect(
          metrics.titleLineHeight,
          `${target.label} @ ${viewport.label} 主标题行高应与 V44 基线一致`,
        ).toBe(V44_BASELINE.pageTitleLineHeight);

        // 卡片面：显式声明 ⇒ 缺失即失败（不再允许"量不到也通过"）
        if (target.card === 'REQUIRED') {
          expect(
            metrics.cardCount,
            `${target.label} @ ${viewport.label} 应存在公共卡片面 ${CANDIDATE_CARD_BASELINE.selector}（${target.cardNote}）`,
          ).toBeGreaterThan(0);
          expect(
            metrics.cardRadius,
            `${target.label} @ ${viewport.label} 卡片圆角应与本仓卡片语言基线一致`,
          ).toBe(CANDIDATE_CARD_BASELINE.radius);
          expect(
            metrics.cardPadding,
            `${target.label} @ ${viewport.label} 卡片内边距应与本仓卡片语言基线一致`,
          ).toBe(CANDIDATE_CARD_BASELINE.padding);
        } else {
          expect(
            metrics.cardCount,
            `${target.label} @ ${viewport.label} 声明为无卡片面（${target.cardNote}）；若页面结构已变更，请同步更新本声明`,
          ).toBe(0);
        }

        // 未预期的控制台错误／页面异常必须可见（本轮已修掉 antd Drawer width 弃用告警）
        expect(
          consoleErrors,
          `${target.label} @ ${viewport.label} 不应有控制台错误或页面异常`,
        ).toEqual([]);

        writeFileSync(
          `${EVIDENCE_DIR}/metrics-${target.label}-${viewport.label}.json`,
          JSON.stringify(
            {
              page: target.path,
              viewport: viewport.label,
              consoleErrors,
              ...metrics,
              comparison: {
                v44Counterpart: target.v44Counterpart,
                v44Baseline: V44_BASELINE,
                candidateCardBaseline: CANDIDATE_CARD_BASELINE,
                cardExpectation: target.card,
                cardNote: target.cardNote,
                deviations: [
                  metrics.cardCount > 0
                    ? `卡片内边距：本仓 ${CANDIDATE_CARD_BASELINE.padding}（src/index.css 的 --panel-* token 真源，另有视觉规格固化） vs V44 原型 ${V44_BASELINE.cardBodyPadding} ⇒ 已知偏离，按仓内卡片语言基线取值`
                    : '该页无卡片面 ⇒ 卡片内边距／圆角对照项不适用',
                ],
              },
            },
            null,
            2,
          ),
        );
      });
    }
  }
});

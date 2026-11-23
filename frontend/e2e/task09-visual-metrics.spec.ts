// frontend/e2e/task09-visual-metrics.spec.ts

import { expect, type Page, type Route, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

import { seedAuthSession } from './helpers/auth-session-seed';

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

const VIEWPORTS = [
  { label: '1440x900', width: 1440, height: 900 },
  { label: '1366x768', width: 1366, height: 768 },
  { label: '390x844', width: 390, height: 844 },
] as const;

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

/**
 * 每页的卡片面声明。
 *
 * - `REQUIRED`：该页必须渲染公共卡片面（`.data-card`），缺失即失败；
 * - `NONE`：该页**按设计**没有卡片面（表格／表单／抽屉布局），显式断言为 0，
 *   并在证据里写明"不适用"的理由（页面结构变更时必须同步更新本声明）。
 */
const PAGES = [
  {
    label: 'record-packages',
    path: '/engineer/record-packages',
    card: 'NONE',
    cardNote: '记录包页为 Tabs＋表单＋结果表格布局，不使用卡片面；V44 无对应页面（其入口在 #/engineer/data-center）',
    v44Counterpart: '#/engineer/data-center',
  },
  {
    label: 'sync-conflicts',
    path: '/engineer/sync-conflicts',
    card: 'NONE',
    cardNote: '同步冲突页为清单＋抽屉布局，不使用卡片面；V44 对应页 #/engineer/conflicts/',
    v44Counterpart: '#/engineer/conflicts/',
  },
  {
    label: 'local-settings',
    path: '/local-settings',
    card: 'REQUIRED',
    cardNote: '本地设置页用公共 DataCard（.data-card）承载分区卡片；V44 对应页 #/local/settings',
    v44Counterpart: '#/local/settings',
  },
  {
    label: 'local-backup',
    path: '/local-backup',
    card: 'REQUIRED',
    cardNote: '备份与恢复页用公共 DataCard（.data-card）承载分区卡片；V44 本地设置页合并了设备与计划入口',
    v44Counterpart: '#/local/settings',
  },
] as const;

async function installLocalRuntimeMocks(page: Page): Promise<void> {
  await page.route('**/graphql', async (route: Route) => {
    const payload = route.request().postDataJSON() as { operationName?: string };
    const operation = payload.operationName ?? '';
    let data: Record<string, unknown> = {};

    if (operation === 'SyncConflicts') {
      data = {
        syncConflicts: { items: [], total: 0, page: 1, pageSize: 10, truncated: false },
      };
    } else if (operation === 'LocalBackupRecords') {
      data = {
        localBackupRecords: {
          items: [
            {
              backupId: 'bk-1',
              organizationId: 9,
              runId: 1,
              installationId: 'inst-1',
              triggerType: 'MANUAL',
              runStatus: 'SUCCEEDED',
              startedAt: '2026-11-20T08:00:00.000Z',
              finishedAt: '2026-11-20T08:01:00.000Z',
              createdAt: '2026-11-20T08:00:00.000Z',
              byteSize: '2048',
              localStatus: 'AVAILABLE',
              localPackageRetained: true,
              cloudStatus: 'AVAILABLE',
              cloudReceiptPresent: true,
              manifestChecksum: 'a'.repeat(64),
              verifiedAt: '2026-11-20T08:01:00.000Z',
              retentionUntil: '2026-12-20T08:00:00.000Z',
              failureReason: null,
              localCleanupError: null,
              attemptCount: 1,
              lastAttemptAt: '2026-11-20T08:02:00.000Z',
              deletedAt: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 10,
        },
      };
    } else if (operation === 'LocalBackupCloudPackages') {
      data = {
        localBackupCloudPackages: {
          organizationId: 9,
          packages: [
            {
              packageId: 'bk-1',
              organizationId: 9,
              backupId: 'bk-1',
              createdAt: '2026-11-20T08:02:00.000Z',
              byteSize: '2048',
              checksumSha256: 'a'.repeat(64),
            },
          ],
        },
      };
    } else if (operation === 'LocalBackupSettings') {
      data = {
        // 设置按"公司 × 设备"逐条返回（列表形态）
        localBackupSettings: [
          {
            organizationId: 9,
            installationId: 'inst-1',
            backupEnabled: true,
            backupIntervalHours: 72,
            nextBackupAt: '2026-11-23T08:00:00.000Z',
            lastAutoSuccessAt: '2026-11-20T08:00:00.000Z',
            lastAutoFailureAt: null,
            failureReason: null,
            autoUploadEnabled: false,
            planIntervalHours: 72,
            retentionDays: 30,
            lastRunStatus: 'SUCCEEDED',
            lastRunStartedAt: '2026-11-20T08:00:00.000Z',
            lastRunFinishedAt: '2026-11-20T08:01:00.000Z',
            lastAssetCloudStatus: 'PENDING',
            lastAssetLocalStatus: 'AVAILABLE',
          },
        ],
      };
    } else if (operation === 'LocalRestoreCapability') {
      data = { localRestoreCapability: { executionAvailable: false, reason: null } };
    } else if (operation === 'LocalRuntimeStatus') {
      // 载荷形状必须与 `localRuntimeStatus` 查询契约一致（否则 adapter 会拒绝映射，
      // 页面落到失败态 ⇒ 度量的是错误分支而不是真实页面）
      data = {
        localRuntimeStatus: {
          installationId: 'inst-1',
          localSiteName: '任务09 隔离演示机',
          mappedOrganizationId: 9,
          mappedOrganizationCode: 'CLIENT_DEFAULT',
          viewerRole: 'ENGINEER',
          scopeOrganizationId: 9,
          service: {
            apiStatus: 'UP',
            databaseStatus: 'UP',
            taskFactSource: '本地数据库',
            taskRecovery: '本地数据库',
          },
          storage: {
            businessFileDirectory: '/srv/lithography/business',
            businessFileDirectoryWritable: true,
            backupDirectory: '/srv/lithography/backups',
            backupDirectoryWritable: true,
          },
          tasks: {
            pendingUploadCount: 0,
            uploadingUploadCount: 0,
            failedUploadCount: 0,
            succeededUploadCount: 0,
            runningBackupCount: 0,
            lastBackupStartedAt: null,
            lastBackupFinishedAt: null,
          },
          companies: [],
          authorizations: [],
          generatedAt: '2026-11-23T08:00:00.000Z',
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
  for (const target of PAGES) {
    for (const viewport of VIEWPORTS) {
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

        const metrics = await page.evaluate<Metric>(() => {
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
              while (node !== null) {
                const overflowX = window.getComputedStyle(node).overflowX;
                if (overflowX === 'auto' || overflowX === 'scroll') {
                  return 0;
                }
                node = node.parentElement;
              }
              // 超宽且**没有**可横向滚动的祖先 ⇒ 真实溢出（页面会被撑开）
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
        });

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

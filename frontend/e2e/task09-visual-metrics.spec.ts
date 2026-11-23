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
 * 度量口径（V44 对照）：
 * - 主标题字号／行高（原型：24px）；
 * - 卡片内边距与圆角（原型：24px／14px）；
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

const PAGES = [
  { label: 'record-packages', path: '/engineer/record-packages' },
  { label: 'sync-conflicts', path: '/engineer/sync-conflicts' },
  { label: 'local-settings', path: '/local-settings' },
  { label: 'local-backup', path: '/local-backup' },
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

type Metric = {
  documentClientWidth: number;
  documentScrollWidth: number;
  tableOverflows: number[];
  headings: string[];
  titleFontSize: string;
  titleLineHeight: string;
  cardPadding: string;
  cardRadius: string;
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
          const card = document.querySelector('.ant-card-body');
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
            cardPadding: cardStyle?.padding ?? '',
            cardRadius: cardStyle?.borderRadius ?? '',
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
        writeFileSync(
          `${EVIDENCE_DIR}/metrics-${target.label}-${viewport.label}.json`,
          JSON.stringify(
            { page: target.path, viewport: viewport.label, consoleErrors, ...metrics },
            null,
            2,
          ),
        );
        expect(
          metrics.headings.length,
          `${target.label} @ ${viewport.label} 应有可读标题（控制台错误：${consoleErrors.slice(0, 2).join(' | ')}）`,
        ).toBeGreaterThan(0);
      });
    }
  }
});

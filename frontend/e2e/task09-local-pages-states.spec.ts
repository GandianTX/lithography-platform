// frontend/e2e/task09-local-pages-states.spec.ts

import { expect, type Page, test } from '@playwright/test';

import { seedAuthSession } from './helpers/auth-session-seed';
import {
  installLocalRuntimeMocks,
  type Task09MockOverrides,
} from './helpers/task09-local-runtime-mocks';

/**
 * 任务 09 候选页面的**逐态对照**（中英／长文案／空态／错误态／键盘／旧响应晚到）。
 *
 * 口径声明（**不得混淆**）：
 * - 本规格是 **mock-only**：会话用 sessionStorage 预置，GraphQL 全部被拦截；
 *   **不等于**真实后端走查（后者仍未验证）。
 * - 选择器全部取自**生产实现**的事实（不是猜的）：
 *   · 语言：localStorage 键 `ui-language`，`<html lang>` 随之变化（`i18n-provider.tsx`）；
 *   · 空态：antd Table 占位 `.ant-table-placeholder .ant-empty`（冲突页）、
 *     自研 `.empty-state`（本地设置／备份页）；
 *   · 错误态：自研 `.error-state`（本地设置／备份页）、冲突页用 `.ant-empty` 承载失败态；
 *   · 渲染期崩溃：路由级错误边界 `.error-block-root`（仓内**没有** class 型 ErrorBoundary）。
 *
 * "旧响应晚到"构造：备份页有**请求序号防乱序**（`use-local-backup.ts` 的 `useAsyncResource`），
 * 故让**首次**记录请求延迟、翻页触发**第二次**请求立即返回 ⇒ 第二次先到、
 * 第一次（旧）后到；断言页面最终仍展示第二次的数据。
 * 已知缺口：记录包页的两个 hook **没有**序号机制（晚到的旧响应会覆盖新状态），
 * 本规格**不对它写通过型断言**（避免把缺陷固化成期望），只在注释与文档中登记。
 */

/** 预置界面语言（localStorage 键 `ui-language`） */
async function setUiLanguage(page: Page, language: 'zh-CN' | 'en'): Promise<void> {
  await page.addInitScript((value: string) => {
    window.localStorage.setItem('ui-language', value);
  }, language);
}

/** 读取页面主标题文本（h1／h2 首个非空） */
async function readMainHeading(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = document.querySelector('h1, h2');
    return (node.textContent ?? '').trim();
  });
}

type StatePage = {
  label: string;
  path: string;
  /** 空态选择器（缺省＝该页不适用，需在文档登记） */
  emptySelector?: string;
  /** 错误态选择器 */
  errorSelector?: string;
  /** 触发错误态的 GraphQL 操作 */
  errorOperations: string[];
  /** 覆盖项（构造该页的空态／错误态） */
  overrides?: Task09MockOverrides;
  /** 键盘可达的目标选择器（Tab 序列中应能命中） */
  focusTargetSelector?: string;
};

const STATE_PAGES: StatePage[] = [
  {
    label: 'sync-conflicts',
    path: '/engineer/sync-conflicts',
    // antd v6 的 Table 占位符**不再**是 `.ant-empty` 组件（实测：占位符存在但内层无 `.ant-empty`）
    emptySelector: '.ant-table-placeholder',
    errorSelector: '.ant-empty',
    errorOperations: ['SyncConflicts'],
    focusTargetSelector: 'button',
  },
  {
    label: 'local-settings',
    path: '/local-settings',
    emptySelector: '.empty-state',
    errorSelector: '.error-state',
    errorOperations: ['LocalRuntimeStatus'],
    focusTargetSelector: 'button',
  },
  {
    label: 'local-backup',
    path: '/local-backup',
    emptySelector: '.empty-state',
    errorSelector: '.error-state',
    errorOperations: ['LocalBackupRecords'],
    // 空态需要"没有任何备份记录"
    overrides: { backupRecordTotal: 0 },
    focusTargetSelector: 'button',
  },
  {
    label: 'record-packages',
    path: '/engineer/record-packages',
    // 页面加载不发起查询（结果表格仅在动作成功后渲染）⇒ 空态／错误态**不适用**
    emptySelector: undefined,
    errorSelector: undefined,
    errorOperations: [],
    focusTargetSelector: '[role="tab"]',
  },
];

test.describe('任务 09 候选页面的逐态对照', () => {
  for (const target of STATE_PAGES) {
    test(`${target.label}：中英切换（html lang 与文案随语言变化）`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await seedAuthSession(page, 'ENGINEER');
      await setUiLanguage(page, 'zh-CN');
      await installLocalRuntimeMocks(page);
      await page.goto(target.path);
      await page.waitForSelector('h1, h2', { timeout: 10_000 });
      const chineseHeading = await readMainHeading(page);
      const chineseLang = await page.evaluate(() => document.documentElement.lang);

      // 侧栏展开态有语言双按钮（`button[lang="en"]`）
      const englishButton = page.locator('button[lang="en"]');
      await expect(englishButton, '侧栏应提供英文切换按钮').toHaveCount(1);
      await englishButton.click();
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.lang), {
          timeout: 5_000,
        })
        .toBe('en');
      const englishHeading = await readMainHeading(page);

      expect(chineseLang, '默认应为中文界面').toBe('zh-CN');
      expect(
        englishHeading,
        '切换到英文后主标题应随词条变化（若不变说明该页标题缺英文词条）',
      ).not.toBe(chineseHeading);
    });

    test(`${target.label}：键盘可达（Tab 能聚焦到可见控件）`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await seedAuthSession(page, 'ENGINEER');
      await installLocalRuntimeMocks(page);
      await page.goto(target.path);
      await page.waitForSelector('h1, h2', { timeout: 10_000 });

      const reached = await page.evaluate((targetSelector) => {
        const focusables = Array.from(
          document.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((node) => node.offsetParent !== null);
        for (let index = 0; index < 40; index += 1) {
          const active = document.activeElement as HTMLElement | null;
          if (active !== null && active !== document.body) {
            const rect = active.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && active.matches(targetSelector)) {
              return {
                hit: true,
                tag: active.tagName,
                text: (active.textContent ?? '').slice(0, 40),
              };
            }
          }
          const focusable = focusables[index % Math.max(focusables.length, 1)];
          focusable?.focus();
          if (focusable === undefined) {
            break;
          }
        }
        return { hit: false, tag: '', text: '' };
      }, target.focusTargetSelector ?? 'button');

      expect(
        reached.hit,
        `键盘应能聚焦到可见的 ${target.focusTargetSelector ?? 'button'}（实际聚焦信息：${reached.tag} ${reached.text}）`,
      ).toBe(true);
    });
  }

  test('长文案：注入超长文本后整页不得横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAuthSession(page, 'ENGINEER');
    await installLocalRuntimeMocks(page, { longText: true });
    for (const path of ['/local-settings', '/local-backup']) {
      await page.goto(path);
      await page.waitForSelector('h1, h2', { timeout: 10_000 });
      const metrics = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(
        metrics.scrollWidth - metrics.clientWidth,
        `${path} 在超长文案下不得横向溢出`,
      ).toBeLessThanOrEqual(0);
    }
  });

  for (const target of STATE_PAGES.filter((item) => item.emptySelector !== undefined)) {
    test(`${target.label}：空态可见`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await seedAuthSession(page, 'ENGINEER');
      await installLocalRuntimeMocks(page, target.overrides);
      await page.goto(target.path);
      await page.waitForSelector('h1, h2', { timeout: 10_000 });
      // 先等数据区（表格／卡片区）渲染完，再判空态（避免把"还在加载"当成空）
      await page.waitForSelector('.ant-table, .data-card', { timeout: 10_000 });
      // 诊断信息随断言消息带出（选择器口径不一致时可直接看出 DOM 实际形态）
      const probe = await page.evaluate(() => ({
        hasTable: document.querySelector('.ant-table') !== null,
        hasPlaceholder: document.querySelector('.ant-table-placeholder') !== null,
        hasEmpty: document.querySelector('.ant-empty') !== null,
        hasErrorState: document.querySelector('.error-state') !== null,
        rows: document.querySelectorAll('.ant-table-row').length,
        bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160),
      }));
      await expect(
        page.locator(target.emptySelector ?? '').first(),
        `空态探针：${JSON.stringify(probe)}`,
      ).toBeVisible();
    });
  }

  for (const target of STATE_PAGES.filter((item) => item.errorSelector !== undefined)) {
    test(`${target.label}：错误态可见（不白屏、无渲染期异常）`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await seedAuthSession(page, 'ENGINEER');
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => {
        pageErrors.push(error.message.slice(0, 200));
      });
      await installLocalRuntimeMocks(page, {
        ...target.overrides,
        failOperations: target.errorOperations,
      });
      await page.goto(target.path);
      await page.waitForSelector('h1, h2', { timeout: 10_000 });
      await expect(page.locator(target.errorSelector ?? '').first()).toBeVisible();
      // 渲染期崩溃会整页替换为错误块（`.error-block-root`）⇒ 不得出现
      await expect(page.locator('.error-block-root')).toHaveCount(0);
      expect(pageErrors, '错误态不应触发渲染期异常').toEqual([]);
    });
  }

  test('旧响应晚到：备份页应丢弃晚到的旧响应（展示最后一次请求的数据）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAuthSession(page, 'ENGINEER');
    await installLocalRuntimeMocks(page, {
      backupRecordTotal: 25,
      backupRecordIdByPage: { 1: 'bk-OLD', 2: 'bk-MID', 3: 'bk-NEW' },
      // **第 2 次**请求延迟 1.5s ⇒ 第 3 次（更快）先到，第 2 次（旧）后到
      delayRequestIndexOf: { LocalBackupRecords: 2 },
      delayMs: 1_500,
    });
    await page.goto('/local-backup');
    await page.waitForSelector('h1, h2', { timeout: 10_000 });
    await expect(page.locator('text=bk-OLD').first()).toBeVisible({ timeout: 10_000 });

    const nextButton = page.locator('.ant-pagination-next');
    await expect(nextButton).toBeVisible();
    // 第 1 次翻页 ⇒ 发出较慢的第 2 页请求
    await nextButton.click();
    await page.waitForTimeout(400);
    // 第 2 次翻页 ⇒ 发出更快的第 3 页请求（先到）
    await nextButton.click();
    await expect(page.locator('text=bk-NEW').first()).toBeVisible({ timeout: 10_000 });

    // 等较慢的第 2 页响应到达：若有防乱序，页面仍应显示第 3 页的数据
    await page.waitForTimeout(2_000);
    await expect(page.locator('text=bk-NEW').first()).toBeVisible();
    await expect(page.locator('text=bk-MID')).toHaveCount(0);
  });
});

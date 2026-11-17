// e2e-real/admin-s4-credential-visual-real.spec.ts
// 任务 08 · S4 凭据保护视觉取证：三视口 × 安全态采集（不截取任何展示中的口令）。
//
// 运行方式（授权变量由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_DEDICATED_DB_NAME=lithography_work_e2e \
//     npx playwright test --config playwright.admin-s4-credential-visual-real.config.ts
//
// 口径：
// - 只读采集：不触发补发 / 重置提交，因此除开通夹具外没有任何写操作；
// - 开通夹具经真实 `adminProvisionCompany` 建立「已绑定」事实，只登记主键与公司/账号事实，
//   一次性口令即用即弃，不写入截图、测量文件、日志或断言消息；
// - 采集范围：公司档案列表的「二级管理员账号」列、公司详情、补发确认弹窗、
//   用户管理「二级管理员凭据」弹窗第一步与第二步；
// - 每个状态都断言 `document.documentElement.scrollWidth - clientWidth <= 0`，
//   弹窗另测宽度与左右边界；
// - 截图走 `prepareStableViewport()` + `page.screenshot()`（工作区未提交时
//   `captureStableViewport` 的干净工作区门禁不成立，已在 frontend/docs/testing.md 登记）。
//
// 输出：
// - `docs/plan/task08/visual/s4-<name>-<w>x<h>.png`
// - `docs/plan/task08/visual/s4-measurements.json`

import { expect, type Page, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  cleanupProvisionedCompany,
  maskLoginName,
  provisionCompanyViaApi,
  type ProvisionedCompanyFacts,
  readProvisionedCompanyResidue,
} from '../e2e/helpers/provisioned-company-cleanup';
import {
  assertPhysicalCleanupAllowed,
  mysqlQuery,
  readBackendEnv,
  runGuardedFixtureWrite,
  runTeardownSteps,
  throwPrimaryAndTeardown,
} from '../e2e/helpers/real-backend';
import { prepareStableViewport } from '../e2e/helpers/visual-evidence';

const LEVEL_ONE_LOGIN = 'mock_super_admin';

const VIEWPORTS = [
  { height: 900, width: 1440 },
  { height: 768, width: 1366 },
  { height: 844, width: 390 },
] as const;

const VISUAL_DIR = path.resolve(process.cwd(), '../docs/plan/task08/visual');
const MEASUREMENTS_FILE = path.join(VISUAL_DIR, 's4-measurements.json');
const SENTINEL_ORGANIZATION_CODE = 'CLIENT_DEFAULT';

/** 默认宽度弹窗（详情 / 补发确认 / 凭据弹窗）：antd Modal width=520 */
const DEFAULT_DIALOG_WIDTH = 520;

type VisualMeasurement = {
  state: string;
  viewport: string;
  screenshot: string;
  documentOverflowX: number;
  dialogWidth: number | null;
  dialogX: number | null;
  dialogRight: number | null;
  bodyOverflowY: string | null;
  bodyClientHeight: number | null;
  bodyScrollHeight: number | null;
  tableScrollerClientWidth: number | null;
  tableScrollerScrollWidth: number | null;
};

let env: Record<string, string> = {};
let facts: ProvisionedCompanyFacts | null = null;
let originalAdminLevel = 'NULL';
let companyName = '';
const measurements: VisualMeasurement[] = [];

function readAdminLevel(loginName: string): string {
  return mysqlQuery(
    `SELECT COALESCE(admin_level, 'NULL') FROM base_user_account WHERE login_name = '${loginName}'`,
  );
}

function setAdminLevel(loginName: string, level: 1 | null): void {
  runGuardedFixtureWrite(
    env,
    `UPDATE base_user_account SET admin_level = ${level === null ? 'NULL' : String(level)} ` +
      `WHERE login_name = '${loginName}'`,
  );
}

function restoreAdminLevel(loginName: string, original: string): void {
  if (original !== 'NULL' && original !== '1' && original !== '2') {
    throw new Error(`原始 admin_level 值异常，拒绝恢复：${JSON.stringify(original)}`);
  }

  runGuardedFixtureWrite(
    env,
    `UPDATE base_user_account SET admin_level = ${original === 'NULL' ? 'NULL' : original} ` +
      `WHERE login_name = '${loginName}'`,
  );
}

async function loginViaUi(page: Page, loginName: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill(loginName);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(/\/admin$/u);
}

async function enterPageFromNav(
  page: Page,
  target: { heading: string; label: string; path: string },
): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: target.label })
    .click();
  await expect(page).toHaveURL(new RegExp(`${target.path}$`));
  await expect(page.getByRole('heading', { name: target.heading })).toBeVisible();
}

function visibleDialog(page: Page) {
  return page.locator('[role="dialog"]:visible');
}

/**
 * 采集一个状态在三种视口下的截图与几何数据。
 *
 * 横向约束一律硬断言；纵向数据只记录（默认宽度弹窗的正文滚动策略由组件自身决定）。
 */
async function captureState(
  page: Page,
  state: string,
  options: { dialog?: boolean } = {},
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);

    const viewportLabel = `${viewport.width}x${viewport.height}`;
    const fileName = `s4-${state}-${viewportLabel}.png`;

    // 先等待布局稳定（含弹窗入场动画）再测量，避免量到缩放中间态
    await prepareStableViewport(page, fileName);

    const resolved = await page.evaluate(() => {
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (item) => (item as HTMLElement).offsetParent !== null,
      ) as HTMLElement | undefined;
      const rect = dialog?.getBoundingClientRect();
      // 列表态没有弹窗：`dialog?.querySelector` 返回 undefined，必须收敛为 null 再取样式
      const body = (dialog?.querySelector('.ant-modal-body') ?? null) as HTMLElement | null;
      const scroller = document.querySelector(
        '.table-container .ant-table-content, .table-container .ant-table-body',
      ) as HTMLElement | null;

      return {
        bodyClientHeight: body?.clientHeight ?? null,
        bodyOverflowY: body === null ? null : getComputedStyle(body).overflowY,
        bodyScrollHeight: body?.scrollHeight ?? null,
        dialogRight: rect === undefined ? null : rect.x + rect.width,
        dialogWidth: rect?.width ?? null,
        dialogX: rect?.x ?? null,
        documentOverflowX:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tableScrollerClientWidth: scroller?.clientWidth ?? null,
        tableScrollerScrollWidth: scroller?.scrollWidth ?? null,
      };
    });

    await page.screenshot({ path: path.join(VISUAL_DIR, fileName) });

    expect(
      resolved.documentOverflowX,
      `${state} 在 ${viewportLabel} 不应横向溢出`,
    ).toBeLessThanOrEqual(0);

    if (options.dialog === true) {
      const inset = viewport.width <= 767 ? 16 : 32;
      const expectedWidth = Math.min(DEFAULT_DIALOG_WIDTH, viewport.width - inset);

      expect(resolved.dialogWidth, `${state} 应存在可见弹窗`).not.toBeNull();
      expect(resolved.dialogWidth ?? 0, `${state} 弹窗宽度应贴齐默认宽度或按视口收缩`).toBeCloseTo(
        expectedWidth,
        0,
      );
      expect(resolved.dialogX ?? -1, `${state} 弹窗左边不应越出视口`).toBeGreaterThanOrEqual(0);
      expect(
        resolved.dialogRight ?? Number.POSITIVE_INFINITY,
        `${state} 弹窗右边不应越出视口`,
      ).toBeLessThanOrEqual(viewport.width);
    }

    measurements.push({
      ...resolved,
      screenshot: fileName,
      state,
      viewport: viewportLabel,
    });
  }

  await page.setViewportSize(VIEWPORTS[0]);
}

test.describe.serial('S4 凭据保护视觉取证（隔离库真实链路）', () => {
  test.beforeAll(async () => {
    env = readBackendEnv();
    assertPhysicalCleanupAllowed(env);

    const runTag = `${Date.now()}`;

    companyName = `E2E S4 视觉凭据公司-${runTag}`;
    originalAdminLevel = readAdminLevel(LEVEL_ONE_LOGIN);
    setAdminLevel(LEVEL_ONE_LOGIN, 1);

    // 只取事实，不持有口令：口令既不需要也不进入任何输出
    const provisioning = await provisionCompanyViaApi(env, {
      contactPhone: '13900006666',
      isServiceProvider: true,
      name: companyName,
      operatorLogin: LEVEL_ONE_LOGIN,
      // 提交标识必须是 UUID：服务端按 UUID 归一化，非 UUID 直接拒绝
      submissionKey: randomUUID(),
    });

    facts = provisioning.facts;
  });

  test.afterAll(async () => {
    let primaryError: unknown = null;

    try {
      const teardown = await runTeardownSteps([
        {
          label: '按开通响应主键回收本轮公司与二级管理员',
          run: () => {
            if (facts !== null) {
              cleanupProvisionedCompany(facts);
            }
          },
        },
        {
          label: '恢复一级管理员等级',
          run: () => restoreAdminLevel(LEVEL_ONE_LOGIN, originalAdminLevel),
        },
      ]);

      if (teardown !== null) {
        throw teardown;
      }

      const registered = facts;

      if (registered === null) {
        throw new Error('本轮没有登记到开通主键，无法核验清理残留');
      }

      expect(readProvisionedCompanyResidue(registered)).toEqual({
        account: 0,
        audit: 0,
        membership: 0,
        organization: 0,
        provisioningRequest: 0,
        userInfo: 0,
      });
      expect(
        Number(
          mysqlQuery(
            `SELECT COUNT(*) FROM organization WHERE organization_code = '${SENTINEL_ORGANIZATION_CODE}'`,
          ),
        ),
        'seed 哨兵组织应保持原样',
      ).toBe(1);

      mkdirSync(VISUAL_DIR, { recursive: true });
      writeFileSync(
        MEASUREMENTS_FILE,
        `${JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            viewportSet: VIEWPORTS.map((item) => `${item.width}x${item.height}`),
            measurements,
          },
          null,
          2,
        )}\n`,
        'utf-8',
      );
    } catch (error) {
      primaryError = error;
    }

    throwPrimaryAndTeardown(primaryError, null);
  });

  test('一级管理员：绑定列、详情、补发确认与凭据弹窗前三态只读采集', async ({ page }) => {
    test.setTimeout(300_000);

    if (facts === null) {
      throw new Error('开通夹具未就绪，拒绝继续采集');
    }

    const maskedLoginName = maskLoginName(facts.adminLoginName);

    await loginViaUi(page, LEVEL_ONE_LOGIN, env.MOCK_SEED_PASSWORD);
    await enterPageFromNav(page, {
      heading: '公司档案',
      label: '公司档案',
      path: '/admin/companies',
    });

    // 1. 列表：绑定状态列 + 脱敏登录名（完整登录名不得出现在页面上）
    await page.getByPlaceholder('搜索公司全称 / 编号 / 简称').fill(companyName);

    const row = page.getByRole('row').filter({ hasText: companyName });

    await expect(row).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '二级管理员账号' })).toBeVisible();
    await expect(row.getByText('已绑定')).toBeVisible();
    await expect(row.getByText(maskedLoginName)).toBeVisible();
    await expect(row.getByText(facts.adminLoginName, { exact: true })).toHaveCount(0);
    await captureState(page, 'admin1-companies-binding');

    // 2. 详情：绑定事实与补发入口（不提交）
    await row.getByRole('button', { name: '详情' }).click();

    const detailDialog = visibleDialog(page).filter({ hasText: '公司详情' });

    await expect(detailDialog).toBeVisible();
    await expect(detailDialog.getByText('二级管理员账号')).toBeVisible();
    await expect(detailDialog.getByText(maskedLoginName)).toBeVisible();
    await expect(detailDialog.getByRole('button', { name: '补发临时密码' })).toBeVisible();
    await captureState(page, 'admin1-company-detail', { dialog: true });

    // 3. 补发二次确认：只有公司名与脱敏登录名，没有任何口令
    await detailDialog.getByRole('button', { name: '补发临时密码' }).click();

    const confirmDialog = visibleDialog(page).filter({ hasText: '补发二级管理员临时密码' });

    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByText(companyName)).toBeVisible();
    await expect(confirmDialog.getByText(maskedLoginName)).toBeVisible();
    await expect(confirmDialog.getByText('补发会立即作废旧口令与旧登录会话')).toBeVisible();
    await expect(confirmDialog.getByText(facts.adminLoginName, { exact: true })).toHaveCount(0);
    await captureState(page, 'admin1-company-reissue-confirm', { dialog: true });

    await page.setViewportSize(VIEWPORTS[0]);
    await confirmDialog.getByRole('button', { name: /取\s*消/ }).click();
    await expect(confirmDialog).toHaveCount(0);
    // 打开补发确认时详情已关闭（详情与确认是两个独立会话），取消后回到列表即可

    // 4. 用户管理「二级管理员凭据」前两步：第三步（口令展示）不在取证范围
    await enterPageFromNav(page, { heading: '用户管理', label: '用户管理', path: '/admin/users' });

    const entry = page.getByRole('button', { name: '二级管理员凭据' });

    await expect(entry).toBeVisible();
    await entry.click();

    const credentialDialog = visibleDialog(page);

    await expect(credentialDialog.getByText('选择已绑定的二级管理员')).toBeVisible();
    await credentialDialog
      .getByPlaceholder('搜索公司全称 / 编号 / 登录名 / 昵称')
      .fill(companyName);

    const candidateRow = credentialDialog.getByRole('row').filter({ hasText: companyName });

    await expect(candidateRow).toBeVisible();
    // 凭据入口是「一级专用」页面：候选表展示完整登录名，用于管理员核对目标准确性
    await expect(candidateRow.getByText(facts.adminLoginName)).toBeVisible();
    await captureState(page, 'admin1-level-two-credential-select', { dialog: true });

    await candidateRow.getByRole('button', { name: '选择' }).click();

    await expect(credentialDialog.getByText('核对目标与重置原因')).toBeVisible();
    await expect(credentialDialog.getByText(facts.organizationCode)).toBeVisible();
    await expect(
      credentialDialog.getByPlaceholder('例如：管理员遗忘密码，经电话核实后重置'),
    ).toBeVisible();
    await captureState(page, 'admin1-level-two-credential-confirm', { dialog: true });

    // 只关闭不提交：任何口令都不会出现在页面或证据中
    await page.setViewportSize(VIEWPORTS[0]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog').filter({ hasText: '核对目标与重置原因' })).toHaveCount(0);
  });
});

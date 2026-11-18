// e2e-real/task02-b-review-visual-real.spec.ts
// 任务 02 · B 审查 R2 视觉补证（2026-11-18）：当前候选生产页面截图，不使用原型文件。
//
// 运行方式（授权变量由执行者显式设置）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npx playwright test \
//     --config=playwright.account-settings-real.config.ts e2e-real/task02-b-review-visual-real.spec.ts
//
// 口径：
// - 只读采集：管理员首页不做任何业务写入；仅临时改写 seed 管理员的 `admin_level`，
//   采集结束按原值恢复并回读核对；
// - 改密截图使用一次性专用账号（真实落库的完整链路），结束后按台账精确物理删除；
// - 工作区未提交时 `captureStableViewport` 的干净工作区门禁不成立，按 S2/S3 先例
//   使用 `prepareStableViewport()` + `page.screenshot()`，并单独记录 HEAD、脏文件清单
//   与 `git diff` 指纹，避免把截图伪关联到某个提交；
// - 成功提示等实际出现后才截图；失败场景的密码框由表单清空，截图不含凭据。

import { expect, type Page, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  assertApiSqlSameDatabase,
  cleanupRegisteredDedicatedAccounts,
  preflightDedicatedAccountCleanup,
  readAccountCountByLoginName,
  readActingOrganizationId,
  readDedicatedAccountCleanupResidue,
  registerCreatedDedicatedAccount,
  type RegisteredDedicatedAccount,
  runWithCleanup,
} from '../e2e/helpers/dedicated-account-cleanup';
import {
  mysqlQuery,
  readBackendEnv,
  realGraphqlCall,
  runGuardedFixtureWrite,
} from '../e2e/helpers/real-backend';
import {
  prepareStableViewport,
  readPngDimensions,
  readWorkspaceEvidenceState,
} from '../e2e/helpers/visual-evidence';

const REPO_ROOT = path.resolve(process.cwd(), '..');
const VISUAL_DIR = path.resolve(REPO_ROOT, 'docs/plan/task02/acceptance/B审查修复-20261118/visual');
const ADMIN_MEASUREMENTS_FILE = path.join(VISUAL_DIR, 'S3-admin-home-measurements.json');
const PASSWORD_MEASUREMENTS_FILE = path.join(VISUAL_DIR, 'S3-password-measurements.json');

const VIEWPORTS = [
  { height: 900, width: 1440 },
  { height: 768, width: 1366 },
  { height: 844, width: 390 },
] as const;

type UiLanguage = 'en' | 'zh-CN';

const ADMIN_CASES = [
  { documentEntryExpected: true, key: 'admin-l1', level: '1', loginName: 'mock_super_admin' },
  { documentEntryExpected: false, key: 'admin-l2', level: '2', loginName: 'mock_admin_peer' },
] as const;

/** 管理员首页主区入口卡与导航标签（zh / en 与 messages 词条逐字一致） */
const ADMIN_COPY = {
  'zh-CN': {
    documents: '文档数据库',
    heading: '管理员工作台',
    orders: '工单管理',
    users: '用户管理',
  },
  en: {
    documents: 'Document database',
    heading: 'Administrator workspace',
    orders: 'Work orders',
    users: 'User management',
  },
} as const;

/** 改密三态（成功 / 当前密码错误 / 新密码被策略拒绝）在中英文下的本地化反馈 */
const PASSWORD_COPY = {
  'zh-CN': {
    cardTitle: '修改密码',
    confirmLabel: '确认新密码',
    currentLabel: '当前密码',
    newLabel: '新密码',
    rejectedMessage: '密码未更新，请核对当前密码及新密码要求后重试。',
    submitName: /修\s*改\s*密\s*码/,
    successMessage: '密码已更新，请使用新密码重新登录。',
    tabName: '修改密码',
  },
  en: {
    cardTitle: 'Change password',
    confirmLabel: 'Confirm new password',
    currentLabel: 'Current password',
    newLabel: 'New password',
    rejectedMessage:
      'Password not updated. Check your current password and the new password requirements, then try again.',
    submitName: /Change password/,
    successMessage: 'Password updated. Sign in again with your new password.',
    tabName: 'Change password',
  },
} as const;

/** 专用改密账号（清理台账只接受 e2e-pw-<时间戳>） */
const ADMIN_CREATE_USER_MUTATION = `
  mutation AdminCreateUser($input: AdminCreateUserInput!) {
    adminCreateUser(input: $input) { id loginName status }
  }
`;

type Measurement = Record<string, unknown> & { file: string };

const measurements: Measurement[] = [];

function readWorkspaceFingerprint(): {
  diffFingerprint: string | null;
  dirtyEntries: string[];
  head: string;
  state: string;
  untrackedFileFingerprints: Record<string, string>;
} {
  const state = readWorkspaceEvidenceState();
  const head = state.kind === 'unavailable' ? null : state.sha;
  const dirtyEntries = state.kind === 'dirty' ? state.entries : [];
  const diff = execFileSync('git', ['diff', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const untrackedPaths = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const untrackedFileFingerprints = Object.fromEntries(
    untrackedPaths.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(REPO_ROOT, file)))
        .digest('hex'),
    ]),
  );

  return {
    diffFingerprint: createHash('sha256').update(diff).digest('hex'),
    dirtyEntries,
    head: head ?? 'unavailable',
    state: state.kind,
    untrackedFileFingerprints,
  };
}

/** 切换界面语言：宽屏用双按钮组，窄屏（≤1024px 默认折叠）用图标按钮的可访问名称 */
async function switchLanguage(page: Page, target: UiLanguage): Promise<void> {
  const current = await page.locator('html').getAttribute('lang');

  if (current === target) {
    return;
  }

  const inlineButton = page.locator(`button[lang="${target}"]`).first();

  if (await inlineButton.isVisible().catch(() => false)) {
    await inlineButton.click();
  } else {
    const label =
      current === 'en'
        ? target === 'zh-CN'
          ? 'Switch to Chinese'
          : 'Switch to English'
        : target === 'zh-CN'
          ? '切换到中文'
          : '切换到英文';

    await page.getByRole('button', { name: label }).click();
  }

  await expect(page.locator('html')).toHaveAttribute('lang', target);
}

async function loginViaUi(
  page: Page,
  loginName: string,
  password: string,
  homePath: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill(loginName);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(new RegExp(`${homePath}$`));
}

function cardByTitle(page: Page, title: string) {
  return page.locator('section.data-card', {
    has: page.locator('h3.data-card-title', { hasText: title }),
  });
}

async function submitPasswordChange(
  card: ReturnType<typeof cardByTitle>,
  copy: (typeof PASSWORD_COPY)[UiLanguage],
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await card.getByLabel(copy.currentLabel).fill(currentPassword);
  await card.getByLabel(copy.newLabel, { exact: true }).fill(newPassword);
  await card.getByLabel(copy.confirmLabel).fill(newPassword);
  await card.getByRole('button', { name: copy.submitName }).click();
}

/** 稳定截图（脏工作区登记口径）并回写量测 */
async function capture(
  page: Page,
  options: {
    file: string;
    language: UiLanguage;
    role: string;
    scenario: string;
    viewport: { height: number; width: number };
  },
): Promise<void> {
  await prepareStableViewport(page, options.file);

  const filePath = path.join(VISUAL_DIR, options.file);

  await page.screenshot({ path: filePath, animations: 'disabled' });

  const dom = await page.evaluate(() => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();

      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
    };

    const main = document.querySelector('main');
    const cardTitles = Array.from(document.querySelectorAll('main h3.data-card-title')).map(
      (element) => element.textContent?.trim() ?? '',
    );
    const visibleNavLinks = Array.from(document.querySelectorAll('nav a')).filter(
      (element) => element.getClientRects().length > 0,
    );

    return {
      cardTitles,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(
        (element) => element.textContent?.trim() ?? '',
      ),
      lang: document.documentElement.lang,
      mainRect: main ? rect(main) : null,
      navLabels: visibleNavLinks.map((element) => element.textContent?.trim() ?? ''),
      scrollY: window.scrollY,
      url: window.location.href,
    };
  });

  expect(dom.scrollY, `${options.file} 截图时 scrollY 应为 0`).toBe(0);
  expect(
    dom.documentScrollWidth - dom.documentClientWidth,
    `${options.file} 不应出现整页横向溢出`,
  ).toBeLessThanOrEqual(0);

  // 物理尺寸必须等于登记视口：防止默认 1280×720 被误记成 1440×900
  const png = readPngDimensions(filePath);

  expect(png, `${options.file} PNG 物理尺寸应等于登记视口`).toEqual(options.viewport);

  // DOM 证据补充：关键 selector 的 computed style + 键盘焦点轨迹（截图之后采集，
  // 避免焦点描边改变已保存的视觉证据）
  const styles = await page.evaluate(() => {
    const read = (selector: string, properties: string[]) => {
      const element = document.querySelector(selector);

      if (!element) {
        return null;
      }

      const computed = getComputedStyle(element);

      return Object.fromEntries(
        properties.map((property) => [property, computed.getPropertyValue(property)]),
      );
    };

    return {
      heading: read('main h1, main h2, main h3', ['color', 'font-size', 'font-weight']),
      html: read('html', ['overflow-x']),
      main: read('main', ['display', 'overflow-x', 'width']),
    };
  });

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

  const focusTrace: string[] = [];

  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Tab');
    focusTrace.push(
      await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;

        if (!element) {
          return 'none';
        }

        const label =
          element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '';

        return `${element.tagName.toLowerCase()}|${label}`;
      }),
    );
  }

  measurements.push({
    ...dom,
    focusTrace,
    file: options.file,
    language: options.language,
    png,
    role: options.role,
    scenario: options.scenario,
    selectors: {
      cards: 'main h3.data-card-title',
      navLinks: 'nav a',
      pageMain: 'main',
    },
    styles,
    viewport: options.viewport,
  });
}

function readAdminLevel(loginName: string): string {
  return mysqlQuery(
    `SELECT COALESCE(admin_level, 'NULL') FROM base_user_account WHERE login_name = '${loginName}'`,
  );
}

/** 只接受 NULL/1/2 的受控等级形态，非法值在第一条写入前失败关闭 */
function toLevelSqlValue(level: string): 'NULL' | '1' | '2' {
  if (level !== 'NULL' && level !== '1' && level !== '2') {
    throw new Error(`admin_level 值异常，拒绝写入 / 恢复：${JSON.stringify(level)}`);
  }

  return level;
}

function writeAdminLevel(env: Record<string, string>, loginName: string, level: string): void {
  const value = toLevelSqlValue(level);

  runGuardedFixtureWrite(
    env,
    `UPDATE base_user_account SET admin_level = ${value} WHERE login_name = '${loginName}'`,
  );
}

test.describe('任务 02 B 审查 R2 视觉补证', () => {
  test('管理员首页：一级 / 二级 × 中文 / 英文 × 三视口', async ({ browser }) => {
    test.setTimeout(300_000);
    const env = readBackendEnv();
    const workspace = readWorkspaceFingerprint();
    const originals = ADMIN_CASES.map((item) => ({
      level: readAdminLevel(item.loginName),
      loginName: item.loginName,
    }));

    mkdirSync(VISUAL_DIR, { recursive: true });

    // 本用例只写自己的量测（模块级数组在同一 worker 内跨用例保留）
    const adminStart = measurements.length;
    await runWithCleanup(
      async () => {
        for (const item of ADMIN_CASES) {
          writeAdminLevel(env, item.loginName, item.level);
        }

        for (const item of ADMIN_CASES) {
          for (const viewport of VIEWPORTS) {
            const context = await browser.newContext({ viewport });
            const page = await context.newPage();

            try {
              await loginViaUi(page, item.loginName, env.MOCK_SEED_PASSWORD, '/admin');
              await expect(
                page.getByRole('heading', { name: ADMIN_COPY['zh-CN'].heading }),
              ).toBeVisible();

              for (const language of ['zh-CN', 'en'] as const) {
                await switchLanguage(page, language);

                const copy = ADMIN_COPY[language];
                const main = page.getByRole('main');

                await expect(page.getByRole('heading', { name: copy.heading })).toBeVisible();
                await expect(main.getByText(copy.users, { exact: true })).toBeVisible();
                await expect(main.getByText(copy.orders, { exact: true })).toBeVisible();

                if (item.documentEntryExpected) {
                  await expect(main.getByText(copy.documents, { exact: true })).toBeVisible();
                } else {
                  await expect(main.getByText(copy.documents, { exact: true })).toHaveCount(0);
                }

                // 展开态侧栏（>1024px）导航与主区同口径；窄屏默认折叠只核对主区
                // 侧栏 aria-label 随语言本地化，故用稳定 class 定位而非中文标签
                if (viewport.width > 1024) {
                  const nav = page.locator('nav.app-sidebar-nav');

                  await expect(nav.getByRole('link', { name: copy.orders })).toBeVisible();

                  if (item.documentEntryExpected) {
                    await expect(nav.getByRole('link', { name: copy.documents })).toBeVisible();
                  } else {
                    await expect(nav.getByRole('link', { name: copy.documents })).toHaveCount(0);
                  }
                }

                await capture(page, {
                  file: `${item.key}-${language === 'zh-CN' ? 'zh' : 'en'}-${viewport.width}x${viewport.height}.png`,
                  language,
                  role: item.key,
                  scenario: `admin home · level ${item.level}`,
                  viewport,
                });
              }
            } finally {
              await context.close();
            }
          }
        }
      },
      ...originals.map((original) => ({
        label: `管理员 ${original.loginName} 等级恢复`,
        run: () => {
          writeAdminLevel(env, original.loginName, original.level);
          expect(readAdminLevel(original.loginName)).toBe(original.level);
        },
      })),
      {
        label: '管理员首页量测保存',
        run: () => {
          writeFileSync(
            ADMIN_MEASUREMENTS_FILE,
            JSON.stringify({ measurements: measurements.slice(adminStart), workspace }, null, 2),
          );
        },
      },
    );
  });

  test('改密三态：中英文成功提示 / 当前密码错误 / 新密码被拒', async ({ page }) => {
    test.setTimeout(300_000);
    const env = readBackendEnv();

    // 页面 fixture 默认 1280×720；R2 证据固定 1440×900，截图前显式设置
    await page.setViewportSize({ height: 900, width: 1440 });

    preflightDedicatedAccountCleanup();
    await assertApiSqlSameDatabase(env);

    const fixtureLevel = readAdminLevel('mock_super_admin');
    const dedicatedLoginName = `e2e-pw-${Date.now()}`;
    const INITIAL_PASSWORD = 'E2eVisual#2026Init';
    const FIRST_PASSWORD = 'E2eVisual#2026First';
    const SECOND_PASSWORD = 'E2eVisual#2026Second';
    const WRONG_PASSWORD = 'E2eVisual#2026Wrong';
    const WEAK_PASSWORD = 'weakpass';
    const DEDICATED_NICKNAME = 'E2E 视觉补证账号';
    const registry: RegisteredDedicatedAccount[] = [];
    let restoreFixtureLevel: (() => void) | null = null;

    const workspace = readWorkspaceFingerprint();
    const passwordStart = measurements.length;

    mkdirSync(VISUAL_DIR, { recursive: true });

    await runWithCleanup(
      async () => {
        const organizationId = readActingOrganizationId('mock_super_admin');

        if (fixtureLevel !== '1') {
          // 写入可能已经生效但调用仍抛错，恢复动作必须在写入之前登记。
          restoreFixtureLevel = () => {
            writeAdminLevel(env, 'mock_super_admin', fixtureLevel);
            expect(readAdminLevel('mock_super_admin')).toBe(fixtureLevel);
          };
          writeAdminLevel(env, 'mock_super_admin', '1');
        }

        const created = await realGraphqlCall(
          env,
          ADMIN_CREATE_USER_MUTATION,
          {
            input: {
              initialPassword: INITIAL_PASSWORD,
              loginName: dedicatedLoginName,
              nickname: DEDICATED_NICKNAME,
              role: 'ENGINEER',
            },
          },
          'mock_super_admin',
        );

        registerCreatedDedicatedAccount(registry, created.body, {
          accessGroup: ['ENGINEER'],
          loginName: dedicatedLoginName,
          nickname: DEDICATED_NICKNAME,
          organizationId,
          role: 'ENGINEER',
          userInfoEmail: null,
          userState: 'ACTIVE',
        });

        const viewport = { height: 900, width: 1440 };
        const openSettings = async (language: UiLanguage) => {
          await page.goto('/account/settings');
          await switchLanguage(page, language);

          const copy = PASSWORD_COPY[language];

          await page.getByRole('tab', { name: copy.tabName }).click();
          await expect(cardByTitle(page, copy.cardTitle)).toBeVisible();

          return copy;
        };

        // ---- zh-CN：错误当前密码 → 新密码被策略拒绝 → 成功（真实落库） ----
        await loginViaUi(page, dedicatedLoginName, INITIAL_PASSWORD, '/engineer');

        let copy = await openSettings('zh-CN');
        let card = cardByTitle(page, copy.cardTitle);

        await submitPasswordChange(card, copy, WRONG_PASSWORD, FIRST_PASSWORD);
        await expect(page.getByText(copy.rejectedMessage)).toBeVisible();
        await expect(card.getByLabel(copy.currentLabel)).toHaveValue('');
        await capture(page, {
          file: 'password-rejected-current-zh-1440x900.png',
          language: 'zh-CN',
          role: 'engineer',
          scenario: 'change password · wrong current password',
          viewport,
        });

        await submitPasswordChange(card, copy, INITIAL_PASSWORD, WEAK_PASSWORD);
        await expect(page.getByText(copy.rejectedMessage)).toBeVisible();
        await expect(card.getByLabel(copy.currentLabel)).toHaveValue('');
        await capture(page, {
          file: 'password-rejected-policy-zh-1440x900.png',
          language: 'zh-CN',
          role: 'engineer',
          scenario: 'change password · weak new password rejected',
          viewport,
        });

        await submitPasswordChange(card, copy, INITIAL_PASSWORD, FIRST_PASSWORD);
        await expect(page.getByText(copy.successMessage)).toBeVisible();
        await expect(page).toHaveURL(/\/login$/);
        await capture(page, {
          file: 'password-success-zh-1440x900.png',
          language: 'zh-CN',
          role: 'engineer',
          scenario: 'change password · success notice',
          viewport,
        });

        // ---- en：以新密码登录后错误当前密码 → 策略拒绝 → 成功 ----
        // 登录页沿用 zh 界面完成登录，再在实际页面切换英文（登录页不保证有语言切换入口）
        await loginViaUi(page, dedicatedLoginName, FIRST_PASSWORD, '/engineer');
        await switchLanguage(page, 'en');

        copy = await openSettings('en');
        card = cardByTitle(page, copy.cardTitle);

        await submitPasswordChange(card, copy, WRONG_PASSWORD, SECOND_PASSWORD);
        await expect(page.getByText(copy.rejectedMessage)).toBeVisible();
        await expect(card.getByLabel(copy.currentLabel)).toHaveValue('');
        await capture(page, {
          file: 'password-rejected-current-en-1440x900.png',
          language: 'en',
          role: 'engineer',
          scenario: 'change password · wrong current password',
          viewport,
        });

        await submitPasswordChange(card, copy, FIRST_PASSWORD, WEAK_PASSWORD);
        await expect(page.getByText(copy.rejectedMessage)).toBeVisible();
        await expect(card.getByLabel(copy.currentLabel)).toHaveValue('');
        await capture(page, {
          file: 'password-rejected-policy-en-1440x900.png',
          language: 'en',
          role: 'engineer',
          scenario: 'change password · weak new password rejected',
          viewport,
        });

        await submitPasswordChange(card, copy, FIRST_PASSWORD, SECOND_PASSWORD);
        await expect(page.getByText(copy.successMessage)).toBeVisible();
        await expect(page).toHaveURL(/\/login$/);
        await capture(page, {
          file: 'password-success-en-1440x900.png',
          language: 'en',
          role: 'engineer',
          scenario: 'change password · success notice',
          viewport,
        });
      },
      {
        label: '专用账号清理',
        run: () => {
          cleanupRegisteredDedicatedAccounts(registry);

          for (const account of registry) {
            expect(readDedicatedAccountCleanupResidue(account.id)).toEqual({
              account: 0,
              relatedBusiness: 0,
              userInfo: 0,
            });
          }

          expect(readAccountCountByLoginName('mock_super_admin')).toBe(1);
        },
      },
      {
        label: '夹具管理员等级恢复',
        run: () => {
          restoreFixtureLevel?.();
        },
      },
    );

    writeFileSync(
      PASSWORD_MEASUREMENTS_FILE,
      JSON.stringify({ measurements: measurements.slice(passwordStart), workspace }, null, 2),
    );
  });
});

// e2e-real/admin-s5-visual-real.spec.ts
// 任务 08 · S5 视觉复验：三页 × 三视口 × 两级只读采集。
//
// 运行方式（授权变量由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_DEDICATED_DB_NAME=lithography_work_e2e \
//     npm run test:e2e:admin-s5-visual-real
//
// 口径：
// - 只读采集：页面不做任何写操作；夹具在公司/账号/申请层面预置，收尾按本轮台账单事务回收；
// - 一级与二级分别登录采集，二级页面呈现与服务端作用域一一对应；
// - 所有整视口证据统一走 `captureStableViewport`：工作区脏或 git 不可用时失败关闭，
//   禁止把截图伪关联到某个提交；提交级采集请在干净候选（提交后）上重跑本规格。
//
// 输出：
// - `docs/plan/task08/visual/s5-<role>-<page>-<w>x<h>.png`
// - `docs/plan/task08/visual/s5-<name>-<w>x<h>.png`（关键弹窗：两个桌面视口 + 390×844）
// - `docs/plan/task08/visual/s5-measurements.json`
//   （rect / computed style / overflow / 弹窗正文滚动 / 视口截图元数据 / 浏览器与字体环境）

import { expect, type Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  assertPhysicalCleanupAllowed,
  BACKEND_GRAPHQL,
  mysqlQuery,
  readBackendEnv,
  runGuardedFixtureWrite,
  runTeardownSteps,
  throwPrimaryAndTeardown,
} from '../e2e/helpers/real-backend';
import {
  cleanupRegistrationRound,
  createRegistrationRoundLedger,
  insertRegistrationRoundOrganization,
  readRegistrationRoundMembershipsByAccountId,
  readRegistrationRoundUserInfoByAccountId,
  registerRegistrationRoundAccount,
  registerRegistrationRoundApplication,
  registerRegistrationRoundMembership,
  registerRegistrationRoundUserInfo,
  type RegistrationRoundLedger,
  retainRegistrationRoundOrganization,
} from '../e2e/helpers/registration-round-cleanup';
import {
  captureStableViewport,
  readWorkspaceEvidenceState,
  type ViewportCaptureMeta,
} from '../e2e/helpers/visual-evidence';

/** 主导航入口 */
const PAGES = [
  { key: 'companies', label: '公司档案', path: '/admin/companies', heading: '公司档案' },
  {
    key: 'applications',
    label: '注册审批',
    path: '/admin/engineer-registrations',
    heading: '工程师注册审批',
  },
  { key: 'users', label: '用户管理', path: '/admin/users', heading: '用户管理' },
] as const;

type PageKey = (typeof PAGES)[number]['key'];

const VIEWPORTS = [
  { height: 900, width: 1440 },
  { height: 768, width: 1366 },
  { height: 844, width: 390 },
] as const;

const LEVEL_ONE_LOGIN = 'mock_super_admin';
const LEVEL_TWO_LOGIN = 'mock_admin_peer';
/** 二级管理员可信公司：seed 同行隔离测试组织（本轮临时置为受管） */
const LEVEL_TWO_ORGANIZATION_CODE = 'PEER_ALT';

const VISUAL_DIR = path.resolve(process.cwd(), '../docs/plan/task08/visual');
const MEASUREMENTS_FILE = path.join(VISUAL_DIR, 's5-measurements.json');

/** 客户注册口令：满足后端密码策略（仅测试夹具使用） */
const FIXTURE_PASSWORD = 'E2eS5Visual@2026';

const REGISTER_WEB_MUTATION = `
  mutation RegisterWeb($input: RegisterWebInput!) {
    register: registerWeb(input: $input) {
      success
      message
      accountId
      registrationStatus
      applicationId
    }
  }
`;

/** 本轮临时改写的 seed 状态：与共享台账分离，收尾时独立复原 */
type RestorationLedger = {
  restoredManagedCompany: { organizationId: number; original: string } | null;
  restoredAdminLevels: Array<{ loginName: string; original: string }>;
};

type BoxMeasurement = {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  color: string;
  backgroundColor: string;
  borderRadius: string;
  overflowX: string;
};

type PageMeasurement = {
  role: 'admin1' | 'admin2';
  page: PageKey;
  viewport: string;
  url: string;
  document: {
    clientWidth: number;
    scrollWidth: number;
    clientHeight: number;
    scrollHeight: number;
    pageOverflowX: number;
  };
  pageStack: BoxMeasurement | null;
  pageHeader: BoxMeasurement | null;
  pageTitle: BoxMeasurement | null;
  filterBar: BoxMeasurement | null;
  actionArea: BoxMeasurement | null;
  tableContainer: BoxMeasurement | null;
  tableScroller: (BoxMeasurement & { scrollWidth: number; clientWidth: number }) | null;
  rowCount: number;
};

type DialogMeasurement = {
  name: string;
  title: string;
  viewport: string;
  expectedWidth: number;
  dialog: BoxMeasurement | null;
  content: BoxMeasurement | null;
  titleBox: BoxMeasurement | null;
  footer: BoxMeasurement | null;
  body: (BoxMeasurement & { clientHeight: number; scrollHeight: number }) | null;
  documentOverflowX: number;
  footerBottom: number | null;
  bodyText: string;
};

type EnvironmentInfo = {
  browserName: string;
  browserVersion: string;
  platform: string;
  devicePixelRatio: number;
  bodyFontFamily: string;
  fonts: { family: string; loaded: boolean }[];
};

let ledger: RegistrationRoundLedger = createRegistrationRoundLedger();
let restoration: RestorationLedger = { restoredAdminLevels: [], restoredManagedCompany: null };
let env: Record<string, string> = {};
let peerOrganizationId = 0;
let foreignCompanyName = '';
let ownCustomer = { accountId: 0, loginName: '' };
let foreignCustomer = { accountId: 0, loginName: '' };
let engineerApplicant = { accountId: 0, loginName: '' };
let runTag = '';
let environment: EnvironmentInfo | null = null;
const measurements: PageMeasurement[] = [];
const dialogMeasurements: DialogMeasurement[] = [];
const viewportCaptures: ViewportCaptureMeta[] = [];

function buildRunTag(): string {
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  if (!/^\d{10,20}$/u.test(tag)) {
    throw new Error(`运行标识格式异常，拒绝使用：${tag}`);
  }

  return tag;
}

function readAdminLevel(loginName: string): string {
  return mysqlQuery(
    `SELECT COALESCE(admin_level, 'NULL') FROM base_user_account WHERE login_name = '${loginName}'`,
  );
}

function setAdminLevel(loginName: string, level: 1 | 2 | null): void {
  const value = level === null ? 'NULL' : String(level);
  runGuardedFixtureWrite(
    env,
    `UPDATE base_user_account SET admin_level = ${value} WHERE login_name = '${loginName}'`,
  );
}

function restoreAdminLevel(loginName: string, original: string): void {
  if (original !== 'NULL' && original !== '1' && original !== '2') {
    throw new Error(`原始 admin_level 值异常，拒绝恢复：${JSON.stringify(original)}`);
  }

  setAdminLevel(loginName, original === 'NULL' ? null : (Number(original) as 1 | 2));
}

function createFixtureCompany(
  code: string,
  name: string,
): { id: number; organizationCode: string } {
  const id = insertRegistrationRoundOrganization(ledger, {
    isManagedCompany: true,
    kind: 'CLIENT',
    name,
    organizationCode: code,
  });

  return { id, organizationCode: code };
}

/** 注册响应回读真实资料 / 成员关系 ID 后连同账号、申请一起登记 */
function registerFixtureAccount(facts: {
  accountId: number;
  applicationId: number | null;
  loginEmail: string;
  loginName: string;
}): void {
  registerRegistrationRoundAccount(ledger, {
    id: facts.accountId,
    loginEmail: facts.loginEmail,
    loginName: facts.loginName,
  });
  registerRegistrationRoundUserInfo(
    ledger,
    readRegistrationRoundUserInfoByAccountId(facts.accountId),
  );

  for (const membership of readRegistrationRoundMembershipsByAccountId(facts.accountId)) {
    registerRegistrationRoundMembership(ledger, membership);
  }

  if (facts.applicationId !== null) {
    registerRegistrationRoundApplication(ledger, {
      accountId: facts.accountId,
      id: facts.applicationId,
    });
  }
}

async function registerWeb(input: {
  loginEmail: string;
  loginName: string;
  nickname: string;
  organizationId: number;
  type: 'CUSTOMER' | 'ENGINEER';
  realName?: string;
  phone?: string;
}): Promise<{ accountId: number; applicationId: number | null }> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({
      query: REGISTER_WEB_MUTATION,
      variables: {
        input: {
          loginEmail: input.loginEmail,
          loginName: input.loginName,
          loginPassword: FIXTURE_PASSWORD,
          nickname: input.nickname,
          organizationId: input.organizationId,
          phone: input.phone,
          realName: input.realName,
          type: input.type,
        },
      },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const body = (await response.json()) as {
    data?: {
      register?: { success: boolean; accountId: number; applicationId: number | null };
    };
    errors?: Array<{ message?: string }>;
  };
  const payload = body.data?.register;

  if (!payload || !payload.success) {
    throw new Error(`Web 注册未成功：${JSON.stringify(body)}`);
  }

  return { accountId: payload.accountId, applicationId: payload.applicationId ?? null };
}

async function loginViaUi(page: Page, loginName: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill(loginName);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(/\/admin$/u);
}

async function enterPageFromNav(page: Page, target: (typeof PAGES)[number]): Promise<void> {
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

/** 页面级测量：rect + 关键 computed style + 页面/表格 overflow */
async function measurePage(
  page: Page,
  role: 'admin1' | 'admin2',
  pageKey: PageKey,
  viewport: string,
): Promise<PageMeasurement> {
  const measurement = await page.evaluate(
    (params: { role: 'admin1' | 'admin2'; pageKey: PageKey; viewport: string }) => {
      const boxOf = (element: Element | null) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);

        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          color: style.color,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          height: rect.height,
          left: rect.left,
          lineHeight: style.lineHeight,
          top: rect.top,
          width: rect.width,
          x: rect.x,
          y: rect.y,
          overflowX: style.overflowX,
        };
      };

      const tableContainer = document.querySelector('.table-container');
      const scroller =
        tableContainer?.querySelector('.ant-table-content') ??
        tableContainer?.querySelector('.ant-table-body') ??
        null;
      const scrollerBox = boxOf(scroller);
      // 排除 antd 在启用 scroll 时插入的测量行（.ant-table-measure-row），只统计真实数据行
      const rows = document.querySelectorAll('.ant-table-tbody > tr:not(.ant-table-measure-row)');

      return {
        role: params.role,
        page: params.pageKey,
        viewport: params.viewport,
        url: window.location.href,
        document: {
          clientHeight: document.documentElement.clientHeight,
          clientWidth: document.documentElement.clientWidth,
          pageOverflowX:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
        },
        pageStack: boxOf(document.querySelector('.page-stack')),
        pageHeader: boxOf(document.querySelector('.page-header')),
        pageTitle: boxOf(document.querySelector('.page-header h1')),
        filterBar: boxOf(document.querySelector('.filter-bar')),
        actionArea: boxOf(document.querySelector('.page-header-actions, .page-action-row')),
        tableContainer: boxOf(tableContainer),
        tableScroller:
          scrollerBox && scroller instanceof HTMLElement
            ? {
                ...scrollerBox,
                clientWidth: scroller.clientWidth,
                scrollWidth: scroller.scrollWidth,
              }
            : null,
        rowCount: rows.length,
      };
    },
    { pageKey, role, viewport },
  );

  expect(measurement.document.pageOverflowX).toBeLessThanOrEqual(0);

  return measurement;
}

async function capturePage(
  page: Page,
  role: 'admin1' | 'admin2',
  target: (typeof PAGES)[number],
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const viewportLabel = `${viewport.width}x${viewport.height}`;
    const fileName = `s5-${role}-${target.key}-${viewportLabel}.png`;

    const meta = await captureStableViewport(page, {
      fileName,
      filePath: path.join(VISUAL_DIR, fileName),
    });

    viewportCaptures.push(meta);
    measurements.push(await measurePage(page, role, target.key, viewportLabel));
  }

  await page.setViewportSize(VIEWPORTS[0]);
}

/** 浏览器与字体环境：随证据一起交回，避免截图脱离对照环境 */
async function captureEnvironment(page: Page): Promise<void> {
  const browser = page.context().browser();

  environment = {
    bodyFontFamily: await page.evaluate(() => getComputedStyle(document.body).fontFamily),
    browserName: browser?.browserType().name() ?? 'unknown',
    browserVersion: browser?.version() ?? 'unknown',
    devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
    fonts: await page.evaluate(() => {
      const families = ['Inter', 'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei'];

      return families.map((family) => ({
        family,
        loaded: document.fonts.check(`14px "${family}"`),
      }));
    }),
    platform: process.platform,
  };
}

/**
 * 单次弹窗测量：rect / computed style / 正文 overflow / 页面横向溢出。
 * 断言宽度按 V44 的 760 px 收口、窄屏按视口收缩，且标题与底部动作都在视口内。
 *
 * 视口收缩口径跟随真实 CSS：
 * - antd `Modal` 默认 `max-width: calc(100vw - 32px)`，`max-width: 767px` 媒体查询下降为
 *   `calc(100vw - 16px)`（`antd/es/modal/style/index.js`）；
 * - 公司新增/编辑弹窗由组件显式声明 `calc(100vw - 32px)`，窄屏同样保留 16 px 边距。
 */
async function measureDialog(
  page: Page,
  name: string,
  title: string,
  viewport: { height: number; width: number },
  baseWidth: number,
  expectBodyScroll: boolean,
  viewportInset?: number,
): Promise<DialogMeasurement> {
  const viewportLabel = `${viewport.width}x${viewport.height}`;
  const inset = viewportInset ?? (viewport.width <= 767 ? 16 : 32);
  const expectedWidth = Math.min(baseWidth, viewport.width - inset);

  const measured = await page.evaluate((expectedTitle: string) => {
    const boxOf = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        height: rect.height,
        left: rect.left,
        lineHeight: style.lineHeight,
        overflowX: style.overflowX,
        top: rect.top,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      };
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
      (item) => (item as HTMLElement).offsetParent !== null,
    );
    // 叠加弹窗（详情 + 拒绝）时必须定位到标题匹配的那一层，不能默认取第一个
    const dialog =
      dialogs.find((item) => (item.textContent ?? '').includes(expectedTitle)) ??
      dialogs[dialogs.length - 1] ??
      null;
    const heading = Array.from(dialog?.querySelectorAll('.ant-modal-title') ?? []).find((item) =>
      (item.textContent ?? '').includes(expectedTitle),
    );
    const body = dialog?.querySelector('.ant-modal-body') ?? null;
    const bodyBox = boxOf(body);

    return {
      body:
        bodyBox && body instanceof HTMLElement
          ? { ...bodyBox, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight }
          : null,
      bodyOverflowY: body instanceof HTMLElement ? getComputedStyle(body).overflowY : null,
      bodyText: (dialog?.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 300),
      content: boxOf(dialog?.querySelector('.ant-modal-container, .ant-modal-content') ?? null),
      dialog: boxOf(dialog ?? null),
      documentOverflowX:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      footer: boxOf(dialog?.querySelector('.ant-modal-footer') ?? null),
      titleBox: boxOf(heading ?? null),
    };
  }, title);

  expect(measured.dialog, `${name} 应存在可见弹窗`).not.toBeNull();
  expect(measured.documentOverflowX, `${name} 弹窗打开时页面不应横向溢出`).toBeLessThanOrEqual(0);
  expect(measured.dialog?.width, `${name} 宽度应对齐 V44 750~760 px 或按视口收缩`).toBeCloseTo(
    expectedWidth,
    0,
  );
  expect(measured.dialog?.x ?? -1, `${name} 弹窗左边不应越出视口`).toBeGreaterThanOrEqual(0);
  expect(
    (measured.dialog?.x ?? 0) + (measured.dialog?.width ?? 0),
    `${name} 弹窗右边不应越出视口`,
  ).toBeLessThanOrEqual(viewport.width);
  expect(measured.titleBox?.height ?? 0, `${name} 标题应可见`).toBeGreaterThan(0);
  expect(measured.footer, `${name} 底部动作区应存在`).not.toBeNull();

  const footerBottom = measured.footer === null ? null : measured.footer.y + measured.footer.height;

  expect(footerBottom, `${name} 底部动作区应在视口内`).not.toBeNull();
  expect(footerBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(viewport.height + 1);

  if (expectBodyScroll) {
    // 正文受控滚动：样式必须落在 auto，超出高度时才能滚动而不是把底部动作顶出视口
    expect(measured.bodyOverflowY, `${name} 正文应使用受控滚动`).toBe('auto');
  }

  return {
    body: measured.body,
    bodyText: measured.bodyText,
    content: measured.content,
    dialog: measured.dialog,
    documentOverflowX: measured.documentOverflowX,
    expectedWidth,
    footer: measured.footer,
    footerBottom,
    name,
    title,
    titleBox: measured.titleBox,
    viewport: viewportLabel,
  };
}

/**
 * 关键弹窗采集：两个桌面视口 + 390×844 各截图一次并测量。
 * 弹窗只做打开 / 截图 / 关闭，不提交任何写操作。
 */
async function captureDialog(
  page: Page,
  name: string,
  open: () => Promise<{ title: string }>,
  options: {
    baseWidth?: number;
    expectBodyScroll?: boolean;
    onClose?: () => Promise<void>;
    viewportInset?: number;
  } = {},
): Promise<void> {
  const baseWidth = options.baseWidth ?? 520;
  const expectBodyScroll = options.expectBodyScroll ?? false;
  const { title } = await open();

  const targetDialog = visibleDialog(page).filter({ hasText: title }).last();

  await expect(targetDialog).toBeVisible();
  await expect(targetDialog.getByText(title, { exact: false }).first()).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const viewportLabel = `${viewport.width}x${viewport.height}`;
    const fileName = `s5-${name}-${viewportLabel}.png`;

    viewportCaptures.push(
      await captureStableViewport(page, {
        fileName,
        filePath: path.join(VISUAL_DIR, fileName),
      }),
    );
    dialogMeasurements.push(
      await measureDialog(
        page,
        name,
        title,
        viewport,
        baseWidth,
        expectBodyScroll,
        options.viewportInset,
      ),
    );
  }

  await page.setViewportSize(VIEWPORTS[0]);

  if (options.onClose) {
    await options.onClose();
  } else {
    await page.keyboard.press('Escape');
  }

  await expect(visibleDialog(page)).toHaveCount(0);
}

/**
 * 收尾步骤：共享台账单事务回收夹具，seed 受管标记与管理员等级各自独立复原。
 * 任一步失败都不跳过后续步骤，最终汇总抛出。
 */
async function runS5Teardown(): Promise<Error | null> {
  return runTeardownSteps([
    { label: '清理本轮台账', run: () => cleanupRegistrationRound(ledger) },
    {
      label: '恢复 seed 公司受管标记',
      run: () => {
        const target = restoration.restoredManagedCompany;

        if (target === null) {
          return;
        }

        if (
          Number(
            mysqlQuery(
              `SELECT is_managed_company FROM organization WHERE id = ${target.organizationId}`,
            ),
          ) !== Number(target.original)
        ) {
          runGuardedFixtureWrite(
            env,
            `UPDATE organization SET is_managed_company = ${target.original} WHERE id = ${target.organizationId}`,
          );
        }
      },
    },
    {
      label: '恢复管理员等级',
      run: () => {
        for (const level of restoration.restoredAdminLevels) {
          if (readAdminLevel(level.loginName) !== level.original) {
            restoreAdminLevel(level.loginName, level.original);
          }
        }
      },
    },
  ]);
}

test.describe.serial('S5 管理端三页视觉复验（隔离库真实链路）', () => {
  test.beforeAll(() => {
    env = readBackendEnv();
    assertPhysicalCleanupAllowed(env);

    runTag = buildRunTag();
    ledger = createRegistrationRoundLedger();
    restoration = { restoredAdminLevels: [], restoredManagedCompany: null };

    peerOrganizationId = Number(
      mysqlQuery(
        `SELECT id FROM organization WHERE organization_code = '${LEVEL_TWO_ORGANIZATION_CODE}'`,
      ),
    );

    if (!Number.isSafeInteger(peerOrganizationId) || peerOrganizationId <= 0) {
      throw new Error(`未找到二级管理员可信公司：${LEVEL_TWO_ORGANIZATION_CODE}`);
    }

    const originalManaged = mysqlQuery(
      `SELECT is_managed_company FROM organization WHERE id = ${peerOrganizationId}`,
    );

    if (originalManaged !== '0' && originalManaged !== '1') {
      throw new Error(`原始 is_managed_company 值异常，拒绝改写：${originalManaged}`);
    }

    restoration.restoredManagedCompany = {
      organizationId: peerOrganizationId,
      original: originalManaged,
    };
    restoration.restoredAdminLevels = [
      { loginName: LEVEL_ONE_LOGIN, original: readAdminLevel(LEVEL_ONE_LOGIN) },
      { loginName: LEVEL_TWO_LOGIN, original: readAdminLevel(LEVEL_TWO_LOGIN) },
    ];
    // seed 可信公司只被本轮账号引用，不进入删除范围
    retainRegistrationRoundOrganization(ledger, peerOrganizationId);

    setAdminLevel(LEVEL_ONE_LOGIN, 1);
    setAdminLevel(LEVEL_TWO_LOGIN, 2);
    runGuardedFixtureWrite(
      env,
      `UPDATE organization SET is_managed_company = 1 WHERE id = ${peerOrganizationId}`,
    );
  });

  test.afterAll(async () => {
    let primaryError: unknown = null;

    try {
      // 清理与 seed 复原各自独立执行：任一失败都不跳过后续步骤
      const teardown = await runS5Teardown();

      if (teardown !== null) {
        throw teardown;
      }

      // 残留核验：本轮前缀必须为 0；非本轮哨兵账号保持存在
      const residueAccounts = Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM base_user_account WHERE login_email LIKE 'e2e.s5v.${runTag}%'`,
        ),
      );
      const residueOrganizations = Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM organization WHERE organization_code LIKE 'E2E_S5V_${runTag}%'`,
        ),
      );
      const sentinelAdmins = Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM base_user_account WHERE login_name IN ('${LEVEL_ONE_LOGIN}', '${LEVEL_TWO_LOGIN}')`,
        ),
      );

      expect(residueAccounts, '本轮账号前缀应零残留').toBe(0);
      expect(residueOrganizations, '本轮公司编码前缀应零残留').toBe(0);
      expect(sentinelAdmins, '非本轮 seed 管理员哨兵应保持存在').toBe(2);

      mkdirSync(VISUAL_DIR, { recursive: true });
      writeFileSync(
        MEASUREMENTS_FILE,
        `${JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            evidenceState: readWorkspaceEvidenceState(),
            environment,
            prototype: {
              dialogWidth: 760,
              file: 'docs/plan/1114后新文档/01-光刻维护平台-DemoV44-中英文切换.html',
              sha256: '60c92141ab3095fc73c07a600d0c9de5a99eea9d4f9865bc5c36612af79fbe3c',
            },
            runTag,
            viewportSet: VIEWPORTS.map((item) => `${item.width}x${item.height}`),
            measurements,
            dialogs: dialogMeasurements,
            viewportCaptures,
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

  test('一级管理员：三页与关键弹窗只读采集', async ({ page }) => {
    test.setTimeout(300_000);

    // 夹具：本公司（二级可信公司）与外公司各一名客户，外加一条待审工程师申请
    ownCustomer = {
      accountId: 0,
      loginName: `e2es5vo${runTag}`,
    };
    foreignCustomer = {
      accountId: 0,
      loginName: `e2es5vf${runTag}`,
    };
    engineerApplicant = {
      accountId: 0,
      loginName: `e2es5ve${runTag}`,
    };
    foreignCompanyName = `E2E S5 视觉外公司-${runTag}`;

    const foreignCompany = createFixtureCompany(`E2E_S5V_ORG_${runTag}`, foreignCompanyName);

    const ownLoginEmail = `e2e.s5v.own.${runTag}@example.com`;
    const own = await registerWeb({
      loginEmail: ownLoginEmail,
      loginName: ownCustomer.loginName,
      nickname: `视觉客户甲${runTag.slice(-4)}`,
      organizationId: peerOrganizationId,
      type: 'CUSTOMER',
    });
    ownCustomer.accountId = own.accountId;
    registerFixtureAccount({
      accountId: own.accountId,
      applicationId: own.applicationId,
      loginEmail: ownLoginEmail,
      loginName: ownCustomer.loginName,
    });

    const foreignLoginEmail = `e2e.s5v.foreign.${runTag}@example.com`;
    const foreign = await registerWeb({
      loginEmail: foreignLoginEmail,
      loginName: foreignCustomer.loginName,
      nickname: `视觉客户乙${runTag.slice(-4)}`,
      organizationId: foreignCompany.id,
      type: 'CUSTOMER',
    });
    foreignCustomer.accountId = foreign.accountId;
    registerFixtureAccount({
      accountId: foreign.accountId,
      applicationId: foreign.applicationId,
      loginEmail: foreignLoginEmail,
      loginName: foreignCustomer.loginName,
    });

    const engineerLoginEmail = `e2e.s5v.engineer.${runTag}@example.com`;
    const engineer = await registerWeb({
      loginEmail: engineerLoginEmail,
      loginName: engineerApplicant.loginName,
      nickname: `视觉工程师${runTag.slice(-4)}`,
      organizationId: peerOrganizationId,
      phone: '13800000000',
      realName: '视觉工程师',
      type: 'ENGINEER',
    });
    engineerApplicant.accountId = engineer.accountId;

    if (engineer.applicationId === null) {
      throw new Error('待审工程师申请未返回 applicationId');
    }

    registerFixtureAccount({
      accountId: engineer.accountId,
      applicationId: engineer.applicationId,
      loginEmail: engineerLoginEmail,
      loginName: engineerApplicant.loginName,
    });

    await loginViaUi(page, LEVEL_ONE_LOGIN, env.MOCK_SEED_PASSWORD);
    await captureEnvironment(page);

    // 公司档案
    await enterPageFromNav(page, PAGES[0]);
    await expect(page.getByRole('row').filter({ hasText: foreignCompanyName })).toBeVisible();
    await capturePage(page, 'admin1', PAGES[0]);

    await captureDialog(
      page,
      'admin1-companies-add-dialog',
      async () => {
        await page.getByRole('button', { name: '新增公司' }).click();

        return { title: '新增公司档案' };
      },
      { baseWidth: 760, expectBodyScroll: true, viewportInset: 32 },
    );

    await captureDialog(
      page,
      'admin1-companies-edit-dialog',
      async () => {
        await page
          .getByRole('row')
          .filter({ hasText: foreignCompanyName })
          .getByRole('button', { name: '编辑' })
          .click();

        return { title: '编辑公司档案' };
      },
      { baseWidth: 760, expectBodyScroll: true, viewportInset: 32 },
    );

    // 注册审批
    await enterPageFromNav(page, PAGES[1]);
    await expect(
      page.getByRole('row').filter({ hasText: engineerApplicant.loginName }),
    ).toBeVisible();
    await capturePage(page, 'admin1', PAGES[1]);

    await captureDialog(
      page,
      'admin1-applications-reject-dialog',
      async () => {
        await page
          .getByRole('row')
          .filter({ hasText: engineerApplicant.loginName })
          .getByRole('button', { name: '详情' })
          .click();

        const detailDialog = visibleDialog(page);

        await expect(detailDialog).toBeVisible();
        await detailDialog.getByRole('button', { name: /拒\s*绝/ }).click();

        return { title: '拒绝申请' };
      },
      {
        // 拒绝弹窗叠在详情弹窗上：先关拒绝，再关详情，确保下一段采集不受残留弹窗影响
        onClose: async () => {
          await page.keyboard.press('Escape');
          await expect(page.getByText('拒绝申请', { exact: false })).toBeHidden();
          await visibleDialog(page)
            .getByRole('button', { name: /关\s*闭/ })
            .click();
        },
      },
    );

    // 用户管理
    await enterPageFromNav(page, PAGES[2]);
    await expect(
      page.getByRole('row').filter({ hasText: foreignCustomer.loginName }),
    ).toBeVisible();
    await capturePage(page, 'admin1', PAGES[2]);

    await captureDialog(page, 'admin1-users-reset-dialog', async () => {
      await page
        .getByRole('row')
        .filter({ hasText: foreignCustomer.loginName })
        .getByRole('button', { name: '重置密码' })
        .click();

      return { title: '重置密码' };
    });
  });

  test('二级管理员：三页只读范围与写入口缺席', async ({ page }) => {
    test.setTimeout(300_000);

    await loginViaUi(page, LEVEL_TWO_LOGIN, env.MOCK_SEED_PASSWORD);

    // 公司档案：二级只读最小名称名单（按设计跨公司可读，不含联系方式与操作入口）
    await enterPageFromNav(page, PAGES[0]);
    await expect(page.getByText('当前账号仅可查看公司名称名单。')).toBeVisible();
    // 名称名单是 R015 最小字段视图：二级可见跨公司名称，但仅限 id/name
    await expect(page.getByText(foreignCompanyName)).toBeVisible();
    await expect(page.getByRole('button', { name: '新增公司' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '编辑' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: '联系人' })).toHaveCount(0);
    await capturePage(page, 'admin2', PAGES[0]);

    // 注册审批：仅本公司申请，且范围提示为本公司
    await enterPageFromNav(page, PAGES[1]);
    await expect(page.getByText('当前账号仅可查看并审批本公司的工程师注册申请。')).toBeVisible();
    await expect(
      page.getByRole('row').filter({ hasText: engineerApplicant.loginName }),
    ).toBeVisible();
    await capturePage(page, 'admin2', PAGES[1]);

    // 用户管理：仅本公司客户
    await enterPageFromNav(page, PAGES[2]);
    await expect(page.getByText('当前账号仅可查看并管理本公司的普通用户账号。')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: ownCustomer.loginName })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: foreignCustomer.loginName })).toHaveCount(
      0,
    );
    await capturePage(page, 'admin2', PAGES[2]);
  });
});

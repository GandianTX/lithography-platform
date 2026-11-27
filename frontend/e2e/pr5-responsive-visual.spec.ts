// e2e/pr5-responsive-visual.spec.ts
//
// PR5 S6-1 / S6-2 / S6-3 响应式、可复现性与交付验收（无后端确定性版本）：
// 会话由 helpers/auth-session-seed 预置，GraphQL 一律走仓库内 mock
// （helpers/customer-repair-request-mocks 与 helpers/reference-document-mocks），
// 不依赖真实后端、开发库、backend/env/.env.development、docs/tmp、个人目录或远程 CDN，
// fresh clone / 临时 worktree 直接可跑，0 skipped。
// 真实前后端链路（登录 + 完整闭环 + 角色权限）由 *-real.spec.ts 承担，职责分离。
//
// 验收内容（PR5 计划表 S6，数值源 frontend/docs/gkj-visual-baseline.md §1 / §6.4.4）：
// - S6-1：M 档 + 100% 缩放（helpers/visual-evidence 锁定 EVIDENCE_SCALE_LEVEL='M'、
//   EVIDENCE_ZOOM='100'）在 1366×768 / 1440×900 / 1920×1080 三个基准视口全量采集
//   PR5 七页就绪态截图：客户四页（/customer 系；2026-09-29 起复用同一整合工作台，
//   首页即 create 态、列表与详情为同一工作台的 history-list / history-detail 态）、
//   资料列表（ENGINEER），资料新增 / 资料详情（SUPER_ADMIN，写入口按后端口径只给
//   SUPER_ADMIN）。每页每个视口先断言该页自身真实文案 / 表单控件 / 活动条目已渲染（不是
//   「有 DOM」），再断言 PNG 物理尺寸**严格等于**视口。窄视口 375×667 归 S1/S2/S3/S4
//   既有 spec，本文件不重复采集。
// - S6-2：字号档位 S→M→L→M 往返过程中，四个停靠点上都断言「创建表单四控件 / 列表
//   条目删除按钮 / 删除 Popconfirm / 分页器上一页与下一页 / 侧栏退出按钮 / 全局 AI
//   浮动入口」仍可达（可见 + 启用 + 几何位于视口内）；往返结束根字号回到 M 档 16px。
// - S6-3：三个基准视口 × 七页整页无横向滚动；长文本数据集下超宽内容不得撑破页面：
//   客户列表条目在容器内换行不溢出（列表已无表格），资料列表必要的横向滚动只发生在
//   表格容器 `.ant-table-content`。
//
// 全局 AI 浮动入口（.entry-trigger-shell）宿主条件：唯一宿主是 AppLayout
// （src/app/layout/app-layout.tsx:270-287，`{!isSidecarOpen ? <div className="entry-trigger-shell">…}`），
// 而 PR5 七页全部挂在 AppLayout 根路由之下（src/app/router/app.tsx:218 `element: <AppLayout />`），
// 故七页默认都渲染该浮动入口，无需像 admin-document-database-visual.spec.ts 那样隐藏。
//
// 截图与 JSON 写入 testInfo outputPath（frontend/test-results/...），由采集人复制归档到
// docs/tmp/PR/PR5-证据（本地可追溯，不随 PR 提交）。命名遵循
// frontend/docs/gkj-visual-baseline.md §1，由 helpers/visual-evidence.ts 统一生成；
// 所有截图经 captureStableViewport（2026-09-30 S2：截图前滚动复位到页面顶部 +
// scrollY/视口/页面模式/Git SHA 元数据随 JSON 落盘，两轮截图构图一致可审计）。

import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { seedAuthSession, type SeededAuthSessionRole } from './helpers/auth-session-seed';
import {
  installCustomerRepairRequestMocks,
  LONG_ERROR_CODE,
  LONG_REQUEST_NO,
  readUnregisteredOperations,
} from './helpers/customer-repair-request-mocks';
import {
  installReferenceLibraryMocks,
  LIST_ITEMS,
  type ListItem,
  LONG_TEXT_ITEMS,
} from './helpers/reference-document-mocks';
import {
  buildEvidenceFileName,
  captureStableViewport,
  readPngDimensions,
  waitForFontsReady,
} from './helpers/visual-evidence';

type ViewportSpec = { height: number; label: string; width: number };

/** 基准三视口（M 档 / zoom 100 由 visual-evidence 常量表达）；窄视口归既有 spec。 */
const VIEWPORTS: readonly ViewportSpec[] = [
  { height: 768, label: '1366x768', width: 1366 },
  { height: 900, label: '1440x900', width: 1440 },
  { height: 1080, label: '1920x1080', width: 1920 },
];

/** M 档根字号（src/app/providers/theme-constants.ts standard.htmlFontSize）。 */
const M_ROOT_FONT_SIZE = '16px';

/** S6-2 停靠点顺序：S→M→L→M 往返。 */
const FONT_SCALE_DOCKS = ['S', 'M', 'L', 'M'] as const;

/** S6-2 固定视口：基准 §1 锁定视口，且实测六类控件在各档位均位于视口内。 */
const S6_2_VIEWPORT: ViewportSpec = { height: 900, label: '1440x900', width: 1440 };

const CUSTOMER_HOME_PATH = '/customer';
const CUSTOMER_CREATE_PATH = '/customer/repair-requests/new';
const CUSTOMER_LIST_PATH = '/customer/repair-requests';
const CUSTOMER_DETAIL_ID = 920002;
const CUSTOMER_DETAIL_PATH = `${CUSTOMER_LIST_PATH}/${CUSTOMER_DETAIL_ID}`;
const REFERENCE_LIST_PATH = '/reference-documents';
const REFERENCE_NEW_PATH = '/reference-documents/new';
const REFERENCE_DETAIL_ID = 980001;
const REFERENCE_DETAIL_PATH = `/reference-documents/${REFERENCE_DETAIL_ID}`;

/** PR5 七页的可执行定义：角色 + mock 来源 + 就绪态断言（用页面自身真实渲染物）。 */
type Pr5PageCase = {
  /** 证据文件「区域」段（命名规则见 visual-evidence） */
  area: string;
  mocks: 'customer' | 'reference';
  mockOptions?: Parameters<typeof installCustomerRepairRequestMocks>[1];
  referenceItems?: ListItem[];
  path: string;
  role: SeededAuthSessionRole;
  /** 该页是否应存在紧凑表格容器（S6-3 的表格内横滚断言只对 required 页生效，避免空转） */
  tableScope: 'absent' | 'required';
  title: string;
  expectReady: (page: Page) => Promise<void>;
};

const CUSTOMER_HOME_CASE: Pr5PageCase = {
  area: 'pr5-responsive-customer-home',
  expectReady: async (page) => {
    await expect(page.locator('.page-title')).toHaveText('客户页面');
    // 固定页头入口（同名空态按钮仅在库为空时出现，此处固定夹具 2 条已就绪）
    await expect(
      page.locator('.page-header').getByRole('button', { name: '发起维修申请' }),
    ).toBeVisible();
    // create 态右栏表单可用 + 左栏列表上下文就绪
    await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();
    await expect(page.locator('.activity-item')).toHaveCount(2);
  },
  mocks: 'customer',
  mockOptions: {},
  path: CUSTOMER_HOME_PATH,
  role: 'CUSTOMER',
  tableScope: 'absent',
  title: '客户首页',
};

const CUSTOMER_CREATE_CASE: Pr5PageCase = {
  area: 'pr5-responsive-customer-create',
  expectReady: async (page) => {
    await expect(page.locator('.page-title')).toHaveText('客户页面');
    await expect(
      page.getByText('提交设备维修申请，并跟踪接单情况、处理进度与工程师回复。'),
    ).toBeVisible();
    // 就绪态：型号已返回 → 下拉与字段可用（加载中/失败会禁用）
    await expect(page.getByRole('combobox')).toBeEnabled();
    await expect(page.getByPlaceholder('例如：E-2001')).toBeVisible();
    await expect(page.getByPlaceholder('请描述设备故障现象与发生场景')).toBeVisible();
    await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();
  },
  mocks: 'customer',
  mockOptions: { models: 'ready' },
  path: CUSTOMER_CREATE_PATH,
  role: 'CUSTOMER',
  tableScope: 'absent',
  title: '客户创建页',
};

const CUSTOMER_LIST_CASE: Pr5PageCase = {
  area: 'pr5-responsive-customer-list',
  expectReady: async (page) => {
    await expect(page.locator('.page-title')).toHaveText('客户页面');
    await expect(page.getByRole('heading', { name: '我的维修申请' })).toBeVisible();
    await expect(page.locator('.activity-item')).toHaveCount(2);
    // 编号同时出现在左栏条目与右栏默认详情（第一项 0001）标题，故取首个
    await expect(page.getByText('MOCK-RR-2026-0001').first()).toBeVisible();
    // 右栏默认详情（列表态以第一项 920001 为目标，mock 按 id 分发返回 0001）异步就绪：
    // 右栏标题出现且骨架结束；0 条回复时整个回复模块不渲染（S2-6 口径）
    await expect(
      page.locator('.customer-workspace-detail-pane').getByText('MOCK-RR-2026-0001'),
    ).toBeVisible();
    await expect(page.locator('.customer-workspace-detail-pane .ant-skeleton')).toHaveCount(0);
    await expect(page.getByText('工程师回复（2）')).toHaveCount(0);
  },
  mocks: 'customer',
  mockOptions: { list: 'ready' },
  path: CUSTOMER_LIST_PATH,
  role: 'CUSTOMER',
  tableScope: 'absent',
  title: '客户列表页',
};

const CUSTOMER_DETAIL_CASE: Pr5PageCase = {
  area: 'pr5-responsive-customer-detail',
  expectReady: async (page) => {
    await expect(page.locator('.page-title')).toHaveText('客户页面');
    await expect(page.getByText('MOCK-RR-2026-0002').first()).toBeVisible();
    // 有回复态：回复模块、工程师昵称与正文均渲染（不只看骨架）
    await expect(page.getByText('工程师回复（2）')).toBeVisible();
    await expect(page.getByText('李工')).toBeVisible();
    await expect(page.getByText('已更换温控组件并完成标定，套刻误差回到规格内。')).toBeVisible();
  },
  mocks: 'customer',
  mockOptions: { detail: 'with-responses' },
  path: CUSTOMER_DETAIL_PATH,
  role: 'CUSTOMER',
  tableScope: 'absent',
  title: '客户详情页（有回复）',
};

const REFERENCE_LIST_CASE: Pr5PageCase = {
  area: 'pr5-responsive-reference-list',
  expectReady: async (page) => {
    await expect(page.locator('.page-title')).toHaveText('历史维修记录库');
    await expect(page.locator('.reference-library-table-scope')).toHaveCount(1);
    await expect(page.getByText('光源模块维护指南')).toBeVisible();
    await expect(page.locator('.reference-library-card-footer')).toContainText(
      `共 ${LIST_ITEMS.length} 条`,
    );
  },
  mocks: 'reference',
  path: REFERENCE_LIST_PATH,
  role: 'ENGINEER',
  tableScope: 'required',
  title: '资料列表页',
};

const REFERENCE_NEW_CASE: Pr5PageCase = {
  area: 'pr5-responsive-reference-new',
  expectReady: async (page) => {
    await expect(page.locator('.page-title')).toHaveText('新增参考资料');
    await expect(page.locator('.surface-panel form')).toHaveCount(1);
    await expect(page.getByPlaceholder('请输入文档标题')).toBeVisible();
    await expect(page.getByRole('combobox').first()).toBeEnabled();
    await expect(page.getByRole('button', { name: /创建资料/ })).toBeVisible();
  },
  mocks: 'reference',
  path: REFERENCE_NEW_PATH,
  role: 'SUPER_ADMIN',
  tableScope: 'absent',
  title: '资料新增页',
};

const REFERENCE_DETAIL_CASE: Pr5PageCase = {
  area: 'pr5-responsive-reference-detail',
  expectReady: async (page) => {
    await expect(page.locator('.page-title')).toHaveText('历史维修记录详情');
    await expect(page.locator('.reference-document-detail')).toHaveCount(1);
    await expect(page.locator('.ant-card-head-title')).toHaveText(LIST_ITEMS[0].title);
    await expect(page.locator('.ant-descriptions-item-content')).toContainText([
      'light-source-maintenance.pdf',
    ]);
  },
  mocks: 'reference',
  path: REFERENCE_DETAIL_PATH,
  role: 'SUPER_ADMIN',
  tableScope: 'absent',
  title: '资料详情页',
};

/** S6-1：客户四页（同一角色，单次会话预置即可）。 */
const CUSTOMER_PAGE_CASES: readonly Pr5PageCase[] = [
  CUSTOMER_HOME_CASE,
  CUSTOMER_CREATE_CASE,
  CUSTOMER_LIST_CASE,
  CUSTOMER_DETAIL_CASE,
];

/** S6-1：资料列表（ENGINEER，只读角色）。 */
const REFERENCE_READ_CASES: readonly Pr5PageCase[] = [REFERENCE_LIST_CASE];

/** S6-1：资料写页面（SUPER_ADMIN；后端口径写入口只给 SUPER_ADMIN）。 */
const REFERENCE_WRITE_CASES: readonly Pr5PageCase[] = [REFERENCE_NEW_CASE, REFERENCE_DETAIL_CASE];

/** S6-3：七页全集，按角色分组以减少会话切换。 */
const ALL_PAGE_CASES: readonly Pr5PageCase[] = [
  ...CUSTOMER_PAGE_CASES,
  REFERENCE_NEW_CASE,
  REFERENCE_DETAIL_CASE,
  REFERENCE_LIST_CASE,
];

/** 整页横向溢出量（<= 0 表示无横滚）。 */
function measurePageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** 表格容器（.ant-table-content）的横滚量：AntD `scroll.x` 的落点即「必要横滚」的唯一容器。 */
function measureTableOverflow(
  page: Page,
): Promise<{ clientWidth: number; overflowX: string; scrollWidth: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.ant-table-content');

    if (!el) {
      return null;
    }

    return {
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      scrollWidth: el.scrollWidth,
    };
  });
}

/** 根字号（M 档口径 16px）。 */
function readRootFontSize(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
}

/** 切换字号档位并核对 segmented 选中项已切换（口径同 visual-shell-acceptance.spec.ts）。 */
async function clickFontScale(page: Page, label: 'S' | 'M' | 'L'): Promise<void> {
  const control = page.locator('.app-font-scale-control');
  await control.getByText(label, { exact: true }).click();
  await expect(control.locator('.ant-segmented-item-selected')).toHaveText(label);
}

type Box = { height: number; width: number; x: number; y: number };

/** 几何包含判定：可见 + 几何盒完整落在视口内（可达性不靠肉眼）。 */
async function expectInViewport(
  locator: Locator,
  label: string,
  viewport: { height: number; width: number },
): Promise<Box> {
  await expect(locator, `${label} 应可见`).toBeVisible();

  const box = await locator.boundingBox();

  expect(box, `${label} 应有几何盒`).not.toBeNull();

  const measured = box as Box;

  expect(measured.x, `${label} 左边界不得越出视口`).toBeGreaterThanOrEqual(-0.5);
  expect(measured.y, `${label} 上边界不得越出视口`).toBeGreaterThanOrEqual(-0.5);
  expect(measured.x + measured.width, `${label} 右边界不得越出视口`).toBeLessThanOrEqual(
    viewport.width + 0.5,
  );
  expect(measured.y + measured.height, `${label} 下边界不得越出视口`).toBeLessThanOrEqual(
    viewport.height + 0.5,
  );

  return measured;
}

/** 可达 = 可见 + 启用 + 几何位于视口内。 */
async function expectReachable(
  locator: Locator,
  label: string,
  viewport: { height: number; width: number },
): Promise<Box> {
  const box = await expectInViewport(locator, label, viewport);

  await expect(locator, `${label} 应启用`).toBeEnabled();

  return box;
}

/**
 * 预置会话的隔离窗：seedAuthSession 内部先 goto('/') 落地再写会话，落地导航用的
 * 是页面上现存的旧会话（跨用例/跨角色即旧角色），会以旧角色首页发出查询。这段
 * 查询一律 abort 兜底 —— 既不能落入即将安装的目标 stub（失败关闭），也不得放行到
 * dev proxy（后端不可达时的 proxy 连接错误会打断 dev server）；abort 只影响旧角色
 * 首页渲染，无断言依赖（2026-09-29 实锤）。
 */
async function seedAuthSessionWithAbort(page: Page, role: SeededAuthSessionRole): Promise<void> {
  await page.route('**/graphql', async (route) => {
    await route.abort();
  });
  await seedAuthSession(page, role);
  await page.unroute('**/graphql');
}

/** 会话预置 + 按用例所属 mock 来源安装 stub（先卸载上一用例的 GraphQL 路由，避免叠加）。 */
async function prepareCase(page: Page, testCase: Pr5PageCase): Promise<void> {
  // 跨 mock/跨角色的切换必须严格按序：
  // 1) 离舱：旧业务页卸载，其在途请求被浏览器取消；
  // 2) 卸 stub：window 内无任何 mock；
  // 3) 预置会话：旧角色查询经 seedAuthSessionWithAbort 的 abort 窗拦下，不产生留痕；
  // 4) 再离舱：预置完成后清掉角色首页，避免其延迟微任务落入新 stub；
  // 5) 装 stub：此后只有目标用例页面的查询会命中。
  await page.goto('about:blank');
  await page.unroute('**/graphql');
  await seedAuthSessionWithAbort(page, testCase.role);
  await page.goto('about:blank');

  if (testCase.mocks === 'customer') {
    await installCustomerRepairRequestMocks(page, testCase.mockOptions ?? {});
  } else {
    await installReferenceLibraryMocks(page, testCase.referenceItems);
  }
}

function writeEvidence(testInfo: TestInfo, fileName: string, payload: unknown): void {
  const evidenceDir = testInfo.outputPath();

  mkdirSync(evidenceDir, { recursive: true });

  const file = path.join(evidenceDir, fileName);

  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`[visual-evidence] ${file}`);
}

// review P2-2 回归守卫：AntD 静态 message 无法消费 ConfigProvider 的 dynamic theme，
// 真实浏览器会打印「[antd: message] Static function can not consume context like dynamic theme」。
// PR5 的反馈呈现统一走 message.useMessage()（src/shared/ui/message-feedback，由
// app/providers/theme-provider 在 ConfigProvider 内挂 context holder），
// 因此任何 PR5 路径都不应再出现该告警。
const ANT_DYNAMIC_THEME_WARNING = 'Static function can not consume context like dynamic theme';
const forbiddenAntdWarnings: string[] = [];

test.beforeEach(async ({ page }) => {
  forbiddenAntdWarnings.length = 0;
  page.on('console', (message) => {
    const text = message.text();

    if (text.includes(ANT_DYNAMIC_THEME_WARNING) && !forbiddenAntdWarnings.includes(text)) {
      forbiddenAntdWarnings.push(text);
    }
  });
});

// mock 失败关闭的兜底断言：任何用例里出现未登记的 operationName 都必须失败
// （customer mock 已同时抛错；此处保证即使抛错被吞，留痕也不会静默通过）。
test.afterEach(async ({ page }) => {
  expect(readUnregisteredOperations(page), '未登记的 GraphQL operationName').toEqual([]);
  expect(forbiddenAntdWarnings, 'PR5 路径不得出现 AntD 静态 message 的 dynamic theme 告警').toEqual(
    [],
  );
});

// ------------------------------------------------------------ S6-1：三视口 × 七页整页采集

test('S6-1 客户四页 M 档 100% 缩放在三个基准视口全量采集（CUSTOMER）', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);

  const capturedAt = new Date();
  const evidence: Record<string, unknown> = {};

  await prepareCase(page, CUSTOMER_HOME_CASE);

  for (const testCase of CUSTOMER_PAGE_CASES) {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await page.goto(testCase.path);
      await waitForFontsReady(page);
      await testCase.expectReady(page);

      const overflow = await measurePageOverflow(page);
      expect(
        overflow,
        `${testCase.title} ${viewport.label} 不应出现整页横向滚动`,
      ).toBeLessThanOrEqual(0);

      const fileName = buildEvidenceFileName({
        area: testCase.area,
        capturedAt,
        role: testCase.role,
        viewportLabel: viewport.label,
      });
      const pngPath = path.join(testInfo.outputPath(), fileName);

      const capture = await captureStableViewport(page, { fileName, filePath: pngPath });

      const png = readPngDimensions(pngPath);

      expect(png, `${fileName} 物理尺寸应严格等于视口`).toEqual({
        height: viewport.height,
        width: viewport.width,
      });

      evidence[`${testCase.area}-${viewport.label}`] = {
        capture,
        fileName,
        overflow,
        path: testCase.path,
        png,
        role: testCase.role,
      };
    }
  }

  writeEvidence(testInfo, 'pr5-s6-1-customer-evidence.json', {
    acceptedItems: ['S6-1'],
    capturedAt: capturedAt.toISOString(),
    scale: 'M',
    viewports: VIEWPORTS,
    zoom: '100',
    pages: evidence,
  });
});

test('S6-1 资料列表 M 档三基准视口采集（ENGINEER，只读角色）', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const capturedAt = new Date();
  const evidence: Record<string, unknown> = {};

  await prepareCase(page, REFERENCE_LIST_CASE);

  for (const testCase of REFERENCE_READ_CASES) {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await page.goto(testCase.path);
      await waitForFontsReady(page);
      await testCase.expectReady(page);

      const overflow = await measurePageOverflow(page);
      expect(
        overflow,
        `${testCase.title} ${viewport.label} 不应出现整页横向滚动`,
      ).toBeLessThanOrEqual(0);

      const fileName = buildEvidenceFileName({
        area: testCase.area,
        capturedAt,
        role: testCase.role,
        viewportLabel: viewport.label,
      });
      const pngPath = path.join(testInfo.outputPath(), fileName);

      const capture = await captureStableViewport(page, { fileName, filePath: pngPath });

      const png = readPngDimensions(pngPath);

      expect(png, `${fileName} 物理尺寸应严格等于视口`).toEqual({
        height: viewport.height,
        width: viewport.width,
      });

      evidence[`${testCase.area}-${viewport.label}`] = {
        capture,
        fileName,
        overflow,
        path: testCase.path,
        png,
        role: testCase.role,
      };
    }
  }

  writeEvidence(testInfo, 'pr5-s6-1-reference-read-evidence.json', {
    acceptedItems: ['S6-1'],
    capturedAt: capturedAt.toISOString(),
    scale: 'M',
    viewports: VIEWPORTS,
    zoom: '100',
    pages: evidence,
  });
});

test('S6-1 资料新增与详情 M 档三基准视口采集（SUPER_ADMIN，写入口角色）', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);

  const capturedAt = new Date();
  const evidence: Record<string, unknown> = {};

  await prepareCase(page, REFERENCE_NEW_CASE);

  for (const testCase of REFERENCE_WRITE_CASES) {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await page.goto(testCase.path);
      await waitForFontsReady(page);
      await testCase.expectReady(page);

      const overflow = await measurePageOverflow(page);
      expect(
        overflow,
        `${testCase.title} ${viewport.label} 不应出现整页横向滚动`,
      ).toBeLessThanOrEqual(0);

      const fileName = buildEvidenceFileName({
        area: testCase.area,
        capturedAt,
        role: testCase.role,
        viewportLabel: viewport.label,
      });
      const pngPath = path.join(testInfo.outputPath(), fileName);

      const capture = await captureStableViewport(page, { fileName, filePath: pngPath });

      const png = readPngDimensions(pngPath);

      expect(png, `${fileName} 物理尺寸应严格等于视口`).toEqual({
        height: viewport.height,
        width: viewport.width,
      });

      evidence[`${testCase.area}-${viewport.label}`] = {
        capture,
        fileName,
        overflow,
        path: testCase.path,
        png,
        role: testCase.role,
      };
    }
  }

  writeEvidence(testInfo, 'pr5-s6-1-reference-write-evidence.json', {
    acceptedItems: ['S6-1'],
    capturedAt: capturedAt.toISOString(),
    scale: 'M',
    viewports: VIEWPORTS,
    zoom: '100',
    pages: evidence,
  });
});

// ------------------------------------------------------------ S6-2：S→M→L→M 往返可达性

test('S6-2 创建页 S→M→L→M 往返：表单四控件、侧栏退出与 AI 浮动入口仍可达', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  const capturedAt = new Date();
  const docksEvidence: Record<string, unknown> = {};

  await prepareCase(page, CUSTOMER_CREATE_CASE);
  await page.setViewportSize({ height: S6_2_VIEWPORT.height, width: S6_2_VIEWPORT.width });
  await page.goto(CUSTOMER_CREATE_PATH);
  await waitForFontsReady(page);
  await CUSTOMER_CREATE_CASE.expectReady(page);

  // 控件定位真源（表单四件套：设备型号选择 / 错误码输入 / 故障描述输入 / 提交按钮）
  const modelSelect = page.locator('.ant-select').first();
  const modelCombobox = page.getByRole('combobox').first();
  const errorCodeInput = page.getByPlaceholder('例如：E-2001');
  const faultDescriptionInput = page.getByPlaceholder('请描述设备故障现象与发生场景');
  const submitButton = page.getByRole('button', { name: '提交申请' });

  for (const [step, dock] of FONT_SCALE_DOCKS.entries()) {
    await clickFontScale(page, dock);

    await expectReachable(modelSelect, `创建页 设备型号选择（${dock} 档）`, S6_2_VIEWPORT);
    await expect(modelCombobox, `创建页 设备型号选择（${dock} 档）应启用`).toBeEnabled();
    await expectReachable(errorCodeInput, `创建页 错误码输入（${dock} 档）`, S6_2_VIEWPORT);
    await expectReachable(
      faultDescriptionInput,
      `创建页 故障描述输入（${dock} 档）`,
      S6_2_VIEWPORT,
    );
    await expectReachable(submitButton, `创建页 提交按钮（${dock} 档）`, S6_2_VIEWPORT);

    const logout = await expectReachable(
      page.locator('.app-sidebar-footer button'),
      `侧栏退出按钮（${dock} 档）`,
      S6_2_VIEWPORT,
    );
    // 侧栏退出按钮口径同 visual-shell-acceptance.spec.ts：底部不得越出视口
    expect(
      logout.y + logout.height,
      `侧栏退出按钮底部（${dock} 档）应 <= 视口高度`,
    ).toBeLessThanOrEqual(S6_2_VIEWPORT.height);

    await expectReachable(
      page.locator('.entry-trigger-shell button'),
      `AI 浮动入口按钮（${dock} 档）`,
      S6_2_VIEWPORT,
    );

    const rootFontSize = await readRootFontSize(page);
    const fileName = buildEvidenceFileName({
      area: `pr5-s6-2-create-step-${step + 1}-dock-${dock}`,
      capturedAt,
      role: CUSTOMER_CREATE_CASE.role,
      scaleLevel: dock,
      viewportLabel: S6_2_VIEWPORT.label,
    });
    const pngPath = path.join(testInfo.outputPath(), fileName);

    const capture = await captureStableViewport(page, { fileName, filePath: pngPath });

    const png = readPngDimensions(pngPath);

    expect(png, `${fileName} 物理尺寸应严格等于视口`).toEqual({
      height: S6_2_VIEWPORT.height,
      width: S6_2_VIEWPORT.width,
    });

    // key 带步序：S→M→L→M 的末次 M 与首次 M 档位相同，只用 label 做 key 会互相覆盖，
    // 丢掉「往返确实回到 M」的痕迹（证据必须能逐停靠点追溯）。
    docksEvidence[`${step + 1}-${dock}`] = {
      capture,
      fileName,
      logoutBottom: logout.y + logout.height,
      png,
      rootFontSize,
      selected: await page
        .locator('.app-font-scale-control .ant-segmented-item-selected')
        .textContent(),
    };
  }

  // 往返结束回到 M 档：根字号回到 16px（theme-constants standard.htmlFontSize）
  expect(await readRootFontSize(page), '往返结束后根字号应回到 M 档').toBe(M_ROOT_FONT_SIZE);

  writeEvidence(testInfo, 'pr5-s6-2-create-evidence.json', {
    acceptedItems: ['S6-2'],
    capturedAt: capturedAt.toISOString(),
    docks: docksEvidence,
    path: CUSTOMER_CREATE_PATH,
    viewport: S6_2_VIEWPORT,
  });
});

test('S6-2 列表页 S→M→L→M 往返：条目删除、Popconfirm、分页与侧栏退出仍可达', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);

  const capturedAt = new Date();
  const docksEvidence: Record<string, unknown> = {};

  // list: 'many'（12 条）→ 分页器真实出现（12 > PAGE_SIZE 10）；会话预置走同款
  // abort 窗（本 test 新 page 无旧会话时落 /login 零查询，防御重试/复用场景）
  await page.unroute('**/graphql');
  await seedAuthSessionWithAbort(page, CUSTOMER_LIST_CASE.role);
  await installCustomerRepairRequestMocks(page, { list: 'many' });
  await page.setViewportSize({ height: S6_2_VIEWPORT.height, width: S6_2_VIEWPORT.width });
  await page.goto(CUSTOMER_LIST_PATH);
  await waitForFontsReady(page);

  // 列表就绪态按 many 夹具判定（不能用 CUSTOMER_LIST_CASE.expectReady：该夹具 2 条、
  // 首条 0001；many 首页 10 条、首条申请编号 MOCK-RR-2026-1001）
  await expect(page.locator('.page-title')).toHaveText('客户页面');
  await expect(page.getByRole('heading', { name: '我的维修申请' })).toBeVisible();
  await expect(page.getByText('MOCK-RR-2026-1001').first()).toBeVisible();

  const pagination = page.locator('.ant-pagination');
  const prevButton = page.locator('.ant-pagination-prev button');
  const nextButton = page.locator('.ant-pagination-next button');
  const activePage = page.locator('.ant-pagination-item-active');
  const popconfirm = page.locator('.ant-popconfirm');

  // 分页器真的出现：total 12 / pageSize 10 → 2 页
  await expect(pagination, '分页器应真实出现（total 12 > pageSize 10）').toBeVisible();
  await expect(page.locator('.activity-item')).toHaveCount(10);

  // 状态/操作栏统一布局（2026-09-30）：已接单行（1004）不渲染删除按钮（无删除 DOM、
  // 非禁用占位），与未接单行共用同一套两列几何
  const acceptedRow = page.locator('.activity-item').filter({ hasText: 'MOCK-RR-2026-1004' });
  await expect(acceptedRow, '已接单行应存在于首页').toHaveCount(1);
  await expect(
    acceptedRow.getByRole('button', { name: /^删除申请 / }),
    '已接单行不得出现删除按钮',
  ).toHaveCount(0);

  for (const [step, dock] of FONT_SCALE_DOCKS.entries()) {
    await clickFontScale(page, dock);

    // 1) 条目操作位：第一条目（1001，未接单）的删除按钮可达且归属同一活动条目
    //（2026-09-29 整合工作台：删除按钮携带条目编号 aria-label，精确限定本条目）
    const firstItem = page.locator('.activity-item').filter({ hasText: 'MOCK-RR-2026-1001' });
    const deleteButton = firstItem.getByRole('button', { name: '删除申请 MOCK-RR-2026-1001' });

    await expect(firstItem, '删除按钮应归属第一项活动条目').toHaveCount(1);
    // 长列表自然高度超出视口：先滚回条目操作位（上一轮末尾停在分页器处；
    // 架构不设列表内滚动容器，页面竖直滚动是唯一可达手段）
    await deleteButton.scrollIntoViewIfNeeded();
    await expectReachable(deleteButton, `列表条目删除按钮（${dock} 档）`, S6_2_VIEWPORT);

    // 2) 弹窗：点删除打开 Popconfirm，Escape 关闭后回到可操作态
    await deleteButton.click();
    await expect(popconfirm, `删除 Popconfirm 应可见（${dock} 档）`).toBeVisible();
    await expect(deleteButton, 'Popconfirm 打开时删除按钮仍在视口内').toBeVisible();

    const popconfirmBox = await expectInViewport(
      popconfirm,
      `删除 Popconfirm（${dock} 档）`,
      S6_2_VIEWPORT,
    );

    await page.keyboard.press('Escape');
    await expect(popconfirm, `Escape 应关闭 Popconfirm（${dock} 档）`).toBeHidden();
    await expect(deleteButton, 'Popconfirm 关闭后删除按钮回到可操作态').toBeEnabled();

    // 3) 分页：两个翻页按钮均在视口内；正向前进证明「下一页」可用，返回证明「上一页」可用
    //（分页器位于长列表底部，按真实用户路径先滚动到分页器再断言几何）
    await pagination.scrollIntoViewIfNeeded();
    await expectInViewport(prevButton, `分页 上一页按钮（${dock} 档）`, S6_2_VIEWPORT);
    await expectReachable(nextButton, `分页 下一页按钮（${dock} 档）`, S6_2_VIEWPORT);
    await expect(activePage).toHaveText('1');

    await nextButton.click();
    await expect(activePage, '点击下一页应真实翻到第 2 页').toHaveText('2');
    await prevButton.scrollIntoViewIfNeeded();
    await expectReachable(prevButton, `分页 上一页按钮（${dock} 档，第 2 页）`, S6_2_VIEWPORT);
    await expect(page.locator('.activity-item'), '第 2 页应只剩 2 条').toHaveCount(2);

    await prevButton.click();
    await expect(activePage, '点击上一页应回到第 1 页').toHaveText('1');

    // 4) 侧栏退出
    const logout = await expectReachable(
      page.locator('.app-sidebar-footer button'),
      `侧栏退出按钮（${dock} 档）`,
      S6_2_VIEWPORT,
    );

    expect(
      logout.y + logout.height,
      `侧栏退出按钮底部（${dock} 档）应 <= 视口高度`,
    ).toBeLessThanOrEqual(S6_2_VIEWPORT.height);

    // 5) 全局 AI 浮动入口（宿主为 AppLayout，见文件头注释）
    await expectReachable(
      page.locator('.entry-trigger-shell button'),
      `AI 浮动入口按钮（${dock} 档）`,
      S6_2_VIEWPORT,
    );

    const rootFontSize = await readRootFontSize(page);
    const fileName = buildEvidenceFileName({
      area: `pr5-s6-2-list-step-${step + 1}-dock-${dock}`,
      capturedAt,
      role: CUSTOMER_LIST_CASE.role,
      scaleLevel: dock,
      viewportLabel: S6_2_VIEWPORT.label,
    });
    const pngPath = path.join(testInfo.outputPath(), fileName);

    const capture = await captureStableViewport(page, { fileName, filePath: pngPath });

    const png = readPngDimensions(pngPath);

    expect(png, `${fileName} 物理尺寸应严格等于视口`).toEqual({
      height: S6_2_VIEWPORT.height,
      width: S6_2_VIEWPORT.width,
    });

    // key 带步序：末次 M 与首次 M 档位相同，只用 label 做 key 会覆盖（同 S6-2 创建页用例）。
    docksEvidence[`${step + 1}-${dock}`] = {
      capture,
      deleteLabel: '删除申请 MOCK-RR-2026-1001',
      fileName,
      logoutBottom: logout.y + logout.height,
      png,
      popconfirmBottom: popconfirmBox.y + popconfirmBox.height,
      rootFontSize,
    };
  }

  expect(await readRootFontSize(page), '往返结束后根字号应回到 M 档').toBe(M_ROOT_FONT_SIZE);

  writeEvidence(testInfo, 'pr5-s6-2-list-evidence.json', {
    acceptedItems: ['S6-2'],
    capturedAt: capturedAt.toISOString(),
    docks: docksEvidence,
    fixture: { list: 'many', pageSize: 10, total: 12 },
    path: CUSTOMER_LIST_PATH,
    viewport: S6_2_VIEWPORT,
  });
});

// ------------------------------------------------------------ S6-3：整页无横滚 + 表格内横滚

test('S6-3 七页在三基准视口均无整页横向滚动（1366×768 / 1440×900 / 1920×1080）', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);

  const capturedAt = new Date();
  const evidence: Record<string, unknown> = {};

  for (const testCase of ALL_PAGE_CASES) {
    await prepareCase(page, testCase);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await page.goto(testCase.path);
      await waitForFontsReady(page);
      await testCase.expectReady(page);

      const overflow = await measurePageOverflow(page);
      expect(
        overflow,
        `${testCase.title}（${testCase.role}）${viewport.label} 不应出现整页横向滚动`,
      ).toBeLessThanOrEqual(0);

      // 有表格的页面：横向滚动能力必须落在表格容器内（AntD scroll.x → overflow-x: auto）；
      // 无表格页面则断言不存在该容器（不写「有就断言」式的空转分支）
      const table = await measureTableOverflow(page);

      if (testCase.tableScope === 'required') {
        if (table === null) {
          throw new Error(`${testCase.title} ${viewport.label} 缺少表格容器 .ant-table-content`);
        }

        expect(
          ['auto', 'scroll'],
          `${testCase.title} ${viewport.label} 表格容器 overflow-x 应为 auto/scroll`,
        ).toContain(table.overflowX);
      } else {
        expect(
          await page.locator('.ant-table-content').count(),
          `${testCase.title} ${viewport.label} 不应出现表格容器`,
        ).toBe(0);
      }

      evidence[`${testCase.area}-${viewport.label}`] = {
        overflow,
        path: testCase.path,
        role: testCase.role,
        table,
      };
    }
  }

  writeEvidence(testInfo, 'pr5-s6-3-page-overflow-evidence.json', {
    acceptedItems: ['S6-3'],
    capturedAt: capturedAt.toISOString(),
    pages: evidence,
    viewports: VIEWPORTS,
  });
});

test('S6-3 长文本：整页不横滚，客户条目换行吸收、资料横滚限表格容器', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);

  const capturedAt = new Date();
  const evidence: Record<string, unknown> = {};

  // 客户列表：长申请编号 / 长错误码由条目换行吸收（2026-09-29 起列表已无表格），
  // 断言编号允许任意位置换行、型号·错误码行允许长词换行，且条目自身无内容横溢
  await page.unroute('**/graphql');
  // 会话预置口径同 prepareCase：旧会话查询经 abort 窗拦下（本 test 新 page 无旧
  // 会话时它落在 /login 零查询，防御重试/复用场景）。
  await seedAuthSessionWithAbort(page, CUSTOMER_LIST_CASE.role);
  await installCustomerRepairRequestMocks(page, { list: 'long-text' });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto(CUSTOMER_LIST_PATH);
    await waitForFontsReady(page);
    await expect(page.locator('.activity-item')).toHaveCount(1);
    await expect(page.getByText(LONG_REQUEST_NO).first()).toBeVisible();

    const pageOverflow = await measurePageOverflow(page);

    expect(
      pageOverflow,
      `客户列表长文本 ${viewport.label} 不应出现整页横向滚动`,
    ).toBeLessThanOrEqual(0);

    // 条目换行约束：编号 word-break: break-all、型号·错误码行 overflow-wrap: break-word；
    // 条目 scrollWidth <= clientWidth + 1（亚像素容差）证明超宽长串被换行吸收而非撑破条目
    const wrapping = await page
      .locator('.customer-workspace-list-pane .activity-item')
      .first()
      .evaluate((item) => {
        const code = item.querySelector<HTMLElement>('.activity-item-code');
        const wrapSpan = item.querySelector<HTMLElement>('span.break-words');

        if (!code || !wrapSpan) {
          throw new Error('长文本条目缺少编号或错误码节点');
        }

        return {
          codeText: code.textContent ?? '',
          codeWordBreak: getComputedStyle(code).wordBreak,
          errorText: wrapSpan.textContent ?? '',
          errorWrap: getComputedStyle(wrapSpan).overflowWrap,
          itemClientWidth: item.clientWidth,
          itemScrollWidth: item.scrollWidth,
        };
      });

    expect(wrapping.codeWordBreak, `客户列表长文本 ${viewport.label} 编号应允许任意位置换行`).toBe(
      'break-all',
    );
    expect(wrapping.errorWrap, `客户列表长文本 ${viewport.label} 错误码行应允许长词换行`).toBe(
      'break-word',
    );
    expect(wrapping.codeText).toContain(LONG_REQUEST_NO);
    expect(wrapping.errorText, '长错误码应完整落在型号·错误码行内').toContain(LONG_ERROR_CODE);
    expect(
      wrapping.itemScrollWidth,
      `客户列表长文本 ${viewport.label} 条目不应出现内容横溢`,
    ).toBeLessThanOrEqual(wrapping.itemClientWidth + 1);

    const fileName = buildEvidenceFileName({
      area: 'pr5-s6-3-customer-list-long-text',
      capturedAt,
      role: CUSTOMER_LIST_CASE.role,
      viewportLabel: viewport.label,
    });
    const pngPath = path.join(testInfo.outputPath(), fileName);

    const capture = await captureStableViewport(page, { fileName, filePath: pngPath });

    const png = readPngDimensions(pngPath);

    expect(png, `${fileName} 物理尺寸应严格等于视口`).toEqual({
      height: viewport.height,
      width: viewport.width,
    });

    evidence[`customer-list-long-text-${viewport.label}`] = {
      capture,
      fileName,
      pageOverflow,
      path: CUSTOMER_LIST_PATH,
      png,
      wrapping,
    };
  }

  // 资料列表：长标题 / 长说明 / 长文件名三列走单行截断（ellipsis），
  // 内容被列内截断而非撑破页面；表格仍保留可横滚容器（overflow-x: auto），
  // 但基准三视口的表格容器宽（1102 / 1176 / 1278）均 >= AntD scroll.x 最小宽 1100，
  // 故此刻不需要内部横滚 —— 实测 scrollWidth == clientWidth（见证据 JSON）。
  // 跨 mock 切换按 prepareCase 同口径严格按序：离舱 → 卸 stub → 预置会话
  //（旧角色客户首页查询经 abort 窗拦下）→ 再离舱 → 装资料 stub。
  await page.goto('about:blank');
  await page.unroute('**/graphql');
  await seedAuthSessionWithAbort(page, REFERENCE_LIST_CASE.role);
  await page.goto('about:blank');
  await installReferenceLibraryMocks(page, LONG_TEXT_ITEMS);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto(REFERENCE_LIST_PATH);
    await waitForFontsReady(page);
    await expect(page.getByText(LONG_TEXT_ITEMS[0].title)).toBeVisible();

    const pageOverflow = await measurePageOverflow(page);
    const table = await measureTableOverflow(page);
    const tableDom = page.locator('.ant-table-content');

    if (table === null) {
      throw new Error(`资料列表长文本 ${viewport.label} 缺少表格容器 .ant-table-content`);
    }

    expect(
      pageOverflow,
      `资料列表长文本 ${viewport.label} 不应出现整页横向滚动`,
    ).toBeLessThanOrEqual(0);
    expect(table.overflowX, `资料列表长文本 ${viewport.label} 表格容器 overflow-x`).toBe('auto');

    // 长文本确实被表内单元格截断（内容宽 > 可见宽），证明超宽内容被限制在表格内
    const truncation = await tableDom.evaluate((container) => {
      const row = container.querySelector('.ant-table-tbody tr.ant-table-row');

      if (!row) {
        throw new Error('缺少数据行');
      }

      return [...row.querySelectorAll('td.ant-table-cell-ellipsis')].map((cell) => ({
        clientWidth: cell.clientWidth,
        scrollWidth: cell.scrollWidth,
      }));
    });

    expect(truncation, `资料列表长文本 ${viewport.label} 应有三个截断列`).toHaveLength(3);

    for (const [index, cell] of truncation.entries()) {
      expect(
        cell.scrollWidth,
        `资料列表长文本 ${viewport.label} 第 ${index + 1} 个长文本列应真的被截断`,
      ).toBeGreaterThan(cell.clientWidth);
    }

    const fileName = buildEvidenceFileName({
      area: 'pr5-s6-3-reference-list-long-text',
      capturedAt,
      role: REFERENCE_LIST_CASE.role,
      viewportLabel: viewport.label,
    });
    const pngPath = path.join(testInfo.outputPath(), fileName);

    const capture = await captureStableViewport(page, { fileName, filePath: pngPath });

    const png = readPngDimensions(pngPath);

    expect(png, `${fileName} 物理尺寸应严格等于视口`).toEqual({
      height: viewport.height,
      width: viewport.width,
    });

    evidence[`reference-list-long-text-${viewport.label}`] = {
      capture,
      fileName,
      pageOverflow,
      path: REFERENCE_LIST_PATH,
      png,
      table,
      truncation,
    };
  }

  writeEvidence(testInfo, 'pr5-s6-3-table-overflow-evidence.json', {
    acceptedItems: ['S6-3'],
    capturedAt: capturedAt.toISOString(),
    tables: evidence,
    viewports: VIEWPORTS,
  });
});

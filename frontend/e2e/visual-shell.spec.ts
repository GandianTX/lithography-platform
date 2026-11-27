// e2e/visual-shell.spec.ts
// PR1 视觉底座浏览器级验收（外审 R2 P1-01）：真实浏览器 + 真实路由树（protectedRouteLoader
// 参与执行），会话经 seedAuthSession 种入；GraphQL 一律 stub——壳层验收不依赖后端业务数据。

import { expect, test } from '@playwright/test';

import { seedAuthSession } from './helpers/auth-session-seed';
import { handleSessionBootstrapOperation } from './helpers/my-session-identity-mocks';

// GraphQL stub：壳层验收只关心导航/布局，但仍返回已访问页面所需的最小合法 DTO。
// 不能把 `{ data: {} }` 当成空态：adapter 会把它读成 undefined，页面进入 ready 后取
// `data.items` 直接抛 TypeError，而 React Router 的 error boundary 接住异常后壳层仍在，
// 用例会「业务页崩了却依然全绿」（PR5 S0–S4 全量复审 P2-1）。
const SHELL_GRAPHQL_STUBS: Record<string, unknown> = {
  AdminUsers: { adminUsers: { items: [], page: 1, pageSize: 20, total: 0 } },
  // 工程师首页工作台（/engineer）会真实读列表：登记最小合法 DTO，否则退化成失败关闭。
  EngineerRepairRequests: {
    engineerRepairRequests: { items: [], page: 1, pageSize: 10, total: 0 },
  },
  // 客户整合工作台（2026-09-29 复用同一工作台）：/customer 创建态会真实读型号，
  // 登记最小合法 DTO（空数组）；历史列表走空页时右栏占位不发其余业务查询。
  EquipmentModels: { equipmentModels: [] },
  MyRepairRequests: { myRepairRequests: { items: [], page: 1, pageSize: 10, total: 0 } },
  // 创建态另读可选维修厂家与当前账号可信公司（PR #27 复审后新增）：
  // 种子会话没有客户公司归属，可信公司如实为 null；厂家候选空数组即「暂无候选」，
  // 不使用演示公司冒充真实归属。
  RepairServiceOrganizationSearch: {
    repairServiceOrganizationSearch: { items: [], page: 1, pageSize: 20, total: 0 },
  },
  TrustedCompanyName: { myAccountSettings: { trustedCompanyName: null } },
};

// 未登记 operation 与页面运行时异常都必须是失败依据，而不是被静默吸收：
// 前者会退化成上面那种「空 data 契约异常」，后者会被 error boundary 吞掉。
// 注意：被 error boundary 接住的 render 异常不会派发 window error 事件，React 只把
// 原始异常打到 console.error（实测本用例即为此形态），因此必须同时收 console.error，
// 否则「业务页崩了」在浏览器事件层面完全不可见。
const unregisteredOperations: string[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  unregisteredOperations.length = 0;
  pageErrors.length = 0;
  consoleErrors.length = 0;

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.route('**/graphql', async (route) => {
    const requestBody = route.request().postDataJSON() as { operationName?: string } | null;
    const operationName = requestBody?.operationName ?? '';

    // 壳层挂载后的会话身份复核与工程师准入检查：回显预置会话事实（唯一真源），
    // 管理员等级 / 可信公司 / 客户公司都从种子读取，mock 不做任何抬升或兜底。
    if (await handleSessionBootstrapOperation(page, route, operationName)) {
      return;
    }

    const stub = SHELL_GRAPHQL_STUBS[operationName];

    // 失败关闭：未登记的 operation 不返回空 data，而是显式报错，避免掩盖真实契约缺口
    if (stub === undefined) {
      unregisteredOperations.push(operationName);

      await route.fulfill({
        body: JSON.stringify({
          errors: [{ message: `visual-shell 未登记 operation：${operationName}` }],
        }),
        contentType: 'application/json',
        status: 200,
      });

      return;
    }

    await route.fulfill({
      body: JSON.stringify({ data: stub }),
      contentType: 'application/json',
      status: 200,
    });
  });
});

test.afterEach(() => {
  expect(pageErrors, '页面出现未预期的运行时异常').toEqual([]);
  expect(consoleErrors, '页面出现未预期的 console.error').toEqual([]);
  expect(unregisteredOperations, '存在未登记的 GraphQL operation').toEqual([]);
});

test('seeded roles see only their own stable menu items in the sidebar', async ({ page }) => {
  // 本用例含多次真实页面导航，在 dev server 串行门禁中需要独立预算。
  test.setTimeout(40_000);
  const expectations: Array<{
    path: string;
    role: 'CUSTOMER' | 'ENGINEER' | 'SUPER_ADMIN';
    /** 管理员侧事实：路由守卫与侧栏收口都按等级 + 可信公司判定（2026-11-27 起显式声明） */
    adminFacts?: { adminLevel?: number | null; adminOrganizationId?: number | null };
    visible: string[];
    hidden: string[];
  }> = [
    {
      hidden: ['维修申请', '历史维修记录库', '用户管理'],
      path: '/customer',
      role: 'CUSTOMER',
      visible: ['首页', '发起申请', '我的申请'],
    },
    {
      hidden: ['发起申请', '我的申请', '用户管理'],
      path: '/engineer',
      role: 'ENGINEER',
      visible: ['首页', '维修申请', '历史维修记录库'],
    },
    // 一级管理员（GLOBAL）：历史维修记录库与 AI 会话记录改由文档数据库标签承载，
    // 侧栏不再重复展示两个独立入口。
    {
      adminFacts: { adminLevel: 1, adminOrganizationId: 910003 },
      hidden: ['发起申请', '我的申请', '维修申请', '历史维修记录库', 'AI 会话记录'],
      path: '/admin/users',
      role: 'SUPER_ADMIN',
      visible: ['首页', '文档数据库', '用户管理'],
    },
    // 二级管理员（ORGANIZATION）：保留两个独立只读入口，文档数据库仍不可见。
    {
      adminFacts: { adminLevel: 2, adminOrganizationId: 910004 },
      hidden: ['发起申请', '我的申请', '文档数据库'],
      path: '/admin/users',
      role: 'SUPER_ADMIN',
      visible: ['首页', '历史维修记录库', 'AI 会话记录', '用户管理'],
    },
  ];

  for (const expectation of expectations) {
    await seedAuthSession(page, expectation.role, expectation.adminFacts);
    await page.goto(expectation.path);

    const nav = page.getByRole('navigation', { name: '主导航' });

    for (const label of expectation.visible) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    for (const label of expectation.hidden) {
      await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
    }
  }
});

// PR5 S1-3：刷新后菜单选中正确需覆盖每个角色的真实路由（jsdom 单测不执行 loader，
// 与「刷新」不等价，故必须有浏览器级用例）。三例分别覆盖：子路由前缀选中、客户主页
// 无同名菜单项时回落选中「首页」、以及无同名业务项的排除关系。
const REFRESH_CASES: ReadonlyArray<{
  activeLabel: string;
  inactiveLabel: string;
  path: string;
  readyHeading: string;
  readyText?: string;
  role: 'CUSTOMER' | 'SUPER_ADMIN';
  /** 管理员路由准入按等级 + 可信公司判定：/admin/users 必须有 1 级与可信公司 */
  adminFacts?: { adminLevel?: number | null; adminOrganizationId?: number | null };
}> = [
  {
    activeLabel: '用户管理',
    inactiveLabel: '首页',
    adminFacts: { adminLevel: 1, adminOrganizationId: 910003 },
    path: '/admin/users',
    readyHeading: '用户管理',
    role: 'SUPER_ADMIN',
  },
  {
    activeLabel: '我的申请',
    inactiveLabel: '首页',
    path: '/customer/repair-requests',
    // 业务页就绪正控：Heading 存在只说明壳层渲染了路由，还必须有该页真实 ready 态产物
    //（2026-09-29 整合工作台：左栏列表空态与右栏详情占位同为空态文案）
    readyHeading: '我的维修申请',
    readyText: '还没有维修申请。',
    role: 'CUSTOMER',
  },
  {
    activeLabel: '首页',
    inactiveLabel: '我的申请',
    path: '/customer',
    readyHeading: '客户页面',
    role: 'CUSTOMER',
  },
];

for (const refreshCase of REFRESH_CASES) {
  test(`refreshing ${refreshCase.path} selects "${refreshCase.activeLabel}" for ${refreshCase.role}`, async ({
    page,
  }) => {
    await seedAuthSession(page, refreshCase.role, refreshCase.adminFacts);
    // 直接打开目标路由等价于刷新：完整路由树 + protectedRouteLoader 参与执行
    await page.goto(refreshCase.path);

    // 就绪正控：先证明目标业务页真的渲染完成，再看菜单选中；
    // 否则业务页抛异常被 error boundary 接住时，壳层与菜单断言依然成立（假绿）。
    await expect(page.getByRole('heading', { name: refreshCase.readyHeading })).toBeVisible();
    if (refreshCase.readyText !== undefined) {
      // 整合工作台左右栏同为空态时同文案出现两处，取首个即可证明 ready 产物已渲染
      await expect(page.getByText(refreshCase.readyText).first()).toBeVisible();
    }

    const nav = page.getByRole('navigation', { name: '主导航' });
    const active = nav.getByRole('link', { name: refreshCase.activeLabel });

    await expect(active).toBeVisible();
    await expect(active).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: refreshCase.inactiveLabel })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });
}

test('anonymous direct access to a protected URL is redirected to login with returnTo', async ({
  page,
}) => {
  await page.goto('/admin/users');

  await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin%2Fusers$/);
  // 匿名态侧栏仍渲染（登录页位于壳层内），但受保护入口不出现
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '用户管理' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('账号或邮箱')).toBeVisible();
});

test('collapse toggle switches the sidebar between expanded and collapsed', async ({ page }) => {
  await seedAuthSession(page, 'CUSTOMER');
  await page.goto('/customer');

  const collapseButton = page.getByRole('button', { name: '折叠导航' });

  await expect(page.getByText('光刻维护平台')).toBeVisible();
  await collapseButton.click();
  await expect(page.getByRole('button', { name: '展开导航' })).toBeVisible();
  await expect(page.getByText('光刻维护平台')).toBeHidden();
  await page.getByRole('button', { name: '展开导航' }).click();
  await expect(page.getByRole('button', { name: '折叠导航' })).toBeVisible();
  await expect(page.getByText('光刻维护平台')).toBeVisible();
});

test.describe('task-book viewports show no horizontal overflow and keep the user card reachable', () => {
  for (const viewport of [
    { height: 768, name: '1366x768', width: 1366 },
    { height: 900, name: '1440x900', width: 1440 },
  ] as const) {
    test(`viewport ${viewport.name}: no horizontal scroll, sidebar and logout visible`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await seedAuthSession(page, 'CUSTOMER');
      await page.goto('/customer');

      // 无横向滚动：根元素滚动宽度不超过视口
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // 侧栏与底部退出入口都落在视口内（用户卡不被长内容推离）
      const sidebar = page.locator('aside.app-sidebar');
      await expect(sidebar).toBeVisible();
      const sidebarBox = await sidebar.boundingBox();
      expect(sidebarBox).not.toBeNull();
      expect(sidebarBox?.y).toBe(0);
      expect(sidebarBox?.height).toBeLessThanOrEqual(viewport.height);

      // 页面内可能有同名按钮（如客户页自带的会话面板），只认侧栏里的这个
      const logoutButton = page
        .getByRole('complementary')
        .getByRole('button', { name: /退出登录/ });
      await expect(logoutButton).toBeVisible();
      const logoutBox = await logoutButton.boundingBox();
      expect(logoutBox).not.toBeNull();
      expect((logoutBox?.y ?? 0) + (logoutBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
    });
  }

  test('viewport 375x667: sidebar auto-collapses (S4 narrow viewport policy)', async ({ page }) => {
    await page.setViewportSize({ height: 667, width: 375 });
    await seedAuthSession(page, 'CUSTOMER');
    await page.goto('/customer');

    await expect(page.getByRole('button', { name: '展开导航' })).toBeVisible();
  });
});

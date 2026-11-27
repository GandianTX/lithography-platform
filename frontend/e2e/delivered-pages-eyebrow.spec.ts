// e2e/delivered-pages-eyebrow.spec.ts
//
// 已交付业务页「蓝色英文眉题」参数化覆盖（第三轮修复：负责人指出证据只有少数
// 页面截图，未逐页核对）。本 spec 用仓库内确定性 GraphQL mock + 预置会话逐页
// 断言：① `.page-eyebrow` 文案与页面语义对应；② 颜色为基准蓝 #2563eb（computed
// style，防「有眉题但不是蓝色」的退化）。眉题覆盖清单见 PR 描述与
// frontend/docs/gkj-visual-baseline.md 第 2 节。
//
// 排除（非交付业务页）：登录页（未登录壳外页面，原型即无页头眉题）、
// shared-ui-gallery 开发验收页、error-preview / labs / sandbox 等开发工具页。
// 数据态说明：列表与详情查询均在 mock 登记表内（详情页返回 id 同源的最小
// fixture：资料 501 / 申请 901；账号设置返回最小就绪态，避免空 data 触发
// mapper 失败关闭的「未分类错误」控制台报错），页面渲染就绪态；工程师详情等
// 个别页面在空 data 下也能渲染页头，不受影响。

import { expect, test } from '@playwright/test';

import { installAdminDocumentKbGraphqlMocks } from './helpers/admin-document-kb-mocks';
import { seedAuthSession, type SeededAuthSessionRole } from './helpers/auth-session-seed';

const EYEBROW_BLUE = 'rgb(37, 99, 235)'; // --eyebrow-text #2563eb

type EyebrowCase = {
  eyebrow: string;
  path: string;
  role: SeededAuthSessionRole;
  /** 预置会话事实：管理员路由准入按等级 + 可信公司判定，缺省不放行 */
  facts?: {
    adminLevel?: number | null;
    adminOrganizationId?: number | null;
  };
  /** false = 该页面已下线，用例只登记不执行（不计入通过） */
  enabled?: boolean;
};

const ADMIN_FACTS = { adminLevel: 1, adminOrganizationId: 910003 } as const;

const CASES: readonly EyebrowCase[] = [
  { eyebrow: 'Account Settings', path: '/account/settings', role: 'SUPER_ADMIN' },
  { eyebrow: 'User Management', facts: ADMIN_FACTS, path: '/admin/users', role: 'SUPER_ADMIN' },
  {
    eyebrow: 'Knowledge Management',
    facts: ADMIN_FACTS,
    path: '/admin/document-database',
    role: 'SUPER_ADMIN',
  },
  {
    // 2026-11-27 更名轮：reference documents → maintenance record library
    eyebrow: 'Maintenance Record Library',
    facts: ADMIN_FACTS,
    path: '/reference-documents',
    role: 'SUPER_ADMIN',
  },
  {
    // /reference-documents/new 路由已在任务 07 收口时下线（改为受控上传/修订通道），
    // 无页头可断言；保留登记但跳过，不计入通过。
    enabled: false,
    eyebrow: 'New Reference Document',
    facts: ADMIN_FACTS,
    path: '/reference-documents/new',
    role: 'SUPER_ADMIN',
  },
  {
    eyebrow: 'Maintenance Record Detail',
    facts: ADMIN_FACTS,
    path: '/reference-documents/501',
    role: 'SUPER_ADMIN',
  },
  { eyebrow: 'Repair Requests', path: '/engineer/repair-requests', role: 'ENGINEER' },
  { eyebrow: 'Repair Request Detail', path: '/engineer/repair-requests/901', role: 'ENGINEER' },
  // 客户四页（PR5 整合工作台）：首页 / 创建 / 列表 / 详情四个 URL 复用同一
  // CustomerRepairWorkspace 与同一固定页头（eyebrow 恒为 Customer Workspace、
  // 标题恒为「客户页面」）；ENGINEER / SUPER_ADMIN 的角色主页仍为开发期占位
  //（PR6 归属），故本清单暂不收录。
  { eyebrow: 'Customer Workspace', path: '/customer', role: 'CUSTOMER' },
  { eyebrow: 'Customer Workspace', path: '/customer/repair-requests', role: 'CUSTOMER' },
  { eyebrow: 'Customer Workspace', path: '/customer/repair-requests/new', role: 'CUSTOMER' },
  { eyebrow: 'Customer Workspace', path: '/customer/repair-requests/901', role: 'CUSTOMER' },
];

for (const item of CASES) {
  test(`眉题覆盖：${item.path} → ${item.eyebrow}`, async ({ page }) => {
    test.skip(item.enabled === false, `${item.path} 页面已下线，无页头眉题可断言`);

    await installAdminDocumentKbGraphqlMocks(page);
    // 眉题断言的基准是英文，固定界面语言，避免依赖运行环境的 navigator.language
    await page.addInitScript(() => window.localStorage.setItem('ui-language', 'en'));
    await seedAuthSession(page, item.role, item.facts);
    await page.goto(item.path);

    const eyebrow = page.locator('.page-eyebrow');
    await expect(eyebrow, '页面应渲染语义对应的英文眉题').toHaveText(item.eyebrow);
    const color = await eyebrow.evaluate((el) => getComputedStyle(el).color);
    expect(color, '眉题应为基准蓝 #2563eb').toBe(EYEBROW_BLUE);
  });
}

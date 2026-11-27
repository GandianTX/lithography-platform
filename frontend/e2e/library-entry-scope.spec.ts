// e2e/library-entry-scope.spec.ts
//
// 2026-11-27「历史维修记录库」更名轮的浏览器级验收（mock-only）：
// 侧栏重复入口收口只在**替换入口真实可用**时发生，路由守卫与后端数据权限都不因改名变化。
//
// 覆盖矩阵（全部使用仓库内确定性 GraphQL mock，不连真实后端 / 开发库 / 环境文件）：
// 1. 一级管理员 GLOBAL（level 1 + 可信公司）：
//    侧栏隐藏「历史维修记录库」「AI 会话记录」两个重复入口，改由文档数据库标签承载；
//    两个标签都真实可打开并渲染数据，旧路由直达仍放行。
// 2. 二级管理员 ORGANIZATION（level 2 + 本公司）：
//    保留两个独立入口；文档数据库仍不可见，直达被守卫退回管理员首页。
// 3. 工程师：保留「历史维修记录库」入口；/admin/** 直达仍被角色路径表拒绝。
// 4. 一级但缺可信公司（PLATFORM）：
//    前端入口保留（隐藏条件只在 GLOBAL 生效），**文档数据库路由被拒绝**，
//    且不发任何文档数据库业务查询 —— 「看得到入口」不等于「能拿到数据」。
// 5. 中英文切换：列表页与详情页的标题、描述随语言正确切换（含导航同名文案）。
// 6. 客户直达 /reference-documents 仍按角色路径表退回个人主页。
//
// 身份响应不回显任何伪造事实：helpers/my-session-identity-mocks 从 sessionStorage
// 的预置会话逐字段回显，缺公司 / 缺等级的会话原样穿过 mock。

import { expect, type Page, test } from '@playwright/test';

import { installAdminDocumentKbGraphqlMocks } from './helpers/admin-document-kb-mocks';
import { seedAuthSession } from './helpers/auth-session-seed';
import { installCustomerRepairRequestMocks } from './helpers/customer-repair-request-mocks';
import {
  CUSTOMER_IDENTITY_FACTS,
  ENGINEER_IDENTITY_FACTS,
  GLOBAL_ADMIN_IDENTITY_FACTS,
  ORGANIZATION_ADMIN_IDENTITY_FACTS,
  PLATFORM_ADMIN_IDENTITY_FACTS,
} from './helpers/my-session-identity-mocks';
import { installReferenceLibraryMocks } from './helpers/reference-document-mocks';

const LIBRARY_LABEL = '历史维修记录库';
const AI_CONVERSATIONS_LABEL = 'AI 会话记录';
const DOCUMENT_DATABASE_LABEL = '文档数据库';

const LIBRARY_PAGE_PATH = '/reference-documents';
const DOCUMENT_DATABASE_PATH = '/admin/document-database';
const ADMIN_AI_CONVERSATIONS_PATH = '/admin/ai-conversations';

/** 主导航（aria-label 随语言切换，故按中英两种可访问名称匹配）。 */
const mainNav = (page: Page) =>
  page.getByRole('navigation', { name: /^(主导航|Main navigation)$/ });

/** 文档数据库业务查询（缺可信公司时一条都不应发出）。 */
function recordDocumentDatabaseOperations(page: Page): string[] {
  const operations: string[] = [];

  page.on('request', (request) => {
    if (!request.url().includes('/graphql')) {
      return;
    }

    const payload = request.postDataJSON() as { operationName?: string } | null;
    const operationName = payload?.operationName;

    if (typeof operationName === 'string' && operationName.startsWith('AdminDocumentDatabase')) {
      operations.push(operationName);
    }
  });

  return operations;
}

test('一级管理员（GLOBAL）：侧栏隐藏两个重复入口，文档数据库标签仍可打开历史维修记录库与 AI 会话', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await installAdminDocumentKbGraphqlMocks(page);
  await seedAuthSession(page, 'SUPER_ADMIN', GLOBAL_ADMIN_IDENTITY_FACTS);

  await page.goto('/admin/users');

  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: LIBRARY_LABEL })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: AI_CONVERSATIONS_LABEL })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: DOCUMENT_DATABASE_LABEL })).toBeVisible();

  // 替换入口真实可用：标签内渲染到 mock 夹具，而不是空壳
  await nav.getByRole('link', { name: DOCUMENT_DATABASE_LABEL }).click();
  await expect(page).toHaveURL(/\/admin\/document-database$/);
  await expect(page.getByRole('heading', { name: DOCUMENT_DATABASE_LABEL })).toBeVisible();
  await expect(page.getByRole('tab', { name: LIBRARY_LABEL })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('E-201 故障处理手册').first()).toBeVisible();

  await page.getByRole('tab', { name: AI_CONVERSATIONS_LABEL }).click();
  await expect(page.getByText('RR20260901090001A1B2C3').first()).toBeVisible();

  // 旧路由直达仍是既有守卫口径：GLOBAL 一级管理员两条旧路由都放行
  await page.goto(LIBRARY_PAGE_PATH);
  await expect(page.getByRole('heading', { name: LIBRARY_LABEL })).toBeVisible();

  await page.goto(ADMIN_AI_CONVERSATIONS_PATH);
  await expect(page.getByRole('heading', { name: AI_CONVERSATIONS_LABEL })).toBeVisible();
});

test('二级管理员（ORGANIZATION）：保留两个独立入口，文档数据库不可进', async ({ page }) => {
  test.setTimeout(60_000);
  await installAdminDocumentKbGraphqlMocks(page);
  await seedAuthSession(page, 'SUPER_ADMIN', ORGANIZATION_ADMIN_IDENTITY_FACTS);

  await page.goto('/admin/users');

  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: LIBRARY_LABEL })).toBeVisible();
  await expect(nav.getByRole('link', { name: AI_CONVERSATIONS_LABEL })).toBeVisible();
  await expect(nav.getByRole('link', { name: DOCUMENT_DATABASE_LABEL })).toHaveCount(0);

  // 直达仍按既有守卫退回管理员首页（/admin）
  const documentDatabaseOperations = recordDocumentDatabaseOperations(page);
  await page.goto(DOCUMENT_DATABASE_PATH);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: '管理员工作台' })).toBeVisible();
  expect(documentDatabaseOperations, '二级管理员不得触发文档数据库业务查询').toEqual([]);
});

test('工程师：保留历史维修记录库入口，管理员路由直达仍被拒绝', async ({ page }) => {
  test.setTimeout(60_000);
  // /engineer 首页会额外读工单列表；从资料库页进入，跳转回 /engineer 时用同一失败关闭分发器应答。
  await installReferenceLibraryMocks(page, undefined, {
    EngineerRepairRequests: () => ({
      engineerRepairRequests: { items: [], page: 1, pageSize: 10, total: 0 },
    }),
  });
  await seedAuthSession(page, 'ENGINEER', ENGINEER_IDENTITY_FACTS);

  await page.goto(LIBRARY_PAGE_PATH);
  await expect(mainNav(page).getByRole('link', { name: LIBRARY_LABEL })).toBeVisible();
  await expect(page.getByRole('heading', { name: LIBRARY_LABEL })).toBeVisible();
  await expect(page.getByText('光源模块维护指南').first()).toBeVisible();

  await page.goto(DOCUMENT_DATABASE_PATH);
  await expect(page).toHaveURL(/\/engineer$/);
});

test('一级但缺可信公司（PLATFORM）：前端入口保留，文档数据库路由与数据访问都不放行', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await installAdminDocumentKbGraphqlMocks(page);
  await seedAuthSession(page, 'SUPER_ADMIN', PLATFORM_ADMIN_IDENTITY_FACTS);

  await page.goto('/admin/users');

  const nav = mainNav(page);
  // 1) 前端入口保留：隐藏条件只在 GLOBAL 生效，避免「隐藏了重复入口却没有替代入口」
  await expect(nav.getByRole('link', { name: LIBRARY_LABEL })).toBeVisible();
  await expect(nav.getByRole('link', { name: AI_CONVERSATIONS_LABEL })).toBeVisible();
  // 文档数据库本身仍要求可信公司，故入口不可见
  await expect(nav.getByRole('link', { name: DOCUMENT_DATABASE_LABEL })).toHaveCount(0);

  // 2) 路由是否放行：直达文档数据库被守卫退回管理员首页
  const documentDatabaseOperations = recordDocumentDatabaseOperations(page);
  await page.goto(DOCUMENT_DATABASE_PATH);
  await expect(page).toHaveURL(/\/admin$/);

  // 旧路由仍按原口径放行（工程师/管理员角色 + 管理范围判定）
  await page.goto(LIBRARY_PAGE_PATH);
  await expect(page.getByRole('heading', { name: LIBRARY_LABEL })).toBeVisible();
  await page.goto(ADMIN_AI_CONVERSATIONS_PATH);
  await expect(page.getByRole('heading', { name: AI_CONVERSATIONS_LABEL })).toBeVisible();

  // 3) 后端是否有权返回数据：本次 mock-only 验收只能证明「前端没有发出文档数据库业务查询」，
  //    服务端侧由后端离线用例钉住（一级 + 可信组织成员才放行，见
  //    backend/src/usecases/admin-document-database/admin-document-database-permission.spec.ts）；
  //    真实库联调不在本轮范围。
  expect(documentDatabaseOperations, '缺可信公司时不得触发文档数据库业务查询').toEqual([]);
});

test('中英文切换：历史维修记录库列表页与详情页的标题、描述正确', async ({ page }) => {
  test.setTimeout(90_000);
  await installReferenceLibraryMocks(page);
  await seedAuthSession(page, 'ENGINEER', ENGINEER_IDENTITY_FACTS);

  const pageTitle = page.locator('.page-title');
  const pageDescription = page.locator('.page-description');

  await page.goto(LIBRARY_PAGE_PATH);
  await expect(pageTitle).toHaveText(LIBRARY_LABEL);
  await expect(pageDescription).toHaveText(
    '查看已正式提交的工单维修总结、历史维修记录及平台已有的相关资料。',
  );

  // 切到英文：侧栏导航与页头同源文案一起更新
  await page.locator('.language-switch button[lang="en"]').click();
  await expect(
    mainNav(page).getByRole('link', { name: 'Maintenance record library' }),
  ).toBeVisible();
  await expect(pageTitle).toHaveText('Maintenance record library');
  await expect(pageDescription).toHaveText(
    'View formally submitted work order summaries, maintenance history, and related materials already on the platform.',
  );

  // 详情页（英文）
  await page.goto(`${LIBRARY_PAGE_PATH}/980001`);
  await expect(pageTitle).toHaveText('Maintenance record detail');
  await expect(pageDescription).toHaveText(
    'Read the full content, source version, and version history of this maintenance record.',
  );
  // 详情面板同时有「资料标题」与「版本历史」两张卡，按首个标题卡断言资料标题
  await expect(page.locator('.ant-card-head-title').first()).toHaveText('光源模块维护指南');

  // 切回中文：详情页标题、描述与导航同步回落
  await page.locator('.language-switch button[lang="zh-CN"]').click();
  await expect(pageTitle).toHaveText('历史维修记录详情');
  await expect(pageDescription).toHaveText('查阅维护知识资料的完整内容、来源版本与历史版本。');
  await expect(mainNav(page).getByRole('link', { name: LIBRARY_LABEL })).toBeVisible();
});

test('客户直达历史维修记录库仍被角色路径表退回个人主页', async ({ page }) => {
  test.setTimeout(60_000);
  await installCustomerRepairRequestMocks(page);
  await seedAuthSession(page, 'CUSTOMER', CUSTOMER_IDENTITY_FACTS);

  await page.goto(LIBRARY_PAGE_PATH);
  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByRole('heading', { name: '客户页面' })).toBeVisible();
});

// 明确记录本轮未覆盖的事实（可作为后续任务的输入，不作为通过项）：
// - 真实数据库下的文档数据库数据范围：一级跨公司、二级本公司由后端在请求期裁决，
//   mock-only 无法证明；本轮只证明前端未发出越权查询。
// - 后端「一级缺可信公司」的拒绝行为由离线用例覆盖（见上面引用的 permission.spec），
//   未做真实库/浏览器联调。

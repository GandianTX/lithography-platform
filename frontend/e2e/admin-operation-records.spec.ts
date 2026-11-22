// e2e/admin-operation-records.spec.ts
// @vitest-environment node

/**
 * 关键操作记录页验收（任务 10 · A10-05）。
 *
 * 覆盖：
 * - 一级管理员：七列表头、三类操作文案、只读（表格区无写入口）、分页与翻页；
 * - 零记录：AntD 空态文案；
 * - 二级管理员：等级副标题分档；
 * - 越权角色：直达本路由被守卫拦下，不展示任何既有内容；
 * - 窄屏（390×844）：整页无横向溢出，横向滚动只发生在表格容器内。
 *
 * 全部走仓库内确定性 mock（helpers/admin-operation-records-mocks.ts），
 * 不连真实后端、不写共享开发库。
 */

import { expect, test } from '@playwright/test';

import { installAdminOperationRecordsMocks } from './helpers/admin-operation-records-mocks';
import { seedAuthSession } from './helpers/auth-session-seed';

const PAGE_PATH = '/admin/operation-records';

test.describe('关键操作记录页（任务 10）', () => {
  test('一级管理员看到七列只读表格、总数与两页分页', async ({ page }) => {
    await seedAuthSession(page, 'SUPER_ADMIN', { adminLevel: 1, adminOrganizationId: 1001 });
    await installAdminOperationRecordsMocks(page);
    await page.goto(PAGE_PATH);

    await expect(page.getByRole('heading', { name: '关键操作记录' })).toBeVisible();
    await expect(page.getByText('查看全部公司的关键操作。')).toBeVisible();
    await expect(page.getByText('操作记录', { exact: true })).toBeVisible();

    // 七列表头齐全
    for (const header of [
      '时间',
      '操作者',
      '所属公司',
      '操作类型',
      '目标',
      '实际结果',
      '必要说明',
    ]) {
      await expect(page.getByRole('columnheader', { name: header })).toBeVisible();
    }

    // 三类操作文案与结果文案按协议枚举渲染
    await expect(page.getByText('管理员删除正式资料').first()).toBeVisible();
    await expect(page.getByText('更改资料上传者和公司归属').first()).toBeVisible();
    await expect(page.getByText('使用备份包恢复本机业务').first()).toBeVisible();
    await expect(page.getByText('成功').first()).toBeVisible();
    await expect(page.getByText('失败').first()).toBeVisible();
    await expect(page.getByText('已拒绝').first()).toBeVisible();

    // 只读：表格区没有按钮、没有链接（没有编辑/删除/导出/规则入口）
    const tableArea = page.locator('.ant-table');
    await expect(tableArea.getByRole('button')).toHaveCount(0);
    await expect(tableArea.getByRole('link')).toHaveCount(0);

    // 总数与分页：一页 10 条、第二页 5 条
    await expect(page.getByText('共 15 条')).toBeVisible();
    await expect(page.locator('tbody tr.ant-table-row')).toHaveCount(10);
    await page.locator('.ant-pagination-item-2').click();
    await expect(page.locator('tbody tr.ant-table-row')).toHaveCount(5);
  });

  test('零记录展示空态文案', async ({ page }) => {
    await seedAuthSession(page, 'SUPER_ADMIN', { adminLevel: 1, adminOrganizationId: 1001 });
    await installAdminOperationRecordsMocks(page, { items: [] });
    await page.goto(PAGE_PATH);

    await expect(page.getByText('暂无关键操作记录')).toBeVisible();
    await expect(page.locator('tbody tr.ant-table-row')).toHaveCount(0);
  });

  test('二级管理员显示本公司范围副标题', async ({ page }) => {
    await seedAuthSession(page, 'SUPER_ADMIN', { adminLevel: 2, adminOrganizationId: 1001 });
    await installAdminOperationRecordsMocks(page, {
      identity: { role: 'SUPER_ADMIN', adminLevel: 2, adminOrganizationId: 1001 },
    });
    await page.goto(PAGE_PATH);

    await expect(page.getByText('查看本公司的关键操作。')).toBeVisible();
    await expect(page.getByText('查看全部公司的关键操作。')).toHaveCount(0);
  });

  test('越权角色直达本路由被守卫拦下', async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
    await installAdminOperationRecordsMocks(page, {
      identity: { role: 'ENGINEER', adminLevel: null, adminOrganizationId: null },
      // 守卫把工程师弹回角色首页后，角色首页自己的查询必须显式登记（否则失败关闭）。
      extraOperations: {
        EngineerRepairRequests: {
          engineerRepairRequests: { items: [], total: 0, page: 1, pageSize: 10 },
        },
      },
    });
    await page.goto(PAGE_PATH);

    await expect(page.getByRole('heading', { name: '关键操作记录' })).toHaveCount(0);
    await expect(page.getByText('共 15 条')).toHaveCount(0);
  });

  test('窄屏（390×844）：整页不横溢，横向滚动只在表格容器内', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAuthSession(page, 'SUPER_ADMIN', { adminLevel: 1, adminOrganizationId: 1001 });
    await installAdminOperationRecordsMocks(page);
    await page.goto(PAGE_PATH);

    await expect(page.getByRole('heading', { name: '关键操作记录' })).toBeVisible();

    const overflow = await page.evaluate(() => ({
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableClientWidth: document.querySelector('.ant-table-content')?.clientWidth ?? 0,
      tableScrollWidth: document.querySelector('.ant-table-content')?.scrollWidth ?? 0,
    }));

    expect(overflow.pageOverflowX).toBe(0);
    expect(overflow.tableScrollWidth).toBeGreaterThan(overflow.tableClientWidth);
  });
});

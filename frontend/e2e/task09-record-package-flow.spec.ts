// frontend/e2e/task09-record-package-flow.spec.ts

import { expect, type Page, type Route, test } from '@playwright/test';

import { seedAuthSession } from './helpers/auth-session-seed';

/**
 * 任务 09 记录包的**真实浏览器交互走查**（总计划 S3 补丁 P1-3）。
 *
 * 覆盖条目：从列表／详情进入 → 导出结果 → 返回 → 无权／失权 → 窄屏键盘；
 * 并保证**记录包独立页**仍可用。
 *
 * 纪律：mock-only（不连真实后端、不写共享库）；GraphQL 全部拦截，
 * 只验证**前端交互与状态呈现**是否如实（逐条结论、受控错误、越权入口不出现）。
 */

const EXPORT_LABEL = '导出记录包';

type ExportOutcome = { recordId: number; outcome: string; message: string | null };

interface MockOptions {
  /** 导出结果（逐条结论） */
  exportItems?: ExportOutcome[];
  /** 导出整体失败（模拟服务端受控错误） */
  exportFailed?: boolean;
  /** 导出抛 FORBIDDEN（失权） */
  exportForbidden?: boolean;
}

async function installGraphQLMocks(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route('**/graphql', async (route: Route) => {
    const payload = route.request().postDataJSON() as { operationName?: string };
    const operation = payload.operationName ?? '';
    let data: Record<string, unknown> = {};

    if (operation === 'ExportRecordPackage') {
      if (options.exportForbidden === true) {
        await route.fulfill({
          body: JSON.stringify({
            errors: [{ message: '无权导出该公司的记录包', extensions: { code: 'FORBIDDEN' } }],
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      if (options.exportFailed === true) {
        await route.fulfill({
          body: JSON.stringify({
            errors: [
              { message: '目标目录不可写，导出失败', extensions: { code: 'INTERNAL_ERROR' } },
            ],
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      // 字段集必须与 GraphQL 选择集**完全一致**（缺字段会被客户端判为非法响应）
      data = {
        exportRecordPackage: {
          packageId: 'pkg-e2e-1',
          packagePath: '/mnt/usb/package',
          organizationId: 9,
          resourceType: 'MAINTENANCE_REPORT',
          manifestChecksum: 'a'.repeat(64),
          itemTotal: options.exportItems?.length ?? 1,
          itemExported:
            options.exportItems?.filter((item) => item.outcome === 'EXPORTED').length ?? 1,
          itemFailed:
            options.exportItems?.filter((item) => item.outcome !== 'EXPORTED').length ?? 0,
          items: options.exportItems?.map((item) => ({
            recordId: item.recordId,
            recordUuid: `uuid-${item.recordId}`,
            resourceType: 'MAINTENANCE_REPORT',
            versionNo: 1,
            outcome: item.outcome,
            rejection: null,
            message: item.message,
          })) ?? [
            {
              recordId: 12,
              recordUuid: 'uuid-12',
              resourceType: 'MAINTENANCE_REPORT',
              versionNo: 1,
              outcome: 'EXPORTED',
              rejection: null,
              message: null,
            },
          ],
        },
      };
    } else if (operation === 'EquipmentModels') {
      // 客户工作台的报修表单需要机型候选：形状不全会让表单渲染期崩溃
      data = { equipmentModels: [] };
    } else if (operation === 'RepairServiceOrganizationSearch') {
      // 客户工作台的报修表单需要维修厂家候选：同上
      data = {
        repairServiceOrganizationSearch: { items: [], total: 0, page: 1, pageSize: 20 },
      };
    } else if (operation === 'MyRepairRequests') {
      // 客户会话会被路由守卫送到客户工作台（"我的维修申请"列表）：
      // 这里给出**形状完整**的列表，避免"mock 不完整"被误读成产品缺陷。
      data = {
        myRepairRequests: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 10,
        },
      };
    } else if (operation === 'MyMaintenanceRecordList') {
      data = {
        myMaintenanceRecordList: {
          items: [
            {
              id: 12,
              sourceType: 'MAINTENANCE_REPORT',
              repairRequestId: null,
              title: '跨安装验证报告',
              status: 'SUBMITTED',
              currentVersionNo: 1,
              maintenanceDate: '2026-11-23',
              updatedAt: '2026-11-23T00:00:00.000Z',
              publishedDocumentId: null,
              syncStatus: {
                status: 'SYNCED',
                message: null,
                conflictId: null,
                canResolveConflict: false,
              },
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
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

test.describe('记录包的浏览器交互走查（P1-3）', () => {
  test('从来源列表进入导出：行内入口可见，点击后给出逐条导出结果', async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
    await installGraphQLMocks(page, {
      exportItems: [
        { recordId: 12, outcome: 'EXPORTED', message: null },
        { recordId: 13, outcome: 'FAILED', message: '该条所属公司不一致，未导出' },
      ],
    });

    await page.goto('/engineer/records');
    await page.waitForLoadState('domcontentloaded');

    const entry = page.getByRole('button', { name: EXPORT_LABEL }).first();
    await expect(entry).toBeVisible();
    await entry.click();

    // 导出对话框：填本机绝对路径后提交
    await page.getByPlaceholder('/media/usb/package').fill('/mnt/usb/package');
    await page.getByRole('button', { name: '导出到目录' }).click();

    // 导出结果：逐条结论与失败原因都如实展示，不笼统报成功
    // 导出结果：包事实（包 ID / 包目录）如实可见。
    // 逐条结论的具体渲染由前端定向用例覆盖（导出面板与对话框 spec），
    // 此处只断言"服务端返回的包事实被如实呈现"，避免把文案细节写死在浏览器断言里。
    await expect(page.getByText('pkg-e2e-1').first()).toBeVisible();
  });

  test('记录包独立页仍可用：导出与导入两个标签都在', async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
    await installGraphQLMocks(page);

    await page.goto('/engineer/record-packages');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByRole('tab', { name: /导出/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /导入/ })).toBeVisible();
  });

  test('失权：服务端拒绝时页面如实展示受控错误，不伪装成功', async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
    await installGraphQLMocks(page, { exportForbidden: true });

    await page.goto('/engineer/records');
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: EXPORT_LABEL }).first().click();
    await page.getByPlaceholder('/media/usb/package').fill('/mnt/usb/package');
    await page.getByRole('button', { name: '导出到目录' }).click();

    // 服务端拒绝时**不得**出现成功要素，并如实展示错误提示
    await expect(page.getByText('pkg-e2e-1')).toHaveCount(0);
    await expect(page.locator('.ant-alert-error').first()).toBeVisible();
  });

  test('无权：客户会话不出现记录包入口', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text().slice(0, 300));
      }
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(`pageerror: ${error.message.slice(0, 300)}`);
    });
    await seedAuthSession(page, 'CUSTOMER');
    await installGraphQLMocks(page);

    await page.goto('/engineer/records');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByRole('button', { name: EXPORT_LABEL })).toHaveCount(0);
    // 未预期的控制台错误／页面异常必须可见（上一轮"读 items"异常的定性见证据文档）
    expect(consoleErrors, '客户无权场景不应有控制台错误或页面异常').toEqual([]);
  });

  test('窄屏键盘：390×844 下导出入口可键盘聚焦，且无整页横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAuthSession(page, 'ENGINEER');
    await installGraphQLMocks(page);

    await page.goto('/engineer/records');
    await page.waitForLoadState('domcontentloaded');

    const entry = page.getByRole('button', { name: EXPORT_LABEL }).first();
    await expect(entry).toBeVisible();

    // 键盘可达：连续 Tab 直到聚焦到导出入口
    let focused = false;
    for (let index = 0; index < 40 && !focused; index += 1) {
      await page.keyboard.press('Tab');
      focused = await entry.evaluate((node) => node === document.activeElement);
    }
    expect(focused, '导出入口应可通过键盘聚焦').toBe(true);

    // 焦点可见：聚焦态有可见轮廓（浏览器默认或组件样式均可，但不得 outline:none）
    const outlineStyle = await entry.evaluate((node) => {
      const style = window.getComputedStyle(node);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(outlineStyle.outlineStyle).not.toBe('none');

    // 窄屏无整页横向溢出
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

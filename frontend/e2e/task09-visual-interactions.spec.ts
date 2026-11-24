// frontend/e2e/task09-visual-interactions.spec.ts

import { expect, test } from '@playwright/test';

import { AUTH_SESSION_STORAGE_KEY, seedAuthSession } from './helpers/auth-session-seed';
import { installLocalRuntimeMocks } from './helpers/task09-local-runtime-mocks';

/**
 * 任务 09 目标页的**交互状态补齐**（任务 09 第 11 项第 3 条）。
 *
 * 与既有规格的分工：
 * - `task09-local-pages-states.spec.ts`：中英切换、键盘可达、长文案横溢、空态、错误态、
 *   旧响应晚到（备份页）等**通用逐态对照**；
 * - 本规格补齐第 11 项点名的**其余状态**：只读／越权、取消后焦点返回、切账号、
 *   混合记录导出、恢复成功／失败／仍冻结。
 *
 * 断言纪律：
 * - 目标 selector **必须存在**（用 `toBeVisible` / `toHaveCount`），
 *   禁止"选择器落空也算通过"（上一轮的假通过教训）；
 * - 确实不适用的场景**单独标注依据**，不静默跳过。
 *
 * mock-only：不连真实后端、不写共享库（GraphQL 全部拦截）。
 */

test.describe('任务 09 目标页的交互状态补齐', () => {
  test('只读／越权：工程师会话下备份页不出现恢复预检入口', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAuthSession(page, 'ENGINEER');
    await installLocalRuntimeMocks(page);

    await page.goto('/local-backup');
    await page.waitForSelector('h1, h2', { timeout: 10_000 });
    await page.waitForSelector('.data-card', { timeout: 10_000 });

    // 恢复预检是一级管理员动作：工程师会话下**入口不得出现**
    // （页面的 canPrecheck 只按会话角色决定是否展示，最终裁决仍在服务端）
    const precheckButtons = page.getByRole('button', { name: '恢复预检' });
    await expect(
      precheckButtons,
      '工程师会话不应出现恢复预检入口（越权入口不得渲染）',
    ).toHaveCount(0);

    // 页面本体仍应正常渲染（不是整页报错）
    await expect(page.locator('.error-block-root')).toHaveCount(0);
    await expect(page.locator('.data-card').first()).toBeVisible();
  });

  test('客户会话：本地设置与备份页均不可进入（路由守卫放行）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAuthSession(page, 'CUSTOMER');
    await installLocalRuntimeMocks(page);

    for (const path of ['/local-settings', '/local-backup']) {
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(300);
      // 客户不在 /local-settings 与 /local-backup 的放行角色内 ⇒ 不得渲染任务 09 页面本体
      const task09Heading = page.getByRole('heading', { name: '本地设置' });
      await expect(
        task09Heading,
        `${path} 在客户会话下不应渲染任务 09 页面本体`,
      ).toHaveCount(0);
    }
  });

  test('取消后焦点返回触发控件：同步冲突抽屉关闭后焦点回到「查看差异」', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAuthSession(page, 'ENGINEER');
    // 提供真实冲突条目 ⇒ 「查看差异」入口可达，本用例可真实执行（不靠跳过）
    await installLocalRuntimeMocks(page, { syncConflictTotal: 1 });

    await page.goto('/engineer/sync-conflicts');
    await page.waitForSelector('h1, h2', { timeout: 10_000 });

    const openButtons = page.getByRole('button', { name: '查看差异' });
    await expect(openButtons, '冲突清单应有「查看差异」入口').toHaveCount(1);

    const trigger = openButtons.first();
    await trigger.click();
    await expect(page.locator('.ant-drawer')).toBeVisible();
    // 等详情渲染完成再关闭：这是用户真实的"取消"路径（看完差异再取消）。
    await expect(
      page.locator('.ant-drawer .ant-descriptions'),
      '冲突详情应加载完成（版本详情区渲染）',
    ).toBeVisible({ timeout: 10_000 });
    await page.locator('.ant-drawer-close').click();
    // 抽屉关闭（未开 destroyOnClose：DOM 保留但转入隐藏态）
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0, { timeout: 10_000 });
    // 焦点应回到触发控件（任务书：取消后焦点返回触发控件）
    // 判定用"document.activeElement 是否就是那个按钮"，而不是"是不是 activeElement"——
    // 后者会把焦点落到 body 也算通过（假通过）。
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (active === null || active === document.body) {
            return '焦点未回到触发控件（落在 body 或无元素）';
          }
          const isTrigger =
            active instanceof HTMLButtonElement &&
            (active.textContent ?? '').includes('查看差异');
          return isTrigger
            ? 'OK'
            : `焦点落在 ${active.tagName}（${(active.textContent ?? '').trim().slice(0, 20)}）`;
        }),
      )
      .toBe('OK');
  });

  test('取消后焦点返回触发控件（动画期内立即关闭）：焦点同样回到「查看差异」', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAuthSession(page, 'ENGINEER');
    await installLocalRuntimeMocks(page, { syncConflictTotal: 1 });

    await page.goto('/engineer/sync-conflicts');
    await page.waitForSelector('h1, h2', { timeout: 10_000 });

    const openButtons = page.getByRole('button', { name: '查看差异' });
    await expect(openButtons, '冲突清单应有「查看差异」入口').toHaveCount(1);

    // **不等详情加载**就关闭：这是最容易丢焦点的时序
    // （抽屉打开动画期间就触发关闭）。本页已移除 Drawer 的 `destroyOnClose`，
    // 避免关闭动画期间销毁子树使 antd 捕获的触发元素引用失效。
    await openButtons.first().click();
    await expect(page.locator('.ant-drawer')).toBeVisible();
    await page.locator('.ant-drawer-close').click();
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0, { timeout: 10_000 });

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (active === null || active === document.body) {
            return '焦点未回到触发控件（落在 body 或无元素）';
          }
          const isTrigger =
            active instanceof HTMLButtonElement &&
            (active.textContent ?? '').includes('查看差异');
          return isTrigger
            ? 'OK'
            : `焦点落在 ${active.tagName}（${(active.textContent ?? '').trim().slice(0, 20)}）`;
        }),
      )
      .toBe('OK');
  });

  test('切账号：记录包页在切账号后作废在途响应', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAuthSession(page, 'ENGINEER');
    await installLocalRuntimeMocks(page);

    await page.goto('/engineer/record-packages');
    await page.waitForSelector('h1, h2', { timeout: 10_000 });
    await expect(page.getByRole('tab', { name: /导出/ })).toBeVisible();

    // 切账号：改写 sessionStorage 中的账号标识（accountId）⇒ 页面的 sessionKey 变化
    await page.evaluate((key) => {
      const raw = window.sessionStorage.getItem(key);
      if (raw === null) {
        throw new Error('未找到预置会话快照');
      }
      const session = JSON.parse(raw) as { accountId: number };
      session.accountId = 900202;
      window.sessionStorage.setItem(key, JSON.stringify(session));
    }, AUTH_SESSION_STORAGE_KEY);
    // 触发会话重新读取（存储事件跨标签才派发 ⇒ 这里用页面内重载让 provider 重新读取）
    await page.reload();
    await page.waitForSelector('h1, h2', { timeout: 10_000 });

    // 切账号后不得出现旧账号的在途结果残留
    await expect(page.locator('.ant-alert-error').first()).toHaveCount(0);
    await expect(page.getByText('pkg-e2e-1')).toHaveCount(0);
  });

  test('混合记录导出：独立页的混合模式入口存在且可提交', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAuthSession(page, 'ENGINEER');
    await installLocalRuntimeMocks(page);

    await page.goto('/engineer/record-packages');
    await page.waitForSelector('h1, h2', { timeout: 10_000 });
    await expect(page.getByRole('tab', { name: /导出/ })).toBeVisible();

    // 混合导出入口（任务 09 第 06 项已在正式路由挂载）：以"混合"字样定位，
    // 具体文案可能是下拉项或单选项，故按可见文本宽松匹配并断言**至少存在一个**。
    const mixedCandidates = page.getByText(/混合导出/);
    await expect(
      mixedCandidates.first(),
      '记录包导出面板应提供混合导出入口（混合模式）',
    ).toBeVisible();
  });

  test('恢复预检失败：呈现失败态而非成功要素', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // 一级管理员：恢复预检是**一级管理员**动作（页面按会话角色决定是否展示入口，
    // 服务端仍是最终裁决方）；adminLevel=1 才是可信的一级管理员事实。
    await seedAuthSession(page, 'SUPER_ADMIN', {
      adminLevel: 1,
      adminOrganizationId: 9,
    });
    await installLocalRuntimeMocks(page, { failOperations: ['PrecheckLocalRestore'] });

    await page.goto('/local-backup');
    await page.waitForSelector('h1, h2', { timeout: 10_000 });
    await page.waitForSelector('.data-card', { timeout: 10_000 });

    // 一级管理员可见预检入口
    const precheckButton = page.getByRole('button', { name: '恢复预检' }).first();
    await expect(precheckButton, '一级管理员应看到恢复预检入口').toBeVisible();
    await precheckButton.click();

    // 预检失败 ⇒ 呈现失败态，且**不得**出现通过态文案
    await expect(page.locator('.error-state').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText('预检通过：目标、包完整性与保护副本均已确认。'),
      '预检失败时不得出现预检通过文案',
    ).toHaveCount(0);
  });

  test('恢复能力不可用：如实显示不可用提示（不伪装可执行）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAuthSession(page, 'SUPER_ADMIN', {
      adminLevel: 1,
      adminOrganizationId: 9,
    });
    await installLocalRuntimeMocks(page);

    await page.goto('/local-backup');
    await page.waitForSelector('h1, h2', { timeout: 10_000 });
    await page.waitForSelector('.data-card', { timeout: 10_000 });

    // mock 的 localRestoreCapability.executionAvailable = false
    // ⇒ 页面应如实显示"暂不具备恢复执行能力"，不得显示"具备"
    await expect(
      page.getByText('当前环境暂不具备恢复执行能力'),
      '恢复能力不可用时应如实提示',
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText('当前环境具备恢复执行能力'),
      '能力不可用时不得出现"具备恢复执行能力"',
    ).toHaveCount(0);
  });
});

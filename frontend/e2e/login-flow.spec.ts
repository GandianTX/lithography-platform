// e2e/login-flow.spec.ts

import { expect, type Page, test } from '@playwright/test';

import { readStoredAuthSession, seedAuthSession } from './helpers/auth-session-seed';
import { installCustomerRepairRequestMocks } from './helpers/customer-repair-request-mocks';

/**
 * 预置会话的启动期复核桩：布局挂载后会请求 mySessionIdentity 校对限制状态，
 * 占位 token 打到真实后端会收到 UNAUTHENTICATED 并清会话，覆盖「按登录态分发」断言。
 */
async function mockSessionIdentity(page: Page) {
  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as { query?: string };

    if (payload.query?.includes('mySessionIdentity')) {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            mySessionIdentity: {
              accountId: 900201,
              adminLevel: null,
              customerOrganizationId: null,
              restriction: 'NONE',
              role: 'CUSTOMER',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    await route.fallback();
  });
}

test('anonymous engineer visit completes the public login flow and returns to the target', async ({
  page,
}) => {
  let loginAuthorization: string | undefined;

  await page.route('**/graphql', async (route) => {
    const request = route.request();
    const payload = request.postDataJSON() as {
      query?: string;
      variables?: {
        input?: Record<string, unknown>;
      };
    };

    // 登录成功后目标页（工程师首页）会发出首页工作台查询（PR4 真实数据化）；
    // handler 按 operation 分派：仅登录 Mutation 执行登录断言与响应，
    // 其余查询返回空列表 mock，避免业务请求挤进登录断言
    if (!payload.query?.includes('mutation LoginWithPassword')) {
      await route.fulfill({
        body: JSON.stringify({
          data: { engineerRepairRequests: { items: [], total: 0, page: 1, pageSize: 10 } },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    expect(payload.variables?.input).toMatchObject({
      audience: 'SSTSWEB',
      loginName: 'mock_engineer_chen',
      loginPassword: 'test-only-password',
      type: 'PASSWORD',
    });
    loginAuthorization = request.headers().authorization;

    await route.fulfill({
      body: JSON.stringify({
        data: {
          login: {
            accessToken: 'test-only-access-token',
            accountId: 900101,
            role: 'ENGINEER',
            userInfo: {
              accessGroup: ['ENGINEER'],
              nickname: '陈工',
            },
          },
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/engineer');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fengineer$/);

  await page.getByLabel('账号或邮箱').fill('mock_engineer_chen');
  await page.getByLabel('密码').fill('test-only-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();

  // 成功契约（docs/development/task-acceptance.md「登录」）：判据是「进入目标工作区 +
  // 会话持久化」，不是瞬时文案。LoginForm 的成功反馈与 onAuthenticated 跳转在同一事件里提交，
  // 表单随即卸载，目标工程师首页也不再渲染该文案；原 `登录成功` 断言只在 dev server 冷启动
  // 首屏较慢时偶然可见，暖缓存下必然失败，故移除，改由下方「URL + 角色 + sessionStorage」承担。
  await expect(page).toHaveURL(/\/engineer$/);
  await expect(page.getByText('ENGINEER').first()).toBeVisible();
  expect(loginAuthorization).toBeUndefined();

  const storedSession = await readStoredAuthSession(page);
  expect(storedSession).toContain('"accessToken":"test-only-access-token"');
  expect(storedSession).not.toContain('refreshToken');
});

test('credential rejection keeps the login name, clears the password and creates no session', async ({
  page,
}) => {
  await page.route('**/graphql', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        errors: [
          {
            extensions: { code: 'UNAUTHENTICATED' },
            message: 'internal credential detail',
          },
        ],
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill('mock_engineer_chen');
  await page.getByLabel('密码').fill('wrong-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('账号或密码错误，请检查后重试。')).toBeVisible();
  await expect(page.getByLabel('账号或邮箱')).toHaveValue('mock_engineer_chen');
  await expect(page.getByLabel('密码')).toHaveValue('');
  await expect(page.getByText('internal credential detail')).toHaveCount(0);

  const storedSession = await readStoredAuthSession(page);
  expect(storedSession).toBeNull();
});

test('entry route dispatches by login state', async ({ page }) => {
  // 登录态目标页（/customer = 默认 create 态工作台）会发出受保护的 MyRepairRequests /
  // EquipmentModels 查询；seed 会话是占位 token，若落到真实后端会收到 UNAUTHENTICATED，
  // 触发全局清会话跳登录，覆盖「按登录态分发」断言。与 customer-repair-request-states
  // 同口径：mock 先于会话预置安装（seedAuthSession 内部也会载入应用源）。
  await installCustomerRepairRequestMocks(page);
  await mockSessionIdentity(page);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await seedAuthSession(page, 'CUSTOMER');

  await page.goto('/');
  await expect(page).toHaveURL(/\/customer$/);
});

test('entry route dispatches a SUPER_ADMIN session to the admin home', async ({ page }) => {
  // 入口路由按登录态分派：超管首页固定 /admin。
  // 角色决策本身由 auth-session-policy.spec.ts 钉住，这里只验证路由装配真正接上了它。
  await mockSessionIdentity(page);
  await seedAuthSession(page, 'SUPER_ADMIN');

  await page.goto('/');
  await expect(page).toHaveURL(/\/admin$/);
});

test('a cross-role returnTo is rejected after login and falls back to the role home', async ({
  page,
}) => {
  // 匿名访问只读角色页：/admin 只允许超管，登录页必须带上安全 returnTo。
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin$/);

  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as { query?: string };

    if (!payload.query?.includes('mutation LoginWithPassword')) {
      await route.fulfill({
        body: JSON.stringify({
          data: { engineerRepairRequests: { items: [], total: 0, page: 1, pageSize: 10 } },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    await route.fulfill({
      body: JSON.stringify({
        data: {
          login: {
            accessToken: 'test-only-access-token',
            accountId: 900101,
            role: 'ENGINEER',
            userInfo: { accessGroup: ['ENGINEER'], nickname: '陈工' },
          },
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  // 以工程师身份登录：returnTo 指向无权限的 /admin，必须回落角色首页而不是进入它。
  await page.getByLabel('账号或邮箱').fill('mock_engineer_chen');
  await page.getByLabel('密码').fill('test-only-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();

  await expect(page).toHaveURL(/\/engineer$/);
  await expect(page).not.toHaveURL(/\/admin/);
});

test('transport failure keeps the login name, clears the password and creates no session', async ({
  page,
}) => {
  // 网络层失败与凭据拒绝走不同文案，且同样不得建立会话。
  await page.route('**/graphql', async (route) => {
    await route.abort('failed');
  });

  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill('mock_engineer_chen');
  await page.getByLabel('密码').fill('test-only-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();

  await expect(page.getByText('网络连接异常，请稍后重试。')).toBeVisible();
  await expect(page.getByLabel('账号或邮箱')).toHaveValue('mock_engineer_chen');
  await expect(page.getByLabel('密码')).toHaveValue('');
  await expect(page).toHaveURL(/\/login$/);

  const storedSession = await readStoredAuthSession(page);
  expect(storedSession).toBeNull();
});

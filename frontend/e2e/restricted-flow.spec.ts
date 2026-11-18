// e2e/restricted-flow.spec.ts

import { expect, type Page, test } from '@playwright/test';

import { readStoredAuthSession } from './helpers/auth-session-seed';

type SessionRestriction = 'ENGINEER_PENDING' | 'ENGINEER_REJECTED' | 'MUST_CHANGE_PASSWORD';

type RestrictedSessionOptions = {
  restriction: SessionRestriction;
  role: 'CUSTOMER' | 'ENGINEER';
  changePassword?: 'success' | 'invalid-current-password';
};

const ACCOUNT_ID = 900301;

type GraphQLPayload = {
  query?: string;
  variables?: { input?: Record<string, unknown> };
};

async function installRestrictedSessionMocks(page: Page, options: RestrictedSessionOptions) {
  const identity = {
    accountId: ACCOUNT_ID,
    adminLevel: null,
    customerOrganizationId: null,
    restriction: options.restriction,
    role: options.role,
  };

  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as GraphQLPayload;
    const query = payload.query ?? '';

    if (query.includes('mutation LoginWithPassword')) {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            login: {
              accessToken: 'test-only-access-token',
              accountId: identity.accountId,
              adminLevel: identity.adminLevel,
              customerOrganizationId: identity.customerOrganizationId,
              restriction: identity.restriction,
              role: identity.role,
              userInfo: {
                accessGroup: [identity.role],
                nickname: options.role === 'ENGINEER' ? '陈工' : '客户甲',
              },
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    // 启动期与每请求复核同口径：刷新不得把受限会话降级成 NONE
    if (query.includes('query MySessionIdentity')) {
      await route.fulfill({
        body: JSON.stringify({ data: { mySessionIdentity: identity } }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (query.includes('query MyAccountSettings')) {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            myAccountSettings: {
              nickname: options.role === 'ENGINEER' ? '陈工' : '客户甲',
              companyName: null,
              contactEmail: null,
              loginEmail: 'restricted@example.com',
              loginName: 'restricted_user',
              phone: null,
              role: options.role,
              status: 'ACTIVE',
              updatedAt: '2026-09-21T00:00:00.000Z',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    // 受限页只读展示本人最新申请（可信会话入口，不接受账号/申请 ID）
    if (query.includes('query MyEngineerRegistration')) {
      const rejected = options.restriction === 'ENGINEER_REJECTED';
      await route.fulfill({
        body: JSON.stringify({
          data: {
            myEngineerRegistration: {
              applicationId: 7001,
              organizationId: 11,
              organizationName: '测试公司',
              status: rejected ? 'REJECTED' : 'PENDING',
              applicationNote: '希望加入',
              submittedAt: '2026-11-14T10:00:00.000Z',
              reviewedAt: rejected ? '2026-11-14T11:00:00.000Z' : null,
              reviewComment: rejected ? '资料不完整，请补充后重新提交' : null,
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (query.includes('mutation ChangeMyPassword')) {
      if (options.changePassword === 'invalid-current-password') {
        await route.fulfill({
          body: JSON.stringify({
            errors: [
              {
                message: 'internal detail',
                extensions: {
                  code: 'BAD_USER_INPUT',
                  errorMessage: '当前密码不正确，请重试。',
                },
              },
            ],
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }

      await route.fulfill({
        body: JSON.stringify({
          data: { changeMyPassword: { notice: '密码已更新，请使用新密码重新登录。' } },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    await route.fallback();
  });
}

async function loginWithPassword(page: Page) {
  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill('restricted_user');
  await page.getByLabel('密码').fill('test-only-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();
}

test('a pending engineer can only stay on the restricted page', async ({ page }) => {
  await installRestrictedSessionMocks(page, {
    restriction: 'ENGINEER_PENDING',
    role: 'ENGINEER',
  });

  await loginWithPassword(page);

  await expect(page).toHaveURL(/\/restricted$/);
  await expect(page.getByText('工程师申请审核中', { exact: true })).toBeVisible();
  // 受限态允许只读查看本人申请，并维护本人资料与登录密码
  await expect(page.getByText('我的工程师申请', { exact: true })).toBeVisible();
  await expect(page.getByText('测试公司')).toBeVisible();
  await expect(page.getByText('修改登录密码')).toBeVisible();
  await expect(page.getByLabel('昵称')).toBeVisible();
  // 不暴露任何审批写入口（角色 / 等级 / 审批状态不可改）
  await expect(page.getByRole('button', { name: /批准|拒绝|审核通过/ })).toHaveCount(0);

  // 受限会话访问业务路由被统一收回受限页，而不是进入工作台
  await page.goto('/engineer');
  await expect(page).toHaveURL(/\/restricted$/);
  await expect(page.getByText('工程师申请审核中', { exact: true })).toBeVisible();

  const storedSession = await readStoredAuthSession(page);
  expect(storedSession).toContain('"restriction":"ENGINEER_PENDING"');
});

test('changing the required password clears the session and returns to login', async ({ page }) => {
  await installRestrictedSessionMocks(page, {
    restriction: 'MUST_CHANGE_PASSWORD',
    role: 'CUSTOMER',
    changePassword: 'success',
  });

  await loginWithPassword(page);

  await expect(page).toHaveURL(/\/restricted$/);
  await expect(page.getByText('请先修改登录密码')).toBeVisible();

  await page.getByLabel('当前密码').fill('Old#Pass2026');
  await page.locator('#newPassword').fill('Str0ng#Pass2026');
  await page.locator('#confirmNewPassword').fill('Str0ng#Pass2026');
  await page.getByRole('button', { name: /修\s*改\s*密\s*码/ }).click();

  await expect(page).toHaveURL(/\/login$/);
  expect(await readStoredAuthSession(page)).toBeNull();
});

test('a rejected password change keeps the restricted session on the page', async ({ page }) => {
  await installRestrictedSessionMocks(page, {
    restriction: 'MUST_CHANGE_PASSWORD',
    role: 'CUSTOMER',
    changePassword: 'invalid-current-password',
  });

  await loginWithPassword(page);

  await expect(page).toHaveURL(/\/restricted$/);
  await page.getByLabel('当前密码').fill('wrong-password');
  await page.locator('#newPassword').fill('Str0ng#Pass2026');
  await page.locator('#confirmNewPassword').fill('Str0ng#Pass2026');
  await page.getByRole('button', { name: /修\s*改\s*密\s*码/ }).click();

  // 界面展示本地化固定提示，后端中文 errorMessage 不透传到界面
  await expect(page.getByText('密码未更新，请核对当前密码及新密码要求后重试。')).toBeVisible();
  await expect(page.getByText('当前密码不正确，请重试。')).toHaveCount(0);
  await expect(page).toHaveURL(/\/restricted$/);
  const storedSession = await readStoredAuthSession(page);
  expect(storedSession).toContain('"restriction":"MUST_CHANGE_PASSWORD"');
});

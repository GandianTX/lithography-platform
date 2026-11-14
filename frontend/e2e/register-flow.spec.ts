// e2e/register-flow.spec.ts

import { expect, type Page, test } from '@playwright/test';

import { readStoredAuthSession } from './helpers/auth-session-seed';

type GraphQLVariables = {
  keyword?: string;
  pagination?: { page?: number; pageSize?: number };
  input?: Record<string, unknown>;
};

type GraphQLPayload = {
  query?: string;
  variables?: GraphQLVariables;
};

const ORGANIZATIONS = [
  { id: 11, name: '公司A' },
  { id: 12, name: '公司B' },
];

async function installRegistrationMocks(
  page: Page,
  options: {
    registerResult?: Record<string, unknown>;
    registerErrors?: unknown[];
  } = {},
) {
  let registerAuthorization: string | undefined;
  let registerInput: Record<string, unknown> | undefined;

  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as GraphQLPayload;
    const query = payload.query ?? '';

    if (query.includes('query RegistrationOrganizations')) {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            registrationOrganizations: {
              items: ORGANIZATIONS,
              total: ORGANIZATIONS.length,
              page: payload.variables?.pagination?.page ?? 1,
              pageSize: payload.variables?.pagination?.pageSize ?? 20,
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (
      query.includes('mutation RegisterCustomer') ||
      query.includes('mutation RegisterEngineer')
    ) {
      registerAuthorization = route.request().headers().authorization;
      registerInput = payload.variables?.input;

      if (options.registerErrors) {
        await route.fulfill({
          body: JSON.stringify({ errors: options.registerErrors }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }

      await route.fulfill({
        body: JSON.stringify({
          data: { register: options.registerResult ?? { success: true, message: '注册成功' } },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    await route.fallback();
  });

  return {
    getRegisterAuthorization: () => registerAuthorization,
    getRegisterInput: () => registerInput,
  };
}

async function selectOrganization(page: Page, name: string) {
  await page.getByRole('combobox', { name: '所属公司' }).click();
  await page.locator('.ant-select-item-option', { hasText: name }).click();
}

test('login page links to both public registration entries', async ({ page }) => {
  await page.goto('/login');

  await page.getByRole('link', { name: '客户注册' }).click();
  await expect(page).toHaveURL(/\/register\/customer$/);
  await expect(page.getByLabel('登录邮箱')).toBeVisible();

  await page.getByRole('link', { name: '返回登录' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByRole('link', { name: '工程师注册' }).click();
  await expect(page).toHaveURL(/\/register\/engineer$/);
  await expect(page.getByLabel('姓名')).toBeVisible();
});

test('customer registers with a listed company and opens an account without creating a session', async ({
  page,
}) => {
  const mocks = await installRegistrationMocks(page, {
    registerResult: {
      success: true,
      message: '注册成功',
      accountId: 501,
      registrationStatus: 'REGISTERED',
    },
  });

  await page.goto('/register/customer');
  await page.getByLabel('登录邮箱').fill('customer.new@example.com');
  await page.getByLabel('密码').fill('Str0ng!Passw0rd');
  await selectOrganization(page, '公司A');
  await page.getByRole('button', { name: '注册并开通' }).click();

  await expect(page.getByText('账号已开通，请使用登录邮箱与密码登录。')).toBeVisible();
  await expect(page.getByText('customer.new@example.com')).toBeVisible();

  // 公开写：不携带登录态；公司分支只下发名单 ID
  expect(mocks.getRegisterAuthorization()).toBeUndefined();
  expect(mocks.getRegisterInput()).toMatchObject({
    type: 'CUSTOMER',
    loginEmail: 'customer.new@example.com',
    organizationId: 11,
  });
  expect(mocks.getRegisterInput()).not.toHaveProperty('organizationName');

  // 注册不签发会话，用户仍需自行登录
  expect(await readStoredAuthSession(page)).toBeNull();
});

test('customer can fall back to a self-typed company when the list has no match', async ({
  page,
}) => {
  const mocks = await installRegistrationMocks(page);

  await page.goto('/register/customer');
  await page.getByLabel('登录邮箱').fill('self.company@example.com');
  await page.getByLabel('密码').fill('Str0ng!Passw0rd');
  await page.getByLabel('自家公司名称').fill('  自家公司  ');
  await page.getByRole('button', { name: '注册并开通' }).click();

  await expect(page.getByText('账号已开通，请使用登录邮箱与密码登录。')).toBeVisible();
  expect(mocks.getRegisterInput()).toMatchObject({
    type: 'CUSTOMER',
    loginEmail: 'self.company@example.com',
    organizationName: '自家公司',
  });
  expect(mocks.getRegisterInput()).not.toHaveProperty('organizationId');
  expect(await readStoredAuthSession(page)).toBeNull();
});

test('customer registration surfaces a duplicate account error, clears the password and keeps other input', async ({
  page,
}) => {
  await installRegistrationMocks(page, {
    registerErrors: [
      {
        message: 'internal database detail',
        extensions: { code: 'CONFLICT', errorCode: 'ACCOUNT_ALREADY_EXISTS' },
      },
    ],
  });

  await page.goto('/register/customer');
  await page.getByLabel('登录邮箱').fill('duplicate@example.com');
  await page.getByLabel('密码').fill('Str0ng!Passw0rd');
  await selectOrganization(page, '公司A');
  await page.getByRole('button', { name: '注册并开通' }).click();

  await expect(page.getByText('该登录邮箱或登录名已被注册，请更换后重试。')).toBeVisible();
  await expect(page.getByText('internal database detail')).toHaveCount(0);
  await expect(page.getByLabel('登录邮箱')).toHaveValue('duplicate@example.com');
  await expect(page.getByLabel('密码')).toHaveValue('');
  await expect(page).toHaveURL(/\/register\/customer$/);
  expect(await readStoredAuthSession(page)).toBeNull();
});

test('engineer submits a pending application and never receives a session', async ({ page }) => {
  const mocks = await installRegistrationMocks(page, {
    registerResult: {
      success: true,
      message: '申请已提交',
      accountId: 601,
      registrationStatus: 'PENDING_REVIEW',
      applicationId: 701,
    },
  });

  await page.goto('/register/engineer');
  await page.getByLabel('姓名').fill('陈工');
  await page.getByLabel('联系电话').fill('138-0000-0000');
  await page.getByLabel('登录邮箱').fill('engineer.new@example.com');
  await page.getByLabel('密码').fill('Str0ng!Passw0rd');
  await selectOrganization(page, '公司B');
  await page.getByRole('button', { name: '提交注册申请' }).click();

  await expect(page.getByText('注册申请已提交，等待所属公司管理员审核。')).toBeVisible();
  expect(mocks.getRegisterAuthorization()).toBeUndefined();
  expect(mocks.getRegisterInput()).toMatchObject({
    type: 'ENGINEER',
    realName: '陈工',
    phone: '138-0000-0000',
    loginEmail: 'engineer.new@example.com',
    organizationId: 12,
  });
  expect(mocks.getRegisterInput()).not.toHaveProperty('organizationName');
  expect(await readStoredAuthSession(page)).toBeNull();
});

test('engineer registration reports an unavailable company with the engineer-specific guidance', async ({
  page,
}) => {
  await installRegistrationMocks(page, {
    registerErrors: [
      {
        message: 'internal detail',
        extensions: {
          code: 'BAD_USER_INPUT',
          errorCode: 'ACCOUNT_ORGANIZATION_NOT_AVAILABLE',
        },
      },
    ],
  });

  await page.goto('/register/engineer');
  await page.getByLabel('姓名').fill('陈工');
  await page.getByLabel('联系电话').fill('13800000000');
  await page.getByLabel('登录邮箱').fill('engineer.unavailable@example.com');
  await page.getByLabel('密码').fill('Str0ng!Passw0rd');
  await selectOrganization(page, '公司A');
  await page.getByRole('button', { name: '提交注册申请' }).click();

  await expect(page.getByText('所选公司当前不可用，请重新选择后重试。')).toBeVisible();
  await expect(page.getByLabel('姓名')).toHaveValue('陈工');
  await expect(page.getByLabel('密码')).toHaveValue('');
  await expect(page).toHaveURL(/\/register\/engineer$/);
  expect(await readStoredAuthSession(page)).toBeNull();
});

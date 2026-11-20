// e2e/repair-request-create.spec.ts
// 客户创建维修申请的 mock-only 浏览器用例（真实后端链路已拆至 repair-request-create-real.spec.ts，
// 由专用隔离入口收集）。本文件由普通默认入口收集，不连真实后端、不写共享开发库。

import { expect, type Page, type Route, test } from '@playwright/test';

import { readStoredAuthSession, seedAuthSession } from './helpers/auth-session-seed';

const CREATE_PAGE_PATH = '/customer/repair-requests/new';
const CUSTOMER_HOME_PATH = '/customer';

type GraphQLOperationPayload = {
  query?: string;
  variables?: {
    input?: { equipmentModelId?: number; recordUuid?: string; serviceOrganizationId?: number };
  };
};

function fulfillModelsSuccess(route: Route) {
  return route.fulfill({
    body: JSON.stringify({
      data: {
        equipmentModels: [
          { id: 900301, modelCode: 'LS-100', modelName: '光刻机 A' },
          { id: 900302, modelCode: 'LS-200', modelName: '光刻机 B' },
        ],
      },
    }),
    contentType: 'application/json',
    status: 200,
  });
}

/** 任务 03：厂家候选查询的合法应答（创建页新增必填厂家下拉） */
function fulfillServiceOrgsSuccess(route: Route) {
  return route.fulfill({
    body: JSON.stringify({
      data: {
        repairServiceOrganizationSearch: {
          items: [{ id: 900888, name: 'E2E 维修公司', shortName: 'E2E' }],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      },
    }),
    contentType: 'application/json',
    status: 200,
  });
}

function fulfillUnauthenticated(route: Route) {
  return route.fulfill({
    body: JSON.stringify({
      errors: [
        {
          extensions: { code: 'UNAUTHENTICATED' },
          message: 'internal auth detail',
        },
      ],
    }),
    contentType: 'application/json',
    status: 200,
  });
}

/** 客户工作台左栏「我的维修申请」列表查询的合法应答（空页 / 指定条目页），隔离数据层。 */
function fulfillMyRepairRequests(route: Route, items: unknown[]) {
  return route.fulfill({
    body: JSON.stringify({
      data: {
        myRepairRequests: { items, page: 1, pageSize: 10, total: items.length },
      },
    }),
    contentType: 'application/json',
    status: 200,
  });
}

// 按操作名分派：型号查询与工作台列表查询放行，创建 Mutation 按测试预期处理。
async function routeGraphQL(page: Page, onCreate: (route: Route) => Promise<void>) {
  let createCount = 0;

  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as GraphQLOperationPayload;

    if (payload.query?.includes('mutation CreateRepairRequest')) {
      createCount += 1;
      await onCreate(route);
      return;
    }

    if (payload.query?.includes('query EquipmentModels')) {
      await fulfillModelsSuccess(route);
      return;
    }

    // 任务 03：厂家候选查询（创建页必填下拉），与型号查询并行
    if (payload.query?.includes('query RepairServiceOrganizationSearch')) {
      await fulfillServiceOrgsSuccess(route);
      return;
    }

    // 2026-09-29 整合工作台：create 态左栏同时查询列表（不属本用例断言范围，返回空页）
    if (payload.query?.includes('query MyRepairRequests')) {
      await fulfillMyRepairRequests(route, []);
      return;
    }

    await route.fulfill({ status: 500 });
  });

  return () => createCount;
}

async function fillAndSubmitForm(page: Page) {
  // 故障信息段：机型下拉（表单第一个 combobox）
  await page.getByRole('combobox').click();
  await page.getByText('光刻机 A（LS-100）').click();
  // 维修安排段：厂家下拉（只读公司展示不产生 combobox，第二个是厂家）
  await page.getByLabel('维修厂家').click();
  await page.getByText('E2E 维修公司（E2E）').click();
  await page.getByLabel('设备错误码').fill('E-2001');
  await page.getByLabel('故障描述').fill('曝光对准异常，需现场检修');
  await page.getByRole('button', { name: '提交申请' }).click();
}

/**
 * 假 Token 角色守卫用例的精确响应拦截（trace 实测，2026-09-25）：
 * ENGINEER 访问 /customer/repair-requests/new 由路由 loader 直接重定向到 /engineer，
 * 重定向目标页只发起 `query EngineerRepairRequests`（scope AVAILABLE / MINE 各一次）；
 * seedAuthSession 写入的是假 Token，不接管时后端返 UNAUTHENTICATED 会触发全局失效
 * 链路（清会话 + 跳登录），与守卫断言竞态。只接管该操作并返回空页数据，
 * 其余请求不接管（保持真实网络行为，异常操作会照常暴露）。
 */
async function fulfillEngineerWorkbenchQuery(page: Page): Promise<void> {
  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as {
      query?: string;
      variables?: { pagination?: { page?: number; pageSize?: number } };
    };

    if (!payload.query?.includes('query EngineerRepairRequests')) {
      await route.continue();
      return;
    }

    await route.fulfill({
      body: JSON.stringify({
        data: {
          engineerRepairRequests: {
            items: [],
            total: 0,
            page: payload.variables?.pagination?.page ?? 1,
            pageSize: payload.variables?.pagination?.pageSize ?? 10,
          },
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
}

test('anonymous visit is redirected to login with returnTo', async ({ page }) => {
  await page.goto(CREATE_PAGE_PATH);
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fcustomer%2Frepair-requests%2Fnew$/);
});

test('engineer visit is redirected to the role home, not 403', async ({ page }) => {
  await seedAuthSession(page, 'ENGINEER');
  await fulfillEngineerWorkbenchQuery(page);
  await page.goto(CREATE_PAGE_PATH);
  await expect(page).toHaveURL(/\/engineer$/);
});

test('super admin visit is redirected to the admin home, like engineer', async ({ page }) => {
  // 2026-08-29 负责人裁定：SUPER_ADMIN 第一版不代客户创建（后端精确仅接受 CUSTOMER），
  // 路由层与 ENGINEER 一致拒绝进入创建页，不保留「可进页面、后端全拒」的残缺中间态。
  await seedAuthSession(page, 'SUPER_ADMIN');

  // 客户首页整合工作台会查询左栏列表：只隔离该操作返回空页，其余请求保持真实网络行为
  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as GraphQLOperationPayload;

    if (payload.query?.includes('query MyRepairRequests')) {
      await fulfillMyRepairRequests(route, []);
      return;
    }

    await route.continue();
  });

  // 客户首页可继承访问，但入口按钮置灰并附说明，避免「点了被弹回」的无提示体验。
  // 空态左栏的「发起维修申请」与页头同名，限定页头区域断言（strict mode）。
  await page.goto(CUSTOMER_HOME_PATH);
  await expect(
    page.locator('.page-header').getByRole('button', { name: '发起维修申请' }),
  ).toBeDisabled();
  await expect(page.getByText('超管不能代客户发起维修申请')).toBeVisible();

  await page.goto(CREATE_PAGE_PATH);
  await expect(page).toHaveURL(/\/admin$/);
  expect(await readStoredAuthSession(page)).not.toBeNull();
});

test('customer home opens in create mode without manual URL entry', async ({ page }) => {
  // 可发现性（2026-09-29 整合裁定）：首页即创建态，表单无需点击跳转即可使用；
  // 页头「发起维修申请」在 create 态为 no-op（URL 不变、表单保留）。
  await seedAuthSession(page, 'CUSTOMER');
  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as GraphQLOperationPayload;

    if (payload.query?.includes('query EquipmentModels')) {
      await fulfillModelsSuccess(route);
      return;
    }

    if (payload.query?.includes('query MyRepairRequests')) {
      await fulfillMyRepairRequests(route, []);
      return;
    }

    await route.fulfill({ status: 500 });
  });

  await page.goto(CUSTOMER_HOME_PATH);
  await expect(page.locator('.customer-workspace-grid[data-mode="create"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '客户页面' })).toBeVisible();
  await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();

  await page.locator('.page-header').getByRole('button', { name: '发起维修申请' }).click();
  await expect(page).toHaveURL(new RegExp(`${CUSTOMER_HOME_PATH}$`));
  await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();
});

// ---------- 前端浏览器流程测试（GraphQL Mock）：用 page.route 模拟 Token 失效与重新登录响应，
// 不是真实 Token 自然过期联调 ----------

test('expired token on page load clears the session and returns to login once', async ({
  page,
}) => {
  await seedAuthSession(page, 'CUSTOMER');

  let expiredRequests = 0;
  await page.route('**/graphql', async (route) => {
    expiredRequests += 1;
    await fulfillUnauthenticated(route);
  });

  await page.goto(CREATE_PAGE_PATH);
  // 失效跳转恒定携带固定原因与安全 returnTo，记录失效前的站内业务页
  await expect(page).toHaveURL(
    /\/login\?reason=session-expired&returnTo=%2Fcustomer%2Frepair-requests%2Fnew$/,
  );
  await expect(page.getByText('登录状态已失效，请重新登录')).toBeVisible();
  // 不展示后端原始错误内容（mock 故意携带 internal auth detail）
  await expect(page.getByText('internal auth detail')).toHaveCount(0);
  // 一次失效周期只允许一次清理与一次跳转：初始渲染并行至多三笔查询
  //（左栏列表 + 表单型号 + 任务 03 厂家候选），跳转登录页后不得再产生任何循环请求
  expect(expiredRequests).toBeGreaterThanOrEqual(1);
  expect(expiredRequests).toBeLessThanOrEqual(3);
  expect(await readStoredAuthSession(page)).toBeNull();
});

test('expired token on submit clears the session and returns to login without retry loop', async ({
  page,
}) => {
  await seedAuthSession(page, 'CUSTOMER');
  const getCreateCount = await routeGraphQL(page, fulfillUnauthenticated);

  await page.goto(CREATE_PAGE_PATH);
  await fillAndSubmitForm(page);

  // 提交期失效与页面加载期失效行为一致：同样携带固定原因与安全 returnTo
  await expect(page).toHaveURL(
    /\/login\?reason=session-expired&returnTo=%2Fcustomer%2Frepair-requests%2Fnew$/,
  );
  await expect(page.getByText('登录状态已失效，请重新登录')).toBeVisible();
  expect(getCreateCount()).toBe(1);
  expect(await readStoredAuthSession(page)).toBeNull();
});

test('same-role re-login after expiry returns to the original business page', async ({ page }) => {
  await seedAuthSession(page, 'CUSTOMER');

  let modelsRequests = 0;
  let loginRequests = 0;
  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as GraphQLOperationPayload;

    if (payload.query?.includes('mutation LoginWithPassword')) {
      loginRequests += 1;
      return route.fulfill({
        body: JSON.stringify({
          data: {
            login: {
              accessToken: 'renewed-access-token',
              accountId: 900201,
              role: 'CUSTOMER',
              userInfo: {
                accessGroup: ['CUSTOMER'],
                nickname: '测试会话',
              },
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (payload.query?.includes('query EquipmentModels')) {
      modelsRequests += 1;
      // 首次型号查询命中失效；同角色重新登录后放行，验证返回原业务页。
      if (modelsRequests === 1) {
        return fulfillUnauthenticated(route);
      }

      return fulfillModelsSuccess(route);
    }

    // 任务 03：厂家候选查询返回就绪态（不参与失效计数），否则厂家下拉保持禁用
    if (payload.query?.includes('query RepairServiceOrganizationSearch')) {
      return fulfillServiceOrgsSuccess(route);
    }

    // 2026-09-29 整合工作台：左栏列表查询返回空页（不参与失效计数）
    if (payload.query?.includes('query MyRepairRequests')) {
      return fulfillMyRepairRequests(route, []);
    }

    return route.fulfill({ status: 500 });
  });

  await page.goto(CREATE_PAGE_PATH);
  await expect(page).toHaveURL(
    /\/login\?reason=session-expired&returnTo=%2Fcustomer%2Frepair-requests%2Fnew$/,
  );
  await expect(page.getByText('登录状态已失效，请重新登录')).toBeVisible();

  await page.getByLabel('账号或邮箱').fill('mock_customer_alpha');
  await page.getByLabel('密码').fill('test-only-password');
  await page.getByRole('button', { name: /登\s*录/ }).click();

  // 同角色重新登录后安全返回失效前记录的原业务页，不出现重复跳转或请求循环。
  await expect(page).toHaveURL(new RegExp(CREATE_PAGE_PATH));
  await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();
  expect(loginRequests).toBe(1);
  expect(modelsRequests).toBe(2);
});

test('business rejection keeps the form and shows the backend message', async ({ page }) => {
  await seedAuthSession(page, 'CUSTOMER');
  const getCreateCount = await routeGraphQL(page, (route) =>
    route.fulfill({
      body: JSON.stringify({
        errors: [
          {
            // 与后端真实 DomainError 输出对齐：码值见 domain-error.ts，文案见 create-repair-request.usecase.ts
            extensions: {
              code: 'NOT_FOUND',
              errorCode: 'REPAIR_REQUEST_EQUIPMENT_MODEL_NOT_FOUND',
              errorMessage: '设备型号不存在',
            },
            message: 'internal detail',
          },
        ],
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );

  await page.goto(CREATE_PAGE_PATH);
  await fillAndSubmitForm(page);

  await expect(page).toHaveURL(new RegExp(CREATE_PAGE_PATH));
  await expect(page.getByText('设备型号不存在')).toBeVisible();
  // 业务拒绝保留表单内容，便于修改后重试
  await expect(page.getByLabel('设备错误码')).toHaveValue('E-2001');
  expect(getCreateCount()).toBe(1);
});

test('client-side validation blocks empty submit without any request', async ({ page }) => {
  await seedAuthSession(page, 'CUSTOMER');

  let modelsRequests = 0;
  let serviceOrgRequests = 0;
  let listRequests = 0;
  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as GraphQLOperationPayload;

    if (payload.query?.includes('query EquipmentModels')) {
      modelsRequests += 1;
      await fulfillModelsSuccess(route);
      return;
    }

    if (payload.query?.includes('query RepairServiceOrganizationSearch')) {
      serviceOrgRequests += 1;
      await fulfillServiceOrgsSuccess(route);
      return;
    }

    if (payload.query?.includes('query MyRepairRequests')) {
      listRequests += 1;
      await fulfillMyRepairRequests(route, []);
      return;
    }

    await route.fulfill({ status: 500 });
  });

  await page.goto(CREATE_PAGE_PATH);
  await page.getByRole('button', { name: '提交申请' }).click();

  // 限定校验提示容器：避免与 Select 占位符同文案歧义（strict mode）
  await expect(
    page.locator('.ant-form-item-explain-error', { hasText: '请选择设备型号' }),
  ).toBeVisible();
  await expect(page.getByText('请选择维修厂家')).toBeVisible();
  await expect(page.getByText('请输入设备错误码')).toBeVisible();
  await expect(page.getByText('请输入故障描述')).toBeVisible();
  // 初始仅并行三笔查询（左栏列表 + 表单型号 + 任务 03 厂家候选），校验拦截不产生 Mutation
  expect(modelsRequests).toBe(1);
  expect(serviceOrgRequests).toBe(1);
  expect(listRequests).toBe(1);
});

test('double click sends exactly one mutation and shows the result', async ({ page }) => {
  await seedAuthSession(page, 'CUSTOMER');

  let releaseCreate: () => void = () => {};
  const createPending = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });

  const getCreateCount = await routeGraphQL(page, async (route) => {
    await createPending;
    await route.fulfill({
      body: JSON.stringify({
        data: {
          createRepairRequest: {
            createdAt: '2026-08-28T00:00:00.000Z',
            equipmentModelId: 900301,
            errorCode: 'E-2001',
            faultDescription: '曝光对准异常，需现场检修',
            id: 900401,
            isAccepted: false,
            requestNo: 'RR-2026-0001',
          },
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto(CREATE_PAGE_PATH);
  await page.getByRole('combobox').click();
  await page.getByText('光刻机 A（LS-100）').click();
  await page.getByLabel('维修厂家').click();
  await page.getByText('E2E 维修公司（E2E）').click();
  await page.getByLabel('设备错误码').fill('E-2001');
  await page.getByLabel('故障描述').fill('曝光对准异常，需现场检修');

  const submitButton = page.getByRole('button', { name: '提交申请' });
  await submitButton.click();
  await submitButton.click();

  releaseCreate();

  await expect(page.getByText('维修申请创建成功')).toBeVisible();
  await expect(page.getByText('申请编号：RR-2026-0001')).toBeVisible();
  expect(getCreateCount()).toBe(1);

  // T-05：创建成功页「查看维修申请」进入该申请详情路由（2026-09-29 整合裁定：不再回列表）；
  // 详情数据态不属本用例范围，仅断言导航目标 ID；数据流断言见 manage 系列 spec。
  await page.getByRole('button', { name: '查看维修申请' }).click();
  await expect(page).toHaveURL(/\/customer\/repair-requests\/900401$/);
});

// ---------- 提交期 transport 失败（区别于业务拒绝与 UNAUTHENTICATED 的第三条错误路径） ----------

test('transport failure on submit keeps the form and must not clear the session', async ({
  page,
}) => {
  await seedAuthSession(page, 'CUSTOMER');
  // abort 模拟网络中断：映射为 network 类型错误，不是会话失效
  const getCreateCount = await routeGraphQL(page, (route) => route.abort('failed'));

  await page.goto(CREATE_PAGE_PATH);
  await fillAndSubmitForm(page);

  await expect(page).toHaveURL(new RegExp(CREATE_PAGE_PATH));
  await expect(page.getByText('网络连接异常，请稍后重试。')).toBeVisible();
  // 与业务拒绝一致：保留表单内容便于重试；且只发了一次，无自动重试
  await expect(page.getByLabel('设备错误码')).toHaveValue('E-2001');
  expect(getCreateCount()).toBe(1);
  // transport 失败不得触发会话失效清理
  expect(await readStoredAuthSession(page)).not.toBeNull();
});

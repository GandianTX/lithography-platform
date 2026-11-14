// e2e-real/auth-admin-real.spec.ts
// 「登录 + 管理员用户管理」隔离库真实联调入口（PR6 S4）：专用后端 3100 + 专用前端 4174 +
// 独立 E2E 库 lithography_e2e，串行运行，不复用 127.0.0.1:3000 开发后端。
//
// 运行入口（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:auth-admin-real
// 需要调整真实 Token 有效期时，追加专用进程级覆盖（不改 .env、不伪造 Token）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_AUTH_ADMIN_JWT_EXPIRES_IN=45s npm run test:e2e:auth-admin-real
//
// 覆盖的真实场景（全部以 DOM / URL / 后端权威视图断言，不把截图或录像当作自动化断言）：
//   a. 三角色真实登录进入各自默认首页；管理员通过页面创建 ENGINEER / CUSTOMER，
//      核对角色单值三字段、状态 ACTIVE、刷新后列表一致；
//   b. 本轮专用普通账号停用后：不能登录、旧 Token 下一次真实受保护请求被拒、前端会话被清理
//      跳登录页；重新启用后新登录可访问受保护 Query；
//   c. 真实签发 Token 自然过期后，由真实受保护 Query 触发会话清理并回到登录页；
//   d. 负例：错误凭据真实登录被拒且不建立会话；专用后端与同源代理不可达时本组直接失败。
//
// 硬边界（沿用既有真实联调基建，不新增平行安全门）：
// - 环境前提不满足时**直接失败，不使用 test.skip 掩盖**（目标库 / 授权由 global-setup 与
//   webServer 的 reuseExistingServer:false 兜底；本文件内再加 API/SQL 同库与健康/代理探针）；
// - 本轮专用账号写入前必须通过 API/SQL 同库探针（assertApiSqlSameDatabase）；
// - 本轮自建账号一律使用数据库生成主键，清理绑定 accountId + 专用登录名双因子；
// - 创建响应一返回即**立即登记**精确 ID（早于任何后续查询 / 断言 / 弹窗关闭等待），后续步骤失败
//   不回滚登记；逐账号独立清理（某账号失败不阻断后续），删除错误与逐账号残留核对错误一并聚合
//   报告，主流程与清理同时失败时两类错误都保留（见 helper 的 registerCreatedDedicatedAccount /
//   cleanupRegisteredDedicatedAccounts / runWithCleanup）；
// - 不修改共享 Mock 账号的密码 / 状态 / 角色；共享管理员只用于合法管理与被拒保护验证；
// - 浏览器流量必须落在专用前端 / 专用后端来源，出现 127.0.0.1:3000 即判失败。

import { expect, type Page, test } from '@playwright/test';

import { readStoredAuthSession } from '../e2e/helpers/auth-session-seed';
import {
  assertApiSqlSameDatabase,
  cleanupRegisteredDedicatedAccounts,
  DEDICATED_LOGIN_NAME_PATTERN,
  preflightDedicatedAccountCleanup,
  readAccountCountByLoginName,
  registerCreatedDedicatedAccount,
  type RegisteredDedicatedAccount,
  runWithCleanup,
} from '../e2e/helpers/dedicated-account-cleanup';
import { assertBrowserRequestsBoundToDedicatedOrigins } from '../e2e/helpers/dedicated-real-link-assertions';
import {
  BACKEND_GRAPHQL,
  BACKEND_HEALTH,
  mysqlQuery,
  readBackendEnv,
  realGraphqlCall,
} from '../e2e/helpers/real-backend';

/** 管理员用户管理页路径（经主导航进入，不手工直达） */
const ADMIN_USERS_PATH = '/admin/users';

/** 创建用户初始密码：满足后端策略（8～128 位、含小写字母/数字/特殊字符、非黑名单弱密码） */
const CREATE_PASSWORD = 'E2eInit#2026Pass';

/** 专门的错误凭据（不得等于任何 Mock Seed 口令） */
const WRONG_PASSWORD = 'Wrong-Password#2026';

/** 登录页会话失效提示（与 features/auth-session 的固定文案一致，spec 内收敛为常量） */
const AUTH_SESSION_EXPIRED_NOTICE_MESSAGE = '登录状态已失效，请重新登录';

/** 错误凭据登录的固定安全文案（与 features/auth-session 的 login-error 契约一致） */
const INVALID_CREDENTIALS_MESSAGE = '账号或密码错误，请检查后重试。';

/** 真实 Token 自然过期场景允许的最长有效期：超过则直接失败并提示覆盖，避免用例无限等待 */
const MAX_NATURAL_EXPIRY_LIFETIME_MS = 90_000;

const LOGIN_ATTEMPT_MUTATION = `
  mutation LoginAttempt($input: AuthLoginInput!) {
    login(input: $input) {
      accessToken
    }
  }
`;

const MY_ACCOUNT_SETTINGS_QUERY = `
  query MyAccountSettings {
    myAccountSettings {
      loginName
      nickname
      role
      status
    }
  }
`;

const ADMIN_USERS_QUERY = `
  query AdminUsers($keyword: String, $pagination: PaginationArgs!) {
    adminUsers(keyword: $keyword, pagination: $pagination) {
      items {
        id
        loginName
        nickname
        role
        status
      }
      total
    }
  }
`;

const ADMIN_CREATE_USER_MUTATION = `
  mutation AdminCreateUser($input: AdminCreateUserInput!) {
    adminCreateUser(input: $input) {
      id
      loginName
      status
    }
  }
`;

const ADMIN_SET_USER_STATUS_MUTATION = `
  mutation AdminSetUserStatus($input: AdminSetUserStatusInput!) {
    adminSetUserStatus(input: $input) {
      id
    }
  }
`;

type MyAccountSettingsData = {
  loginName: string | null;
  nickname: string;
  role: string;
  status: string;
};

type AdminUserItem = {
  id: number;
  loginName: string | null;
  nickname: string;
  role: string;
  status: string;
};

type LoginAttemptResult = { accessToken: string | null; errorCode: string | null };

let dedicatedLoginNameCounter = 0;

/** 本轮专用登录名：命中专用账号白名单（e2e-pw-<12~16 位数字>），跨运行唯一 */
function buildDedicatedLoginName(): string {
  dedicatedLoginNameCounter += 1;
  const loginName = `e2e-pw-${Date.now()}${dedicatedLoginNameCounter}`;

  if (!DEDICATED_LOGIN_NAME_PATTERN.test(loginName)) {
    throw new Error(`专用登录名生成异常，拒绝使用：${loginName}`);
  }

  return loginName;
}

/** 真实 UI 登录并断言落到角色主页（与既有真实链路 spec 同一交互口径） */
async function loginViaUi(
  page: Page,
  loginName: string,
  password: string,
  homePath: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill(loginName);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(new RegExp(`${homePath}$`));
}

/** 经主导航进入用户管理页（走真实用户路径，不手工输入 URL） */
async function enterAdminUsersFromNav(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '用户管理' })
    .click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN_USERS_PATH}$`));
  await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
}

/** 在管理员列表主搜索框输入关键字（防抖后由列表应用，调用方负责等待行出现） */
async function searchAdminUser(page: Page, keyword: string): Promise<void> {
  await page.getByPlaceholder('搜索登录名 / 登录邮箱 / 昵称').fill(keyword);
}

/**
 * 通过创建弹窗创建一名普通用户（角色仅 ENGINEER / CUSTOMER）。
 *
 * 评审 P1：点击创建前先登记响应监听，adminCreateUser 成功响应一返回即解析数据库生成 ID 并
 * **立即**登记到本轮清理清单（返回登记项）——早于弹窗关闭等待与调用方任何后续查询 / 断言；
 * 即便本函数后续的 `expect(dialog).toBeHidden()` 或调用方后续步骤失败，精确 ID 也已进入清单。
 */
async function createUserViaPage(
  page: Page,
  input: { roleLabel: string; nickname: string; loginName: string; password: string },
  registry: RegisteredDedicatedAccount[],
): Promise<RegisteredDedicatedAccount> {
  await page.getByRole('button', { name: '创建用户' }).click();

  const dialog = page.getByRole('dialog');

  await expect(dialog).toBeVisible();
  // AntD Select 交互按仓库先例（engineer-repair-request-real / reference-document-real）：
  // 点击 label 不展开下拉，必须先点 combobox 打开下拉。这里必须用 `.ant-select-item-option`
  // （title 为中文标签）而非 getByRole('option')：AntD 6 的 role="option" 节点是零宽内部
  // 元素（实测 rect 宽为 0），Playwright 判为不可见并一直等待。
  await dialog.getByRole('combobox').click();
  await page
    .locator(`.ant-select-dropdown .ant-select-item-option[title="${input.roleLabel}"]`)
    .click();
  await dialog.getByLabel('昵称', { exact: true }).fill(input.nickname);
  await dialog.getByLabel('登录名（登录凭据之一）', { exact: true }).fill(input.loginName);
  await dialog.getByLabel('初始密码', { exact: true }).fill(input.password);
  await dialog.getByLabel('确认初始密码', { exact: true }).fill(input.password);
  // 点击创建前先登记响应监听：创建响应一返回即捕获精确 ID 并立即登记清理目标
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/graphql') &&
      response.request().method() === 'POST' &&
      (response.request().postData() ?? '').includes('adminCreateUser'),
  );

  // 弹窗底部确认按钮的可访问名是「创 建」：AntD 会在两个汉字间自动插空格
  //（与登录按钮 /登\s*录/ 同一现象），故不能用 exact: true 的「创建」。
  await dialog.getByRole('button', { name: /创\s*建/ }).click();

  const createResponse = await createResponsePromise;
  const createBody = (await createResponse.json().catch(() => null)) as unknown;
  const registered = registerCreatedDedicatedAccount(registry, createBody, input.loginName);

  await expect(dialog).toBeHidden();

  return registered;
}

/** Node 侧真实登录尝试：不抛错，返回是否拿到 Token 与首个错误大类（供负例断言用） */
async function attemptRealLogin(
  loginName: string,
  loginPassword: string,
): Promise<LoginAttemptResult> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({
      query: LOGIN_ATTEMPT_MUTATION,
      variables: { input: { audience: 'SSTSWEB', loginName, loginPassword, type: 'PASSWORD' } },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const body = (await response.json()) as {
    data?: { login?: { accessToken?: string } };
    errors?: Array<{ extensions?: { code?: string } }>;
  };

  return {
    accessToken: body.data?.login?.accessToken ?? null,
    errorCode: body.errors?.[0]?.extensions?.code ?? null,
  };
}

/** 以显式 Token 调用真实 GraphQL（用于旧 Token / 过期 Token 的下一次受保护请求断言） */
async function graphqlWithToken(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({ query, variables }),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    method: 'POST',
  });

  return { status: response.status, body: await response.json() };
}

function readFirstGraphqlErrorCode(body: unknown): string | null {
  const errors = (body as { errors?: Array<{ extensions?: { code?: string } }> }).errors;

  return errors?.[0]?.extensions?.code ?? null;
}

/** 读取浏览器唯一会话真源中的 Access Token（不存在或残留异常时返回 null） */
async function readStoredAccessToken(page: Page): Promise<string | null> {
  const raw = await readStoredAuthSession(page);

  if (raw === null) {
    return null;
  }

  const parsed = JSON.parse(raw) as { accessToken?: unknown };

  return typeof parsed.accessToken === 'string' ? parsed.accessToken : null;
}

/** 解码 JWT 的 exp / iat（仅读取声明用于推算自然过期时刻，不伪造任何 Token） */
function decodeJwtClaims(token: string): { exp: number | null; iat: number | null } {
  const segments = token.split('.');

  if (segments.length !== 3) {
    throw new Error('Access Token 不是合法 JWT 形态，无法读取声明');
  }

  const decoded = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf-8')) as {
    exp?: unknown;
    iat?: unknown;
  };

  return {
    exp: typeof decoded.exp === 'number' ? decoded.exp : null,
    iat: typeof decoded.iat === 'number' ? decoded.iat : null,
  };
}

function readMyAccountSettings(body: unknown): MyAccountSettingsData {
  const settings = (body as { data?: { myAccountSettings?: MyAccountSettingsData } }).data
    ?.myAccountSettings;

  if (!settings) {
    throw new Error(`myAccountSettings 未返回数据：${JSON.stringify(body).slice(0, 300)}`);
  }

  return settings;
}

/** 经真实管理员 API 读取指定登录名的用户行（以 keyword 精确收敛，取 loginName 全等的那条） */
async function readAdminUserByLoginName(
  env: Record<string, string>,
  loginName: string,
): Promise<AdminUserItem> {
  const { body } = await realGraphqlCall(
    env,
    ADMIN_USERS_QUERY,
    { keyword: loginName, pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true } },
    'mock_super_admin',
  );
  const items =
    (body as { data?: { adminUsers?: { items?: AdminUserItem[] } } }).data?.adminUsers?.items ?? [];
  const match = items.find((item) => item.loginName === loginName);

  if (!match) {
    throw new Error(`adminUsers 未返回账号 ${loginName}：${JSON.stringify(body).slice(0, 300)}`);
  }

  return match;
}

/** 经真实管理员 API 修改账号状态（Node helper 每次重新登录，不受短 TTL 影响） */
async function setUserStatusViaApi(
  env: Record<string, string>,
  accountId: number,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<void> {
  const { body } = await realGraphqlCall(
    env,
    ADMIN_SET_USER_STATUS_MUTATION,
    { input: { accountId, status } },
    'mock_super_admin',
  );

  if ((body as { errors?: unknown[] }).errors !== undefined) {
    throw new Error(`adminSetUserStatus(${status}) 失败：${JSON.stringify(body).slice(0, 300)}`);
  }
}

test.describe('auth & admin real backend flow（隔离库 lithography_e2e）', () => {
  test('三种角色真实登录进入各自默认首页，并能经主导航进入对应入口', async ({ browser }) => {
    // 三次真实登录 + 三次导航，串行门禁下需要独立预算
    test.setTimeout(90_000);
    const env = readBackendEnv();
    const roleCases = [
      { homePath: '/admin', loginName: 'mock_super_admin', seesUserManagement: true },
      { homePath: '/engineer', loginName: 'mock_engineer_chen', seesUserManagement: false },
      { homePath: '/customer', loginName: 'mock_customer_alpha', seesUserManagement: false },
    ] as const;

    for (const roleCase of roleCases) {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await loginViaUi(page, roleCase.loginName, env.MOCK_SEED_PASSWORD, roleCase.homePath);

        const nav = page.getByRole('navigation', { name: '主导航' });

        if (roleCase.seesUserManagement) {
          await enterAdminUsersFromNav(page);
        } else {
          // 非管理员看不到用户管理入口（权限展示镜像；后端仍是权限真源）
          await expect(nav.getByRole('link', { name: '用户管理' })).toHaveCount(0);
          await expect(nav.getByRole('link', { name: '账号设置' })).toBeVisible();
        }
      } finally {
        await context.close();
      }
    }
  });

  test('管理员通过页面创建 ENGINEER 与 CUSTOMER：角色字段正确、状态 ACTIVE、刷新后一致', async ({
    page,
  }) => {
    // 两次真实创建 + 两次刷新核对 + API/SQL 三字段核验，串行门禁下需要独立预算
    test.setTimeout(150_000);
    const env = readBackendEnv();
    const browserRequestUrls: string[] = [];

    page.on('request', (request) => browserRequestUrls.push(request.url()));

    // 预检失败直接硬失败（不再 skip 掩盖）；业务写入前先证明 API 与 SQL 指向同一 E2E 库
    preflightDedicatedAccountCleanup();
    await assertApiSqlSameDatabase(env);

    // 本轮登记的精确清理目标（创建响应一返回即登记，见 createUserViaPage / 评审 P1）
    const created: RegisteredDedicatedAccount[] = [];

    await runWithCleanup(
      async () => {
        await loginViaUi(page, 'mock_super_admin', env.MOCK_SEED_PASSWORD, '/admin');
        await enterAdminUsersFromNav(page);

        for (const roleCase of [
          { role: 'ENGINEER', roleLabel: '工程师' },
          { role: 'CUSTOMER', roleLabel: '客户' },
        ] as const) {
          const loginName = buildDedicatedLoginName();
          const nickname = `E2E 创建-${roleCase.role}-${Date.now()}`;

          // 创建辅助函数在 adminCreateUser 成功响应返回时立即登记精确 ID（早于弹窗关闭等待）
          const registered = await createUserViaPage(
            page,
            {
              loginName,
              nickname,
              password: CREATE_PASSWORD,
              roleLabel: roleCase.roleLabel,
            },
            created,
          );

          // 后端权威视图：角色 / 状态与页面展示同口径，且 ID 与创建响应登记一致
          const item = await readAdminUserByLoginName(env, loginName);

          expect(item.id).toBe(registered.id);
          expect(item.role).toBe(roleCase.role);
          expect(item.status).toBe('ACTIVE');

          await searchAdminUser(page, loginName);

          const row = page.getByRole('row').filter({ hasText: loginName });

          await expect(row).toBeVisible();
          await expect(row.getByText(roleCase.roleLabel)).toBeVisible();
          await expect(row.getByText('启用')).toBeVisible();

          // 刷新后列表数据保持一致：重新加载用户管理页并重新搜索，仍看到同一角色与状态
          await page.reload();
          await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
          await searchAdminUser(page, loginName);

          const reloadedRow = page.getByRole('row').filter({ hasText: loginName });

          await expect(reloadedRow).toBeVisible();
          await expect(reloadedRow.getByText(roleCase.roleLabel)).toBeVisible();
          await expect(reloadedRow.getByText('启用')).toBeVisible();

          // 单值角色三字段：identity_hint 单值、status / user_state 均为 ACTIVE、access_group 单角色
          expect(
            mysqlQuery(
              `SELECT identity_hint, status FROM base_user_account WHERE id = ${registered.id}`,
            ).split('\t'),
          ).toEqual([roleCase.role, 'ACTIVE']);

          const infoColumns = mysqlQuery(
            `SELECT user_state, access_group FROM base_user_info WHERE account_id = ${registered.id}`,
          ).split('\t');

          expect(infoColumns[0]).toBe('ACTIVE');
          expect(JSON.parse(infoColumns[1])).toEqual([roleCase.role]);
        }

        assertBrowserRequestsBoundToDedicatedOrigins(browserRequestUrls);
      },
      // 逐账号独立清理（某账号失败不阻断后续），删除错误与逐账号残留核对错误一并聚合报告
      () => cleanupRegisteredDedicatedAccounts(created),
    );

    // 无关哨兵数据保持不变：共享 Mock 账号在专用账号清理后仍各 1 行
    expect(readAccountCountByLoginName('mock_super_admin')).toBe(1);
    expect(readAccountCountByLoginName('mock_engineer_chen')).toBe(1);
    expect(readAccountCountByLoginName('mock_customer_alpha')).toBe(1);
  });

  test('专用普通账号停用后：不能登录、旧 Token 受保护请求被拒并清理前端会话；重新启用后可登录访问受保护 Query', async ({
    browser,
  }) => {
    // 创建 + 两次真实登录 + 停用/启用 + 会话清理跳转 + 数据级断言，串行门禁下需要独立预算
    test.setTimeout(180_000);
    const env = readBackendEnv();
    const browserRequestUrls: string[] = [];
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('request', (request) => browserRequestUrls.push(request.url()));

    preflightDedicatedAccountCleanup();
    await assertApiSqlSameDatabase(env);

    const loginName = buildDedicatedLoginName();
    // 本轮登记的精确清理目标（创建响应一返回即登记，见下）
    const created: RegisteredDedicatedAccount[] = [];

    await runWithCleanup(
      async () => {
        const createdResponse = await realGraphqlCall(
          env,
          ADMIN_CREATE_USER_MUTATION,
          {
            input: {
              initialPassword: CREATE_PASSWORD,
              loginName,
              nickname: 'E2E 停用联调账号',
              role: 'ENGINEER',
            },
          },
          'mock_super_admin',
        );

        // 创建响应成功即立即登记精确 ID，早于任何后续登录 / 停用 / 断言
        const accountId = registerCreatedDedicatedAccount(
          created,
          createdResponse.body,
          loginName,
        ).id;

        // 初始密码真实 UI 登录并读取会话 Token（旧 Token 的来源）
        await loginViaUi(page, loginName, CREATE_PASSWORD, '/engineer');

        const oldToken = await readStoredAccessToken(page);

        if (oldToken === null) {
          throw new Error('登录成功后未在唯一会话真源中找到 Access Token');
        }

        // 管理员停用该账号
        await setUserStatusViaApi(env, accountId, 'INACTIVE');

        // 1) 旧 Token 的下一次真实受保护请求被拒（无伪造 Token、无 route 拦截）
        const staleCall = await graphqlWithToken(oldToken, MY_ACCOUNT_SETTINGS_QUERY, {});

        expect(readFirstGraphqlErrorCode(staleCall.body)).toBe('UNAUTHENTICATED');

        // 2) 停用后账号不能重新登录
        const blockedLogin = await attemptRealLogin(loginName, CREATE_PASSWORD);

        expect(blockedLogin.accessToken).toBeNull();
        // 停用账户登录：后端 AUTH_ERROR.ACCOUNT_INACTIVE 经异常过滤器映射为 FORBIDDEN
        //（graphql-exception.filter.ts），不是 UNAUTHENTICATED
        expect(blockedLogin.errorCode).toBe('FORBIDDEN');

        // 3) 停用后前端不再持有可用会话：真实受保护页不可达，会话真源被清理。
        // 应用在旧 Token 的受保护请求被拒（UNAUTHENTICATED）时收敛一次失效周期：
        // 清理会话真源并跳登录页。清理可能由停用后 /engineer 页的受保护请求先触发
        // （走失败处理器，URL 带 reason=session-expired），也可能由本步重载受保护页时
        // 的路由守卫触发（URL 为 /login?returnTo=...）；两者都是合法收敛路径，故此处
        // 只断言「落到登录页 + 会话真源为空」，reason=session-expired 的精确形态由
        // 「真实 Token 自然过期」用例专门断言。
        await page.goto('/account/settings');
        await page.waitForURL(/\/login(\?|$)/, { timeout: 15_000 });
        await expect(page.getByLabel('账号或邮箱')).toBeVisible();
        expect(await readStoredAuthSession(page)).toBeNull();

        // 管理员重新启用
        await setUserStatusViaApi(env, accountId, 'ACTIVE');

        // 4) 重新启用后新登录可访问真实受保护 Query
        await loginViaUi(page, loginName, CREATE_PASSWORD, '/engineer');

        const freshToken = await readStoredAccessToken(page);

        if (freshToken === null) {
          throw new Error('重新启用后登录成功但未在唯一会话真源中找到 Access Token');
        }

        const freshCall = await graphqlWithToken(freshToken, MY_ACCOUNT_SETTINGS_QUERY, {});

        expect(readFirstGraphqlErrorCode(freshCall.body)).toBeNull();

        const freshSettings = readMyAccountSettings(freshCall.body);

        expect(freshSettings.loginName).toBe(loginName);
        expect(freshSettings.status).toBe('ACTIVE');

        assertBrowserRequestsBoundToDedicatedOrigins(browserRequestUrls);
      },
      // 收尾拆为两个独立步骤（最小修复计划）：账号清理失败也不阻断关闭；关闭失败不覆盖清理错误；
      // 主断言同时失败时三类错误全部保留并通过步骤标签区分（见 runWithCleanup 聚合语义）
      { label: '账号清理', run: () => cleanupRegisteredDedicatedAccounts(created) },
      { label: '关闭浏览器上下文', run: () => context.close() },
    );

    expect(readAccountCountByLoginName('mock_super_admin')).toBe(1);
  });

  test('真实签发 Token 自然过期后：受保护 Query 触发会话清理并回到登录页', async ({ page }) => {
    // 含真实登录 + 等待自然过期（默认 60s）+ 受保护页触发清理，需要独立预算
    test.setTimeout(150_000);
    const env = readBackendEnv();
    const loginName = 'mock_engineer_li';

    await loginViaUi(page, loginName, env.MOCK_SEED_PASSWORD, '/engineer');

    const token = await readStoredAccessToken(page);

    if (token === null) {
      throw new Error('登录成功后未在唯一会话真源中找到 Access Token');
    }

    const claims = decodeJwtClaims(token);

    if (claims.exp === null || claims.iat === null) {
      throw new Error('已签发 Access Token 缺少 exp / iat 声明，无法验证自然过期');
    }

    const lifetimeMs = claims.exp * 1000 - claims.iat * 1000;

    if (lifetimeMs > MAX_NATURAL_EXPIRY_LIFETIME_MS) {
      throw new Error(
        `Access Token 有效期约 ${Math.round(lifetimeMs / 1000)}s，超过本场景上限 ${Math.round(MAX_NATURAL_EXPIRY_LIFETIME_MS / 1000)}s：` +
          '请以 E2E_AUTH_ADMIN_JWT_EXPIRES_IN 覆盖为不超过 90s（默认 60s）后再运行，绝不改写 .env 或伪造 Token',
      );
    }

    // 先落在真实受保护页（此刻 Token 仍有效），保证最后一步有确定的受保护 Query 触发点
    await page.goto('/account/settings');
    await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();

    // 等到签名 Token 的自然过期时刻（+ 服务器时钟余量），不使用任何伪造 Token
    await page.waitForTimeout(Math.max(0, claims.exp * 1000 - Date.now()) + 2_000);

    // 过期后的真实受保护请求在 API 级被拒（TOKEN_EXPIRED → UNAUTHENTICATED）
    const expiredCall = await graphqlWithToken(token, MY_ACCOUNT_SETTINGS_QUERY, {});

    expect(readFirstGraphqlErrorCode(expiredCall.body)).toBe('UNAUTHENTICATED');

    // 前端重载受保护页 → 受保护 Query 失败 → 清理会话并跳登录页
    await page.reload();
    await page.waitForURL(/\/login\?reason=session-expired/, { timeout: 15_000 });
    await expect(page.getByText(AUTH_SESSION_EXPIRED_NOTICE_MESSAGE)).toBeVisible();
    expect(await readStoredAuthSession(page)).toBeNull();
  });

  test('负例：错误凭据真实登录被拒绝且不建立会话', async ({ page }) => {
    // API 级：真实登录被拒，不返回 Token
    const attempt = await attemptRealLogin('mock_customer_alpha', WRONG_PASSWORD);

    expect(attempt.accessToken).toBeNull();
    expect(attempt.errorCode).toBe('UNAUTHENTICATED');

    // 浏览器级：真实提交错误凭据后停留登录页、展示固定安全文案、且不建立会话（不做 skip）
    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_customer_alpha');
    await page.getByLabel('密码').fill(WRONG_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();

    await expect(page.getByRole('alert')).toContainText(INVALID_CREDENTIALS_MESSAGE);
    await expect(page).toHaveURL(/\/login$/);
    expect(await readStoredAuthSession(page)).toBeNull();
  });

  test('负例：专用后端与同源代理必须可达，否则本组直接失败（不使用 skip）', async ({
    page,
    request,
  }) => {
    // 专用后端健康检查：不可达即失败（绝不 skip 掩盖环境缺陷）
    const health = await request.get(BACKEND_HEALTH);

    expect(health.ok()).toBe(true);

    // 同源代理：浏览器从专用前端来源发出的 /graphql 必须被转发到专用后端并返回真实响应
    await page.goto('/login');

    const proxied = await page.evaluate(async () => {
      const response = await fetch('/graphql', {
        body: JSON.stringify({ query: '{ __typename }' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });

      return {
        body: (await response.json()) as { data?: { __typename?: string } },
        status: response.status,
      };
    });

    expect(proxied.status).toBe(200);
    expect(proxied.body.data?.__typename).toBe('Query');
  });
});

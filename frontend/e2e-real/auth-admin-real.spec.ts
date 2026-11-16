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
//   a. 三角色真实登录进入各自默认首页；管理员经真实 API 创建 ENGINEER / CUSTOMER（V6.4
//      08.4 起页面不再提供创建入口），页面列表核对角色与状态、刷新后一致，
//      并核对角色单值三字段、状态 ACTIVE；
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
//   不回滚登记；同一用例登记的多个账号作为**一个批次**清理：整批预检通过才允许首删，任一目标
//   不符或后序 DELETE 失败整批回滚（不会先提交前一个账号）；批次提交后才做事务外残留核对，
//   主流程与清理同时失败时两类错误都保留（见 helper 的 registerCreatedDedicatedAccount /
//   cleanupRegisteredDedicatedAccounts / runWithCleanup）；
// - 不修改共享 Mock 账号的密码 / 状态 / 角色；共享管理员只用于合法管理与被拒保护验证；
// - 浏览器流量必须落在专用前端 / 专用后端来源，出现 127.0.0.1:3000 即判失败。

import { expect, type Page, test } from '@playwright/test';

import { readStoredAuthSession } from '../e2e/helpers/auth-session-seed';
import {
  assertApiSqlSameDatabase,
  cleanupRegisteredDedicatedAccounts,
  DEDICATED_LOGIN_NAME_PATTERN,
  type DedicatedAccountRole,
  preflightDedicatedAccountCleanup,
  readAccountCountByLoginName,
  readActingOrganizationId,
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
  runGuardedFixtureWrite,
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
 * 经真实管理员 API 创建一名普通用户（角色仅 ENGINEER / CUSTOMER）。
 *
 * V6.4 08.4 起管理页不再提供创建入口，本用例只验证「创建后列表展示正确」，
 * 因此建号改走与页面同一条后端契约的真实 GraphQL 调用。
 * 创建响应一返回即解析数据库生成 ID 并**立即**登记到本轮清理清单（返回登记项），
 * 早于调用方任何后续查询 / 断言；即便后续步骤失败，精确 ID 也已进入清单。
 */
async function createUserViaApi(
  env: Record<string, string>,
  input: {
    role: DedicatedAccountRole;
    nickname: string;
    loginName: string;
    organizationId: number;
  },
  registry: RegisteredDedicatedAccount[],
): Promise<RegisteredDedicatedAccount> {
  const createdResponse = await realGraphqlCall(
    env,
    ADMIN_CREATE_USER_MUTATION,
    {
      input: {
        initialPassword: CREATE_PASSWORD,
        loginName: input.loginName,
        nickname: input.nickname,
        role: input.role,
      },
    },
    'mock_super_admin',
  );

  return registerCreatedDedicatedAccount(registry, createdResponse.body, {
    accessGroup: [input.role],
    loginName: input.loginName,
    nickname: input.nickname,
    organizationId: input.organizationId,
    role: input.role,
    userInfoEmail: null,
    userState: 'ACTIVE',
  });
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

/** 共享合成 seed 管理员：两例都要以其身份经真实 API 跨公司建号，因而都需要一级管理员等级 */
const SEED_ADMIN_LOGIN_NAME = 'mock_super_admin';

/**
 * 共享 seed 管理员等级状态：`originalLevel` 为运行前原值（NULL 以 `'NULL'` 表达），
 * `appliedLevel` 记录本轮是否真的写入了一级（null 表示运行前已是一级，无需复原）。
 */
type SeedAdminLevelState = {
  readonly accountId: number;
  readonly loginName: string;
  readonly originalLevel: string;
  readonly actingOrganizationId: number;
  appliedLevel: '1' | null;
};

/**
 * 读取共享 seed 管理员的账号事实（只读，不写任何夹具）：真实账号 ID、登录名、
 * 原始 admin_level（含 NULL）与本轮建号会用到的现有组织事实。
 *
 * 目标必须按登录名唯一命中，任何异常都失败关闭——后续等级写入只认这里核验过的账号。
 */
function readSeedAdminLevelState(): SeedAdminLevelState {
  const rows = mysqlQuery(
    `SELECT id, login_name, COALESCE(admin_level, 'NULL') FROM base_user_account WHERE login_name = '${SEED_ADMIN_LOGIN_NAME}'`,
  ).split('\n');

  if (rows.length !== 1) {
    throw new Error(
      `共享管理员 ${SEED_ADMIN_LOGIN_NAME} 账号行数异常（期望 1，实际 ${rows.length}），拒绝继续`,
    );
  }

  const [rawId, loginName, originalLevel] = rows[0].split('\t');
  const accountId = Number(rawId);

  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(`共享管理员账号 ID 异常，拒绝继续：${JSON.stringify(rawId)}`);
  }

  if (loginName !== SEED_ADMIN_LOGIN_NAME) {
    throw new Error(`共享管理员登录名回读不一致：${JSON.stringify(loginName)}`);
  }

  if (originalLevel !== 'NULL' && originalLevel !== '1' && originalLevel !== '2') {
    throw new Error(
      `共享管理员原始 admin_level 值异常，拒绝继续：${JSON.stringify(originalLevel)}`,
    );
  }

  return {
    accountId,
    loginName,
    originalLevel,
    actingOrganizationId: readActingOrganizationId(SEED_ADMIN_LOGIN_NAME),
    appliedLevel: null,
  };
}

/**
 * 建号前置：把已核验的共享 seed 管理员精确设成一级（二级会被目标归属拒绝，建号必然失败）。
 *
 * - 运行前已是一级：不写夹具，`appliedLevel` 保持 null，收尾步骤自然跳过复原；
 * - 否则按登录名精确写入（经 `runGuardedFixtureWrite` 的授权门 + 专用库门 + 实际
 *   `DATABASE()` 门），写入成功即先登记「已写入」事实，再回读账号 ID 与等级——
 *   这样即使后续回读校验抛错，收尾步骤仍会按原值复原，不会把等级留在改动后的状态。
 */
function prepareSeedAdminLevelOne(
  env: Record<string, string>,
  state: SeedAdminLevelState,
): SeedAdminLevelState {
  if (state.originalLevel === '1') {
    return state;
  }

  runGuardedFixtureWrite(
    env,
    `UPDATE base_user_account SET admin_level = 1 WHERE login_name = '${SEED_ADMIN_LOGIN_NAME}'`,
  );
  state.appliedLevel = '1';

  const rows = mysqlQuery(
    `SELECT id, COALESCE(admin_level, 'NULL') FROM base_user_account WHERE login_name = '${SEED_ADMIN_LOGIN_NAME}'`,
  ).split('\n');

  if (rows.length !== 1) {
    throw new Error(`一级写入后共享管理员账号行数异常（期望 1，实际 ${rows.length}）`);
  }

  const [rawId, level] = rows[0].split('\t');

  if (Number(rawId) !== state.accountId) {
    throw new Error(`一级写入后账号 ID 变化，拒绝继续：期望 ${state.accountId}，实际 ${rawId}`);
  }

  if (level !== '1') {
    throw new Error(`一级写入后回读等级不符，拒绝继续：${JSON.stringify(level)}`);
  }

  return state;
}

/**
 * 独立复原步骤：把共享 seed 管理员等级恢复为运行前原值（含 NULL）。
 *
 * 只在确有写入时执行。复原前先核对目标仍是同一账号、且仍是本轮写入的一级，
 * 避免覆盖掉别处的并发改动或误指向其它行；恢复后回读，等级必须回到原始值。
 */
function restoreSeedAdminLevel(env: Record<string, string>, state: SeedAdminLevelState): void {
  if (state.appliedLevel === null) {
    return;
  }

  const rows = mysqlQuery(
    `SELECT id, COALESCE(admin_level, 'NULL') FROM base_user_account WHERE login_name = '${SEED_ADMIN_LOGIN_NAME}'`,
  ).split('\n');

  if (rows.length !== 1) {
    throw new Error(`复原前共享管理员账号行数异常（期望 1，实际 ${rows.length}）`);
  }

  const [rawId, currentLevel] = rows[0].split('\t');

  if (Number(rawId) !== state.accountId) {
    throw new Error(`复原前账号 ID 已变化，拒绝覆盖：期望 ${state.accountId}，实际 ${rawId}`);
  }

  if (currentLevel !== '1') {
    throw new Error(`复原前等级不是本轮写入的一级，拒绝覆盖：${JSON.stringify(currentLevel)}`);
  }

  const restoreValue = state.originalLevel === 'NULL' ? 'NULL' : state.originalLevel;

  runGuardedFixtureWrite(
    env,
    `UPDATE base_user_account SET admin_level = ${restoreValue} WHERE login_name = '${SEED_ADMIN_LOGIN_NAME}'`,
  );

  const restoredLevel = mysqlQuery(
    `SELECT COALESCE(admin_level, 'NULL') FROM base_user_account WHERE login_name = '${SEED_ADMIN_LOGIN_NAME}'`,
  );

  if (restoredLevel !== state.originalLevel) {
    throw new Error(
      `等级复原回读不符：期望 ${state.originalLevel}，实际 ${JSON.stringify(restoredLevel)}`,
    );
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

  test('管理员经真实 API 创建 ENGINEER 与 CUSTOMER：页面列表角色与状态正确、刷新后一致', async ({
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

    // 本轮登记的精确清理目标（创建响应一返回即登记，见 createUserViaApi）
    const created: RegisteredDedicatedAccount[] = [];
    // 建号前置：先只读核验共享管理员账号与原始等级，实际设置一级放在用例体内、创建请求之前
    const seedAdmin = readSeedAdminLevelState();
    // adminCreateUser 会把 ENGINEER / CUSTOMER 绑定管理员当前有效组织，预期值取自该事实
    const actingOrganizationId = seedAdmin.actingOrganizationId;

    await runWithCleanup(
      async () => {
        prepareSeedAdminLevelOne(env, seedAdmin);
        await loginViaUi(page, 'mock_super_admin', env.MOCK_SEED_PASSWORD, '/admin');
        await enterAdminUsersFromNav(page);

        for (const roleCase of [
          { role: 'ENGINEER', roleLabel: '工程师' },
          { role: 'CUSTOMER', roleLabel: '客户' },
        ] as const) {
          const loginName = buildDedicatedLoginName();
          const nickname = `E2E 创建-${roleCase.role}-${Date.now()}`;

          // 创建辅助函数在 adminCreateUser 成功响应返回时立即登记精确 ID
          const registered = await createUserViaApi(
            env,
            {
              loginName,
              nickname,
              organizationId: actingOrganizationId,
              role: roleCase.role,
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
      // 两个账号同批提交：整批预检通过才允许首删，任一目标不符或后序 DELETE 失败整批回滚
      () => cleanupRegisteredDedicatedAccounts(created),
      // 等级复原与账号清理互不依赖：任一失败都不阻断另一步，主断言同时失败时错误全部保留
      { label: '恢复共享管理员等级', run: () => restoreSeedAdminLevel(env, seedAdmin) },
    );

    // 无关哨兵数据保持不变：共享 Mock 账号在专用账号清理后仍各 1 行，管理员等级回到运行前原值
    expect(readAccountCountByLoginName('mock_super_admin')).toBe(1);
    expect(readAccountCountByLoginName('mock_engineer_chen')).toBe(1);
    expect(readAccountCountByLoginName('mock_customer_alpha')).toBe(1);
    expect(readSeedAdminLevelState().originalLevel).toBe(seedAdmin.originalLevel);
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
    // 建号前置：先只读核验共享管理员账号与原始等级，实际设置一级放在用例体内、创建请求之前
    const seedAdmin = readSeedAdminLevelState();
    // adminCreateUser 会把该 ENGINEER 绑定管理员当前有效组织，预期值取自该事实
    const actingOrganizationId = seedAdmin.actingOrganizationId;

    await runWithCleanup(
      async () => {
        prepareSeedAdminLevelOne(env, seedAdmin);
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
        const accountId = registerCreatedDedicatedAccount(created, createdResponse.body, {
          accessGroup: ['ENGINEER'],
          loginName,
          nickname: 'E2E 停用联调账号',
          organizationId: actingOrganizationId,
          role: 'ENGINEER',
          userInfoEmail: null,
          userState: 'ACTIVE',
        }).id;

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
      // 收尾拆为三个独立步骤（最小修复计划 + 提审前收口）：任一步失败都不阻断其它步骤；
      // 主断言同时失败时全部错误保留并通过步骤标签区分（见 runWithCleanup 聚合语义）
      { label: '账号清理', run: () => cleanupRegisteredDedicatedAccounts(created) },
      { label: '恢复共享管理员等级', run: () => restoreSeedAdminLevel(env, seedAdmin) },
      { label: '关闭浏览器上下文', run: () => context.close() },
    );

    // 共享 Mock 管理员仍 1 行，且等级回到运行前原值
    expect(readAccountCountByLoginName('mock_super_admin')).toBe(1);
    expect(readSeedAdminLevelState().originalLevel).toBe(seedAdmin.originalLevel);
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

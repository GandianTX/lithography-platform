// e2e-real/admin-user-management-real.spec.ts
// 普通用户管理（任务 08 · S4）隔离库真实联调入口：专用后端 3100 + 专用前端 4174 +
// 独立 E2E 库（默认 lithography_e2e；本地可用 E2E_DEDICATED_DB_NAME 指向白名单库）。
//
// 运行方式（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 ADMIN_DEFAULT_RESET_PASSWORD='<合成默认密码>' \
//     npm run test:e2e:admin-user-management-real
// 若本机专用库不是默认 lithography_e2e，追加 E2E_DEDICATED_DB_NAME=<白名单库>。
//
// 覆盖：
//   1. 一级管理员：经主导航进入用户管理页，看到「全部公司」范围提示；跨公司看到 A/B 两家
//      公司的普通客户账号；对本公司外账号执行停用（查库核验 status），对另一账号执行
//      「重置为默认密码」（确认弹窗无密码字段；查库核验 must_change_password=1），
//      随后经真实 API 验证旧密码失败、默认密码只签发受限会话、业务入口被拒、改密后恢复。
//   2. 二级管理员：只看到本公司（可信公司）账号，外公司账号既不出现在列表也读不到；
//      本公司账号可重置为默认密码（UI），跨公司重置经真实 API 返回 NOT_FOUND 且不落写入。
//
// 权限与数据真源：等级由请求期查库得到的 `base_user_account.admin_level` 决定，
// 本 spec 只在专用隔离库内临时设置/恢复等级；普通账号经真实 `registerWeb`（CUSTOMER）
// 产生，清理以本轮登记的账号 / 组织实号为边界，删除前先核验登录名与组织编码。
//
// 截图证据写入 docs/plan/task08/visual/（S4 前缀，避免覆盖 S0/S2/S3 截图）。
// 工作区未提交时 `captureStableViewport` 的干净工作区门禁不成立，按 S2/S3 先例
// 使用 `prepareStableViewport()` + `page.screenshot()`，并已在 frontend/docs/testing.md 登记。

import { expect, type Page, test } from '@playwright/test';
import path from 'node:path';

import {
  assertPhysicalCleanupAllowed,
  BACKEND_GRAPHQL,
  mysqlQuery,
  readBackendEnv,
  realGraphqlCall,
  runGuardedFixtureWrite,
  runTeardownSteps,
  throwPrimaryAndTeardown,
} from '../e2e/helpers/real-backend';
import {
  cleanupRegistrationRound,
  createRegistrationRoundLedger,
  insertRegistrationRoundOrganization,
  readRegistrationRoundMembershipsByAccountId,
  readRegistrationRoundUserInfoByAccountId,
  registerRegistrationRoundAccount,
  registerRegistrationRoundMembership,
  registerRegistrationRoundUserInfo,
  type RegistrationRoundLedger,
  retainRegistrationRoundOrganization,
} from '../e2e/helpers/registration-round-cleanup';
import { prepareStableViewport } from '../e2e/helpers/visual-evidence';

/** 主导航入口与页面标题 */
const ADMIN_USERS_PATH = '/admin/users';
const ADMIN_USERS_LABEL = '用户管理';
const ADMIN_USERS_HEADING = '用户管理';

/** 一级 / 二级管理员使用的 seed 账号（密码来自 .env.e2e 的 MOCK_SEED_PASSWORD） */
const LEVEL_ONE_LOGIN = 'mock_super_admin';
const LEVEL_TWO_LOGIN = 'mock_admin_peer';

/** 二级管理员的可信公司（seed 同行隔离测试组织）：临时置为受管以满足 Web 客户注册资格 */
const LEVEL_TWO_ORGANIZATION_CODE = 'PEER_ALT';

/** 视觉证据目录（playwright 以 frontend 为 cwd） */
const VISUAL_DIR = path.resolve(process.cwd(), '../docs/plan/task08/visual');

/** 客户注册口令：满足后端密码策略（仅测试夹具使用） */
const FIXTURE_PASSWORD = 'E2eCustomer@2026';

/** 强制改密后用户自助设置的新密码 */
const AFTER_RESET_PASSWORD = 'E2eAfterReset@2026';

/** 后端固定的重置成功提示（与 Usecase 单一持有文案逐字一致） */
const RESET_TO_DEFAULT_NOTICE =
  '密码已重置为默认密码，目标用户下次登录必须修改密码；已签发的登录态不会立即失效，将在 Access Token 过期后自然退出';

const REGISTER_CUSTOMER_MUTATION = `
  mutation RegisterCustomer($input: RegisterWebInput!) {
    register: registerWeb(input: $input) {
      success
      message
      accountId
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

const ADMIN_RESET_TO_DEFAULT_MUTATION = `
  mutation AdminResetUserPasswordToDefault($input: AdminResetUserPasswordToDefaultInput!) {
    adminResetUserPasswordToDefault(input: $input) {
      accountId
      isUpdated
      notice
    }
  }
`;

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) {
      accessToken
      restriction
    }
  }
`;

const CHANGE_MY_PASSWORD_MUTATION = `
  mutation ChangeMyPassword($input: ChangeMyPasswordInput!) {
    changeMyPassword(input: $input) {
      isUpdated
      notice
    }
  }
`;

const USER_INFO_QUERY = `
  query UserInfo($accountId: Int!) {
    userInfo(accountId: $accountId) {
      nickname
    }
  }
`;

/** GraphQL 响应体的最小共享形状（本 spec 只关心错误大类与少量字段） */
type GqlBody<T> = {
  data?: T;
  errors?: Array<{ extensions?: { code?: string; errorCode?: string } }>;
};

type LoginPayload = { accessToken: string | null; restriction: string | null };

/** 本轮夹具台账由共享 helper 持有：清理只认登记的真实主键 */
let runCounter = 0;

/** 本轮唯一标识：登录名 / 邮箱 / 公司编码与名称共用同一后缀 */
function buildRunTag(): string {
  runCounter += 1;
  const tag = `${Date.now()}${runCounter}`;

  if (!/^\d{10,20}$/u.test(tag)) {
    throw new Error(`运行标识格式异常，拒绝使用：${tag}`);
  }

  return tag;
}

/** 默认重置密码由执行者显式注入；缺失即硬失败（不用 test.skip 掩盖） */
function requireDefaultResetPassword(): string {
  const value = process.env.ADMIN_DEFAULT_RESET_PASSWORD?.trim() ?? '';

  if (value === '') {
    throw new Error('必须显式设置 ADMIN_DEFAULT_RESET_PASSWORD 才能验证重置为默认密码的成功链路');
  }

  return value;
}

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

async function enterAdminUsersFromNav(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: ADMIN_USERS_LABEL })
    .click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN_USERS_PATH}$`));
  await expect(page.getByRole('heading', { name: ADMIN_USERS_HEADING })).toBeVisible();
}

/** 列表主搜索：防抖后由列表应用，调用方负责等待行出现 */
async function searchAdminUser(page: Page, keyword: string): Promise<void> {
  await page.getByPlaceholder('搜索登录名 / 登录邮箱 / 昵称').fill(keyword);
}

/** 读取单个 seed 账号的原始 admin_level（NULL 以字符串 NULL 返回，便于原样恢复） */
function readAdminLevel(loginName: string): string {
  return mysqlQuery(
    `SELECT COALESCE(admin_level, 'NULL') FROM base_user_account WHERE login_name = '${loginName}'`,
  );
}

/** 临时设置管理员等级（仅专用隔离库；SQL 值来自受控联合类型） */
function setAdminLevel(env: Record<string, string>, loginName: string, level: 1 | 2 | null): void {
  const value = level === null ? 'NULL' : String(level);

  runGuardedFixtureWrite(
    env,
    `UPDATE base_user_account SET admin_level = ${value} WHERE login_name = '${loginName}'`,
  );
}

/** 恢复等级：只接受原始值形态，避免把意外内容拼进 SQL */
function restoreAdminLevel(env: Record<string, string>, loginName: string, original: string): void {
  if (original !== 'NULL' && original !== '1' && original !== '2') {
    throw new Error(`原始 admin_level 值异常，拒绝恢复：${JSON.stringify(original)}`);
  }

  setAdminLevel(env, loginName, original === 'NULL' ? null : (Number(original) as 1 | 2));
}

/** 新建一家参与本轮用例的受管公司（Web 客户注册资格：ACTIVE + 受管） */
function createFixtureCompany(
  ledger: RegistrationRoundLedger,
  organizationCode: string,
  name: string,
): { id: number; organizationCode: string } {
  const id = insertRegistrationRoundOrganization(ledger, {
    isManagedCompany: true,
    kind: 'CLIENT',
    name,
    organizationCode,
  });

  return { id, organizationCode };
}

/** 客户注册在事务内即建成员关系：按真实 ID 回读资料与成员关系并登记 */
function registerFixtureCustomer(
  ledger: RegistrationRoundLedger,
  facts: { accountId: number; loginEmail: string; loginName: string },
): void {
  registerRegistrationRoundAccount(ledger, {
    id: facts.accountId,
    loginEmail: facts.loginEmail,
    loginName: facts.loginName,
  });
  registerRegistrationRoundUserInfo(
    ledger,
    readRegistrationRoundUserInfoByAccountId(facts.accountId),
  );

  for (const membership of readRegistrationRoundMembershipsByAccountId(facts.accountId)) {
    registerRegistrationRoundMembership(ledger, membership);
  }
}

/**
 * 经真实 Web 注册入口创建一名普通客户账号。
 *
 * 客户注册不签发会话，因此直接对专用后端发起匿名 GraphQL 请求；
 * 该入口在创建事务内即把账号开通为 ACTIVE 并绑定所选公司为 CUSTOMER 成员。
 */
async function registerCustomer(input: {
  loginEmail: string;
  loginName: string;
  nickname: string;
  organizationId: number;
}): Promise<number> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({
      query: REGISTER_CUSTOMER_MUTATION,
      variables: {
        input: {
          loginEmail: input.loginEmail,
          loginName: input.loginName,
          loginPassword: FIXTURE_PASSWORD,
          nickname: input.nickname,
          organizationId: input.organizationId,
          type: 'CUSTOMER',
        },
      },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const body = (await response.json()) as {
    data?: { register?: { success: boolean; message: string | null; accountId: number } };
    errors?: Array<{ message?: string }>;
  };
  const payload = body.data?.register;

  if (!payload || !payload.success) {
    throw new Error(`客户注册未成功：${JSON.stringify(body)}`);
  }

  return payload.accountId;
}

/** 查库读取本轮普通账号的写入事实（状态 / 资料状态 / 强制改密标记 / 成员关系） */
function readCustomerFacts(accountId: number): {
  accountStatus: string;
  mustChangePassword: string;
  membership: string;
  userState: string;
} {
  const row = mysqlQuery(
    `SELECT a.status, i.user_state, a.must_change_password,
            COALESCE((SELECT CONCAT_WS('|', organization_id, member_role, status)
                        FROM organization_membership WHERE account_id = a.id LIMIT 1), '')
       FROM base_user_account a JOIN base_user_info i ON i.account_id = a.id
      WHERE a.id = ${accountId}`,
  );

  if (row === '') {
    throw new Error(`base_user_account / base_user_info 未返回账号 ${accountId} 的行`);
  }

  const [accountStatus, userState, mustChangePassword, membership] = row.split('\t');

  return { accountStatus, mustChangePassword, membership, userState };
}

function firstGraphqlError(body: unknown): { code: string | null; errorCode: string | null } {
  const error = (body as { errors?: Array<{ extensions?: { code?: string; errorCode?: string } }> })
    .errors?.[0];

  return {
    code: error?.extensions?.code ?? null,
    errorCode: error?.extensions?.errorCode ?? null,
  };
}

/** 后端登录入口：返回是否拿到 Token、会话限制与错误大类（负例断言用，不抛错） */
async function attemptLogin(
  loginName: string,
  loginPassword: string,
  allowRestrictedSession = false,
): Promise<GqlBody<{ login?: LoginPayload }>> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({
      query: LOGIN_MUTATION,
      variables: {
        input: {
          allowRestrictedSession,
          audience: 'SSTSWEB',
          loginName,
          loginPassword,
          type: 'PASSWORD',
        },
      },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  return (await response.json()) as GqlBody<{ login?: LoginPayload }>;
}

async function graphqlWithToken<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GqlBody<T>> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({ query, variables }),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    method: 'POST',
  });

  return (await response.json()) as GqlBody<T>;
}

/** 当前唯一可见弹窗：关闭后的弹窗仍留在 DOM，必须按 :visible 收敛 */
function visibleDialog(page: Page) {
  return page.locator('[role="dialog"]:visible');
}

async function captureScreenshots(
  page: Page,
  fileNamePrefix: string,
  viewports: ReadonlyArray<{ height: number; width: number }> = [
    { height: 900, width: 1440 },
    { height: 768, width: 1366 },
    { height: 844, width: 390 },
  ],
): Promise<void> {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const fileName = `${fileNamePrefix}-${viewport.width}x${viewport.height}.png`;
    // S4 检查轮预提交证据：工作区尚未提交，captureStableViewport 的干净工作区断言
    // 不成立，按 frontend/docs/testing.md 登记表使用稳定前置 + 直接截图。
    await prepareStableViewport(page, fileName);
    await page.screenshot({ path: path.join(VISUAL_DIR, fileName) });
  }
}

/**
 * 在页面上把目标账号停用：打开启停弹窗、选择「停用」、截图后确认。
 * 截图带上目标昵称，便于人工核对弹窗确实对应被操作的那一行。
 */
async function suspendViaUi(page: Page, nickname: string, screenshotPrefix: string): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: nickname });

  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '启停' }).click();

  const dialog = visibleDialog(page);

  await expect(dialog.getByText(`启用 / 停用：${nickname}`)).toBeVisible();
  await dialog.getByRole('radio', { name: '停用' }).click();

  await captureScreenshots(page, screenshotPrefix);
  await page.setViewportSize({ height: 900, width: 1440 });

  await dialog.getByRole('button', { name: /^确\s*认$/ }).click();

  await expect(page.getByText('状态已修改。')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(row.getByText('停用')).toBeVisible();
}

/**
 * 在页面上把目标账号重置为系统默认密码：确认弹窗不收集任何密码字段，
 * 回包只展示后端固定安全提示。
 */
async function resetPasswordViaUi(
  page: Page,
  target: { accountId: number; nickname: string },
  defaultResetPassword: string,
  screenshotPrefix: string,
): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: target.nickname });

  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '重置密码' }).click();

  const dialog = visibleDialog(page);

  await expect(dialog.getByText(`重置密码：${target.nickname}`)).toBeVisible();
  await expect(
    dialog.getByText(`目标账号：${target.nickname}（账号 ID：${target.accountId}）。`),
  ).toBeVisible();
  // 客户端不能指定新密码：确认弹窗里没有任何输入控件
  expect(await dialog.locator('input').count()).toBe(0);
  expect(await dialog.locator('textarea').count()).toBe(0);

  await captureScreenshots(page, screenshotPrefix);
  await page.setViewportSize({ height: 900, width: 1440 });

  const resetResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/graphql') &&
      response.request().method() === 'POST' &&
      (response.request().postData() ?? '').includes('AdminResetUserPasswordToDefault'),
  );

  await dialog.getByRole('button', { name: /重\s*置\s*为\s*默\s*认\s*密\s*码/ }).click();

  const resetResponse = await resetResponsePromise;
  const resetBody = (await resetResponse.json()) as {
    data?: {
      adminResetUserPasswordToDefault?: {
        accountId: number;
        isUpdated: boolean;
        notice: string;
      };
    };
    errors?: unknown[];
  };

  expect(resetBody.errors).toBeUndefined();
  // 运行期 GraphQL 会附加 __typename，按字段断言而不做整对象深比较
  const resetPayload = resetBody.data?.adminResetUserPasswordToDefault;

  expect(resetPayload?.accountId).toBe(target.accountId);
  expect(resetPayload?.isUpdated).toBe(true);
  expect(resetPayload?.notice).toBe(RESET_TO_DEFAULT_NOTICE);
  // 回包不得出现默认密码本身
  expect(JSON.stringify(resetBody)).not.toContain(defaultResetPassword);

  await expect(page.getByText(RESET_TO_DEFAULT_NOTICE)).toBeVisible();
  await expect(dialog).toBeHidden();
}

test.describe('普通用户管理（隔离库真实链路）', () => {
  test('一级管理员：跨公司可见、可停用与重置为默认密码，强制改密链路完整', async ({ page }) => {
    test.setTimeout(240_000);
    const env = readBackendEnv();
    const defaultResetPassword = requireDefaultResetPassword();

    assertPhysicalCleanupAllowed(env);

    const tag = buildRunTag();
    const ledger = createRegistrationRoundLedger();
    const originalAdminLevel = readAdminLevel(LEVEL_ONE_LOGIN);
    let primaryError: unknown = null;

    try {
      setAdminLevel(env, LEVEL_ONE_LOGIN, 1);

      const companyA = createFixtureCompany(ledger, `E2E_S4_ORG_A_${tag}`, `E2E S4 客户甲-${tag}`);
      const companyB = createFixtureCompany(ledger, `E2E_S4_ORG_B_${tag}`, `E2E S4 客户乙-${tag}`);

      const loginNameA = `e2es4a${tag}`;
      const nicknameA = `客户甲${tag}`;
      const loginEmailA = `e2e.s4a.${tag}@example.com`;
      const accountIdA = await registerCustomer({
        loginEmail: loginEmailA,
        loginName: loginNameA,
        nickname: nicknameA,
        organizationId: companyA.id,
      });

      registerFixtureCustomer(ledger, {
        accountId: accountIdA,
        loginEmail: loginEmailA,
        loginName: loginNameA,
      });

      const loginNameB = `e2es4b${tag}`;
      const nicknameB = `客户乙${tag}`;
      const loginEmailB = `e2e.s4b.${tag}@example.com`;
      const accountIdB = await registerCustomer({
        loginEmail: loginEmailB,
        loginName: loginNameB,
        nickname: nicknameB,
        organizationId: companyB.id,
      });

      registerFixtureCustomer(ledger, {
        accountId: accountIdB,
        loginEmail: loginEmailB,
        loginName: loginNameB,
      });

      await loginViaUi(page, LEVEL_ONE_LOGIN, env.MOCK_SEED_PASSWORD, '/admin');
      await enterAdminUsersFromNav(page);

      // 等级 1：范围提示为全部公司（文案只是呈现，授权仍以服务端为准）
      await expect(page.getByText('当前账号可查看并管理全部公司的普通用户账号。')).toBeVisible();
      // V6.4 08.4 不允许的入口一律不出现在页面上
      await expect(page.getByRole('button', { name: '创建用户' })).toHaveCount(0);

      await searchAdminUser(page, loginNameA);
      const rowA = page.getByRole('row').filter({ hasText: loginNameA });

      await expect(rowA).toBeVisible();
      // 角色 / 状态列小且与昵称同含中文字符，必须精确匹配，避免命中昵称片段
      await expect(rowA.getByText('客户', { exact: true })).toBeVisible();
      await expect(rowA.getByText('启用', { exact: true })).toBeVisible();
      // 行内账号 ID 与本轮登记一致，确认命中的是精确账号而非同名片段
      await expect(rowA.getByText(`账号 ID：${accountIdA}`)).toBeVisible();

      await searchAdminUser(page, loginNameB);
      const rowB = page.getByRole('row').filter({ hasText: loginNameB });

      await expect(rowB).toBeVisible();
      await expect(rowB.getByText(`账号 ID：${accountIdB}`)).toBeVisible();

      // 列表证据：清空搜索后覆盖三种视口
      await searchAdminUser(page, '');
      await expect(page.getByRole('table')).toBeVisible();
      await captureScreenshots(page, 's4-admin1-users-list');
      await page.setViewportSize({ height: 900, width: 1440 });

      // 停用 A 公司账号（一级管理员跨公司可写）
      await searchAdminUser(page, loginNameA);
      await suspendViaUi(page, nicknameA, 's4-admin1-status-dialog');

      const factsAfterSuspend = readCustomerFacts(accountIdA);

      expect(factsAfterSuspend.accountStatus).toBe('INACTIVE');
      // 双字段状态一致写入：账号状态与资料状态同为 INACTIVE
      expect(factsAfterSuspend.userState).toBe('INACTIVE');
      // 停用不删除业务历史：公司成员关系保持原样
      expect(factsAfterSuspend.membership).toBe(`${companyA.id}|CUSTOMER|ACTIVE`);

      // 重置 B 公司账号密码为默认密码（跨公司）
      await searchAdminUser(page, loginNameB);
      await resetPasswordViaUi(
        page,
        { accountId: accountIdB, nickname: nicknameB },
        defaultResetPassword,
        's4-admin1-reset-dialog',
      );

      expect(readCustomerFacts(accountIdB).mustChangePassword).toBe('1');

      // 真实 API 链路：旧密码立即失效（会话状态门禁先于密码校验，统一 FORBIDDEN）
      const staleLogin = await attemptLogin(loginNameB, FIXTURE_PASSWORD);

      expect(staleLogin.data?.login?.accessToken).toBeFalsy();
      expect(firstGraphqlError(staleLogin).code).toBe('FORBIDDEN');

      // 默认密码只能签发受限会话，且必须显式允许
      const restrictedLogin = await attemptLogin(loginNameB, defaultResetPassword, true);
      const restrictedToken = restrictedLogin.data?.login?.accessToken;

      expect(restrictedLogin.errors).toBeUndefined();
      expect(restrictedLogin.data?.login?.restriction).toBe('MUST_CHANGE_PASSWORD');
      expect(typeof restrictedToken).toBe('string');

      // 未完成改密前，业务入口必须被拒绝
      const rejected = await graphqlWithToken<{ userInfo?: unknown }>(
        restrictedToken as string,
        USER_INFO_QUERY,
        { accountId: accountIdB },
      );

      expect(rejected.data?.userInfo).toBeFalsy();
      expect(firstGraphqlError(rejected).code).toBe('FORBIDDEN');

      // 用户自助改密后恢复完整会话
      const changed = await graphqlWithToken<{ changeMyPassword?: { isUpdated: boolean } }>(
        restrictedToken as string,
        CHANGE_MY_PASSWORD_MUTATION,
        { input: { currentPassword: defaultResetPassword, newPassword: AFTER_RESET_PASSWORD } },
      );

      expect(changed.errors).toBeUndefined();
      expect(changed.data?.changeMyPassword?.isUpdated).toBe(true);
      expect(readCustomerFacts(accountIdB).mustChangePassword).toBe('0');

      const freshLogin = await attemptLogin(loginNameB, AFTER_RESET_PASSWORD);

      expect(freshLogin.errors).toBeUndefined();
      expect(freshLogin.data?.login?.restriction).toBe('NONE');
    } catch (error) {
      primaryError = error;
    } finally {
      throwPrimaryAndTeardown(
        primaryError,
        await runTeardownSteps([
          { label: '清理本轮台账', run: () => cleanupRegistrationRound(ledger) },
          {
            label: '恢复一级管理员等级',
            run: () => restoreAdminLevel(env, LEVEL_ONE_LOGIN, originalAdminLevel),
          },
        ]),
      );
    }

    // 清理后：本轮账号与公司均无残留
    expect(
      Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM base_user_account WHERE login_name IN ('e2es4a${tag}','e2es4b${tag}')`,
        ),
      ),
    ).toBe(0);
    expect(
      Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM organization
            WHERE organization_code IN ('E2E_S4_ORG_A_${tag}','E2E_S4_ORG_B_${tag}')`,
        ),
      ),
    ).toBe(0);
  });

  test('二级管理员：仅本公司可见；本公司可重置，跨公司重置返回 NOT_FOUND 且不落写入', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const env = readBackendEnv();
    const defaultResetPassword = requireDefaultResetPassword();

    assertPhysicalCleanupAllowed(env);

    const tag = buildRunTag();
    const ledger = createRegistrationRoundLedger();
    const originalAdminLevel = readAdminLevel(LEVEL_TWO_LOGIN);
    let primaryError: unknown = null;

    // 二级管理员的可信公司：seed 同行隔离测试组织，临时置为受管以满足 Web 客户注册资格
    const peerOrganizationId = Number(
      mysqlQuery(
        `SELECT id FROM organization WHERE organization_code = '${LEVEL_TWO_ORGANIZATION_CODE}'`,
      ),
    );

    if (!Number.isSafeInteger(peerOrganizationId) || peerOrganizationId <= 0) {
      throw new Error(`未找到二级管理员可信公司：${LEVEL_TWO_ORGANIZATION_CODE}`);
    }

    const originalManagedCompany = mysqlQuery(
      `SELECT is_managed_company FROM organization WHERE id = ${peerOrganizationId}`,
    );

    if (originalManagedCompany !== '0' && originalManagedCompany !== '1') {
      throw new Error(`原始 is_managed_company 值异常，拒绝改写：${originalManagedCompany}`);
    }

    try {
      setAdminLevel(env, LEVEL_TWO_LOGIN, 2);
      runGuardedFixtureWrite(
        env,
        `UPDATE organization SET is_managed_company = 1 WHERE id = ${peerOrganizationId}`,
      );

      // seed 可信公司只被本轮账号引用，不进入删除范围
      retainRegistrationRoundOrganization(ledger, peerOrganizationId);

      const foreignCompany = createFixtureCompany(
        ledger,
        `E2E_S4_ORG_C_${tag}`,
        `E2E S4 客户丙外公司-${tag}`,
      );

      const ownLoginName = `e2es4o${tag}`;
      const ownNickname = `客户丁${tag}`;
      const ownLoginEmail = `e2e.s4o.${tag}@example.com`;
      const ownAccountId = await registerCustomer({
        loginEmail: ownLoginEmail,
        loginName: ownLoginName,
        nickname: ownNickname,
        organizationId: peerOrganizationId,
      });

      registerFixtureCustomer(ledger, {
        accountId: ownAccountId,
        loginEmail: ownLoginEmail,
        loginName: ownLoginName,
      });

      const foreignLoginName = `e2es4f${tag}`;
      const foreignNickname = `客户戊${tag}`;
      const foreignLoginEmail = `e2e.s4f.${tag}@example.com`;
      const foreignAccountId = await registerCustomer({
        loginEmail: foreignLoginEmail,
        loginName: foreignLoginName,
        nickname: foreignNickname,
        organizationId: foreignCompany.id,
      });

      registerFixtureCustomer(ledger, {
        accountId: foreignAccountId,
        loginEmail: foreignLoginEmail,
        loginName: foreignLoginName,
      });

      await loginViaUi(page, LEVEL_TWO_LOGIN, env.MOCK_SEED_PASSWORD, '/admin');
      await enterAdminUsersFromNav(page);

      await expect(page.getByText('当前账号仅可查看并管理本公司的普通用户账号。')).toBeVisible();

      await searchAdminUser(page, ownLoginName);
      await expect(page.getByRole('row').filter({ hasText: ownLoginName })).toBeVisible();

      await searchAdminUser(page, foreignLoginName);
      await expect(page.getByRole('row').filter({ hasText: foreignLoginName })).toHaveCount(0);
      await expect(page.getByText('暂无用户数据。')).toBeVisible();

      // 列表证据：恢复本公司搜索后覆盖三种视口
      await searchAdminUser(page, ownLoginName);
      await expect(page.getByRole('row').filter({ hasText: ownLoginName })).toBeVisible();
      await captureScreenshots(page, 's4-admin2-users-list');
      await page.setViewportSize({ height: 900, width: 1440 });

      // 本公司账号可重置为默认密码
      await resetPasswordViaUi(
        page,
        { accountId: ownAccountId, nickname: ownNickname },
        defaultResetPassword,
        's4-admin2-reset-dialog',
      );

      expect(readCustomerFacts(ownAccountId).mustChangePassword).toBe('1');

      // 跨公司目标：服务端作用域先限域，二级重置统一 NOT_FOUND 且不落写入
      const crossCompanyReset = await realGraphqlCall(
        env,
        ADMIN_RESET_TO_DEFAULT_MUTATION,
        { input: { accountId: foreignAccountId } },
        LEVEL_TWO_LOGIN,
      );
      const crossError = firstGraphqlError(crossCompanyReset.body);

      expect(crossError.code).toBe('NOT_FOUND');
      expect(crossError.errorCode).toBe('ADMIN_USER_TARGET_NOT_FOUND');
      expect(readCustomerFacts(foreignAccountId).mustChangePassword).toBe('0');

      // 读面同样限域：keyword 精确命中也不得返回外公司账号
      const foreignListCall = await realGraphqlCall(
        env,
        ADMIN_USERS_QUERY,
        {
          keyword: foreignLoginName,
          pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
        },
        LEVEL_TWO_LOGIN,
      );
      const foreignListBody = foreignListCall.body as {
        data?: { adminUsers?: { items?: Array<{ loginName: string | null }>; total?: number } };
      };

      expect(foreignListBody.data?.adminUsers?.items ?? []).toEqual([]);
      expect(foreignListBody.data?.adminUsers?.total ?? 0).toBe(0);
    } catch (error) {
      primaryError = error;
    } finally {
      throwPrimaryAndTeardown(
        primaryError,
        await runTeardownSteps([
          { label: '清理本轮台账', run: () => cleanupRegistrationRound(ledger) },
          {
            label: '恢复可信公司受管标记',
            run: () => {
              const current = mysqlQuery(
                `SELECT is_managed_company FROM organization WHERE id = ${peerOrganizationId}`,
              );

              if (current !== originalManagedCompany) {
                runGuardedFixtureWrite(
                  env,
                  `UPDATE organization SET is_managed_company = ${originalManagedCompany} WHERE id = ${peerOrganizationId}`,
                );
              }
            },
          },
          {
            label: '恢复二级管理员等级',
            run: () => restoreAdminLevel(env, LEVEL_TWO_LOGIN, originalAdminLevel),
          },
        ]),
      );
    }

    // 清理后：本轮账号、公司均无残留；seed 公司受管标记恢复原值
    expect(
      Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM base_user_account WHERE login_name IN ('e2es4o${tag}','e2es4f${tag}')`,
        ),
      ),
    ).toBe(0);
    expect(
      Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM organization WHERE organization_code = 'E2E_S4_ORG_C_${tag}'`,
        ),
      ),
    ).toBe(0);
    expect(
      mysqlQuery(`SELECT is_managed_company FROM organization WHERE id = ${peerOrganizationId}`),
    ).toBe(originalManagedCompany);
  });
});

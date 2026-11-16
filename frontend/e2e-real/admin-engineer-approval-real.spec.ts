// e2e-real/admin-engineer-approval-real.spec.ts
// 工程师注册审批（任务 08 · S3）隔离库真实联调入口：专用后端 3100 + 专用前端 4174 +
// 独立 E2E 库（默认 lithography_e2e；本地可用 E2E_DEDICATED_DB_NAME 指向白名单库）。
//
// 运行方式（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:admin-engineer-approval-real
// 若本机专用库不是默认 lithography_e2e，追加 E2E_DEDICATED_DB_NAME=<白名单库>。
//
// 覆盖：
//   1. 一级管理员：经主导航进入审批页，看到作用域提示「全部公司」，跨公司看到并批准
//      本公司以外的待审申请；查库核验申请终态、审核人、账号/资料状态与成员关系落点。
//   2. 二级管理员：只看到本公司申请，跨公司申请不出现在队列；空拒绝原因被前端拦截
//      （不发起命令），填写原因后拒绝成功；跨公司详情经真实 API 返回 NOT_FOUND。
//
// 权限与数据真源：等级由请求期查库得到的 `base_user_account.admin_level` 决定，
// 本 spec 只在专用隔离库内临时设置/恢复等级、名受管标记，不触碰共享开发库；
// 待审申请经真实 `registerWeb` 产生，清理以本轮登记的实际账号 / 组织 ID 为边界，
// 删除前先核验台账与账外子行。
//
// 截图证据写入 docs/plan/task08/visual/（S3 前缀，避免覆盖 S0/S2 截图）。

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
  registerRegistrationRoundApplication,
  registerRegistrationRoundMembership,
  registerRegistrationRoundUserInfo,
  type RegistrationRoundLedger,
  retainRegistrationRoundOrganization,
} from '../e2e/helpers/registration-round-cleanup';
import { prepareStableViewport } from '../e2e/helpers/visual-evidence';

/** 主导航入口与页面标题 */
const ADMIN_APPROVALS_PATH = '/admin/engineer-registrations';
const ADMIN_APPROVALS_LABEL = '注册审批';
const ADMIN_APPROVALS_HEADING = '工程师注册审批';

/** 一级 / 二级管理员使用的 seed 账号（密码来自 .env.e2e 的 MOCK_SEED_PASSWORD） */
const LEVEL_ONE_LOGIN = 'mock_super_admin';
const LEVEL_TWO_LOGIN = 'mock_admin_peer';

/** 二级管理员的可信公司（seed 同行隔离测试组织）：临时置为受管以满足 Web 注册资格 */
const LEVEL_TWO_ORGANIZATION_CODE = 'PEER_ALT';

/** 视觉证据目录（playwright 以 frontend 为 cwd） */
const VISUAL_DIR = path.resolve(process.cwd(), '../docs/plan/task08/visual');

/** 工程师注册口令：满足后端密码策略，与既有 E2E 规格同口径（仅测试夹具使用） */
const FIXTURE_PASSWORD = 'E2eEngineer@2026';

const REGISTER_MUTATION = `
  mutation RegisterEngineer($input: RegisterWebInput!) {
    register: registerWeb(input: $input) {
      success
      message
      accountId
      registrationStatus
      applicationId
    }
  }
`;

const ADMIN_DETAIL_QUERY = `
  query AdminEngineerRegistrationDetail($applicationId: Int!) {
    adminEngineerRegistrationDetail(applicationId: $applicationId) {
      application { id organizationId status }
      organizationName
      applicant { id loginName nickname }
    }
  }
`;

type RegisterPayload = {
  success: boolean;
  message: string | null;
  accountId: number;
  applicationId: number | null;
  registrationStatus: string;
};

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

async function enterApprovalsFromNav(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: ADMIN_APPROVALS_LABEL })
    .click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN_APPROVALS_PATH}$`));
  await expect(page.getByRole('heading', { name: ADMIN_APPROVALS_HEADING })).toBeVisible();
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

/** 新建一家参与本轮审批的受管公司（Web 工程师注册资格：ACTIVE + 受管） */
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

/** 把真实注册响应回读到资料 / 成员关系，并连同账号、申请一起登记 */
function registerFixtureEngineer(
  ledger: RegistrationRoundLedger,
  facts: {
    accountId: number;
    applicationId: number;
    loginEmail: string;
    loginName: string;
  },
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
  syncFixtureMemberships(ledger, facts.accountId);
  registerRegistrationRoundApplication(ledger, {
    accountId: facts.accountId,
    id: facts.applicationId,
  });
}

/** 审批通过后新增的成员关系也必须按真实 ID 入账（已登记的跳过） */
function syncFixtureMemberships(ledger: RegistrationRoundLedger, accountId: number): void {
  for (const membership of readRegistrationRoundMembershipsByAccountId(accountId)) {
    if (!ledger.memberships.some((item) => item.id === membership.id)) {
      registerRegistrationRoundMembership(ledger, membership);
    }
  }
}

/**
 * 经真实公开注册入口创建一份工程师待审申请。
 *
 * 注册入口不签发会话，因此直接对专用后端发起匿名 GraphQL 请求，
 * 不借用管理员身份（避免把「管理员代建」误当成真实注册路径）。
 */
async function registerPendingEngineer(input: {
  applicationNote: string;
  loginEmail: string;
  loginName: string;
  nickname: string;
  organizationId: number;
  realName: string;
}): Promise<{ accountId: number; applicationId: number }> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({
      query: REGISTER_MUTATION,
      variables: {
        input: {
          applicationNote: input.applicationNote,
          loginEmail: input.loginEmail,
          loginName: input.loginName,
          loginPassword: FIXTURE_PASSWORD,
          nickname: input.nickname,
          organizationId: input.organizationId,
          phone: '13900001234',
          realName: input.realName,
          type: 'ENGINEER',
        },
      },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const body = (await response.json()) as {
    data?: { register?: RegisterPayload };
    errors?: Array<{ message?: string }>;
  };
  const payload = body.data?.register;

  if (!payload || !payload.success || !payload.applicationId) {
    throw new Error(`工程师注册未产生待审申请：${JSON.stringify(body)}`);
  }

  return { accountId: payload.accountId, applicationId: payload.applicationId };
}

function readApplicationRow(applicationId: number): {
  organizationId: number;
  reviewComment: string;
  reviewedByAccountId: number;
  status: string;
} {
  const row = mysqlQuery(
    `SELECT organization_id, status, COALESCE(reviewed_by_account_id, 0), COALESCE(review_comment, 'NULL')
       FROM engineer_registration_application WHERE id = ${applicationId}`,
  );

  if (row === '') {
    throw new Error(`engineer_registration_application 未返回 id=${applicationId} 的行`);
  }

  const [organizationId, status, reviewedByAccountId, reviewComment] = row.split('\t');

  return {
    organizationId: Number(organizationId),
    reviewComment,
    reviewedByAccountId: Number(reviewedByAccountId),
    status,
  };
}

function readAccountFlag(accountId: number): { accountStatus: string; userState: string } {
  const row = mysqlQuery(
    `SELECT a.status, i.user_state
       FROM base_user_account a JOIN base_user_info i ON i.account_id = a.id
      WHERE a.id = ${accountId}`,
  );

  if (row === '') {
    throw new Error(`base_user_account / base_user_info 未返回账号 ${accountId} 的行`);
  }

  const [accountStatus, userState] = row.split('\t');

  return { accountStatus, userState };
}

function readEngineerMembership(accountId: number): string {
  return mysqlQuery(
    `SELECT CONCAT_WS('|', organization_id, member_role, status)
       FROM organization_membership WHERE account_id = ${accountId}`,
  );
}

function firstGraphqlErrorCode(body: unknown): string | null {
  const errors = (body as { errors?: Array<{ extensions?: { code?: string } }> }).errors;

  return errors?.[0]?.extensions?.code ?? null;
}

/** 当前唯一可见弹窗：详情/拒绝弹窗关闭后仍留在 DOM，必须按 :visible 收敛 */
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
    // S3 检查轮预提交证据：工作区尚未提交，captureStableViewport 的干净工作区断言
    // 不成立，按 frontend/docs/testing.md 登记表使用稳定前置 + 直接截图。
    await prepareStableViewport(page, fileName);
    await page.screenshot({ path: path.join(VISUAL_DIR, fileName) });
  }
}

test.describe('工程师注册审批（隔离库真实链路）', () => {
  test('一级管理员：跨公司可见并批准，终态/成员关系/账号状态查库正确', async ({ page }) => {
    test.setTimeout(180_000);
    const env = readBackendEnv();

    assertPhysicalCleanupAllowed(env);

    const tag = buildRunTag();
    const ledger = createRegistrationRoundLedger();
    const originalAdminLevel = readAdminLevel(LEVEL_ONE_LOGIN);
    let primaryError: unknown = null;

    try {
      setAdminLevel(env, LEVEL_ONE_LOGIN, 1);

      const company = createFixtureCompany(ledger, `E2E_S3_ORG_A_${tag}`, `E2E S3 审批甲-${tag}`);

      const engineerLoginName = `e2es3a${tag}`;
      const engineerLoginEmail = `e2e.s3a.${tag}@example.com`;
      const registration = await registerPendingEngineer({
        applicationNote: `E2E S3 跨公司审批申请说明-${tag}`,
        loginEmail: engineerLoginEmail,
        loginName: engineerLoginName,
        nickname: `审批甲${tag}`,
        organizationId: company.id,
        realName: 'E2E 审批甲',
      });

      registerFixtureEngineer(ledger, {
        accountId: registration.accountId,
        applicationId: registration.applicationId,
        loginEmail: engineerLoginEmail,
        loginName: engineerLoginName,
      });

      await loginViaUi(page, LEVEL_ONE_LOGIN, env.MOCK_SEED_PASSWORD, '/admin');
      await enterApprovalsFromNav(page);

      // 等级 1：范围提示为全部公司（文案只是呈现，授权仍以服务端为准）
      await expect(page.getByText('当前账号可查看并审批全部公司的工程师注册申请。')).toBeVisible();

      const row = page.getByRole('row').filter({ hasText: `审批甲${tag}` });

      await expect(row).toBeVisible();
      await expect(row.getByText(`E2E S3 审批甲-${tag}`)).toBeVisible();
      await expect(row.getByText('待审核')).toBeVisible();

      await captureScreenshots(page, 's3-admin1-approvals-list');
      await page.setViewportSize({ height: 900, width: 1440 });

      // 详情：按主键单独读取，展示申请事实、真实姓名与目标公司
      await row.getByRole('button', { name: '详情' }).click();

      const detailDialog = visibleDialog(page);

      await expect(detailDialog.getByText(engineerLoginName)).toBeVisible();
      await expect(detailDialog.getByText('E2E 审批甲')).toBeVisible();
      await expect(detailDialog.getByText(`E2E S3 审批甲-${tag}`)).toBeVisible();
      await expect(detailDialog.getByText(`E2E S3 跨公司审批申请说明-${tag}`)).toBeVisible();
      await expect(detailDialog.getByText('待审核')).toBeVisible();

      await page.setViewportSize({ height: 900, width: 1440 });
      await prepareStableViewport(page, 's3-admin1-approvals-detail-1440x900.png');
      await page.screenshot({
        path: path.join(VISUAL_DIR, 's3-admin1-approvals-detail-1440x900.png'),
      });

      const reviewResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/graphql') &&
          response.request().method() === 'POST' &&
          (response.request().postData() ?? '').includes('ReviewEngineerRegistration'),
      );

      // 批准动作位于详情内，依据刚读取的同一申请详情与待审状态展示
      await detailDialog.getByRole('button', { name: /批\s*准/ }).click();

      const reviewResponse = await reviewResponsePromise;
      const reviewBody = (await reviewResponse.json()) as {
        errors?: unknown[];
      };

      expect(reviewBody.errors).toBeUndefined();
      // 审批通过会新建成员关系：必须在收尾前按真实 ID 入账
      syncFixtureMemberships(ledger, registration.accountId);
      await expect(page.getByText('该申请已通过审核。')).toBeVisible();
      await expect(row.getByText('已通过')).toBeVisible();
      await expect(detailDialog.getByText('已通过')).toBeVisible();
      await expect(detailDialog.getByRole('button', { name: /批\s*准/ })).toHaveCount(0);

      await detailDialog.getByRole('button', { name: /关\s*闭/ }).click();
      await expect(detailDialog).toBeHidden();

      // 查库核验：申请终态 + 审核人、账号/资料开通、成员关系写入申请目标公司
      const application = readApplicationRow(registration.applicationId);
      const adminAccountId = Number(
        mysqlQuery(`SELECT id FROM base_user_account WHERE login_name = '${LEVEL_ONE_LOGIN}'`),
      );

      expect(application.status).toBe('APPROVED');
      expect(application.organizationId).toBe(company.id);
      expect(application.reviewedByAccountId).toBe(adminAccountId);

      const accountFlags = readAccountFlag(registration.accountId);

      expect(accountFlags.accountStatus).toBe('ACTIVE');
      expect(accountFlags.userState).toBe('ACTIVE');
      expect(readEngineerMembership(registration.accountId)).toBe(`${company.id}|ENGINEER|ACTIVE`);
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
      Number(mysqlQuery(`SELECT COUNT(*) FROM base_user_account WHERE login_name LIKE 'e2es3a%'`)),
    ).toBe(0);
    expect(
      Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM organization WHERE organization_code LIKE 'E2E_S3_ORG_A_%'`,
        ),
      ),
    ).toBe(0);
  });

  test('二级管理员：仅本公司可见；空原因被拦截，填写后拒绝成功', async ({ page }) => {
    test.setTimeout(180_000);
    const env = readBackendEnv();

    assertPhysicalCleanupAllowed(env);

    const tag = buildRunTag();
    const ledger = createRegistrationRoundLedger();
    const originalAdminLevel = readAdminLevel(LEVEL_TWO_LOGIN);
    let primaryError: unknown = null;

    // 二级管理员的可信公司：seed 同行隔离测试组织，临时置为受管以满足 Web 注册资格
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

    let reviewRequestCount = 0;

    page.on('request', (request) => {
      if (
        request.url().includes('/graphql') &&
        (request.postData() ?? '').includes('ReviewEngineerRegistration')
      ) {
        reviewRequestCount += 1;
      }
    });

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
        `E2E_S3_ORG_B_${tag}`,
        `E2E S3 审批乙外公司-${tag}`,
      );

      // 本公司申请（应由二级管理员可见）与跨公司申请（不得出现）
      const ownLoginName = `e2es3o${tag}`;
      const ownLoginEmail = `e2e.s3o.${tag}@example.com`;
      const ownRegistration = await registerPendingEngineer({
        applicationNote: `E2E S3 本公司申请说明-${tag}`,
        loginEmail: ownLoginEmail,
        loginName: ownLoginName,
        nickname: `审批乙${tag}`,
        organizationId: peerOrganizationId,
        realName: 'E2E 审批乙',
      });

      registerFixtureEngineer(ledger, {
        accountId: ownRegistration.accountId,
        applicationId: ownRegistration.applicationId,
        loginEmail: ownLoginEmail,
        loginName: ownLoginName,
      });

      const foreignLoginName = `e2es3f${tag}`;
      const foreignLoginEmail = `e2e.s3f.${tag}@example.com`;
      const foreignRegistration = await registerPendingEngineer({
        applicationNote: `E2E S3 跨公司申请说明-${tag}`,
        loginEmail: foreignLoginEmail,
        loginName: foreignLoginName,
        nickname: `审批丙${tag}`,
        organizationId: foreignCompany.id,
        realName: 'E2E 审批丙',
      });

      registerFixtureEngineer(ledger, {
        accountId: foreignRegistration.accountId,
        applicationId: foreignRegistration.applicationId,
        loginEmail: foreignLoginEmail,
        loginName: foreignLoginName,
      });

      await loginViaUi(page, LEVEL_TWO_LOGIN, env.MOCK_SEED_PASSWORD, '/admin');
      await enterApprovalsFromNav(page);

      await expect(page.getByText('当前账号仅可查看并审批本公司的工程师注册申请。')).toBeVisible();

      const ownRow = page.getByRole('row').filter({ hasText: `审批乙${tag}` });

      await expect(ownRow).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: `审批丙${tag}` })).toHaveCount(0);

      await captureScreenshots(page, 's3-admin2-approvals-list');
      await page.setViewportSize({ height: 900, width: 1440 });

      // 跨公司详情：服务端作用域先限域，二级读外公司申请统一 NOT_FOUND
      const foreignDetail = await realGraphqlCall(
        env,
        ADMIN_DETAIL_QUERY,
        { applicationId: foreignRegistration.applicationId },
        LEVEL_TWO_LOGIN,
      );

      expect(firstGraphqlErrorCode(foreignDetail.body)).toBe('NOT_FOUND');

      // 拒绝动作位于详情内；详情与拒绝弹窗同时可见，按标题收敛弹窗
      await ownRow.getByRole('button', { name: '详情' }).click();

      const ownDetailDialog = page
        .locator('[role="dialog"]:visible')
        .filter({ hasText: `注册申请详情：审批乙${tag}` });

      await expect(ownDetailDialog.getByText('E2E 审批乙')).toBeVisible();
      await expect(ownDetailDialog.getByText('待审核')).toBeVisible();

      await ownDetailDialog.getByRole('button', { name: /拒\s*绝/ }).click();

      const rejectDialog = page
        .locator('[role="dialog"]:visible')
        .filter({ hasText: `拒绝申请：审批乙${tag}` });

      await expect(rejectDialog.getByText(`拒绝申请：审批乙${tag}`)).toBeVisible();
      await rejectDialog.getByRole('button', { name: /确认拒绝/ }).click();
      await expect(rejectDialog.getByText('请填写拒绝原因')).toBeVisible();
      expect(reviewRequestCount).toBe(0);

      await page.setViewportSize({ height: 900, width: 1440 });
      await prepareStableViewport(page, 's3-admin2-approvals-reject-dialog-1440x900.png');
      await page.screenshot({
        path: path.join(VISUAL_DIR, 's3-admin2-approvals-reject-dialog-1440x900.png'),
      });

      await rejectDialog.getByRole('textbox').fill(`E2E S3 拒绝原因-${tag}`);

      const rejectResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/graphql') &&
          response.request().method() === 'POST' &&
          (response.request().postData() ?? '').includes('ReviewEngineerRegistration'),
      );

      await rejectDialog.getByRole('button', { name: /确认拒绝/ }).click();

      const rejectResponse = await rejectResponsePromise;
      const rejectBody = (await rejectResponse.json()) as { errors?: unknown[] };

      expect(rejectBody.errors).toBeUndefined();
      expect(reviewRequestCount).toBe(1);
      await expect(rejectDialog).toBeHidden();
      await expect(page.getByText('该申请已拒绝。')).toBeVisible();
      await expect(ownRow.getByText('已拒绝')).toBeVisible();
      await expect(ownDetailDialog.getByText('已拒绝')).toBeVisible();
      await expect(ownDetailDialog.getByRole('button', { name: /拒\s*绝/ })).toHaveCount(0);

      await ownDetailDialog.getByRole('button', { name: /关\s*闭/ }).click();
      await expect(ownDetailDialog).toBeHidden();

      // 查库核验：拒绝终态与原因落库，账号保持待审（未开通），且无成员关系
      const application = readApplicationRow(ownRegistration.applicationId);

      expect(application.status).toBe('REJECTED');
      expect(application.organizationId).toBe(peerOrganizationId);
      expect(application.reviewComment).toBe(`E2E S3 拒绝原因-${tag}`);
      expect(readEngineerMembership(ownRegistration.accountId)).toBe('');
      expect(readAccountFlag(ownRegistration.accountId).accountStatus).not.toBe('ACTIVE');

      // 跨公司申请未被本次操作影响，仍为待审
      expect(readApplicationRow(foreignRegistration.applicationId).status).toBe('PENDING');
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
      Number(mysqlQuery(`SELECT COUNT(*) FROM base_user_account WHERE login_name LIKE 'e2es3o%'`)),
    ).toBe(0);
    expect(
      Number(mysqlQuery(`SELECT COUNT(*) FROM base_user_account WHERE login_name LIKE 'e2es3f%'`)),
    ).toBe(0);
    expect(
      Number(
        mysqlQuery(
          `SELECT COUNT(*) FROM organization WHERE organization_code LIKE 'E2E_S3_ORG_B_%'`,
        ),
      ),
    ).toBe(0);
    expect(
      mysqlQuery(`SELECT is_managed_company FROM organization WHERE id = ${peerOrganizationId}`),
    ).toBe(originalManagedCompany);
  });
});

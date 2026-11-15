// e2e-real/admin-companies-real.spec.ts
// 公司档案（任务 08 · S2）隔离库真实联调入口：专用后端 3100 + 专用前端 4174 +
// 独立 E2E 库（默认 lithography_e2e；本地可用 E2E_DEDICATED_DB_NAME 指向白名单库）。
//
// 运行方式（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:admin-companies-real
// 若本机专用库不是默认 lithography_e2e，追加 E2E_DEDICATED_DB_NAME=<白名单库>。
//
// 覆盖：
//   1. 一级管理员：经主导航进入公司档案，真实新增 → 详情回读 → 编辑（编号只读）；
//      新增/编辑前后按同一 ID 查库比对字段差集；清理后残留计数为 0，哨兵组织不变。
//   2. 二级管理员：只看到最小名称名单与只读提示，无新增/编辑/详情入口；
//      服务端 list / detail / create / update 一律 FORBIDDEN，名称名单仅 id/name 可用。
//
// 权限与数据真源：等级由请求期查库得到的 `base_user_account.admin_level` 决定，
// 本 spec 只在专用隔离库内临时设置/恢复等级与受管组织行，不触碰共享开发库；
// 清理以本轮生成的公司名称 + 编号前缀双条件为边界，且先核验后删除。
//
// 截图证据写入 docs/plan/task08/visual/（S2 前缀，避免覆盖 S0 原型截图）。

import { expect, type Page, test } from '@playwright/test';
import path from 'node:path';

import {
  assertPhysicalCleanupAllowed,
  mysqlQuery,
  readBackendEnv,
  realGraphqlCall,
  runGuardedFixtureWrite,
} from '../e2e/helpers/real-backend';
import { prepareStableViewport } from '../e2e/helpers/visual-evidence';

/** 主导航入口与页面标题 */
const ADMIN_COMPANIES_PATH = '/admin/companies';
const ADMIN_COMPANIES_LABEL = '公司档案';

/** 一级 / 二级管理员使用的 seed 账号（密码来自 .env.e2e 的 MOCK_SEED_PASSWORD） */
const LEVEL_ONE_LOGIN = 'mock_super_admin';
const LEVEL_TWO_LOGIN = 'mock_admin_peer';

/** 视觉证据目录（playwright 以 frontend 为 cwd） */
const VISUAL_DIR = path.resolve(process.cwd(), '../docs/plan/task08/visual');

/** seed 组织中的稳定哨兵：清理后必须原值不变 */
const SENTINEL_ORGANIZATION_CODE = 'CLIENT_DEFAULT';

const ADMIN_LIST_QUERY = `
  query AdminCompanyList($keyword: String, $pagination: PaginationArgs!) {
    adminOrganizationList(keyword: $keyword, pagination: $pagination) {
      items { id name organizationCode }
      total
    }
  }
`;

const ADMIN_DETAIL_QUERY = `
  query AdminCompanyDetail($organizationId: Int!) {
    adminOrganizationDetail(organizationId: $organizationId) {
      id
      name
    }
  }
`;

const ADMIN_CREATE_MUTATION = `
  mutation AdminCreateCompany($input: AdminCreateOrganizationInput!) {
    adminCreateOrganization(input: $input) {
      id
      organizationCode
      name
    }
  }
`;

const ADMIN_UPDATE_MUTATION = `
  mutation AdminUpdateCompany($input: AdminUpdateOrganizationInput!) {
    adminUpdateOrganization(input: $input) {
      id
      name
    }
  }
`;

const ADMIN_NAME_LIST_QUERY = `
  query AdminCompanyNameList($keyword: String, $pagination: PaginationArgs!) {
    adminOrganizationNameList(keyword: $keyword, pagination: $pagination) {
      items { id name }
      total
    }
  }
`;

type CreatedOrganization = { id: number; organizationCode: string; name: string };

let runCounter = 0;

/** 本轮唯一公司名：包含运行标识，避免与其他运行或共享数据同名 */
function buildCompanyName(): string {
  runCounter += 1;
  const name = `E2E 公司档案 S2-${Date.now()}-${runCounter}`;

  if (!/^[\w\s\u4e00-\u9fff-]+$/u.test(name)) {
    throw new Error(`公司名校验异常，拒绝使用：${name}`);
  }

  return name;
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

async function enterAdminCompaniesFromNav(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: ADMIN_COMPANIES_LABEL })
    .click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN_COMPANIES_PATH}$`));
  await expect(page.getByRole('heading', { name: ADMIN_COMPANIES_LABEL })).toBeVisible();
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

/** 读取指定公司行的关键字段（NULL 以字符串 NULL 返回） */
function readOrganizationRow(id: number): Record<string, string> {
  const row = mysqlQuery(
    `SELECT name, contact_name, is_service_provider, status, organization_code, is_managed_company, kind
       FROM organization WHERE id = ${id}`,
  );

  if (row === '') {
    throw new Error(`organization 未返回 id=${id} 的行`);
  }

  const [name, contactName, isServiceProvider, status, organizationCode, isManaged, kind] =
    row.split('\t');

  return {
    contactName,
    isManagedCompany: isManaged,
    isServiceProvider,
    kind,
    name,
    organizationCode,
    status,
  };
}

function readOrganizationCountByCode(code: string): number {
  return Number(
    mysqlQuery(`SELECT COUNT(*) FROM organization WHERE organization_code = '${code}'`),
  );
}

/** 清理本轮创建的公司：先核验名称与编号前缀，再按精确 ID 删除 */
function cleanupCreatedOrganization(
  env: Record<string, string>,
  organization: CreatedOrganization | null,
  fallbackName: string,
): void {
  if (organization === null) {
    // 创建响应未成功解析时，仍按本轮唯一名称收敛（编号前缀限定为服务端生成的受管编号）
    runGuardedFixtureWrite(
      env,
      `DELETE FROM organization WHERE name = '${fallbackName}' AND organization_code LIKE 'ADMIN_ORG_%'`,
    );
    return;
  }

  const row = readOrganizationRow(organization.id);

  if (row.name !== organization.name || !row.organizationCode.startsWith('ADMIN_ORG_')) {
    throw new Error(
      `清理前置核验失败：id=${organization.id} 的名称或编号前缀与创建响应不一致，拒绝删除`,
    );
  }

  runGuardedFixtureWrite(env, `DELETE FROM organization WHERE id = ${organization.id}`);
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
    // S2 检查轮预提交证据：工作区尚未提交，captureStableViewport 的干净工作区断言
    // 不成立，按 frontend/docs/testing.md 登记表使用稳定前置 + 直接截图。
    await prepareStableViewport(page, fileName);
    await page.screenshot({ path: path.join(VISUAL_DIR, fileName) });
  }
}

function firstGraphqlErrorCode(body: unknown): string | null {
  const errors = (body as { errors?: Array<{ extensions?: { code?: string } }> }).errors;

  return errors?.[0]?.extensions?.code ?? null;
}

/** 当前唯一可见弹窗：详情弹窗关闭后仍留在 DOM，必须按 :visible 收敛 */
function visibleDialog(page: Page) {
  return page.locator('[role="dialog"]:visible');
}

/** 二级管理员反向用例里可能被误创建的公司名（仅用于残留核验与兜底清理） */
const FORBIDDEN_CREATE_NAME = 'E2E 越权新增';

test.describe('公司档案（隔离库真实链路）', () => {
  test('一级管理员：新增 → 详情 → 编辑，按同一 ID 查库差异正确且清理无残留', async ({ page }) => {
    test.setTimeout(180_000);
    const env = readBackendEnv();

    assertPhysicalCleanupAllowed(env);

    const companyName = buildCompanyName();
    const originalAdminLevel = readAdminLevel(LEVEL_ONE_LOGIN);
    let created: CreatedOrganization | null = null;

    try {
      setAdminLevel(env, LEVEL_ONE_LOGIN, 1);

      await loginViaUi(page, LEVEL_ONE_LOGIN, env.MOCK_SEED_PASSWORD, '/admin');
      await enterAdminCompaniesFromNav(page);

      // 列表初始就绪：seed 组织经真实查询可见（antd 测量行也会占用 role=row，按内容收敛）
      await expect(page.getByRole('row').filter({ hasText: '甲方默认组织' })).toBeVisible();
      await captureScreenshots(page, 's2-admin1-companies-list');

      // 截图会把视口收窄到移动端，交互前回到桌面视口
      await page.setViewportSize({ height: 900, width: 1440 });

      // 新增：全称 + 电话必填，初设维修资格（状态默认启用且不可改）
      await page.getByRole('button', { name: /新增公司/ }).click();

      const createDialog = visibleDialog(page);

      await expect(createDialog).toBeVisible();
      await createDialog.getByLabel('公司全称', { exact: true }).fill(companyName);
      await createDialog.getByLabel('联系电话', { exact: true }).fill('13900008888');
      // 两个 Switch：公司启用（禁用）与提供维修服务
      await createDialog.getByRole('switch').nth(1).click();

      await page.setViewportSize({ height: 900, width: 1440 });
      await prepareStableViewport(page, 's2-admin1-companies-add-dialog-1440x900.png');
      await page.screenshot({
        path: path.join(VISUAL_DIR, 's2-admin1-companies-add-dialog-1440x900.png'),
      });

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/graphql') &&
          response.request().method() === 'POST' &&
          (response.request().postData() ?? '').includes('adminCreateOrganization'),
      );

      await createDialog.getByRole('button', { name: /创\s*建/ }).click();

      const createResponse = await createResponsePromise;
      const createBody = (await createResponse.json()) as {
        data?: { adminCreateOrganization?: CreatedOrganization };
      };
      const createdPayload = createBody.data?.adminCreateOrganization;

      if (!createdPayload) {
        throw new Error(`adminCreateOrganization 未返回落库结果：${JSON.stringify(createBody)}`);
      }

      created = createdPayload;

      await expect(createDialog).toBeHidden();

      // 服务端生成编号、受管归类与状态：查库核对初始落库事实
      const initial = readOrganizationRow(created.id);

      expect(initial.name).toBe(companyName);
      expect(initial.organizationCode).toBe(created.organizationCode);
      expect(initial.organizationCode.startsWith('ADMIN_ORG_')).toBe(true);
      expect(initial.isManagedCompany).toBe('1');
      expect(initial.kind).toBe('CLIENT');
      expect(initial.status).toBe('ACTIVE');
      expect(initial.isServiceProvider).toBe('1');
      expect(initial.contactName).toBe('NULL');

      // 列表刷新后按关键字收敛到本轮新增行
      await page.getByPlaceholder('搜索公司全称 / 编号 / 简称').fill(companyName);

      const row = page.getByRole('row').filter({ hasText: companyName });

      await expect(row).toBeVisible();
      await expect(row.getByText('是')).toBeVisible();

      // 详情：按主键单独读取，展示编号与受管事实
      await row.getByRole('button', { name: '详情' }).click();

      const detailDialog = visibleDialog(page);

      await expect(detailDialog.getByText(created.organizationCode)).toBeVisible();
      await expect(detailDialog.getByText('受管公司')).toBeVisible();
      await detailDialog.getByRole('button', { name: /关\s*闭/ }).click();
      await expect(detailDialog).toBeHidden();

      // 编辑：编号只读，只改联系人与维修资格
      await row.getByRole('button', { name: '编辑' }).click();

      const editDialog = visibleDialog(page);

      // 公司编号 Form.Item 没有 name，label 不与 input 关联，按字段顺序取首个输入框
      const codeInput = editDialog.locator('input').first();

      await expect(codeInput).toBeDisabled();
      await expect(codeInput).toHaveValue(created.organizationCode);
      await editDialog.getByLabel('联系人姓名', { exact: true }).fill('E2E 联系人');
      await editDialog.getByRole('switch').nth(1).click();

      await page.setViewportSize({ height: 900, width: 1440 });
      await prepareStableViewport(page, 's2-admin1-companies-edit-dialog-1440x900.png');
      await page.screenshot({
        path: path.join(VISUAL_DIR, 's2-admin1-companies-edit-dialog-1440x900.png'),
      });

      await editDialog.getByRole('button', { name: /保\s*存/ }).click();
      await expect(editDialog).toBeHidden();

      // 同一 ID 回读：仅联系人与维修资格变化，编号/受管/类别/状态保持
      const updated = readOrganizationRow(created.id);

      expect(updated.contactName).toBe('E2E 联系人');
      expect(updated.isServiceProvider).toBe('0');
      expect(updated.organizationCode).toBe(initial.organizationCode);
      expect(updated.isManagedCompany).toBe('1');
      expect(updated.kind).toBe('CLIENT');
      expect(updated.status).toBe('ACTIVE');

      await expect(row.getByText('E2E 联系人')).toBeVisible();
      await expect(row.getByText('否')).toBeVisible();
    } finally {
      cleanupCreatedOrganization(env, created, companyName);
      restoreAdminLevel(env, LEVEL_ONE_LOGIN, originalAdminLevel);
    }

    // 清理后：本轮公司与编号残留均为 0，seed 哨兵组织保持原值
    const residualCount =
      created === null
        ? Number(
            mysqlQuery(
              `SELECT COUNT(*) FROM organization WHERE name = '${companyName}' AND organization_code LIKE 'ADMIN_ORG_%'`,
            ),
          )
        : Number(mysqlQuery(`SELECT COUNT(*) FROM organization WHERE id = ${created.id}`));

    expect(residualCount).toBe(0);
    expect(readOrganizationCountByCode(SENTINEL_ORGANIZATION_CODE)).toBe(1);
  });

  test('二级管理员：只读名称名单；写入口与完整视图服务端一律拒绝', async ({ page }) => {
    test.setTimeout(150_000);
    const env = readBackendEnv();

    assertPhysicalCleanupAllowed(env);

    const originalAdminLevel = readAdminLevel(LEVEL_TWO_LOGIN);

    try {
      setAdminLevel(env, LEVEL_TWO_LOGIN, 2);

      await loginViaUi(page, LEVEL_TWO_LOGIN, env.MOCK_SEED_PASSWORD, '/admin');
      await enterAdminCompaniesFromNav(page);

      await expect(page.getByText('当前账号仅可查看公司名称名单。')).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '公司名称' })).toBeVisible();
      await expect(page.getByRole('button', { name: /新增公司/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /筛选/ })).toHaveCount(0);
      await expect(page.getByRole('columnheader', { name: '操作' })).toHaveCount(0);

      // 名称名单保留最小字段（只断言可见列存在，不把列名当字段契约）
      await expect(page.getByRole('row').filter({ hasText: '甲方默认组织' })).toBeVisible();
      await captureScreenshots(page, 's2-admin2-companies-list');

      // 服务端反向：完整视图 / 详情 / 新增 / 编辑对二级一律 FORBIDDEN
      const pagination = { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true };
      const forbiddenCases: ReadonlyArray<{
        readonly label: string;
        readonly query: string;
        readonly variables: Record<string, unknown>;
      }> = [
        { label: 'adminOrganizationList', query: ADMIN_LIST_QUERY, variables: { pagination } },
        {
          label: 'adminOrganizationDetail',
          query: ADMIN_DETAIL_QUERY,
          variables: { organizationId: 1 },
        },
        {
          label: 'adminCreateOrganization',
          query: ADMIN_CREATE_MUTATION,
          variables: { input: { contactPhone: '13900000000', name: FORBIDDEN_CREATE_NAME } },
        },
        {
          label: 'adminUpdateOrganization',
          query: ADMIN_UPDATE_MUTATION,
          variables: { input: { contactName: 'E2E 越权编辑', organizationId: 1 } },
        },
      ];

      for (const { label, query, variables } of forbiddenCases) {
        const { body } = await realGraphqlCall(env, query, variables, LEVEL_TWO_LOGIN);

        expect(firstGraphqlErrorCode(body), `${label} 应拒绝二级管理员`).toBe('FORBIDDEN');
      }

      // 名称名单仍可用，且只返回 id / name
      const names = await realGraphqlCall(
        env,
        ADMIN_NAME_LIST_QUERY,
        { pagination },
        LEVEL_TWO_LOGIN,
      );
      const nameItems = (
        names.body as { data?: { adminOrganizationNameList?: { items?: unknown[] } } }
      ).data?.adminOrganizationNameList?.items;

      expect(firstGraphqlErrorCode(names.body)).toBeNull();
      expect(Array.isArray(nameItems)).toBe(true);

      for (const item of nameItems ?? []) {
        expect(Object.keys(item as Record<string, unknown>).sort()).toEqual(['id', 'name']);
      }
    } finally {
      // 兜底：若越权新增未被拒绝而落下数据，按本轮唯一名称在专用库内删除
      runGuardedFixtureWrite(
        env,
        `DELETE FROM organization WHERE name = '${FORBIDDEN_CREATE_NAME}'`,
      );
      restoreAdminLevel(env, LEVEL_TWO_LOGIN, originalAdminLevel);
    }

    // 反向用例不得留下任何组织行
    expect(
      Number(
        mysqlQuery(`SELECT COUNT(*) FROM organization WHERE name = '${FORBIDDEN_CREATE_NAME}'`),
      ),
    ).toBe(0);
  });
});

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
// 清理边界只认「创建响应返回值 + 本轮请求事实」登记的精确主键：先按库内名称/编号
// 逐字段核验，再按主键删除。名称、编号前缀与固定测试名都不是删除授权；
// 创建响应丢失时只做只读诊断，绝不按名称猜测归属，也不删除未登记行。
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

/** 本轮登记的公司：只来自创建响应 + 本轮请求事实，不从库内回读补齐 */
type RegisteredOrganization = { id: number; organizationCode: string; name: string };

/** 清理前逐字段核验所需的最少归属事实 */
type RegisteredOrganizationFacts = Pick<RegisteredOrganization, 'id' | 'organizationCode' | 'name'>;

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

/**
 * 创建响应一返回就登记本轮公司。
 *
 * 只使用服务端返回值与本轮请求事实，不回读数据库补齐：后续断言失败时，
 * 清理仍能按精确主键执行，而不是退化成按名称/编号前缀删除。
 */
function registerCreatedOrganization(
  payload: RegisteredOrganization,
  expectedName: string,
): RegisteredOrganization {
  const { id, organizationCode, name } = payload;

  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `adminCreateOrganization 未返回可信主键，无法建立清理边界：${JSON.stringify(payload)}`,
    );
  }

  if (typeof organizationCode !== 'string' || organizationCode === '') {
    throw new Error(`adminCreateOrganization 未返回编号，无法核验归属：${JSON.stringify(payload)}`);
  }

  if (name !== expectedName) {
    throw new Error(
      `adminCreateOrganization 返回名称与本轮请求不一致，拒绝登记：${JSON.stringify(name)}`,
    );
  }

  return { id, organizationCode, name };
}

/** 拼接进 SQL 前的最小字面量白名单：排除单引号与反斜杠，并限制长度 */
function assertSafeSqlLiteral(value: string, label: string): void {
  if (!/^[^'\\]{1,4096}$/.test(value)) {
    throw new Error(`${label} 未通过 SQL 字面量白名单，拒绝拼接：${JSON.stringify(value)}`);
  }
}

function readOrganizationCountById(id: number): number {
  return Number(mysqlQuery(`SELECT COUNT(*) FROM organization WHERE id = ${id}`));
}

/** 直接插入夹具组织行（仅专用隔离库）：返回数据库分配的真实主键 */
function insertFixtureOrganization(
  env: Record<string, string>,
  params: {
    readonly name: string;
    readonly organizationCode: string;
    readonly isManagedCompany?: boolean;
  },
): number {
  assertSafeSqlLiteral(params.name, '夹具公司名称');
  assertSafeSqlLiteral(params.organizationCode, '夹具公司编号');

  const output = runGuardedFixtureWrite(
    env,
    'INSERT INTO organization (organization_code, name, kind, status, is_managed_company, is_service_provider)' +
      ` VALUES ('${params.organizationCode}', '${params.name}', 'CLIENT', 'ACTIVE', ${params.isManagedCompany === true ? 1 : 0}, 0);` +
      ' SELECT LAST_INSERT_ID();',
  );
  const id = Number(output);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`夹具组织行未返回可信主键，拒绝继续：${JSON.stringify(output)}`);
  }

  return id;
}

/** 插入一条 LEFT 成员关系作为「外部子行」（left_at 必填，避开单账号唯一有效成员约束） */
function insertExternalLeftMembership(
  env: Record<string, string>,
  params: { readonly organizationId: number; readonly accountId: number },
): number {
  const output = runGuardedFixtureWrite(
    env,
    'INSERT INTO organization_membership (organization_id, account_id, member_role, status, left_at)' +
      ` VALUES (${params.organizationId}, ${params.accountId}, 'CUSTOMER', 'LEFT', CURRENT_TIMESTAMP(3));` +
      ' SELECT LAST_INSERT_ID();',
  );
  const id = Number(output);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`外部子行未返回可信主键，拒绝继续：${JSON.stringify(output)}`);
  }

  return id;
}

/**
 * 按登记事实回收本轮公司：逐字段核验通过后才按主键 DELETE。
 *
 * 只有主键、名称与编号都与登记一致才可删除；硬编码名称、编号前缀与固定测试名
 * 都不构成所有权证据。核验失败或外键拒绝时保留行并抛错，不做降级删除。
 */
function deleteRegisteredOrganization(
  env: Record<string, string>,
  registered: RegisteredOrganizationFacts,
): void {
  const row = readOrganizationRow(registered.id);

  if (row.name !== registered.name || row.organizationCode !== registered.organizationCode) {
    throw new Error(
      `清理前置核验失败：id=${registered.id} 的库内名称/编号与登记事实不一致` +
        `（库内 name=${JSON.stringify(row.name)} code=${JSON.stringify(row.organizationCode)}），拒绝删除`,
    );
  }

  runGuardedFixtureWrite(env, `DELETE FROM organization WHERE id = ${registered.id}`);

  const remaining = readOrganizationCountById(registered.id);

  if (remaining !== 0) {
    throw new Error(`清理后仍残留 id=${registered.id} 的组织行 ${remaining} 条`);
  }
}

/** 哨兵行必须保持登记时的名称与编号（缺行同样视为被误删） */
function assertOrganizationRowUnchanged(registered: RegisteredOrganizationFacts): void {
  const row = readOrganizationRow(registered.id);

  if (row.name !== registered.name || row.organizationCode !== registered.organizationCode) {
    throw new Error(
      `哨兵组织被意外改写：id=${registered.id} 库内 name=${JSON.stringify(row.name)}` +
        ` code=${JSON.stringify(row.organizationCode)}`,
    );
  }
}

/** 响应丢失时的只读诊断：只回读本轮唯一名称命中的行，不删除、不认领 */
function readOrganizationDiagnosticsByName(name: string): string {
  assertSafeSqlLiteral(name, '诊断公司名称');

  return mysqlQuery(
    "SELECT CONCAT_WS('|', id, organization_code, status, is_managed_company, kind)" +
      ` FROM organization WHERE name = '${name}' ORDER BY id`,
  );
}

interface OrganizationSnapshotRow {
  readonly id: number;
  readonly name: string;
  readonly organizationCode: string;
  /** 除主键外的字段拼串，用于识别既有行是否被改写 */
  readonly fields: string;
}

/** 组织表全量快照（只读）：用于越权反例前后比对，任何新增/改写都必须可解释 */
function readOrganizationSnapshot(): OrganizationSnapshotRow[] {
  const output = mysqlQuery(
    "SELECT id, organization_code, name, COALESCE(contact_name, '<NULL>'), status, is_managed_company, is_service_provider, kind FROM organization ORDER BY id",
  );

  if (output === '') {
    return [];
  }

  return output.split('\n').map((line) => {
    const [
      idText,
      organizationCode,
      name,
      contactName,
      status,
      isManagedCompany,
      isServiceProvider,
      kind,
    ] = line.split('\t');

    return {
      fields: [
        organizationCode,
        name,
        contactName,
        status,
        isManagedCompany,
        isServiceProvider,
        kind,
      ].join('|'),
      id: Number(idText),
      name,
      organizationCode,
    };
  });
}

function diffOrganizationSnapshot(
  before: readonly OrganizationSnapshotRow[],
  after: readonly OrganizationSnapshotRow[],
): { readonly newRows: OrganizationSnapshotRow[]; readonly changedExistingIds: number[] } {
  const beforeFieldsById = new Map(before.map((row) => [row.id, row.fields]));

  return {
    changedExistingIds: after
      .filter((row) => beforeFieldsById.has(row.id) && beforeFieldsById.get(row.id) !== row.fields)
      .map((row) => row.id),
    newRows: after.filter((row) => !beforeFieldsById.has(row.id)),
  };
}

interface TeardownStep {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

/**
 * 收尾汇总：清理、状态复原与诊断各自独立执行，任一步失败都不跳过后续步骤，
 * 全部失败按序汇总后一次抛出，避免首个异常掩盖其余异常。
 */
async function runTeardownSteps(steps: readonly TeardownStep[]): Promise<Error | null> {
  const failures: string[] = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(`${step.label}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return failures.length === 0
    ? null
    : new Error(`异常收尾汇总（${failures.length} 项失败）：\n- ${failures.join('\n- ')}`);
}

/** 主流程错误与收尾错误同时存在时一并保留，不让收尾覆盖最初失败原因 */
function throwPrimaryAndTeardown(primary: unknown, teardown: Error | null): void {
  if (primary === null) {
    if (teardown !== null) {
      throw teardown;
    }
    return;
  }

  if (teardown === null) {
    throw primary;
  }

  const primaryMessage = primary instanceof Error ? primary.message : String(primary);

  throw new Error(`主流程失败：${primaryMessage}\n收尾失败：${teardown.message}`, {
    cause: primary,
  });
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

/** 二级越权用例的公司名：按运行唯一化，固定测试名不能作为删除或归属依据 */
function buildForbiddenCompanyName(): string {
  runCounter += 1;
  const name = `E2E 越权新增-${Date.now()}-${runCounter}`;

  if (!/^[\w\s\u4e00-\u9fff-]+$/u.test(name)) {
    throw new Error(`越权公司名校验异常，拒绝使用：${name}`);
  }

  return name;
}

test.describe('公司档案（隔离库真实链路）', () => {
  test('一级管理员：新增 → 详情 → 编辑，按同一 ID 查库差异正确且清理无残留', async ({ page }) => {
    test.setTimeout(180_000);
    const env = readBackendEnv();

    assertPhysicalCleanupAllowed(env);

    const companyName = buildCompanyName();
    const originalAdminLevel = readAdminLevel(LEVEL_ONE_LOGIN);
    let created: RegisteredOrganization | null = null;
    let primaryError: unknown = null;

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
        data?: { adminCreateOrganization?: RegisteredOrganization };
      };
      const createdPayload = createBody.data?.adminCreateOrganization;

      if (!createdPayload) {
        throw new Error(`adminCreateOrganization 未返回落库结果：${JSON.stringify(createBody)}`);
      }

      // 创建响应一返回就登记真实主键与请求事实：后续任何断言失败仍可按精确主键回收
      created = registerCreatedOrganization(createdPayload, companyName);

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
    } catch (error) {
      primaryError = error;
    }

    const teardownError = await runTeardownSteps([
      {
        label: created === null ? '未登记创建结果的只读诊断' : '按登记事实回收本轮公司',
        run: () => {
          if (created !== null) {
            deleteRegisteredOrganization(env, created);
            return;
          }

          // 响应丢失时只回读本轮唯一名称命中的行；名称相同不构成所有权证据，拒绝删除
          const diagnostic = readOrganizationDiagnosticsByName(companyName);

          if (diagnostic !== '') {
            throw new Error(
              '本轮未取得可信创建结果，但库内存在同名组织行；' +
                `只读诊断如下，拒绝按名称删除并保留待人工核对：${diagnostic}`,
            );
          }
        },
      },
      {
        label: '恢复一级管理员等级',
        run: () => restoreAdminLevel(env, LEVEL_ONE_LOGIN, originalAdminLevel),
      },
    ]);

    throwPrimaryAndTeardown(primaryError, teardownError);

    const registered = created;

    if (registered === null) {
      throw new Error('本轮没有登记到公司主键，无法核验清理残留');
    }

    // 清理后：本轮登记的精确主键残留为 0，seed 哨兵组织保持原值
    expect(readOrganizationCountById(registered.id)).toBe(0);
    expect(readOrganizationCountByCode(SENTINEL_ORGANIZATION_CODE)).toBe(1);
  });

  test('二级管理员：只读名称名单；写入口与完整视图服务端一律拒绝', async ({ page }) => {
    test.setTimeout(150_000);
    const env = readBackendEnv();

    assertPhysicalCleanupAllowed(env);

    const originalAdminLevel = readAdminLevel(LEVEL_TWO_LOGIN);
    // 固定测试名不是所有权证据：本轮越权名称按运行唯一化，并前置一条同名外部哨兵
    const forbiddenName = buildForbiddenCompanyName();
    const forbiddenSentinelCode = `E2E_SENTINEL_FORBIDDEN_${Date.now()}`;
    const forbiddenSentinel: RegisteredOrganizationFacts = {
      id: insertFixtureOrganization(env, {
        name: forbiddenName,
        organizationCode: forbiddenSentinelCode,
      }),
      name: forbiddenName,
      organizationCode: forbiddenSentinelCode,
    };
    const beforeSnapshot = readOrganizationSnapshot();
    const unexpectedOrganizations: RegisteredOrganizationFacts[] = [];
    let primaryError: unknown = null;

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
          variables: { input: { contactPhone: '13900000000', name: forbiddenName } },
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
    } catch (error) {
      primaryError = error;
    }

    const teardownError = await runTeardownSteps([
      {
        label: '比对越权前后组织集合并登记意外写入',
        run: () => {
          const { newRows, changedExistingIds } = diffOrganizationSnapshot(
            beforeSnapshot,
            readOrganizationSnapshot(),
          );

          if (changedExistingIds.length > 0) {
            throw new Error(
              `越权反例期间既有组织行发生变化（id=${changedExistingIds.join(',')}），拒绝继续清理`,
            );
          }

          for (const row of newRows) {
            if (row.name !== forbiddenName) {
              throw new Error(
                `越权反例发现无法归属的新组织行（id=${row.id} name=${JSON.stringify(row.name)}），` +
                  '缺少本轮登记事实，拒绝按名称删除',
              );
            }

            unexpectedOrganizations.push({
              id: row.id,
              name: row.name,
              organizationCode: row.organizationCode,
            });
          }
        },
      },
      {
        label: '按精确主键回收越权新增行',
        run: () => {
          for (const organization of unexpectedOrganizations) {
            deleteRegisteredOrganization(env, organization);
          }
        },
      },
      {
        // 旧实现会在 finally 里按固定名称 DELETE，这里必须在清理后仍为 1
        label: '核验同名哨兵未被删除',
        run: () => assertOrganizationRowUnchanged(forbiddenSentinel),
      },
      {
        label: '恢复二级管理员等级',
        run: () => restoreAdminLevel(env, LEVEL_TWO_LOGIN, originalAdminLevel),
      },
      {
        label: '按精确主键删除同名哨兵',
        run: () => deleteRegisteredOrganization(env, forbiddenSentinel),
      },
    ]);

    throwPrimaryAndTeardown(primaryError, teardownError);

    // 反向用例不得留下任何组织行，哨兵也按精确主键回收
    expect(readOrganizationCountById(forbiddenSentinel.id)).toBe(0);
    expect(
      Number(mysqlQuery(`SELECT COUNT(*) FROM organization WHERE name = '${forbiddenName}'`)),
    ).toBe(0);
  });

  /**
   * 清理边界回归（P1-02）。
   *
   * 直接驱动同一套清理 helper，证明：
   * - 精确主键删除只命中本轮行，同名哨兵 1→1、编号前缀相似哨兵不变；
   * - 登记事实与库内不一致时前置核验实际失败，不执行 DELETE；
   * - 未收到创建结果时只有只读诊断，绝不按名称删除；
   * - 外部子行介入时 DELETE 被外键拒绝且行保留，子行删除后才可回收。
   */
  test('清理边界回归：同名与编号前缀相似哨兵不被误删，缺前置核验拒绝删除', async () => {
    test.setTimeout(60_000);
    const env = readBackendEnv();

    assertPhysicalCleanupAllowed(env);

    const runTag = `${Date.now()}-${(runCounter += 1)}`;
    const roundName = `E2E 清理边界回归-${runTag}`;
    const roundCode = `ADMIN_ORG_E2E_GUARD_${runTag}`;
    const sameNameCode = `E2E_SENTINEL_SAME_NAME_${runTag}`;
    const prefixPeerName = `E2E 前缀相似哨兵-${runTag}`;
    const prefixPeerCode = `ADMIN_ORG_E2E_PREFIX_${runTag}`;

    const round: RegisteredOrganizationFacts = {
      id: insertFixtureOrganization(env, { name: roundName, organizationCode: roundCode }),
      name: roundName,
      organizationCode: roundCode,
    };
    const sameNameSentinel: RegisteredOrganizationFacts = {
      id: insertFixtureOrganization(env, { name: roundName, organizationCode: sameNameCode }),
      name: roundName,
      organizationCode: sameNameCode,
    };
    const prefixPeerSentinel: RegisteredOrganizationFacts = {
      id: insertFixtureOrganization(env, {
        name: prefixPeerName,
        organizationCode: prefixPeerCode,
      }),
      name: prefixPeerName,
      organizationCode: prefixPeerCode,
    };

    let externalChildId: number | null = null;
    let primaryError: unknown = null;

    try {
      // 1. 精确主键回收本轮行：同名哨兵 1→1，编号前缀相似哨兵不变
      deleteRegisteredOrganization(env, round);

      expect(readOrganizationCountById(round.id)).toBe(0);
      expect(readOrganizationCountById(sameNameSentinel.id)).toBe(1);
      expect(readOrganizationCountById(prefixPeerSentinel.id)).toBe(1);
      assertOrganizationRowUnchanged(sameNameSentinel);
      assertOrganizationRowUnchanged(prefixPeerSentinel);

      // 2. 缺前置核验：登记名称与库内不一致时必须实际失败且零删除
      expect(() =>
        deleteRegisteredOrganization(env, {
          ...sameNameSentinel,
          name: `${roundName}-伪造`,
        }),
      ).toThrow(/清理前置核验失败/u);
      expect(readOrganizationCountById(sameNameSentinel.id)).toBe(1);

      // 3. 未收到创建结果：只读诊断命中同名行，但绝不按名称删除
      expect(readOrganizationDiagnosticsByName(roundName)).toContain(`${sameNameSentinel.id}|`);
      expect(readOrganizationCountById(sameNameSentinel.id)).toBe(1);

      // 4. 外部子行介入：DELETE 被外键拒绝，目标行保留
      const seedAccountId = Number(
        mysqlQuery(`SELECT id FROM base_user_account WHERE login_name = '${LEVEL_ONE_LOGIN}'`),
      );

      expect(Number.isSafeInteger(seedAccountId) && seedAccountId > 0).toBe(true);
      externalChildId = insertExternalLeftMembership(env, {
        accountId: seedAccountId,
        organizationId: sameNameSentinel.id,
      });

      expect(() => deleteRegisteredOrganization(env, sameNameSentinel)).toThrow();
      expect(readOrganizationCountById(sameNameSentinel.id)).toBe(1);
    } catch (error) {
      primaryError = error;
    }

    const teardownError = await runTeardownSteps([
      {
        label: '按精确主键删除外部子行',
        run: () => {
          if (externalChildId === null) {
            return;
          }

          runGuardedFixtureWrite(
            env,
            `DELETE FROM organization_membership WHERE id = ${externalChildId}`,
          );

          if (
            Number(
              mysqlQuery(
                `SELECT COUNT(*) FROM organization_membership WHERE id = ${externalChildId}`,
              ),
            ) !== 0
          ) {
            throw new Error(`外部子行 id=${externalChildId} 未删除`);
          }
        },
      },
      {
        label: '按精确主键删除同名哨兵',
        run: () => {
          if (readOrganizationCountById(sameNameSentinel.id) !== 0) {
            deleteRegisteredOrganization(env, sameNameSentinel);
          }
        },
      },
      {
        label: '按精确主键删除编号前缀相似哨兵',
        run: () => {
          if (readOrganizationCountById(prefixPeerSentinel.id) !== 0) {
            deleteRegisteredOrganization(env, prefixPeerSentinel);
          }
        },
      },
      {
        label: '按精确主键删除未回收的本轮行',
        run: () => {
          if (readOrganizationCountById(round.id) !== 0) {
            deleteRegisteredOrganization(env, round);
          }
        },
      },
    ]);

    throwPrimaryAndTeardown(primaryError, teardownError);

    // 最后一轮：本轮登记的三行零残留，seed 哨兵字段未变
    expect(
      [round, sameNameSentinel, prefixPeerSentinel].map((item) =>
        readOrganizationCountById(item.id),
      ),
    ).toEqual([0, 0, 0]);
    expect(readOrganizationCountByCode(SENTINEL_ORGANIZATION_CODE)).toBe(1);
  });
});

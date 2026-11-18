// e2e-real/admin-companies-real.spec.ts
// 公司档案（任务 08 · S2）隔离库真实联调入口：专用后端 3100 + 专用前端 4174 +
// 独立 E2E 库（默认 lithography_e2e；本地可用 E2E_DEDICATED_DB_NAME 指向白名单库）。
//
// 运行方式（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:admin-companies-real
// 若本机专用库不是默认 lithography_e2e，追加 E2E_DEDICATED_DB_NAME=<白名单库>。
//
// 覆盖：
//   1. 一级管理员：经主导航进入公司档案，真实「新增公司并开通二级管理员」→ 一次性口令弹窗
//      → 详情只读回读 → 行内「二级管理员账号」核对完整登录名/待首次改密 → 补发口令
//      → 编辑（编号只读）；列表「二级管理员账号」列按绑定事实展示；
//      口令只在当次弹窗出现，关闭/刷新后 DOM 与存储均不可查；补发后旧口令立即失效。
//      新增/编辑前后按同一 ID 查库比对字段差集；清理后六表残留计数为 0，哨兵组织不变。
//   2. 二级管理员：只看到最小名称名单与只读提示，无新增/编辑/详情入口；
//      服务端 list / detail / create / update 与 S4 四个新入口一律 FORBIDDEN，名称名单仅 id/name 可用。
//
// 权限与数据真源：等级由请求期查库得到的 `base_user_account.admin_level` 决定，
// 本 spec 只在专用隔离库内临时设置/恢复等级与受管组织行，不触碰共享开发库；
// 清理边界只认「创建响应返回值 + 本轮夹具 INSERT 的真实主键」登记的精确主键：
// 所有权绑定、子行/集合外引用预检与按主键 DELETE 在**同一事务**内完成，任一预检
// 不通过都在首次 DELETE 之前中止（`rc_*` 标记，可与外键兜底 1451 区分）。
// 名称、编号前缀与固定测试名都不是删除授权；快照差集只用于发现缺失/变更/新增，
// 无法归属的对象保留待确认；创建响应丢失时只做只读诊断，绝不按名称猜测归属。
//
// 截图证据写入 docs/plan/task08/visual/（S2 前缀，避免覆盖 S0 原型截图）。

import { expect, type Page, type Request, test } from '@playwright/test';
import path from 'node:path';

import {
  attemptPasswordLogin,
  cleanupProvisionedCompany,
  maskLoginName,
  type ProvisionedCompanyFacts,
  readProvisionedAdminFacts,
  readProvisionedCompanyFacts,
  readProvisionedCompanyResidue,
} from '../e2e/helpers/provisioned-company-cleanup';
import {
  assertPhysicalCleanupAllowed,
  insertUnregisteredLeftMembership,
  mysqlQuery,
  readBackendEnv,
  readMysqlErrorOutput,
  readServerDeleteCounter,
  realGraphqlCall,
  runGuardedFixtureWrite,
  runTeardownSteps,
  throwPrimaryAndTeardown,
} from '../e2e/helpers/real-backend';
import {
  cleanupRegistrationRound,
  createRegistrationRoundLedger,
  discoverRegistrationRoundReferences,
  readRegistrationRoundOrganization,
  registerRegistrationRoundOrganization,
  type RegistrationRoundLedger,
} from '../e2e/helpers/registration-round-cleanup';
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

/** S4 新入口（与前端 adapter 的 operation 逐字一致） */
const ADMIN_PROVISION_MUTATION = `
  mutation AdminProvisionCompany($input: AdminCreateOrganizationInput!) {
    adminProvisionCompany(input: $input) {
      organization { id organizationCode name }
      provisionedAdmin { accountId loginName nickname mustChangePassword }
      submission { submissionId replayed }
      temporaryPassword
    }
  }
`;

const ADMIN_COMPANY_BINDING_QUERY = `
  query AdminCompanyAdminBinding($organizationId: Int!) {
    adminCompanyAdminBinding(organizationId: $organizationId) {
      organizationId
      status
      boundAccountId
      boundLoginNameMasked
    }
  }
`;

const ADMIN_REISSUE_CREDENTIAL_MUTATION = `
  mutation AdminReissueCompanyAdminCredential($input: AdminReissueLevelTwoCredentialInput!) {
    adminReissueCompanyAdminCredential(input: $input) {
      organizationId
      adminAccountId
      loginName
      temporaryPassword
    }
  }
`;

const ADMIN_BOUND_LEVEL_TWO_ADMINS_QUERY = `
  query AdminBoundLevelTwoAdmins($keyword: String, $pagination: PaginationArgs!) {
    adminBoundLevelTwoAdmins(keyword: $keyword, pagination: $pagination) {
      items { accountId organizationId loginName }
      total
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
 * 开通响应一返回就登记本轮公司与二级管理员。
 *
 * 只使用服务端返回值与本轮请求事实，不回读数据库补齐：后续断言失败时，
 * 清理仍能按精确主键执行，而不是退化成按名称/编号前缀删除。
 * 一次性口令只用于当次展示断言，不写入任何返回结构或证据。
 */
function registerProvisionedCompany(
  payload: unknown,
  expectedName: string,
): { facts: ProvisionedCompanyFacts; temporaryPassword: string } {
  const { facts, temporaryPassword } = readProvisionedCompanyFacts(payload);

  if (facts.organizationName !== expectedName) {
    throw new Error('adminProvisionCompany 返回名称与本轮请求不一致，拒绝登记');
  }

  return { facts, temporaryPassword };
}

/**
 * 从**本次真实请求体**提取提交标识（幂等键）。
 *
 * 提交标识在发送前生成、成功后被 `clearSubmissionKey()` 清除，因此成功后不能再读
 * `sessionStorage`；回放断言只能取实际发出的请求事实，也顺带证明请求确实带上了该标识。
 */
function readCreateSubmissionKeyFromRequest(request: Request): string {
  const body = request.postDataJSON() as {
    variables?: { input?: { submissionKey?: unknown } };
  };
  const submissionKey = body.variables?.input?.submissionKey;

  if (typeof submissionKey !== 'string' || submissionKey === '') {
    throw new Error('未能从开通请求体读取提交标识，拒绝继续回放断言');
  }

  return submissionKey;
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

/**
 * 按登记事实回收本轮公司：单一事务内先绑定所有权并预检子行/集合外引用，再按主键删除。
 *
 * 所有权证据只有「创建响应返回值」或「本轮夹具 INSERT 的真实主键」+ 名称 + 编号；
 * 联系人、维修资格等业务可变字段不参与绑定，避免把用例内的正常编辑误判成归属变化。
 * 子行与外部引用由共享台账的 `rc_*` 守卫在首删前拒绝：预检未通过时不会执行任何
 * DELETE（实际删除计数为 0），与数据库外键兜底（1451）在错误文本上可区分。
 */
function deleteRegisteredOrganization(registered: RegisteredOrganizationFacts): void {
  const current = readRegistrationRoundOrganization(registered.id);
  const ledger = createRegistrationRoundLedger();

  registerRegistrationRoundOrganization(ledger, {
    ...current,
    id: registered.id,
    name: registered.name,
    organizationCode: registered.organizationCode,
  });

  cleanupRegistrationRound(ledger);
}

/** 取 mysql CLI 的 stdout / stderr 原始输出（仅用于区分事务内探针与后序失败） */
function readErrorField(error: unknown, field: 'stdout' | 'stderr'): string {
  if (!(error instanceof Error)) {
    return '';
  }

  const value = (error as unknown as Record<string, unknown>)[field];

  if (typeof value === 'string') {
    return value;
  }

  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
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
  /** 除主键外的字段值（结构化数组，避免拼接分隔符带来的歧义） */
  readonly fields: readonly string[];
}

/** 组织表全量快照（只读）：用于越权反例前后比对，任何缺失/改写/新增都必须可解释 */
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
      ],
      id: Number(idText),
      name,
      organizationCode,
    };
  });
}

interface OrganizationSnapshotDiff {
  readonly missingRows: OrganizationSnapshotRow[];
  readonly changedRows: Array<{
    readonly id: number;
    readonly before: readonly string[];
    readonly after: readonly string[];
  }>;
  readonly newRows: OrganizationSnapshotRow[];
}

function sameSnapshotFields(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 既有行的缺失、变更、新增分别报告；不把任何一类静默折叠进另一类 */
function diffOrganizationSnapshot(
  before: readonly OrganizationSnapshotRow[],
  after: readonly OrganizationSnapshotRow[],
): OrganizationSnapshotDiff {
  const beforeById = new Map(before.map((row) => [row.id, row]));
  const afterIds = new Set(after.map((row) => row.id));
  const changedRows: OrganizationSnapshotDiff['changedRows'] = [];

  for (const row of after) {
    const previous = beforeById.get(row.id);

    if (previous !== undefined && !sameSnapshotFields(previous.fields, row.fields)) {
      changedRows.push({ after: row.fields, before: previous.fields, id: row.id });
    }
  }

  return {
    changedRows,
    missingRows: before.filter((row) => !afterIds.has(row.id)),
    newRows: after.filter((row) => !beforeById.has(row.id)),
  };
}

function describeSnapshotRow(row: OrganizationSnapshotRow): string {
  return `id=${row.id} name=${JSON.stringify(row.name)} code=${JSON.stringify(row.organizationCode)}`;
}

/** 差集报告：结构化值逐项列出，供「异常待确认」结论直接引用 */
function describeSnapshotDiff(diff: OrganizationSnapshotDiff): string {
  const sections: string[] = [];

  if (diff.missingRows.length > 0) {
    sections.push(`缺失：[${diff.missingRows.map(describeSnapshotRow).join('；')}]`);
  }
  if (diff.changedRows.length > 0) {
    sections.push(
      `变更：[${diff.changedRows
        .map(
          ({ id, before, after }) =>
            `id=${id} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
        )
        .join('；')}]`,
    );
  }
  if (diff.newRows.length > 0) {
    sections.push(`新增：[${diff.newRows.map(describeSnapshotRow).join('；')}]`);
  }

  return sections.length === 0 ? '无差异' : sections.join(' / ');
}

/**
 * 从意外成功的创建响应中提取可核验归属的真实主键与名称/编号。
 * 响应缺失或字段不完整时返回 null：调用方只能做只读诊断并报待确认。
 */
function parseUnexpectedCreatedOrganization(payload: unknown): RegisteredOrganizationFacts | null {
  const candidate = payload as Partial<RegisteredOrganization> | null | undefined;

  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate.id !== 'number' ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    typeof candidate.organizationCode !== 'string' ||
    candidate.organizationCode === '' ||
    typeof candidate.name !== 'string' ||
    candidate.name === ''
  ) {
    return null;
  }

  return { id: candidate.id, name: candidate.name, organizationCode: candidate.organizationCode };
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
  test('一级管理员：开通公司并交付一次性口令 → 详情补发 → 编辑，清理后六表无残留', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const env = readBackendEnv();

    assertPhysicalCleanupAllowed(env);

    const companyName = buildCompanyName();
    const contactPhone = '13900008888';
    const originalAdminLevel = readAdminLevel(LEVEL_ONE_LOGIN);
    let provisioned: ProvisionedCompanyFacts | null = null;
    let firstPassword: string;
    let primaryError: unknown = null;

    try {
      setAdminLevel(env, LEVEL_ONE_LOGIN, 1);

      await loginViaUi(page, LEVEL_ONE_LOGIN, env.MOCK_SEED_PASSWORD, '/admin');
      await enterAdminCompaniesFromNav(page);

      // 列表初始就绪：seed 组织经真实查询可见（antd 测量行也会占用 role=row，按内容收敛）
      await expect(page.getByRole('row').filter({ hasText: '甲方默认组织' })).toBeVisible();
      // S4：一级列表新增绑定状态列
      await expect(page.getByRole('columnheader', { name: '二级管理员账号' })).toBeVisible();
      await captureScreenshots(page, 's2-admin1-companies-list');

      // 截图会把视口收窄到移动端，交互前回到桌面视口
      await page.setViewportSize({ height: 900, width: 1440 });

      // 新增：全称 + 电话必填，初设维修资格（状态默认启用且不可改）
      await page.getByRole('button', { name: /新增公司/ }).click();

      // 成功后面临两个弹窗交叠（新增 → 凭据），因此按标题锁定新增弹窗，避免 :visible 匹配多个
      const createDialog = page.getByRole('dialog').filter({ hasText: '新增公司档案' });

      await expect(createDialog).toBeVisible();
      await createDialog.getByLabel('公司全称', { exact: true }).fill(companyName);
      await createDialog.getByLabel('联系电话', { exact: true }).fill(contactPhone);
      // 两个 Switch：公司启用（禁用）与提供维修服务
      await createDialog.getByRole('switch').nth(1).click();

      await page.setViewportSize({ height: 900, width: 1440 });
      await prepareStableViewport(page, 's4-admin1-companies-add-dialog-1440x900.png');
      await page.screenshot({
        path: path.join(VISUAL_DIR, 's4-admin1-companies-add-dialog-1440x900.png'),
      });

      // 提交标识在首次发送前生成、成功后清除：回放断言只能复用实际请求体里的标识
      const provisionResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/graphql') &&
          response.request().method() === 'POST' &&
          (response.request().postData() ?? '').includes('adminProvisionCompany'),
      );

      await createDialog.getByRole('button', { name: /创\s*建/ }).click();

      const provisionResponse = await provisionResponsePromise;
      const submissionKey = readCreateSubmissionKeyFromRequest(provisionResponse.request());
      const provisionBody = (await provisionResponse.json()) as {
        data?: { adminProvisionCompany?: unknown };
      };
      const provisionPayload = provisionBody.data?.adminProvisionCompany;

      if (provisionPayload === undefined) {
        throw new Error('adminProvisionCompany 未返回落库结果，拒绝继续断言');
      }

      // 创建响应一返回就登记真实主键与请求事实：后续任何断言失败仍可按精确主键回收
      const registered = registerProvisionedCompany(provisionPayload, companyName);

      provisioned = registered.facts;
      firstPassword = registered.temporaryPassword;

      await expect(createDialog).toBeHidden();

      // 首次成功才有的口令弹窗：只展示本次响应里的临时密码，且不写入任何持久化位置
      const credentialDialog = page.getByRole('dialog').filter({ hasText: '二级管理员账号凭据' });

      await expect(credentialDialog).toBeVisible();
      await expect(credentialDialog.getByText('本次临时密码只显示一次')).toBeVisible();
      // 口令断言只比较布尔结果：断言失败时不得把口令明文写进日志
      expect((await credentialDialog.locator('input').first().inputValue()) === firstPassword).toBe(
        true,
      );

      const storageDump = await page.evaluate(() =>
        JSON.stringify({
          local: { ...window.localStorage },
          session: { ...window.sessionStorage },
        }),
      );

      expect(storageDump.includes(firstPassword)).toBe(false);

      await credentialDialog.getByRole('button', { name: '我已记录并关闭' }).click();
      await expect(page.getByRole('dialog').filter({ hasText: '二级管理员账号凭据' })).toHaveCount(
        0,
      );
      expect((await page.evaluate(() => document.body.innerText)).includes(firstPassword)).toBe(
        false,
      );

      // 刷新后仍不可查：口令只存在于已销毁的弹窗节点
      await page.reload();
      await expect(page.getByRole('heading', { name: ADMIN_COMPANIES_LABEL })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: '甲方默认组织' })).toBeVisible();
      expect((await page.evaluate(() => document.body.innerText)).includes(firstPassword)).toBe(
        false,
      );

      // 服务端生成编号、受管归类与状态：查库核对初始落库事实
      const initial = readOrganizationRow(provisioned.organizationId);

      expect(initial.name).toBe(companyName);
      expect(initial.organizationCode).toBe(provisioned.organizationCode);
      expect(initial.organizationCode.startsWith('ADMIN_ORG_')).toBe(true);
      expect(initial.isManagedCompany).toBe('1');
      expect(initial.kind).toBe('CLIENT');
      expect(initial.status).toBe('ACTIVE');
      expect(initial.isServiceProvider).toBe('1');
      expect(initial.contactName).toBe('NULL');

      // 开通出的二级管理员：ACTIVE + 强制改密 + 组织管理员成员关系
      const adminFacts = readProvisionedAdminFacts(provisioned.adminAccountId);

      expect(adminFacts.loginName).toBe(provisioned.adminLoginName);
      expect(adminFacts.adminLevel).toBe('2');
      expect(adminFacts.status).toBe('ACTIVE');
      expect(adminFacts.mustChangePassword).toBe('1');
      expect(adminFacts.memberRole).toBe('SUPER_ADMIN');
      expect(adminFacts.membershipStatus).toBe('ACTIVE');

      // 首次口令可签发受限会话（待首次改密）
      const firstLogin = await attemptPasswordLogin(
        provisioned.adminLoginName,
        firstPassword,
        true,
      );

      expect(firstLogin.accessToken).toBeTruthy();

      // 同标识同内容回放：不得再次返回口令，且仍指向本轮公司
      const replay = await realGraphqlCall(
        env,
        ADMIN_PROVISION_MUTATION,
        {
          input: {
            address: null,
            contactEmail: null,
            contactName: null,
            contactPhone,
            isServiceProvider: true,
            name: companyName,
            remark: null,
            shortName: null,
            status: 'ACTIVE',
            submissionKey,
          },
        },
        LEVEL_ONE_LOGIN,
      );
      const replayPayload = (
        replay.body as {
          data?: {
            adminProvisionCompany?: {
              organization?: { id?: number };
              submission?: { replayed?: boolean; submissionId?: number | null };
              temporaryPassword?: string | null;
            };
          };
        }
      ).data?.adminProvisionCompany;

      expect(firstGraphqlErrorCode(replay.body)).toBeNull();
      expect(replayPayload?.submission?.replayed).toBe(true);
      expect(replayPayload?.submission?.submissionId).toBe(provisioned.provisioningRequestId);
      expect(replayPayload?.organization?.id).toBe(provisioned.organizationId);
      expect(replayPayload?.temporaryPassword).toBeNull();

      // 列表刷新后按关键字收敛到本轮新增行：绑定列展示状态 + 脱敏登录名
      await page.getByPlaceholder('搜索公司全称 / 编号 / 简称').fill(companyName);

      const row = page.getByRole('row').filter({ hasText: companyName });

      await expect(row).toBeVisible();
      await expect(row.getByText('是')).toBeVisible();
      await expect(row.getByText('已绑定')).toBeVisible();
      await expect(row.getByText(maskLoginName(provisioned.adminLoginName))).toBeVisible();
      // 完整登录名不得出现在列表（只给脱敏值）
      await expect(row.getByText(provisioned.adminLoginName, { exact: true })).toHaveCount(0);

      // 详情：按主键单独读取，展示编号、受管事实与绑定状态；写入口已收敛到账号弹窗
      await row.getByRole('button', { name: '详情' }).click();

      // 详情同样按标题锁定，避免 :visible 同时匹配叠层弹窗
      const detailDialog = page.getByRole('dialog').filter({ hasText: '公司详情：' });

      await expect(detailDialog.getByText(provisioned.organizationCode)).toBeVisible();
      await expect(detailDialog.getByText('受管公司')).toBeVisible();
      await expect(detailDialog.getByText('已绑定')).toBeVisible();
      // 详情是只读视图：补发入口只在行内「二级管理员账号」弹窗，不能被测试顺手加回
      await expect(detailDialog.getByRole('button', { name: '补发临时密码' })).toHaveCount(0);

      await detailDialog.getByRole('button', { name: '关 闭' }).click();
      await expect(detailDialog).toHaveCount(0);

      // 账号入口：唯一的补发入口，展示完整登录名与开通状态
      await row.getByRole('button', { name: '二级管理员账号' }).click();

      const accountDialog = page
        .getByRole('dialog')
        .filter({ hasText: `二级管理员账号：${companyName}` });

      await expect(accountDialog).toBeVisible();
      await expect(
        accountDialog.getByText(provisioned.adminLoginName, { exact: true }),
      ).toBeVisible();
      await expect(accountDialog.getByText('待首次改密')).toBeVisible();

      await accountDialog.getByRole('button', { name: '补发临时密码' }).click();

      // 二次确认：一级授权弹窗展示公司名与完整登录名，不展示任何口令
      const confirmDialog = page.getByRole('dialog').filter({ hasText: '补发二级管理员临时密码' });

      await expect(confirmDialog).toBeVisible();
      await expect(confirmDialog.getByText(companyName)).toBeVisible();
      await expect(
        confirmDialog.getByText(provisioned.adminLoginName, { exact: true }),
      ).toBeVisible();
      await expect(confirmDialog.getByText('补发会立即作废旧口令与旧登录会话')).toBeVisible();

      const reissuePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/graphql') &&
          response.request().method() === 'POST' &&
          (response.request().postData() ?? '').includes('adminReissueCompanyAdminCredential'),
      );

      await confirmDialog.getByRole('button', { name: '确认补发' }).click();

      const reissueBody = (await (await reissuePromise).json()) as {
        data?: { adminReissueCompanyAdminCredential?: { temporaryPassword?: string } };
      };
      const reissuedPassword =
        reissueBody.data?.adminReissueCompanyAdminCredential?.temporaryPassword;

      if (typeof reissuedPassword !== 'string' || reissuedPassword === '') {
        throw new Error('补发响应未返回新的临时密码，拒绝继续断言');
      }

      expect(reissuedPassword !== firstPassword).toBe(true);

      const reissuedDialog = page.getByRole('dialog').filter({ hasText: '二级管理员账号凭据' });

      await expect(reissuedDialog).toBeVisible();
      expect(
        (await reissuedDialog.locator('input').first().inputValue()) === reissuedPassword,
      ).toBe(true);

      await reissuedDialog.getByRole('button', { name: '我已记录并关闭' }).click();
      await expect(page.getByRole('dialog').filter({ hasText: '二级管理员账号凭据' })).toHaveCount(
        0,
      );
      expect((await page.evaluate(() => document.body.innerText)).includes(reissuedPassword)).toBe(
        false,
      );

      // 三层弹窗实际关闭行为：发起确认时账号弹窗已关闭；补发成功后确认弹窗关闭并弹出凭据；
      // 凭据关闭后不得残留遮罩，编辑入口必须可直接点击
      await expect(confirmDialog).toHaveCount(0);
      await expect(accountDialog).toHaveCount(0);

      // 旧口令立即失效，新口令可签发受限会话
      const staleLogin = await attemptPasswordLogin(
        provisioned.adminLoginName,
        firstPassword,
        true,
      );

      expect(staleLogin.accessToken).toBeNull();
      expect(staleLogin.code).toBe('UNAUTHENTICATED');

      const freshLogin = await attemptPasswordLogin(
        provisioned.adminLoginName,
        reissuedPassword,
        true,
      );

      expect(freshLogin.accessToken).toBeTruthy();
      expect(readProvisionedAdminFacts(provisioned.adminAccountId).mustChangePassword).toBe('1');

      // 编辑：编号只读，只改联系人与维修资格
      await row.getByRole('button', { name: '编辑' }).click();

      const editDialog = visibleDialog(page);

      // 公司编号 Form.Item 没有 name，label 不与 input 关联，按字段顺序取首个输入框
      const codeInput = editDialog.locator('input').first();

      await expect(codeInput).toBeDisabled();
      await expect(codeInput).toHaveValue(provisioned.organizationCode);
      await editDialog.getByLabel('联系人姓名', { exact: true }).fill('E2E 联系人');
      await editDialog.getByRole('switch').nth(1).click();

      await page.setViewportSize({ height: 900, width: 1440 });
      await prepareStableViewport(page, 's4-admin1-companies-edit-dialog-1440x900.png');
      await page.screenshot({
        path: path.join(VISUAL_DIR, 's4-admin1-companies-edit-dialog-1440x900.png'),
      });

      await editDialog.getByRole('button', { name: /保\s*存/ }).click();
      await expect(editDialog).toBeHidden();

      // 同一 ID 回读：仅联系人与维修资格变化，编号/受管/类别/状态保持
      const updated = readOrganizationRow(provisioned.organizationId);

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
        label: provisioned === null ? '未登记开通结果的只读诊断' : '按登记事实回收本轮开通数据',
        run: () => {
          if (provisioned !== null) {
            cleanupProvisionedCompany(provisioned);
            return;
          }

          // 响应丢失时只回读本轮唯一名称命中的行；名称相同不构成所有权证据，拒绝删除
          const diagnostic = readOrganizationDiagnosticsByName(companyName);

          if (diagnostic !== '') {
            throw new Error(
              '本轮未取得可信开通结果，但库内存在同名组织行；' +
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

    const registered = provisioned;

    if (registered === null) {
      throw new Error('本轮没有登记到开通主键，无法核验清理残留');
    }

    // 清理后：六张表全部零残留，seed 哨兵组织保持原值
    expect(readProvisionedCompanyResidue(registered)).toEqual({
      account: 0,
      audit: 0,
      membership: 0,
      organization: 0,
      provisioningRequest: 0,
      userInfo: 0,
    });
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
    // 快照之后新增的独立同名哨兵：只有本轮夹具 INSERT 的真实主键可解释它，
    // 名称相同既不能认领它、也不能删除它。
    const postSnapshotSentinelCode = `E2E_SENTINEL_POST_SNAPSHOT_${Date.now()}`;
    const postSnapshotSentinel: RegisteredOrganizationFacts = {
      id: insertFixtureOrganization(env, {
        name: forbiddenName,
        organizationCode: postSnapshotSentinelCode,
      }),
      name: forbiddenName,
      organizationCode: postSnapshotSentinelCode,
    };
    const sentinels: readonly RegisteredOrganizationFacts[] = [
      forbiddenSentinel,
      postSnapshotSentinel,
    ];
    // 只有「意外成功响应里结构化返回的真实主键」可登记为待回收对象
    const confirmedUnexpectedWrites: RegisteredOrganizationFacts[] = [];
    // S4 新入口意外成功时：开通响应可登记公司 + 管理员的整链路精确回收
    const unexpectedProvisioned: ProvisionedCompanyFacts[] = [];
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
        const code = firstGraphqlErrorCode(body);

        if (code !== null) {
          expect(code, `${label} 应拒绝二级管理员`).toBe('FORBIDDEN');
          continue;
        }

        // 意外成功：保留原失败；创建响应的真实主键可作精确清理，其余只能报待确认
        const payload = (body as { data?: { adminCreateOrganization?: unknown } }).data
          ?.adminCreateOrganization;
        const confirmed =
          label === 'adminCreateOrganization' ? parseUnexpectedCreatedOrganization(payload) : null;

        if (confirmed !== null) {
          confirmedUnexpectedWrites.push(confirmed);
        }

        const diagnostic = readOrganizationDiagnosticsByName(forbiddenName);

        throw new Error(
          `${label} 对二级管理员意外成功，保留原失败：` +
            (confirmed === null
              ? '响应缺少可核验主键/编号，只做只读诊断并保留待确认：' +
                `${diagnostic === '' ? '（无同名行）' : diagnostic}`
              : `已登记真实 id=${confirmed.id} code=${JSON.stringify(confirmed.organizationCode)}，` +
                '将按精确主键清理') +
            `；响应=${JSON.stringify(body)}`,
        );
      }

      // S4 新入口：开通 / 绑定查询 / 补发 / 已绑定名单对二级一律 FORBIDDEN。
      // 开通之外的三个入口没有写副作用，意外成功只报待确认；开通成功可凭响应主键整链路回收。
      const s4ForbiddenCases: ReadonlyArray<{
        readonly label: string;
        readonly query: string;
        readonly variables: Record<string, unknown>;
      }> = [
        {
          label: 'adminProvisionCompany',
          query: ADMIN_PROVISION_MUTATION,
          variables: {
            input: {
              address: null,
              contactEmail: null,
              contactName: null,
              contactPhone: '13900000000',
              isServiceProvider: false,
              name: forbiddenName,
              remark: null,
              shortName: null,
              status: 'ACTIVE',
              submissionKey: `e2e-forbidden-${Date.now()}`,
            },
          },
        },
        {
          label: 'adminCompanyAdminBinding',
          query: ADMIN_COMPANY_BINDING_QUERY,
          variables: { organizationId: forbiddenSentinel.id },
        },
        {
          label: 'adminReissueCompanyAdminCredential',
          query: ADMIN_REISSUE_CREDENTIAL_MUTATION,
          variables: { input: { organizationId: forbiddenSentinel.id } },
        },
        {
          label: 'adminBoundLevelTwoAdmins',
          query: ADMIN_BOUND_LEVEL_TWO_ADMINS_QUERY,
          variables: { pagination },
        },
      ];

      for (const { label, query, variables } of s4ForbiddenCases) {
        const { body } = await realGraphqlCall(env, query, variables, LEVEL_TWO_LOGIN);
        const code = firstGraphqlErrorCode(body);

        if (code !== null) {
          expect(code, `${label} 应拒绝二级管理员`).toBe('FORBIDDEN');
          continue;
        }

        const payload = (body as { data?: Record<string, unknown> }).data?.[label];

        if (label === 'adminProvisionCompany') {
          let confirmed: ProvisionedCompanyFacts | null = null;
          let unreadableReason = '';

          try {
            confirmed = readProvisionedCompanyFacts(payload).facts;
          } catch (parseError) {
            unreadableReason =
              parseError instanceof Error ? parseError.message : String(parseError);
          }

          if (confirmed !== null) {
            unexpectedProvisioned.push(confirmed);

            throw new Error(
              `${label} 对二级管理员意外成功，已登记真实 id=${confirmed.organizationId}` +
                ` code=${JSON.stringify(confirmed.organizationCode)}，将按精确主键清理；` +
                '响应含一次性口令，已省略不落日志',
            );
          }

          const diagnostic = readOrganizationDiagnosticsByName(forbiddenName);

          throw new Error(
            `${label} 对二级管理员意外成功，但${unreadableReason}；` +
              '只做只读诊断并保留待确认：' +
              `${diagnostic === '' ? '（无同名行）' : diagnostic}；响应含一次性口令，已省略不落日志`,
          );
        }

        throw new Error(
          `${label} 对二级管理员意外成功，保留原失败并保留待确认（本入口不应产生写副作用）；` +
            `响应=${JSON.stringify(body)}`,
        );
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
        label: '比对越权前后组织集合并报出无法归属的变化',
        run: () => {
          const diff = diffOrganizationSnapshot(beforeSnapshot, readOrganizationSnapshot());
          const knownSentinelIds = new Set(sentinels.map((sentinel) => sentinel.id));
          const confirmedIds = new Set([
            ...confirmedUnexpectedWrites.map((organization) => organization.id),
            ...unexpectedProvisioned.map((facts) => facts.organizationId),
          ]);
          const pendingDiff: OrganizationSnapshotDiff = {
            changedRows: diff.changedRows.filter((row) => !knownSentinelIds.has(row.id)),
            missingRows: diff.missingRows.filter((row) => !knownSentinelIds.has(row.id)),
            newRows: diff.newRows.filter(
              (row) => !knownSentinelIds.has(row.id) && !confirmedIds.has(row.id),
            ),
          };
          const problems: string[] = [];
          const removedSentinels = diff.missingRows.filter((row) => knownSentinelIds.has(row.id));
          const rewrittenSentinels = diff.changedRows.filter((row) => knownSentinelIds.has(row.id));

          if (removedSentinels.length > 0) {
            problems.push(
              `同名哨兵被意外删除：${removedSentinels.map(describeSnapshotRow).join('；')}`,
            );
          }
          if (rewrittenSentinels.length > 0) {
            problems.push(
              `同名哨兵被意外改写：${describeSnapshotDiff({
                changedRows: rewrittenSentinels,
                missingRows: [],
                newRows: [],
              })}`,
            );
          }
          if (
            pendingDiff.missingRows.length > 0 ||
            pendingDiff.changedRows.length > 0 ||
            pendingDiff.newRows.length > 0
          ) {
            problems.push(
              '存在无法归属的外部变化，已保留相关对象待确认：' + describeSnapshotDiff(pendingDiff),
            );
          }

          if (problems.length > 0) {
            throw new Error(problems.join('；'));
          }
        },
      },
      {
        label: '按响应返回的精确主键回收意外成功写入',
        run: () => {
          for (const organization of confirmedUnexpectedWrites) {
            deleteRegisteredOrganization(organization);
          }
        },
      },
      {
        label: '按开通响应返回的精确主键回收意外成功开通',
        run: () => {
          for (const facts of unexpectedProvisioned) {
            cleanupProvisionedCompany(facts);
          }
        },
      },
      {
        // 旧实现会在 finally 里按固定名称 DELETE，这里必须在清理前仍保持原值
        label: '核验同名哨兵未被删除或改写',
        run: () => {
          for (const sentinel of sentinels) {
            assertOrganizationRowUnchanged(sentinel);
          }
        },
      },
      {
        label: '恢复二级管理员等级',
        run: () => restoreAdminLevel(env, LEVEL_TWO_LOGIN, originalAdminLevel),
      },
      {
        label: '按精确主键删除同名哨兵',
        run: () => {
          for (const sentinel of sentinels) {
            if (readOrganizationCountById(sentinel.id) !== 0) {
              deleteRegisteredOrganization(sentinel);
            }
          }
        },
      },
    ]);

    throwPrimaryAndTeardown(primaryError, teardownError);

    // 反向用例不得留下任何组织行，哨兵也按精确主键回收
    expect(sentinels.map((sentinel) => readOrganizationCountById(sentinel.id))).toEqual([0, 0]);
    expect(
      Number(mysqlQuery(`SELECT COUNT(*) FROM organization WHERE name = '${forbiddenName}'`)),
    ).toBe(0);
  });

  /**
   * 清理边界回归（P1-02 / 第二轮 P1-01）。
   *
   * 直接驱动同一套清理 helper，证明：
   * - 精确主键删除只命中本轮行，同名哨兵 1→1、编号前缀相似哨兵不变；
   * - 登记事实与库内不一致时，事务内绑定守卫拒绝且实际 DELETE 为 0；
   * - 未收到创建结果时只有只读诊断，绝不按名称删除；
   * - 账号下挂未登记的 LEFT 成员关系时，守卫在首删前拒绝，原有资源与外部子行均不变；
   * - 后序失败（注入错误）时整批回滚，错误文本可区分「前置拒绝」与「数据库兜底」。
   */
  test('清理边界回归：同名哨兵不被误删，未登记子行与后序失败均按事务拒绝', async () => {
    test.setTimeout(90_000);
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
    let rollbackLedger: RegistrationRoundLedger | null = null;
    let primaryError: unknown = null;

    try {
      // 1. 精确主键回收本轮行：同名哨兵 1→1，编号前缀相似哨兵不变
      deleteRegisteredOrganization(round);

      expect(readOrganizationCountById(round.id)).toBe(0);
      expect(readOrganizationCountById(sameNameSentinel.id)).toBe(1);
      expect(readOrganizationCountById(prefixPeerSentinel.id)).toBe(1);
      assertOrganizationRowUnchanged(sameNameSentinel);
      assertOrganizationRowUnchanged(prefixPeerSentinel);

      // 2. 缺前置核验：事务内绑定守卫拒绝，实际 DELETE 为 0（错误标记可区分于外键兜底）
      const deleteBeforeMismatch = readServerDeleteCounter();
      let mismatchError: unknown = null;

      try {
        deleteRegisteredOrganization({ ...sameNameSentinel, name: `${roundName}-伪造` });
      } catch (error) {
        mismatchError = error;
      }

      const mismatchText = readMysqlErrorOutput(mismatchError);
      expect(mismatchText).toMatch(/rc_org_\d+_binding_mismatch/u);
      expect(mismatchText).not.toContain('Cannot delete or update a parent row');
      expect(readServerDeleteCounter() - deleteBeforeMismatch).toBe(0);
      expect(readOrganizationCountById(sameNameSentinel.id)).toBe(1);

      // 3. 未收到创建结果：只读诊断命中同名行，但绝不按名称删除
      expect(readOrganizationDiagnosticsByName(roundName)).toContain(`${sameNameSentinel.id}|`);
      expect(readOrganizationCountById(sameNameSentinel.id)).toBe(1);

      // 4. 账号下挂未登记的 LEFT 成员关系：守卫在首删前拒绝，计数为 0 且外部子行不变
      const seedAccountId = Number(
        mysqlQuery(`SELECT id FROM base_user_account WHERE login_name = '${LEVEL_ONE_LOGIN}'`),
      );

      expect(Number.isSafeInteger(seedAccountId) && seedAccountId > 0).toBe(true);
      externalChildId = insertUnregisteredLeftMembership(env, {
        accountId: seedAccountId,
        organizationId: sameNameSentinel.id,
      });

      const deleteBeforeMembership = readServerDeleteCounter();
      let membershipGuardError: unknown = null;

      try {
        deleteRegisteredOrganization(sameNameSentinel);
      } catch (error) {
        membershipGuardError = error;
      }

      const membershipText = readMysqlErrorOutput(membershipGuardError);
      expect(membershipText).toContain(
        'rc_unregistered_in_set_organization_membership_organization_id',
      );
      expect(membershipText).not.toContain('Cannot delete or update a parent row');
      expect(readServerDeleteCounter() - deleteBeforeMembership).toBe(0);
      expect(readOrganizationCountById(sameNameSentinel.id)).toBe(1);
      expect(
        Number(
          mysqlQuery(`SELECT COUNT(*) FROM organization_membership WHERE id = ${externalChildId}`),
        ),
      ).toBe(1);

      // 5. 后序失败整批回滚：去掉 COMMIT，在事务内加探针后再注入失败
      const rollbackA: RegisteredOrganizationFacts = {
        id: insertFixtureOrganization(env, {
          name: `E2E 整批回滚-A-${runTag}`,
          organizationCode: `E2E_ROLLBACK_A_${runTag}`,
        }),
        name: `E2E 整批回滚-A-${runTag}`,
        organizationCode: `E2E_ROLLBACK_A_${runTag}`,
      };
      const rollbackB: RegisteredOrganizationFacts = {
        id: insertFixtureOrganization(env, {
          name: `E2E 整批回滚-B-${runTag}`,
          organizationCode: `E2E_ROLLBACK_B_${runTag}`,
        }),
        name: `E2E 整批回滚-B-${runTag}`,
        organizationCode: `E2E_ROLLBACK_B_${runTag}`,
      };

      rollbackLedger = createRegistrationRoundLedger();
      for (const facts of [rollbackA, rollbackB]) {
        registerRegistrationRoundOrganization(
          rollbackLedger,
          readRegistrationRoundOrganization(facts.id),
        );
      }

      let rollbackError: unknown = null;

      try {
        cleanupRegistrationRound(rollbackLedger, {
          discoverReferences: discoverRegistrationRoundReferences,
          query: mysqlQuery,
          readEnv: readBackendEnv,
          write: (writeEnv, script) => {
            const head = script.split('; COMMIT')[0];
            const probe =
              `SELECT 'RC_IN_TX', (SELECT COUNT(*) FROM organization WHERE id = ${rollbackA.id}), ` +
              `(SELECT COUNT(*) FROM organization WHERE id = ${rollbackB.id})`;

            return runGuardedFixtureWrite(
              writeEnv,
              `${head}; ${probe}; SELECT rc_injected_rollback_probe`,
            );
          },
        });
      } catch (error) {
        rollbackError = error;
      }

      const rollbackText = readMysqlErrorOutput(rollbackError);
      // 注入失败属于「后序失败」（DELETE 已执行后由数据库报错），不是前置守卫标记
      expect(rollbackText).toContain('rc_injected_rollback_probe');
      expect(rollbackText).not.toContain('rc_unregistered_in_set_');
      const inTxLine = readErrorField(rollbackError, 'stdout')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('RC_IN_TX'));

      // 事务内可见两行都已删除；未 COMMIT 且连接关闭 → 整批回滚，两行都还在
      expect(inTxLine).toBe('RC_IN_TX\t0\t0');
      expect(readOrganizationCountById(rollbackA.id)).toBe(1);
      expect(readOrganizationCountById(rollbackB.id)).toBe(1);
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
            deleteRegisteredOrganization(sameNameSentinel);
          }
        },
      },
      {
        label: '按精确主键删除编号前缀相似哨兵',
        run: () => {
          if (readOrganizationCountById(prefixPeerSentinel.id) !== 0) {
            deleteRegisteredOrganization(prefixPeerSentinel);
          }
        },
      },
      {
        label: '按台账回收整批回滚场景的两行',
        run: () => {
          if (rollbackLedger !== null) {
            cleanupRegistrationRound(rollbackLedger);
          }
        },
      },
      {
        label: '按精确主键删除未回收的本轮行',
        run: () => {
          if (readOrganizationCountById(round.id) !== 0) {
            deleteRegisteredOrganization(round);
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

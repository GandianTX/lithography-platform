// e2e-real/pr5-real-flow.spec.ts
// PR5 S5「真实权限与业务闭环」真实链路用例：专用隔离库 lithography_e2e + 专用后端 3100
// + 专用前端 4174（/graphql 同源代理到 3100）。
//
// 运行入口（授权变量必须由执行者显式设置，不写入 npm script）：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:pr5-real
//
// 硬边界（与 account-settings-real.spec.ts 同一套基建）：
// - 前置不满足**直接失败**，不使用 test.skip 掩盖；目标库、授权与 Mock Seed 前置数据
//   由 beforeAll 逐条断言（含 API/SQL 同库探针：SQL 写唯一哨兵 → 真实 API 读回 → 精确恢复）；
// - 本轮自建数据一律使用**数据库生成主键**：创建前先取主键快照，创建后断言新主键不在快照内，
//   证明没有复用 Mock Seed 的固定主键；
// - 清理按「唯一绑定 + 精确 DELETE + 残留核对」在单事务内完成，不触碰 Seed 固定行，
//   也不按标题前缀批量删除；二次运行可重入（本轮标题关键字含运行级唯一标识）；
// - 浏览器流量必须落在专用前端 / 专用后端来源，出现 127.0.0.1:3000 即判失败。
//
// 覆盖的清单项：S5-1 客户闭环 / S5-2 已接单拒绝 / S5-3 有回复·无回复 /
// S5-4 管理员资料闭环 / S5-5 工程师只读与全写拒绝 / S5-6 客户越权 / S5-7 数据安全 /
// S5-8 专用库与前置数据（S5-9 视频与拒绝回执在证据采集阶段落地）。

import { expect, type Page, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { assertApiSqlSameDatabase } from '../e2e/helpers/dedicated-account-cleanup';
import { assertBrowserRequestsBoundToDedicatedOrigins } from '../e2e/helpers/dedicated-real-link-assertions';
import {
  assertPr5CleanupReceiptClean,
  assertPr5DedicatedEnvironment,
  assertPr5GeneratedId,
  assertPr5SeedDataReady,
  buildPr5DocKeyword,
  cleanupPr5ReferenceDocumentsBound,
  countPr5ReferenceDocumentsByTitlePrefix,
  deletePr5RepairRequestBound,
  findPr5ReferenceDocumentIdsByKeyword,
  PR5_SEED_ACCEPTED_REQUEST_NO,
  type Pr5ReferenceDocumentBinding,
  type Pr5RepairRequestBinding,
  readPr5EngineerResponseBindingById,
  readPr5PrimaryKeySnapshot,
  readPr5ReferenceDocumentBindingFromDb,
  readPr5ReferenceDocumentDeprecatedById,
  readPr5ReferenceDocumentSnapshot,
  readPr5RepairRequestBindingFromDb,
  readPr5RepairRequestState,
} from '../e2e/helpers/pr5-real-flow';
import {
  findRepairRequestByRequestNo,
  mysqlQuery,
  readBackendEnv,
  realGraphqlCall,
  realLoginAccountId,
  realRestDownload,
  realRestUpload,
  REQUEST_NO_PATTERN,
} from '../e2e/helpers/real-backend';

const CUSTOMER_LOGIN = 'mock_customer_alpha';
const ENGINEER_LOGIN = 'mock_engineer_chen';
const ADMIN_LOGIN = 'mock_super_admin';

const CUSTOMER_HOME_PATH = '/customer';
const CUSTOMER_LIST_PATH = '/customer/repair-requests';
const DOCUMENT_LIST_PATH = '/reference-documents';
const DOCUMENT_NEW_PATH = '/reference-documents/new';

/** 本轮运行唯一标识：并入自建行文案与资料标题关键字，跨运行/跨执行者不可能撞名 */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** 本轮自建资料标题关键字（清理的唯一绑定因子之一） */
const DOC_KEYWORD = buildPr5DocKeyword(RUN_ID);
/** 本轮自建维修申请故障描述标记（不含清理语义，仅便于人工追溯） */
const FAULT_TAG = `PR5真实链路验收·${RUN_ID}`;

/** 本轮自建资料上传的原始文件名（下载断言按它比对） */
const UPLOAD_FILENAME = `pr5-real-${RUN_ID}.md`;
const UPLOAD_BYTES = new TextEncoder().encode(
  `# PR5 真实链路验收（${RUN_ID}）\n\n下载链路必须无损往返。`,
);

/** 已软删的 seed 资料（970004）：任何角色在正常列表中都不可见 */
const SEED_SOFT_DELETED_DOCUMENT_ID = 970004;
/** 未软删的 seed 资料（970001）：用作客户越权下载的负测目标（守卫先于文件读取拒绝） */
const SEED_VISIBLE_DOCUMENT_ID = 970001;

const CREATE_REPAIR_REQUEST_MUTATION = `
  mutation CreateRepairRequest($input: CreateRepairRequestInput!) {
    createRepairRequest(input: $input) { id requestNo }
  }
`;

const ACCEPT_REPAIR_REQUEST_MUTATION = `
  mutation AcceptRepairRequest($id: Int!) {
    acceptRepairRequest(id: $id) { id requestNo }
  }
`;

const CREATE_ENGINEER_RESPONSE_MUTATION = `
  mutation CreateEngineerResponse($input: CreateEngineerResponseInput!) {
    createEngineerResponse(input: $input) {
      id
      engineerNickname
      resolutionStatus
      responseText
      createdAt
    }
  }
`;

const DELETE_MY_REPAIR_REQUEST_MUTATION = `
  mutation DeleteMyRepairRequest($id: Int!) {
    deleteMyRepairRequest(id: $id) { id requestNo }
  }
`;

const REFERENCE_DOCUMENTS_QUERY = `
  query ReferenceDocuments($pagination: PaginationArgs!, $filter: ReferenceDocumentFilterInput) {
    referenceDocuments(pagination: $pagination, filter: $filter) {
      items { id title }
      total
    }
  }
`;

// 单条详情读（工程师/管理员专用）：客户越权负测必须直调该接口，路由重定向不能证明 API 拒绝
const REFERENCE_DOCUMENT_DETAIL_QUERY = `
  query ReferenceDocumentDetail($id: Int!) {
    referenceDocument(id: $id) { id title }
  }
`;

const CREATE_REFERENCE_DOCUMENT_MUTATION = `
  mutation CreateReferenceDocument($input: CreateReferenceDocumentInput!) {
    createReferenceDocument(input: $input) { id }
  }
`;

const UPDATE_REFERENCE_DOCUMENT_MUTATION = `
  mutation UpdateReferenceDocument($id: Int!, $input: UpdateReferenceDocumentInput!) {
    updateReferenceDocument(id: $id, input: $input) { id }
  }
`;

const SOFT_DELETE_REFERENCE_DOCUMENT_MUTATION = `
  mutation SoftDeleteReferenceDocument($id: Int!) {
    softDeleteReferenceDocument(id: $id) { id }
  }
`;

type GraphqlExtension = { code?: string; errorCode?: string };

/** 取 GraphQL 响应的首个错误扩展（无错误返回 undefined） */
function firstGraphqlExtension(body: unknown): GraphqlExtension | undefined {
  return (body as { errors?: Array<{ extensions?: GraphqlExtension }> }).errors?.[0]?.extensions;
}

/** 首个启用设备型号 ID（创建维修申请的真实外键目标；只读，取自与 API 同一库） */
function readFirstEnabledModelId(): number {
  const value = Number(
    mysqlQuery('SELECT id FROM equipment_model WHERE enabled = 1 ORDER BY id LIMIT 1'),
  );

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`启用设备型号读取异常：${JSON.stringify(value)}`);
  }

  return value;
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

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: '主导航' });
}

/** Node 侧真实创建维修申请（客户甲身份），返回数据库生成的主键与申请编号 */
async function createPr5RepairRequestViaApi(
  env: Record<string, string>,
  faultDescription: string,
): Promise<{ id: number; requestNo: string }> {
  const { body } = await realGraphqlCall(
    env,
    CREATE_REPAIR_REQUEST_MUTATION,
    {
      input: {
        equipmentModelId: readFirstEnabledModelId(),
        errorCode: 'E2E-PR5',
        faultDescription,
      },
    },
    CUSTOMER_LOGIN,
  );
  const created = (body as { data?: { createRepairRequest?: { id: number; requestNo: string } } })
    .data?.createRepairRequest;

  if (created === undefined) {
    throw new Error(`PR5 自建维修申请失败：${JSON.stringify(body)}`);
  }

  return created;
}

/** Node 侧真实接单（工程师身份） */
async function acceptPr5RepairRequestViaApi(
  env: Record<string, string>,
  id: number,
): Promise<void> {
  const { body } = await realGraphqlCall(
    env,
    ACCEPT_REPAIR_REQUEST_MUTATION,
    { id },
    ENGINEER_LOGIN,
  );
  const accepted = (body as { data?: { acceptRepairRequest?: { id: number } } }).data
    ?.acceptRepairRequest;

  if (accepted?.id !== id) {
    throw new Error(`PR5 真实接单失败：${JSON.stringify(body)}`);
  }
}

/** 真实登录后读取权威资料列表的全部 ID（S5-4/S5-5 可见性与不可见性断言） */
async function listPr5DocumentIds(
  env: Record<string, string>,
  loginName: string,
): Promise<number[]> {
  const { body } = await realGraphqlCall(
    env,
    REFERENCE_DOCUMENTS_QUERY,
    {
      filter: null,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 100, withTotal: true },
    },
    loginName,
  );
  const items = (body as { data?: { referenceDocuments?: { items?: Array<{ id: number }> } } }).data
    ?.referenceDocuments?.items;

  return (items ?? []).map((item) => item.id);
}

/** S5-9 脱敏拒绝回执（P2-3/D6-1）：仅字段化事实，不含 token / 密码 / headers */
interface Pr5DenialReceipt {
  readonly case: string;
  readonly role: string;
  readonly operation: string;
  readonly graphqlCode?: string;
  readonly errorCode?: string;
  readonly httpStatus?: number;
  readonly targetSnapshotHash?: string;
}

const denialReceipts: Pr5DenialReceipt[] = [];

/** 资料行快照的不可逆短摘要（回执中证明「拒绝后目标行未被改写」而不泄露字段原文） */
function hashPr5Snapshot(snapshot: string | null): string {
  return createHash('sha256')
    .update(snapshot ?? '<missing>')
    .digest('hex')
    .slice(0, 16);
}

/**
 * 统一执行「主链路 + 清理」并保留双错误（P2-1）：
 * - 两个都成功 → 正常返回；
 * - 仅一个失败 → 抛出该错误；
 * - 两个都失败 → 抛出 AggregateError，errors 同时携带主错误与清理错误（互不掩盖）。
 * 不使用 finally：finally 中若再抛错会覆盖主错误，且主错误抛出后其后的断言永不执行。
 */
async function runPr5Case(
  body: () => Promise<void>,
  cleanup: () => void | Promise<void>,
): Promise<void> {
  let primaryFailed = false;
  let primaryFailure: unknown;
  let cleanupFailed = false;
  let cleanupFailure: unknown;

  try {
    await body();
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  }

  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }

  if (primaryFailed && cleanupFailed) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      'PR5 用例主链路与清理同时失败：两个错误均保留在 errors 中',
    );
  }

  if (primaryFailed) {
    throw primaryFailure;
  }

  if (cleanupFailed) {
    throw cleanupFailure;
  }
}

/**
 * 二次运行可重入断言：本轮自建维修申请行已物理回收（清理前未创建则跳过）。
 * 独立函数承接可空入参，避免闭包内赋值导致外部控制流窄化失真。
 */
function expectPr5RepairRequestReclaimed(binding: Pr5RepairRequestBinding | null): void {
  if (binding === null) {
    return;
  }

  expect(
    Number(
      mysqlQuery(`SELECT COUNT(*) FROM repair_request WHERE request_no = '${binding.requestNo}'`),
    ),
  ).toBe(0);
}

/**
 * 本轮自建维修申请的物理回收（P1-1）：teardown 时**按当前库行重新读取整行快照**再删除——
 * 本轮自建行会被 UI 合法软删 / 接单 / 追加回复，创建时快照已不再等于当前行；
 * 用「主键 + 三因子 + 本轮回复集合」定位，但 WHERE 仍是当下完整行快照（口径不降低）。
 * 本轮回复集合按创建时捕捉的 ID 逐条用**当前库行**重建 7/7 完整绑定（父事务内会再逐条复核，
 * 删除前失败关闭），既保持「本轮集合精确」闭包，又不使用过期的创建时快照。行已不存在则幂等跳过。
 */
function reclaimPr5RepairRequestBound(binding: Pr5RepairRequestBinding | null): void {
  if (binding === null) {
    return;
  }

  const present = Number(
    mysqlQuery(`SELECT COUNT(*) FROM repair_request WHERE id = ${binding.id}`),
  );

  if (present === 0) {
    return;
  }

  deletePr5RepairRequestBound(
    readPr5RepairRequestBindingFromDb({
      customerAccountId: binding.customerAccountId,
      id: binding.id,
      requestNo: binding.requestNo,
      responses: binding.responses.map((response) =>
        readPr5EngineerResponseBindingById(response.id),
      ),
    }),
  );
}

/**
 * 本轮自建资料按精确 ID 物理回收（S4：编排抽取到共享 helper）：
 * 「全量预检 → 精确删行 → 按已核验引用删文件」由 cleanupPr5ReferenceDocumentsBound 完成，
 * 残留回执经 assertPr5CleanupReceiptClean 判红——任一行/文件残留即失败，绝不静默通过。
 *
 * P1-1：teardown 时**按当前库行重新读取整行快照**再删除（本轮自建资料可能已被 UI 合法编辑 /
 * 软删，创建时快照不再等于当前行）；行已不存在则跳过。禁止用部分字段绑定冒充完整行。
 */
function cleanupPr5Documents(adminAccountId: number, capturedIds: readonly number[]): void {
  const ids = new Set<number>(capturedIds);

  for (const id of findPr5ReferenceDocumentIdsByKeyword(DOC_KEYWORD)) {
    ids.add(id);
  }

  const bindings: Pr5ReferenceDocumentBinding[] = [];

  for (const id of ids) {
    if (Number(mysqlQuery(`SELECT COUNT(*) FROM reference_document WHERE id = ${id}`)) === 0) {
      continue;
    }

    bindings.push(
      readPr5ReferenceDocumentBindingFromDb({
        createdByAccountId: adminAccountId,
        id,
        titleKeyword: DOC_KEYWORD,
      }),
    );
  }

  if (bindings.length === 0) {
    return;
  }

  assertPr5CleanupReceiptClean(cleanupPr5ReferenceDocumentsBound(bindings));
}

test.describe('PR5 real link permission and business closure', () => {
  test.beforeAll(async () => {
    // S5-8：专用库 + 显式清理授权 + 唯一配置源（失败即硬失败，不 skip）
    assertPr5DedicatedEnvironment();
    // 业务写入前先证明 SQL helper 与真实 API 后端指向同一个独立 E2E 库
    await assertApiSqlSameDatabase();
    // 前置数据就绪（账号 / 型号 / 预置申请与回复 / 预置资料可见性）
    assertPr5SeedDataReady();
  });

  // -------------------------------------------------------------------------
  // S5-1 / S5-7：客户真实闭环（菜单与首页 → 创建 → 列表 → 详情 → 未接单删除）
  // -------------------------------------------------------------------------
  test('S5-1 客户真实闭环：首页入口创建、列表可见、详情可达、未接单删除并软删落库', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const env = readBackendEnv();
    const password = env.MOCK_SEED_PASSWORD;
    const customerAccountId = await realLoginAccountId(env, CUSTOMER_LOGIN);
    // S5-7：创建前主键快照（证明本轮自建行使用数据库生成的新主键）
    const primaryKeySnapshot = readPr5PrimaryKeySnapshot('repair_request');

    let binding: Pr5RepairRequestBinding | null = null;

    const browserRequestUrls: string[] = [];
    page.on('request', (request) => {
      browserRequestUrls.push(request.url());
    });

    await runPr5Case(
      async () => {
        await loginViaUi(page, CUSTOMER_LOGIN, password, CUSTOMER_HOME_PATH);

        // 菜单：客户可见「发起申请」「我的申请」，未见资料入口（S5-6 的角色过滤同源）
        await expect(mainNav(page).getByRole('link', { name: '发起申请' })).toBeVisible();
        await expect(mainNav(page).getByRole('link', { name: '我的申请' })).toBeVisible();

        // 首页即创建态（2026-09-29 整合工作台裁定）：页头「发起维修申请」入口始终保留，
        // create 态点击为 no-op（不跳转、不重复挂载、不清空输入）
        await expect(page.getByRole('heading', { name: '客户页面' })).toBeVisible();
        await page.locator('.page-header').getByRole('button', { name: '发起维修申请' }).click();
        await expect(page).toHaveURL(new RegExp(`${CUSTOMER_HOME_PATH}$`));

        // 真实创建：型号来自真实库，提交走真实受保护通道
        await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();
        await page.getByRole('combobox').first().click();
        // AntD Select 的选项由 rc-virtual-list 渲染，开启动画与虚拟列表测量期间选项节点会反复重建，
        // 直接 click 选项会出现「element is not stable → element was detached from the DOM」并耗尽用例超时
        // （本轮视频跑曾实测复现 1 次）。改为键盘确认当前高亮项（AntD defaultActiveFirstOption 默认高亮首项），
        // 语义与「点选第一项」等价且不依赖选项节点几何稳定性；随后按首项 title 断言选择确已生效。
        const firstModelLabel =
          (await page.locator('.ant-select-item-option').first().getAttribute('title')) ?? '';
        expect(firstModelLabel).not.toBe('');
        await page.keyboard.press('Enter');
        await expect(page.locator('.ant-select-content')).toContainText(firstModelLabel);
        await page.getByLabel('设备错误码').fill('E2E-PR5-S5');
        await page.getByLabel('故障描述').fill(`未接单删除链路：${FAULT_TAG}`);
        await page.getByRole('button', { name: '提交申请' }).click();

        await expect(page.getByText('维修申请创建成功')).toBeVisible();
        const requestNo =
          (await page.getByText(/申请编号：/).textContent())?.replace('申请编号：', '').trim() ??
          '';
        expect(requestNo).toMatch(REQUEST_NO_PATTERN);

        // S5-7：落库主键由数据库生成（不命中创建前快照）
        const generatedId = Number(findRepairRequestByRequestNo(requestNo, 'id'));
        assertPr5GeneratedId(generatedId, primaryKeySnapshot, '维修申请');
        binding = readPr5RepairRequestBindingFromDb({
          customerAccountId,
          id: generatedId,
          requestNo,
          responses: [],
        });

        // 成功反馈 → 详情（2026-09-29 起直达该申请详情路由）：新申请按 createdAt DESC 置顶，
        // 左栏条目应为待接单
        await page.getByRole('button', { name: '查看维修申请' }).click();
        await expect(page).toHaveURL(new RegExp(`${CUSTOMER_LIST_PATH}/${generatedId}$`));
        const createdItem = page.locator('.activity-item').filter({ hasText: requestNo });
        await expect(createdItem).toHaveCount(1);
        await expect(createdItem.getByText('待接单')).toBeVisible();

        // 详情：字段来自后端真实载荷（右栏详情面板接单状态为待接单）
        await expect(
          page.locator('.customer-workspace-detail-pane').getByText('待接单'),
        ).toBeVisible();
        await expect(page.getByText(requestNo).first()).toBeVisible();
        await expect(page.getByText(`未接单删除链路：${FAULT_TAG}`).first()).toBeVisible();

        // S6 视频序列：详情态点击页头「发起维修申请」→ 恢复默认创建态（页头不卸载、表单可用）
        await page.locator('.page-header').getByRole('button', { name: '发起维修申请' }).click();
        await expect(page).toHaveURL(new RegExp(`${CUSTOMER_HOME_PATH}$`));
        await expect(page.getByRole('button', { name: '提交申请' })).toBeVisible();

        // S6 视频序列：经侧栏「我的申请」重回历史态，点击条目返回该申请详情
        await mainNav(page).getByRole('link', { name: '我的申请' }).click();
        await expect(page).toHaveURL(new RegExp(`${CUSTOMER_LIST_PATH}$`));
        const detailEntry = page
          .locator('.activity-item')
          .filter({ hasText: requestNo })
          .locator('.customer-workspace-item-main');
        await expect(detailEntry).toBeVisible();
        await detailEntry.click();
        await expect(page).toHaveURL(new RegExp(`${CUSTOMER_LIST_PATH}/${generatedId}$`));

        // 未接单：详情页保留删除入口 → 二次确认 → 回列表
        //（左栏条目删除按钮的 accessible name 为「删除申请 {编号}」，详情入口用 exact 精确匹配）
        await expect(page.getByRole('button', { name: '删除申请', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '删除申请', exact: true }).click();
        await page.getByRole('button', { name: '确认删除' }).click();
        await expect(page.getByText('维修申请已删除。')).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`${CUSTOMER_LIST_PATH}$`));
        await expect(page.locator('.activity-item').filter({ hasText: requestNo })).toHaveCount(0);

        // S5-1/S5-7 落库证据：软删除（deprecated=1 且 deleted_at 非空）、未接单标记不变
        expect(readPr5RepairRequestState(requestNo, customerAccountId)).toEqual({
          deletedAtIsNotNull: '1',
          deprecated: '1',
          isAccepted: '0',
        });

        // 回到首页（菜单路径可用）
        await mainNav(page).getByRole('link', { name: '首页' }).click();
        await expect(page.getByRole('heading', { name: '客户页面' })).toBeVisible();

        assertBrowserRequestsBoundToDedicatedOrigins(browserRequestUrls);
      },
      () => {
        reclaimPr5RepairRequestBound(binding);
      },
    );

    // 二次运行可重入：本轮自建行已物理回收
    expectPr5RepairRequestReclaimed(binding);
  });

  // -------------------------------------------------------------------------
  // S5-2：已接单不提供删除入口，直调 Mutation 拒绝且数据不变
  // -------------------------------------------------------------------------
  test('S5-2 已接单申请：UI 无删除入口，直调删除被 CONFLICT 拒绝且数据不变', async ({ page }) => {
    test.setTimeout(120_000);
    const env = readBackendEnv();
    const customerAccountId = await realLoginAccountId(env, CUSTOMER_LOGIN);
    const primaryKeySnapshot = readPr5PrimaryKeySnapshot('repair_request');

    let binding: Pr5RepairRequestBinding | null = null;

    await runPr5Case(
      async () => {
        const created = await createPr5RepairRequestViaApi(env, `已接单拒绝链路：${FAULT_TAG}`);
        assertPr5GeneratedId(created.id, primaryKeySnapshot, '维修申请');
        binding = readPr5RepairRequestBindingFromDb({
          customerAccountId,
          id: created.id,
          requestNo: created.requestNo,
          responses: [],
        });

        // 真实接单（工程师身份）
        await acceptPr5RepairRequestViaApi(env, created.id);
        expect(readPr5RepairRequestState(created.requestNo, customerAccountId)).toEqual({
          deletedAtIsNotNull: '0',
          deprecated: '0',
          isAccepted: '1',
        });

        // 已接单后 UI：详情呈现已接单，且无任何删除入口
        //（左栏条目同 pill 文案，状态断言限定右栏详情面板避免多节点歧义）
        await loginViaUi(page, CUSTOMER_LOGIN, env.MOCK_SEED_PASSWORD, CUSTOMER_HOME_PATH);
        await page.goto(`${CUSTOMER_LIST_PATH}/${created.id}`);
        await expect(page.getByText(created.requestNo).first()).toBeVisible();
        await expect(
          page.locator('.customer-workspace-detail-pane').getByText('已接单', { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: '删除申请', exact: true })).toHaveCount(0);

        // 直调 Mutation 探测：CONFLICT + 固定业务码，且行状态未被改动
        const stateBeforeDelete = readPr5RepairRequestState(created.requestNo, customerAccountId);
        const denied = await realGraphqlCall(
          env,
          DELETE_MY_REPAIR_REQUEST_MUTATION,
          { id: created.id },
          CUSTOMER_LOGIN,
        );
        const extension = firstGraphqlExtension(denied.body);

        expect(extension?.code).toBe('CONFLICT');
        expect(extension?.errorCode).toBe('REPAIR_REQUEST_ALREADY_ACCEPTED');
        expect(readPr5RepairRequestState(created.requestNo, customerAccountId)).toEqual(
          stateBeforeDelete,
        );

        // S5-9 脱敏拒绝回执：只落字段化事实与目标快照的不可逆摘要
        denialReceipts.push({
          case: 'S5-2',
          errorCode: extension?.errorCode,
          graphqlCode: extension?.code,
          operation: 'deleteMyRepairRequest',
          role: 'CUSTOMER',
          targetSnapshotHash: hashPr5Snapshot(JSON.stringify(stateBeforeDelete)),
        });
      },
      () => {
        reclaimPr5RepairRequestBound(binding);
      },
    );
  });

  // -------------------------------------------------------------------------
  // S5-3：无回复时整个回复模块不存在；有回复时内容 / 工程师 / 状态齐备
  // -------------------------------------------------------------------------
  test('S5-3 无回复不渲染回复模块，有回复展示工程师、状态与正文', async ({ page }) => {
    test.setTimeout(150_000);
    const env = readBackendEnv();
    const customerAccountId = await realLoginAccountId(env, CUSTOMER_LOGIN);
    const primaryKeySnapshot = readPr5PrimaryKeySnapshot('repair_request');
    const responseText = `真实回复正文·${RUN_ID}`;

    let binding: Pr5RepairRequestBinding | null = null;

    await runPr5Case(
      async () => {
        const created = await createPr5RepairRequestViaApi(env, `回复模块链路：${FAULT_TAG}`);
        assertPr5GeneratedId(created.id, primaryKeySnapshot, '维修申请');
        const createdBinding = readPr5RepairRequestBindingFromDb({
          customerAccountId,
          id: created.id,
          requestNo: created.requestNo,
          responses: [],
        });

        binding = createdBinding;

        // D1-1 消费：Seed 预置「已接单且有回复」申请作为真实数据正控（只读，不写入）
        expect(
          Number(
            mysqlQuery(
              `SELECT COUNT(*) FROM engineer_response WHERE request_id = (SELECT id FROM repair_request WHERE request_no = '${PR5_SEED_ACCEPTED_REQUEST_NO}')`,
            ),
          ),
        ).toBeGreaterThanOrEqual(1);

        // 无回复：回复模块整体不存在（无标题、无计数、无占位），未接单删除入口仍在
        await loginViaUi(page, CUSTOMER_LOGIN, env.MOCK_SEED_PASSWORD, CUSTOMER_HOME_PATH);
        await page.goto(`${CUSTOMER_LIST_PATH}/${created.id}`);
        await expect(page.getByText(created.requestNo).first()).toBeVisible();
        await expect(
          page.locator('.customer-workspace-detail-pane').getByText(/工程师回复/),
        ).toHaveCount(0);
        await expect(page.getByText(/暂无工程师回复/)).toHaveCount(0);
        // 未接单详情只剩「故障描述」与「故障正文」两块内容区（DataCard 之外）
        await expect(
          page.locator('.customer-workspace-detail-pane section:not(.data-card)'),
        ).toHaveCount(2);
        await expect(page.getByRole('button', { name: '删除申请', exact: true })).toBeVisible();

        // 真实接单 + 真实回复（Node 侧，工程师身份）
        await acceptPr5RepairRequestViaApi(env, created.id);
        const responseCall = await realGraphqlCall(
          env,
          CREATE_ENGINEER_RESPONSE_MUTATION,
          { input: { requestId: created.id, resolutionStatus: 'PENDING', responseText } },
          ENGINEER_LOGIN,
        );
        const response = (
          responseCall.body as {
            data?: { createEngineerResponse?: { id: number; engineerNickname: string } };
          }
        ).data?.createEngineerResponse;

        if (response === undefined) {
          throw new Error(`PR5 真实回复失败：${JSON.stringify(responseCall.body)}`);
        }

        // P1-3：记录本轮回复**完整绑定**（读回 7/7 整行快照），清理时父事务逐条按完整快照复核后删除
        binding = {
          ...createdBinding,
          responses: [readPr5EngineerResponseBindingById(response.id)],
        };

        // 有回复：计数、工程师昵称、状态标签与正文全部可见；已接单故无删除入口
        //（接单后详情头部与回复条目可能同显「处理中」，取首个）
        await page.reload();
        await expect(page.getByText(/工程师回复（1）/)).toBeVisible();
        await expect(page.getByText(response.engineerNickname).first()).toBeVisible();
        await expect(page.getByText('处理中').first()).toBeVisible();
        await expect(page.getByText(responseText)).toBeVisible();
        await expect(page.getByRole('button', { name: '删除申请', exact: true })).toHaveCount(0);
      },
      () => {
        reclaimPr5RepairRequestBound(binding);
      },
    );
  });

  // -------------------------------------------------------------------------
  // S5-4 / S5-7：管理员资料闭环（UI 上传 → 列表 → 详情 → 下载 → 编辑 → 软删不可见）
  // -------------------------------------------------------------------------
  test('S5-4 管理员资料闭环：上传、列表、详情、下载、编辑、软删后不可见', async ({ page }) => {
    test.setTimeout(180_000);
    const env = readBackendEnv();
    const adminAccountId = await realLoginAccountId(env, ADMIN_LOGIN);
    const primaryKeySnapshot = readPr5PrimaryKeySnapshot('reference_document');
    const originalTitle = `${DOC_KEYWORD}（管理员上传）`;
    const editedTitle = `${DOC_KEYWORD}（管理员上传·已改）`;

    const capturedIds: number[] = [];

    const browserRequestUrls: string[] = [];
    page.on('request', (request) => {
      browserRequestUrls.push(request.url());
    });

    await runPr5Case(
      async () => {
        await loginViaUi(page, ADMIN_LOGIN, env.MOCK_SEED_PASSWORD, '/admin');

        // 菜单入口 → 列表页
        await expect(mainNav(page).getByRole('link', { name: '参考资料' })).toBeVisible();
        await mainNav(page).getByRole('link', { name: '参考资料' }).click();
        await expect(page).toHaveURL(new RegExp(DOCUMENT_LIST_PATH));
        await expect(page.getByRole('heading', { name: '参考资料库' })).toBeVisible();

        // 软删的 seed 资料在正常列表中不可见（同一不可见口径的既有基线）
        expect(await listPr5DocumentIds(env, ADMIN_LOGIN)).not.toContain(
          SEED_SOFT_DELETED_DOCUMENT_ID,
        );

        // 新增页：文件名/标题就绪后再填表（避免 URL 先行变更时的子串命中）
        await page.getByRole('button', { name: '新增资料' }).click();
        await expect(page).toHaveURL(new RegExp(`${DOCUMENT_NEW_PATH}`));
        await expect(page.getByRole('heading', { name: '新增参考资料' })).toBeVisible();
        await page.getByLabel('文档标题', { exact: true }).fill(originalTitle);
        await page.getByRole('combobox').nth(0).click();
        await page.locator('.ant-select-item-option', { hasText: '检查表' }).click();
        await page.setInputFiles('input[type="file"]', {
          buffer: Buffer.from(UPLOAD_BYTES),
          mimeType: 'text/markdown',
          name: UPLOAD_FILENAME,
        });
        await expect(page.getByText(UPLOAD_FILENAME)).toBeVisible();
        await page.getByRole('button', { name: /创建资料/ }).click();

        // 成功后进详情：从 URL 捕获本轮精确 ID
        await expect(page.getByText('参考资料创建成功')).toBeVisible();
        await page.getByRole('button', { name: '查看详情' }).click();
        await expect(page).toHaveURL(/\/reference-documents\/\d+$/);
        const createdIdMatch = page.url().match(/\/reference-documents\/(\d+)$/);

        expect(createdIdMatch).not.toBeNull();
        const documentId = Number(createdIdMatch?.[1]);
        capturedIds.push(documentId);
        // S5-7：资料主键由数据库生成（不命中创建前快照）
        assertPr5GeneratedId(documentId, primaryKeySnapshot, '参考资料');

        // 详情：标题、原始文件名与下载入口
        await expect(page.getByRole('heading', { name: '参考资料详情' })).toBeVisible();
        await expect(page.getByText(originalTitle).first()).toBeVisible();
        await expect(page.getByText(UPLOAD_FILENAME).first()).toBeVisible();

        // 浏览器真实下载：文件名与字节与上传一致
        const downloadPromise = page.waitForEvent('download');

        await page.getByRole('button', { name: /下载文件/ }).click();

        const download = await downloadPromise;

        expect(download.suggestedFilename()).toBe(UPLOAD_FILENAME);
        expect(new Uint8Array(readFileSync(await download.path()))).toEqual(UPLOAD_BYTES);

        // Node 侧 REST 下载（管理员身份）：状态、Content-Type 与字节
        const restDownload = await realRestDownload(env, documentId, ADMIN_LOGIN);

        expect(restDownload.status).toBe(200);
        expect(restDownload.contentType).toBe('text/markdown');
        expect(new Uint8Array(restDownload.buffer)).toEqual(UPLOAD_BYTES);

        // 列表可见（按原始文件名定位）
        await page.goto(DOCUMENT_LIST_PATH);
        await expect(page.getByText(UPLOAD_FILENAME)).toBeVisible();

        // 编辑：改标题后详情回显新标题
        await page.goto(`/reference-documents/${documentId}`);
        await page.getByRole('button', { name: /编\s*辑/ }).click();
        await page.getByLabel('文档标题', { exact: true }).fill(editedTitle);
        await page.getByRole('button', { name: /保存修改/ }).click();
        await expect(page.getByText('参考资料已保存。')).toBeVisible();
        await expect(page.getByText(editedTitle).first()).toBeVisible();

        // 软删：二次确认 → 回列表且该行不可见
        await page.getByRole('button', { name: '删 除' }).click();
        await page.getByRole('button', { name: '确认删除' }).click();
        await expect(page.getByText('参考资料已删除。')).toBeVisible();
        await expect(page).toHaveURL(new RegExp(DOCUMENT_LIST_PATH));
        await expect(page.getByText(editedTitle)).toHaveCount(0);

        // DB 级证据：软删标记落库；且权威列表接口不再返回该 ID
        expect(readPr5ReferenceDocumentDeprecatedById(documentId)).toBe('1');
        expect(await listPr5DocumentIds(env, ADMIN_LOGIN)).not.toContain(documentId);

        // D3-1：软删资料的 REST 下载口径（软删 → NOT_FOUND / FILE_NOT_AVAILABLE → 404）
        expect((await realRestDownload(env, documentId, ADMIN_LOGIN)).status).toBe(404);

        assertBrowserRequestsBoundToDedicatedOrigins(browserRequestUrls);
      },
      () => cleanupPr5Documents(adminAccountId, capturedIds),
    );
  });

  // -------------------------------------------------------------------------
  // S5-5：工程师读链路通过、写入口与写接口全拒绝
  // -------------------------------------------------------------------------
  test('S5-5 工程师只读：列表/搜索/筛选/详情/下载通过，写入口与写接口全拒绝', async ({ page }) => {
    test.setTimeout(180_000);
    const env = readBackendEnv();
    const adminAccountId = await realLoginAccountId(env, ADMIN_LOGIN);
    const primaryKeySnapshot = readPr5PrimaryKeySnapshot('reference_document');
    const title = `${DOC_KEYWORD}（工程师只读）`;

    const capturedIds: number[] = [];

    await runPr5Case(
      async () => {
        // 以管理员身份经 REST 上传本轮验收资料（工程师写接口必须先被拒绝，故不能由工程师创建）
        const upload = await realRestUpload(
          env,
          { bytes: UPLOAD_BYTES, contentType: 'text/markdown', name: UPLOAD_FILENAME },
          { documentType: 'CHECKLIST', title },
          ADMIN_LOGIN,
        );

        expect(upload.status).toBe(201);
        // REST 成功响应经后端统一信封包装（format-response.middleware：{ success, data, requestId, host }），
        // 业务载荷在 data 内，故资料 ID 取自 body.data.id
        const uploadedId = (upload.body as { data?: { id?: unknown } } | null)?.data?.id;

        if (typeof uploadedId !== 'number') {
          throw new Error(`PR5 管理员 REST 上传未返回资料 ID：${JSON.stringify(upload.body)}`);
        }

        const documentId = uploadedId;

        assertPr5GeneratedId(documentId, primaryKeySnapshot, '参考资料');
        capturedIds.push(documentId);

        // 工程师真实登录 → 菜单 → 列表
        await loginViaUi(page, ENGINEER_LOGIN, env.MOCK_SEED_PASSWORD, '/engineer');
        await expect(mainNav(page).getByRole('link', { name: '参考资料' })).toBeVisible();
        await mainNav(page).getByRole('link', { name: '参考资料' }).click();
        await expect(page.getByRole('heading', { name: '参考资料库' })).toBeVisible();

        // 标题搜索（防抖后重载）：本轮资料可见
        await page.getByLabel('按文档标题搜索').fill(DOC_KEYWORD);
        await expect(page.getByText(title).first()).toBeVisible();

        // 类型筛选：命中本轮资料；清空后仍可见
        // 独立资料列表页的筛选区自 2f7d247 起默认收起（与原型 gkj 一致），需先展开再操作。
        await page.locator('.reference-library-toolbar-button').click();
        await expect(page.locator('.reference-library-filter-panel')).toBeVisible();
        await page.getByRole('combobox').nth(0).click();
        await page.locator('.ant-select-item-option', { hasText: '检查表' }).click();
        await expect(page.getByText(title).first()).toBeVisible();
        await page.getByRole('combobox').nth(0).hover();
        await page.locator('.ant-select-clear').click();
        await expect(page.getByText(title).first()).toBeVisible();

        // 详情只读：无编辑 / 无删除入口，下载入口可见且可用
        await page.getByText(title).first().click();
        await expect(page.getByRole('heading', { name: '参考资料详情' })).toBeVisible();
        await expect(page.getByText(title).first()).toBeVisible();
        await expect(page.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '删 除' })).toHaveCount(0);

        const downloadPromise = page.waitForEvent('download');

        await page.getByRole('button', { name: /下载文件/ }).click();

        const download = await downloadPromise;

        expect(download.suggestedFilename()).toBe(UPLOAD_FILENAME);
        expect(new Uint8Array(readFileSync(await download.path()))).toEqual(UPLOAD_BYTES);

        // 写入口：新增页被角色拒绝清单拦截，安全跳回工程师主页
        await page.goto(DOCUMENT_NEW_PATH);
        await expect(page).toHaveURL(/\/engineer$/);

        // 写接口全拒绝：GraphQL 三个写 Mutation + REST 上传
        const createDenied = await realGraphqlCall(
          env,
          CREATE_REFERENCE_DOCUMENT_MUTATION,
          {
            input: {
              contentText: '越权探测正文',
              description: null,
              documentType: 'CHECKLIST',
              equipmentModelId: null,
              title: `${DOC_KEYWORD}（工程师越权）`,
            },
          },
          ENGINEER_LOGIN,
        );
        expect(firstGraphqlExtension(createDenied.body)?.code).toBe('FORBIDDEN');
        denialReceipts.push({
          case: 'S5-5',
          graphqlCode: firstGraphqlExtension(createDenied.body)?.code,
          operation: 'createReferenceDocument',
          role: 'ENGINEER',
        });

        // D2-1/P2-3：update 被拒后目标行整行字段快照必须逐字不变（防「先改写后抛错」回归）
        const snapshotBeforeUpdate = readPr5ReferenceDocumentSnapshot(documentId);
        const updateDenied = await realGraphqlCall(
          env,
          UPDATE_REFERENCE_DOCUMENT_MUTATION,
          { id: documentId, input: { title: `${DOC_KEYWORD}（工程师越权改）` } },
          ENGINEER_LOGIN,
        );
        expect(firstGraphqlExtension(updateDenied.body)?.code).toBe('FORBIDDEN');
        const snapshotAfterUpdate = readPr5ReferenceDocumentSnapshot(documentId);

        expect(snapshotAfterUpdate).not.toBeNull();
        expect(snapshotAfterUpdate).toEqual(snapshotBeforeUpdate);
        denialReceipts.push({
          case: 'S5-5',
          graphqlCode: firstGraphqlExtension(updateDenied.body)?.code,
          operation: 'updateReferenceDocument',
          role: 'ENGINEER',
          targetSnapshotHash: hashPr5Snapshot(snapshotAfterUpdate),
        });

        const snapshotBeforeSoftDelete = readPr5ReferenceDocumentSnapshot(documentId);
        const softDeleteDenied = await realGraphqlCall(
          env,
          SOFT_DELETE_REFERENCE_DOCUMENT_MUTATION,
          { id: documentId },
          ENGINEER_LOGIN,
        );
        expect(firstGraphqlExtension(softDeleteDenied.body)?.code).toBe('FORBIDDEN');
        expect(readPr5ReferenceDocumentSnapshot(documentId)).toEqual(snapshotBeforeSoftDelete);
        denialReceipts.push({
          case: 'S5-5',
          graphqlCode: firstGraphqlExtension(softDeleteDenied.body)?.code,
          operation: 'softDeleteReferenceDocument',
          role: 'ENGINEER',
          targetSnapshotHash: hashPr5Snapshot(snapshotBeforeSoftDelete),
        });

        const engineerUploadDenied = await realRestUpload(
          env,
          { bytes: UPLOAD_BYTES, contentType: 'text/markdown', name: UPLOAD_FILENAME },
          { documentType: 'CHECKLIST', title: `${DOC_KEYWORD}（工程师越权上传）` },
          ENGINEER_LOGIN,
        );
        expect(engineerUploadDenied.status).toBe(403);
        denialReceipts.push({
          case: 'S5-5',
          httpStatus: engineerUploadDenied.status,
          operation: 'POST /api/reference-documents/upload',
          role: 'ENGINEER',
        });

        // 读接口与下载仍放行：越权写全部未落库，资料未被改动、未被软删
        const engineerDownload = await realRestDownload(env, documentId, ENGINEER_LOGIN);

        expect(engineerDownload.status).toBe(200);
        expect(new Uint8Array(engineerDownload.buffer)).toEqual(UPLOAD_BYTES);

        expect(readPr5ReferenceDocumentDeprecatedById(documentId)).toBe('0');
        expect(await listPr5DocumentIds(env, ENGINEER_LOGIN)).toContain(documentId);
        expect(await listPr5DocumentIds(env, ENGINEER_LOGIN)).not.toContain(
          SEED_SOFT_DELETED_DOCUMENT_ID,
        );
        // 越权新建未落库：不存在本轮关键字下的「工程师越权」资料行
        // （GraphQL 越权新建与 REST 越权上传的标题均以此前缀开头；前缀经白名单 helper 校验）
        expect(countPr5ReferenceDocumentsByTitlePrefix(`${DOC_KEYWORD}（工程师越权`)).toBe(0);
      },
      () => cleanupPr5Documents(adminAccountId, capturedIds),
    );
  });

  // -------------------------------------------------------------------------
  // S5-6：客户无资料菜单，直达被安全重定向，GraphQL 读写与 REST 上传/下载全拒绝
  // -------------------------------------------------------------------------
  test('S5-6 客户越权：无资料菜单、直达安全重定向、读写与上传下载全拒绝', async ({ page }) => {
    test.setTimeout(120_000);
    const env = readBackendEnv();

    await loginViaUi(page, CUSTOMER_LOGIN, env.MOCK_SEED_PASSWORD, CUSTOMER_HOME_PATH);

    // 无资料菜单（角色可见性过滤）
    await expect(mainNav(page).getByRole('link', { name: '参考资料' })).toHaveCount(0);

    // 直达 list / new / detail 一律被安全重定向回客户主页
    for (const path of [
      DOCUMENT_LIST_PATH,
      DOCUMENT_NEW_PATH,
      `${DOCUMENT_LIST_PATH}/${SEED_VISIBLE_DOCUMENT_ID}`,
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${CUSTOMER_HOME_PATH}$`));
    }

    // GraphQL：读与写全部 FORBIDDEN
    const readDenied = await realGraphqlCall(
      env,
      REFERENCE_DOCUMENTS_QUERY,
      { filter: null, pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true } },
      CUSTOMER_LOGIN,
    );
    expect(firstGraphqlExtension(readDenied.body)?.code).toBe('FORBIDDEN');
    denialReceipts.push({
      case: 'S5-6',
      graphqlCode: firstGraphqlExtension(readDenied.body)?.code,
      operation: 'referenceDocuments',
      role: 'CUSTOMER',
    });

    // P2-3：客户直调单条详情读（referenceDocument(id)）——路由重定向不能证明 API 详情读被拒
    const detailReadDenied = await realGraphqlCall(
      env,
      REFERENCE_DOCUMENT_DETAIL_QUERY,
      { id: SEED_VISIBLE_DOCUMENT_ID },
      CUSTOMER_LOGIN,
    );
    expect(firstGraphqlExtension(detailReadDenied.body)?.code).toBe('FORBIDDEN');
    denialReceipts.push({
      case: 'S5-6',
      graphqlCode: firstGraphqlExtension(detailReadDenied.body)?.code,
      operation: 'referenceDocument',
      role: 'CUSTOMER',
    });

    const createDenied = await realGraphqlCall(
      env,
      CREATE_REFERENCE_DOCUMENT_MUTATION,
      {
        input: {
          contentText: '客户越权探测正文',
          description: null,
          documentType: 'CHECKLIST',
          equipmentModelId: null,
          title: `${DOC_KEYWORD}（客户越权）`,
        },
      },
      CUSTOMER_LOGIN,
    );
    expect(firstGraphqlExtension(createDenied.body)?.code).toBe('FORBIDDEN');
    denialReceipts.push({
      case: 'S5-6',
      graphqlCode: firstGraphqlExtension(createDenied.body)?.code,
      operation: 'createReferenceDocument',
      role: 'CUSTOMER',
    });

    // D2-1/P2-3：update 被拒后 seed 目标行整行字段快照必须逐字不变
    const seedSnapshotBeforeUpdate = readPr5ReferenceDocumentSnapshot(SEED_VISIBLE_DOCUMENT_ID);
    const updateDenied = await realGraphqlCall(
      env,
      UPDATE_REFERENCE_DOCUMENT_MUTATION,
      { id: SEED_VISIBLE_DOCUMENT_ID, input: { title: `${DOC_KEYWORD}（客户越权改）` } },
      CUSTOMER_LOGIN,
    );
    expect(firstGraphqlExtension(updateDenied.body)?.code).toBe('FORBIDDEN');
    const seedSnapshotAfterUpdate = readPr5ReferenceDocumentSnapshot(SEED_VISIBLE_DOCUMENT_ID);

    expect(seedSnapshotAfterUpdate).not.toBeNull();
    expect(seedSnapshotAfterUpdate).toEqual(seedSnapshotBeforeUpdate);
    denialReceipts.push({
      case: 'S5-6',
      graphqlCode: firstGraphqlExtension(updateDenied.body)?.code,
      operation: 'updateReferenceDocument',
      role: 'CUSTOMER',
      targetSnapshotHash: hashPr5Snapshot(seedSnapshotAfterUpdate),
    });

    const seedSnapshotBeforeSoftDelete = readPr5ReferenceDocumentSnapshot(SEED_VISIBLE_DOCUMENT_ID);
    const softDeleteDenied = await realGraphqlCall(
      env,
      SOFT_DELETE_REFERENCE_DOCUMENT_MUTATION,
      { id: SEED_VISIBLE_DOCUMENT_ID },
      CUSTOMER_LOGIN,
    );
    expect(firstGraphqlExtension(softDeleteDenied.body)?.code).toBe('FORBIDDEN');
    expect(readPr5ReferenceDocumentSnapshot(SEED_VISIBLE_DOCUMENT_ID)).toEqual(
      seedSnapshotBeforeSoftDelete,
    );
    denialReceipts.push({
      case: 'S5-6',
      graphqlCode: firstGraphqlExtension(softDeleteDenied.body)?.code,
      operation: 'softDeleteReferenceDocument',
      role: 'CUSTOMER',
      targetSnapshotHash: hashPr5Snapshot(seedSnapshotBeforeSoftDelete),
    });

    // REST：上传与下载均 403（守卫先于业务与文件读取）
    const uploadDenied = await realRestUpload(
      env,
      { bytes: UPLOAD_BYTES, contentType: 'text/markdown', name: UPLOAD_FILENAME },
      { documentType: 'CHECKLIST', title: `${DOC_KEYWORD}（客户越权上传）` },
      CUSTOMER_LOGIN,
    );
    expect(uploadDenied.status).toBe(403);
    denialReceipts.push({
      case: 'S5-6',
      httpStatus: uploadDenied.status,
      operation: 'POST /api/reference-documents/upload',
      role: 'CUSTOMER',
    });

    const downloadDenied = await realRestDownload(env, SEED_VISIBLE_DOCUMENT_ID, CUSTOMER_LOGIN);
    expect(downloadDenied.status).toBe(403);
    denialReceipts.push({
      case: 'S5-6',
      httpStatus: downloadDenied.status,
      operation: 'GET /api/reference-documents/:id/download',
      role: 'CUSTOMER',
    });

    // 越权写全部未落库：seed 行状态不变，且无本轮关键字的自建行
    expect(readPr5ReferenceDocumentDeprecatedById(SEED_VISIBLE_DOCUMENT_ID)).toBe('0');
    expect(findPr5ReferenceDocumentIdsByKeyword(DOC_KEYWORD)).toEqual([]);
  });

  // S5-9：脱敏拒绝回执（P2-3/D6-1）——单个 JSON 块，仅字段化事实，无 token / 密码 / headers
  test.afterAll(() => {
    console.log(`PR5_DENIAL_RECEIPTS=${JSON.stringify(denialReceipts)}`);
  });
});

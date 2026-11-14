// e2e/admin-document-database-real.spec.ts
// 管理员文档数据库真实后端 e2e（PR3 S4 计划表 S4.5）。
//
// 数据基础：backend seed 预置数据（只读断言）——维修申请 920001~920005
//（920004 已软删不可见）、AI 会话 930001~930003（930002 进行中，含消息
// 940006~940011，SYSTEM/USER/ASSISTANT/TOOL 三轮完整覆盖）、AI 报告
// 950001~950002、参考资料 970001~970003（970002 含下载入口）。
// 分页用例以本次运行唯一故障码（RUN_ID）自建 12 行跑满两页，try 从首笔写入前
// 开始、逐笔记录创建响应的精确 ID 与编号（连同本轮输入事实形成目标记录），finally 经
// deleteMyRepairRequest 逐 ID 幂等软删（清理失败归并进 primaryError 让测试转红）；
// 共享开发库不做物理删除（与 reference-document-real.spec 同一安全边界），仅当目标库严格为
// lithography_e2e 且显式授权物理清理时，才按同一批精确 ID 物理删除，避免残留污染官方 Mock Seed。
// 前提不满足（无本地后端 / 无 env / 无前端真实通道）时用例自动跳过，不阻塞。
//
// 断言作用域注意：Tabs 非激活面板保持挂载（仅隐藏），因此所有标签内
// 定位一律收口到 .ant-tabs-tabpane-active（激活面板），Drawer 内容经
// portal 渲染在面板外，单独用 getByRole('dialog') 收口（AntD v6 无内容类）。

import { expect, type Page, test } from '@playwright/test';

import {
  deleteRepairRequestRowsByIds,
  isPhysicalCleanupEnabled,
  readBackendEnv,
  realGraphqlCall,
  realLoginAccountId,
  REQUEST_NO_PATTERN,
  resolveRealBackendPrerequisite,
} from './helpers/real-backend';

const PAGE_PATH = '/admin/document-database';

// ---- seed 行（backend/scripts/seed-mock.ts，只读断言） ----

/** 申请编号筛选关键字：只命中 5 行 seed（后端生成编号格式不同，不可能撞） */
const SEED_REQUEST_KEYWORD = 'MOCK-RR-2026';
const SEED_VISIBLE_REQUEST_NOS = [
  'MOCK-RR-2026-0001',
  'MOCK-RR-2026-0002',
  'MOCK-RR-2026-0003',
  'MOCK-RR-2026-0005',
] as const;
const SEED_DELETED_REQUEST_NO = 'MOCK-RR-2026-0004';
const SEED_ACTIVE_CONVERSATION_REQUEST_NO = 'MOCK-RR-2026-0003'; // 会话 930002（ACTIVE）
const SEED_FAULT_DIAGNOSIS_REPORT_TITLE = 'E-LASER-207 故障诊断报告'; // 950001
const SEED_INTERIM_REPORT_TITLE = '扫描台位置误差阶段性分析'; // 950002

// ---- 分页夹具（本次运行唯一，清理以它为反查边界） ----

/** 本次运行唯一标识：并入故障码，跨运行/并行执行永不撞名 */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const RUN_ERROR_CODE = `E2EADM-${RUN_ID}`;
const RUN_REQUEST_COUNT = 12; // pageSize 10 → 第 1 页 10 行 + 第 2 页 2 行

/** 第 index 笔自建行的故障描述：本轮输入事实，一并与创建响应记录形成清理目标 */
function runFaultDescription(index: number): string {
  return `PR3 S4 分页夹具 #${index + 1}`;
}

/**
 * 本次运行自建行的清理目标记录：id / requestNo 取创建响应，faultDescription 取本轮输入。
 * 物理清理的预期事实一律来自这里，不回读目标行（否则核验退化为自证）。
 */
type CreatedRunRequest = {
  id: number;
  requestNo: string;
  faultDescription: string;
};

// ---- GraphQL（Node 侧夹具准备 / 清理 / 对照） ----

const STATS_QUERY = `
  query AdminDocumentDatabaseStatsE2E {
    adminDocumentDatabaseStats {
      repairRequestTotal
      referenceDocumentTotal
      aiConversationTotal
      aiReportTotal
    }
  }
`;

const ADMIN_REPAIR_LIST_QUERY = `
  query AdminRepairRequestsE2E($pagination: PaginationArgs!, $filter: AdminRepairRequestFilterInput) {
    adminRepairRequests(pagination: $pagination, filter: $filter) {
      items { id requestNo }
      total
    }
  }
`;

const EQUIPMENT_MODELS_QUERY = `
  query EquipmentModelsForE2E {
    equipmentModels { id modelCode }
  }
`;

const CREATE_REQUEST_MUTATION = `
  mutation CreateRepairRequestE2E($input: CreateRepairRequestInput!) {
    createRepairRequest(input: $input) { id requestNo }
  }
`;

/** 客户软删自己的未接单申请（幂等成功）——分页夹具的清理通道 */
const DELETE_MY_REQUEST_MUTATION = `
  mutation DeleteMyRepairRequestE2E($id: Int!) {
    deleteMyRepairRequest(id: $id) { id }
  }
`;

// ---- helpers ----

function activePane(page: Page) {
  return page.locator('.ant-tabs-tabpane-active');
}

// AntD v6 的 Drawer 无 .ant-drawer-content 内容类，portal 内同时只有一个 dialog，用角色定位收口
function detailDrawer(page: Page) {
  return page.getByRole('dialog');
}

async function loginAs(
  page: Page,
  env: Record<string, string>,
  loginName: string,
  landingPath: RegExp,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill(loginName);
  await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(landingPath);
}

/** 按唯一故障码反查本次运行自建行的精确 ID 与编号（管理员视角）——归属核实的依据 */
async function listRunRequests(
  env: Record<string, string>,
): Promise<Array<{ id: number; requestNo: string }>> {
  const { body } = await realGraphqlCall(
    env,
    ADMIN_REPAIR_LIST_QUERY,
    {
      filter: { errorCode: RUN_ERROR_CODE },
      pagination: { mode: 'OFFSET', page: 1, pageSize: 50, withTotal: true },
    },
    'mock_super_admin',
  );
  const items = (
    body as {
      data?: { adminRepairRequests?: { items?: Array<{ id: number; requestNo: string }> } };
    }
  ).data?.adminRepairRequests?.items;

  return (items ?? []).map((item) => ({ id: item.id, requestNo: item.requestNo }));
}

/**
 * 分页夹具清理（S4-01）：软删目标取「本次记录的精确 ID」∪「按运行唯一故障码反查的可见行」，
 * 反查作为安全网兜住创建中途抛错、ID 尚未记录但行已落库的情况。逐条幂等软删
 * （deleteMyRepairRequest）后再反查确认可见行为零。任一环节失败即抛出，由用例 finally
 * 归并到 primaryError——主断言通过而清理失败时让测试转红，主断言已失败时保留原始失败原因不被掩盖。
 *
 * 物理清理边界（负责人最小修复计划 P2）：
 * - 预期事实一律取创建响应与本轮输入记录（编号 / 客户账号 / 故障码 / 设备型号 / 故障描述），
 *   绝不回填反查所得编号（否则核验退化为自证，编号与创建记录不符也永远不会被发现）；
 *   反查只保留为「发现遗漏残留」的辅助步骤与软删安全网；
 * - 创建响应未记录的行（创建中途抛错）不进物理删除目标，只走反查软删兜底，避免用猜测事实删行；
 * - 共享开发库只软删不物理删除（与 reference-document-real.spec 同边界）；仅当目标库严格为
 *   lithography_e2e 且执行者显式授权（E2E_ALLOW_PHYSICAL_CLEANUP=1）时才物理删除，
 *   保证不残留影响官方 Mock Seed 计数校验。绝不按编号前缀/行数/猜测 ID 删除。
 * - 受保护 helper 在同一连接同一事务内 FOR UPDATE 核验目标行的五项事实与子记录引用、
 *   删除后再核验残留为零，任一不达标即回滚报错（编号与创建记录不符同样命中 field_mismatch_rows，
 *   事务在 DELETE 之前中止，不提交删除）。
 */
async function cleanupRunRequests(
  env: Record<string, string>,
  createdRows: readonly CreatedRunRequest[],
  expected: { customerAccountId: number; equipmentModelId: number },
): Promise<void> {
  const failures: string[] = [];
  // 反查必须在软删前完成：软删后这些行对该筛选不可见，遗漏残留无从发现。
  // 反查边界是本次运行唯一故障码（RUN_ERROR_CODE），仅用于软删安全网与残留发现。
  const discovered = await listRunRequests(env);

  // 软删（可逆）沿用既有边界：记录 ID ∪ 反查 ID
  const softDeleteTargets = Array.from(
    new Set([...createdRows.map((row) => row.id), ...discovered.map((item) => item.id)]),
  );

  for (const id of softDeleteTargets) {
    try {
      const response = await realGraphqlCall(
        env,
        DELETE_MY_REQUEST_MUTATION,
        { id },
        'mock_customer_alpha',
      );

      if ((response.body as { errors?: unknown[] }).errors) {
        failures.push(`自建申请 ${id} 软删返回 GraphQL 错误`);
      }
    } catch (error) {
      failures.push(`自建申请 ${id} 软删异常：${(error as Error).message}`);
    }
  }

  const remaining = await listRunRequests(env);

  if (remaining.length > 0) {
    failures.push(`清理后仍可见自建行：${remaining.map((item) => item.id).join(',')}`);
  }

  // 物理删除（不可逆）只针对创建时已记录精确事实的行，预期值全部来自创建响应与本轮输入
  const physicalTargets = createdRows.map((row) => ({
    id: row.id,
    expected: {
      requestNo: row.requestNo,
      customerAccountId: expected.customerAccountId,
      errorCode: RUN_ERROR_CODE,
      equipmentModelId: expected.equipmentModelId,
      faultDescription: row.faultDescription,
    },
  }));

  if (isPhysicalCleanupEnabled(env)) {
    try {
      // 受安全门保护的 helper（内部复查授权 + 库名门 + 事务内核验与残留核验），失败即抛错
      deleteRepairRequestRowsByIds(physicalTargets);
    } catch (error) {
      failures.push(`自建申请物理清理失败：${(error as Error).message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`E2E 自建数据清理失败——${failures.join('；')}`);
  }
}

test.describe('real backend admin document database', () => {
  test.beforeEach(async () => {
    // 共享预检：普通入口返回跳过原因（保持既有 skip 语义），专用入口严格模式直接失败
    const skipReason = await resolveRealBackendPrerequisite();
    test.skip(skipReason !== null, skipReason ?? '');
  });

  // 计划表 S4.5 主链路：四标签真实渲染 + 真实统计入卡 + seed 行 + 会话消息详情 +
  // 报告正文 + 参考资料下载入口 + 刷新恢复（seed 只读，无数据写入）
  test('super admin 四标签主链路：真实统计、seed 行、会话消息、报告正文与下载入口', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const env = readBackendEnv();

    // Node 侧先读真实统计：页面四分区汇总条必须与 API 一致（不硬编码共享库数字）
    const statsResponse = await realGraphqlCall(env, STATS_QUERY, {}, 'mock_super_admin');
    const stats = (
      statsResponse.body as {
        data: { adminDocumentDatabaseStats: Record<string, number> };
      }
    ).data.adminDocumentDatabaseStats;

    await loginAs(page, env, 'mock_super_admin', /\/admin$/);
    await page.goto(PAGE_PATH);
    await expect(page.getByRole('heading', { name: '文档数据库' })).toBeVisible();

    // PR3 R7 S4：四张 StatCard 已改为单卡四分区紧凑汇总条（.kb-summary）；
    // 数值后附口径小字，用 toContainText 容忍（数字仍为真实 API 值）
    const expectSummaryCell = (label: string, value: number) =>
      expect(
        page.locator('.kb-summary-cell', { hasText: label }).locator('.kb-summary-value'),
      ).toContainText(String(value));
    expectSummaryCell('维修申请', stats.repairRequestTotal);
    expectSummaryCell('参考资料', stats.referenceDocumentTotal);
    expectSummaryCell('AI 会话', stats.aiConversationTotal);
    expectSummaryCell('AI 报告', stats.aiReportTotal);

    // 维修申请标签：主搜索（卡内工具区）编号前缀收窄到 seed 行，已软删的 920004 不可见
    await page.getByRole('tab', { name: '维修申请' }).click();
    await activePane(page).getByPlaceholder('按申请编号搜索').fill(SEED_REQUEST_KEYWORD);
    for (const requestNo of SEED_VISIBLE_REQUEST_NOS) {
      await expect(activePane(page).getByRole('cell', { name: requestNo })).toBeVisible();
    }
    await expect(activePane(page).getByRole('cell', { name: SEED_DELETED_REQUEST_NO })).toHaveCount(
      0,
    );

    // AI 会话标签：组合筛选（关联申请编号 + 会话状态=进行中）唯一定位 seed 930002；
    // 会话状态等精确条件在「筛选」展开区内（PR3 R7 S5）
    await page.getByRole('tab', { name: 'AI 会话' }).click();
    await activePane(page)
      .getByPlaceholder('按关联申请编号搜索')
      .fill(SEED_ACTIVE_CONVERSATION_REQUEST_NO);
    await activePane(page).getByRole('button', { name: '筛选' }).click();
    await activePane(page).getByRole('combobox').click();
    await page.locator('.ant-select-item-option', { hasText: '进行中' }).click();
    await expect(activePane(page).getByText('共 1 条')).toBeVisible();

    // 消息详情 Drawer：服务端 messageSeq ASC 稳定顺序，pageSize 50 单页放下 6 条 seed
    await activePane(page).getByRole('button', { name: '消息详情' }).click();
    await expect(detailDrawer(page).getByText('会话消息详情')).toBeVisible();
    await expect(detailDrawer(page).getByText('共 6 条')).toBeVisible();
    await expect(detailDrawer(page).getByText(/你是光刻机扫描台故障诊断助手/)).toBeVisible();
    await expect(detailDrawer(page).getByText(/NXT:2000i 高速扫描时/)).toBeVisible();
    // seed 覆盖四类角色标签（系统开场 / 工程师提问 / AI 回答 / 工具观测）；
    // 工程师/AI 助手标签各出现两轮，取首个断言可见性
    await expect(detailDrawer(page).getByText('系统', { exact: true })).toBeVisible();
    await expect(detailDrawer(page).getByText('工程师', { exact: true }).first()).toBeVisible();
    await expect(detailDrawer(page).getByText('AI 助手', { exact: true }).first()).toBeVisible();
    await expect(detailDrawer(page).getByText('工具', { exact: true })).toBeVisible();
    // 关闭 Drawer（遮罩会拦截后续 tab 点击），等 portal 移除后再切换
    await detailDrawer(page).getByRole('button', { name: 'Close' }).click();
    await expect(detailDrawer(page)).toHaveCount(0);

    // AI 报告标签：报告类型筛选唯一定位 seed 950001（精确条件在「筛选」展开区，PR3 R7 S5）
    await page.getByRole('tab', { name: 'AI 报告' }).click();
    await activePane(page).getByRole('button', { name: '筛选' }).click();
    await activePane(page).getByPlaceholder('按报告类型筛选').fill('FAULT_DIAGNOSIS');
    await expect(
      activePane(page).getByRole('cell', { name: SEED_FAULT_DIAGNOSIS_REPORT_TITLE }),
    ).toBeVisible();
    await expect(
      activePane(page).getByRole('cell', { name: SEED_INTERIM_REPORT_TITLE }),
    ).toHaveCount(0);
    await activePane(page).getByRole('button', { name: '正文' }).click();
    await expect(detailDrawer(page).getByText(/能量传感器窗口污染导致读数漂移/)).toBeVisible();
    await expect(detailDrawer(page).getByText(/关联申请 MOCK-RR-2026-0002/)).toBeVisible();
    await detailDrawer(page).getByRole('button', { name: 'Close' }).click();
    await expect(detailDrawer(page)).toHaveCount(0);

    // 参考资料标签：seed 行可达，含原始文件名的行进详情后下载入口可见（不点击下载，
    // 下载字节链路由 reference-document-real.spec 覆盖）
    await page.getByRole('tab', { name: '参考资料' }).click();
    await activePane(page).getByText('NXE:3400C 光源维护指南（Mock）').click();
    await expect(page).toHaveURL(/\/reference-documents\/\d+$/);
    await expect(page.getByRole('button', { name: /下载文件/ })).toBeVisible();

    // 刷新：只读聚合页恢复默认态（统计与默认标签重新加载）
    await page.goto(PAGE_PATH);
    await expect(page.getByRole('heading', { name: '文档数据库' })).toBeVisible();
    expectSummaryCell('AI 报告', stats.aiReportTotal);
    await expect(page.getByRole('tab', { name: '参考资料' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // 计划表 S4.5：组合筛选收窄、无命中空态、筛选清空恢复（seed 只读）
  test('组合筛选收窄、空态与清空恢复', async ({ page }) => {
    test.setTimeout(60_000);
    const env = readBackendEnv();

    await loginAs(page, env, 'mock_super_admin', /\/admin$/);
    await page.goto(PAGE_PATH);

    // 维修申请：故障码等值筛选（后端 errorCode 契约为等值匹配，非 LIKE）+ 接单状态组合；
    // 精确条件均位于「筛选」展开区（PR3 R7 S5）
    // seed 0001 = E-CHUCK-101 待接单，0002 = E-LASER-207 已接单
    await page.getByRole('tab', { name: '维修申请' }).click();
    await activePane(page).getByRole('button', { name: '筛选' }).click();
    await activePane(page).getByPlaceholder('输入完整故障码').fill('E-CHUCK-101');
    await expect(activePane(page).getByRole('cell', { name: 'MOCK-RR-2026-0001' })).toBeVisible();
    await activePane(page).getByRole('combobox').nth(0).click();
    await page.locator('.ant-select-item-option', { hasText: '待接单' }).click();
    await expect(activePane(page).getByRole('cell', { name: 'MOCK-RR-2026-0001' })).toBeVisible();
    await expect(activePane(page).getByRole('cell', { name: 'MOCK-RR-2026-0002' })).toHaveCount(0);

    // 无命中 → 正式空态文案（不报错、不残留旧数据）
    await activePane(page).getByPlaceholder('输入完整故障码').fill('E2E-无命中-999');
    await expect(activePane(page).getByText('没有符合筛选条件的维修申请。')).toBeVisible();

    // 清空故障码：恢复到「待接单 + 无故障码」的组合结果
    await activePane(page).getByPlaceholder('输入完整故障码').fill('');
    await expect(activePane(page).getByText('没有符合筛选条件的维修申请。')).toHaveCount(0);
    await expect(activePane(page).getByRole('cell', { name: 'MOCK-RR-2026-0001' })).toBeVisible();

    // 清除接单状态（AntD allowClear：hover 后出现清除按钮）→ 已接单行恢复可见
    await activePane(page).getByRole('combobox').nth(0).hover();
    await activePane(page).locator('.ant-select-clear').click();
    await expect(activePane(page).getByRole('cell', { name: 'MOCK-RR-2026-0002' })).toBeVisible();

    // AI 会话：状态筛选已完成 → 进行中标签消失；清空恢复（状态在「筛选」展开区）
    await page.getByRole('tab', { name: 'AI 会话' }).click();
    await activePane(page).getByRole('button', { name: '筛选' }).click();
    await activePane(page).getByRole('combobox').click();
    await page.locator('.ant-select-item-option', { hasText: '已完成' }).click();
    await expect(activePane(page).getByText('进行中', { exact: true })).toHaveCount(0);
    await expect(
      activePane(page).getByRole('cell', { name: 'MOCK-RR-2026-0002' }).first(),
    ).toBeVisible();
    await activePane(page).getByRole('combobox').hover();
    await activePane(page).locator('.ant-select-clear').click();
    // 清空状态筛选：「进行中」会话重新出现（共享库可能有多条 ACTIVE，取首行断言语义）
    await expect(activePane(page).getByText('进行中', { exact: true }).first()).toBeVisible();
  });

  // 计划表 S4.5 分页：共享库 seed 行数不足一页，用运行唯一故障码自建 12 行
  // 跑满两页断言翻页与真实 total；finally 按创建响应记录的精确 ID 幂等软删清理，
  // 反查仅作发现遗漏残留的辅助步骤
  test('分页：运行唯一故障码自建 12 行跑满两页（清理后筛选归零）', async ({ page }) => {
    test.setTimeout(120_000);
    const env = readBackendEnv();

    // 只读夹具准备：公开 equipmentModels 取型号（无写入，留在 try 外）
    const modelsResponse = await realGraphqlCall(
      env,
      EQUIPMENT_MODELS_QUERY,
      {},
      'mock_super_admin',
    );
    const models = (modelsResponse.body as { data?: { equipmentModels?: Array<{ id: number }> } })
      .data?.equipmentModels;
    const modelId = models?.[0]?.id;
    expect(modelId).toBeDefined();

    // 物理清理的预期事实之一：客户甲账号 ID（JWT 口径，本轮测试自身掌握）。留在 try 外，
    // 让清理兜底不依赖网络调用。
    const customerAccountId = await realLoginAccountId(env);

    const createdRows: CreatedRunRequest[] = [];
    let primaryError: unknown = null;

    // S4-01：try 覆盖「首笔写入 → 页面断言」全程，任何一步失败都进入统一 finally 清理
    try {
      for (let index = 0; index < RUN_REQUEST_COUNT; index += 1) {
        const faultDescription = runFaultDescription(index);
        const created = await realGraphqlCall(
          env,
          CREATE_REQUEST_MUTATION,
          {
            input: {
              equipmentModelId: modelId,
              errorCode: RUN_ERROR_CODE,
              faultDescription,
            },
          },
          'mock_customer_alpha',
        );
        expect((created.body as { errors?: unknown[] }).errors).toBeUndefined();
        const createdRecord = (
          created.body as {
            data?: { createRepairRequest?: { id: number; requestNo: string } };
          }
        ).data?.createRepairRequest;
        // 创建成功即记录精确 ID 与本次创建事实（Playwright expect 无 toBeTypeOf，用 toBeGreaterThan 断正整数）；
        // 编号取创建响应而非事后反查，物理清理的预期值由此而来。
        expect(createdRecord?.id).toBeGreaterThan(0);
        expect(createdRecord?.requestNo).toMatch(REQUEST_NO_PATTERN);
        createdRows.push({
          id: createdRecord?.id as number,
          requestNo: createdRecord?.requestNo as string,
          faultDescription,
        });
      }

      await loginAs(page, env, 'mock_super_admin', /\/admin$/);
      await page.goto(PAGE_PATH);
      await page.getByRole('tab', { name: '维修申请' }).click();
      await activePane(page).getByRole('button', { name: '筛选' }).click();
      await activePane(page).getByPlaceholder('输入完整故障码').fill(RUN_ERROR_CODE);

      // 第 1 页：真实 total 12，pageSize 10 → 10 行 + 两页指示
      await expect(activePane(page).getByText(`共 ${RUN_REQUEST_COUNT} 条`)).toBeVisible();
      await expect(activePane(page).locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(10);

      // 翻到第 2 页：余 2 行，total 不变，页码高亮
      await activePane(page).locator('.ant-pagination-item-2').click();
      await expect(activePane(page).locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2);
      await expect(activePane(page).getByText(`共 ${RUN_REQUEST_COUNT} 条`)).toBeVisible();
      await expect(activePane(page).locator('.ant-pagination-item-2')).toHaveClass(
        /ant-pagination-item-active/,
      );
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        await cleanupRunRequests(env, createdRows, {
          customerAccountId,
          equipmentModelId: modelId as number,
        });
      } catch (cleanupError) {
        // 主断言已通过时清理失败才让测试转红；否则保留原始失败原因不被掩盖
        if (primaryError === null) {
          primaryError = cleanupError;
        }
      }
    }

    if (primaryError !== null) {
      throw primaryError;
    }
  });

  // 角色边界（与后端 e2e 角色矩阵呼应的浏览器侧口径）：
  // customer 无导航入口、直访被安全跳转回个人主页、越权直调 GraphQL FORBIDDEN
  test('customer 越权被拦截：无导航入口、页面重定向与 GraphQL FORBIDDEN', async ({ page }) => {
    const env = readBackendEnv();

    await loginAs(page, env, 'mock_customer_alpha', /\/customer$/);
    await expect(
      page.getByRole('navigation', { name: '主导航' }).getByText('文档数据库'),
    ).toHaveCount(0);

    await page.goto(PAGE_PATH);
    await expect(page).toHaveURL(/\/customer$/);

    const denied = await realGraphqlCall(
      env,
      ADMIN_REPAIR_LIST_QUERY,
      { pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true } },
      'mock_customer_alpha',
    );
    const errors = (denied.body as { errors?: Array<{ extensions?: { code?: string } }> }).errors;
    expect(errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  // 计划表 S4.5：1366×768 视口本页无横向滚动且退出登录可达
  test('1366×768 视口：文档数据库页无横向滚动且退出入口可达', async ({ page }) => {
    const env = readBackendEnv();

    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, env, 'mock_super_admin', /\/admin$/);
    await page.goto(PAGE_PATH);
    await expect(page.getByRole('heading', { name: '文档数据库' })).toBeVisible();
    await expect(page.getByRole('button', { name: /退出登录/ })).toBeVisible();

    // 表格列宽超出走 AntD 表格内部横向滚动（scroll.x），页面本体不得溢出视口
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(0);
  });
});

// 授权矩阵的角色边界补强：ENGINEER 直调管理员只读 Query 同样被拒（与后端
// test/03-roles-guard 及 usecase 层权限单测呼应的集成侧口径）。这是纯后端契约断言，
// 不依赖前端 dev server，故单列一个 describe，仅以「后端可用 + 可登录」为前置。
test.describe('real backend admin document database - authorization', () => {
  test.beforeEach(async () => {
    // 纯后端契约用例不依赖前端 dev server，共享预检只要求 env 与后端可用
    const skipReason = await resolveRealBackendPrerequisite({ requireFrontendChannel: false });
    test.skip(skipReason !== null, skipReason ?? '');
  });

  test('engineer 越权直调管理员维修申请 Query 返回 FORBIDDEN', async () => {
    const env = readBackendEnv();

    const denied = await realGraphqlCall(
      env,
      ADMIN_REPAIR_LIST_QUERY,
      { pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true } },
      'mock_engineer_chen',
    );
    const errors = (denied.body as { errors?: Array<{ extensions?: { code?: string } }> }).errors;
    expect(errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  test('engineer 越权直调管理员统计 Query 返回 FORBIDDEN', async () => {
    const env = readBackendEnv();

    const denied = await realGraphqlCall(env, STATS_QUERY, {}, 'mock_engineer_chen');
    const errors = (denied.body as { errors?: Array<{ extensions?: { code?: string } }> }).errors;
    expect(errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});

// e2e/repair-request-manage-real.spec.ts
// 客户「我的维修申请」真实后端数据流 e2e（阶段三 T-07/T-08）。
//
// 与 repair-request-manage.spec.ts 分工：本文件覆盖真实登录后的列表 / 详情 / 删除
// 全链路与越权、角色语义；守卫重定向与失效链路不依赖数据返回，留在前者。
//
// 数据基础：backend seed 预置维修申请与前端阶段一 Mock 数据同 ID 对齐——
// 920001/920005 客户甲（mock_customer_alpha）未接单可删、920003 客户甲已接单
// （李工，含一条 PENDING 回复）、920002 客户乙（mock_customer_beta）已接单、
// 920004 客户乙已软删除。seed 预置行只做只读断言与「必然拒绝」的 API 探测
// （条件更新未命中不改行状态）；删除流程用本用例自建的申请行，结束前清理，
// 不污染共享开发库基线。
// 前提不满足（无本地后端 / 无 env）时用例自动跳过，不会以失败阻塞。
// 2026-09-29 整合工作台：断言口径同步为「左栏活动列表 + 右栏详情面板」，
// 创建成功后的「查看维修申请」分流到该申请详情路由，列表/详情不再有表格与 Descriptions。

import { expect, test } from '@playwright/test';

import {
  cleanupE2ERepairRequest,
  findRepairRequestByRequestNo,
  mysqlQuery,
  readBackendEnv,
  realGraphqlCall,
  realLoginAccountId,
  REQUEST_NO_PATTERN,
  resolveRealBackendPrerequisite,
} from './helpers/real-backend';

const LIST_PATH = '/customer/repair-requests';
const CREATE_PAGE_PATH = '/customer/repair-requests/new';
// 自建行的唯一故障码：既填进表单，也作为统一清理入口的预期事实之一（本轮测试自身掌握的值）
const MANAGE_ERROR_CODE = 'E2E-MANAGE';
// 故障描述同口径：填进表单的值即本轮预期事实，物理清理的同一事务内会逐字段核验
const MANAGE_FAULT_DESCRIPTION = '阶段三删除链路真实后端 e2e 用例';
const DELETE_MUTATION = `
  mutation DeleteMyRepairRequest($id: Int!) {
    deleteMyRepairRequest(id: $id) { id requestNo }
  }
`;

/** 详情查询（与 features/repair-request 的 adapter 同形状）：用于把 UI 展示值与后端载荷对照。 */
const DETAIL_QUERY = `
  query MyRepairRequest($id: Int!) {
    myRepairRequest(id: $id) {
      id
      requestNo
      responses { id engineerNickname resolutionStatus responseText createdAt }
    }
  }
`;

/** 客户侧统一时间格式（与 src/shared/ui/format-date-time.ts 同参数），用于核对展示值。 */
const customerTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

test.describe('real backend manage flow', () => {
  test.beforeEach(async () => {
    // 共享预检：普通入口返回跳过原因（保持既有 skip 语义），专用入口严格模式直接失败
    const skipReason = await resolveRealBackendPrerequisite();
    test.skip(skipReason !== null, skipReason ?? '');
  });

  // T-07 主链路：登录 → 创建 → 成功页跳列表 → 列表可见 → 详情 → 删除未接单成功 →
  // 软删除落库证据。自建行经 try/finally 兜底清理：落库始于提交点击，之后任何断言
  // 失败都不得把真实行泄漏进共享开发库（requestNo 取到前失败的窗口无法定位行，可接受）。
  test('customer full journey: login, create, see it listed, open detail and delete it', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const env = readBackendEnv();

    // 真实登录（客户甲）
    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_customer_alpha');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/customer$/);

    // 客户账号 ID 在进入 try 前一次性取得（JWT 口径）：清理兜底不再依赖网络调用，
    // 也不会在清理阶段才失败而掩盖主断言原因。
    const customerAccountId = await realLoginAccountId(env);

    // 本轮自建行的预期事实之一：创建 Mutation 实际发送的设备型号（被动记录，不回读目标行）。
    // 只观察不拦截：不改写真实请求，仅在同一 route 回调里读取发送值后放行。
    // 初值 0 表示「尚未记录」：创建成功后必须已被记录（见下方齐备性断言），清理入口只接受正整数。
    let createdEquipmentModelId = 0;
    await page.route('**/graphql', (route) => {
      const payload = route.request().postDataJSON() as {
        query?: string;
        variables?: { input?: { equipmentModelId?: number } };
      };

      if (payload.query?.includes('mutation CreateRepairRequest')) {
        const modelId = payload.variables?.input?.equipmentModelId;

        if (typeof modelId === 'number') {
          createdEquipmentModelId = modelId;
        }
      }

      return route.continue();
    });

    let requestNo: string | undefined;
    try {
      // 真实创建：型号来自真实库，提交走真实受保护通道
      await page.goto(CREATE_PAGE_PATH);
      await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();
      await page.getByRole('combobox').click();
      await page.locator('.ant-select-item-option').first().click();
      await page.getByLabel('设备错误码').fill(MANAGE_ERROR_CODE);
      await page.getByLabel('故障描述').fill(MANAGE_FAULT_DESCRIPTION);
      await page.getByRole('button', { name: '提交申请' }).click();

      // 成功页（T-05：创建成功后分流到该申请详情路由，2026-09-29 整合裁定）
      await expect(page.getByText('维修申请创建成功')).toBeVisible();
      requestNo = (await page.getByText(/申请编号：/).textContent())
        ?.replace('申请编号：', '')
        .trim();
      expect(requestNo).toBeTruthy();
      expect(requestNo).toMatch(REQUEST_NO_PATTERN);
      // 清理所需预期事实齐备性：创建成功即必须已被动记录到发送的设备型号，探针失效时用例转红
      expect(createdEquipmentModelId).toBeGreaterThan(0);
      await page.getByRole('button', { name: '查看维修申请' }).click();
      await expect(page).toHaveURL(new RegExp(`${LIST_PATH}/\\d+$`));

      // 详情直接可达且字段来自后端：标题为申请编号 + 待接单 Pill，描述来自真实载荷
      await expect(page.getByText(requestNo!).first()).toBeVisible();
      await expect(
        page.locator('.customer-workspace-detail-pane').getByText('待接单'),
      ).toBeVisible();
      await expect(page.getByText(MANAGE_FAULT_DESCRIPTION).first()).toBeVisible();

      // 返回历史列表：新申请按 createdAt DESC 置顶（左栏第一条目）
      await page.getByRole('button', { name: '返回历史列表' }).click();
      await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
      const createdItem = page.locator('.activity-item').filter({ hasText: requestNo! });
      await expect(createdItem).toHaveCount(1);
      await expect(createdItem.getByText('待接单')).toBeVisible();

      // 删除未接单申请（左栏条目删除按钮 aria-label 携带编号，精确命中本行）
      await page.getByRole('button', { name: `删除申请 ${requestNo}` }).click();
      await page.getByRole('button', { name: '确认删除' }).click();
      await expect(page.getByText('维修申请已删除。')).toBeVisible();
      await expect(page.locator('.activity-item').filter({ hasText: requestNo! })).toHaveCount(0);

      // 落库证据：软删除（deprecated=1 且 deleted_at 非空），非物理删除（受保护 helper，内部白名单校验）
      const row = findRepairRequestByRequestNo(
        requestNo!,
        'is_accepted, deprecated, deleted_at IS NOT NULL',
      );
      expect(row.split('\t')).toEqual(['0', '1', '1']);

      // 幂等（裁定 5）：API 重复删除同一申请仍成功
      const id = findRepairRequestByRequestNo(requestNo!, 'id');
      const repeat = await realGraphqlCall(env, DELETE_MUTATION, { id: Number(id) });
      expect(
        (repeat.body as { data?: { deleteMyRepairRequest?: { requestNo: string } } }).data
          ?.deleteMyRepairRequest?.requestNo,
      ).toBe(requestNo);
    } finally {
      // 清理兜底：统一入口先做编号白名单校验，再按解析出的精确 ID 经产品通道软删
      //（主路径已软删，重复软删幂等成功），保证断言中途失败也不留下可见行；
      // 仅当环境为专用隔离库 lithography_e2e 且显式授权时，才按「精确 ID + 本轮预期事实」
      // 走受保护物理清理（同一连接同一事务核验后删除，残留非零即抛错）；
      // 共享开发库保持既有软删边界，不做物理删除。
      // 预期事实（编号 / 客户账号 / 故障码 / 设备型号 / 故障描述）全部取本轮自有值：
      // 型号来自创建成功时已记录的被动探针，缺失即由入口的正整数白名单拒绝清理。
      if (requestNo) {
        await cleanupE2ERepairRequest({
          env,
          requestNo,
          customerAccountId,
          errorCode: MANAGE_ERROR_CODE,
          equipmentModelId: createdEquipmentModelId,
          faultDescription: MANAGE_FAULT_DESCRIPTION,
        });
      }
    }
  });

  // T-08：已接单详情呈现实时昵称回复时间线、无删除入口，且不含任何账号 ID 字样
  //（seed 920003：客户甲名下已接单，李工一条 PENDING 回复；只读，不改动 seed 行）
  test('accepted detail renders nickname timeline and hides delete', async ({ page }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_customer_alpha');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/customer$/);

    await page.goto(`${LIST_PATH}/920003`);
    await expect(page.getByText('MOCK-RR-2026-0003').first()).toBeVisible();
    // 已接单在详情面板标题呈现为「已接单」Pill（左栏条目同文案，限定右栏避免歧义）
    const detailPane = page.locator('.customer-workspace-detail-pane');
    await expect(detailPane.getByText('已接单', { exact: true })).toBeVisible();
    // 删除入口断言限定右栏详情面板（左栏未接单条目的删除按钮 accessible name 为
    // 「删除申请 {编号}」，全局按名匹配会被子串命中，不能表达「详情面板无删除入口」）
    await expect(detailPane.getByRole('button', { name: '删除申请' })).toHaveCount(0);
    // 回复时间线：李工实时昵称 + PENDING 标签；无任何账号 ID 字样（裁定 3）。
    // 详情标题区还会渲染同一「处理中」状态胶囊（latestResolutionStatus），与时间线
    // 状态标签同文案并存；断言限定回复模块容器。外层 DataCard 同样是 section
    // （.data-card）且包住全部文本，须以 section:not(.data-card) 排除（与未接单用例
    // 同口径），避免多元素 strict 歧义（2026-09-30 基线实锤）。
    const responsesSection = detailPane.locator('section:not(.data-card)', {
      hasText: '工程师回复',
    });
    await expect(responsesSection.getByText('李工')).toBeVisible();
    await expect(responsesSection.getByText('处理中')).toBeVisible();
    await expect(page.getByText(/engineerAccountId|accountId|customerAccountId/)).toHaveCount(0);

    // S2-7：回复时间来自后端字段并按客户侧分钟精度格式化。期望值由同一后端载荷推导
    // （而非硬编码字面量），避免对序号化时区做假设；同时不得出现原始 ISO 串。
    const { body } = await realGraphqlCall(env, DETAIL_QUERY, { id: 920003 });
    const replyCreatedAt = (
      body as {
        data?: { myRepairRequest?: { responses?: Array<{ createdAt: string }> } };
      }
    ).data?.myRepairRequest?.responses?.[0]?.createdAt;
    expect(replyCreatedAt, '真实载荷应含回复时间').toBeTruthy();
    const expectedTime = customerTimeFormatter.format(new Date(replyCreatedAt as string));
    await expect(page.getByText(expectedTime)).toBeVisible();
    await expect(page.getByText(replyCreatedAt as string)).toHaveCount(0);
  });

  // S2-6（真实数据）：seed 920001 属客户甲、未接单且 0 条回复 —— 详情页整个回复模块
  // 不渲染（无标题 / 无计数 / 无占位），且未接单仍保留删除入口（只读，不改动 seed 行）
  test('unaccepted request without responses hides the whole reply module', async ({ page }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_customer_alpha');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/customer$/);

    await page.goto(`${LIST_PATH}/920001`);
    // 先确认数据已就绪，再断言回复模块缺失（排除 loading 造成的假阴性）
    await expect(page.getByText('MOCK-RR-2026-0001').first()).toBeVisible();
    await expect(
      page.locator('.customer-workspace-detail-pane').getByText(/工程师回复/),
    ).toHaveCount(0);
    await expect(page.getByText(/暂无工程师回复/)).toHaveCount(0);
    // 未接单详情只剩「故障描述」与「故障正文」两块内容区（DataCard 之外）
    await expect(
      page.locator('.customer-workspace-detail-pane section:not(.data-card)'),
    ).toHaveCount(2);
    await expect(
      page.locator('.customer-workspace-detail-pane').getByRole('button', { name: '删除申请' }),
    ).toBeVisible();
  });

  // T-08：已接单拒绝（裁定 5 CONFLICT）。UI 无删除入口，走 API 直发探测；
  // 后端条件更新未命中不改行状态，seed 行无污染。
  test('deleting an accepted request is rejected with conflict via api', async () => {
    const env = readBackendEnv();

    const { body } = await realGraphqlCall(env, DELETE_MUTATION, { id: 920003 });
    const errors = (
      body as {
        errors?: Array<{ extensions?: { code?: string; errorCode?: string } }>;
      }
    ).errors;
    expect(errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(errors?.[0]?.extensions?.errorCode).toBe('REPAIR_REQUEST_ALREADY_ACCEPTED');
    // 行状态未被改动
    expect(mysqlQuery('SELECT deprecated FROM repair_request WHERE id = 920003')).toBe('0');
  });

  // T-07/T-08：越权防探测（裁定 5）——改 URL 访问他人申请统一呈现 not-found 态，
  // 不泄露存在性（seed 920002 属客户乙，客户甲访问；只读）
  test('cross-account detail access is rejected with the unified not-found state', async ({
    page,
  }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_customer_alpha');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/customer$/);

    await page.goto(`${LIST_PATH}/920002`);
    await expect(page.getByText(/维修申请不存在/)).toBeVisible();
    await expect(page.getByText('MOCK-RR-2026-0002')).toHaveCount(0);
  });

  // T-07/T-08：已删除申请不可见（A-01 场景③）——seed 920004 属客户乙且已软删除：
  // 正常列表不含该行，改 URL 直访详情同样统一 not-found 态（读取侧防探测，不泄露存在性）
  test('deleted request is absent from list and detail shows the unified not-found state', async ({
    page,
  }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_customer_beta');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/customer$/);

    await page.goto(LIST_PATH);
    // 乙名下未删除的申请可见（左栏条目 + 右栏默认详情标题同文案，取首个）；已删除的 920004 不出现在正常列表
    await expect(page.getByText('MOCK-RR-2026-0002').first()).toBeVisible();
    await expect(page.getByText('MOCK-RR-2026-0004')).toHaveCount(0);

    await page.goto(`${LIST_PATH}/920004`);
    await expect(page.getByText(/维修申请不存在/)).toBeVisible();
    await expect(page.getByText('MOCK-RR-2026-0004')).toHaveCount(0);
  });

  // T-08 角色权限（裁定 2）：超管继承放行列表与详情，但仅见本人名下数据（空态），
  // 且不能以客户身份删除（后端 Guard 精确 CUSTOMER 拒绝）
  test('super admin enters the list with own empty data and cannot delete via api', async ({
    page,
  }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_super_admin');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto(LIST_PATH);
    await expect(page).toHaveURL(new RegExp(LIST_PATH));
    await expect(page.getByText('我的维修申请').first()).toBeVisible();
    // 左栏列表与右栏详情占位同为空态：同一文案出现两处
    await expect(page.getByText('还没有维修申请。')).toHaveCount(2);

    const { body } = await realGraphqlCall(
      env,
      DELETE_MUTATION,
      { id: 920001 },
      'mock_super_admin',
    );
    const errors = (
      body as {
        errors?: Array<{ extensions?: { code?: string; errorCode?: string } }>;
      }
    ).errors;
    expect(errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    // 行状态未被改动
    expect(mysqlQuery('SELECT deprecated FROM repair_request WHERE id = 920001')).toBe('0');
  });

  // T-08 角色权限（裁定 2）：超管继承放行详情页，但本人名下无他人申请 → 后端
  // FORBIDDEN/ACCESS_DENIED 防探测文案经 adapter 双口径归并呈现统一 not-found 态
  //（seed 920002 属客户乙；只读）
  test('super admin accessing another customer detail sees the unified not-found state', async ({
    page,
  }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_super_admin');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto(`${LIST_PATH}/920002`);
    await expect(page.getByText(/维修申请不存在/)).toBeVisible();
    await expect(page.getByText('MOCK-RR-2026-0002')).toHaveCount(0);
  });
});

// e2e/engineer-repair-request-real.spec.ts
// 工程师维修申请真实链路 e2e（负责人单卡片计划 P3）。
//
// 与 engineer-repair-request-flow.spec.ts 分工：该文件是前端浏览器流程测试（GraphQL 由
// page.route mock，不连数据库）；本文件是真实链路——客户创建 → 工程师接单/回复 → 客户查看回复，
// 浏览器业务请求真实到达连接专用隔离库 lithography_e2e 的后端，落库事实由受保护 SQL helper 核验。
//
// 数据边界（与 repair-request-create / repair-request-manage-real 同一口径）：
// - 本轮自建行只在 finally 经统一安全入口清理，预期事实取本轮自有值（表单填入值 + 被动记录的
//   Create Mutation 返回 id / requestNo / equipmentModelId + CreateEngineerResponse 返回 id），
//   不复用从目标行反查所得的值充当预期；
// - 已接单并含本轮回复的申请无法经产品通道软删（业务上客户不得删除已接单申请），
//   因此必须走扩展后的精确物理清理：同一事务内核验库名 / 授权 / 归属 / 记录字段，
//   确认无其他子记录后先删本轮回复、再删申请，提交前断言零残留；
//   物理清理未显式授权时入口直接抛错，拒绝静默把本轮自建数据留在库里。
// 专用入口的配置、授权、健康或真实登录前提不满足时直接失败，不得跳过验收。
//
// 本文件含两组用例：①业务链路（客户创建 → 工程师接单/回复 → 客户查看回复，走浏览器）；
// ②清理事务安全回归（在 lithography_e2e 上验证「字段不符 + 缺少预期回复」组合下事务真实回滚）。

import { expect, type Page, test } from '@playwright/test';

import { DEDICATED_E2E_DB_NAME } from '../e2e-real/dedicated-e2e-environment';

import {
  assertPhysicalCleanupAllowed,
  BACKEND_HEALTH,
  cleanupE2ERepairRequest,
  deleteRepairRequestRowsByIds,
  findRepairRequestByRequestNo,
  readBackendEnv,
  realGraphqlCall,
  realLoginAccountId,
  REQUEST_NO_PATTERN,
} from './helpers/real-backend';

const CUSTOMER_LOGIN_NAME = 'mock_customer_alpha';
/** 工程师账号（mock_engineer_chen 的展示昵称是「陈工」）：接单与回复必须由精确 ENGINEER 写身份完成 */
const ENGINEER_LOGIN_NAME = 'mock_engineer_chen';
// 客户侧回复时间线按昵称展示（seed 真值：mock_engineer_chen → 陈工）
const ENGINEER_NICKNAME = '陈工';
const CUSTOMER_CREATE_PATH = '/customer/repair-requests/new';
const CUSTOMER_LIST_PATH = '/customer/repair-requests';
const ENGINEER_LIST_PATH = '/engineer/repair-requests';

// 本轮自建行的唯一故障码：既填进表单，也作为统一清理入口的预期事实之一（本轮测试自身掌握的值）
const REAL_FLOW_ERROR_CODE = 'E2E-ENGINEER-FLOW';
// 故障描述同口径：填进表单的值即本轮预期事实，物理清理的同一事务内会逐字段核验
const REAL_FLOW_FAULT_DESCRIPTION = '工程师接单回复真实链路 e2e 用例';
// 本轮回复正文：填进表单的值即本轮预期事实，物理清理时逐字段核验该回复行
const REAL_FLOW_RESPONSE_TEXT = '已完成现场检修并复测，设备恢复正常';

// ---- 清理事务安全回归（第二组用例）的本轮专属事实，与业务链路用例互不干扰 ----
// 本轮专属故障码 / 描述：既是夹具的创建输入，也是清理入口的预期事实
const GUARD_ERROR_CODE = 'E2E-CLEANUP-GUARD';
const GUARD_FAULT_DESCRIPTION = '清理事务安全回归 e2e 夹具';
// 故意与库内记录不符的预期描述：命中「申请字段不符」违例项
const GUARD_MISMATCHED_DESCRIPTION = '与库内记录不符的预期描述';
// 故意缺失的预期回复 ID：命中「预期回复 ID 缺失」违例项（int 上限，夹具绝不会命中）
const GUARD_MISSING_RESPONSE_ID = 2_147_483_647;
const GUARD_RESPONSE_TEXT = '该回复在库中并不存在';

const EQUIPMENT_MODELS_QUERY = `
  query EquipmentModelsForCleanupGuardE2E {
    equipmentModels { id modelCode }
  }
`;

const CREATE_REQUEST_MUTATION = `
  mutation CreateRepairRequestForCleanupGuardE2E($input: CreateRepairRequestInput!) {
    createRepairRequest(input: $input) { id requestNo }
  }
`;

type GraphQLOperationPayload = {
  query?: string;
  variables?: { input?: { equipmentModelId?: number } };
};

/** 真实登录：以种子账号走真实登录页，落到该角色的默认入口 */
async function loginAs(
  page: Page,
  loginName: string,
  password: string,
  homePattern: RegExp,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('账号或邮箱').fill(loginName);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(homePattern);
}

/** 切换浏览器会话：本应用会话存在 sessionStorage，清空后再登录即完成换人（不新开 context） */
async function switchAccount(
  page: Page,
  loginName: string,
  password: string,
  homePattern: RegExp,
): Promise<void> {
  await page.evaluate(() => sessionStorage.clear());
  await loginAs(page, loginName, password, homePattern);
}

/** 处理状态选择：与 Mock 流程测试同一口径（antd 下拉可见项按 class + title 定位） */
async function selectResolutionStatus(page: Page, label: '处理中' | '已解决'): Promise<void> {
  await page.getByRole('combobox').click();
  await page.locator(`.ant-select-dropdown .ant-select-item-option[title="${label}"]`).click();
}

/**
 * 专用真实通道前置检查（两组用例共用）：任一不满足即报错。
 * 本用例创建的是会被工程师接单并回复的申请，业务上客户无法删除已接单申请
 *（deleteMyRepairRequest 拒绝），只能在专用隔离库 lithography_e2e 上走显式授权的精确物理清理。
 * 在创建夹具前确认隔离库、清理授权与客户/工程师的直连及代理登录。
 * 错误仅包含阶段及安全诊断，不透传可能带有秘密的底层异常或 cause。
 */
async function assertDedicatedRealChannel(): Promise<Record<string, string>> {
  let env: Record<string, string>;
  try {
    env = readBackendEnv();
  } catch {
    throw new Error('[preflight:backend-env] 无法读取 backend/env/.env.development 专用配置');
  }
  if (env.DB_NAME !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `[preflight:database] DB_NAME 必须为 ${DEDICATED_E2E_DB_NAME}，实际为 ${JSON.stringify(env.DB_NAME ?? '')}`,
    );
  }
  try {
    assertPhysicalCleanupAllowed(env);
  } catch {
    throw new Error(
      '[preflight:cleanup-authorization] 专用库物理清理需要 E2E_ALLOW_PHYSICAL_CLEANUP=1',
    );
  }
  let health: Response;
  try {
    health = await fetch(BACKEND_HEALTH, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error('[preflight:backend-health] 无法访问专用后端健康端点');
  }
  if (!health.ok) throw new Error(`[preflight:backend-health] HTTP ${health.status}`);
  // 故障注入只作用于本 spec 的只读登录探针，不改变 Seed 或共享登录 helper。
  const loginEnv = {
    ...env,
    MOCK_SEED_PASSWORD: process.env.E2E_REAL_LOGIN_PASSWORD || env.MOCK_SEED_PASSWORD,
  };
  for (const loginName of [CUSTOMER_LOGIN_NAME, ENGINEER_LOGIN_NAME]) {
    try {
      await realLoginAccountId(loginEnv, loginName);
    } catch {
      throw new Error(`[preflight:backend-login] 登录失败（账号=${loginName}）`);
    }
  }
  for (const [loginName, role] of [
    [CUSTOMER_LOGIN_NAME, 'CUSTOMER'],
    [ENGINEER_LOGIN_NAME, 'ENGINEER'],
  ]) {
    const proxyResponse = await fetch('http://127.0.0.1:4174/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        query:
          'mutation LoginWithPassword($input: AuthLoginInput!) { login(input: $input) { accessToken accountId role } }',
        variables: {
          input: {
            audience: 'SSTSWEB',
            loginName,
            loginPassword: loginEnv.MOCK_SEED_PASSWORD,
            type: 'PASSWORD',
          },
        },
      }),
    }).catch(() => {
      throw new Error('[preflight:frontend-proxy] 无法访问 4174 /graphql 代理');
    });
    if (!proxyResponse.ok)
      throw new Error(`[preflight:frontend-proxy] HTTP ${proxyResponse.status}`);
    const proxyBody = (await proxyResponse.json().catch(() => {
      throw new Error('[preflight:frontend-proxy] 登录响应不是合法 JSON');
    })) as {
      errors?: unknown[];
      data?: { login?: { accountId?: number; accessToken?: string; role?: string } };
    };
    const login = proxyBody.data?.login;
    if (
      proxyBody.errors?.length ||
      !Number.isSafeInteger(login?.accountId) ||
      (login?.accountId ?? 0) <= 0 ||
      typeof login?.accessToken !== 'string' ||
      !login.accessToken ||
      login.role !== role
    ) {
      throw new Error(`[preflight:frontend-proxy] 登录结果无效（账号=${loginName}）`);
    }
  }
  return env;
}

test.describe('real backend engineer accept and respond flow', () => {
  test.beforeEach(async () => {
    await assertDedicatedRealChannel();
  });

  test('customer creates, the engineer accepts and replies in the browser, the customer reads the reply', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const env = readBackendEnv();

    // 本轮预期事实的被动记录位：初值表示「尚未记录」，创建/回复成功后必须已被记录
    // （见下方齐备性断言），清理入口只接受正整数与白名单文本。
    let createdRequestId = 0;
    let createdEquipmentModelId = 0;
    let createdResponseId = 0;
    let requestNo: string | undefined;
    let engineerAccepted = false;
    let responseSubmitCount = 0;

    // 只观察不拦截：在同一 route 回调里读取真实请求/响应后原样放行（route.fetch + fulfill），
    // 不改写任何业务数据，也不 mock 任何业务语义。
    await page.route('**/graphql', async (route) => {
      const payload = route.request().postDataJSON() as GraphQLOperationPayload;

      if (payload.query?.includes('mutation CreateRepairRequest')) {
        const modelId = payload.variables?.input?.equipmentModelId;

        if (typeof modelId === 'number') {
          createdEquipmentModelId = modelId;
        }

        const response = await route.fetch();
        const body = (await response.json()) as {
          data?: { createRepairRequest?: { id?: number; requestNo?: string } };
        };
        const created = body.data?.createRepairRequest;

        if (typeof created?.id === 'number') {
          createdRequestId = created.id;
        }
        if (typeof created?.requestNo === 'string') {
          requestNo = created.requestNo;
        }

        await route.fulfill({ json: body, response });
        return;
      }

      if (payload.query?.includes('mutation CreateEngineerResponse')) {
        responseSubmitCount += 1;

        const response = await route.fetch();
        const body = (await response.json()) as {
          data?: { createEngineerResponse?: { id?: number } };
        };
        const id = body.data?.createEngineerResponse?.id;

        if (typeof id === 'number') {
          createdResponseId = id;
        }

        await route.fulfill({ json: body, response });
        return;
      }

      await route.continue();
    });

    // 两个账号 ID 在进入 try 前一次性取得（JWT 口径）：清理兜底不再依赖网络调用，
    // 也不会在清理阶段才失败而掩盖主断言原因。
    const customerAccountId = await realLoginAccountId(env, CUSTOMER_LOGIN_NAME);
    const engineerAccountId = await realLoginAccountId(env, ENGINEER_LOGIN_NAME);

    try {
      // ---------- 1. 客户创建本轮专属申请 ----------
      await loginAs(page, CUSTOMER_LOGIN_NAME, env.MOCK_SEED_PASSWORD, /\/customer$/);
      await page.goto(CUSTOMER_CREATE_PATH);
      await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();
      await page.getByRole('combobox').click();
      await page.locator('.ant-select-item-option').first().click();
      await page.getByLabel('设备错误码').fill(REAL_FLOW_ERROR_CODE);
      await page.getByLabel('故障描述').fill(REAL_FLOW_FAULT_DESCRIPTION);
      await page.getByRole('button', { name: '提交申请' }).click();

      await expect(page.getByText('维修申请创建成功')).toBeVisible();
      // 清理所需预期事实齐备性：创建成功即必须已被动记录，探针失效时用例转红
      expect(requestNo).toBeTruthy();
      expect(requestNo).toMatch(REQUEST_NO_PATTERN);
      expect(createdRequestId).toBeGreaterThan(0);
      expect(createdEquipmentModelId).toBeGreaterThan(0);
      // 页面展示的编号与被动记录的创建返回值一致（同一条落库记录）
      await expect(page.getByText(`申请编号：${requestNo!}`)).toBeVisible();
      // 跨库一致性硬校验：浏览器写入的这条申请必须能被 SQL helper 在 lithography_e2e
      // 按编号查到且 ID 与创建响应一致——否则说明浏览器后端与清理 helper 不连同一个库，
      // 立即失败，绝不继续在错误的库上创建无法清理的已接单数据（业务请求确实到达了
      // 连接 lithography_e2e 的后端，而不是仅凭配置声称）。
      expect(findRepairRequestByRequestNo(requestNo!, 'id')).toBe(String(createdRequestId));

      // ---------- 2. 工程师在浏览器中接单、回复 ----------
      await switchAccount(page, ENGINEER_LOGIN_NAME, env.MOCK_SEED_PASSWORD, /\/engineer$/);

      await page.goto(ENGINEER_LIST_PATH);
      // 真实列表可见本轮新建申请（列表按 createdAt DESC，新建行在第一页）
      const row = page.getByRole('row', { name: new RegExp(requestNo!) });
      await expect(row).toBeVisible();
      await row.click();
      await expect(page).toHaveURL(new RegExp(`${ENGINEER_LIST_PATH}/${createdRequestId}$`));

      // 未接单：唯一卡片内只有接单入口，没有回复表单
      await expect(page.locator('section.data-card')).toHaveCount(1);
      await expect(page.getByRole('button', { name: /^(loading\s+)?接\s*单$/ })).toBeVisible();
      await expect(page.getByLabel('回复正文')).toHaveCount(0);

      await page.getByRole('button', { name: /^(loading\s+)?接\s*单$/ }).click();
      await page.getByRole('button', { name: '确认接单' }).click();
      await expect(page.getByText('你已接单该维修申请，后续请跟进处理。')).toBeVisible();
      engineerAccepted = true;

      await page.getByLabel('回复正文').fill(REAL_FLOW_RESPONSE_TEXT);
      await selectResolutionStatus(page, '已解决');
      await page.getByRole('button', { name: /^(loading\s+)?提交回复$/ }).click();

      await expect(page.getByText('回复已提交。')).toBeVisible();
      // 回复 Mutation 恰好一次；真实回复行 ID 已被动记录（清理必须按本轮精确 ID 删除）
      expect(responseSubmitCount).toBe(1);
      expect(createdResponseId).toBeGreaterThan(0);
      // 接单与回复成功后仍是单张卡片：历史回复、反馈与状态都在同一卡片内
      await expect(page.locator('section.data-card')).toHaveCount(1);
      const engineerCard = page.locator('section.data-card');
      await expect(engineerCard).toContainText('回复已提交。');
      await expect(engineerCard.locator('.ant-timeline')).toContainText(REAL_FLOW_RESPONSE_TEXT);
      await expect(engineerCard).toContainText('我的接单');

      // ---------- 3. 客户查看回复 ----------
      await switchAccount(page, CUSTOMER_LOGIN_NAME, env.MOCK_SEED_PASSWORD, /\/customer$/);
      await page.goto(`${CUSTOMER_LIST_PATH}/${createdRequestId}`);

      // 2026-09-29 整合工作台：详情标题为申请编号 + 状态 pill（无「维修申请详情」heading）。
      // 左右栏 pill 文案会重复，编号与接单状态断言限定右栏详情面板；「已解决」同时出现在
      // 头部处理状态与回复条目，取首个。
      const customerDetailPane = page.locator('.customer-workspace-detail-pane');

      await expect(customerDetailPane.getByText(requestNo!).first()).toBeVisible();
      await expect(customerDetailPane.getByText('已接单', { exact: true })).toBeVisible();
      await expect(page.getByText('工程师回复（1）')).toBeVisible();
      await expect(page.getByText(ENGINEER_NICKNAME)).toBeVisible();
      await expect(customerDetailPane.getByText('已解决').first()).toBeVisible();
      await expect(page.getByText(REAL_FLOW_RESPONSE_TEXT)).toBeVisible();
      // 回复时间线只呈现昵称与文案，不泄露任何账号 ID 字样
      await expect(page.getByText(/engineerAccountId|accountId|customerAccountId/)).toHaveCount(0);
    } finally {
      // 清理兜底：统一入口先做编号白名单校验，再按解析出的精确 ID 走受保护清理。
      // 已接单并含本轮回复的申请跳过产品通道软删，直接按「精确 ID + 本轮预期事实 + 本轮回复
      // 精确 ID」在同一连接同一事务内核验后先删回复、再删申请，任一残留非零即抛错；
      // 未显式授权物理清理时入口抛错——清理失败必须是可观测的失败，而不是静默残留。
      if (requestNo) {
        await cleanupE2ERepairRequest({
          env,
          requestNo,
          customerAccountId,
          errorCode: REAL_FLOW_ERROR_CODE,
          equipmentModelId: createdEquipmentModelId,
          faultDescription: REAL_FLOW_FAULT_DESCRIPTION,
          acceptedEngineerAccountId: engineerAccepted ? engineerAccountId : undefined,
          expectedResponses:
            createdResponseId > 0
              ? [
                  {
                    expected: {
                      customerAccountId,
                      engineerAccountId,
                      requestId: createdRequestId,
                      resolutionStatus: 'RESOLVED',
                      responseText: REAL_FLOW_RESPONSE_TEXT,
                    },
                    id: createdResponseId,
                  },
                ]
              : undefined,
        });
      }
    }
  });
});

/**
 * 清理事务安全回归（真实库回滚验证）。
 *
 * 背景：清理脚本唯一的提交前守卫是 `INSERT INTO guard SELECT <违例和>` 的 CHECK。
 * 旧实现把「实际回复数 - 预期回复数」直接作为违例项，该项可为负——当「申请字段不符」(+1)
 * 与「预期回复缺失」(-1) 同时出现时会相消为 0，CHECK 误判通过并提交 DELETE；删除已落库，
 * 之后才由 Node 侧诊断发现，属于「核验未通过却已经删了数据」的安全缺陷。
 *
 * 本用例在 lithography_e2e 上用本轮专属夹具构造该组合，验证真实回滚（不是只比对 SQL 字符串）：
 * 事务必须中止，且被核验拦下的申请必须仍然在库中。
 */
test.describe('real backend repair request cleanup transaction guard', () => {
  test.beforeEach(async () => {
    await assertDedicatedRealChannel();
  });

  test('a mismatched request combined with a missing expected response aborts the transaction and keeps the row', async () => {
    test.setTimeout(120_000);
    const env = readBackendEnv();

    const customerAccountId = await realLoginAccountId(env, CUSTOMER_LOGIN_NAME);
    const engineerAccountId = await realLoginAccountId(env, ENGINEER_LOGIN_NAME);

    // 夹具真值：初值表示「尚未记录」，创建成功即必须已被记录；清理只接受本轮记录的值
    let modelId = 0;
    let requestId = 0;
    let requestNo: string | undefined;

    try {
      // 夹具：客户经真实 GraphQL 创建一条本轮专属申请（未接单、无回复）。
      // 走业务通道而非直接 INSERT，夹具因此天然满足全部外键与 CHECK 约束。
      const models = await realGraphqlCall(env, EQUIPMENT_MODELS_QUERY, {}, CUSTOMER_LOGIN_NAME);
      modelId = ((models.body as { data?: { equipmentModels?: Array<{ id: number }> } }).data
        ?.equipmentModels?.[0]?.id ?? 0) as number;
      expect(modelId).toBeGreaterThan(0);

      const created = await realGraphqlCall(
        env,
        CREATE_REQUEST_MUTATION,
        {
          input: {
            equipmentModelId: modelId,
            errorCode: GUARD_ERROR_CODE,
            faultDescription: GUARD_FAULT_DESCRIPTION,
          },
        },
        CUSTOMER_LOGIN_NAME,
      );
      expect((created.body as { errors?: unknown[] }).errors).toBeUndefined();
      const createdRecord = (
        created.body as {
          data?: { createRepairRequest?: { id: number; requestNo: string } };
        }
      ).data?.createRepairRequest;

      expect(createdRecord?.id).toBeGreaterThan(0);
      requestId = createdRecord?.id as number;
      requestNo = createdRecord?.requestNo as string;
      expect(requestNo).toMatch(REQUEST_NO_PATTERN);

      // 组合违例：申请字段不符（描述与库内不符）+ 预期回复 ID 缺失（库中不存在该回复行）。
      // 修复后两项各自非负，违例和不为 0，守卫在 DELETE 之前中止并回滚。
      expect(() =>
        deleteRepairRequestRowsByIds([
          {
            expected: {
              customerAccountId,
              equipmentModelId: modelId,
              errorCode: GUARD_ERROR_CODE,
              faultDescription: GUARD_MISMATCHED_DESCRIPTION,
              requestNo: requestNo as string,
            },
            expectedResponses: [
              {
                expected: {
                  customerAccountId,
                  engineerAccountId,
                  requestId,
                  resolutionStatus: 'RESOLVED',
                  responseText: GUARD_RESPONSE_TEXT,
                },
                id: GUARD_MISSING_RESPONSE_ID,
              },
            ],
            id: requestId,
          },
        ]),
      ).toThrow(/事务中止/);

      // 核心断言：真实回滚——被核验拦下的申请必须仍在库中（旧实现此处已被 DELETE 提交）
      expect(findRepairRequestByRequestNo(requestNo as string, 'id')).toBe(String(requestId));
    } finally {
      // 夹具精确清理：正确预期 + 不声明 expectedResponses → 统一入口先软删、再受保护物理清理
      if (requestNo !== undefined && requestId > 0 && modelId > 0) {
        await cleanupE2ERepairRequest({
          env,
          requestNo,
          customerAccountId,
          errorCode: GUARD_ERROR_CODE,
          equipmentModelId: modelId,
          faultDescription: GUARD_FAULT_DESCRIPTION,
        });
        // 清理后再核对零残留：夹具既不残留申请、也不残留回复
        expect(findRepairRequestByRequestNo(requestNo, 'id')).toBe('');
      }
    }
  });
});

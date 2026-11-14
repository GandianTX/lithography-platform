// e2e/repair-request-create-real.spec.ts
// 客户创建维修申请的真实后端链路（自 repair-request-create.spec.ts 拆出）。
//
// 只有专用隔离入口（playwright.real-backend-dedicated.config.ts）收集本文件；普通默认入口
// （playwright.config.ts）不收集，保证 `npm run test:e2e` 默认只跑 mock-only、不触达真实后端，
// 也不写共享开发库 lithography_drill。专用入口固定 lithography_e2e 并显式注入严格模式。
//
// 共享工具（env/探针/mysql/真实登录）见 ./helpers/real-backend；前提不满足时用例自动跳过
// （专用入口严格模式下直接失败，不以 skipped 掩盖），运行后自行清理产生的申请行。

import { expect, test } from '@playwright/test';

import { readStoredAuthSession } from './helpers/auth-session-seed';
import {
  cleanupE2ERepairRequest,
  findRepairRequestByRequestNo,
  readBackendEnv,
  realLoginAccountId,
  REQUEST_NO_PATTERN,
  resolveRealBackendPrerequisite,
} from './helpers/real-backend';

const CREATE_PAGE_PATH = '/customer/repair-requests/new';
const CUSTOMER_HOME_PATH = '/customer';
// 自建行的唯一故障码：既填进表单，也作为统一清理入口的预期事实之一（本轮测试自身掌握的值）
const CREATE_ERROR_CODE = 'E2E-REAL';
// 故障描述同口径：填进表单的值即本轮预期事实，物理清理的同一事务内会逐字段核验
const CREATE_FAULT_DESCRIPTION = '阶段五真实后端 e2e 用例';

type GraphQLOperationPayload = {
  query?: string;
  variables?: { input?: { equipmentModelId?: number } };
};

test.describe('real backend mutation', () => {
  test.beforeEach(async () => {
    // 共享预检：普通入口返回跳过原因（保持既有 skip 语义），专用入口严格模式直接失败
    const skipReason = await resolveRealBackendPrerequisite();
    test.skip(skipReason !== null, skipReason ?? '');
  });

  test('customer completes real login, creates a repair request and the row lands in db', async ({
    page,
  }) => {
    test.setTimeout(45_000);

    const env = readBackendEnv();
    const expectedAccountId = await realLoginAccountId(env);
    const mutationAuthorizations: string[] = [];
    // 本轮自建行的预期事实之一：创建 Mutation 实际发送的设备型号（被动记录，不回读目标行）。
    // 初值 0 表示「尚未记录」：创建成功后必须已被记录（见下方齐备性断言），清理入口只接受正整数。
    let createdEquipmentModelId = 0;

    // 只观察不拦截：记录真实受保护通道的 Authorization 头，并按同一口径被动记录设备型号
    await page.route('**/graphql', (route) => {
      const payload = route.request().postDataJSON() as GraphQLOperationPayload;

      if (payload.query?.includes('mutation CreateRepairRequest')) {
        mutationAuthorizations.push(route.request().headers().authorization ?? '');

        const modelId = payload.variables?.input?.equipmentModelId;

        if (typeof modelId === 'number') {
          createdEquipmentModelId = modelId;
        }
      }

      return route.continue();
    });

    // 真实登录（蔡的登录页 + 真实后端）
    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_customer_alpha');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/customer$/);

    // 自建行落库始于下方提交，之后任何断言失败都必须仍能清理（try/finally 兜底）
    let requestNo: string | undefined;
    try {
      // 真实创建：型号来自真实库，提交走真实受保护通道
      await page.goto(CREATE_PAGE_PATH);
      await expect(page.getByRole('button', { name: '提交申请' })).toBeEnabled();
      await page.getByRole('combobox').click();
      await page.locator('.ant-select-item-option').first().click();
      await page.getByLabel('设备错误码').fill(CREATE_ERROR_CODE);
      await page.getByLabel('故障描述').fill(CREATE_FAULT_DESCRIPTION);
      await page.getByRole('button', { name: '提交申请' }).click();

      await expect(page.getByText('维修申请创建成功')).toBeVisible();

      requestNo = (await page.getByText(/申请编号：/).textContent())
        ?.replace('申请编号：', '')
        .trim();
      expect(requestNo).toBeTruthy();
      // 白名单校验：业务断言（受保护 helper 内部还有强制校验，见 real-backend.ts 守卫说明）。
      expect(requestNo).toMatch(REQUEST_NO_PATTERN);
      // 清理所需预期事实齐备性：创建成功即必须已被动记录到发送的设备型号，探针失效时用例转红
      expect(createdEquipmentModelId).toBeGreaterThan(0);

      // 受保护通道证据：真实 Mutation 携带 Bearer
      expect(mutationAuthorizations.length).toBe(1);
      expect(mutationAuthorizations[0]).toMatch(/^Bearer .+/);

      // 落库证据：账号取自 JWT（customer_account_id 与 mock 客户一致），初始未接单未删除
      const row = findRepairRequestByRequestNo(
        requestNo!,
        'customer_account_id, is_accepted, deleted_at',
      );
      expect(row.split('\t')[0]).toBe(String(expectedAccountId));
      expect(row.split('\t')[1]).toBe('0');
      expect(row.split('\t')[2]).toMatch(/^NULL$/);
    } finally {
      // 清理兜底：断言中途失败时仍清理本用例产生的行，保持基线干净。
      // 统一入口内部先做编号白名单校验，再按精确 ID 软删；仅专用隔离库 + 显式授权时
      // 才按「精确 ID + 本轮预期事实」走受保护物理清理（同一连接同一事务核验后删除，
      // 残留非零即抛错，因此这里不再重复断言 COUNT(*)=0）；对不存在行是 no-op，幂等成立。
      // 预期事实（编号 / 客户账号 / 故障码 / 设备型号 / 故障描述）全部取本轮自有值：
      // 型号来自创建成功时已记录的被动探针，缺失即由入口的正整数白名单拒绝清理。
      if (requestNo) {
        await cleanupE2ERepairRequest({
          env,
          requestNo,
          customerAccountId: expectedAccountId,
          errorCode: CREATE_ERROR_CODE,
          equipmentModelId: createdEquipmentModelId,
          faultDescription: CREATE_FAULT_DESCRIPTION,
        });
      }
    }
  });

  // 2026-08-29 负责人裁定：SUPER_ADMIN 第一版不代客户创建，路由层与 ENGINEER 一致拒绝。
  // 后端精确 CUSTOMER 约束保持不变（06 组 auth spec 已覆盖 FORBIDDEN）；此处锁定真实链路：
  // 超管真实登录后直输创建页路径被重定向回 /admin，会话保留，全程无创建 Mutation 到达后端。
  test('super admin is redirected to the admin home before any mutation reaches the backend', async ({
    page,
  }) => {
    test.setTimeout(45_000);

    const env = readBackendEnv();
    const mutationAuthorizations: string[] = [];

    await page.route('**/graphql', (route) => {
      const payload = route.request().postDataJSON() as GraphQLOperationPayload;

      if (payload.query?.includes('mutation CreateRepairRequest')) {
        mutationAuthorizations.push(route.request().headers().authorization ?? '');
      }

      return route.continue();
    });

    // SUPER_ADMIN 真实登录：登录与默认入口不受本次策略调整影响
    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_super_admin');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/admin$/);

    // 客户首页可继承访问，但创建入口置灰并附说明（与路由层拒绝同口径）；
    // 空态左栏的「发起维修申请」与页头同名，限定页头区域断言（strict mode）。
    await page.goto(CUSTOMER_HOME_PATH);
    await expect(
      page.locator('.page-header').getByRole('button', { name: '发起维修申请' }),
    ).toBeDisabled();
    await expect(page.getByText('超管不能代客户发起维修申请')).toBeVisible();

    // 直输创建页路径：路由层拒绝，跳回管理主页；会话保留（非 auth 失效）
    await page.goto(CREATE_PAGE_PATH);
    await expect(page).toHaveURL(/\/admin$/);
    expect(await readStoredAuthSession(page)).not.toBeNull();

    // 反向链路证据：真实后端全程未收到任何创建 Mutation（防护发生在进入页面之前）
    expect(mutationAuthorizations).toHaveLength(0);
  });
});

// e2e/registration-organization-name-real.spec.ts
// P2-2 · 客户手填公司名同名提示的真实浏览器验收（专用隔离入口收集）。
//
// 运行入口：
//   E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_DEDICATED_DB_NAME=lithography_work_e2e \
//     npm run test:e2e:real-backend-dedicated -- registration-organization-name-real
//
// 证据边界：
// - 主流程完全走真实浏览器 + 真实 API：不打开下拉、不搜索、不滚动，直接手填一个位于
//   候选第 2 页的启用受管公司名称，出现同名提示后仍按手填分支提交；
// - 提交后由真实注册响应 accountId 定位账号，再经归属事实（资料 customer_organization_id
//   ↔ 成员关系 organization_id）互相印证后核验手填公司，确认其与受管公司不同、
//   未进入一级维护名单，且新公司不出现在公开候选（因未受管）；
// - 异步反例 / 清空 / 改选名单 / 查询报错分支允许受控网络替身；只有同名查询被替换，
//   其余请求继续走真实后端。
//
// 清理（B 复审 P1）：本轮受管夹具公司、手填公司、账号、资料、成员关系全部按真实数据库
// ID 登记，afterAll 只按台账精确删除——不再按登录邮箱、公司名称或编码前缀 LIKE 扫描。
// 另建两条**不入台账**的外部哨兵（与目标同名未受管、与编码前缀相似的编码），
// 收尾后逐字段核验其事实不变，再用独立台账回收。

import { expect, type Page, test } from '@playwright/test';

import { readStoredAuthSession } from './helpers/auth-session-seed';
import {
  BACKEND_GRAPHQL,
  mysqlQuery,
  resolveRealBackendPrerequisite,
} from './helpers/real-backend';
import {
  type RegistrationCapture,
  startRegistrationCapture,
} from './helpers/registration-response-capture';
import {
  cleanupRegistrationRound,
  createRegistrationRoundLedger,
  insertRegistrationRoundOrganization,
  readRegistrationRoundOrganization,
  type RegistrationRoundOrganizationFacts,
} from './helpers/registration-round-cleanup';

const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CODE_PREFIX = `E2E_NM_${RUN_TAG}_`;
const NAME_PREFIX = `E2E-NM-${RUN_TAG}-`;
/** 位于候选第 2 页的目标受管公司名称（24 条首屏占位 + 排序靠后的目标） */
const TARGET_NAME = `${NAME_PREFIX}99`;
const LOGIN_EMAIL = `e2e.name.${RUN_TAG}@example.com`;
const LOGIN_PASSWORD = 'Str0ng!Passw0rd';
const HINT = '发现同名公司，可从名单选择；手填名称不会自动合并。';
const SUCCESS = '账号已开通，请使用登录邮箱与密码登录。';

/** 外部哨兵 1：与目标同名但未受管（旧收尾按名称会误删） */
const SAME_NAME_SENTINEL = {
  isManagedCompany: false,
  kind: 'CLIENT' as const,
  name: TARGET_NAME,
  organizationCode: `E2E_NM_SENT_${RUN_TAG}`,
  status: 'ACTIVE',
};

/** 外部哨兵 2：编码落在旧收尾的 LIKE 前缀内（下划线还是 LIKE 通配符） */
const SIMILAR_CODE_SENTINEL = {
  isManagedCompany: false,
  kind: 'CLIENT' as const,
  name: `${NAME_PREFIX}SENTINEL`,
  organizationCode: `${CODE_PREFIX}SENTINEL`,
  status: 'ACTIVE',
};

const SEARCH_QUERY = `
  query RegistrationOrganizationSearch($pagination: PaginationArgs!, $keyword: String) {
    registrationOrganizationSearch(pagination: $pagination, keyword: $keyword) {
      items { id name }
      total
      page
      pageSize
    }
  }
`;

type CandidatePage = {
  items: Array<{ id: number; name: string }>;
  total: number;
};

/** 调用公开候选查询（真实后端，无登录态） */
async function queryCandidates(keyword?: string): Promise<CandidatePage> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
        ...(keyword ? { keyword } : {}),
      },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const body = (await response.json()) as {
    data?: { registrationOrganizationSearch?: CandidatePage };
    errors?: unknown[];
  };
  const page = body.data?.registrationOrganizationSearch;
  if (!page) {
    throw new Error(`公开候选查询失败：${JSON.stringify(body.errors ?? body)}`);
  }
  return page;
}

/** 解析 mysql -N -B 的制表符输出 */
function parseRows(output: string): string[][] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
}

/** 拦截同名精确查询（其余请求继续走真实后端） */
async function installNameCheckStub(
  page: Page,
  resolveExists: (rawName: string) => Promise<boolean> | boolean,
): Promise<void> {
  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as {
      query?: string;
      variables?: { name?: string };
    };

    if (payload.query?.includes('RegistrationOrganizationNameExists')) {
      const exists = await resolveExists(payload.variables?.name ?? '');
      await route.fulfill({
        body: JSON.stringify({ data: { registrationOrganizationNameExists: exists } }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    await route.continue();
  });
}

/** 本轮台账：受管夹具公司 + 手填公司 + 账号 + 资料 + 成员关系 */
const roundLedger = createRegistrationRoundLedger();
/** 外部哨兵台账：只含本轮创建的两条哨兵，验证不变后独立回收 */
const sentinelLedger = createRegistrationRoundLedger();
let sentinelFacts: Array<{ id: number; facts: RegistrationRoundOrganizationFacts }> = [];
/** 候选第 2 页目标受管公司的真实 ID（beforeAll 插入时登记） */
let targetManagedCompanyId = 0;
/** 同名前哨兵的真实 ID（beforeAll 插入时登记） */
let sameNameSentinelId = 0;

/**
 * 注册响应的早期接管（P2-01）：点击前挂接，成功响应一到即按真实 accountId 登记，
 * 早于任何页面文案断言；afterAll 必须先等它收敛再清理。实现见公共 helper。
 */
let registrationCapture: RegistrationCapture | null = null;

const startCapture = (page: Page): RegistrationCapture => {
  registrationCapture = startRegistrationCapture(page, roundLedger, {
    expectedSelfFilledName: TARGET_NAME,
    loginEmail: LOGIN_EMAIL,
  });
  return registrationCapture;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 收尾失败也要继续执行后续收尾动作，最后抛出全部失败（不掩盖任一错误） */
async function runTeardownSteps(steps: Array<() => void | Promise<void>>): Promise<void> {
  const failures: unknown[] = [];

  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new Error(
      `收尾出现 ${failures.length} 个失败：${failures.map(describeError).join('；')}`,
    );
  }
}

test.describe('客户注册手填公司名同名提示（真实链路）', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // 专用入口严格模式下前提不满足直接失败，不以 skip 掩盖
    const skipReason = await resolveRealBackendPrerequisite();
    test.skip(skipReason !== null, skipReason ?? '');

    try {
      for (let index = 1; index <= 24; index += 1) {
        const suffix = String(index).padStart(2, '0');
        insertRegistrationRoundOrganization(roundLedger, {
          isManagedCompany: true,
          kind: 'CLIENT',
          name: `${NAME_PREFIX}${suffix}`,
          organizationCode: `${CODE_PREFIX}F${suffix}`,
        });
      }
      targetManagedCompanyId = insertRegistrationRoundOrganization(roundLedger, {
        isManagedCompany: true,
        kind: 'CLIENT',
        name: TARGET_NAME,
        organizationCode: `${CODE_PREFIX}TARGET`,
      });

      for (const sentinel of [SAME_NAME_SENTINEL, SIMILAR_CODE_SENTINEL]) {
        const id = insertRegistrationRoundOrganization(sentinelLedger, sentinel);
        sentinelFacts = [...sentinelFacts, { facts: readRegistrationRoundOrganization(id), id }];
      }
      sameNameSentinelId = sentinelFacts[0].id;
    } catch (error) {
      // setup 中断：已插入的那部分按台账精确回收。
      // 原错误必须保留：清理抛错不得覆盖 setup 原错，两段错误一起呈现；
      // 清理成功时台账已释放，afterAll 不会对同一批 ID 重复删除。
      const setupError = error;
      try {
        await runTeardownSteps([
          () => cleanupRegistrationRound(roundLedger),
          () => {
            for (const { facts, id } of sentinelFacts) {
              expect(readRegistrationRoundOrganization(id)).toEqual(facts);
            }
          },
          () => cleanupRegistrationRound(sentinelLedger),
        ]);
      } catch (cleanupError) {
        throw new Error(
          `注册夹具 setup 失败，且按台账收尾也失败；setup=${describeError(setupError)}；cleanup=${describeError(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw setupError;
    }
  });

  test.afterAll(async () => {
    await runTeardownSteps([
      // 0. 先等注册响应接管收敛：已返回的成功响应必须先入账，再谈清理
      () => registrationCapture?.settled ?? Promise.resolve(),
      // 1. 只按本轮真实 ID 台账清理
      () => cleanupRegistrationRound(roundLedger),
      // 2. 外部哨兵必须逐字段保持不变（未被按名称/前缀误删或改动）
      () => {
        for (const { facts, id } of sentinelFacts) {
          expect(readRegistrationRoundOrganization(id)).toEqual(facts);
        }
      },
      // 3. 哨兵自身按独立台账精确回收
      () => cleanupRegistrationRound(sentinelLedger),
    ]);
  });

  test('手填候选第 2 页同名公司：出现提示、允许提交并创建独立未受管公司', async ({ page }) => {
    test.setTimeout(90_000);

    const graphqlBodies: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/graphql')) {
        graphqlBodies.push(request.postData() ?? '');
      }
    });

    // 证据 1：候选首屏无目标（前端从未加载第 2 页），同名前哨兵也未受管不在候选内
    const firstPage = await queryCandidates();
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.items.some((item) => item.name === TARGET_NAME)).toBe(false);

    await page.goto('/register/customer');
    await page.getByLabel('登录邮箱').fill(LOGIN_EMAIL);
    await page.getByLabel('密码').fill(LOGIN_PASSWORD);

    // 证据 2：不打开下拉、不搜索、不滚动，直接手填后页目标
    await page.getByLabel('自家公司名称').fill(TARGET_NAME);
    await expect(page.getByText(HINT)).toBeVisible({ timeout: 10_000 });

    expect(graphqlBodies.some((body) => body.includes('RegistrationOrganizationNameExists'))).toBe(
      true,
    );
    // 从未发起带关键字（下拉搜索）的候选请求
    expect(
      graphqlBodies.some(
        (body) => body.includes('RegistrationOrganizationSearch') && body.includes('"keyword"'),
      ),
    ).toBe(false);

    // P2-01：点击前接管真实注册响应——成功响应一到即登记，早于成功文案断言
    const capture = startCapture(page);

    await page.getByRole('button', { name: '注册并开通' }).click();
    await expect(page.getByText(SUCCESS)).toBeVisible({ timeout: 20_000 });

    // 响应接管收敛后才有完整台账；接管失败时显式抛出（不静默）
    await capture.settled;
    if (capture.error) {
      throw capture.error;
    }
    const located = capture.located;
    if (located === null) {
      throw new Error('注册响应接管未取得账号归属，停止后续断言（保留诊断，不猜测删除）');
    }

    expect(located.selfFilledOrganizationId).not.toBe(targetManagedCompanyId);
    const selfFilledFacts = readRegistrationRoundOrganization(located.selfFilledOrganizationId);
    expect(selfFilledFacts.name).toBe(TARGET_NAME);
    expect(selfFilledFacts.isManagedCompany).toBe(false);
    expect(selfFilledFacts.status).toBe('ACTIVE');

    // 归属正确：成员关系与客户资料的可信归属都指向新公司（由 locate 逐字段核验）
    const accountId = located.accountId;
    expect(accountId).toBeGreaterThan(0);
    expect(
      Number(
        mysqlQuery(
          `SELECT organization_id FROM organization_membership WHERE account_id = ${accountId}`,
        ),
      ),
    ).toBe(located.selfFilledOrganizationId);
    expect(
      Number(
        mysqlQuery(
          `SELECT customer_organization_id FROM base_user_info WHERE account_id = ${accountId}`,
        ),
      ),
    ).toBe(located.selfFilledOrganizationId);

    // 同名前哨兵仍是未受管外部行，且未被本轮注册复用
    const sentinelCompanyRows = parseRows(
      mysqlQuery(
        `SELECT id, is_managed_company FROM organization WHERE name = '${TARGET_NAME}' AND id <> ${targetManagedCompanyId} AND id <> ${located.selfFilledOrganizationId}`,
      ),
    );
    expect(sentinelCompanyRows.length).toBe(1);
    expect(Number(sentinelCompanyRows[0][0])).toBe(sameNameSentinelId);

    // 新公司未进入工程师候选（未受管），同名候选只剩受管公司
    const sameNameCandidates = await queryCandidates(TARGET_NAME);
    const ids = sameNameCandidates.items.map((item) => item.id);
    expect(ids).toContain(targetManagedCompanyId);
    expect(ids).not.toContain(located.selfFilledOrganizationId);

    // 注册不签发会话
    expect(await readStoredAuthSession(page)).toBeNull();
  });

  test('异步反例：A 有同名但晚到、B 无同名，最终只保留 B 的状态', async ({ page }) => {
    let releaseA: (() => void) | undefined;
    let markAStarted: (() => void) | undefined;
    const aStarted = new Promise<void>((resolve) => {
      markAStarted = resolve;
    });

    await installNameCheckStub(page, async (rawName) => {
      if (rawName.includes('stub-a')) {
        markAStarted?.();
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
        return true;
      }
      return false;
    });

    await page.goto('/register/customer');
    const nameInput = page.getByLabel('自家公司名称');

    await nameInput.fill('STUB-A 公司');
    await aStarted;

    await nameInput.fill('STUB-B 公司');
    // B 的防抖 + 响应
    await page.waitForTimeout(800);
    await expect(page.getByText(HINT)).toHaveCount(0);

    // A 的响应晚到，不得恢复已切换到 B 的提示
    releaseA?.();
    await page.waitForTimeout(400);
    await expect(page.getByText(HINT)).toHaveCount(0);
  });

  test('清空手填名称后同名提示消失（真实 API）', async ({ page }) => {
    await page.goto('/register/customer');
    const nameInput = page.getByLabel('自家公司名称');

    await nameInput.fill(TARGET_NAME);
    await expect(page.getByText(HINT)).toBeVisible({ timeout: 10_000 });

    await nameInput.fill('');
    await expect(page.getByText(HINT)).toHaveCount(0);
  });

  test('改选名单公司后手填字段与同名提示一并消失（真实 API）', async ({ page }) => {
    await page.goto('/register/customer');
    await page.getByLabel('自家公司名称').fill(TARGET_NAME);
    await expect(page.getByText(HINT)).toBeVisible({ timeout: 10_000 });

    await page.getByRole('combobox', { name: '所属公司' }).click();
    await page.locator('.ant-select-item-option').first().click();

    await expect(page.getByLabel('自家公司名称')).toHaveCount(0);
    await expect(page.getByText(HINT)).toHaveCount(0);
  });

  test('精确查询报错时按未命中处理，不显示提示也不阻断表单', async ({ page }) => {
    await page.route('**/graphql', async (route) => {
      const payload = route.request().postDataJSON() as { query?: string };
      if (payload.query?.includes('RegistrationOrganizationNameExists')) {
        await route.fulfill({
          body: JSON.stringify({ errors: [{ message: 'stub failure' }] }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/register/customer');
    await page.getByLabel('自家公司名称').fill(TARGET_NAME);

    await page.waitForTimeout(1_000);
    await expect(page.getByText(HINT)).toHaveCount(0);
    await expect(page.getByLabel('自家公司名称')).toHaveValue(TARGET_NAME);
    await expect(page.getByRole('button', { name: '注册并开通' })).toBeEnabled();
  });
});

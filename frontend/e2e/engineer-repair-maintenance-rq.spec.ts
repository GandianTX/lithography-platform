// e2e/engineer-repair-maintenance-rq.spec.ts

/**
 * PR #20 合并后定向验收（隔离浏览器，mock-only）：
 * - A 结单版本冲突：提示刷新、重新确认，不自动重试；
 * - D 首次保存并绑定原件成功，紧接着详情读回失败一次：
 *   「已保存，刷新失败」、暂存原件不再等待提交、保存请求总数仍为 1，
 *   点「重试刷新」只重发详情查询；
 * - D 保存请求本身失败：保留输入，不误报成功。
 *
 * 本文件只跑在默认 playwright.config.ts（不启动后端、不连 MySQL）：
 * - 已登记 GraphQL operation 与 /api/stored-files 由测试逐条应答；
 * - 未登记的业务请求一律留痕并在 afterEach 失败，不转发到默认 API。
 */

import { expect, type Page, type Route, test } from '@playwright/test';
import { Buffer } from 'node:buffer';

import { seedAuthSession } from './helpers/auth-session-seed';

const REQUEST_ID = 8802;
const DETAIL_PATH = `/engineer/repair-requests/${REQUEST_ID}`;
const ENGINEER_NAME = '李工';

type GraphQLPayload = {
  operationName?: string;
  query?: string;
  variables?: Record<string, unknown>;
};

const unregisteredOperations: string[] = [];

function buildDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    requestNo: `RR20260902000000AC${REQUEST_ID}`,
    equipmentModel: { id: 8801, modelCode: 'E2E-LS', modelName: '光刻机 E2E' },
    errorCode: 'E-9001',
    faultDescription: '曝光平台漂移，需现场检修',
    contentMd: '# E2E 测试申请',
    createdAt: '2026-09-01T08:00:00.000Z',
    isAccepted: true,
    acceptedAt: '2026-09-02T09:00:00.000Z',
    latestResolutionStatus: null,
    customerNickname: '林客户',
    customerCompanyName: '林氏精密制造',
    acceptanceViewStatus: 'MINE',
    acceptedEngineerNickname: '测试会话',
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: null,
    processEntries: [],
    maintenance: {
      maintenanceDate: null,
      engineerName: ENGINEER_NAME,
      resetResult: null,
      supplementaryNote: null,
      versionNo: 0,
      attachment: null,
    },
    maintenanceSteps: [],
    maintenanceFaultPanels: [],
    intake: null,
    canEditMaintenance: true,
    responses: [],
    ...overrides,
  };
}

type Stubs = {
  onDetail: (route: Route, count: number) => Promise<void> | void;
  onClose: (route: Route, input: Record<string, unknown>, count: number) => Promise<void> | void;
  onSave: (route: Route, input: Record<string, unknown>) => Promise<void> | void;
};

async function fulfillData(route: Route, data: unknown) {
  await route.fulfill({
    body: JSON.stringify({ data }),
    contentType: 'application/json',
    status: 200,
  });
}

async function fulfillGraphQLError(route: Route, code: string, errorMessage: string) {
  await route.fulfill({
    body: JSON.stringify({
      errors: [
        {
          extensions: { code, errorMessage },
          message: 'internal detail',
        },
      ],
    }),
    contentType: 'application/json',
    status: 200,
  });
}

async function installRoutes(page: Page, stubs: Stubs) {
  const counters = { close: 0, detail: 0, save: 0, upload: 0 };

  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON() as GraphQLPayload;
    const operationName = payload.operationName ?? '';

    if (operationName === 'EngineerRepairRequest') {
      counters.detail += 1;
      await stubs.onDetail(route, counters.detail);
      return;
    }

    if (operationName === 'EngineerRepairRequestRevisionHistory') {
      await fulfillData(route, { engineerRepairRequestRevisionHistory: [] });
      return;
    }

    if (operationName === 'MySessionIdentity') {
      await fulfillData(route, {
        mySessionIdentity: {
          accountId: 900201,
          role: 'ENGINEER',
          adminLevel: null,
          customerOrganizationId: null,
          engineerOrganizationId: null,
          adminOrganizationId: null,
          registrationOrganizationId: null,
          restriction: 'NONE',
        },
      });
      return;
    }

    if (operationName === 'CloseRepairRequest') {
      counters.close += 1;
      const input = (payload.variables?.input ?? {}) as Record<string, unknown>;
      await stubs.onClose(route, input, counters.close);
      return;
    }

    if (operationName === 'SaveRepairRequestMaintenance') {
      counters.save += 1;
      const input = (payload.variables?.input ?? {}) as Record<string, unknown>;
      await stubs.onSave(route, input);
      return;
    }

    unregisteredOperations.push(operationName || '(missing operationName)');
    await fulfillGraphQLError(route, 'BAD_USER_INPUT', `未登记 operation：${operationName}`);
  });

  await page.route('**/api/stored-files', async (route) => {
    if (route.request().method() !== 'POST') {
      unregisteredOperations.push(`stored-files ${route.request().method()}`);
      await route.fulfill({ status: 500 });
      return;
    }
    counters.upload += 1;
    await fulfillData(route, {
      fileId: '11111111-1111-4111-8111-111111111111',
      uploadContextId: '22222222-2222-4222-8222-222222222222',
      originalFilename: '合成原件.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      checksumSha256: 'a'.repeat(64),
    });
  });

  return counters;
}

test.beforeEach(() => {
  unregisteredOperations.length = 0;
});

test.afterEach(() => {
  expect(unregisteredOperations, '存在未登记的业务请求').toEqual([]);
});

async function openDetail(page: Page) {
  await page.goto(DETAIL_PATH);
  await expect(page.getByText('内部维修记录')).toBeVisible();
}

test('D 首次保存并绑定原件后详情读回失败：已保存，刷新失败；重试只重发详情查询', async ({
  page,
}) => {
  await seedAuthSession(page, 'ENGINEER');

  let failNextDetail = false;
  let detailVersion = 0;

  const counters = await installRoutes(page, {
    onDetail: async (route) => {
      if (failNextDetail) {
        failNextDetail = false;
        await route.fulfill({ status: 500, body: 'readback failed' });
        return;
      }
      await fulfillData(route, {
        engineerRepairRequest: buildDetail({
          maintenance: {
            maintenanceDate: detailVersion === 0 ? null : '2026-11-18',
            engineerName: ENGINEER_NAME,
            resetResult: null,
            supplementaryNote: detailVersion === 0 ? null : '首次保存的补充说明',
            versionNo: detailVersion,
            attachment: null,
          },
          canEditMaintenance: detailVersion === 0,
        }),
      });
    },
    onClose: async (route) => {
      await fulfillData(route, { closeRepairRequest: { requestId: REQUEST_ID } });
    },
    onSave: async (route, input) => {
      expect(input).toMatchObject({
        requestId: REQUEST_ID,
        expectedVersion: 0,
        attachment: {
          fileId: '11111111-1111-4111-8111-111111111111',
          uploadContextId: '22222222-2222-4222-8222-222222222222',
        },
      });
      detailVersion = 1;
      failNextDetail = true;
      await fulfillData(route, {
        saveRepairRequestMaintenance: {
          maintenanceDate: '2026-11-18',
          engineerName: ENGINEER_NAME,
          resetResult: null,
          supplementaryNote: '首次保存的补充说明',
          versionNo: 1,
          attachment: null,
        },
      });
    },
  });

  await openDetail(page);

  // v0：姓名只读并由可信资料回填
  const engineerInput = page.getByRole('textbox', { name: /维修工程师/ });
  await expect(engineerInput).toHaveValue(ENGINEER_NAME);
  await expect(engineerInput).toBeDisabled();

  // 上传暂存原件
  await page.getByLabel('维修原件').setInputFiles({
    buffer: Buffer.from('%PDF-1.4'),
    mimeType: 'application/pdf',
    name: '合成原件.pdf',
  });
  await expect(page.getByText('已上传暂存')).toBeVisible();

  await page.getByPlaceholder('补充其他维修事实、备件或后续建议…').fill('首次保存的补充说明');

  const saveButton = page.getByRole('button', { name: '保存维修记录并绑定原件' });
  await saveButton.click();

  // 保存成功、回读失败：明确区分，不把已保存伪报为失败
  await expect(page.getByText('已保存，刷新失败')).toBeVisible();
  await expect(page.getByText('保存已生效，请重试刷新以同步最新版本。')).toBeVisible();
  // 暂存原件已被本次保存消费，不再等待提交
  await expect(page.getByText('已上传暂存')).toHaveCount(0);
  expect(counters.save).toBe(1);
  expect(counters.upload).toBe(1);

  const detailBeforeRetry = counters.detail;
  await page.getByRole('button', { name: '重试刷新' }).click();
  await expect(page.getByText('已保存，刷新失败')).toHaveCount(0);
  await expect.poll(() => counters.detail).toBe(detailBeforeRetry + 1);
  expect(counters.save).toBe(1);
});

test('D 保存请求本身失败：保留输入，不误报「已保存」', async ({ page }) => {
  await seedAuthSession(page, 'ENGINEER');

  const counters = await installRoutes(page, {
    onDetail: async (route) => {
      await fulfillData(route, { engineerRepairRequest: buildDetail() });
    },
    onClose: async (route) => {
      await fulfillData(route, { closeRepairRequest: { requestId: REQUEST_ID } });
    },
    onSave: async (route) => {
      await fulfillGraphQLError(route, 'INTERNAL_SERVER_ERROR', '维修记录保存失败，请稍后重试');
    },
  });

  await openDetail(page);

  const note = page.getByPlaceholder('补充其他维修事实、备件或后续建议…');
  await note.fill('失败后仍需保留的输入');
  const detailBeforeSave = counters.detail;

  await page.getByRole('button', { name: '保存维修记录' }).click();

  await expect(page.getByText('维修记录保存失败，请稍后重试')).toBeVisible();
  await expect(page.getByText('已保存，刷新失败')).toHaveCount(0);
  await expect(note).toHaveValue('失败后仍需保留的输入');
  expect(counters.save).toBe(1);
  expect(counters.detail).toBe(detailBeforeSave);
});

test('A 结单版本冲突：提示刷新并重新确认，不自动重试', async ({ page }) => {
  await seedAuthSession(page, 'ENGINEER');

  let detailVersion = 0;
  const submittedVersions: unknown[] = [];

  const counters = await installRoutes(page, {
    onDetail: async (route) => {
      await fulfillData(route, {
        engineerRepairRequest: buildDetail({
          maintenance: {
            maintenanceDate: detailVersion === 0 ? null : '2026-11-18',
            engineerName: ENGINEER_NAME,
            resetResult: null,
            supplementaryNote: '结单前的保存内容',
            versionNo: detailVersion,
            attachment: null,
          },
          canEditMaintenance: detailVersion === 0,
        }),
      });
    },
    onClose: async (route, input, count) => {
      submittedVersions.push(input.maintenanceVersionNo);
      if (count === 1) {
        await fulfillGraphQLError(route, 'CONFLICT', '维修记录已更新，请刷新后重新确认结单');
        detailVersion = 4;
        return;
      }
      await fulfillData(route, {
        closeRepairRequest: {
          requestId: REQUEST_ID,
          closureStatus: 'CLOSED',
          closedAt: '2026-11-19T08:00:00.000Z',
          closureReason: null,
          handlingResult: 'FIXED',
          handlingStatus: 'COMPLETED',
          handlingEndedAt: '2026-11-19T08:00:00.000Z',
        },
      });
    },
    onSave: async (route) => {
      await fulfillGraphQLError(route, 'CONFLICT', '未登记的保存路径');
    },
  });

  await openDetail(page);

  await page.getByLabel('处理结果').click();
  await page.locator('.ant-select-dropdown .ant-select-item-option[title="故障修复"]').click();
  await page.getByRole('button', { name: /^结\s*单$/ }).click();
  await page.getByRole('button', { name: '确认结单' }).click();

  // 冲突：提示 + 刷新入口，且只发生一次 mutation（无自动重试）
  await expect(page.getByText('维修记录已更新，请刷新后重新确认结单')).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新详情' })).toBeVisible();
  expect(counters.close).toBe(1);

  // 刷新采用服务端新版本后重新确认
  await page.getByRole('button', { name: '刷新详情' }).click();
  await expect(page.getByText('v4')).toBeVisible();

  await page.getByLabel('处理结果').click();
  await page.locator('.ant-select-dropdown .ant-select-item-option[title="故障修复"]').click();
  await page.getByRole('button', { name: /^结\s*单$/ }).click();
  await page.getByRole('button', { name: '确认结单' }).click();

  await expect(page.getByText('工单已结单，内部维修过程与回复已转为只读。')).toBeVisible();
  expect(counters.close).toBe(2);
  // 第二次确认提交的是刷新后看到的版本 4，而不是旧捕获值或自动重试
  expect(submittedVersions).toEqual([0, 4]);
});

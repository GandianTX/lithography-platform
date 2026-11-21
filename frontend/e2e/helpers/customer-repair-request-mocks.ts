// e2e/helpers/customer-repair-request-mocks.ts
//
// 客户四页（首页除外）状态验收（customer-repair-request-states.spec.ts）专用的
// 仓库内确定性 GraphQL mock：不依赖真实后端、开发库、backend/env/.env.development，
// fresh clone 直接可跑。
//
// - 按 operationName 精确应答（与 helpers/admin-document-kb-mocks.ts 同口径），
//   字段与 features/repair-request 各 adapter 的 GraphQL 契约逐一对齐；
// - 每个用例只挑选自己需要的状态（models / list / detail / create），未登记状态回落
//   到该 operation 的就绪态；
// - **失败关闭**：未登记的 operationName 一律抛出并把名称记入
//   `readUnregisteredOperations`，由 spec 的 afterEach 断言为空 —— 不得用成功空 data 兜底，
//   否则新增请求、拼错 operationName 或漏登记状态会被静默吞掉（假绿）；
// - 失败态有两种：`abort`（网络中失败 → GraphQLIngressError → 共享错误模型文案）
//   与 GraphQL errors 响应（业务拒绝与 NOT_FOUND 防探测口径）；
// - `pending` 表示永不应答（挂起），用于验证加载态与提交中态；换 mock（unroute）前
//   必须调用 `abortSuspendedCustomerRepairRequestMocks` 显式中止：unroute 会把仍
//   挂起的请求释放到真实网络，dev server 代理可达后端时会收到 UNAUTHENTICATED，
//   触发全局清会话与跳登录，污染后续断言（2026-09-30 zoom 200% 用例实锤）。

import type { Page, Route } from '@playwright/test';

export const CUSTOMER_MOCK_ROUTES = '**/graphql';

/** 按 page 记录未登记的 operationName（spec 在 afterEach 断言为空）。 */
const unregisteredOperationsByPage = new WeakMap<Page, string[]>();

/** 按 page 记录仍处于挂起（未收敛）状态的拦截路由：换 mock 前必须显式中止。 */
const suspendedRoutesByPage = new WeakMap<Page, Set<Route>>();

/** 读取该 page 出现过的未登记 operationName（测试用）。 */
export function readUnregisteredOperations(page: Page): string[] {
  return unregisteredOperationsByPage.get(page) ?? [];
}

/**
 * 中止该 page 上所有仍挂起的 mock 请求（换 mock / `page.unroute` 之前调用）。
 * 不中止时：unroute 会把未收敛的挂起请求释放到真实网络；dev server 代理可达真实
 * 后端时，测试会话占位 token 会收到 UNAUTHENTICATED，触发全局清会话跳登录，
 * 使后续断言落在登录页（2026-09-30 zoom 200% 用例实锤）。
 */
export async function abortSuspendedCustomerRepairRequestMocks(page: Page): Promise<void> {
  const suspended = suspendedRoutesByPage.get(page);

  if (!suspended || suspended.size === 0) {
    return;
  }

  suspendedRoutesByPage.delete(page);

  await Promise.all(
    [...suspended].map(async (route) => {
      try {
        await route.abort();
      } catch {
        // 路由可能已因页面关闭等被收敛；忽略即可，不阻断换 mock 流程。
      }
    }),
  );
}

/** 申请编号 / 错误码的长连续文本（长文本不换行时必然撑破表格与页面）。 */
export const LONG_REQUEST_NO = `RR2026${'9'.repeat(52)}`;
export const LONG_ERROR_CODE = `E-${'8'.repeat(78)}`;

const MODELS = [
  { id: 47, modelCode: 'LITHO-200', modelName: '光刻机 200 型' },
  { id: 48, modelCode: 'LITHO-300', modelName: '光刻机 300 型' },
];

/** 任务 03：报修厂家候选（ACTIVE + 具备维修服务资格），与后端 `repairServiceOrganizationSearch` 契约对齐 */
const SERVICE_ORGS = [{ id: 900777, name: 'E2E 维修服务公司', shortName: 'E2E 维修' }];

type ListItem = {
  id: number;
  requestNo: string;
  errorCode: string;
  createdAt: string;
  isAccepted: boolean;
  acceptedAt: string | null;
  latestResolutionStatus: string | null;
  equipmentModel: { id: number; modelCode: string; modelName: string };
};

const LIST_ITEMS: ListItem[] = [
  {
    id: 920001,
    requestNo: 'MOCK-RR-2026-0001',
    errorCode: 'E-STAGE-201',
    createdAt: '2026-09-01T09:00:00.000Z',
    isAccepted: false,
    acceptedAt: null,
    latestResolutionStatus: null,
    equipmentModel: { id: 47, modelCode: 'LITHO-200', modelName: '光刻机 200 型' },
  },
  {
    id: 920002,
    requestNo: 'MOCK-RR-2026-0002',
    errorCode: 'E-LENS-102',
    createdAt: '2026-09-02T14:30:00.000Z',
    isAccepted: true,
    acceptedAt: '2026-09-02T15:00:00.000Z',
    latestResolutionStatus: 'RESOLVED',
    equipmentModel: { id: 48, modelCode: 'LITHO-300', modelName: '光刻机 300 型' },
  },
];

const LONG_TEXT_ITEMS: ListItem[] = [
  { ...LIST_ITEMS[0], errorCode: LONG_ERROR_CODE, requestNo: LONG_REQUEST_NO },
];

/**
 * 多条数据夹具（PR5 S6-2）：12 条合法 item，超过列表页 PAGE_SIZE = 10，
 * 使分页器真实出现（total 12 → 2 页）；字段形状与 LIST_ITEMS 逐一对齐，只递增 id / 申请编号。
 * 接单状态按 index 交替：保证第一页既有未接单行（操作列渲染删除按钮）也有已接单行。
 */
const MANY_ITEMS: ListItem[] = Array.from({ length: 12 }, (_unused, index) => {
  const isAccepted = index % 4 === 3;

  return {
    id: 920101 + index,
    requestNo: `MOCK-RR-2026-${String(index + 1001).padStart(4, '0')}`,
    errorCode: `E-STAGE-${201 + index}`,
    createdAt: `2026-09-${String(1 + index).padStart(2, '0')}T09:00:00.000Z`,
    isAccepted,
    acceptedAt: isAccepted ? `2026-09-${String(1 + index).padStart(2, '0')}T10:00:00.000Z` : null,
    latestResolutionStatus: isAccepted ? 'RESOLVED' : null,
    equipmentModel:
      index % 2 === 0
        ? { id: 47, modelCode: 'LITHO-200', modelName: '光刻机 200 型' }
        : { id: 48, modelCode: 'LITHO-300', modelName: '光刻机 300 型' },
  };
});

/**
 * 详情：两条回复（工程师昵称 / 处理状态 / 回复时间 / 正文均来自后端字段）。
 * 顺序与真实契约一致：后端按 `createdAt ASC + id ASC` 返回，故 15:10 在前、18:40 在后。
 */
const DETAIL_WITH_RESPONSES = {
  id: 920002,
  requestNo: 'MOCK-RR-2026-0002',
  errorCode: 'E-LENS-102',
  faultDescription: '曝光镜头组温漂超限，连续三片晶圆套刻误差超标。',
  contentMd: '## 故障现象\n\n套刻误差连续超标，设备停机等待处理。',
  createdAt: '2026-09-02T14:30:00.000Z',
  isAccepted: true,
  acceptedAt: '2026-09-02T15:00:00.000Z',
  latestResolutionStatus: 'RESOLVED',
  equipmentModel: { id: 48, modelCode: 'LITHO-300', modelName: '光刻机 300 型' },
  responses: [
    {
      id: 960001,
      engineerNickname: '王工',
      resolutionStatus: 'PENDING',
      responseText: '已接单，正在排查温控回路。',
      createdAt: '2026-09-02T15:10:00.000Z',
    },
    {
      id: 960002,
      engineerNickname: '李工',
      resolutionStatus: 'RESOLVED',
      responseText: '已更换温控组件并完成标定，套刻误差回到规格内。',
      createdAt: '2026-09-02T18:40:00.000Z',
    },
  ],
};

/** 详情：0 条回复（未接单）。任务书口径要求整个回复模块不渲染。 */
const DETAIL_NO_RESPONSES = {
  ...DETAIL_WITH_RESPONSES,
  id: 920001,
  requestNo: 'MOCK-RR-2026-0001',
  errorCode: 'E-STAGE-201',
  createdAt: '2026-09-01T09:00:00.000Z',
  isAccepted: false,
  acceptedAt: null,
  latestResolutionStatus: null,
  equipmentModel: { id: 47, modelCode: 'LITHO-200', modelName: '光刻机 200 型' },
  responses: [],
};

/** 详情：长连续文本（故障描述 / 正文 / 回复正文均为无空格长串）。 */
const DETAIL_LONG_TEXT = {
  ...DETAIL_NO_RESPONSES,
  faultDescription: 'A'.repeat(600),
  contentMd: 'B'.repeat(1200),
  responses: [
    {
      id: 960003,
      engineerNickname: '赵工',
      resolutionStatus: 'PENDING',
      responseText: 'C'.repeat(900),
      createdAt: '2026-09-03T02:00:00.000Z',
    },
  ],
};

/**
 * 合成列表条目（MANY_ITEMS）的详情：字段形状与真实契约对齐，0 回复（未接单行）。
 * 默认详情按请求变量 id 分发时，长列表夹具的每一条都能拿到「自己的」详情，
 * 避免 active 高亮与右栏内容错位。
 */
function detailFromListItem(item: ListItem) {
  return {
    id: item.id,
    requestNo: item.requestNo,
    errorCode: item.errorCode,
    faultDescription: `压测列表夹具条目 ${item.requestNo} 的故障描述。`,
    contentMd: '## 故障现象\n\n压测列表夹具正文。',
    createdAt: item.createdAt,
    isAccepted: item.isAccepted,
    acceptedAt: item.acceptedAt,
    latestResolutionStatus: item.latestResolutionStatus,
    equipmentModel: { ...item.equipmentModel },
    responses: [],
  };
}

const CREATED_RECORD = {
  id: 920009,
  requestNo: 'RR20260903090000XYZ789',
  equipmentModelId: 47,
  errorCode: 'E-2001',
  faultDescription: 'E2E 状态验收：提交成功分流',
  createdAt: '2026-09-03T01:00:00.000Z',
  isAccepted: false,
};

type GraphQLRequestBody = {
  operationName?: string;
  variables?: { id?: number; pagination?: { page?: number; pageSize?: number } };
};

/** 各 operation 的可控状态；未指定则使用就绪态。 */
export type CustomerRepairRequestMockOptions = {
  models?: 'ready' | 'empty' | 'failed' | 'pending';
  /** 任务 03：厂家候选三态（创建页新增查询），默认就绪 */
  serviceOrgs?: 'ready' | 'empty' | 'failed' | 'pending';
  list?: 'ready' | 'empty' | 'failed' | 'pending' | 'long-text' | 'many';
  detail?: 'with-responses' | 'no-responses' | 'not-found' | 'failed' | 'pending' | 'long-text';
  create?: 'success' | 'pending' | 'rejected';
};

function paginated(
  items: readonly unknown[],
  total: number,
  variables: GraphQLRequestBody['variables'],
) {
  return {
    items: [...items],
    page: variables?.pagination?.page ?? 1,
    pageSize: variables?.pagination?.pageSize ?? 10,
    total,
  };
}

/**
 * 业务拒绝：GraphQL 顶层 `errors` 信封（**不**包 `data`）。
 * 与成功应答的 `{ data }` 形状互斥，Apollo 据此走 CombinedGraphQLErrors 分支。
 */
function businessError(code: string, errorCode: string, errorMessage: string) {
  return { errors: [{ extensions: { code, errorCode, errorMessage }, message: errorMessage }] };
}

/** 成功应答：GraphQL 顶层 `data` 信封。缺了它 Apollo 拿不到 data，页面只会落到失败态。 */
function ok(data: Record<string, unknown>) {
  return { data };
}

/**
 * operationName + 选项 → 完整 GraphQL 响应体
 * （`null` 表示挂起，`{ abort: true }` 表示中断连接，`{ unregistered: true }` 表示未登记 → 失败关闭）。
 */
function resolveResponse(
  operationName: string | undefined,
  variables: GraphQLRequestBody['variables'],
  options: CustomerRepairRequestMockOptions,
): Record<string, unknown> | { abort: true } | { unregistered: true } | null {
  switch (operationName) {
    case 'EquipmentModels': {
      const state = options.models ?? 'ready';
      if (state === 'failed') return { abort: true };
      if (state === 'pending') return null;
      return ok({
        equipmentModels: state === 'empty' ? [] : MODELS.map((model) => ({ ...model })),
      });
    }
    case 'RepairServiceOrganizationSearch': {
      const state = options.serviceOrgs ?? 'ready';
      if (state === 'failed') return { abort: true };
      if (state === 'pending') return null;
      if (state === 'empty') {
        return ok({
          repairServiceOrganizationSearch: {
            items: [],
            page: variables?.pagination?.page ?? 1,
            pageSize: variables?.pagination?.pageSize ?? 10,
            total: 0,
          },
        });
      }
      return ok({
        repairServiceOrganizationSearch: {
          items: SERVICE_ORGS.map((org) => ({ ...org })),
          page: variables?.pagination?.page ?? 1,
          pageSize: variables?.pagination?.pageSize ?? 10,
          total: SERVICE_ORGS.length,
        },
      });
    }
    case 'MyRepairRequests': {
      const state = options.list ?? 'ready';
      if (state === 'failed') return { abort: true };
      if (state === 'pending') return null;
      if (state === 'empty') return ok({ myRepairRequests: paginated([], 0, variables) });
      if (state === 'long-text') {
        return ok({ myRepairRequests: paginated(LONG_TEXT_ITEMS, 1, variables) });
      }
      if (state === 'many') {
        // 分页回显请求变量并按页切片：翻到第 2 页时真实返回剩余条目，
        // 使「上一页 / 下一页」按钮的可达性断言不是空转（页 2 仍满足 failed-closed 契约）
        const page = variables?.pagination?.page ?? 1;
        const pageSize = variables?.pagination?.pageSize ?? 10;

        return ok({
          myRepairRequests: paginated(
            MANY_ITEMS.slice((page - 1) * pageSize, page * pageSize),
            MANY_ITEMS.length,
            variables,
          ),
        });
      }
      return ok({ myRepairRequests: paginated(LIST_ITEMS, LIST_ITEMS.length, variables) });
    }
    case 'MyRepairRequest': {
      const state = options.detail ?? null;
      if (state === 'failed') return { abort: true };
      if (state === 'pending') return null;
      if (state === 'not-found') {
        return businessError('NOT_FOUND', 'REPAIR_REQUEST_NOT_FOUND', '维修申请不存在或不可查看。');
      }
      if (state === 'no-responses') return ok({ myRepairRequest: { ...DETAIL_NO_RESPONSES } });
      if (state === 'long-text') return ok({ myRepairRequest: { ...DETAIL_LONG_TEXT } });
      if (state === 'with-responses') return ok({ myRepairRequest: { ...DETAIL_WITH_RESPONSES } });

      // 默认（未显式指定 detail）：按请求变量 id 返回「自己的」详情，对齐组件
      // 「列表态右栏默认目标 = 当前页第一项」的真实行为（恒返回 920002 会让 active
      // 高亮与右栏内容错位，2026-09-30 实锤）。920002/920001 用专用夹具，
      // MANY_ITEMS 合成条目由列表行生成（0 回复）；未知 id 保底沿用 with-responses。
      const requestedId = variables?.id;
      if (requestedId === DETAIL_WITH_RESPONSES.id) {
        return ok({ myRepairRequest: { ...DETAIL_WITH_RESPONSES } });
      }
      if (requestedId === DETAIL_NO_RESPONSES.id) {
        return ok({ myRepairRequest: { ...DETAIL_NO_RESPONSES } });
      }
      const synthesized = MANY_ITEMS.find((item) => item.id === requestedId);
      if (synthesized) return ok({ myRepairRequest: detailFromListItem(synthesized) });

      return ok({ myRepairRequest: { ...DETAIL_WITH_RESPONSES } });
    }
    case 'CreateRepairRequest': {
      const state = options.create ?? 'success';
      if (state === 'pending') return null;
      if (state === 'rejected') {
        return businessError(
          'BAD_USER_INPUT',
          'REPAIR_REQUEST_EQUIPMENT_MODEL_DISABLED',
          '所选设备型号已停用，请重新选择。',
        );
      }
      return ok({ createRepairRequest: { ...CREATED_RECORD } });
    }
    case 'DeleteMyRepairRequest':
      return ok({ deleteMyRepairRequest: { id: 920001, requestNo: 'MOCK-RR-2026-0001' } });
    default:
      // 失败关闭：未登记（含拼错 / 遗漏）的 operation 不得回成功空 data 兜底
      return { unregistered: true };
  }
}

/**
 * 为当前 page 安装客户状态验收的确定性 GraphQL mock。
 * 必须在首次页面导航前调用；同一 page 只安装一次（重复注册会叠加路由）。
 */
export async function installCustomerRepairRequestMocks(
  page: Page,
  options: CustomerRepairRequestMockOptions = {},
): Promise<void> {
  await page.route(CUSTOMER_MOCK_ROUTES, async (route) => {
    const requestBody = route.request().postDataJSON() as GraphQLRequestBody | null;
    const response = resolveResponse(requestBody?.operationName, requestBody?.variables, options);

    if (response === null) {
      // 挂起：不 fulfill 也不 abort，用真实「未返回」验证加载态与提交中态。
      // 同时登记未收敛路由：unroute 时 Playwright 会把这些请求释放到真实网络，
      // 换 mock 前必须用 abortSuspendedCustomerRepairRequestMocks 显式中止。
      const suspended = suspendedRoutesByPage.get(page) ?? new Set<Route>();
      suspended.add(route);
      suspendedRoutesByPage.set(page, suspended);
      return;
    }

    if ('unregistered' in response) {
      const operationName = requestBody?.operationName ?? '(缺少 operationName)';
      unregisteredOperationsByPage.set(page, [...readUnregisteredOperations(page), operationName]);
      // 立即抛错让用例失败，同时留痕给 spec 的 afterEach 兜底断言
      throw new Error(
        `[customer-repair-request-mocks] 未登记的 GraphQL operation：${operationName}`,
      );
    }

    if ('abort' in response) {
      await route.abort();
      return;
    }

    await route.fulfill({
      body: JSON.stringify(response),
      contentType: 'application/json',
      status: 200,
    });
  });
}

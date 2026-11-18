// src/widgets/customer-repair-workspace/index.spec.tsx
// @vitest-environment jsdom

/**
 * 客户维修工作台组合边界单测（PR5 整合工作台）。
 *
 * 走真实工作台组件与真实列表面板/详情面板 UI，只 mock feature 流程 hook
 * （列表/详情 view state 与命令端口）、创建表单与路由跳转、会话视图。
 * 本 spec 只覆盖 widget 的组合职责：固定页头、模式装配、选中项真值、删除编排与
 * 导航意图；列表 / 详情 / 创建状态机的时序行为由各自 application spec 与面板 spec 覆盖。
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CustomerRepairRequestListView,
  RepairRequestDetail,
  RepairRequestListItem,
  RepairRequestListPage,
  RepairRequestRecord,
} from '@/features/repair-request';

import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import { CustomerRepairWorkspace } from './index';

const { authViewMock, detailFlowCalls, detailHook, listHook, navigateMock } = vi.hoisted(() => ({
  authViewMock: vi.fn(),
  detailFlowCalls: [] as number[],
  detailHook: {
    current: {
      state: { status: 'loading' } as unknown,
      deleting: false,
      deleteRequest: vi.fn(),
    },
  },
  listHook: {
    current: {
      state: { status: 'loading' } as unknown,
      deletingId: null as null | number,
      deleteRequest: vi.fn(),
      goToPage: vi.fn(),
      retry: vi.fn(),
    },
  },
  navigateMock: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

// 会话视图用桩（widget 只读角色用于 SUPER_ADMIN 边界）；放行判断函数保留真实实现。
vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return { ...actual, useAuthSession: () => authViewMock() };
});

// 只替换流程 hook 与创建表单：面板、状态标签等纯展示实现保留真实代码；
// 表单协作端口用最小按钮触发，验证 widget 的联动接线（表单内部行为由 form spec 覆盖）。
vi.mock('@/features/repair-request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/repair-request')>();

  const createdRecord: RepairRequestRecord = {
    id: 930001,
    requestNo: 'MOCK-RR-NEW-930001',
    equipmentModelId: 11,
    errorCode: 'E-NEW',
    faultDescription: '新申请',
    createdAt: '2026-09-29T08:00:00.000Z',
    isAccepted: false,
  };

  return {
    ...actual,
    RepairRequestForm: (props: {
      onCreated?: (record: RepairRequestRecord) => void;
      onViewCreated?: (record: RepairRequestRecord) => void;
    }) => (
      <div data-testid="mock-repair-request-form">
        <button onClick={() => props.onCreated?.(createdRecord)} type="button">
          触发创建成功
        </button>
        <button onClick={() => props.onViewCreated?.(createdRecord)} type="button">
          触发查看新申请
        </button>
      </div>
    ),
    useCustomerRepairRequestDetailFlow: (requestId: number) => {
      detailFlowCalls.push(requestId);

      return detailHook.current;
    },
    useCustomerRepairRequestList: () => listHook.current,
  };
});

const listDeleteMock = listHook.current.deleteRequest;
const listRetryMock = listHook.current.retry;
const detailDeleteMock = detailHook.current.deleteRequest;

function makeItem(
  id: number,
  overrides: Partial<RepairRequestListItem> = {},
): RepairRequestListItem {
  return {
    id,
    requestNo: `MOCK-RR-2026-${String(id).slice(-4)}`,
    errorCode: 'E-STAGE-201',
    createdAt: '2026-01-10T00:30:00.000Z',
    isAccepted: false,
    acceptedAt: null,
    latestResolutionStatus: null,
    equipmentModel: { id: 48, modelCode: 'M1', modelName: '型号一' },
    ...overrides,
  };
}

function makePage(overrides?: Partial<RepairRequestListPage>): RepairRequestListPage {
  return {
    items: [
      makeItem(920001),
      makeItem(920002, {
        requestNo: 'MOCK-RR-2026-0002',
        errorCode: 'E-LENS-102',
        isAccepted: true,
        acceptedAt: '2026-01-11T00:50:00.000Z',
        latestResolutionStatus: 'RESOLVED',
      }),
    ],
    total: 2,
    page: 1,
    pageSize: 10,
    ...overrides,
  };
}

function makeDetail(overrides?: Partial<RepairRequestDetail>): RepairRequestDetail {
  return {
    id: 920001,
    requestNo: 'MOCK-RR-2026-0001',
    errorCode: 'E-STAGE-201',
    faultDescription: '设备异常',
    contentMd: '## 故障现象\n报错。',
    createdAt: '2026-01-10T00:30:00.000Z',
    isAccepted: false,
    acceptedAt: null,
    latestResolutionStatus: null,
    equipmentModel: { id: 48, modelCode: 'M1', modelName: '型号一' },
    responses: [],
    ...overrides,
  };
}

/** 列表与详情均就绪（右栏默认详情需与列表第一项一致） */
function setupReadyList(): void {
  listHook.current.state = { status: 'ready', data: makePage() };
  detailHook.current.state = { status: 'ready', detail: makeDetail() };
}

/**
 * 当前可见 Popconfirm 内的确认按钮（弹层挂在 document.body，跨用例残留需过滤隐藏节点）。
 */
const visibleConfirmButtons = () =>
  Array.from(document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)')).flatMap(
    (popover) => Array.from(popover.querySelectorAll('.ant-popconfirm-buttons .ant-btn-primary')),
  );

async function confirmVisibleDelete(): Promise<void> {
  await waitFor(() => expect(visibleConfirmButtons()).toHaveLength(1));
  fireEvent.click(visibleConfirmButtons()[0]);
}

/** 可控结算的删除请求句柄：用于在途期间切换路由 / 卸载后再决定成功或失败晚到 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

/**
 * 申请编号同时出现在左栏条目（button）与右栏详情标题（非按钮），
 * 据此定位左栏条目按钮。
 */
function listButtonOf(requestNo: string): HTMLElement {
  const button = screen
    .getAllByText(requestNo)
    .map((el) => el.closest('button'))
    .find((el): el is HTMLButtonElement => el !== null);

  expect(button).toBeTruthy();

  return button as unknown as HTMLElement;
}

/** 选中态由条目容器（.activity-item）的 aria-current 表达，不在主选择按钮上 */
function listItemOf(requestNo: string): HTMLElement {
  const item = listButtonOf(requestNo).closest('.activity-item');

  expect(item).not.toBeNull();

  return item as HTMLElement;
}

function renderWorkspace(props: {
  mode: 'create' | 'history-list' | 'history-detail';
  requestId?: number | null;
}) {
  return render(
    <MessageFeedbackProvider>
      <CustomerRepairWorkspace {...props} />
    </MessageFeedbackProvider>,
  );
}

beforeEach(() => {
  authViewMock.mockReturnValue({
    session: {
      accountId: 900101,
      customerOrganizationId: 7001,
      role: 'CUSTOMER',
      userInfo: null,
    },
    status: 'authenticated',
  });
  detailFlowCalls.length = 0;
  listHook.current.state = { status: 'loading' } satisfies CustomerRepairRequestListView;
  listHook.current.deletingId = null;
  listDeleteMock.mockReset();
  listDeleteMock.mockResolvedValue(true);
  listHook.current.goToPage.mockReset();
  listRetryMock.mockReset();
  detailHook.current.state = { status: 'loading' };
  detailHook.current.deleting = false;
  detailDeleteMock.mockReset();
  detailDeleteMock.mockResolvedValue(true);
  navigateMock.mockReset();
});

describe('CustomerRepairWorkspace 的固定页头与模式装配', () => {
  it.each([
    ['create' as const, undefined],
    ['history-list' as const, undefined],
    ['history-detail' as const, 920001],
  ])('模式 %s 只渲染一个「客户页面」标题与固定主按钮', (mode, requestId) => {
    setupReadyList();
    renderWorkspace({ mode, requestId });

    expect(screen.getAllByRole('heading', { name: '客户页面' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '发起维修申请' })).toBeTruthy();
  });

  it('create 态挂载创建表单协作端口，且不发起任何详情查询', () => {
    setupReadyList();
    renderWorkspace({ mode: 'create' });

    expect(screen.getByTestId('mock-repair-request-form')).toBeTruthy();
    expect(detailFlowCalls).toHaveLength(0);
  });

  it('create 态点击页头主按钮是 no-op（不导航、不重挂载、不清空输入）', () => {
    setupReadyList();
    renderWorkspace({ mode: 'create' });

    fireEvent.click(screen.getByRole('button', { name: '发起维修申请' }));

    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-repair-request-form')).toBeTruthy();
  });

  it('create 态点击左栏「我的维修申请」进入历史列表路由', () => {
    setupReadyList();
    renderWorkspace({ mode: 'create' });

    fireEvent.click(screen.getByRole('button', { name: '我的维修申请' }));

    expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests');
  });

  it('history 态点击页头「发起维修申请」回到创建路由', () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-list' });

    fireEvent.click(screen.getByRole('button', { name: '发起维修申请' }));

    expect(navigateMock).toHaveBeenCalledWith('/customer');
  });
});

describe('CustomerRepairWorkspace 的选中项真值', () => {
  it('列表态就绪后以当前页第一项为右栏默认详情，并显示 active 高亮', () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-list' });

    expect(detailFlowCalls).toEqual([920001]);
    expect(listItemOf('MOCK-RR-2026-0001')).toHaveAttribute('aria-current', 'true');
    expect(listItemOf('MOCK-RR-2026-0002')).not.toHaveAttribute('aria-current');
  });

  it('列表态点击条目导航到该申请的详情 URL', () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-list' });

    fireEvent.click(listButtonOf('MOCK-RR-2026-0002'));

    expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests/920002');
  });

  it('详情深链目标在当前分页时高亮该项，详情 hook 收到 URL 目标', () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-detail', requestId: 920002 });

    expect(detailFlowCalls).toEqual([920002]);
    expect(listItemOf('MOCK-RR-2026-0002')).toHaveAttribute('aria-current', 'true');
    expect(listItemOf('MOCK-RR-2026-0001')).not.toHaveAttribute('aria-current');
  });

  it('详情深链目标不在当前分页时不误选任何条目，右栏仍按 URL 加载', () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-detail', requestId: 999999 });

    expect(detailFlowCalls).toEqual([999999]);
    expect(document.querySelectorAll('.activity-item[aria-current="true"]')).toHaveLength(0);
  });

  it('列表空库时右栏保留发起申请的主操作', () => {
    listHook.current.state = { status: 'ready', data: makePage({ items: [], total: 0 }) };
    renderWorkspace({ mode: 'history-list' });

    expect(screen.getAllByText('还没有维修申请。').length).toBeGreaterThanOrEqual(1);
    expect(detailFlowCalls).toHaveLength(0);

    const createButtons = screen.getAllByRole('button', { name: '发起维修申请' });
    // 页头主按钮 + 右栏空态主操作（左栏空态同款按钮），全部指向创建路由
    expect(createButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(createButtons[createButtons.length - 1]);
    expect(navigateMock).toHaveBeenCalledWith('/customer');
  });
});

describe('CustomerRepairWorkspace 的删除编排', () => {
  it('列表态确认删除当前详情报 list hook 的删除命令（不走详情 flow、不导航）', async () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-list' });

    // 精确名称命中右栏详情面板删除按钮；左栏条目删除按钮带编号后缀不误中
    fireEvent.click(screen.getByRole('button', { name: '删除申请' }));
    await confirmVisibleDelete();

    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920001));
    expect(detailDeleteMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('详情态确认删除走详情 flow；成功后导航回列表路由', async () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-detail', requestId: 920001 });

    // 精确名称命中右栏详情面板删除按钮；左栏条目删除按钮带编号后缀不误中
    fireEvent.click(screen.getByRole('button', { name: '删除申请' }));
    await confirmVisibleDelete();

    await waitFor(() => expect(detailDeleteMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests'));
    expect(listDeleteMock).not.toHaveBeenCalled();
  });

  it('详情态从左栏删除当前 URL 目标：成功后同样进入列表路由', async () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-detail', requestId: 920001 });

    fireEvent.click(screen.getByRole('button', { name: '删除申请 MOCK-RR-2026-0001' }));
    await confirmVisibleDelete();

    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920001));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests'));
  });

  it('列表态从左栏删除非当前项：只调 list 删除命令，不导航', async () => {
    listHook.current.state = {
      status: 'ready',
      data: makePage({ items: [makeItem(920001), makeItem(920003)], total: 2 }),
    };
    detailHook.current.state = { status: 'ready', detail: makeDetail() };
    renderWorkspace({ mode: 'history-list' });

    fireEvent.click(screen.getByRole('button', { name: '删除申请 MOCK-RR-2026-0003' }));
    await confirmVisibleDelete();

    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920003));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  // 2026-09-30 复审：左栏删除的导航守卫（与右栏详情删除的目标代次守卫等价）。
  // 删除在途时切页 / 切目标 / 卸载，旧请求的成功晚到只完成数据删除，不得把用户强制带回列表。
  it('从左栏删除 A 后切到创建页：A 的成功晚到不导航', async () => {
    setupReadyList();
    const pendingDelete = deferred<boolean>();
    listDeleteMock.mockReturnValueOnce(pendingDelete.promise);

    const view = renderWorkspace({ mode: 'history-detail', requestId: 920001 });
    fireEvent.click(screen.getByRole('button', { name: '删除申请 MOCK-RR-2026-0001' }));
    await confirmVisibleDelete();
    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920001));

    view.rerender(
      <MessageFeedbackProvider>
        <CustomerRepairWorkspace mode="create" />
      </MessageFeedbackProvider>,
    );

    await act(async () => {
      pendingDelete.resolve(true);
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('从左栏删除 A 后切到详情 B：A 的成功晚到不导航', async () => {
    setupReadyList();
    const pendingDelete = deferred<boolean>();
    listDeleteMock.mockReturnValueOnce(pendingDelete.promise);

    const view = renderWorkspace({ mode: 'history-detail', requestId: 920001 });
    fireEvent.click(screen.getByRole('button', { name: '删除申请 MOCK-RR-2026-0001' }));
    await confirmVisibleDelete();
    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920001));

    view.rerender(
      <MessageFeedbackProvider>
        <CustomerRepairWorkspace mode="history-detail" requestId={920002} />
      </MessageFeedbackProvider>,
    );

    await act(async () => {
      pendingDelete.resolve(true);
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('从左栏删除 A 后离开工作台（卸载）：成功晚到不导航，也不产生卸载后更新告警', async () => {
    setupReadyList();
    const pendingDelete = deferred<boolean>();
    listDeleteMock.mockReturnValueOnce(pendingDelete.promise);
    const consoleErrorSpy = vi.spyOn(console, 'error');

    const view = renderWorkspace({ mode: 'history-detail', requestId: 920001 });
    fireEvent.click(screen.getByRole('button', { name: '删除申请 MOCK-RR-2026-0001' }));
    await confirmVisibleDelete();
    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920001));

    view.unmount();

    await act(async () => {
      pendingDelete.resolve(true);
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(
      consoleErrorSpy.mock.calls.some((args) => String(args[0]).includes('unmounted')),
      '不得出现「卸载后更新」告警',
    ).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  it('从左栏删除 A、离开后重新进入申请 A（相同 ID 的新页面实例）：旧请求不导航', async () => {
    setupReadyList();
    const pendingDelete = deferred<boolean>();
    listDeleteMock.mockReturnValueOnce(pendingDelete.promise);

    const view = renderWorkspace({ mode: 'history-detail', requestId: 920001 });
    fireEvent.click(screen.getByRole('button', { name: '删除申请 MOCK-RR-2026-0001' }));
    await confirmVisibleDelete();
    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920001));

    view.rerender(
      <MessageFeedbackProvider>
        <CustomerRepairWorkspace mode="create" />
      </MessageFeedbackProvider>,
    );
    view.rerender(
      <MessageFeedbackProvider>
        <CustomerRepairWorkspace mode="history-detail" requestId={920001} />
      </MessageFeedbackProvider>,
    );

    await act(async () => {
      pendingDelete.resolve(true);
    });

    // 只比较申请 ID 会误判同一 ID 的新页面实例；必须按路由实例代次守卫
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('从左栏删除 A 且一直停留在 A：deferred 成功后正常回列表', async () => {
    setupReadyList();
    const pendingDelete = deferred<boolean>();
    listDeleteMock.mockReturnValueOnce(pendingDelete.promise);

    renderWorkspace({ mode: 'history-detail', requestId: 920001 });
    fireEvent.click(screen.getByRole('button', { name: '删除申请 MOCK-RR-2026-0001' }));
    await confirmVisibleDelete();
    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920001));
    expect(navigateMock).not.toHaveBeenCalled();

    await act(async () => {
      pendingDelete.resolve(true);
    });

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests'));
  });

  it('从左栏删除失败（删除命令返回 false）：不导航（错误反馈仍由列表 hook 承担）', async () => {
    setupReadyList();
    const pendingDelete = deferred<boolean>();
    listDeleteMock.mockReturnValueOnce(pendingDelete.promise);

    renderWorkspace({ mode: 'history-detail', requestId: 920001 });
    fireEvent.click(screen.getByRole('button', { name: '删除申请 MOCK-RR-2026-0001' }));
    await confirmVisibleDelete();
    await waitFor(() => expect(listDeleteMock).toHaveBeenCalledWith(920001));

    await act(async () => {
      pendingDelete.resolve(false);
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });
});

// 2026-10-02 复审 P2：history-detail + null（非法 / 缺失 URL 参数经路由边界归一）与
// 「列表暂无默认目标」语义不同——非法详情 URL 直显统一 not-found，不挂载详情 hook、
// 不发详情 Query、不暴露删除入口；列表态空库仍走右栏占位。
describe('CustomerRepairWorkspace 的非法详情 URL（history-detail + null）', () => {
  it('直显统一 not-found 与返回入口：不挂载详情 hook、无删除入口', () => {
    setupReadyList();
    const { container } = renderWorkspace({ mode: 'history-detail', requestId: null });

    expect(screen.getByText('维修申请不存在或不可查看。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回历史列表' })).toBeTruthy();
    // 未挂载 WorkspaceDetailPane：详情 flow 未被创建（无详情 Query / 无删除命令）
    expect(detailFlowCalls).toHaveLength(0);
    const detailPane = container.querySelector('.customer-workspace-detail-pane');
    expect(detailPane).not.toBeNull();
    expect(
      within(detailPane as HTMLElement).queryByRole('button', { name: '删除申请' }),
    ).toBeNull();
  });

  it('点击「返回历史列表」只导航到列表路由', () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-detail', requestId: null });

    fireEvent.click(screen.getByRole('button', { name: '返回历史列表' }));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests');
  });

  it('与「列表暂无默认目标」区分：history-list 空库仍走占位而非 not-found', () => {
    listHook.current.state = { status: 'ready', data: makePage({ items: [], total: 0 }) };
    renderWorkspace({ mode: 'history-list' });

    expect(screen.queryByText('维修申请不存在或不可查看。')).toBeNull();
    expect(screen.getAllByText('还没有维修申请。').length).toBeGreaterThanOrEqual(1);
    expect(detailFlowCalls).toHaveLength(0);
  });
});

describe('CustomerRepairWorkspace 的创建页信息架构', () => {
  it('不再渲染「填写提示」独立右栏（aside），表单协作端口保留', () => {
    setupReadyList();
    const { container } = renderWorkspace({ mode: 'create' });

    expect(screen.queryByText('填写提示')).toBeNull();
    expect(container.querySelector('.customer-workspace-detail-pane aside')).toBeNull();
    expect(screen.getByTestId('mock-repair-request-form')).toBeTruthy();
  });

  // S4 归属门禁：缺公司归属只在表单上方引导补录，不隐藏表单（以服务端判定为准）
  it('客户归属为空时在表单上方展示补录引导，并可跳转账号设置', () => {
    authViewMock.mockReturnValue({
      session: {
        accountId: 900101,
        customerOrganizationId: null,
        role: 'CUSTOMER',
        userInfo: null,
      },
      status: 'authenticated',
    });
    setupReadyList();
    renderWorkspace({ mode: 'create' });

    expect(screen.getByText('请先在账号设置中补充公司信息。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '前往账号设置' }));

    expect(navigateMock).toHaveBeenCalledWith('/account/settings');
    // 表单仍挂载：门禁裁决留给服务端，前端不以会话事实替代授权
    expect(screen.getByTestId('mock-repair-request-form')).toBeTruthy();
  });

  it('客户已有归属时不展示补录引导', () => {
    setupReadyList();
    renderWorkspace({ mode: 'create' });

    expect(screen.queryByText('请先在账号设置中补充公司信息。')).toBeNull();
    expect(screen.queryByRole('button', { name: '前往账号设置' })).toBeNull();
  });
});

describe('CustomerRepairWorkspace 的 SUPER_ADMIN 边界', () => {
  it('按钮置灰并附说明；create 态右栏不渲染可用表单', () => {
    authViewMock.mockReturnValue({
      session: { accountId: 900101, role: 'SUPER_ADMIN', userInfo: null },
      status: 'authenticated',
    });
    setupReadyList();
    renderWorkspace({ mode: 'create' });

    const button = screen.getByRole('button', {
      name: '发起维修申请',
    }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(screen.getByText('超管不能代客户发起维修申请')).toBeTruthy();
    expect(screen.queryByTestId('mock-repair-request-form')).toBeNull();
  });
});

describe('CustomerRepairWorkspace 的创建成功联动', () => {
  it('onCreated 触发左栏列表刷新（retry），不跳转', () => {
    setupReadyList();
    renderWorkspace({ mode: 'create' });

    fireEvent.click(screen.getByRole('button', { name: '触发创建成功' }));

    expect(listRetryMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('onViewCreated 以真实 id 导航到新申请详情路由', () => {
    setupReadyList();
    renderWorkspace({ mode: 'create' });

    fireEvent.click(screen.getByRole('button', { name: '触发查看新申请' }));

    expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests/930001');
  });
});

describe('CustomerRepairWorkspace 的卡头入口', () => {
  it('列表态点击卡头入口是 no-op（已在历史列表路由）', () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-list' });

    fireEvent.click(screen.getByRole('button', { name: '我的维修申请' }));

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('详情态点击卡头入口回到历史列表路由', () => {
    setupReadyList();
    renderWorkspace({ mode: 'history-detail', requestId: 920001 });

    fireEvent.click(screen.getByRole('button', { name: '我的维修申请' }));

    expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests');
  });
});

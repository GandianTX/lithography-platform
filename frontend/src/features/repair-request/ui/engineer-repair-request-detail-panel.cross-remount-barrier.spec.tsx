// src/features/repair-request/ui/engineer-repair-request-detail-panel.cross-remount-barrier.spec.tsx
// @vitest-environment jsdom

/**
 * 结单成功后的本地只读屏障跨工单页面重挂载 / 跨会话隔离回归。
 *
 * 走真实详情 hook、真实 workbench hook 与真实面板，只 mock 外部 adapter，
 * 用可控 Promise 推进 mutation / 回读，不使用固定 sleep：
 * - A 结单成功、回读未结束 → 切 B → 返回 A（真实页面以 key 重挂载）：
 *   A 仍只读且保留“尚未确认 + 重试”，B 按自身状态可写；
 * - 返回 A 且详情 loading 时直接调用各应用层写入口：adapter 均未被调用；
 * - 重挂载后重试采用已结束详情：服务端事实接管只读，未确认提示清除；
 * - 同一工单在不同身份/会话（scopeKey）之间不共享屏障；
 * - mutation 失败不建立“已结单”屏障。
 */

import { useLayoutEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRepairRequestClosureBarriersForTests } from '../application/repair-request-closure-barrier';
import {
  type RepairProcessFormInput,
  useEngineerRepairProcessWorkbench,
} from '../application/use-engineer-repair-process-workbench';
import { useEngineerRepairRequestDetailFlow } from '../application/use-engineer-repair-request-detail-flow';
import type {
  CloseRepairRequestResult,
  CreateEngineerResponseInput,
  CreateEngineerResponseResult,
  EngineerRepairMaintenanceRecord,
  EngineerRepairMaintenanceStep,
  EngineerRepairProcessEntry,
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailResult,
  RepairProcessWriteResult,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { EngineerRepairRequestDetailPanel } from './engineer-repair-request-detail-panel';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    fetchEngineerRepairRequestDetail: vi.fn(),
    acceptRepairRequest: vi.fn(),
    createEngineerResponse: vi.fn(),
    uploadRepairProcessFile: vi.fn(),
    createRepairProcessEntry: vi.fn(),
    updateRepairProcessEntry: vi.fn(),
    closeRepairRequest: vi.fn(),
    downloadRepairProcessFile: vi.fn(),
  };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequestDetail);
const closeMock = vi.mocked(engineerRepairRequestAdapter.closeRepairRequest);
const createProcessMock = vi.mocked(engineerRepairRequestAdapter.createRepairProcessEntry);
const updateProcessMock = vi.mocked(engineerRepairRequestAdapter.updateRepairProcessEntry);
const uploadMock = vi.mocked(engineerRepairRequestAdapter.uploadRepairProcessFile);
const createResponseMock = vi.mocked(engineerRepairRequestAdapter.createEngineerResponse);

const CLOSE_UNCONFIRMED = '工单已结单，但详情尚未确认。';
const RETRY_REFRESH = '重试刷新';
const BARRIER_HINT = '工单已结单，内部维修过程与回复均为只读。';
const EDIT_MAINTENANCE = '编辑维修记录';
const FILL_MAINTENANCE = '填写维修记录';
const MAINTENANCE_STEP_PLACEHOLDER = '记录实际执行的排查动作与观察结果…';

const MAINTENANCE_A: EngineerRepairMaintenanceRecord = {
  maintenanceDate: '2026-11-16',
  engineerName: 'A 原维修工程师',
  resetResult: null,
  supplementaryNote: null,
  versionNo: 1,
  attachment: null,
};

const MAINTENANCE_B: EngineerRepairMaintenanceRecord = {
  ...MAINTENANCE_A,
  engineerName: 'B 维修工程师',
};

const CLOSED_MAINTENANCE_A: EngineerRepairMaintenanceRecord = {
  ...MAINTENANCE_A,
  engineerName: 'A 最新维修工程师',
  versionNo: 2,
};

const STEP_A: EngineerRepairMaintenanceStep = {
  id: 'step-a',
  stepNo: 1,
  errorCode: null,
  partName: null,
  actionText: 'A 的维修步骤',
  resultCode: 'RESOLVED',
};

const STEP_B: EngineerRepairMaintenanceStep = {
  ...STEP_A,
  id: 'step-b',
  actionText: 'B 的维修步骤',
};

function makeDetail(
  overrides: Partial<EngineerRepairRequestDetail> = {},
): EngineerRepairRequestDetail {
  return {
    id: 21,
    requestNo: 'RR-20261116-001',
    errorCode: 'E-0001',
    faultDescription: '光刻机对准模块异常。',
    contentMd: '',
    createdAt: '2026-11-16T01:00:00.000Z',
    isAccepted: true,
    acceptedAt: '2026-11-16T01:30:00.000Z',
    latestResolutionStatus: null,
    equipmentModel: { id: 1, modelCode: 'LITHO-100', modelName: '样例光刻机' },
    customerNickname: '林客户',
    customerCompanyName: '林氏精密制造',
    acceptanceViewStatus: 'MINE',
    acceptedEngineerNickname: '陈工',
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: 'IN_PROGRESS',
    processEntries: [],
    maintenance: MAINTENANCE_A,
    maintenanceSteps: [STEP_A],
    maintenanceFaultPanels: [],
    responses: [],
    // 接单本人且后端允许编辑：可写夹具必须显式覆盖
    canEditMaintenance: true,
    ...overrides,
  };
}

const OPEN_DETAIL_A = makeDetail();
const OPEN_DETAIL_B = makeDetail({
  id: 22,
  requestNo: 'RR-20261116-002',
  maintenance: MAINTENANCE_B,
  maintenanceSteps: [STEP_B],
});
const CLOSED_DETAIL_A = makeDetail({
  closureStatus: 'CLOSED',
  closedAt: '2026-11-16T04:00:00.000Z',
  handlingResult: 'FIXED',
  handlingStatus: 'COMPLETED',
  canEditMaintenance: false,
  maintenance: CLOSED_MAINTENANCE_A,
  maintenanceSteps: [STEP_A],
});

const CLOSE_OK: CloseRepairRequestResult = {
  ok: true,
  closure: {
    requestId: 21,
    closureStatus: 'CLOSED',
    closedAt: '2026-11-16T04:00:00.000Z',
    closureReason: null,
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    handlingEndedAt: '2026-11-16T03:30:00.000Z',
  },
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function renderPanel(requestId: number, scopeKey: string) {
  return render(
    <MemoryRouter>
      <EngineerRepairRequestDetailPanel
        canHandleAsEngineer={true}
        key={`${scopeKey}:${requestId}`}
        requestId={requestId}
        scopeKey={scopeKey}
      />
    </MemoryRouter>,
  );
}

async function selectHandlingResult() {
  const comboboxes = screen.getAllByRole('combobox');
  fireEvent.mouseDown(comboboxes[comboboxes.length - 1]);
  fireEvent.click(await screen.findByText('故障修复'));
}

async function submitClose() {
  fireEvent.click(screen.getByRole('button', { name: /^结\s*单$/ }));
  fireEvent.click(await screen.findByRole('button', { name: '确认结单' }));
}

/** 屏障生效后所有实际写入口都不可用（不只是隐藏某个提交按钮） */
function expectNoWritableEntries() {
  expect(screen.queryByText('追加处理回复')).toBeNull();
  expect(screen.queryByText(FILL_MAINTENANCE)).toBeNull();
  expect(screen.queryByText(EDIT_MAINTENANCE)).toBeNull();
  expect(screen.queryByPlaceholderText(MAINTENANCE_STEP_PLACEHOLDER)).toBeNull();
  expect(screen.queryByRole('button', { name: '保存维修记录' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^结\s*单$/ })).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
}

type ApplicationEntryApi = {
  markClosureSucceeded: () => void;
  closureBarrier: boolean;
  createResponse: (
    input: CreateEngineerResponseInput,
  ) => Promise<CreateEngineerResponseResult | null>;
  uploadFile: (file: File) => Promise<unknown>;
  saveProcess: (
    input: RepairProcessFormInput,
    editingEntry: EngineerRepairProcessEntry | null,
  ) => Promise<RepairProcessWriteResult | null>;
  closeRequest: (handlingResult: 'FIXED', closureReason: string | null) => Promise<unknown>;
};

/**
 * 只装配 application 层入口，不渲染详情内容：
 * 用于在“详情仍在加载”时直接调用各写入口，验证应用层拒绝而不是只靠隐藏按钮。
 */
function ApplicationEntryHarness({
  apiRef,
  requestId,
  scopeKey,
}: {
  apiRef: { current: ApplicationEntryApi | null };
  requestId: number;
  scopeKey: string;
}) {
  const flow = useEngineerRepairRequestDetailFlow(requestId, scopeKey);
  const workbench = useEngineerRepairProcessWorkbench(requestId, flow.reload, {
    writeBlocked: flow.closureBarrier,
    onCloseSucceeded: flow.markClosureSucceeded,
    onCloseReadbackSucceeded: flow.markClosureReadbackSucceeded,
  });

  useLayoutEffect(() => {
    apiRef.current = {
      markClosureSucceeded: flow.markClosureSucceeded,
      closureBarrier: flow.closureBarrier,
      createResponse: flow.createResponse,
      uploadFile: workbench.uploadFile,
      saveProcess: workbench.saveProcess,
      closeRequest: workbench.closeRequest,
    };
  });

  return <div data-testid="detail-status">{flow.state.status}</div>;
}

function expectNoAdapterWrites() {
  expect(uploadMock).not.toHaveBeenCalled();
  expect(createProcessMock).not.toHaveBeenCalled();
  expect(updateProcessMock).not.toHaveBeenCalled();
  expect(closeMock).not.toHaveBeenCalled();
  expect(createResponseMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetRepairRequestClosureBarriersForTests();
  fetchMock.mockReset();
  closeMock.mockReset();
  createProcessMock.mockReset();
  updateProcessMock.mockReset();
  uploadMock.mockReset();
  createResponseMock.mockReset();
});

describe('结单屏障跨页面重挂载', () => {
  // 用例要在 jsdom 中真实挂载 A→B→A 三轮完整面板（含维修记录与详情回读）；
  // 实测单跑约 2.9s，全量并发时常越过默认 5s，属渲染成本而非等待缺陷。
  it('A 结单成功→回读未结束→B→返回 A（重挂载）→再回读未结束：A 保持只读，B 不受影响', async () => {
    const closeReadback = deferred<EngineerRepairRequestDetailResult>();
    const returnLoad = deferred<EngineerRepairRequestDetailResult>();
    let callsA = 0;
    fetchMock.mockImplementation((id) => {
      if (id === 22) {
        return Promise.resolve({ ok: true, detail: OPEN_DETAIL_B });
      }
      callsA += 1;
      if (callsA === 1) {
        return Promise.resolve({ ok: true, detail: OPEN_DETAIL_A });
      }
      if (callsA === 2) {
        return closeReadback.promise;
      }
      if (callsA === 3) {
        return returnLoad.promise;
      }
      return Promise.resolve({ ok: true, detail: CLOSED_DETAIL_A });
    });
    closeMock.mockResolvedValue(CLOSE_OK);

    const view = renderPanel(21, 'session-a');
    expect(await screen.findByText('A 原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();

    await act(async () => {
      closeReadback.resolve({ ok: true, detail: OPEN_DETAIL_A });
    });
    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expectNoWritableEntries();

    // 清空已发生的结单 mutation 计数：后续断言只关注返回 A 之后是否新增写请求
    closeMock.mockClear();
    createProcessMock.mockClear();
    updateProcessMock.mockClear();
    uploadMock.mockClear();
    createResponseMock.mockClear();

    // 切到 B：B 有自己的详情与写入口，不受 A 的屏障影响
    view.rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={true}
          key="session-a:22"
          requestId={22}
          scopeKey="session-a"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('B 维修工程师')).toBeTruthy();
    expect(screen.getByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^结\s*单$/ })).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();

    // 返回 A：真实页面以 key 重挂载，A 的新页面在服务端已结束详情被采用前保持只读
    view.rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={true}
          key="session-a:21"
          requestId={21}
          scopeKey="session-a"
        />
      </MemoryRouter>,
    );

    // 返回 A 的详情仍在加载：不出现任何写入口，且没有任何写请求发出
    expect(screen.queryByText('A 原维修工程师')).toBeNull();
    expectNoWritableEntries();
    expectNoAdapterWrites();

    await act(async () => {
      returnLoad.resolve({ ok: true, detail: OPEN_DETAIL_A });
    });

    // 再回读仍未结束：屏障保持，提示尚未确认并可重试；A 仍只读
    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();
    expect(screen.getByRole('button', { name: RETRY_REFRESH })).toBeTruthy();
    expect(screen.getByText('A 原维修工程师')).toBeTruthy();
    expect(screen.queryByText('已结单')).toBeNull();
    expect(screen.getByText('结单状态')).toBeTruthy();
    expectNoWritableEntries();
    expectNoAdapterWrites();

    // 重挂载后的重试采用已结束详情：服务端事实接管只读，未确认提示清除
    fireEvent.click(screen.getByRole('button', { name: RETRY_REFRESH }));
    expect(await screen.findByText('已结单')).toBeTruthy();
    expect(screen.getByText('A 最新维修工程师')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull());
    expectNoWritableEntries();
    expect(screen.queryByRole('button', { name: RETRY_REFRESH })).toBeNull();
  }, 15_000);

  it('返回 A 且详情 loading 时直接调用各应用层写入口：adapter 均未被调用', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL_A });

    const apiRef: { current: ApplicationEntryApi | null } = { current: null };
    const view = render(
      <ApplicationEntryHarness apiRef={apiRef} requestId={21} scopeKey="session-a" />,
    );
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('ready'));

    act(() => {
      apiRef.current?.markClosureSucceeded();
    });
    expect(apiRef.current?.closureBarrier).toBe(true);

    // 模拟离开再返回：页面重挂载为新的 hook 实例，详情读取尚未完成
    view.unmount();
    const returnLoad = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReset();
    fetchMock.mockReturnValue(returnLoad.promise);

    const returnRef: { current: ApplicationEntryApi | null } = { current: null };
    render(<ApplicationEntryHarness apiRef={returnRef} requestId={21} scopeKey="session-a" />);
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('loading'));
    expect(returnRef.current?.closureBarrier).toBe(true);

    await act(async () => {
      await returnRef.current?.createResponse({
        requestId: 21,
        responseText: '迟到的回复',
        resolutionStatus: 'RESOLVED',
      });
      await returnRef.current?.uploadFile(new File(['x'], 'a.bin'));
      await returnRef.current?.saveProcess(
        { operationText: '迟到的过程', testResult: null, occurredAt: null },
        null,
      );
      await returnRef.current?.closeRequest('FIXED', null);
    });

    expectNoAdapterWrites();
    expect(screen.getByTestId('detail-status').textContent).toBe('loading');
  });

  it('同一工单在不同身份/会话之间不共享结单屏障', async () => {
    const closeReadback = deferred<EngineerRepairRequestDetailResult>();
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ ok: true, detail: OPEN_DETAIL_A });
      }
      if (calls === 2) {
        return closeReadback.promise;
      }
      return Promise.resolve({ ok: true, detail: OPEN_DETAIL_A });
    });
    closeMock.mockResolvedValue(CLOSE_OK);

    // 面板 key 未变时仅 scopeKey 变化：旧详情仍须立即失效并重新读取
    const view = render(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={true}
          key="account-1:21"
          requestId={21}
          scopeKey="900101:3"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('A 原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();

    await act(async () => {
      closeReadback.resolve({ ok: true, detail: OPEN_DETAIL_A });
    });
    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expectNoWritableEntries();

    // 新会话（同账号、不同 epoch）：不得继承旧会话的结单事实
    view.rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={true}
          key="account-1:21"
          requestId={21}
          scopeKey="900101:4"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^结\s*单$/ })).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();

    // 回到旧会话：旧会话的本地事实仍然隔离在旧会话内，重新生效
    view.rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={true}
          key="account-1:21"
          requestId={21}
          scopeKey="900101:3"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();
    expect(screen.getByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expectNoWritableEntries();
  });

  it('重挂载后 mutation 失败：不得错误建立“已结单”屏障', async () => {
    fetchMock.mockResolvedValue({ ok: true, detail: OPEN_DETAIL_A });
    closeMock.mockResolvedValue({
      ok: false,
      reason: 'close-failed',
      message: '结单失败，请稍后重试。',
    });

    const view = renderPanel(21, 'session-a');
    expect(await screen.findByText('A 原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();

    expect(await screen.findByText('结单失败，请稍后重试。')).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();

    // 离开再返回：失败事实不得被重挂载后误认为成功
    view.unmount();
    renderPanel(21, 'session-a');

    expect(await screen.findByText('A 原维修工程师')).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();
    expect(screen.getByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^结\s*单$/ })).toBeTruthy();
  });
});

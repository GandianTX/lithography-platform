// src/features/repair-request/ui/engineer-repair-request-detail-panel.close-barrier.spec.tsx
// @vitest-environment jsdom

/**
 * 结单成功后的本地只读屏障与写后回读失败反馈回归。
 *
 * 走真实详情 hook、真实 workbench hook 与真实 UI，只 mock 外部 adapter，
 * 用可控 Promise 验证 mutation 成功与回读结果解耦：
 * - 结单 mutant 成功、回读失败（网络/业务）→ 立即只读，明确展示结单成功 + 刷新失败并可重试；
 * - 维修记录保存成功、回读失败 → 明确区分保存成功与刷新失败，不声称回滚；
 * - 回读重试成功 → 展示服务端最新结果并清除刷新失败提示；
 * - 回读期间切工单 → 旧屏障/迟到回调不影响新工单；
 * - mutation 本身失败 → 不建立只读屏障，保留原有失败行为。
 */

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRepairRequestClosureBarriersForTests } from '../application/repair-request-closure-barrier';
import { useEngineerRepairRequestDetailFlow } from '../application/use-engineer-repair-request-detail-flow';
import type {
  CloseRepairRequestResult,
  EngineerRepairMaintenanceRecord,
  EngineerRepairMaintenanceStep,
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailResult,
  RepairMaintenanceWriteResult,
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
    saveRepairRequestMaintenance: vi.fn(),
    closeRepairRequest: vi.fn(),
    downloadRepairProcessFile: vi.fn(),
  };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequestDetail);
const closeMock = vi.mocked(engineerRepairRequestAdapter.closeRepairRequest);
const saveMaintenanceMock = vi.mocked(engineerRepairRequestAdapter.saveRepairRequestMaintenance);
const createProcessMock = vi.mocked(engineerRepairRequestAdapter.createRepairProcessEntry);
const updateProcessMock = vi.mocked(engineerRepairRequestAdapter.updateRepairProcessEntry);
const uploadMock = vi.mocked(engineerRepairRequestAdapter.uploadRepairProcessFile);
const createResponseMock = vi.mocked(engineerRepairRequestAdapter.createEngineerResponse);

const CLOSE_UNCONFIRMED = '工单已结单，但详情尚未确认。';
const RETRY_REFRESH = '重试刷新';
const BARRIER_HINT = '工单已结单，内部维修过程与回复均为只读。';
const READBACK_FAILED = '已保存，刷新失败';
const SAVE_BUTTON = /保存维修记录/;
const ANTI_ROLLBACK_HINT = '历史版本仅供查看与对比，不提供回滚或恢复。';
const EDIT_MAINTENANCE = '编辑维修记录';
const FILL_MAINTENANCE = '填写维修记录';
const MAINTENANCE_STEP_PLACEHOLDER = '记录实际执行的排查动作与观察结果…';

const OPEN_MAINTENANCE: EngineerRepairMaintenanceRecord = {
  maintenanceDate: '2026-11-16',
  engineerName: '原维修工程师',
  resetResult: null,
  supplementaryNote: null,
  versionNo: 1,
  attachment: null,
};

const MAINTENANCE_STEP: EngineerRepairMaintenanceStep = {
  id: 'step-101',
  stepNo: 1,
  errorCode: null,
  partName: null,
  actionText: '服务端已有维修步骤',
  resultCode: 'RESOLVED',
};

const LATEST_MAINTENANCE: EngineerRepairMaintenanceRecord = {
  ...OPEN_MAINTENANCE,
  engineerName: '最新维修工程师',
  versionNo: 2,
};

const SAVED_MAINTENANCE: EngineerRepairMaintenanceRecord = {
  ...OPEN_MAINTENANCE,
  engineerName: '保存后维修工程师',
  versionNo: 2,
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
    maintenance: OPEN_MAINTENANCE,
    maintenanceSteps: [MAINTENANCE_STEP],
    maintenanceFaultPanels: [],
    responses: [],
    // 接单本人且后端允许编辑：可写夹具必须显式覆盖，避免默认只读导致断言失真
    canEditMaintenance: true,
    ...overrides,
  };
}

const OPEN_DETAIL = makeDetail();
const CLOSED_DETAIL = makeDetail({
  closureStatus: 'CLOSED',
  closedAt: '2026-11-16T04:00:00.000Z',
  handlingResult: 'FIXED',
  handlingStatus: 'COMPLETED',
  canEditMaintenance: false,
  maintenance: LATEST_MAINTENANCE,
  maintenanceSteps: [MAINTENANCE_STEP],
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

const SAVE_OK: RepairMaintenanceWriteResult = { ok: true, record: SAVED_MAINTENANCE };

const READBACK_NETWORK_FAILED: EngineerRepairRequestDetailResult = {
  ok: false,
  reason: 'load-failed',
  message: '网络连接异常，请稍后重试。',
};

const READBACK_BUSINESS_FAILED: EngineerRepairRequestDetailResult = {
  ok: false,
  reason: 'not-accessible',
  message: '维修申请不存在，或当前账号无权查看。',
};

function renderPanel(requestId = 21) {
  return render(
    <MemoryRouter>
      <EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={requestId} />
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

async function submitMaintenance(actionText = '更换干涉仪镜片') {
  fireEvent.click(screen.getByRole('button', { name: EDIT_MAINTENANCE }));
  fireEvent.change(await screen.findByPlaceholderText(MAINTENANCE_STEP_PLACEHOLDER), {
    target: { value: actionText },
  });
  fireEvent.click(screen.getByRole('button', { name: SAVE_BUTTON }));
}

/** 屏障生效后所有实际写入口都不可用（不只是隐藏某个提交按钮） */
function expectNoWritableEntries() {
  expect(screen.queryByText('追加处理回复')).toBeNull();
  expect(screen.queryByText(FILL_MAINTENANCE)).toBeNull();
  expect(screen.queryByText(EDIT_MAINTENANCE)).toBeNull();
  expect(screen.queryByPlaceholderText(MAINTENANCE_STEP_PLACEHOLDER)).toBeNull();
  expect(screen.queryByRole('button', { name: SAVE_BUTTON })).toBeNull();
  expect(screen.queryByRole('button', { name: /^结\s*单$/ })).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
}

function makeDetail22(): EngineerRepairRequestDetail {
  return makeDetail({
    id: 22,
    requestNo: 'RR-20261116-002',
    maintenance: { ...OPEN_MAINTENANCE, engineerName: '工单 22 维修工程师' },
    maintenanceSteps: [
      {
        ...MAINTENANCE_STEP,
        id: 'step-22',
        actionText: '工单 22 的维修步骤',
      },
    ],
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetRepairRequestClosureBarriersForTests();
  fetchMock.mockReset();
  closeMock.mockReset();
  saveMaintenanceMock.mockReset();
  createProcessMock.mockReset();
  updateProcessMock.mockReset();
  uploadMock.mockReset();
  createResponseMock.mockReset();
});

describe('结单成功后的本地只读屏障', () => {
  it('屏障生效后回复入口在应用层拒绝写入，而不仅是隐藏按钮', async () => {
    fetchMock.mockResolvedValue({ ok: true, detail: OPEN_DETAIL });

    const { result } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.markClosureSucceeded();
    });

    let response: unknown = null;
    await act(async () => {
      response = await result.current.createResponse({
        requestId: 21,
        responseText: '迟到回复',
        resolutionStatus: 'RESOLVED',
      });
    });

    expect(response).toBeNull();
    expect(createResponseMock).not.toHaveBeenCalled();
  });

  it.each([
    ['网络失败', 'network'],
    ['业务失败', 'business'],
  ] as const)(
    '结单成功但回读%s：立即只读，明确提示刷新失败、可重试且不伪造结单字段',
    async (_label, failureKind) => {
      const readback = deferred<EngineerRepairRequestDetailResult>();
      fetchMock
        .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
        .mockReturnValueOnce(readback.promise);
      closeMock.mockResolvedValue(CLOSE_OK);

      renderPanel();
      expect(await screen.findByText('原维修工程师')).toBeTruthy();

      await selectHandlingResult();
      await submitClose();

      // mutation 成功、回读尚未返回：只读屏障已生效，所有实际写入口不可用
      expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();
      expect(screen.queryByText('追加处理回复')).toBeNull();
      expect(screen.queryByText(EDIT_MAINTENANCE)).toBeNull();
      expect(screen.queryByRole('button', { name: /^结\s*单$/ })).toBeNull();
      expect(screen.getByText('原维修工程师')).toBeTruthy();

      await act(async () => {
        if (failureKind === 'network') {
          readback.reject(new Error('network down'));
        } else {
          readback.resolve(READBACK_BUSINESS_FAILED);
        }
      });

      expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
      expect(screen.getByRole('button', { name: RETRY_REFRESH })).toBeTruthy();
      // 结单仍显示成功，不把结单改报为失败
      expect(screen.queryByText('结单失败，请稍后重试。')).toBeNull();
      // 回读未确认前不编造服务端结单事实，只展示本地「待刷新确认」状态与恒定标签
      expect(screen.queryByText('已结单')).toBeNull();
      expect(screen.getByText('结单状态')).toBeTruthy();
      expect(screen.getByText('原维修工程师')).toBeTruthy();
    },
  );

  it('回读重试成功：展示服务端最新详情并清除刷新失败提示', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockResolvedValueOnce(READBACK_NETWORK_FAILED)
      .mockResolvedValueOnce({ ok: true, detail: CLOSED_DETAIL });
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();

    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: RETRY_REFRESH }));

    expect(await screen.findByText('已结单')).toBeTruthy();
    expect(screen.getByText('最新维修工程师')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull());
  });

  it('初次回读返回未结束详情：屏障保持，过程/上传/回复/再次结单均不可写且提示尚未确认', async () => {
    const readback = deferred<EngineerRepairRequestDetailResult>();
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockReturnValueOnce(readback.promise);
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();

    // 回读请求成功，但详情仍未结束：不能据此撤销本地只读屏障
    await act(async () => {
      readback.resolve({ ok: true, detail: OPEN_DETAIL });
    });

    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();
    expectNoWritableEntries();
    expect(screen.getByRole('button', { name: RETRY_REFRESH })).toBeTruthy();
    expect(screen.queryByText('已结单')).toBeNull();
    expect(screen.getByText('结单状态')).toBeTruthy();
    expect(screen.queryByText(/结单失败/)).toBeNull();
    expect(screen.getByText(ANTI_ROLLBACK_HINT)).toBeTruthy();
  });

  it('初次回读失败后，重试返回未结束详情：屏障仍保持', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockResolvedValueOnce(READBACK_NETWORK_FAILED)
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL });
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: RETRY_REFRESH }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();
    expectNoWritableEntries();
    expect(screen.queryByText('已结单')).toBeNull();
  });

  it('重试失败后再次重试采用已结束详情：服务端状态接管只读并清除未确认提示', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockResolvedValueOnce(READBACK_NETWORK_FAILED)
      .mockResolvedValueOnce(READBACK_NETWORK_FAILED)
      .mockResolvedValueOnce({ ok: true, detail: CLOSED_DETAIL });
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: RETRY_REFRESH }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: RETRY_REFRESH }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    expect(await screen.findByText('已结单')).toBeTruthy();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();
    expect(screen.getByText('工单已结单，维修记录只读。')).toBeTruthy();
    expectNoWritableEntries();
    expect(screen.queryByRole('button', { name: RETRY_REFRESH })).toBeNull();
  });

  it('初次回读即采用已结束详情：服务端状态接管，只读保持且不显示未确认提示', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockResolvedValueOnce({ ok: true, detail: CLOSED_DETAIL });
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();

    expect(await screen.findByText('已结单')).toBeTruthy();
    expect(screen.getByText('最新维修工程师')).toBeTruthy();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();
    expectNoWritableEntries();
    expect(screen.queryByRole('button', { name: RETRY_REFRESH })).toBeNull();
  });

  it('旧工单已结束回读迟到：不得解除新工单的屏障或污染其提示', async () => {
    const readback21 = deferred<EngineerRepairRequestDetailResult>();
    const readback22 = deferred<EngineerRepairRequestDetailResult>();
    const detail22 = makeDetail22();
    let calls21 = 0;
    let calls22 = 0;
    fetchMock.mockImplementation((id) => {
      if (id === 21) {
        calls21 += 1;
        return calls21 === 1
          ? Promise.resolve({ ok: true, detail: OPEN_DETAIL })
          : readback21.promise;
      }
      calls22 += 1;
      return calls22 === 1 ? Promise.resolve({ ok: true, detail: detail22 }) : readback22.promise;
    });
    closeMock.mockResolvedValue(CLOSE_OK);

    const { rerender } = renderPanel(21);
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();

    rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={22} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('工单 22 维修工程师')).toBeTruthy();

    // 工单 B 也完成结单 mutation，建立 B 自己的局部屏障
    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();

    // 工单 A 的已结束回读迟到：实例已失效，不得解除 B 的屏障
    await act(async () => {
      readback21.resolve({ ok: true, detail: CLOSED_DETAIL });
    });
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();
    expect(screen.queryByText('已结单')).toBeNull();
    expectNoWritableEntries();

    // B 自己的回读仍未结束：屏障与未确认提示都保留
    await act(async () => {
      readback22.resolve({ ok: true, detail: detail22 });
    });
    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();
    expectNoWritableEntries();
    expect(screen.queryByText('已结单')).toBeNull();
  });

  it('A→B→A 重新进入：A 的结单只读屏障保持，B 按自身状态可写', async () => {
    const detail22 = makeDetail22();
    let calls21 = 0;
    fetchMock.mockImplementation((id) => {
      if (id === 21) {
        calls21 += 1;
        return Promise.resolve({ ok: true, detail: OPEN_DETAIL });
      }
      return Promise.resolve({ ok: true, detail: detail22 });
    });
    closeMock.mockResolvedValue(CLOSE_OK);

    const { rerender } = renderPanel(21);
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();

    rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={22} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('工单 22 维修工程师')).toBeTruthy();
    // B 不受 A 的本地结单事实影响
    expect(screen.getByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();

    rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={21} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    // 重新进入 A：服务端回读仍未结束，结单成功事实不得随页面切换丢失
    expect(screen.getByText(BARRIER_HINT)).toBeTruthy();
    expect(screen.getByText(CLOSE_UNCONFIRMED)).toBeTruthy();
    expect(screen.getByRole('button', { name: RETRY_REFRESH })).toBeTruthy();
    expectNoWritableEntries();
    expect(screen.queryByText('已结单')).toBeNull();
    // 初次加载、结单回读、重新进入各一次
    expect(calls21).toBe(3);
  });

  it('切换账号/会话：旧页面迟到的已结束回读不污染新页面', async () => {
    const oldReadback = deferred<EngineerRepairRequestDetailResult>();
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ ok: true, detail: OPEN_DETAIL });
      }
      if (calls === 2) {
        return oldReadback.promise;
      }
      return Promise.resolve({ ok: true, detail: OPEN_DETAIL });
    });
    closeMock.mockResolvedValue(CLOSE_OK);

    const { rerender } = render(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={true}
          key="account-a:21"
          requestId={21}
          scopeKey="account-a"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();

    rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={true}
          key="account-b:21"
          requestId={21}
          scopeKey="account-b"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('原维修工程师')).toBeTruthy();
    expect(screen.getByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();

    // 旧账号页面的回读迟到：不得污染新账号页面
    await act(async () => {
      oldReadback.resolve({ ok: true, detail: CLOSED_DETAIL });
    });
    expect(screen.getByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();
    expect(screen.queryByText('已结单')).toBeNull();
  });

  it('结单 mutation 本身失败：不建立只读屏障，保留原有失败反馈和写入口', async () => {
    const failed: CloseRepairRequestResult = {
      ok: false,
      reason: 'close-failed',
      message: '结单失败，请稍后重试。',
    };
    closeMock.mockResolvedValue(failed);
    fetchMock.mockResolvedValue({ ok: true, detail: OPEN_DETAIL });

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();

    expect(await screen.findByText(failed.message)).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();
    expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull();
    expect(screen.getByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^结\s*单$/ })).toBeTruthy();
  });

  it('真实面板连续确认结单：第一条在途时只发出一次 mutation，按钮保持 loading', async () => {
    const closeGate = deferred<CloseRepairRequestResult>();
    closeMock.mockReturnValueOnce(closeGate.promise);
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockResolvedValue({ ok: true, detail: CLOSED_DETAIL });

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    fireEvent.click(screen.getByRole('button', { name: /^结\s*单$/ }));
    const confirm = await screen.findByRole('button', { name: '确认结单' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    // Form 校验是异步的：等两次确认都走完 onFinish 后再断言只发出一次
    await waitFor(() => expect(closeMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('button.ant-btn-loading')).not.toBeNull();

    await act(async () => {
      closeGate.resolve(CLOSE_OK);
    });
  });

  it('回读期间切换工单：旧屏障与迟到失败不影响新工单的写入口和提示', async () => {
    const readback = deferred<EngineerRepairRequestDetailResult>();
    const detail22 = makeDetail({
      id: 22,
      requestNo: 'RR-20261116-002',
      maintenance: { ...OPEN_MAINTENANCE, engineerName: '工单 22 维修工程师' },
      maintenanceSteps: [
        {
          ...MAINTENANCE_STEP,
          id: 'step-22',
          actionText: '工单 22 的维修步骤',
        },
      ],
    });
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockReturnValueOnce(readback.promise)
      .mockResolvedValue({ ok: true, detail: detail22 });
    closeMock.mockResolvedValue(CLOSE_OK);

    const { rerender } = renderPanel(21);
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await selectHandlingResult();
    await submitClose();
    expect(await screen.findByText(BARRIER_HINT)).toBeTruthy();

    rerender(
      <MemoryRouter>
        <EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={22} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('工单 22 维修工程师')).toBeTruthy();
    expect(screen.getByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();

    await act(async () => {
      readback.resolve(READBACK_NETWORK_FAILED);
    });

    await waitFor(() => expect(screen.queryByText(CLOSE_UNCONFIRMED)).toBeNull());
    expect(screen.queryByText(BARRIER_HINT)).toBeNull();
    expect(screen.getByText('追加处理回复')).toBeTruthy();
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
  });
});

describe('维修记录保存成功后的回读失败反馈', () => {
  it('维修记录保存成功但回读失败：明确区分保存成功与刷新失败，不声称回滚，详情保留并可重试', async () => {
    const savedDetail = makeDetail({
      maintenance: SAVED_MAINTENANCE,
      maintenanceSteps: [MAINTENANCE_STEP],
    });
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockResolvedValueOnce(READBACK_NETWORK_FAILED)
      .mockResolvedValueOnce({ ok: true, detail: savedDetail });
    saveMaintenanceMock.mockResolvedValue(SAVE_OK);

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await submitMaintenance();

    expect(await screen.findByText(READBACK_FAILED)).toBeTruthy();
    expect(saveMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('原维修工程师')).toBeTruthy();
    expect(screen.getByText(ANTI_ROLLBACK_HINT)).toBeTruthy();
    expect(screen.queryByText('维修记录保存失败，请稍后重试。')).toBeNull();
    // 保存已明确成功：退出编辑态，避免重复提交；只保留重试读取入口
    expect(screen.queryByRole('button', { name: SAVE_BUTTON })).toBeNull();
    expect(screen.queryByPlaceholderText(MAINTENANCE_STEP_PLACEHOLDER)).toBeNull();
    expect(screen.queryByText(EDIT_MAINTENANCE)).toBeNull();
    expect(screen.getByText('请先重试刷新最新记录再编辑。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: RETRY_REFRESH }));

    expect(await screen.findByText('保存后维修工程师')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(READBACK_FAILED)).toBeNull());
    expect(screen.getByText(EDIT_MAINTENANCE)).toBeTruthy();
  });

  it('维修记录保存成功但回读业务失败：同样明确区分保存成功与刷新失败', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: OPEN_DETAIL })
      .mockResolvedValueOnce(READBACK_BUSINESS_FAILED);
    saveMaintenanceMock.mockResolvedValue(SAVE_OK);

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await submitMaintenance();

    expect(await screen.findByText(READBACK_FAILED)).toBeTruthy();
    expect(saveMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('原维修工程师')).toBeTruthy();
    expect(screen.getByText(ANTI_ROLLBACK_HINT)).toBeTruthy();
    expect(screen.queryByText('维修记录保存失败，请稍后重试。')).toBeNull();
    expect(screen.getByRole('button', { name: RETRY_REFRESH })).toBeTruthy();
    expect(screen.queryByRole('button', { name: SAVE_BUTTON })).toBeNull();
  });

  it('维修记录保存请求失败：保留输入，不误提示「已保存」', async () => {
    const failed: RepairMaintenanceWriteResult = {
      ok: false,
      reason: 'conflict',
      message: '维修记录已被更新或工单已结单，请刷新后重试。',
    };
    saveMaintenanceMock.mockResolvedValue(failed);
    fetchMock.mockResolvedValue({ ok: true, detail: OPEN_DETAIL });

    renderPanel();
    expect(await screen.findByText('原维修工程师')).toBeTruthy();

    await submitMaintenance('保留的维修动作');

    expect(await screen.findByText(failed.message)).toBeTruthy();
    expect(saveMaintenanceMock).toHaveBeenCalledTimes(1);
    // 保存未成功：不得出现保存成功/读回失败提示，也不提供重试读取
    expect(screen.queryByText(READBACK_FAILED)).toBeNull();
    expect(screen.queryByRole('button', { name: RETRY_REFRESH })).toBeNull();
    // 保留编辑器与用户输入，便于直接重试
    expect(
      (screen.getByPlaceholderText(MAINTENANCE_STEP_PLACEHOLDER) as HTMLTextAreaElement).value,
    ).toBe('保留的维修动作');
    expect(screen.getByRole('button', { name: SAVE_BUTTON })).toBeTruthy();
  });
});

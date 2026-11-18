// src/features/repair-request/ui/engineer-repair-request-detail-panel.write-readiness.spec.tsx
// @vitest-environment jsdom

/**
 * 真实面板回归：详情未就绪时写入口的 UI 与应用层判定保持一致。
 *
 * 走真实面板 / 详情 hook / workbench hook，只 mock 外部 adapter：
 * - 首载仍在加载：只显示加载态，不出现回复 / 过程 / 上传 / 结单入口，adapter 为 0 次；
 * - 详情就绪：写入口出现，提交回复正常调用一次 adapter；
 * - 切工单后新详情未就绪：回到加载态，写入口消失，不触发任何写 adapter。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRepairRequestClosureBarriersForTests } from '../application/repair-request-closure-barrier';
import type {
  CreateEngineerResponseResult,
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailResult,
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
const createResponseMock = vi.mocked(engineerRepairRequestAdapter.createEngineerResponse);
const uploadMock = vi.mocked(engineerRepairRequestAdapter.uploadRepairProcessFile);
const createProcessMock = vi.mocked(engineerRepairRequestAdapter.createRepairProcessEntry);
const updateProcessMock = vi.mocked(engineerRepairRequestAdapter.updateRepairProcessEntry);
const closeMock = vi.mocked(engineerRepairRequestAdapter.closeRepairRequest);

const LOADING_LABEL = '正在加载维修申请详情…';

const RESPONSE_OK: CreateEngineerResponseResult = {
  ok: true,
  response: {
    id: 501,
    engineerNickname: '陈工',
    resolutionStatus: 'RESOLVED',
    responseText: '已更换备件',
    createdAt: '2026-11-16T04:00:00.000Z',
  },
};

function makeDetail(
  id: number,
  overrides: Partial<EngineerRepairRequestDetail> = {},
): EngineerRepairRequestDetail {
  return {
    id,
    requestNo: `RR-20261116-${id}`,
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
    responses: [],
    ...overrides,
  };
}

function detailOk(detail: EngineerRepairRequestDetail): EngineerRepairRequestDetailResult {
  return { ok: true, detail };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function panelElement(requestId: number, scopeKey?: string) {
  return (
    <MemoryRouter>
      <EngineerRepairRequestDetailPanel
        canHandleAsEngineer={true}
        requestId={requestId}
        scopeKey={scopeKey}
      />
    </MemoryRouter>
  );
}

function renderPanel(requestId = 21) {
  return render(panelElement(requestId));
}

function expectNoWritableEntries() {
  expect(screen.queryByText('追加处理回复')).toBeNull();
  expect(screen.queryByText('新增维修过程')).toBeNull();
  expect(screen.queryByText('编辑维修过程')).toBeNull();
  expect(screen.queryByPlaceholderText('记录实际执行的操作…')).toBeNull();
  expect(screen.queryByRole('button', { name: /^结\s*单$/ })).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
}

function fillDraft(text = '已更换备件，待观察') {
  fireEvent.change(screen.getByLabelText('回复正文'), { target: { value: text } });
}

async function selectResolved() {
  fireEvent.mouseDown(screen.getByLabelText('处理状态'));
  fireEvent.click(await screen.findByText('已解决'));
}

beforeEach(() => {
  resetRepairRequestClosureBarriersForTests();
  fetchMock.mockReset();
  createResponseMock.mockReset().mockResolvedValue(RESPONSE_OK);
  uploadMock.mockReset();
  createProcessMock.mockReset();
  updateProcessMock.mockReset();
  closeMock.mockReset();
});

describe('真实面板的未就绪写入口', () => {
  it('首载加载中无任何写入口；就绪后 UI 可写且提交回复只调用一次 adapter', async () => {
    const firstLoad = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(firstLoad.promise);

    renderPanel(21);

    expect(screen.getByText(LOADING_LABEL)).toBeTruthy();
    expectNoWritableEntries();
    expect(createResponseMock).not.toHaveBeenCalled();

    await act(async () => {
      firstLoad.resolve(detailOk(makeDetail(21)));
    });

    expect(await screen.findByText('追加处理回复')).toBeTruthy();
    expect(screen.queryByText(LOADING_LABEL)).toBeNull();

    fillDraft();
    await selectResolved();
    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));

    await waitFor(() => expect(createResponseMock).toHaveBeenCalledTimes(1));
  });

  it('切工单后新详情未就绪：写入口消失且不触发写 adapter', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(makeDetail(21)));
    const { rerender } = renderPanel(21);
    expect(await screen.findByText('追加处理回复')).toBeTruthy();

    const secondLoad = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(secondLoad.promise);
    rerender(panelElement(22));

    expect(await screen.findByText(LOADING_LABEL)).toBeTruthy();
    expectNoWritableEntries();

    expect(createResponseMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(createProcessMock).not.toHaveBeenCalled();
    expect(updateProcessMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('同账号会话代次变化：旧详情失效重读，写入口消失；采用新详情后才恢复且不携带旧草稿', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(makeDetail(21)));
    const { rerender } = render(panelElement(21, 'account-1:epoch-1'));
    expect(await screen.findByText('追加处理回复')).toBeTruthy();
    fillDraft('旧会话中的草稿');

    const freshLoad = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(freshLoad.promise);
    rerender(panelElement(21, 'account-1:epoch-2'));

    expect(await screen.findByText(LOADING_LABEL)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectNoWritableEntries();
    expect(screen.queryByLabelText('回复正文')).toBeNull();

    await act(async () => {
      freshLoad.resolve(detailOk(makeDetail(21)));
    });

    expect(await screen.findByText('追加处理回复')).toBeTruthy();
    expect(screen.getByLabelText('回复正文')).toHaveValue('');
    fillDraft('新会话输入');
    await selectResolved();
    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));
    await waitFor(() => expect(createResponseMock).toHaveBeenCalledTimes(1));
  });
});

// src/features/repair-request/ui/engineer-repair-request-detail-panel.maintenance-closure-gate.spec.tsx
// @vitest-environment jsdom

/**
 * 真实面板回归：维修记录草稿门禁拦住结单。
 *
 * 走真实详情 hook、真实维修记录 workbench 与真实编辑器，只 mock 外部 adapter：
 * - 首次填写（v0 空白记录）有未保存内容 → 提示且结单请求为 0 次，输入保留；
 * - 编辑已有记录只改步骤文本 → 同样拦截，结单请求为 0 次；
 * - 保存成功并读回后手动重新打开确认 → 结单请求正常发出；
 * - 空白 v0 未修改 → 不拦截，可用版本 0 结单。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '@/shared/i18n';

import { resetRepairRequestClosureBarriersForTests } from '../application/repair-request-closure-barrier';
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

const UNSAVED_PROMPT = translate('zh-CN', 'engineerDetail.closeBlockedByUnsavedMaintenance');
const EDIT_MAINTENANCE = translate('zh-CN', 'engineerDetail.maintenanceEdit');
const SAVE_BUTTON = /保存维修记录/;
const STEP_PLACEHOLDER = translate('zh-CN', 'maintenance.stepActionPlaceholder');
const NOTE_PLACEHOLDER = translate('zh-CN', 'maintenance.supplementaryNotePlaceholder');

const EMPTY_MAINTENANCE: EngineerRepairMaintenanceRecord = {
  maintenanceDate: null,
  engineerName: '陈工',
  resetResult: null,
  supplementaryNote: null,
  versionNo: 0,
  attachment: null,
};

const EXISTING_MAINTENANCE: EngineerRepairMaintenanceRecord = {
  ...EMPTY_MAINTENANCE,
  maintenanceDate: '2026-11-16',
  versionNo: 1,
};

const EXISTING_STEP: EngineerRepairMaintenanceStep = {
  id: 'step-101',
  stepNo: 1,
  errorCode: null,
  partName: null,
  actionText: '服务端已有维修步骤',
  resultCode: 'RESOLVED',
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
    closureStatus: 'OPEN',
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: 'IN_PROGRESS',
    processEntries: [],
    responses: [],
    maintenance: EMPTY_MAINTENANCE,
    maintenanceSteps: [],
    maintenanceFaultPanels: [],
    canEditMaintenance: true,
    ...overrides,
  };
}

const EMPTY_DETAIL = makeDetail();
const EXISTING_DETAIL = makeDetail({
  maintenance: EXISTING_MAINTENANCE,
  maintenanceSteps: [EXISTING_STEP],
});

/** 首次填写保存成功后的服务端回读：版本 0 → 1，补充说明已落库 */
const SAVED_DETAIL = makeDetail({
  maintenance: {
    ...EXISTING_MAINTENANCE,
    supplementaryNote: '首次填写草稿',
  },
});

const SAVE_OK: RepairMaintenanceWriteResult = {
  ok: true,
  record: SAVED_DETAIL.maintenance as EngineerRepairMaintenanceRecord,
};

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

function detailOk(detail: EngineerRepairRequestDetail): EngineerRepairRequestDetailResult {
  return { ok: true, detail };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={21} />
    </MemoryRouter>,
  );
}

/** 处理结果下拉在结单区，位于维修记录分区之后，取最后一个 combobox */
async function selectHandlingResult() {
  const comboboxes = screen.getAllByRole('combobox');
  fireEvent.mouseDown(comboboxes[comboboxes.length - 1]);
  fireEvent.click(await screen.findByText('故障修复'));
}

function clickCloseButton() {
  fireEvent.click(screen.getByRole('button', { name: /^结\s*单$/ }));
}

beforeEach(() => {
  resetRepairRequestClosureBarriersForTests();
  fetchMock.mockReset();
  closeMock.mockReset();
  saveMaintenanceMock.mockReset();
});

describe('维修记录草稿门禁：首次填写', () => {
  it('有未保存内容时结单确认不展开、结单请求为 0 次，保存读回后可重新确认', async () => {
    fetchMock
      .mockResolvedValueOnce(detailOk(EMPTY_DETAIL))
      .mockResolvedValueOnce(detailOk(SAVED_DETAIL));
    saveMaintenanceMock.mockResolvedValue(SAVE_OK);
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    const noteInput = (await screen.findByPlaceholderText(NOTE_PLACEHOLDER)) as HTMLTextAreaElement;
    fireEvent.change(noteInput, { target: { value: '首次填写草稿' } });

    await selectHandlingResult();
    clickCloseButton();

    expect(await screen.findByText(UNSAVED_PROMPT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认结单' })).toBeNull();
    expect(closeMock).not.toHaveBeenCalled();
    // 输入保留，不替用户自动保存
    expect(noteInput.value).toBe('首次填写草稿');
    expect(saveMaintenanceMock).not.toHaveBeenCalled();

    // 用户主动保存：成功并读回后编辑器退出，门禁解除
    fireEvent.click(screen.getByRole('button', { name: SAVE_BUTTON }));
    await waitFor(() => expect(saveMaintenanceMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByPlaceholderText(NOTE_PLACEHOLDER)).toBeNull());

    // 重新打开确认：允许提交，版本来自最新读回
    clickCloseButton();
    fireEvent.click(await screen.findByRole('button', { name: '确认结单' }));
    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(closeMock).toHaveBeenCalledWith(
      expect.objectContaining({ maintenanceVersionNo: 1, requestId: 21 }),
    );
  });
});

describe('维修记录草稿门禁：编辑已有记录', () => {
  it('只改已有步骤文本即拦截结单，输入保留且不发结单请求', async () => {
    fetchMock.mockResolvedValue(detailOk(EXISTING_DETAIL));
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    expect(await screen.findByRole('button', { name: EDIT_MAINTENANCE })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: EDIT_MAINTENANCE }));
    const stepInput = (await screen.findByPlaceholderText(STEP_PLACEHOLDER)) as HTMLTextAreaElement;
    fireEvent.change(stepInput, { target: { value: '编辑后的排查动作' } });

    await selectHandlingResult();
    clickCloseButton();

    expect(await screen.findByText(UNSAVED_PROMPT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认结单' })).toBeNull();
    expect(closeMock).not.toHaveBeenCalled();
    expect(stepInput.value).toBe('编辑后的排查动作');
  });

  it('仅打开已有记录编辑器、未修改时不拦截结单', async () => {
    fetchMock.mockResolvedValue(detailOk(EXISTING_DETAIL));
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    expect(await screen.findByRole('button', { name: EDIT_MAINTENANCE })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: EDIT_MAINTENANCE }));
    expect(await screen.findByPlaceholderText(STEP_PLACEHOLDER)).toBeTruthy();

    await selectHandlingResult();
    clickCloseButton();
    fireEvent.click(await screen.findByRole('button', { name: '确认结单' }));

    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(closeMock).toHaveBeenCalledWith(
      expect.objectContaining({ maintenanceVersionNo: 1, requestId: 21 }),
    );
  });
});

describe('维修记录草稿门禁：空白 v0', () => {
  it('空白 v0 未修改：不拦截，允许以版本 0 结单', async () => {
    fetchMock
      .mockResolvedValueOnce(detailOk(EMPTY_DETAIL))
      .mockResolvedValue(detailOk({ ...EMPTY_DETAIL, closureStatus: 'CLOSED' }));
    closeMock.mockResolvedValue(CLOSE_OK);

    renderPanel();
    await screen.findByPlaceholderText(NOTE_PLACEHOLDER);

    await selectHandlingResult();
    clickCloseButton();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: '确认结单' }));
    });

    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(closeMock).toHaveBeenCalledWith(
      expect.objectContaining({ maintenanceVersionNo: 0, requestId: 21 }),
    );
  });
});

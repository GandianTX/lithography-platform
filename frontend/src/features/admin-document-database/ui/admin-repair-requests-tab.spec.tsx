// src/features/admin-document-database/ui/admin-repair-requests-tab.spec.tsx
// @vitest-environment jsdom

/**
 * 维修申请 Tab 页面级测试（R3 + R4 + R7 S5）。
 *
 * R3/S5：主搜索在卡内工具区、loading/失败/空/数据各状态与表格分页同处
 * .kb-card 内、Drawer 在卡外；筛选/分页/Drawer 可操作。
 * R4：默认空态使用「暂无…」而非筛选空文案、清空/纯空格恢复默认态、
 * isAccepted=false 是有效筛选且进入请求变量、旧请求晚到不覆盖新结果。
 *
 * 只 mock 本 feature 的 adapter 模块，其余走真实组件与状态机。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminListPage,
  AdminRepairRequestListItem,
  AdminRepairRequestSummary,
} from '../infrastructure/admin-document-database.types';
import {
  appendAdminRepairRequestRevision,
  fetchAdminEquipmentModelOptions,
  fetchAdminRepairRequests,
  fetchAdminRepairRequestSummary,
} from '../infrastructure/admin-document-database-adapter';

import { AdminRepairRequestsTab } from './admin-repair-requests-tab';

vi.mock('../infrastructure/admin-document-database-adapter', async (importOriginal) => {
  type Adapter = typeof import('../infrastructure/admin-document-database-adapter');
  const actual = await importOriginal<Adapter>();

  return {
    ...actual,
    appendAdminRepairRequestRevision: vi.fn(),
    fetchAdminEquipmentModelOptions: vi.fn(),
    fetchAdminRepairRequestSummary: vi.fn(),
    fetchAdminRepairRequests: vi.fn(),
  };
});

const appendRevisionMock = vi.mocked(appendAdminRepairRequestRevision);

const fetchRepairMock = vi.mocked(fetchAdminRepairRequests);
const fetchSummaryMock = vi.mocked(fetchAdminRepairRequestSummary);
const fetchModelOptionsMock = vi.mocked(fetchAdminEquipmentModelOptions);

function buildRepairItem(id: number): AdminRepairRequestListItem {
  return {
    id,
    requestNo: `RR-2026090${id}-001`,
    customerNickname: `客户${id}`,
    companyName: null,
    equipmentModelId: 49,
    equipmentModelCode: 'ASML-TWINSCAN-NXT-1980DI',
    equipmentModelName: 'ASML TWINSCAN NXT:1980Di',
    errorCode: 'E-001',
    isAccepted: false,
    acceptedAt: null,
    acceptedByEngineerNickname: null,
    latestResolutionStatus: null,
    createdAt: '2026-09-01T08:00:00.000Z',
  };
}

function buildSummary(id: number): AdminRepairRequestSummary {
  return {
    ...buildRepairItem(id),
    faultDescription: '曝光光路异常',
    contentMd: '## 故障描述\n\n曝光光路异常。',
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: null,
    currentRevisionNo: 0,
    processEntries: [],
    responses: [],
    revisions: [],
  };
}

function buildPage<T>(items: T[], total = items.length, page = 1): AdminListPage<T> {
  return { items, total, page, pageSize: 10 };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  appendRevisionMock.mockReset();
  fetchRepairMock.mockReset();
  fetchSummaryMock.mockReset();
  fetchModelOptionsMock.mockReset();

  fetchRepairMock.mockResolvedValue(buildPage([buildRepairItem(1), buildRepairItem(2)]));
  fetchSummaryMock.mockResolvedValue({ ok: true, detail: buildSummary(1) });
  fetchModelOptionsMock.mockResolvedValue([
    { id: 49, modelCode: 'ASML-TWINSCAN-NXT-1980DI', modelName: 'ASML TWINSCAN NXT:1980Di' },
  ]);
});

describe('AdminRepairRequestsTab（R3/R7 S5 知识库卡容器）', () => {
  it('主搜索在卡内工具区，loading 骨架在同一知识库卡内', async () => {
    const { container } = render(<AdminRepairRequestsTab />);

    const card = container.querySelector('.kb-card');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.table-container')).toBeNull();
    const toolbar = card?.querySelector('.kb-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('input')).not.toBeNull();
    expect(card?.querySelector('.kb-card-state .ant-skeleton')).not.toBeNull();

    // flush 初始取数的落定，避免测试结束后才 dispatch 的 act 警告
    await act(async () => {});
  });

  it('有数据：表格与卡底分页在知识库卡内，详情 Drawer 在卡外且可打开', async () => {
    const { container } = render(<AdminRepairRequestsTab />);

    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();
    const card = container.querySelector('.kb-card');
    expect(card?.querySelector('.kb-table-scope table')).not.toBeNull();
    expect(card?.querySelector('.kb-card-footer .ant-pagination')).not.toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /详\s*情/ })[0]);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText(/工单详情/)).toBeInTheDocument();
    expect(container.querySelector('.kb-card .ant-drawer')).toBeNull();
  });

  it('加载失败：错误告警在知识库卡内呈现，重试可恢复数据', async () => {
    fetchRepairMock.mockRejectedValueOnce(new Error('network down'));
    const { container } = render(<AdminRepairRequestsTab />);

    expect(await screen.findByText('维修申请列表加载失败，请稍后重试。')).toBeInTheDocument();
    expect(container.querySelector('.kb-card .kb-card-state .ant-alert-error')).not.toBeNull();

    // AntD 两字按钮在中间插入全角空格（「重 试」），用正则容忍
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();
  });

  it('设备型号加载失败：告警与表格同卡显示（四态同卡，型号告警不单独带框）', async () => {
    fetchModelOptionsMock.mockRejectedValueOnce(new Error('models down'));
    const { container } = render(<AdminRepairRequestsTab />);

    expect(
      await screen.findByText('设备型号选项加载失败，型号筛选暂不可用，可继续使用其他筛选。'),
    ).toBeInTheDocument();
    const card = container.querySelector('.kb-card');
    expect(card?.querySelector('.kb-card-state .ant-alert-warning')).not.toBeNull();
    expect(card?.querySelector('table')).not.toBeNull();
  });
});

describe('AdminRepairRequestsTab（R4 有效筛选单一真源）', () => {
  it('默认空（无筛选）：显示「暂无维修申请。」而非筛选空文案，请求参数为空对象', async () => {
    fetchRepairMock.mockResolvedValue(buildPage([]));
    render(<AdminRepairRequestsTab />);

    expect(await screen.findByText('暂无维修申请。')).toBeInTheDocument();
    expect(screen.queryByText('没有符合筛选条件的维修申请。')).toBeNull();
    expect(fetchRepairMock).toHaveBeenCalledWith(1, 10, {});
  });

  it('真实筛选无结果：显示筛选空文案，请求变量保留筛选字段', async () => {
    fetchRepairMock.mockResolvedValue(buildPage([]));
    render(<AdminRepairRequestsTab />);
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText('按申请编号搜索'), {
      target: { value: 'RR-999' },
    });

    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(fetchRepairMock).toHaveBeenLastCalledWith(1, 10, { requestNo: 'RR-999' });
    expect(await screen.findByText('没有符合筛选条件的维修申请。')).toBeInTheDocument();
  });

  it('清空输入（含纯空格）后恢复默认空态与空请求参数', async () => {
    fetchRepairMock.mockResolvedValue(buildPage([]));
    render(<AdminRepairRequestsTab />);
    const search = screen.getByPlaceholderText('按申请编号搜索');
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(1));

    fireEvent.change(search, { target: { value: 'RR-999' } });
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(await screen.findByText('没有符合筛选条件的维修申请。')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '   ' } });
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(fetchRepairMock).toHaveBeenLastCalledWith(1, 10, {});
    expect(await screen.findByText('暂无维修申请。')).toBeInTheDocument();
  });

  it('仅接单状态=待接单（false）是有效筛选，请求变量保留 isAccepted:false', async () => {
    fetchRepairMock.mockResolvedValue(buildPage([]));
    render(<AdminRepairRequestsTab />);
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(1));

    // 接单状态位于「筛选」展开区内，先展开再操作
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.mouseDown(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByText('待接单'));

    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(fetchRepairMock).toHaveBeenLastCalledWith(1, 10, { isAccepted: false });
    expect(await screen.findByText('没有符合筛选条件的维修申请。')).toBeInTheDocument();
  });

  it('筛选入口可展开/收起，重置清空主搜索与展开区条件回到空请求参数', async () => {
    fetchRepairMock.mockResolvedValue(buildPage([]));
    render(<AdminRepairRequestsTab />);
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(1));

    const filterButton = screen.getByRole('button', { name: '筛选' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(filterButton);
    expect(filterButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.change(screen.getByPlaceholderText('按申请编号搜索'), {
      target: { value: 'RR-999' },
    });
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(fetchRepairMock).toHaveBeenLastCalledWith(1, 10, { requestNo: 'RR-999' });

    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(fetchRepairMock).toHaveBeenLastCalledWith(1, 10, {});
    expect(await screen.findByText('暂无维修申请。')).toBeInTheDocument();
  });

  it('分页可操作：翻页请求同时保留筛选参数并回带 page=2', async () => {
    fetchRepairMock.mockResolvedValueOnce(buildPage([buildRepairItem(1)], 25, 1));
    fetchRepairMock.mockResolvedValueOnce(buildPage([buildRepairItem(1)], 25, 1));
    fetchRepairMock.mockResolvedValueOnce(buildPage([buildRepairItem(5)], 25, 2));
    const { container } = render(<AdminRepairRequestsTab />);
    await screen.findByText('RR-20260901-001');

    fireEvent.change(screen.getByPlaceholderText('按申请编号搜索'), { target: { value: 'RR-' } });
    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(fetchRepairMock).toHaveBeenLastCalledWith(1, 10, { requestNo: 'RR-' });

    const secondPage = container.querySelector('.ant-pagination-item-2 a');
    expect(secondPage).not.toBeNull();
    fireEvent.click(secondPage as HTMLElement);

    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(3));
    expect(fetchRepairMock).toHaveBeenLastCalledWith(2, 10, { requestNo: 'RR-' });
    expect(await screen.findByText('RR-20260905-001')).toBeInTheDocument();
  });

  it('快速筛选时旧请求晚到不覆盖新列表（requestSeq 竞态防护）', async () => {
    let resolveStale: (value: AdminListPage<AdminRepairRequestListItem>) => void = () => {};
    const stalePage = new Promise<AdminListPage<AdminRepairRequestListItem>>((resolve) => {
      resolveStale = resolve;
    });
    fetchRepairMock.mockReturnValueOnce(stalePage);
    fetchRepairMock.mockResolvedValueOnce(buildPage([buildRepairItem(2)]));

    render(<AdminRepairRequestsTab />);
    fireEvent.change(screen.getByPlaceholderText('按申请编号搜索'), { target: { value: 'RR-2' } });

    await waitFor(() => expect(fetchRepairMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(await screen.findByText('RR-20260902-001')).toBeInTheDocument();

    // 首笔旧请求此刻才返回：不得覆盖已渲染的新结果
    await act(async () => {
      resolveStale(buildPage([buildRepairItem(1)]));
    });

    expect(screen.queryByText('RR-20260901-001')).toBeNull();
    expect(screen.getByText('RR-20260902-001')).toBeInTheDocument();
  });
});

describe('AdminRepairRequestsTab（修订迟到响应身份守卫）', () => {
  type RevisionOutcome = Awaited<ReturnType<typeof appendAdminRepairRequestRevision>>;

  const REVISION_RESULT = {
    requestId: 1,
    currentRevisionNo: 1,
    revisionNo: 1,
    previousVersion: 0,
    reason: 'A 修订原因',
    actorNickname: 'admin',
    createdAt: '2026-09-01T09:00:00.000Z',
  };

  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  async function openRevisionFor(index: number): Promise<void> {
    fireEvent.click(screen.getAllByRole('button', { name: /详\s*情/ })[index]);
    await screen.findByText(new RegExp(`工单详情 · RR-2026090${index + 1}-001`));
    fireEvent.click(screen.getByRole('button', { name: /修\s*订/ }));
    await screen.findByPlaceholderText('说明本次修订的原因与依据');
  }

  async function closeDrawer(): Promise<void> {
    const close = document.querySelector('.ant-drawer-close');
    expect(close).not.toBeNull();
    fireEvent.click(close as HTMLElement);
    await waitFor(() => expect(screen.queryByText(/工单详情 ·/)).toBeNull());
  }

  beforeEach(() => {
    fetchSummaryMock.mockImplementation(async (target) => ({
      ok: true,
      detail: buildSummary(target),
    }));
  });

  it('A 迟到成功不关闭 B 弹窗、不重载 A、不污染 B', async () => {
    const pending = createDeferred<RevisionOutcome>();
    appendRevisionMock.mockReturnValueOnce(pending.promise);

    render(<AdminRepairRequestsTab />);
    await screen.findByText('RR-20260901-001');

    await openRevisionFor(0);
    fireEvent.change(screen.getByDisplayValue(/## 故障描述/), {
      target: { value: '# A 修订稿' },
    });
    fireEvent.change(screen.getByPlaceholderText('说明本次修订的原因与依据'), {
      target: { value: 'A 修订原因' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
    await waitFor(() => expect(appendRevisionMock).toHaveBeenCalledTimes(1));

    // 响应前关闭 A 的修订弹窗与详情，改开 B 的修订弹窗
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));
    await closeDrawer();
    await openRevisionFor(1);
    fireEvent.change(screen.getByPlaceholderText('说明本次修订的原因与依据'), {
      target: { value: 'B 修订原因' },
    });
    fireEvent.change(screen.getByDisplayValue(/## 故障描述/), {
      target: { value: '# B 修订稿' },
    });

    // A 的提交此刻才成功返回
    await act(async () => {
      pending.resolve({ ok: true, result: REVISION_RESULT });
    });

    // B 弹窗仍在、B 输入未被覆盖；A 的详情未被重新加载
    expect(screen.getByDisplayValue('B 修订原因')).toBeInTheDocument();
    expect(screen.getByDisplayValue('# B 修订稿')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('A 修订原因')).toBeNull();
    expect(screen.getByText(/工单详情 · RR-20260902-001/)).toBeInTheDocument();
    expect(fetchSummaryMock.mock.calls.map((call) => call[0])).toEqual([1, 2]);
  });

  it('A 迟到失败不覆盖 B 的错误与输入', async () => {
    const pending = createDeferred<RevisionOutcome>();
    appendRevisionMock.mockReturnValueOnce(pending.promise);

    render(<AdminRepairRequestsTab />);
    await screen.findByText('RR-20260901-001');

    await openRevisionFor(0);
    fireEvent.change(screen.getByDisplayValue(/## 故障描述/), {
      target: { value: '# A 修订稿' },
    });
    fireEvent.change(screen.getByPlaceholderText('说明本次修订的原因与依据'), {
      target: { value: 'A 修订原因' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
    await waitFor(() => expect(appendRevisionMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));
    await closeDrawer();
    await openRevisionFor(1);

    // B 自身产生校验错误，并保留已输入内容
    fireEvent.change(screen.getByDisplayValue(/## 故障描述/), {
      target: { value: '# B 修订稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
    expect(await screen.findByText('请填写修订原因。')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('说明本次修订的原因与依据'), {
      target: { value: 'B 修订原因' },
    });

    // A 的提交此刻以业务失败返回
    await act(async () => {
      pending.resolve({ ok: false, message: 'A 迟到冲突' });
    });

    expect(screen.queryByText('A 迟到冲突')).toBeNull();
    expect(screen.getByText('请填写修订原因。')).toBeInTheDocument();
    expect(screen.getByDisplayValue('B 修订原因')).toBeInTheDocument();
    expect(fetchSummaryMock.mock.calls.map((call) => call[0])).toEqual([1, 2]);
  });
});

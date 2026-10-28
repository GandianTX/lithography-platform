// src/features/reference-document/ui/reference-document-detail-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 参考资料详情面板 UI 单测。
 *
 * 走真实面板 + 真实详情 query 状态机，只 mock 外部 adapter 与路由跳转；
 * 统一 NOT_FOUND 态、编辑/软删入口的角色可见性、软删防重与不乐观口径均由
 * 生产组件决定，测试不复制规则。
 */

import { type ReactElement, StrictMode } from 'react';
import {
  act,
  fireEvent,
  render as rtlRender,
  type RenderOptions,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import type { ReferenceDocumentDetail } from '../infrastructure/reference-document.types';
import * as referenceDocumentAdapter from '../infrastructure/reference-document-adapter';
import * as referenceDocumentHttpAdapter from '../infrastructure/reference-document-http-adapter';

import { ReferenceDocumentDetailPanel } from './reference-document-detail-panel';

/**
 * 面板的反馈呈现由 MessageFeedbackProvider（src/shared/ui/message-feedback）提供：
 * 走 `message.useMessage()` 的 context api，不再用静态 `message`。
 * RTL 的 rerender 会复用同一个 wrapper，故这里包一次即可覆盖全文件的 render / rerender。
 */
function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return rtlRender(ui, { wrapper: MessageFeedbackProvider, ...options });
}

vi.mock('../infrastructure/reference-document-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceDocumentAdapter>();

  return {
    ...actual,
    fetchReferenceDocument: vi.fn(),
    updateReferenceDocument: vi.fn(),
    deleteReferenceDocument: vi.fn(),
  };
});

vi.mock('../infrastructure/reference-document-http-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceDocumentHttpAdapter>();

  return {
    ...actual,
    downloadReferenceDocumentFile: vi.fn(),
  };
});

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const navigateMock = vi.fn();

const fetchDetailMock = vi.mocked(referenceDocumentAdapter.fetchReferenceDocument);
const updateMock = vi.mocked(referenceDocumentAdapter.updateReferenceDocument);
const deleteMock = vi.mocked(referenceDocumentAdapter.deleteReferenceDocument);
const downloadFileMock = vi.mocked(referenceDocumentHttpAdapter.downloadReferenceDocumentFile);

function buildDetail(id: number): ReferenceDocumentDetail {
  return {
    id,
    title: 'NXE:3400C 光源维护指南（Mock）',
    documentType: 'MAINTENANCE_GUIDE',
    equipmentModelId: 51,
    equipmentModelName: 'ASML TWINSCAN NXE:3400C',
    equipmentModelText: null,
    description: '光源模块周期性维护要点。',
    originalFilename: 'nxe-3400c-source-guide-mock.pdf',
    mimeType: 'application/pdf',
    hasFile: true,
    contentText: '# 光源维护指南\n\n每周记录能量衰减。',
    organizationName: '甲方默认组织',
    ingestMethod: 'ADMIN_DIRECT',
    caseDetail: null,
    creatorNickname: '陈工',
    createdAt: '2026-08-02T09:30:00.000Z',
    updatedAt: '2026-08-05T14:00:00.000Z',
  };
}

beforeEach(() => {
  fetchDetailMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  downloadFileMock.mockReset();
  navigateMock.mockReset();

  // jsdom 无 blob URL 体系，浏览器保存链路用 spy 钉住调用形态
  URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  URL.revokeObjectURL = vi.fn();
});

/**
 * AntD message 的通知容器挂在 document.body 上（context api 与静态调用同样如此），
 * 不随 RTL cleanup 移除，因此「不得提示成功」不能按文本查（会命中前序用例残留的同文通知），
 * 改为按节点身份快照判定「结算旧结果后有无新增通知」。
 */
const snapshotNotices = () => new Set(document.querySelectorAll('.ant-message-notice'));

const addedNotices = (before: Set<Element>) =>
  Array.from(document.querySelectorAll('.ant-message-notice')).filter(
    (notice) => !before.has(notice),
  );

/**
 * 当前可见 Popconfirm 的确认按钮集合。
 *
 * RTL cleanup 只卸载组件树，AntD 挂在 document.body 的 popover 容器会跨用例残留
 * （关闭后带 `.ant-popover-hidden`）。按文本查「确认删除」会命中这些残留节点，
 * 取「最后一个」于是依赖容器插入顺序 —— 全文件跑与单用例跑结果不一致。
 * 这里只认「可见容器内的确认按钮」，与执行顺序和残留无关。
 */
const visibleConfirmButtons = () =>
  Array.from(document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)')).flatMap(
    (popover) => Array.from(popover.querySelectorAll('.ant-popconfirm-buttons .ant-btn-primary')),
  );

/** 点「删除」并点击当前可见 Popconfirm 的确认按钮（不经文本查残留节点） */
async function confirmVisibleDelete() {
  fireEvent.click(screen.getByRole('button', { name: '删 除' }));
  await waitFor(() => expect(visibleConfirmButtons()).toHaveLength(1));
  fireEvent.click(visibleConfirmButtons()[0]);
}

describe('ReferenceDocumentDetailPanel', () => {
  it('详情展示完整元数据与文本内容；ENGINEER（canManage=false）只见只读态', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(970002) });

    render(<ReferenceDocumentDetailPanel canManage={false} documentId={970002} />);

    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    expect(screen.getByText('维护指南')).toBeTruthy();
    expect(screen.getByText('ASML TWINSCAN NXE:3400C')).toBeTruthy();
    expect(screen.getByText('陈工')).toBeTruthy();
    expect(screen.getByText(/每周记录能量衰减/)).toBeTruthy();
    // 只读态：无编辑 / 删除入口
    expect(screen.queryByRole('button', { name: /编辑/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });

  it('canManage=true 时可见编辑与删除入口', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(970002) });

    render(<ReferenceDocumentDetailPanel canManage={true} documentId={970002} />);

    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    expect(screen.getByRole('button', { name: /编\s*辑/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /删\s*除/ })).toBeTruthy();
  });

  it('下载入口：canManage=false（ENGINEER）也可见；点击后经 blob URL 触发浏览器保存', async () => {
    const blob = new Blob(['pdf-bytes'], { type: 'application/pdf' });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(970002) });
    downloadFileMock.mockResolvedValue({
      ok: true,
      blob,
      filename: 'nxe-3400c-source-guide-mock.pdf',
    });

    render(<ReferenceDocumentDetailPanel canManage={false} documentId={970002} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    // 只读角色（ENGINEER）可见：canManage=false 仍显示下载入口
    fireEvent.click(screen.getByRole('button', { name: /下载文件/ }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(downloadFileMock).toHaveBeenCalledWith(970002);
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);

    // 排空下载 promise 链的收尾 setState（finally 内 downloading 复位）：
    // 否则 jsdom teardown 后 React 仍在调度并访问 window，产生未处理
    // ReferenceError（验收报告 20260916，不能仅靠断言通过计数）。
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // a[download] 带服务端文件名，保存后回收 URL
    const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement;

    expect(anchor.download).toBe('nxe-3400c-source-guide-mock.pdf');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    clickSpy.mockRestore();
  });

  it('纯文本资料不显示下载入口', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: { ...buildDetail(970005), originalFilename: null, mimeType: null, hasFile: false },
    });

    render(<ReferenceDocumentDetailPanel canManage={false} documentId={970005} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    expect(screen.queryByRole('button', { name: /下载文件/ })).toBeNull();
  });

  it('有文件名但无存储引用（hasFile=false）不显示下载入口：不从 originalFilename 推断', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: { ...buildDetail(970001), hasFile: false },
    });

    render(<ReferenceDocumentDetailPanel canManage={false} documentId={970001} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    // 原始文件名仍如实展示，但不承诺可下载
    expect(screen.getByText('nxe-3400c-source-guide-mock.pdf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /下载文件/ })).toBeNull();
  });

  it('下载失败展示受控错误文案', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(970002) });
    downloadFileMock.mockResolvedValue({
      ok: false,
      reason: 'file-not-available',
      message: '该资料没有可下载的文件。',
    });

    render(<ReferenceDocumentDetailPanel canManage={false} documentId={970002} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    fireEvent.click(screen.getByRole('button', { name: /下载文件/ }));

    expect(await screen.findByText('该资料没有可下载的文件。')).toBeTruthy();
  });

  it('下载链路抛异常时兜底：不外泄原始错误，给出统一重试文案并复位按钮', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(970002) });
    // adapter 抛异常（网络中断 / blob 读取失败等未包装路径）：走面板 catch 兜底，
    // 不得把底层异常原样抛给用户，也不得让按钮永久停留在 loading。
    downloadFileMock.mockRejectedValue(new Error('boom: raw fetch failure'));

    render(<ReferenceDocumentDetailPanel canManage={false} documentId={970002} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    fireEvent.click(screen.getByRole('button', { name: /下载文件/ }));

    expect(await screen.findByText('下载失败，请稍后重试。')).toBeTruthy();
    // 底层异常细节不得透出界面
    expect(screen.queryByText(/boom/)).toBeNull();
    // 兜底后必须复位：按钮不再 loading，用户可重试
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /下载文件/ }).classList.contains('ant-btn-loading'),
      ).toBe(false),
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('统一 NOT_FOUND：不存在与已软删呈现 warning 态而非数据', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可查看。',
    });

    render(<ReferenceDocumentDetailPanel canManage={true} documentId={999999} />);

    await screen.findByText('参考资料不存在或不可查看。');

    expect(screen.queryByText('删除')).toBeNull();
    expect(screen.getByRole('button', { name: /返回列表/ })).toBeTruthy();
  });

  it('加载失败展示共享错误文案与重试入口', async () => {
    fetchDetailMock.mockRejectedValue(
      new (await import('@/shared/graphql')).GraphQLIngressError({
        type: 'network',
        message: 'fetch failed',
      }),
    );

    render(<ReferenceDocumentDetailPanel canManage={false} documentId={970002} />);

    await screen.findByText('网络连接异常，请稍后重试。');
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
  });

  it('编辑：提交成功后刷新详情并退出编辑态；取消丢弃修改', async () => {
    const detail = buildDetail(970002);

    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail }).mockResolvedValueOnce({
      ok: true,
      detail: { ...detail, title: '改名后的维护指南' },
    });
    updateMock.mockResolvedValue({ ok: true, id: 970002 });

    render(<ReferenceDocumentDetailPanel canManage={true} documentId={970002} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    // 进入编辑态
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }));
    await screen.findByText('编辑参考资料');

    // 取消路径：丢弃修改回详情
    fireEvent.click(screen.getByRole('button', { name: /取消编辑/ }));
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');
    expect(updateMock).not.toHaveBeenCalled();

    // 提交路径：成功后刷新并回到详情展示
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }));
    await screen.findByText('编辑参考资料');
    fireEvent.change(screen.getByPlaceholderText('请输入文档标题'), {
      target: { value: '改名后的维护指南' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }));

    await screen.findByText('改名后的维护指南');
    expect(updateMock).toHaveBeenCalledWith(
      970002,
      expect.objectContaining({
        title: '改名后的维护指南',
      }),
    );
    expect(fetchDetailMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('编辑参考资料')).toBeNull();
  });

  it('ID 变化时同步退出旧资料的编辑态（负责人 0909 阻塞项 2 验收）', async () => {
    fetchDetailMock.mockImplementation(
      (id) => Promise.resolve({ ok: true, detail: buildDetail(id) }) as never,
    );

    const { rerender } = render(
      <ReferenceDocumentDetailPanel canManage={true} documentId={970002} />,
    );
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    // 在资料 970002 上进入编辑态
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }));
    await screen.findByText('编辑参考资料');

    // 切换到另一份资料：编辑态必须被清除，不得沿用旧资料开启的编辑界面
    rerender(<ReferenceDocumentDetailPanel canManage={true} documentId={970003} />);

    await screen.findByText('NXE:3400C 光源维护指南（Mock）');
    expect(screen.queryByText('编辑参考资料')).toBeNull();
    // 且详情展示操作目标与新 ID 一致（保存/删除发送的 documentId 与界面显示一致）
    expect(screen.getByRole('button', { name: /编\s*辑/ })).toBeTruthy();
  });

  it('软删：二次确认后删除并回列表，未确认前不发请求；成功路径不回刷详情', async () => {
    const detail = buildDetail(970002);

    fetchDetailMock.mockResolvedValue({ ok: true, detail });
    deleteMock.mockResolvedValue({ ok: true });

    render(<ReferenceDocumentDetailPanel canManage={true} documentId={970002} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');
    expect(fetchDetailMock).toHaveBeenCalledTimes(1);

    // 未确认前不调用删除（精确匹配主按钮，避免命中 Popconfirm 的「确认删除」）
    fireEvent.click(screen.getByRole('button', { name: '删 除' }));
    expect(deleteMock).not.toHaveBeenCalled();

    // Popconfirm 确认
    fireEvent.click(await screen.findByText('确认删除'));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/reference-documents'));
    // 成功即离页，不产生多余详情查询
    expect(fetchDetailMock).toHaveBeenCalledTimes(1);
  });

  it('软删业务失败：给原因并精确回刷一次详情，不乐观跳转（去掉生产 reload 本用例必红）', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(970002) });
    deleteMock.mockResolvedValue({
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可删除。',
    });

    render(<ReferenceDocumentDetailPanel canManage={true} documentId={970002} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    // 基线查询次数：断言「失败后精确 +1」，避免只证「曾调用过」的恒真断言
    const baselineFetchCount = fetchDetailMock.mock.calls.length;

    expect(baselineFetchCount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '删 除' }));
    fireEvent.click(await screen.findByText('确认删除'));

    await screen.findByText('参考资料不存在或不可删除。');
    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(baselineFetchCount + 1));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('软删抛异常：兜底文案并精确回刷一次详情，不乐观跳转且不外泄原始错误', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(970002) });
    deleteMock.mockRejectedValue(new Error('boom: delete transport failure'));

    render(<ReferenceDocumentDetailPanel canManage={true} documentId={970002} />);
    await screen.findByText('NXE:3400C 光源维护指南（Mock）');

    const baselineFetchCount = fetchDetailMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '删 除' }));
    fireEvent.click(await screen.findByText('确认删除'));

    await screen.findByText('参考资料删除失败，请稍后重试。');
    expect(screen.queryByText(/boom/)).toBeNull();
    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(baselineFetchCount + 1));
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

/**
 * 操作目标守卫矩阵（PR5 S4 评审 Codex P1-1）：
 * 在资料 A 上发起 update / delete / download 并保持 pending，切换到资料 B 且 B 先就绪，
 * 再结算 A 的旧结果。旧目标的任何结果都不得提示、不得导航、不得把 A reload 进 B 的路由
 * （否则「界面显示 B、内容却是 A」，用户随后保存会把 A 的字段写入 B），
 * 也不得让旧目标的 pending 状态继续锁住 B 的操作入口。
 */
describe('ReferenceDocumentDetailPanel 操作目标守卫（A pending → 切 B → A settle）', () => {
  const DETAIL_A = { ...buildDetail(970002), title: '甲资料标题' };
  const DETAIL_B = { ...buildDetail(970003), title: '乙资料标题' };

  /** A / B 详情按 id 区分返回，用于识别「旧资料被 reload 回新路由」 */
  function mockDetailByTarget() {
    fetchDetailMock.mockImplementation(
      (id) =>
        Promise.resolve({
          ok: true,
          detail: id === DETAIL_B.id ? DETAIL_B : DETAIL_A,
        }) as never,
    );
  }

  const fetchCountFor = (id: number) =>
    fetchDetailMock.mock.calls.filter(([calledId]) => calledId === id).length;

  async function switchToB(rerender: ReturnType<typeof render>['rerender'], canManage: boolean) {
    rerender(<ReferenceDocumentDetailPanel canManage={canManage} documentId={DETAIL_B.id} />);
    await screen.findByText(DETAIL_B.title);
  }

  it('编辑成功结果跨目标：不提示成功、不 reload 回新路由，后续编辑只写 B', async () => {
    mockDetailByTarget();
    let resolveUpdate: ((value: { ok: true; id: number }) => void) | undefined;

    updateMock.mockImplementation(
      () =>
        new Promise<{ ok: true; id: number }>((resolve) => {
          resolveUpdate = resolve;
        }) as never,
    );

    const { rerender } = render(
      <ReferenceDocumentDetailPanel canManage={true} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }));
    await screen.findByText('编辑参考资料');
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith(DETAIL_A.id, expect.anything());

    await switchToB(rerender, true);
    expect(fetchCountFor(DETAIL_A.id)).toBe(1);

    const noticesBefore = snapshotNotices();

    await act(async () => {
      resolveUpdate?.({ ok: true, id: DETAIL_A.id });
    });

    // 旧目标结果被丢弃：不新增任何提示、不把 A reload 回 B 的路由
    expect(addedNotices(noticesBefore)).toHaveLength(0);
    expect(screen.queryByText(DETAIL_A.title)).toBeNull();
    expect(screen.getByText(DETAIL_B.title)).toBeTruthy();
    expect(fetchCountFor(DETAIL_A.id)).toBe(1);

    // 后续编辑必须只作用于 B（界面显示与写入目标一致）
    updateMock.mockResolvedValue({ ok: true, id: DETAIL_B.id });
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }));
    await screen.findByText('编辑参考资料');
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenLastCalledWith(DETAIL_B.id, expect.anything()),
    );
  });

  it('编辑业务失败结果跨目标：不改写新目标状态、不 reload A', async () => {
    mockDetailByTarget();
    let resolveUpdate: ((value: { ok: false; message: string }) => void) | undefined;

    updateMock.mockImplementation(
      () =>
        new Promise<{ ok: false; message: string }>((resolve) => {
          resolveUpdate = resolve;
        }) as never,
    );

    const { rerender } = render(
      <ReferenceDocumentDetailPanel canManage={true} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }));
    await screen.findByText('编辑参考资料');
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));

    await switchToB(rerender, true);

    const noticesBefore = snapshotNotices();

    await act(async () => {
      resolveUpdate?.({ ok: false, message: '甲资料更新被拒绝。' });
    });

    // 说明：编辑失败结果只回传给表单，而表单已随目标切换卸载，因此本用例对
    // 「守卫本身」不具鉴别力（有无守卫都看不到差别）；它钉住的是「不泄漏」这一独立要求：
    // 旧目标的失败既不得渲染进新目标界面，也不得升级为全局提示或回刷 A。
    expect(screen.queryByText('甲资料更新被拒绝。')).toBeNull();
    expect(addedNotices(noticesBefore)).toHaveLength(0);
    expect(screen.getByText(DETAIL_B.title)).toBeTruthy();
    expect(fetchCountFor(DETAIL_A.id)).toBe(1);
    // 旧目标的挂起/失败不得锁住新目标的编辑入口
    expect(screen.getByRole('button', { name: /编\s*辑/ })).toBeTruthy();
  });

  it('软删成功结果跨目标：不跳转列表、不提示成功、不改写 B', async () => {
    mockDetailByTarget();
    let resolveDelete: ((value: { ok: true }) => void) | undefined;

    deleteMock.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveDelete = resolve;
        }) as never,
    );

    const { rerender } = render(
      <ReferenceDocumentDetailPanel canManage={true} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    fireEvent.click(screen.getByRole('button', { name: '删 除' }));
    fireEvent.click(await screen.findByText('确认删除'));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock).toHaveBeenCalledWith(DETAIL_A.id);

    await switchToB(rerender, true);
    // 旧目标 pending 期间的操作锁已随目标切换放开，B 的删除入口可用
    expect((screen.getByRole('button', { name: '删 除' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    const noticesBefore = snapshotNotices();

    await act(async () => {
      resolveDelete?.({ ok: true });
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(addedNotices(noticesBefore)).toHaveLength(0);
    expect(screen.getByText(DETAIL_B.title)).toBeTruthy();
    // 且 B 的删除入口未被旧目标的收尾逻辑重新锁死
    expect((screen.getByRole('button', { name: '删 除' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    // 且 B 能立即发起自己的删除：目标切换后旧目标不得再持有 B 的操作锁，
    // 否则按钮看似可用、点击却静默失效（在途锁仍被旧目标占着）
    deleteMock.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: '删 除' }));

    await waitFor(() => expect(visibleConfirmButtons()).toHaveLength(1));

    fireEvent.click(visibleConfirmButtons()[0]);

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
    expect(deleteMock).toHaveBeenLastCalledWith(DETAIL_B.id);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/reference-documents'));
  });

  it('软删业务失败结果跨目标：不提示、不 reload A、不跳转', async () => {
    mockDetailByTarget();
    let resolveDelete: ((value: { ok: false; message: string }) => void) | undefined;

    deleteMock.mockImplementation(
      () =>
        new Promise<{ ok: false; message: string }>((resolve) => {
          resolveDelete = resolve;
        }) as never,
    );

    const { rerender } = render(
      <ReferenceDocumentDetailPanel canManage={true} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    fireEvent.click(screen.getByRole('button', { name: '删 除' }));
    fireEvent.click(await screen.findByText('确认删除'));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));

    await switchToB(rerender, true);

    await act(async () => {
      resolveDelete?.({ ok: false, message: '甲资料删除被拒绝。' });
    });

    expect(screen.queryByText('甲资料删除被拒绝。')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(fetchCountFor(DETAIL_A.id)).toBe(1);
    expect(screen.getByText(DETAIL_B.title)).toBeTruthy();
  });

  it('下载成功结果跨目标：不提示、不触发浏览器保存、B 的下载入口不残留 loading', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let resolveDownload: ((value: { ok: true; blob: Blob; filename: string }) => void) | undefined;

    mockDetailByTarget();
    downloadFileMock.mockImplementation(
      () =>
        new Promise<{ ok: true; blob: Blob; filename: string }>((resolve) => {
          resolveDownload = resolve;
        }) as never,
    );

    const { rerender } = render(
      <ReferenceDocumentDetailPanel canManage={false} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    fireEvent.click(screen.getByRole('button', { name: /下载文件/ }));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(1));
    expect(downloadFileMock).toHaveBeenCalledWith(DETAIL_A.id);

    await switchToB(rerender, false);

    // 旧目标 pending 期间不得让 B 的下载按钮停留在 loading：
    // 若 A 的请求挂死，B 将永远无法下载（在途按钮态须随目标切换放开）
    expect(
      screen.getByRole('button', { name: /下载文件/ }).classList.contains('ant-btn-loading'),
    ).toBe(false);

    await act(async () => {
      resolveDownload?.({
        ok: true,
        blob: new Blob(['pdf-bytes'], { type: 'application/pdf' }),
        filename: 'a-document.pdf',
      });
    });

    // 不得在 B 的界面下触发 A 的文件保存
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    // 旧目标 pending 不得让 B 的下载按钮永久 loading
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /下载文件/ }).classList.contains('ant-btn-loading'),
      ).toBe(false),
    );
    expect(screen.getByText(DETAIL_B.title)).toBeTruthy();

    // 且 B 能立即发起自己的下载：目标切换必须同时释放 downloadingRef，
    // 否则按钮看似可用、点击却静默失效（防连点 ref 仍被旧目标占着）
    downloadFileMock.mockResolvedValue({
      ok: true,
      blob: new Blob(['b-bytes'], { type: 'application/pdf' }),
      filename: 'b-document.pdf',
    });
    fireEvent.click(screen.getByRole('button', { name: /下载文件/ }));

    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(2));
    expect(downloadFileMock).toHaveBeenLastCalledWith(DETAIL_B.id);

    clickSpy.mockRestore();
  });

  it('下载失败结果跨目标：不提示旧目标错误、不残留 loading', async () => {
    let resolveDownload:
      | ((value: { ok: false; reason: 'file-not-available'; message: string }) => void)
      | undefined;

    mockDetailByTarget();
    downloadFileMock.mockImplementation(
      () =>
        new Promise<{ ok: false; reason: 'file-not-available'; message: string }>((resolve) => {
          resolveDownload = resolve;
        }) as never,
    );

    const { rerender } = render(
      <ReferenceDocumentDetailPanel canManage={false} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    fireEvent.click(screen.getByRole('button', { name: /下载文件/ }));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(1));

    await switchToB(rerender, false);

    // 同「下载成功结果跨目标」：在途按钮态须随目标切换放开，不依赖旧目标 settle
    expect(
      screen.getByRole('button', { name: /下载文件/ }).classList.contains('ant-btn-loading'),
    ).toBe(false);

    await act(async () => {
      resolveDownload?.({ ok: false, reason: 'file-not-available', message: '甲资料无文件。' });
    });

    expect(screen.queryByText('甲资料无文件。')).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /下载文件/ }).classList.contains('ant-btn-loading'),
      ).toBe(false),
    );
    expect(screen.getByText(DETAIL_B.title)).toBeTruthy();
  });
});

/**
 * 调度一次宏任务并等待其执行。
 * Node 下优先用 `setImmediate`：React 调度器的回调就排在同一个 check 队列里，
 * FIFO 保证「先入队的调度回调先跑完」；浏览器语义下回退到 setTimeout。
 * （`setImmediate` 是 Node 全局，前端 tsconfig 未引入 node 类型，故在此显式取值。）
 */
function waitMacrotask(): Promise<void> {
  const setImmediateFn = (
    globalThis as typeof globalThis & {
      setImmediate?: (callback: () => void) => void;
    }
  ).setImmediate;

  return new Promise((resolve) => {
    if (setImmediateFn === undefined) {
      setTimeout(resolve, 0);

      return;
    }

    setImmediateFn(resolve);
  });
}

/**
 * 排空 React 调度器（P2-4 根因处置，实测复现后修复）：
 * react-dom 的 `commitRootImpl` 只要提交里带 passive effect 标记，就会用
 * `scheduleCallback(NormalPriority, …)` 把 passive effects 的 flush 排进 React 调度器，
 * 该回调在 Node 下经 `setImmediate` 执行，回调体第一行即读取 `window.event`。
 * 若这个已入队的回调一直留到 vitest 拆除 jsdom 之后才执行，就会抛出
 * `ReferenceError: window is not defined`（实测在 6 轮全量单测中复现 1 次，
 * 属与本文件最后一个提交绑定的竞态）。这里在 act 内等待若干次宏任务，
 * 让已入队回调在 window 仍存在时按 FIFO 跑完。
 */
async function drainReactScheduler(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await waitMacrotask();
    });
  }
}

/**
 * 卸载失效矩阵（PR5 S4 双报告修复复检 Codex P2-1）：
 * 用户经侧栏离开详情页使面板卸载后，代次必须失效——在途的 update / delete / download
 * 只能静默收尾：不提示全局消息、不 navigate、不 reload、不触发浏览器保存。
 * 否则旧删除成功会把已进入其他页面的用户强制带回资料列表，旧下载也会在错误上下文触发保存。
 * 三个用例都在 act 内推进 promise 与卸载，排空收尾调度，避免 jsdom 拆除后残留调度
 * （回执 §6 的未处理异常归因）；每个用例收尾再显式 drainReactScheduler，避免已入队的
 * React 调度回调跨过本文件的 jsdom 拆除（P2-4）。
 */
describe('ReferenceDocumentDetailPanel 卸载后旧操作失效（pending → unmount → settle）', () => {
  const DETAIL_A = { ...buildDetail(970002), title: '甲资料标题' };

  function mockDetail() {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: DETAIL_A });
  }

  it('编辑 pending 期间卸载：旧更新结果不提示成功、不 reload', async () => {
    mockDetail();
    let resolveUpdate: ((value: { ok: true; id: number }) => void) | undefined;

    updateMock.mockImplementation(
      () =>
        new Promise<{ ok: true; id: number }>((resolve) => {
          resolveUpdate = resolve;
        }) as never,
    );

    const { unmount } = render(
      <ReferenceDocumentDetailPanel canManage={true} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }));
    await screen.findByText('编辑参考资料');
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));

    const baselineFetchCount = fetchDetailMock.mock.calls.length;
    const noticesBefore = snapshotNotices();

    // 请求 pending 期间离开详情页
    act(() => {
      unmount();
    });

    await act(async () => {
      resolveUpdate?.({ ok: true, id: DETAIL_A.id });
    });

    expect(addedNotices(noticesBefore)).toHaveLength(0);
    expect(navigateMock).not.toHaveBeenCalled();
    // 卸载后的旧结果不得再触发详情回刷
    expect(fetchDetailMock).toHaveBeenCalledTimes(baselineFetchCount);

    await drainReactScheduler();
  });

  it('软删 pending 期间卸载：旧删除结果不提示成功、不跳转列表、不 reload', async () => {
    mockDetail();
    let resolveDelete: ((value: { ok: true }) => void) | undefined;

    deleteMock.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveDelete = resolve;
        }) as never,
    );

    const { unmount } = render(
      <ReferenceDocumentDetailPanel canManage={true} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    await confirmVisibleDelete();
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock).toHaveBeenCalledWith(DETAIL_A.id);

    const baselineFetchCount = fetchDetailMock.mock.calls.length;
    const noticesBefore = snapshotNotices();

    act(() => {
      unmount();
    });

    await act(async () => {
      resolveDelete?.({ ok: true });
    });

    // 关键：不得把已离开详情页的用户强制导航回资料列表
    expect(navigateMock).not.toHaveBeenCalled();
    expect(addedNotices(noticesBefore)).toHaveLength(0);
    expect(fetchDetailMock).toHaveBeenCalledTimes(baselineFetchCount);

    await drainReactScheduler();
  });

  it('下载 pending 期间卸载：旧下载成功不提示、不触发浏览器保存', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let resolveDownload: ((value: { ok: true; blob: Blob; filename: string }) => void) | undefined;

    mockDetail();
    downloadFileMock.mockImplementation(
      () =>
        new Promise<{ ok: true; blob: Blob; filename: string }>((resolve) => {
          resolveDownload = resolve;
        }) as never,
    );

    const { unmount } = render(
      <ReferenceDocumentDetailPanel canManage={false} documentId={DETAIL_A.id} />,
    );
    await screen.findByText(DETAIL_A.title);

    fireEvent.click(screen.getByRole('button', { name: /下载文件/ }));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(1));

    const noticesBefore = snapshotNotices();

    act(() => {
      unmount();
    });

    await act(async () => {
      resolveDownload?.({
        ok: true,
        blob: new Blob(['pdf-bytes'], { type: 'application/pdf' }),
        filename: 'a-document.pdf',
      });
    });

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    expect(addedNotices(noticesBefore)).toHaveLength(0);
    expect(navigateMock).not.toHaveBeenCalled();

    clickSpy.mockRestore();

    await drainReactScheduler();
  });

  it('StrictMode 的 effect setup → cleanup → setup 重放不误判失效：首次可交互操作仍正常完成', async () => {
    // 应用入口启用 StrictMode（src/main.tsx），effect 会被 setup → cleanup → setup 重放。
    // 若 cleanup 无条件作废代次，首次挂载后的正常操作也会被当成「旧代次」而静默失效，
    // 本用例钉住这一反向约束（与上面三个卸载失效用例互为对照）。
    mockDetail();
    deleteMock.mockResolvedValue({ ok: true });

    const { unmount } = render(
      <StrictMode>
        <ReferenceDocumentDetailPanel canManage={true} documentId={DETAIL_A.id} />
      </StrictMode>,
    );
    await screen.findByText(DETAIL_A.title);

    // AntD Popconfirm 的开启与删除结果回调由 React 调度器分多跳推进（rc-motion 动画帧 +
    // NormalPriority → setImmediate 的 passive effect flush）。StrictMode 的 effect
    // setup → cleanup → setup 重放会再多一跳，使其中一次 setState 落在 fireEvent / waitFor
    // 各自的 act 边界之外，输出「An update to ForwardRef / ReferenceDocumentDetailPanel
    // was not wrapped in act(...)」（实测仅本用例复现 3 条）。故把整段交互与调度排空收进
    // 同一个异步 act：act 在其整个 await 窗口内保持收集状态，多跳更新都会落在边界内。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删 除' }));
      for (let round = 0; round < 3; round += 1) {
        await waitMacrotask();
      }

      expect(visibleConfirmButtons()).toHaveLength(1);

      fireEvent.click(visibleConfirmButtons()[0]);
      for (let round = 0; round < 3; round += 1) {
        await waitMacrotask();
      }
    });

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock).toHaveBeenCalledWith(DETAIL_A.id);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/reference-documents'));

    // P2-4：本用例是文件内最后一个提交来源，显式卸载（免去 RTL afterEach cleanup 再产生一次
    // 卸载提交）后立即排空调度器，确保文件结束时 React 调度队列为空。
    await act(async () => {
      unmount();
    });
    await drainReactScheduler();
  });
});

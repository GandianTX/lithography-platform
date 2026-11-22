// src/pages/admin-document-database/index.spec.tsx
// @vitest-environment jsdom

/**
 * 文档数据库页 UI 单测（PR3 S3）。
 *
 * 走真实页面装配 + 真实列表/详情状态机，只 mock 两个 feature 的 adapter；
 * 断言口径：四标签独立渲染不串数据、真实统计入卡、标签切换保持各自状态。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as adminFeature from '@/features/admin-document-database';
import {
  type AdminAiConversationListItem,
  type AdminListPage,
  type AdminRepairRequestListItem,
} from '@/features/admin-document-database';
import * as referenceFeature from '@/features/reference-document';
import {
  type ReferenceDocumentListItem,
  type ReferenceDocumentListPage,
} from '@/features/reference-document';

import { AdminDocumentDatabasePage } from './index';

// 页面层只能经 barrel 消费 feature，但 feature 内部组件/hooks 以相对路径
// 直连 adapter 模块——mock barrel 拦不到真实数据调用，因此 mock 落在
// adapter 模块路径上：barrel 再导出同一 mock 实例，断言引用保持一致。
vi.mock(
  '@/features/admin-document-database/infrastructure/admin-document-database-adapter',
  async (importOriginal) => {
    type AdminAdapter =
      typeof import('@/features/admin-document-database/infrastructure/admin-document-database-adapter');
    const actual = await importOriginal<AdminAdapter>();

    return {
      ...actual,
      fetchAdminRepairRequests: vi.fn(),
      fetchAdminAiConversations: vi.fn(),
      fetchAdminAiReports: vi.fn(),
      fetchAdminAiMessages: vi.fn(),
      fetchAdminRepairRequestSummary: vi.fn(),
      fetchAdminEquipmentModelOptions: vi.fn(),
      fetchAdminDocumentDatabaseStats: vi.fn(),
    };
  },
);

vi.mock(
  '@/features/reference-document/infrastructure/reference-document-adapter',
  async (importOriginal) => {
    type ReferenceAdapter =
      typeof import('@/features/reference-document/infrastructure/reference-document-adapter');
    const actual = await importOriginal<ReferenceAdapter>();

    return {
      ...actual,
      fetchReferenceDocuments: vi.fn(),
      fetchReferenceEquipmentModels: vi.fn(),
    };
  },
);

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

const navigateMock = vi.fn();

const fetchStatsMock = vi.mocked(adminFeature.fetchAdminDocumentDatabaseStats);
const fetchRepairMock = vi.mocked(adminFeature.fetchAdminRepairRequests);
const fetchConversationsMock = vi.mocked(adminFeature.fetchAdminAiConversations);
const fetchReportsMock = vi.mocked(adminFeature.fetchAdminAiReports);
const fetchModelOptionsMock = vi.mocked(adminFeature.fetchAdminEquipmentModelOptions);
const fetchReferenceMock = vi.mocked(referenceFeature.fetchReferenceDocuments);
const fetchReferenceModelsMock = vi.mocked(referenceFeature.fetchReferenceEquipmentModels);

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
    closureStatus: null,
    closedAt: null,
    handlingResult: null,
    handlingStatus: null,
    createdAt: '2026-09-01T08:00:00.000Z',
  };
}

function buildConversationItem(id: number): AdminAiConversationListItem {
  return {
    id,
    requestNo: 'RR-20260901-001',
    requestId: 1,
    status: 'COMPLETED',
    engineerNickname: '陈工程师',
    // 版本随记录派生：让多行夹具具备可区分的版本事实，避免固定值掩盖映射错误
    contentVersion: id,
    messageCount: 12,
    reportCount: 1,
    createdAt: '2026-09-02T09:00:00.000Z',
    completedAt: '2026-09-02T10:00:00.000Z',
    aiFeedback: null,
  };
}

function buildPage<T>(items: T[], total = items.length): AdminListPage<T> {
  return { items, total, page: 1, pageSize: 10 };
}

beforeEach(() => {
  fetchStatsMock.mockReset();
  fetchRepairMock.mockReset();
  fetchConversationsMock.mockReset();
  fetchReportsMock.mockReset();
  fetchModelOptionsMock.mockReset();
  fetchReferenceMock.mockReset();
  fetchReferenceModelsMock.mockReset();
  navigateMock.mockReset();

  fetchStatsMock.mockResolvedValue({
    repairRequestTotal: 3,
    referenceDocumentTotal: 5,
    aiConversationTotal: 7,
    aiReportTotal: 9,
  });
  fetchRepairMock.mockResolvedValue(buildPage([buildRepairItem(1), buildRepairItem(2)]));
  fetchConversationsMock.mockResolvedValue(buildPage([buildConversationItem(11)]));
  fetchReportsMock.mockResolvedValue(buildPage([]));
  fetchModelOptionsMock.mockResolvedValue([
    { id: 49, modelCode: 'ASML-TWINSCAN-NXT-1980DI', modelName: 'ASML TWINSCAN NXT:1980Di' },
  ]);
  fetchReferenceMock.mockResolvedValue(
    buildPage<ReferenceDocumentListItem>([]) satisfies ReferenceDocumentListPage,
  );
  fetchReferenceModelsMock.mockResolvedValue([]);
});

describe('AdminDocumentDatabasePage（PR3 S3）', () => {
  it('渲染页头、四类真实统计卡片与四个标签', async () => {
    render(<AdminDocumentDatabasePage />);

    expect(screen.getByRole('heading', { name: '文档数据库' })).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '参考资料' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '维修申请' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'AI 会话' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'AI 报告' })).toBeInTheDocument();
    expect(fetchStatsMock).toHaveBeenCalledTimes(1);
  });

  it('默认渲染参考资料标签（复用 reference-document 列表）', async () => {
    render(<AdminDocumentDatabasePage />);

    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    // 知识库变体：工具区主搜索框即默认标签已装配的证据（卡片标题已按 R7 去除）
    expect(await screen.findByPlaceholderText('按文档标题搜索')).toBeInTheDocument();
  });

  it('任务 07 起页面不再渲染任何新增/写入主操作（旧新增入口已下线）', async () => {
    render(<AdminDocumentDatabasePage />);

    await screen.findByText('维修申请');

    expect(screen.queryByRole('button', { name: /新增资料/ })).not.toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalledWith('/reference-documents/new');

    // 只读标签同样不出现新增/上传操作
    await act(async () => {
      fireEvent.click(await screen.findByRole('tab', { name: 'AI 报告' }));
    });
    expect(screen.queryByRole('button', { name: /新增资料/ })).not.toBeInTheDocument();
  });

  it('切换到维修申请标签加载独立列表，切回不串数据', async () => {
    render(<AdminDocumentDatabasePage />);

    await act(async () => {
      fireEvent.click(await screen.findByRole('tab', { name: '维修申请' }));
    });

    await waitFor(() => {
      expect(fetchRepairMock).toHaveBeenCalled();
    });
    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();

    // 切到 AI 会话：独立请求与数据
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'AI 会话' }));
    });
    await waitFor(() => {
      expect(fetchConversationsMock).toHaveBeenCalled();
    });
    expect(await screen.findByText('陈工程师')).toBeInTheDocument();

    // 切回维修申请：面板保留自身数据（Tabs 卸载保留语义由 hook 重载兜底）
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '维修申请' }));
    });
    expect((await screen.findAllByText('RR-20260901-001')).length).toBeGreaterThan(0);
  });

  // PR3 review S4-02：补齐计划要求的四态中「失败态」在实际 UI 的呈现与恢复
  it('列表加载失败显示错误提示与重试入口，点击重试后恢复数据', async () => {
    // 首笔维修申请取数失败（通用 Error 非 GraphQLIngressError → 命中 hook 兜底文案）；
    // beforeEach 默认 resolve 兜住重试后的第二次取数
    fetchRepairMock.mockRejectedValueOnce(new Error('network down'));
    render(<AdminDocumentDatabasePage />);

    await act(async () => {
      fireEvent.click(await screen.findByRole('tab', { name: '维修申请' }));
    });

    expect(await screen.findByText('维修申请列表加载失败，请稍后重试。')).toBeInTheDocument();
    // AntD 两字按钮会在中间插入全角空格（「重 试」），用正则容忍
    const retryButton = screen.getByRole('button', { name: /重\s*试/ });

    await act(async () => {
      fireEvent.click(retryButton);
    });

    await waitFor(() => expect(screen.getByText('RR-20260901-001')).toBeInTheDocument());
    expect(screen.queryByText('维修申请列表加载失败，请稍后重试。')).not.toBeInTheDocument();
  });

  it('空态：筛选后无命中展示明确的筛选空文案（requirement 3）', async () => {
    // beforeEach 已让 AI 报告返回空页（total 0）；输入筛选词后重载仍空，展示筛选空态。
    render(<AdminDocumentDatabasePage />);

    await act(async () => {
      fireEvent.click(await screen.findByRole('tab', { name: 'AI 报告' }));
    });
    await waitFor(() => expect(fetchReportsMock).toHaveBeenCalled());

    const search = await screen.findByPlaceholderText('按关联申请编号搜索');
    await act(async () => {
      fireEvent.change(search, { target: { value: 'RR-不存在的编号' } });
    });

    // 防抖重载后仍无命中（reports 总返回空页），展示明确的筛选空态文案
    expect(await screen.findByText('没有符合筛选条件的 AI 报告。')).toBeInTheDocument();
    expect(screen.queryByText('AI 报告列表加载失败，请稍后重试。')).not.toBeInTheDocument();
  });

  it('统计加载失败给出可理解提示，且不阻断默认标签列表', async () => {
    fetchStatsMock.mockRejectedValueOnce(new Error('stats down'));
    render(<AdminDocumentDatabasePage />);

    // 统计失败提示可见（带「列表功能不受影响」的口径说明）
    expect(await screen.findByText(/统计加载失败：/)).toBeInTheDocument();
    // 统计失败不影响列表：默认参考资料标签仍完成加载
    expect(await screen.findByPlaceholderText('按文档标题搜索')).toBeInTheDocument();
  });

  // PR3 review M-01：统计失败态必须提供可操作的重试入口（S3 退出条件：加载/空/错误/重试完整）
  it('统计加载失败后可点击重试恢复四项统计数值', async () => {
    fetchStatsMock.mockRejectedValueOnce(new Error('stats down'));
    render(<AdminDocumentDatabasePage />);

    // 失败态：错误提示 + 重试按钮均可见
    expect(await screen.findByText(/统计加载失败：/)).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: /重\s*试/ });

    // 点击重试：beforeEach 默认 resolve 兜住第二次取数 → 统计卡恢复
    await act(async () => {
      fireEvent.click(retryButton);
    });

    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.queryByText(/统计加载失败：/)).not.toBeInTheDocument();
    expect(fetchStatsMock).toHaveBeenCalledTimes(2);
  });
});

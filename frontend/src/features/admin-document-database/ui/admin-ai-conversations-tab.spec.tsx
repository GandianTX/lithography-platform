// src/features/admin-document-database/ui/admin-ai-conversations-tab.spec.tsx
// @vitest-environment jsdom

/**
 * AI 会话 Tab 页面级测试（R3 + R4 + R7 S5）。
 *
 * R3/S5：主搜索在卡内工具区、各状态与表格分页同处 .kb-card 内、
 * 消息详情 Drawer 在卡外；筛选/分页/Drawer 可操作。
 * R4：默认空态「暂无 AI 会话。」、筛选空文案、会话状态枚举是有效筛选、
 * 请求参数与筛选状态一致。
 *
 * 只 mock 本 feature 的 adapter 模块，其余走真实组件与状态机。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminAiConversationDetail,
  AdminAiConversationListItem,
  AdminAiMessageListItem,
  AdminListPage,
} from '../infrastructure/admin-document-database.types';
import {
  exportAdminAiConversationPdf,
  fetchAdminAiConversationDetail,
  fetchAdminAiConversations,
  fetchAdminAiMessages,
} from '../infrastructure/admin-document-database-adapter';

import { AdminAiConversationsTab } from './admin-ai-conversations-tab';

vi.mock('../infrastructure/admin-document-database-adapter', async (importOriginal) => {
  type Adapter = typeof import('../infrastructure/admin-document-database-adapter');
  const actual = await importOriginal<Adapter>();

  return {
    ...actual,
    fetchAdminAiConversations: vi.fn(),
    fetchAdminAiMessages: vi.fn(),
    fetchAdminAiConversationDetail: vi.fn(),
    exportAdminAiConversationPdf: vi.fn(),
  };
});

const fetchConversationsMock = vi.mocked(fetchAdminAiConversations);
const fetchMessagesMock = vi.mocked(fetchAdminAiMessages);
const fetchDetailMock = vi.mocked(fetchAdminAiConversationDetail);
const exportPdfMock = vi.mocked(exportAdminAiConversationPdf);

function buildConversationItem(id: number): AdminAiConversationListItem {
  return {
    id,
    requestNo: `RR-2026090${id}-001`,
    requestId: id,
    status: 'COMPLETED',
    engineerNickname: '陈工程师',
    contentVersion: id,
    messageCount: 12,
    reportCount: 1,
    createdAt: '2026-09-02T09:00:00.000Z',
    completedAt: '2026-09-02T10:00:00.000Z',
    aiFeedback: null,
  };
}

function buildMessageItem(id: number, seq: number): AdminAiMessageListItem {
  return {
    id,
    conversationId: 1,
    messageSeq: seq,
    turnNo: 1,
    role: 'ASSISTANT',
    contentText: `消息正文 ${seq}`,
    contentVersion: 1,
    analysisStatus: 'SUCCEEDED',
    failureReason: null,
    createdAt: '2026-09-02T09:05:00.000Z',
  };
}

function buildConversationDetail(): AdminAiConversationDetail {
  return {
    conversationId: 1,
    requestId: 1,
    requestNo: 'RR-20260901-001',
    status: 'COMPLETED',
    contentVersion: 3,
    engineerNickname: '陈工程师',
    createdAt: '2026-09-02T09:00:00.000Z',
    turns: [
      {
        questionUuid: 'uuid-1',
        turnNo: 1,
        analysisStatus: 'FAILED',
        failureReason: '模型调用超时',
        analysisContentVersion: 3,
        question: {
          messageId: 101,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          questionUuid: 'uuid-1',
          text: '曝光异常如何排查',
          contentVersion: 3,
          createdAt: '2026-09-02T09:01:00.000Z',
        },
        answer: null,
      },
    ],
  };
}

function buildPage<T>(items: T[], total = items.length, page = 1): AdminListPage<T> {
  return { items, total, page, pageSize: 10 };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  fetchConversationsMock.mockReset();
  fetchMessagesMock.mockReset();
  fetchDetailMock.mockReset();

  fetchConversationsMock.mockResolvedValue(buildPage([buildConversationItem(1)]));
  fetchMessagesMock.mockResolvedValue(buildPage([buildMessageItem(101, 1)]));
  fetchDetailMock.mockResolvedValue(buildConversationDetail());
});

describe('AdminAiConversationsTab（R3/R7 S5 知识库卡容器）', () => {
  it('主搜索在卡内工具区，loading 骨架在同一知识库卡内', async () => {
    const { container } = render(<AdminAiConversationsTab />);

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

  it('有数据：表格与卡底分页在知识库卡内，消息详情 Drawer 在卡外且可打开', async () => {
    const { container } = render(<AdminAiConversationsTab />);

    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();
    expect(screen.getByText('陈工程师')).toBeInTheDocument();
    const card = container.querySelector('.kb-card');
    expect(card?.querySelector('.kb-table-scope table')).not.toBeNull();
    expect(card?.querySelector('.kb-card-footer .ant-pagination')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '消息详情' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText('消息正文 1')).toBeInTheDocument();
    expect(fetchMessagesMock).toHaveBeenCalledWith(1, 1, 50);
    expect(container.querySelector('.kb-card .ant-drawer')).toBeNull();
  });

  it('加载失败：错误告警在知识库卡内呈现，重试可恢复数据', async () => {
    fetchConversationsMock.mockRejectedValueOnce(new Error('network down'));
    const { container } = render(<AdminAiConversationsTab />);

    expect(await screen.findByText('AI 会话列表加载失败，请稍后重试。')).toBeInTheDocument();
    expect(container.querySelector('.kb-card .kb-card-state .ant-alert-error')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();
  });
});

describe('AdminAiConversationsTab（R4 有效筛选单一真源）', () => {
  it('默认空（无筛选）：显示「暂无 AI 会话。」而非筛选空文案，请求参数为空对象', async () => {
    fetchConversationsMock.mockResolvedValue(buildPage([]));
    render(<AdminAiConversationsTab />);

    expect(await screen.findByText('暂无 AI 会话。')).toBeInTheDocument();
    expect(screen.queryByText('没有符合筛选条件的 AI 会话。')).toBeNull();
    expect(fetchConversationsMock).toHaveBeenCalledWith(1, 10, {});
  });

  it('真实筛选无结果：展开筛选后显示筛选空文案，请求变量保留筛选字段', async () => {
    fetchConversationsMock.mockResolvedValue(buildPage([]));
    render(<AdminAiConversationsTab />);
    await waitFor(() => expect(fetchConversationsMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.change(screen.getByPlaceholderText('按工程师昵称/公司搜索'), {
      target: { value: '陈' },
    });

    await waitFor(() => expect(fetchConversationsMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(fetchConversationsMock).toHaveBeenLastCalledWith(1, 10, { engineerKeyword: '陈' });
    expect(await screen.findByText('没有符合筛选条件的 AI 会话。')).toBeInTheDocument();
  });

  it('会话状态枚举是有效筛选，请求变量保留 status', async () => {
    fetchConversationsMock.mockResolvedValue(buildPage([]));
    render(<AdminAiConversationsTab />);
    await waitFor(() => expect(fetchConversationsMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.mouseDown(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByText('已完成'));

    await waitFor(() => expect(fetchConversationsMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(fetchConversationsMock).toHaveBeenLastCalledWith(1, 10, { status: 'COMPLETED' });
    expect(await screen.findByText('没有符合筛选条件的 AI 会话。')).toBeInTheDocument();
  });

  it('筛选入口可展开/收起，重置清空全部条件回到空请求参数', async () => {
    fetchConversationsMock.mockResolvedValue(buildPage([]));
    render(<AdminAiConversationsTab />);
    await waitFor(() => expect(fetchConversationsMock).toHaveBeenCalledTimes(1));

    const filterButton = screen.getByRole('button', { name: '筛选' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(filterButton);
    expect(filterButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.change(screen.getByPlaceholderText('按工程师昵称/公司搜索'), {
      target: { value: '陈' },
    });
    await waitFor(() => expect(fetchConversationsMock).toHaveBeenCalledTimes(2), { timeout: 2000 });

    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(fetchConversationsMock).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(fetchConversationsMock).toHaveBeenLastCalledWith(1, 10, {});
    expect(await screen.findByText('暂无 AI 会话。')).toBeInTheDocument();
  });

  it('分页可操作：翻页请求回带 page=2', async () => {
    fetchConversationsMock.mockResolvedValueOnce(buildPage([buildConversationItem(1)], 25, 1));
    fetchConversationsMock.mockResolvedValueOnce(buildPage([buildConversationItem(5)], 25, 2));
    const { container } = render(<AdminAiConversationsTab />);
    await screen.findByText('RR-20260901-001');

    const secondPage = container.querySelector('.ant-pagination-item-2 a');
    expect(secondPage).not.toBeNull();
    fireEvent.click(secondPage as HTMLElement);

    await waitFor(() => expect(fetchConversationsMock).toHaveBeenCalledTimes(2));
    expect(fetchConversationsMock).toHaveBeenLastCalledWith(2, 10, {});
    expect(await screen.findByText('RR-20260905-001')).toBeInTheDocument();
  });
});

describe('管理员只读问答弹窗（任务 05 · S4.1 · R038-01）', () => {
  it('点击「查看问答」打开只读弹窗，展示逐轮问答与失败原因', async () => {
    render(<AdminAiConversationsTab />);

    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看问答' }));

    expect(await screen.findByText('会话问答（只读）')).toBeInTheDocument();
    expect(await screen.findByText('曝光异常如何排查')).toBeInTheDocument();
    expect(await screen.findByText('模型调用超时')).toBeInTheDocument();
    expect(await screen.findByText('（未保存回答）')).toBeInTheDocument();
    expect(fetchDetailMock).toHaveBeenCalledWith(1);
  });

  it('只读弹窗不提供提问入口', async () => {
    render(<AdminAiConversationsTab />);

    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看问答' }));

    expect(await screen.findByText('会话问答（只读）')).toBeInTheDocument();
    // 弹窗内不提供任何可编辑输入与提交入口（只读）
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('textarea')).toBeNull();
    expect(dialog.querySelector('input')).toBeNull();
    // 抽屉自带的关闭/重试按钮之外，不提供任何提问或提交入口
    expect(screen.queryByRole('button', { name: /提交|发送|提问|重试本轮/ })).toBeNull();
  });

  it('直传外公司会话被拒绝时提示失败，不展示外公司内容', async () => {
    fetchDetailMock.mockRejectedValue(new Error('会话不存在或无权访问'));
    render(<AdminAiConversationsTab />);

    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看问答' }));

    expect(await screen.findByText('会话详情加载失败，请稍后重试。')).toBeInTheDocument();
    expect(screen.queryByText('曝光异常如何排查')).toBeNull();
  });
});

describe('管理员导出固定版本 PDF（任务 05 · S4.2 · R039-01）', () => {
  it('点击导出按列表记录的内容版本生成文件并提示版本与截止点', async () => {
    exportPdfMock.mockResolvedValue({
      contentBase64: btoa('%PDF-mock'),
      contentVersion: 3,
      filename: 'ai-conversation-1-v3.pdf',
      lastMessageSeq: 6,
      mimeType: 'application/pdf',
    });

    render(<AdminAiConversationsTab />);
    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }));

    expect(await screen.findByText(/已导出 ai-conversation-1-v3\.pdf/)).toBeInTheDocument();
    expect(exportPdfMock).toHaveBeenCalledWith({ contentVersion: 1, conversationId: 1 });
  });

  it('导出失败时给出错误提示', async () => {
    exportPdfMock.mockRejectedValue(new Error('export failed'));

    render(<AdminAiConversationsTab />);
    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }));

    expect(await screen.findByText('导出失败，请稍后重试。')).toBeInTheDocument();
  });

  it('页面不提供受控原始 JSON 导出入口', async () => {
    render(<AdminAiConversationsTab />);
    expect(await screen.findByText('RR-20260901-001')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /JSON/i })).toBeNull();
  });
});

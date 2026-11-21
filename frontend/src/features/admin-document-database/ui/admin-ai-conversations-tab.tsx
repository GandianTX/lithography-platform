// src/features/admin-document-database/ui/admin-ai-conversations-tab.tsx

import { useCallback, useMemo, useState } from 'react';
import type { TableColumnsType } from 'antd';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Pagination,
  Select,
  Skeleton,
  Table,
  Tag,
} from 'antd';

import { base64ToBlob, saveBlobAsFile } from '@/shared/download';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { KbSearchField, KbToolbarButton } from '@/shared/ui/knowledge-base';
import { StatusPill } from '@/shared/ui/status-pill';

import {
  useAdminAiConversationDetail,
  useAdminAiConversationMessages,
} from '../application/use-admin-document-detail';
import { useAdminDocumentList } from '../application/use-admin-document-list';
import { useDebouncedValue } from '../application/use-debounced-value';
import type {
  AdminAiConversationDetail,
  AdminAiConversationFilter,
  AdminAiConversationListItem,
  AdminAiMessageAnalysisStatus,
  AdminAiMessageListItem,
} from '../infrastructure/admin-document-database.types';
import {
  exportAdminAiConversationPdf,
  fetchAdminAiConversations,
} from '../infrastructure/admin-document-database-adapter';

import { AdminCreatedAtFilter } from './admin-created-at-filter';
import { type AdminCreatedAtRangeState, toAdminCreatedAtRange } from './admin-created-at-range';
import { toEffectiveAdminFilter } from './admin-effective-filter';
import { AdminListStates } from './admin-list-states';

const CONVERSATION_STATUS_LABELS: Record<AdminAiConversationListItem['status'], string> = {
  ACTIVE: '进行中',
  COMPLETED: '已完成',
};

const MESSAGE_ROLE_LABELS: Record<AdminAiMessageListItem['role'], string> = {
  USER: '工程师',
  ASSISTANT: 'AI 助手',
  SYSTEM: '系统',
  TOOL: '工具',
};

const MESSAGE_ROLE_TAG_COLORS: Record<AdminAiMessageListItem['role'], string> = {
  USER: 'blue',
  ASSISTANT: 'green',
  SYSTEM: 'default',
  TOOL: 'orange',
};

const ANALYSIS_STATUS_LABELS: Record<AdminAiMessageAnalysisStatus, string> = {
  PENDING: '待执行',
  RUNNING: '生成中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
};

const ANALYSIS_STATUS_TAG_COLORS: Record<AdminAiMessageAnalysisStatus, string> = {
  PENDING: 'gold',
  RUNNING: 'blue',
  SUCCEEDED: 'green',
  FAILED: 'red',
};

/** AI 会话标签：全局会话列表 + 消息详情 Drawer（服务端按 messageSeq ASC + id ASC 稳定排序）
 *
 * PR3 R7 S5：迁入单张知识库卡（卡内工具区 + 主搜索 + 筛选展开区 + 紧凑表格 +
 * 卡底分页）；会话状态等精确条件收进「筛选」展开区，能力不减。 */
export function AdminAiConversationsTab() {
  const [requestNoKeyword, setRequestNoKeyword] = useState('');
  const [engineerKeyword, setEngineerKeyword] = useState('');
  const [status, setStatus] = useState<AdminAiConversationListItem['status'] | undefined>(
    undefined,
  );
  const [createdAtRange, setCreatedAtRange] = useState<AdminCreatedAtRangeState>(null);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [messagesConversationId, setMessagesConversationId] = useState<number | null>(null);
  const [messagesPage, setMessagesPage] = useState(1);
  const [qaConversationId, setQaConversationId] = useState<number | null>(null);
  const [exportingId, setExportingId] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const debouncedRequestNo = useDebouncedValue(requestNoKeyword.trim());
  const debouncedEngineer = useDebouncedValue(engineerKeyword.trim());
  const timeFilter = toAdminCreatedAtRange(createdAtRange);

  // R4 有效筛选单一真源：请求参数、reloadKey、hasActiveFilter 从同一份对象派生
  const effectiveFilter = useMemo(
    () =>
      toEffectiveAdminFilter<AdminAiConversationFilter>({
        requestNo: debouncedRequestNo,
        engineerKeyword: debouncedEngineer,
        status,
        ...timeFilter,
      }),
    [debouncedRequestNo, debouncedEngineer, status, timeFilter],
  );
  // 筛选变化触发回第 1 页；请求序号竞态防护在列表 hook 内
  const reloadKey = JSON.stringify(effectiveFilter);
  const hasActiveFilter = Object.keys(effectiveFilter).length > 0;

  /**
   * 导出会话 PDF（任务 05 · S4.2 · R039-01）。
   *
   * 管理员只有读取与授权导出的能力；导出按服务端固定的内容版本生成，
   * 导出期间追加的消息不混入。受控原始 JSON 不在此提供入口。
   */
  const handleExportPdf = useCallback(async (record: AdminAiConversationListItem) => {
    setExportingId(record.id);
    setExportError(null);
    setExportNotice(null);

    try {
      const result = await exportAdminAiConversationPdf({
        contentVersion: record.contentVersion,
        conversationId: record.id,
      });
      saveBlobAsFile(base64ToBlob(result.contentBase64, result.mimeType), result.filename);
      setExportNotice(
        `已导出 ${result.filename}（内容版本 v${result.contentVersion}，消息截止 #${result.lastMessageSeq}）`,
      );
    } catch {
      setExportError('导出失败，请稍后重试。');
    } finally {
      setExportingId(null);
    }
  }, []);

  const resetFilters = () => {
    setRequestNoKeyword('');
    setEngineerKeyword('');
    setStatus(undefined);
    setCreatedAtRange(null);
  };

  const fetcher = useMemo(
    () => (page: number, pageSize: number) =>
      fetchAdminAiConversations(page, pageSize, effectiveFilter),
    [effectiveFilter],
  );

  const { state, goToPage, reload } = useAdminDocumentList<AdminAiConversationListItem>(
    fetcher,
    reloadKey,
    { failureMessage: 'AI 会话列表加载失败，请稍后重试。' },
  );
  const messages = useAdminAiConversationMessages(messagesConversationId, messagesPage);
  const qaDetail = useAdminAiConversationDetail(qaConversationId);

  // 紧凑列宽：scroll.x 由 1180 收紧到 856，两个验收视口下无需表格内部横滚（视觉报告 3.5）
  const columns = useMemo<TableColumnsType<AdminAiConversationListItem>>(
    () => [
      { dataIndex: 'requestNo', key: 'requestNo', title: '关联申请', width: 136 },
      { dataIndex: 'engineerNickname', key: 'engineerNickname', title: '工程师', width: 92 },
      {
        dataIndex: 'status',
        key: 'status',
        render: (value: AdminAiConversationListItem['status']) => (
          <StatusPill tone={value === 'ACTIVE' ? 'ok' : 'neutral'}>
            {CONVERSATION_STATUS_LABELS[value]}
          </StatusPill>
        ),
        title: '会话状态',
        width: 92,
      },
      { dataIndex: 'messageCount', key: 'messageCount', title: '消息数', width: 80 },
      { dataIndex: 'reportCount', key: 'reportCount', title: '报告数', width: 80 },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (value: string) => formatDateTimeText(value),
        title: '创建时间',
        width: 140,
      },
      {
        dataIndex: 'completedAt',
        key: 'completedAt',
        render: (value: string | null) => (value ? formatDateTimeText(value) : '—'),
        title: '完成时间',
        width: 140,
      },
      {
        key: 'actions',
        render: (_value, record) => (
          <div className="flex items-center gap-1">
            <Button
              onClick={() => {
                setMessagesPage(1);
                setMessagesConversationId(record.id);
              }}
              size="small"
              type="link"
            >
              消息详情
            </Button>
            <Button
              onClick={() => {
                setQaConversationId(record.id);
              }}
              size="small"
              type="link"
            >
              查看问答
            </Button>
            <Button
              disabled={exportingId !== null}
              loading={exportingId === record.id}
              onClick={() => {
                void handleExportPdf(record);
              }}
              size="small"
              type="link"
            >
              导出 PDF
            </Button>
          </div>
        ),
        title: '操作',
        width: 236,
      },
    ],
    [exportingId, handleExportPdf],
  );

  return (
    <div className="kb-card">
      {exportError !== null ? (
        <Alert
          closable
          onClose={() => setExportError(null)}
          showIcon
          title={exportError}
          type="error"
        />
      ) : null}
      {exportNotice !== null ? (
        <Alert
          closable
          onClose={() => setExportNotice(null)}
          showIcon
          title={exportNotice}
          type="success"
        />
      ) : null}
      {/* 卡内工具区（PR3 R7 S5）：主搜索 + 筛选入口；会话状态/工程师/时间收进展开区 */}
      <div className="kb-toolbar">
        <KbSearchField
          clearLabel="清除关联申请编号搜索"
          onChange={setRequestNoKeyword}
          placeholder="按关联申请编号搜索"
          value={requestNoKeyword}
        />
        <KbToolbarButton
          active={hasActiveFilter}
          aria-expanded={filterPanelOpen}
          onClick={() => setFilterPanelOpen((previous) => !previous)}
        >
          筛选
        </KbToolbarButton>
      </div>

      {filterPanelOpen ? (
        <div className="kb-filter-panel">
          <Input
            allowClear
            maxLength={100}
            placeholder="按工程师昵称/公司搜索"
            style={{ width: 200 }}
            value={engineerKeyword}
            onChange={(event) => setEngineerKeyword(event.target.value)}
          />
          <Select
            allowClear
            placeholder="会话状态"
            style={{ width: 130 }}
            value={status}
            onChange={(value) => setStatus(value)}
            options={Object.entries(CONVERSATION_STATUS_LABELS).map(([value, label]) => ({
              label,
              value,
            }))}
          />
          <AdminCreatedAtFilter onChange={setCreatedAtRange} value={createdAtRange} />
          <KbToolbarButton onClick={resetFilters}>重置</KbToolbarButton>
        </div>
      ) : null}

      <AdminListStates
        emptyLabel="暂无 AI 会话。"
        filteredEmptyLabel="没有符合筛选条件的 AI 会话。"
        hasActiveFilter={hasActiveFilter}
        onRetry={reload}
        state={state}
        variant="knowledge-base"
      >
        {state.status === 'ready' && state.total > 0 ? (
          <>
            <div className="kb-table-scope">
              <Table<AdminAiConversationListItem>
                columns={columns}
                dataSource={state.items}
                pagination={false}
                rowKey="id"
                scroll={{ x: 856 }}
              />
            </div>
            <div className="kb-card-footer">
              <span>共 {state.total} 条</span>
              <Pagination
                current={state.page}
                onChange={goToPage}
                pageSize={state.pageSize}
                showSizeChanger={false}
                size="small"
                total={state.total}
              />
            </div>
          </>
        ) : null}
      </AdminListStates>

      <Drawer
        destroyOnHidden
        onClose={() => setMessagesConversationId(null)}
        open={messagesConversationId !== null}
        title="会话消息详情"
        size="large"
      >
        {messages.state.status === 'loading' ? <Skeleton active /> : null}
        {messages.state.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={messages.retry} size="small">
                重试
              </Button>
            }
            title={messages.state.message}
            showIcon
            type="error"
          />
        ) : null}
        {messages.state.status === 'ready' && messages.state.detail.total === 0 ? (
          <Empty description="该会话暂无消息。" />
        ) : null}
        {messages.state.status === 'ready' && messages.state.detail.total > 0 ? (
          <div className="flex flex-col gap-4">
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {messages.state.detail.items.map((message) => (
                <li
                  className="rounded border border-[var(--panel-border)] bg-[var(--filter-bar-bg)] p-3"
                  key={message.id}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <Tag color={MESSAGE_ROLE_TAG_COLORS[message.role]}>
                      {MESSAGE_ROLE_LABELS[message.role]}
                    </Tag>
                    <span className="text-xs text-[var(--text-muted)]">
                      {message.turnNo !== null ? `第 ${message.turnNo} 轮 · ` : ''}
                      序号 {message.messageSeq} · {formatDateTimeText(message.createdAt)}
                    </span>
                  </div>
                  <p className="m-0 text-sm whitespace-pre-wrap">{message.contentText}</p>
                </li>
              ))}
            </ol>
            <div className="flex justify-end">
              <Pagination
                current={messages.state.detail.page}
                onChange={(page) => setMessagesPage(page)}
                pageSize={messages.state.detail.pageSize}
                showSizeChanger={false}
                showTotal={(total) => `共 ${total} 条`}
                total={messages.state.detail.total}
              />
            </div>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        destroyOnHidden
        onClose={() => setQaConversationId(null)}
        open={qaConversationId !== null}
        title="会话问答（只读）"
        size="large"
      >
        {qaDetail.state.status === 'loading' ? <Skeleton active /> : null}
        {qaDetail.state.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={qaDetail.retry} size="small">
                重试
              </Button>
            }
            message={qaDetail.state.message}
            showIcon
            type="error"
          />
        ) : null}
        {qaDetail.state.status === 'ready' ? (
          <AdminAiQaDetail detail={qaDetail.state.detail} />
        ) : null}
      </Drawer>
    </div>
  );
}

/**
 * 管理员只读问答视图（任务 05 · S4.1 · R038-01）。
 *
 * 只读展示：问题、回答、轮次状态与失败原因；不提供提问、重试或编辑入口。
 */
function AdminAiQaDetail({ detail }: { detail: AdminAiConversationDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
        <span>关联申请：{detail.requestNo}</span>
        <span>工程师：{detail.engineerNickname}</span>
        <span>内容版本：v{detail.contentVersion}</span>
        <span>创建时间：{formatDateTimeText(detail.createdAt)}</span>
      </div>
      {detail.turns.length === 0 ? (
        <Empty description="该会话暂无问答轮次。" />
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {detail.turns.map((turn) => (
            <li
              className="rounded border border-[var(--panel-border)] bg-[var(--filter-bar-bg)] p-3"
              key={turn.questionUuid}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-[var(--text-muted)]">
                  第 {turn.turnNo ?? '-'} 轮
                </span>
                {turn.analysisStatus !== null ? (
                  <Tag color={ANALYSIS_STATUS_TAG_COLORS[turn.analysisStatus]}>
                    {ANALYSIS_STATUS_LABELS[turn.analysisStatus]}
                  </Tag>
                ) : null}
                {turn.failureReason !== null ? (
                  <span className="text-xs text-[var(--text-muted)]">{turn.failureReason}</span>
                ) : null}
              </div>
              <p className="m-0 mb-2 text-sm whitespace-pre-wrap">
                <span className="mr-2 text-xs text-[var(--text-muted)]">提问</span>
                {turn.question?.text ?? '—'}
              </p>
              <p className="m-0 text-sm whitespace-pre-wrap">
                <span className="mr-2 text-xs text-[var(--text-muted)]">回答</span>
                {turn.answer?.text ?? '（未保存回答）'}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

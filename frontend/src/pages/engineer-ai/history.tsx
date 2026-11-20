// src/pages/engineer-ai/history.tsx

import { useMemo } from 'react';
import { Button, Empty, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useNavigate } from 'react-router';

import type { AiConversationListItem } from '@/features/ai-conversation';
import { useAiDiagnosisWorkspace } from '@/features/ai-conversation';

import { useI18n } from '@/shared/i18n';

/** 本人问答记录：只读列表，来源固定、可回到对应会话继续查看 */
export function EngineerAiHistoryPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const workspace = useAiDiagnosisWorkspace();
  const { conversations, conversationsTotal, loading, loadingMore } = workspace;

  const columns = useMemo<ColumnsType<AiConversationListItem>>(
    () => [
      {
        dataIndex: 'requestId',
        render: (_value, record) =>
          record.requestId === null ? (
            <Tag>{t('ai.record.source.standalone')}</Tag>
          ) : (
            <Tag color="blue">{t('ai.record.source.workOrder')}</Tag>
          ),
        title: t('ai.record.column.source'),
        width: 120,
      },
      {
        dataIndex: 'requestNo',
        ellipsis: true,
        render: (value: string) => value || '—',
        title: t('ai.record.column.requestNo'),
        width: 200,
      },
      {
        dataIndex: 'messageCount',
        title: t('ai.record.column.messages'),
        width: 96,
      },
      {
        dataIndex: 'status',
        render: (value: AiConversationListItem['status']) => (
          <Tag color={value === 'COMPLETED' ? 'green' : 'processing'}>
            {t(`ai.record.status.${value}`)}
          </Tag>
        ),
        title: t('ai.record.column.status'),
        width: 110,
      },
      {
        dataIndex: 'createdAt',
        render: (value: string) => (value ? formatDateTime(value) : '—'),
        title: t('ai.record.column.createdAt'),
        width: 180,
      },
      {
        dataIndex: 'lastMessageAt',
        render: (value: string | null) => (value === null ? '—' : formatDateTime(value)),
        title: t('ai.record.column.lastMessageAt'),
        width: 180,
      },
      {
        dataIndex: 'id',
        render: (_value, record) => (
          <Button
            onClick={() => navigate(`/engineer/ai?conversation=${record.id}`)}
            size="small"
            type="link"
          >
            {t('ai.record.open')}
          </Button>
        ),
        title: t('ai.record.open'),
        width: 110,
      },
    ],
    [navigate, t],
  );

  const total = conversationsTotal;
  const loadedSummary =
    total === null
      ? null
      : t('ai.record.loadedSummary', { loaded: conversations.length, total: String(total) });

  return (
    <div className="ai-shell">
      <header className="ai-shell-header">
        <h1 className="ai-shell-title">{t('ai.shell.title')}</h1>
        <nav aria-label={t('ai.shell.navLabel')} className="ai-shell-nav">
          <Link className="ai-shell-tab" to="/engineer/ai">
            {t('ai.shell.navChat')}
          </Link>
          <Link aria-current="page" className="ai-shell-tab" to="/engineer/ai/history">
            {t('ai.shell.navHistory')}
          </Link>
        </nav>
      </header>

      <section aria-label={t('ai.record.title')} className="ai-record">
        <div className="ai-record-header">
          <div>
            <h2 className="ai-shell-title">{t('ai.record.title')}</h2>
            <p className="ai-record-subtitle">{t('ai.record.subtitle')}</p>
          </div>
          <Link className="ai-record-back" to="/engineer/ai">
            {t('ai.shell.backToChat')}
          </Link>
        </div>

        {workspace.errorMessage !== null ? (
          <div className="ai-compose-alert" role="alert">
            {workspace.errorMessage}
            <Button
              disabled={loading}
              onClick={() => void workspace.loadConversations()}
              size="small"
              type="link"
            >
              {t('ai.record.retry')}
            </Button>
          </div>
        ) : null}

        <Spin spinning={loading}>
          {conversations.length === 0 && !loading ? (
            <Empty description={t('ai.record.empty')} />
          ) : (
            <Table<AiConversationListItem>
              columns={columns}
              dataSource={conversations}
              pagination={false}
              rowKey="id"
              size="small"
            />
          )}
        </Spin>

        <div className="ai-record-footer">
          {loadedSummary === null ? null : (
            <span className="ai-record-summary">{loadedSummary}</span>
          )}
          {total === null || conversations.length < total ? (
            <Button
              disabled={loading || loadingMore || conversations.length === 0}
              loading={loadingMore}
              onClick={() => void workspace.loadMoreConversations()}
              size="small"
            >
              {t('ai.record.loadMore')}
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  // 跟随浏览器/界面语言，避免英文界面出现中文日期格式
  return date.toLocaleString(undefined, { hour12: false });
}

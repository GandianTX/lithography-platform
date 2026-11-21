// src/features/ai-conversation/ui/ai-history-drawer.tsx
// 历史会话抽屉（任务 05 · S3）
//
// 只列本人有权会话（S1 契约 myAiConversations）；点击切换会话由页面负责。
// F08：分页与空态必须可区分「没有记录」与「当前页为空」。
// F09：列表项是可聚焦的 button（Enter/Space 可切换会话），不是只能鼠标点击的 div。

import { Button, Drawer, Empty, List, Tag } from 'antd';

import { useI18n } from '@/shared/i18n';

import type { AiConversationListItem } from '../infrastructure/ai-conversation.types';

export type AiHistoryDrawerProps = {
  readonly open: boolean;
  readonly conversations: readonly AiConversationListItem[];
  readonly selectedId: number | null;
  readonly loading: boolean;
  readonly total: number;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: () => void;
  readonly onClose: () => void;
  readonly onSelect: (conversationId: number) => void;
};

export function AiHistoryDrawer({
  conversations,
  loading,
  loadingMore = false,
  onClose,
  onLoadMore,
  onSelect,
  open,
  selectedId,
  total,
}: AiHistoryDrawerProps) {
  const { t } = useI18n();
  const hasMore = conversations.length < total;

  return (
    <Drawer
      onClose={onClose}
      open={open}
      placement="left"
      title={t('ai.history.title')}
      width={360}
    >
      {conversations.length === 0 ? (
        <Empty
          description={
            loading
              ? t('ai.history.loading')
              : total > 0
                ? t('ai.history.emptyPage')
                : t('ai.history.empty')
          }
        />
      ) : (
        <List
          dataSource={[...conversations]}
          loading={loading}
          renderItem={(item) => (
            <List.Item
              style={
                item.id === selectedId
                  ? { background: 'var(--activity-item-active-bg)' }
                  : undefined
              }
            >
              <button
                aria-current={item.id === selectedId ? 'true' : undefined}
                className="w-full cursor-pointer rounded-card px-2 text-left hover:bg-fill-secondary"
                onClick={() => onSelect(item.id)}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-text-primary">#{item.id}</div>
                    <div className="truncate text-xs text-text-secondary">
                      {`${item.requestNo || t('ai.history.standalone')} · ${t('ai.panel.turnCount', { count: String(item.turnCount) })} · v${item.contentVersion}`}
                    </div>
                  </div>
                  <Tag color={item.status === 'ACTIVE' ? 'blue' : 'default'}>{item.status}</Tag>
                </div>
              </button>
            </List.Item>
          )}
        />
      )}

      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-text-secondary">
        <span>
          {t('ai.history.loadedSummary')
            .replace('{loaded}', String(conversations.length))
            .replace('{total}', String(total))}
        </span>
        {hasMore && onLoadMore !== undefined ? (
          <Button loading={loadingMore} onClick={onLoadMore} size="small" type="link">
            {t('ai.history.loadMore')}
          </Button>
        ) : null}
      </div>
    </Drawer>
  );
}

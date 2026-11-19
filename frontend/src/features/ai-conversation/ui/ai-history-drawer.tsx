// src/features/ai-conversation/ui/ai-history-drawer.tsx
// 历史会话抽屉（任务 05 · S3）
//
// 只列本人有权会话（S1 契约 myAiConversations）；点击切换会话由页面负责。

import { Drawer, Empty, List, Tag } from 'antd';

import { useI18n } from '@/shared/i18n';

import type { AiConversationListItem } from '../infrastructure/ai-conversation.types';

export type AiHistoryDrawerProps = {
  readonly open: boolean;
  readonly conversations: readonly AiConversationListItem[];
  readonly selectedId: number | null;
  readonly loading: boolean;
  readonly onClose: () => void;
  readonly onSelect: (conversationId: number) => void;
};

export function AiHistoryDrawer({
  conversations,
  loading,
  onClose,
  onSelect,
  open,
  selectedId,
}: AiHistoryDrawerProps) {
  const { t } = useI18n();

  return (
    <Drawer
      onClose={onClose}
      open={open}
      placement="left"
      title={t('ai.history.title')}
      width={360}
    >
      {conversations.length === 0 ? (
        <Empty description={t('ai.history.empty')} />
      ) : (
        <List
          dataSource={[...conversations]}
          loading={loading}
          renderItem={(item) => (
            <div
              className="cursor-pointer rounded-card px-2 hover:bg-fill-secondary"
              onClick={() => onSelect(item.id)}
              style={
                item.id === selectedId ? { background: 'var(--activity-item-active-bg)' } : undefined
              }
            >
              <List.Item>
                <List.Item.Meta
                  description={`${item.requestNo || t('ai.history.standalone')} · ${
                    item.messageCount
                  } · v${item.contentVersion}`}
                  title={`#${item.id}`}
                />
                <Tag color={item.status === 'ACTIVE' ? 'blue' : 'default'}>{item.status}</Tag>
              </List.Item>
            </div>
          )}
        />
      )}
    </Drawer>
  );
}

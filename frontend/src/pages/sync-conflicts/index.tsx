// src/pages/sync-conflicts/index.tsx

import { useState } from 'react';
import { Drawer } from 'antd';

import { SyncConflictDetailPanel, SyncConflictList } from '@/features/sync-conflict';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 同步冲突页（任务 09 S2.3）。
 *
 * - 清单只展示摘要（不拉正文快照），点"查看差异"再按需取详情；
 * - 裁决动作在详情面板内完成，动作可用性由服务端事实决定（只读内容不给恢复入口）；
 * - 路由 /engineer/sync-conflicts 复用 protectedRouteLoader；数据范围由服务端按
 *   Session 裁决，前端不做公司过滤。
 */
export function SyncConflictsPage() {
  const { t } = useI18n();
  const [activeConflictId, setActiveConflictId] = useState<string | null>(null);

  return (
    <div className="page-stack">
      <PageHeader
        description={t('syncConflict.description')}
        eyebrow={t('syncConflict.eyebrow')}
        title={t('syncConflict.title')}
      />
      <SyncConflictList onOpen={(conflictId: string) => setActiveConflictId(conflictId)} />
      <Drawer
        destroyOnClose
        onClose={() => setActiveConflictId(null)}
        open={activeConflictId !== null}
        title={t('syncConflict.detail.title')}
        // antd v6 起 `width` 属废弃属性（运行期会打弃用告警）：改用 `size` 传同一宽度
        size={720}
      >
        {activeConflictId === null ? null : (
          <SyncConflictDetailPanel conflictId={activeConflictId} />
        )}
      </Drawer>
    </div>
  );
}

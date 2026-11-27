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
        // 不开 `destroyOnClose`：抽屉内容本来��由 `activeConflictId === null` 条件控制，
        // 不开 `destroyOnClose`：抽屉内容本来由 `activeConflictId === null` 条件控制，
        // 关闭即卸载详情面板（无残留、无重复请求）。
        // 而 `destroyOnClose` 会在**关闭动画期间**销毁子树，使 antd 在打开时捕获的
        // 触发元素引用失效 ⇒ 取消后焦点落到 body 而非返回「查看差异」按钮
        // （任务书《前端布局与视觉验收》要求"取消后焦点返回触发控件"；实测 700ms 内关闭必现）。
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

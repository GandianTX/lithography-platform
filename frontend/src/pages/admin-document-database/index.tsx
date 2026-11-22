// src/pages/admin-document-database/index.tsx

import { useState } from 'react';
import { Alert, Button, Skeleton, Tabs } from 'antd';

import {
  AdminAiConversationsTab,
  AdminAiReportsTab,
  AdminRepairRequestsTab,
  useAdminDocumentStats,
} from '@/features/admin-document-database';
import { ReferenceDocumentList } from '@/features/reference-document';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 文档数据库页（PR3 S3）：页头四类真实统计 + 四标签。
 *
 * - 路由治理复用 protectedRouteLoader 与 /admin/** 角色策略
 * *（SUPER_ADMIN 放行，ENGINEER/CUSTOMER 按角色路径表拒绝）；
 * - 四个标签各自实例化独立的列表 hook（筛选/分页/加载状态互不共享），
 *   Tabs 默认懒挂载、已挂载标签卸载保留，切换不串数据；
 * - 参考资料标签复用 features/reference-document 的公开列表组件（筛选/分页/四态），
 *   不制造平行功能；任务 07 起该标签只读，不再提供「新增资料」入口；
 * - 维修申请标签复用任务 04 的工单读侧；AI 会话/AI 报告标签复用 PR3 既有历史读侧，
 *   任务 05 已合入：AI 会话标签按其合并版本展示真实会话/消息/问答与导出；
 *   AI 报告标签复用 PR3 既有历史读侧，数据面不变。
 * - 统计口径与默认列表过滤一致（不含软删除、下架与未知归属），来自后端聚合统计查询；
 * - 本页全部标签均为只读查询，页面不再承载任何写入主操作。
 */
export function AdminDocumentDatabasePage() {
  const { t } = useI18n();
  const stats = useAdminDocumentStats();
  // Tabs 受控仅用于保留已挂载标签的懒挂载/保留行为，不再驱动页头写操作。
  const [activeTabKey, setActiveTabKey] = useState('reference-documents');

  return (
    <div className="kb-page">
      <PageHeader
        description={t('adminDocDb.page.description')}
        eyebrow={t('adminDocDb.page.eyebrow')}
        title={t('adminDocDb.page.title')}
        variant="knowledge-base"
      />

      {stats.state.status === 'loading' ? (
        <div className="mb-4">
          <Skeleton active paragraph={{ rows: 1 }} />
        </div>
      ) : null}
      {stats.state.status === 'failed' ? (
        <div className="mb-4">
          <Alert
            action={
              <Button onClick={stats.reload} size="small">
                {t('common.retry')}
              </Button>
            }
            description={t('adminDocDb.stats.unaffected')}
            showIcon
            title={t('adminDocDb.stats.loadFailed', { message: stats.state.message })}
            type="error"
          />
        </div>
      ) : null}
      {stats.state.status === 'ready' ? (
        /* 四分区紧凑汇总条：业务保留四类真实统计（原型为演示元数据，属登记偏差）；
           口径提示以小字附在数值后，不破坏原型 67.5px 行高 */
        <div className="kb-card kb-summary">
          <div className="kb-summary-cell">
            <div className="kb-summary-label">{t('adminDocDb.stats.repairRequests')}</div>
            <div className="kb-summary-value">
              {stats.state.stats.repairRequestTotal}
              <span className="kb-summary-hint">{t('adminDocDb.stats.hint.notSoftDeleted')}</span>
            </div>
          </div>
          <div className="kb-summary-cell">
            <div className="kb-summary-label">{t('adminDocDb.stats.referenceDocuments')}</div>
            <div className="kb-summary-value">
              {stats.state.stats.referenceDocumentTotal}
              <span className="kb-summary-hint">{t('adminDocDb.stats.hint.notSoftDeleted')}</span>
            </div>
          </div>
          <div className="kb-summary-cell">
            <div className="kb-summary-label">{t('adminDocDb.stats.aiConversations')}</div>
            <div className="kb-summary-value">
              {stats.state.stats.aiConversationTotal}
              <span className="kb-summary-hint">
                {t('adminDocDb.stats.hint.allEngineerConversations')}
              </span>
            </div>
          </div>
          <div className="kb-summary-cell">
            <div className="kb-summary-label">{t('adminDocDb.stats.aiReports')}</div>
            <div className="kb-summary-value">
              {stats.state.stats.aiReportTotal}
              <span className="kb-summary-hint">
                {t('adminDocDb.stats.hint.allGeneratedReports')}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      <div className="kb-tabs">
        <Tabs
          activeKey={activeTabKey}
          items={[
            {
              children: <ReferenceDocumentList variant="knowledge-base" />,
              key: 'reference-documents',
              label: t('adminDocDb.tabs.referenceDocuments'),
            },
            {
              children: <AdminRepairRequestsTab />,
              key: 'repair-requests',
              label: t('adminDocDb.tabs.repairRequests'),
            },
            {
              children: <AdminAiConversationsTab />,
              key: 'ai-conversations',
              label: t('adminDocDb.tabs.aiConversations'),
            },
            {
              children: <AdminAiReportsTab />,
              key: 'ai-reports',
              label: t('adminDocDb.tabs.aiReports'),
            },
          ]}
          onChange={setActiveTabKey}
        />
      </div>
    </div>
  );
}

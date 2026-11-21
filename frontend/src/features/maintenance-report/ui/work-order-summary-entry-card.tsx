// src/features/maintenance-report/ui/work-order-summary-entry-card.tsx
//
// 结单详情页的工单总结入口卡片（§3.2）。
//
// 与工程师首页待填写列表进入同一 URL（/engineer/work-order-summaries/:id），
// 因此自然续填同一份草稿；资格与归属由服务端 myWorkOrderSummary 复核：
// - 未结单 / 非本人接单：查询报错或不可访问 → 本卡片直接不渲染；
// - 尚无报告：开始填写；
// - 草稿（含已退回）：继续填写；
// - 已正式提交：查看总结（编辑页按 canEdit 只读展示）。

import { useEffect, useState } from 'react';
import { Button, Card, Space, Tag } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';

import type { MyWorkOrderSummaryEntry } from '../infrastructure/maintenance-report.types';
import { fetchMyWorkOrderSummary } from '../infrastructure/maintenance-report-adapter';

import { WORK_ORDER_SUMMARIES_PATH } from './maintenance-report-editor-page';

type EntryState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ready'; entry: MyWorkOrderSummaryEntry };

export function WorkOrderSummaryEntryCard({ repairRequestId }: { repairRequestId: number }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<EntryState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void fetchMyWorkOrderSummary(repairRequestId)
      .then((entry) => {
        if (!cancelled) setState({ kind: 'ready', entry });
      })
      .catch(() => {
        // 未结单 / 非本人接单 / 已撤回：服务端裁决不可填写，入口隐藏
        if (!cancelled) setState({ kind: 'hidden' });
      });
    return () => {
      cancelled = true;
    };
  }, [repairRequestId]);

  if (state.kind !== 'ready') {
    return null;
  }
  const { entry } = state;
  const reportStatus = entry.report?.report.status ?? null;
  const isDraft = reportStatus === 'DRAFT' || reportStatus === 'RETURNED';

  return (
    <Card
      size="small"
      title={t('maintenanceReport.summary.title')}
      extra={
        <Button
          size="small"
          type={reportStatus === null ? 'primary' : 'default'}
          onClick={() => void navigate(`${WORK_ORDER_SUMMARIES_PATH}/${repairRequestId}`)}
        >
          {reportStatus === null
            ? t('maintenanceReport.summary.start')
            : isDraft
              ? t('maintenanceReport.summary.resume')
              : t('maintenanceReport.open')}
        </Button>
      }
    >
      <Space size="small" wrap>
        <Tag>
          {t('maintenanceReport.column.requestNo')}：{entry.requestNo}
        </Tag>
        {reportStatus === null ? (
          <Tag color="blue">{t('maintenanceReport.draft.notStarted')}</Tag>
        ) : isDraft ? (
          <Tag color="gold">{t('maintenanceReport.status.DRAFT')}</Tag>
        ) : (
          <Tag color="green">{t('maintenanceReport.status.SUBMITTED')}</Tag>
        )}
      </Space>
    </Card>
  );
}

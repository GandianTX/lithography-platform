// src/features/my-records/ui/my-record-detail-panel.tsx

import type { TableColumnsType } from 'antd';
import { Alert, Button, Card, Descriptions, Skeleton, Table, Tag } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';

import { resolveTask06DraftEditorEntry } from '../application/task-06-editor-entry';
import { useMyRecordDetail } from '../application/use-my-record-detail';
import type {
  MyRecordAlarm,
  MyRecordAttachment,
  MyRecordReview,
  MyRecordStep,
} from '../infrastructure/my-records.types';
import { isDraftRecordStatus } from '../infrastructure/my-records.types';

import { MY_RECORD_SOURCE_LABEL_KEYS, resolveStatusLabelKey } from './my-record-labels';
import { buildPublishedDocumentPath, MY_RECORDS_LIST_PATH } from './my-record-paths';

const STATUS_TAG_COLORS: Record<string, string> = {
  DRAFT: 'default',
  RETURNED: 'warning',
  PENDING_REVIEW: 'processing',
  APPROVED: 'success',
  SUBMITTED: 'processing',
};

/**
 * 本人记录只读详情：正式记录查看冻结后的内容，草稿记录不在此编辑（进入任务 06 编辑器）。
 *
 * 草稿续填入口按来源类型经任务 06 对接点指向真实路由；activeRole 非 ENGINEER
 * 或后端 canEdit=false（含已正式提交记录）时不显示入口。任务 09 同步适配层未接入，
 * 本面板不提供任何「已同步」展示或冲突处理入口。
 * 附件仅展示安全元数据：任务 11 的文件授权下载尚未合入本仓库，这里不提供虚假下载入口。
 */
export function MyRecordDetailPanel({
  recordId,
  activeRole,
}: {
  recordId: number | null;
  activeRole?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { state, reload } = useMyRecordDetail(recordId);

  if (state.status === 'loading') {
    return <Skeleton active paragraph={{ rows: 10 }} />;
  }

  if (state.status === 'not-found' || state.status === 'failed') {
    return (
      <Alert
        action={
          <div className="flex gap-2">
            {state.status === 'failed' ? (
              <Button onClick={reload} size="small">
                {t('common.retry')}
              </Button>
            ) : null}
            <Button onClick={() => void navigate(MY_RECORDS_LIST_PATH)} size="small">
              {t('myRecords.action.back')}
            </Button>
          </div>
        }
        showIcon
        title={state.message}
        type={state.status === 'not-found' ? 'warning' : 'error'}
      />
    );
  }

  const { detail } = state;
  const draft = isDraftRecordStatus(detail.report.status);
  const editor = resolveTask06DraftEditorEntry({
    reportId: detail.report.id,
    sourceType: detail.report.sourceType,
    repairRequestId: detail.report.repairRequestId,
    activeRole,
  });
  const resumeLabel =
    detail.report.sourceType === 'WORK_ORDER_SUMMARY'
      ? t('myRecords.action.resumeSummary')
      : t('myRecords.action.resume');
  const statusLabel = t(resolveStatusLabelKey(detail.report.status));

  const alarmColumns: TableColumnsType<MyRecordAlarm> = [
    {
      dataIndex: 'alarmIndex',
      key: 'alarmIndex',
      title: t('myRecords.detail.alarm.index'),
      width: 90,
    },
    {
      dataIndex: 'alarmCode',
      key: 'alarmCode',
      title: t('myRecords.detail.alarm.code'),
      width: 140,
    },
    {
      dataIndex: 'alarmDescription',
      key: 'alarmDescription',
      title: t('myRecords.detail.alarm.description'),
      render: (value: string | null) => value ?? '—',
    },
    {
      dataIndex: 'phaseCode',
      key: 'phaseCode',
      title: t('myRecords.detail.alarm.phase'),
      width: 140,
    },
    {
      dataIndex: 'resetResult',
      key: 'resetResult',
      title: t('myRecords.detail.alarm.reset'),
      width: 160,
    },
  ];

  const stepColumns: TableColumnsType<MyRecordStep> = [
    { dataIndex: 'stepNo', key: 'stepNo', title: t('myRecords.detail.step.no'), width: 80 },
    {
      dataIndex: 'phaseCode',
      key: 'phaseCode',
      title: t('myRecords.detail.step.phase'),
      width: 140,
    },
    {
      dataIndex: 'partName',
      key: 'partName',
      title: t('myRecords.detail.step.part'),
      render: (value: string | null) => value ?? '—',
    },
    { dataIndex: 'actionText', key: 'actionText', title: t('myRecords.detail.step.action') },
    {
      dataIndex: 'resultText',
      key: 'resultText',
      title: t('myRecords.detail.step.result'),
      render: (value: string | null) => value ?? '—',
    },
    {
      dataIndex: 'newAlarmCode',
      key: 'newAlarmCode',
      title: t('myRecords.detail.step.newAlarm'),
      width: 140,
      render: (value: string | null) => value ?? '—',
    },
  ];

  const attachmentColumns: TableColumnsType<MyRecordAttachment> = [
    {
      dataIndex: 'originalFilename',
      key: 'originalFilename',
      title: t('myRecords.detail.attachment.name'),
    },
    {
      dataIndex: 'byteSize',
      key: 'byteSize',
      title: t('myRecords.detail.attachment.size'),
      width: 120,
      render: (value: number) => `${Math.max(1, Math.round(value / 1024))} KB`,
    },
    {
      dataIndex: 'description',
      key: 'description',
      title: t('myRecords.detail.attachment.description'),
      render: (value: string | null) => value ?? '—',
    },
    {
      dataIndex: 'status',
      key: 'status',
      title: t('myRecords.detail.attachment.status'),
      width: 120,
      render: (value: string) =>
        value === 'CURRENT'
          ? t('myRecords.detail.attachment.current')
          : t('myRecords.detail.attachment.retired'),
    },
  ];

  const reviewColumns: TableColumnsType<MyRecordReview> = [
    {
      dataIndex: 'decision',
      key: 'decision',
      title: t('myRecords.detail.review.decision'),
      width: 120,
      render: (value: string) =>
        value === 'APPROVE'
          ? t('myRecords.detail.review.approve')
          : t('myRecords.detail.review.return'),
    },
    {
      dataIndex: 'comment',
      key: 'comment',
      title: t('myRecords.detail.review.comment'),
      render: (value: string | null) => value ?? '—',
    },
    {
      dataIndex: 'reviewedAt',
      key: 'reviewedAt',
      title: t('myRecords.detail.review.reviewedAt'),
      width: 180,
      render: (value: string) => formatDateTimeText(value),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {draft ? (
        <Alert
          action={
            editor.available && detail.canEdit ? (
              <Button
                onClick={() => {
                  if (editor.path !== null) void navigate(editor.path);
                }}
                size="small"
                type="primary"
              >
                {resumeLabel}
              </Button>
            ) : null
          }
          showIcon
          title={t('myRecords.detail.draftNotice')}
          type="info"
        />
      ) : null}

      <Card
        title={detail.report.title ?? t('myRecords.titleFallback')}
        extra={
          <div className="flex gap-2">
            <Button onClick={() => void navigate(MY_RECORDS_LIST_PATH)} size="small">
              {t('myRecords.action.back')}
            </Button>
            {detail.publishedDocumentId !== null ? (
              <Button
                onClick={() =>
                  void navigate(buildPublishedDocumentPath(detail.publishedDocumentId as number))
                }
                size="small"
                type="primary"
              >
                {t('myRecords.action.viewPublished')}
              </Button>
            ) : null}
          </div>
        }
      >
        <Descriptions bordered column={1} size="small">
          <Descriptions.Item label={t('myRecords.detail.field.source')}>
            {t(MY_RECORD_SOURCE_LABEL_KEYS[detail.report.sourceType])}
          </Descriptions.Item>
          {detail.report.repairRequestId !== null ? (
            <Descriptions.Item label={t('myRecords.detail.field.workOrder')}>
              {t('myRecords.workOrderRef', { id: detail.report.repairRequestId })}
            </Descriptions.Item>
          ) : null}
          <Descriptions.Item label={t('myRecords.detail.field.status')}>
            <Tag color={STATUS_TAG_COLORS[detail.report.status] ?? 'default'}>{statusLabel}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t('myRecords.detail.field.version')}>
            {detail.currentVersion !== null
              ? t('myRecords.versionValue', { no: detail.currentVersion.versionNo })
              : t('myRecords.versionNone')}
          </Descriptions.Item>
          <Descriptions.Item label={t('myRecords.detail.field.customerFactory')}>
            {detail.report.customerFactoryName ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label={t('myRecords.detail.field.equipment')}>
            {detail.equipmentModelName ??
              detail.report.equipmentModelText ??
              (detail.report.equipmentModelId !== null
                ? `#${detail.report.equipmentModelId}`
                : '—')}
          </Descriptions.Item>
          <Descriptions.Item label={t('myRecords.detail.field.maintenanceDate')}>
            {detail.report.maintenanceDate ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label={t('myRecords.detail.field.engineer')}>
            {detail.report.maintenanceEngineerName}
          </Descriptions.Item>
          <Descriptions.Item label={t('myRecords.detail.field.aiUsage')}>
            {detail.report.aiUsage}
          </Descriptions.Item>
          {/* AI 评价字段全部可空：有值才渲染，null/缺字段不得误显示成评分 0 */}
          {detail.report.aiScore !== null ? (
            <Descriptions.Item label={t('myRecords.detail.field.aiScore')}>
              {detail.report.aiScore}
            </Descriptions.Item>
          ) : null}
          {detail.report.aiCorrectness !== null ? (
            <Descriptions.Item label={t('myRecords.detail.field.aiCorrectness')}>
              {detail.report.aiCorrectness}
            </Descriptions.Item>
          ) : null}
          {detail.report.aiHelpfulness !== null ? (
            <Descriptions.Item label={t('myRecords.detail.field.aiHelpfulness')}>
              {detail.report.aiHelpfulness}
            </Descriptions.Item>
          ) : null}
          {detail.report.aiNote !== null && detail.report.aiNote !== '' ? (
            <Descriptions.Item label={t('myRecords.detail.field.aiNote')}>
              {detail.report.aiNote}
            </Descriptions.Item>
          ) : null}
          <Descriptions.Item label={t('myRecords.detail.field.updatedAt')}>
            {formatDateTimeText(detail.report.updatedAt)}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {detail.latestReturnComment ? (
        <Alert
          showIcon
          title={t('myRecords.detail.latestReturn')}
          description={detail.latestReturnComment}
          type="warning"
        />
      ) : null}

      <Card title={t('myRecords.detail.section.alarms')} size="small">
        <Table
          columns={alarmColumns}
          dataSource={detail.alarms}
          pagination={false}
          rowKey="alarmIndex"
          scroll={{ x: 720 }}
          size="small"
        />
      </Card>

      <Card title={t('myRecords.detail.section.steps')} size="small">
        <Table
          columns={stepColumns}
          dataSource={detail.steps}
          pagination={false}
          rowKey="stepNo"
          scroll={{ x: 900 }}
          size="small"
        />
      </Card>

      <Card title={t('myRecords.detail.section.attachments')} size="small">
        {detail.currentAttachments.length > 0 ? (
          <Table
            columns={attachmentColumns}
            dataSource={detail.currentAttachments}
            pagination={false}
            rowKey="id"
            scroll={{ x: 720 }}
            size="small"
          />
        ) : (
          <div className="text-text-secondary text-sm">
            {t('myRecords.detail.attachment.empty')}
          </div>
        )}
      </Card>

      <Card title={t('myRecords.detail.section.review')} size="small">
        {detail.reviewHistory.length > 0 ? (
          <Table
            columns={reviewColumns}
            dataSource={detail.reviewHistory}
            pagination={false}
            rowKey="id"
            scroll={{ x: 720 }}
            size="small"
          />
        ) : (
          <div className="text-text-secondary text-sm">{t('myRecords.detail.review.empty')}</div>
        )}
      </Card>
    </div>
  );
}

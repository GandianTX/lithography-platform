// src/features/admin-document-database/ui/admin-repair-request-detail-panel.tsx

import { useMemo, useState } from 'react';
import { Alert, Button, Descriptions, Skeleton, Tag } from 'antd';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { MaintenanceRecordEditor } from '@/shared/ui/maintenance-record-editor';
import { createMaintenanceEditorValue } from '@/shared/ui/maintenance-record-editor/model';
import {
  REPAIR_HANDLING_RESULT_LABELS,
  REPAIR_HANDLING_STATUS_LABELS,
  resolveRepairClosureState,
} from '@/shared/ui/repair-request-status-labels';
import { StatusPill } from '@/shared/ui/status-pill';

import { useAdminRepairRequestSummary } from '../application/use-admin-document-detail';
import { downloadAdminRepairProcessFile } from '../infrastructure/admin-document-database-adapter';

import { AdminRepairRequestRevisionModal } from './admin-repair-request-revision-modal';
import { AdminRepairRequestVersionHistory } from './admin-repair-request-version-history';

const RESOLUTION_STATUS_LABELS: Record<'PENDING' | 'RESOLVED', string> = {
  PENDING: '处理中',
  RESOLVED: '已解决',
};

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * 管理员工单详情（独立详情页与旧抽屉共用）。
 *
 * 只展示既有管理员查询返回的已提交事实：基础信息、处理结果、内部过程、
 * 客户可见回复与修订历史。附件沿用既有 REST 授权下载，仅提供下载入口，
 * 不新增上传/替换/移除。权限边界完全由服务端用例负责。
 */
export function AdminRepairRequestDetailPanel({
  requestId,
  onBack,
}: {
  requestId: number;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const summary = useAdminRepairRequestSummary(requestId);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);

  const handleDownload = async (
    fileId: string,
  ): Promise<{ ok: boolean; message?: string }> => {
    setDownloadError(null);
    setDownloadingFileId(fileId);
    const result = await downloadAdminRepairProcessFile(fileId);
    setDownloadingFileId(null);
    if (!result.ok) {
      setDownloadError(result.message);
      return { ok: false, message: result.message };
    }
    triggerBrowserDownload(result.blob, result.filename);
    return { ok: true };
  };

  const detail = summary.state.status === 'ready' ? summary.state.detail : null;
  const closureState = detail
    ? resolveRepairClosureState(detail.closureStatus, detail.closedAt)
    : 'UNKNOWN';
  const maintenanceValue = useMemo(
    () =>
      createMaintenanceEditorValue({
        maintenanceDate: detail?.maintenance?.maintenanceDate ?? null,
        engineerName: detail?.maintenance?.engineerName ?? null,
        resetResult: detail?.maintenance?.resetResult ?? null,
        supplementaryNote: detail?.maintenance?.supplementaryNote ?? null,
        attachment: detail?.maintenance?.attachment ?? null,
        steps: detail?.maintenanceSteps ?? [],
        panels: detail?.maintenanceFaultPanels ?? [],
      }),
    [detail],
  );
  const hasMaintenance =
    Boolean(detail?.maintenance) ||
    (detail?.maintenanceSteps?.length ?? 0) > 0 ||
    (detail?.maintenanceFaultPanels?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-base font-medium">
          {detail ? `工单详情 · ${detail.requestNo}` : '工单详情'}
        </h2>
        <div className="flex flex-wrap gap-2">
          {onBack ? <Button onClick={onBack}>返回列表</Button> : null}
          {detail ? (
            <Button onClick={() => setRevisionOpen(true)} type="primary">
              修订工单
            </Button>
          ) : null}
        </div>
      </div>

      {summary.state.status === 'loading' ? <Skeleton active /> : null}

      {summary.state.status === 'failed' ? (
        <Alert
          action={
            <Button onClick={summary.retry} size="small">
              重试
            </Button>
          }
          showIcon
          title={summary.state.message}
          type="error"
        />
      ) : null}

      {detail ? (
        <>
          <DataCard title="基础信息">
            <Descriptions
              column={{ lg: 2, md: 1, sm: 1, xs: 1 }}
              items={[
                { key: 'requestNo', label: '申请编号', children: detail.requestNo },
                { key: 'customer', label: '客户', children: detail.customerNickname },
                { key: 'company', label: '公司', children: detail.companyName ?? '—' },
                {
                  key: 'model',
                  label: '设备型号',
                  children: `${detail.equipmentModelName}（${detail.equipmentModelCode}）`,
                },
                { key: 'errorCode', label: '故障码', children: detail.errorCode },
                {
                  key: 'createdAt',
                  label: '提交时间',
                  children: formatDateTimeText(detail.createdAt),
                },
                {
                  key: 'accepted',
                  label: '接单',
                  children: detail.isAccepted
                    ? `${detail.acceptedByEngineerNickname ?? '—'} · ${detail.acceptedAt ? formatDateTimeText(detail.acceptedAt) : '—'}`
                    : '待接单',
                },
                {
                  key: 'revision',
                  label: '当前修订版本',
                  children: `v${detail.currentRevisionNo}`,
                },
              ]}
              size="small"
            />
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium">故障描述</p>
              <p className="mb-2 text-sm whitespace-pre-wrap">{detail.faultDescription || '—'}</p>
              <p className="mb-2 text-sm font-medium">申请正文</p>
              <pre className="max-h-[420px] overflow-auto rounded border border-[var(--panel-border)] bg-[var(--filter-bar-bg)] p-3 text-xs whitespace-pre-wrap">
                {detail.contentMd}
              </pre>
            </div>
          </DataCard>

          <DataCard title="处理结果">
            <Descriptions
              column={{ lg: 2, md: 1, sm: 1, xs: 1 }}
              items={[
                {
                  key: 'closureStatus',
                  label: '结单状态',
                  children:
                    closureState === 'CLOSED' ? (
                      <StatusPill tone="ok">
                        {detail.handlingResult === 'INTERRUPTED' ? '已结单 · 维修中断' : '已结单'}
                      </StatusPill>
                    ) : closureState === 'OPEN' ? (
                      <StatusPill tone="warn">未结单</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">结单状态未知</StatusPill>
                    ),
                },
                {
                  key: 'closedAt',
                  label: '结单时间',
                  children: detail.closedAt ? formatDateTimeText(detail.closedAt) : '—',
                },
                {
                  key: 'handlingResult',
                  label: '处理结果',
                  children: detail.handlingResult
                    ? REPAIR_HANDLING_RESULT_LABELS[detail.handlingResult]
                    : '未记录',
                },
                {
                  key: 'handlingStatus',
                  label: '处理状态',
                  children: detail.handlingStatus
                    ? REPAIR_HANDLING_STATUS_LABELS[detail.handlingStatus]
                    : '未记录',
                },
                {
                  key: 'latestResolutionStatus',
                  label: '最后回复状态',
                  children: detail.latestResolutionStatus
                    ? RESOLUTION_STATUS_LABELS[detail.latestResolutionStatus]
                    : '未记录',
                },
                {
                  key: 'closureReason',
                  label: '结单原因',
                  children: detail.closureReason || '—',
                },
              ]}
              size="small"
            />
          </DataCard>

          <DataCard
            extra={
              hasMaintenance && detail.maintenanceVersionNo !== undefined ? (
                <Tag>v{detail.maintenanceVersionNo}</Tag>
              ) : null
            }
            title={t('adminRepairRequest.maintenanceCard')}
          >
            {!hasMaintenance ? (
              <p className="text-sm text-text-tertiary">
                {t('adminRepairRequest.maintenanceEmpty')}
              </p>
            ) : (
              <MaintenanceRecordEditor
                attachment={{
                  onClearStaged: () => undefined,
                  onDownload: (fileId) => void handleDownload(fileId),
                  onSelectFile: () => undefined,
                  readOnly: true,
                  stagedFile: null,
                  uploading: false,
                }}
                onChange={() => undefined}
                readOnly
                value={maintenanceValue}
              />
            )}
          </DataCard>

          <DataCard title="内部维修过程">
            {detail.processEntries.length === 0 ? (
              <p className="text-sm text-text-tertiary">暂无已提交过程。</p>
            ) : (
              <div className="flex flex-col gap-3">
                {detail.processEntries.map((entry) => (
                  <div className="rounded border border-[var(--panel-border)] p-3" key={entry.id}>
                    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
                      <Tag>v{entry.versionNo}</Tag>
                      <span>{formatDateTimeText(entry.occurredAt ?? entry.createdAt)}</span>
                      <span>时间来源 {entry.timeSource === 'SERVER' ? '服务端' : '人工'}</span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{entry.operationText}</p>
                    {entry.testResult ? (
                      <p className="mt-1 text-xs text-text-secondary">
                        测试事实：{entry.testResult}
                      </p>
                    ) : null}
                    {entry.file ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Tag color="green">已保存绑定</Tag>
                        <span className="text-sm">{entry.file.originalFilename}</span>
                        <span className="text-xs text-text-secondary">
                          {entry.file.byteSize} 字节
                        </span>
                        <Button
                          loading={downloadingFileId === entry.file.fileId}
                          onClick={() => void handleDownload(entry.file!.fileId)}
                          size="small"
                        >
                          下载原件
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {downloadError ? (
              <div className="mt-3">
                <Alert showIcon title={downloadError} type="error" />
              </div>
            ) : null}
            <p className="mt-3 text-xs text-text-tertiary">
              管理员仅可查看与下载已绑定原件；上传、替换与移除请在工程师端完成。
            </p>
          </DataCard>

          <DataCard title="客户可见回复">
            {detail.responses.length === 0 ? (
              <p className="text-sm text-text-tertiary">暂无客户可见回复。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {detail.responses.map((response) => (
                  <div
                    className="rounded border border-[var(--panel-border)] p-3"
                    key={response.id}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-x-3 text-xs text-[var(--text-secondary)]">
                      <span>{response.engineerNickname}</span>
                      <span>{formatDateTimeText(response.createdAt)}</span>
                      <Tag color={response.resolutionStatus === 'RESOLVED' ? 'green' : 'blue'}>
                        {RESOLUTION_STATUS_LABELS[response.resolutionStatus]}
                      </Tag>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{response.responseText}</p>
                  </div>
                ))}
              </div>
            )}
          </DataCard>

          <AdminRepairRequestVersionHistory
            onDownloadAttachment={handleDownload}
            requestId={detail.id}
            revisions={detail.revisions}
          />

          <AdminRepairRequestRevisionModal
            detail={detail}
            key={`${detail.id}:${detail.currentRevisionNo}:${revisionOpen}`}
            onClose={() => setRevisionOpen(false)}
            onDownloadAttachment={handleDownload}
            onSaved={summary.reload}
            open={revisionOpen}
          />
        </>
      ) : null}
    </div>
  );
}

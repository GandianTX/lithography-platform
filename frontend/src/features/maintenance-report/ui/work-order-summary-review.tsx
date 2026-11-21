// src/features/maintenance-report/ui/work-order-summary-review.tsx
//
// 工单维修总结（2026-11-21 需求调整：只读核对页，一次正式提交完成）。
//
// - 只读展示服务端预览事实（myWorkOrderSummary.sourcePreview）：预览与
//   sourceConfirmation 指纹由同一次服务端读取生成，展示即被校验的事实，
//   预览与校验不再走两条读取路径；
// - 维修内容复用共享维修记录编辑器的只读模式；另有工单基本信息、客户原始报修、
//   处理结果与结单信息、来源工单原件（有权时授权下载）；
// - 本页没有「保存草稿」，也不在正式提交前调用建稿接口：无草稿时一次正式提交
//   直接冻结服务端派生内容；已有总结草稿兼容读取，重新核对后可直接提交；
//   也不提供新上传或更换原件入口；
// - 预览后来源工单变化（原件新增/移除/更换、维修内容变化）由提交侧指纹复核
//   拒绝，要求刷新并重新核对；实际展示内容与原件未变时纯修订号变化不拦截；
// - AI 评价：候选会话查询进行中/失败/未选择时不允许提交；服务端确认无适用
//   会话才不强制评分；查询失败绝不当作无会话；不提供「未使用 AI」强制选项；
// - 打开页面、滚动与查看不创建报告。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Space, Spin, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router';

import { isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';
import { type MessageKey, useI18n } from '@/shared/i18n';
import {
  type MaintenanceEditorAttachmentProps,
  MaintenanceRecordEditor,
} from '@/shared/ui/maintenance-record-editor';
import { createMaintenanceEditorValue } from '@/shared/ui/maintenance-record-editor/model';
import { PageHeader } from '@/shared/ui/page-header';

import type {
  MaintenanceReportDraftInput,
  MaintenanceReportExportFormat,
  MaintenanceReportRecord,
  MyWorkOrderSummaryEntry,
  ReportHandlingResult,
} from '../infrastructure/maintenance-report.types';
import {
  exportMaintenanceReport,
  fetchMyWorkOrderSummary,
  submitMaintenanceReport,
} from '../infrastructure/maintenance-report-adapter';

import { downloadBlobAsFile, downloadMaintenanceReportExport } from './maintenance-report-download';
import {
  type WorkOrderSummaryAiDraftValue,
  type WorkOrderSummaryAiReadiness,
  WorkOrderSummaryAiSection,
} from './work-order-summary-ai-section';

/** 从已落库报告还原评价草稿（只接受工单辅助排查会话来源；非法标识视为未评价） */
function readSavedAiValue(
  record: MaintenanceReportRecord | null,
): WorkOrderSummaryAiDraftValue | null {
  if (
    record === null ||
    record.aiUsage !== 'USED' ||
    record.aiSourceType !== 'AI_CONVERSATION' ||
    record.aiSourceId === null ||
    record.aiSourceVersion === null
  ) {
    return null;
  }
  const conversationId = Number(record.aiSourceId);
  const contentVersion = Number(record.aiSourceVersion);
  if (!Number.isInteger(conversationId) || !Number.isInteger(contentVersion)) return null;
  return {
    conversationId,
    contentVersion,
    score: record.aiScore,
    correctness: record.aiCorrectness,
    helpfulness: record.aiHelpfulness,
    note: record.aiNote ?? '',
  };
}

/** 与 editor-page 的路由常量同值（本地常量避免循环依赖） */
const WORK_ORDER_SUMMARIES_PATH = '/engineer/work-order-summaries';

/** 来源工单内容/版本冲突：需要重新核对，错误横幅内提供刷新入口 */
const SOURCE_CONFLICT_ERROR_CODE = 'MAINTENANCE_REPORT_SUBMISSION_VERSION_CONFLICT';

/**
 * 提交/导出的可操作错误解析（graphql-error-contract）：
 * 后端业务错误附带 errorCode/errorMessage（可操作的中文业务文案）时如实透出；
 * 其余一律走通用兜底文案，不展示原始异常。仅确认来源冲突时要求重新核对。
 */
function resolveSummaryActionError(
  error: unknown,
  fallback: string,
): { message: string; sourceConflict: boolean } {
  const detail = readGraphQLErrorDetail(error);
  if (detail !== null && detail.errorCode !== null && detail.errorMessage !== null) {
    return {
      message: detail.errorMessage,
      sourceConflict: detail.errorCode === SOURCE_CONFLICT_ERROR_CODE,
    };
  }
  return { message: fallback, sourceConflict: false };
}

const HANDLING_LABEL_KEYS: Record<ReportHandlingResult, MessageKey> = {
  FIXED: 'status.handlingResult.FIXED',
  PART_PURCHASED: 'status.handlingResult.PART_PURCHASED',
  PROVIDE_PLAN_SELF_EXECUTE: 'status.handlingResult.PROVIDE_PLAN_SELF_EXECUTE',
  INTERRUPTED: 'status.handlingResult.INTERRUPTED',
  UNREPAIRABLE: 'status.handlingResult.UNREPAIRABLE',
};

type SourceFileRef = { fileId: string; originalFilename: string; byteSize: number };

export type WorkOrderSummaryFileDownloadResult =
  | { ok: true; blob: Blob; filename: string }
  | { ok: false; message: string };

type PageState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; entry: MyWorkOrderSummaryEntry };

export function WorkOrderSummaryReviewPage({
  repairRequestId,
  downloadSourceFile,
}: {
  repairRequestId: number;
  /** 页面层注入：来源工单原件授权下载（REST 授权） */
  downloadSourceFile: (fileId: string) => Promise<WorkOrderSummaryFileDownloadResult>;
}) {
  const [reloadToken, setReloadToken] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  return (
    <SummaryReviewLoader
      downloadSourceFile={downloadSourceFile}
      flash={flash}
      key={`${repairRequestId}:${reloadToken}`}
      onFlash={setFlash}
      onRetry={() => setReloadToken((token) => token + 1)}
      repairRequestId={repairRequestId}
    />
  );
}

function SummaryReviewLoader({
  repairRequestId,
  downloadSourceFile,
  flash,
  onFlash,
  onRetry,
}: {
  repairRequestId: number;
  downloadSourceFile: (fileId: string) => Promise<WorkOrderSummaryFileDownloadResult>;
  flash: string | null;
  onFlash: (message: string | null) => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // 2026-11-21 需求：预览与校验同一份读取——只取一次 myWorkOrderSummary，
    // 展示（sourcePreview）与提交标识（sourceConfirmation）来自同一响应
    void fetchMyWorkOrderSummary(repairRequestId)
      .then((entry) => {
        if (!cancelled) setState({ kind: 'ready', entry });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'failed',
          message: isGraphQLIngressError(error)
            ? error.userMessage
            : t('maintenanceReport.summaryReview.loadFailed'),
        });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairRequestId]);

  if (state.kind === 'loading') {
    return (
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <PageHeader title={t('maintenanceReport.summaryReview.title')} />
        <Spin />
      </Space>
    );
  }

  if (state.kind === 'failed') {
    return (
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <PageHeader title={t('maintenanceReport.summaryReview.title')} />
        <Alert showIcon title={state.message} type="error" />
        <Button onClick={onRetry}>{t('maintenanceReport.retry')}</Button>
      </Space>
    );
  }

  return (
    <SummaryReviewBody
      downloadSourceFile={downloadSourceFile}
      entry={state.entry}
      flash={flash}
      onFlash={onFlash}
      onReload={onRetry}
    />
  );
}

function SummaryReviewBody({
  entry,
  downloadSourceFile,
  flash,
  onFlash,
  onReload,
}: {
  entry: MyWorkOrderSummaryEntry;
  downloadSourceFile: (fileId: string) => Promise<WorkOrderSummaryFileDownloadResult>;
  flash: string | null;
  onFlash: (message: string | null) => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const preview = entry.sourcePreview;
  const report = entry.report;
  const canEdit = report?.canEdit ?? true;
  const reportId = report?.report.id ?? null;
  const currentVersionNo = report?.report.currentVersionNo ?? 0;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{
    message: string;
    sourceConflict: boolean;
  } | null>(null);
  const [exportingFormat, setExportingFormat] = useState<MaintenanceReportExportFormat | null>(
    null,
  );
  const [exportError, setExportError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  // AI 评价：null = 未选择会话。查询就绪且存在适用会话时必须选择后才能提交
  const [aiValue, setAiValue] = useState<WorkOrderSummaryAiDraftValue | null>(() =>
    readSavedAiValue(report === null ? null : report.report),
  );
  const [aiReadiness, setAiReadiness] = useState<WorkOrderSummaryAiReadiness>('loading');
  // R051-01：提交标识绑定内容摘要——同内容重试沿用，内容变化才生成新标识
  const [submissionKey, setSubmissionKey] = useState<string | null>(null);

  // AI 评价补丁：显式选择会话才提交 USED 组；未选择时不下发任何 AI 字段
  // （服务端沿用落库值；确认无会话时按 NOT_USED 落库，服务端事务内复核）
  const aiDraftPatch = useMemo<MaintenanceReportDraftInput>(() => {
    if (aiValue === null) {
      return {};
    }
    return {
      aiUsage: 'USED',
      aiSourceType: 'AI_CONVERSATION',
      aiSourceId: String(aiValue.conversationId),
      aiSourceVersion: String(aiValue.contentVersion),
      aiScore: aiValue.score,
      aiCorrectness: aiValue.correctness,
      aiHelpfulness: aiValue.helpfulness,
      aiNote: aiValue.note.trim().length === 0 ? null : aiValue.note.trim(),
    };
  }, [aiValue]);

  // 2026-11-21 需求：AI 候选查询进行中/失败、或存在适用会话但未选择时禁止提交
  const aiSubmitBlocked =
    aiReadiness === 'loading' ||
    aiReadiness === 'failed' ||
    (aiReadiness === 'ready' && aiValue === null);

  // 正式提交：一次提交完成冻结（不预建草稿）；服务端在事务内核验来源与评价；
  // 首提响应丢失后沿用同一提交标识重试，由服务端幂等返回原冻结结果
  const handleFormalSubmit = useCallback(async () => {
    if (submitting) return;
    setSubmitError(null);
    const requestId =
      submissionKey ??
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sub-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
    if (submissionKey === null) setSubmissionKey(requestId);
    setSubmitting(true);
    try {
      await submitMaintenanceReport({
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: entry.repairRequestId,
        reportId,
        expectedVersionNo: reportId === null ? null : currentVersionNo,
        submissionRequestId: requestId,
        sourceConfirmation: entry.sourceConfirmation,
        draft: aiDraftPatch,
        attachment: null,
      });
      onFlash(t('maintenanceReport.submitSuccess'));
      onReload();
    } catch (error) {
      // 已知业务错误展示可操作文案；未知错误通用兜底；失败不清空已填评价
      const fallback = isGraphQLIngressError(error)
        ? error.userMessage
        : t('maintenanceReport.submitFailed');
      setSubmitError(resolveSummaryActionError(error, fallback));
    } finally {
      setSubmitting(false);
    }
  }, [
    aiDraftPatch,
    currentVersionNo,
    entry.repairRequestId,
    entry.sourceConfirmation,
    onFlash,
    onReload,
    reportId,
    submissionKey,
    submitting,
    t,
  ]);

  // R051 导出：可编辑且尚无草稿时导出服务端派生的当前内容（与页面展示一致）；
  // 已有草稿/已冻结导出已保存版本（冻结内容一致）
  const handleExport = useCallback(
    async (format: MaintenanceReportExportFormat) => {
      if (exportingFormat !== null) return;
      setExportError(null);
      setExportingFormat(format);
      try {
        const result =
          canEdit && reportId === null
            ? await exportMaintenanceReport({
                format,
                currentForm: {
                  sourceType: 'WORK_ORDER_SUMMARY',
                  repairRequestId: entry.repairRequestId,
                  draft: aiDraftPatch,
                },
              })
            : await exportMaintenanceReport({
                format,
                savedVersion: { reportId: reportId as number },
              });
        downloadMaintenanceReportExport(result);
      } catch (error) {
        // 已知业务错误展示可操作文案（如缺维修日期/排查步骤）；未知错误通用兜底
        const fallback = isGraphQLIngressError(error)
          ? error.userMessage
          : t('maintenanceReport.export.failed');
        setExportError(resolveSummaryActionError(error, fallback).message);
      } finally {
        setExportingFormat(null);
      }
    },
    [aiDraftPatch, canEdit, entry.repairRequestId, exportingFormat, reportId, t],
  );

  // 来源工单原件授权下载（页面层注入 REST 授权；无权时服务端拒绝并给明确文案）
  const handleDownloadFile = useCallback(
    async (file: SourceFileRef) => {
      if (downloadingFileId !== null) return;
      setDownloadError(null);
      setDownloadingFileId(file.fileId);
      try {
        const result = await downloadSourceFile(file.fileId);
        if (!result.ok) {
          setDownloadError(result.message);
          return;
        }
        downloadBlobAsFile(result.blob, result.filename);
      } finally {
        setDownloadingFileId(null);
      }
    },
    [downloadSourceFile, downloadingFileId],
  );

  const editorValue = createMaintenanceEditorValue({
    attachment: preview.attachment ?? null,
    engineerName: preview.engineerName ?? null,
    maintenanceDate: preview.maintenanceDate ?? null,
    // 预览视图无服务端行 ID：按步骤顺序号构造页内稳定 id，
    // 步骤新故障面板经 stepId 关联到对应步骤（只读展示，无调序/删除）
    panels: preview.panels.map((panel, index) => ({
      id: `summary-panel-${index}`,
      panelType: panel.panelType,
      stepId: panel.stepNo === null ? null : `summary-step-${panel.stepNo}`,
      phaseCode: panel.phaseCode,
      mainError: panel.mainError,
      unitError: panel.unitError,
      source: panel.source,
      errorType: panel.errorType,
      gpibStatus: panel.gpibStatus,
      faultStatus: panel.faultStatus,
      description: panel.description,
      action: panel.action,
    })),
    resetResult: preview.resetResult ?? null,
    steps: preview.steps.map((step) => ({
      id: `summary-step-${step.stepNo}`,
      stepNo: step.stepNo,
      errorCode: step.errorCode,
      partName: step.partName,
      actionText: step.actionText,
      resultCode: step.resultCode,
    })),
    supplementaryNote: preview.supplementaryNote ?? null,
  });

  const attachmentProps: MaintenanceEditorAttachmentProps = {
    stagedFile: null,
    uploading: false,
    downloadingFileId,
    onClearStaged: () => undefined,
    onDownload: (fileId: string) => {
      const boundAttachment = preview.attachment ?? null;
      if (boundAttachment !== null && boundAttachment.fileId === fileId) {
        void handleDownloadFile(boundAttachment);
      }
    },
    onSelectFile: () => undefined,
    readOnly: true,
  };

  const modelLabel =
    entry.equipmentModelCode === null
      ? '—'
      : `${entry.equipmentModelCode} · ${entry.equipmentModelName ?? ''}`;
  const intakeFile = preview.intakeCustomerFile ?? null;
  const maintenanceAttachment = preview.attachment ?? null;
  const handlingResult = preview.handlingResult ?? null;
  const handlingLabel =
    handlingResult === null || !(handlingResult in HANDLING_LABEL_KEYS)
      ? '—'
      : t(HANDLING_LABEL_KEYS[handlingResult as ReportHandlingResult]);

  return (
    <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      <PageHeader
        description={t('maintenanceReport.summaryReview.readOnlyNote')}
        extra={
          <Button onClick={() => void navigate(WORK_ORDER_SUMMARIES_PATH)}>
            {t('maintenanceReport.backToList')}
          </Button>
        }
        title={t('maintenanceReport.summaryReview.title')}
      />

      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Text strong>
            {t('maintenanceReport.workOrder', { requestNo: entry.requestNo })}
          </Typography.Text>
          {report === null ? null : (
            <Tag>{t(`maintenanceReport.status.${report.report.status}` as MessageKey)}</Tag>
          )}
          <Button
            disabled={exportingFormat !== null}
            loading={exportingFormat === 'DOCX'}
            onClick={() => void handleExport('DOCX')}
          >
            {t('maintenanceReport.export.word')}
          </Button>
          <Button
            disabled={exportingFormat !== null}
            loading={exportingFormat === 'PDF'}
            onClick={() => void handleExport('PDF')}
          >
            {t('maintenanceReport.export.pdf')}
          </Button>
          <Typography.Text type="secondary">
            {canEdit
              ? t('maintenanceReport.export.currentFormHint')
              : t('maintenanceReport.export.frozenHint')}
          </Typography.Text>
        </Space>
        {exportError === null ? null : <Alert showIcon title={exportError} type="error" />}
      </Space>

      {flash === null ? null : <Alert showIcon title={flash} type="success" />}
      {entry.sourceChangedSinceDraft ? (
        <Alert showIcon title={t('maintenanceReport.summaryReview.sourceChanged')} type="warning" />
      ) : null}
      {submitError === null ? null : (
        <Alert
          showIcon
          action={
            // 仅确认来源冲突时提供重新核对入口；普通业务失败保留页面状态
            // （含已填评价），重载会重新读取服务端事实
            submitError.sourceConflict ? (
              <Button onClick={onReload} size="small">
                {t('maintenanceReport.summaryReview.reconfirm')}
              </Button>
            ) : null
          }
          title={submitError.message}
          type="error"
        />
      )}

      <Card title={t('maintenanceReport.summaryReview.basic')}>
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <ReviewRow label={t('maintenanceReport.column.requestNo')} value={entry.requestNo} />
          <ReviewRow label={t('maintenanceReport.field.equipmentModel')} value={modelLabel} />
          <ReviewRow
            label={t('maintenanceReport.field.maintenanceDate')}
            value={preview.maintenanceDate ?? '—'}
          />
          <ReviewRow
            label={t('maintenanceReport.field.engineer')}
            value={preview.engineerName ?? '—'}
          />
          <ReviewRow
            label={t('maintenanceReport.field.customerFactory')}
            value={preview.customerCompanyName ?? '—'}
          />
          <ReviewRow
            label={t('maintenanceReport.summaryReview.closedAt')}
            value={entry.closedAt ?? '—'}
          />
        </Space>
      </Card>

      <Card title={t('maintenanceReport.summaryReview.intake')}>
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <ReviewRow
            label={t('maintenanceReport.summaryReview.intakeFault')}
            value={preview.intakeFaultDescription ?? '—'}
          />
          {intakeFile === null ? null : (
            <Space wrap>
              <Typography.Text>
                {intakeFile.originalFilename}（{intakeFile.byteSize} B）
              </Typography.Text>
              <Button
                loading={downloadingFileId === intakeFile.fileId}
                size="small"
                onClick={() => void handleDownloadFile(intakeFile)}
              >
                {t('maintenanceReport.summaryReview.download')}
              </Button>
            </Space>
          )}
        </Space>
      </Card>

      <Card title={t('maintenanceReport.summaryReview.maintenance')}>
        {/* 只读复用共享维修记录编辑器：初始故障/复位/排查步骤与步骤新故障/补充说明 */}
        <MaintenanceRecordEditor
          attachment={attachmentProps}
          engineerNameReadOnly
          readOnly
          onChange={() => undefined}
          value={editorValue}
          visibleSections={['initialFault', 'reset', 'steps', 'supplementaryNote'] as const}
        />
      </Card>

      <Card title={t('maintenanceReport.summaryReview.result')}>
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <ReviewRow
            label={t('maintenanceReport.summaryReview.handlingResult')}
            value={handlingLabel}
          />
          <ReviewRow
            label={t('maintenanceReport.summaryReview.closureReason')}
            value={preview.closureReason ?? '—'}
          />
        </Space>
      </Card>

      <Card title={t('maintenanceReport.summaryReview.sourceAttachment')}>
        {maintenanceAttachment === null ? (
          <Typography.Text type="secondary">
            {t('maintenanceReport.summaryReview.noAttachment')}
          </Typography.Text>
        ) : (
          <Space wrap>
            <Typography.Text>
              {maintenanceAttachment.originalFilename}（{maintenanceAttachment.byteSize} B）
            </Typography.Text>
            <Button
              loading={downloadingFileId === maintenanceAttachment.fileId}
              size="small"
              onClick={() => void handleDownloadFile(maintenanceAttachment)}
            >
              {t('maintenanceReport.summaryReview.download')}
            </Button>
          </Space>
        )}
        {downloadError === null ? null : <Alert showIcon title={downloadError} type="error" />}
      </Card>

      <Card title={t('maintenanceReport.summaryReview.aiTitle')}>
        <WorkOrderSummaryAiSection
          readOnly={!canEdit}
          repairRequestId={entry.repairRequestId}
          saved={report === null ? null : report.report}
          value={aiValue}
          onReadiness={setAiReadiness}
          onChange={setAiValue}
        />
      </Card>

      {canEdit ? (
        <Space wrap>
          <Button
            danger
            disabled={aiSubmitBlocked}
            loading={submitting}
            onClick={() => void handleFormalSubmit()}
          >
            {submitting ? t('maintenanceReport.submitting') : t('maintenanceReport.submitFormal')}
          </Button>
          <Typography.Text type="secondary">
            {t('maintenanceReport.summaryReview.submitNote')}
          </Typography.Text>
        </Space>
      ) : null}
    </Space>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <div style={{ whiteSpace: 'pre-wrap' }}>{value.trim().length === 0 ? '—' : value}</div>
    </div>
  );
}

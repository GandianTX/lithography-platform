// src/features/maintenance-report/ui/maintenance-report-editor-page.tsx
//
// 两个入口共用同一份报告域模型，但页面形态不同（2026-11-20 需求调整）：
// - HISTORICAL_CASE：/engineer/maintenance-records/new 或 /:reportId——单页纵向填写；
// - WORK_ORDER_SUMMARY：/engineer/work-order-summaries/:repairRequestId——只读核对页
//   （work-order-summary-review.tsx），不再重复填写任务 04 维修内容。
//
// 打开页面只读服务端事实，不创建报告；只有「保存草稿」才写库。
// 未保存离开时提示；切换故障分支前提示并保留原内容供切回。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Modal, Space, Spin, Tag, Typography } from 'antd';
import { useBlocker, useNavigate } from 'react-router';

import { isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';
import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

import { useMaintenanceReportEditor } from '../application/use-maintenance-report-editor';
import type {
  EquipmentModelOption,
  MaintenanceReportAttachmentRecord,
  MaintenanceReportExportFormat,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
  StagedMaintenanceReportFile,
} from '../infrastructure/maintenance-report.types';
import {
  addMaintenanceReportAttachment,
  downloadMaintenanceReportAttachment,
  exportMaintenanceReport,
  fetchMaintenanceEquipmentModels,
  fetchMyMaintenanceReport,
  removeMaintenanceReportAttachment,
  uploadMaintenanceReportOriginal,
} from '../infrastructure/maintenance-report-adapter';
import {
  createEmptyReportForm,
  type MaintenanceReportForm,
  serializeReportForm,
  toReportDraftInput,
  toReportFormFromDetail,
} from '../model/report-form';

import { downloadBlobAsFile } from './maintenance-report-download';
import { downloadMaintenanceReportExport } from './maintenance-report-download';
import { MaintenanceReportFormView } from './maintenance-report-form';
import {
  type WorkOrderSummaryFileDownloadResult,
  WorkOrderSummaryReviewPage,
} from './work-order-summary-review';

export const MAINTENANCE_RECORDS_PATH = '/engineer/maintenance-records';
export const WORK_ORDER_SUMMARIES_PATH = '/engineer/work-order-summaries';

export type MaintenanceReportEditorMode = 'HISTORICAL_CASE' | 'WORK_ORDER_SUMMARY';

type LoadedState = {
  form: MaintenanceReportForm;
  reportId: number | null;
  /** 草稿冻结版本号：已有草稿首次提交时作为 expectedVersionNo 服务端核对 */
  currentVersionNo: number;
  canEdit: boolean;
  status: MaintenanceReportStatus | null;
  requestNo: string | null;
  /** 当前附件集合（服务端事实；未保存草稿无附件） */
  attachments: MaintenanceReportAttachmentRecord[];
};

type PageState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; loaded: LoadedState };

export type WorkOrderSummarySourceProps = {
  /** 页面层注入：来源工单原件授权下载 */
  downloadSourceFile: (fileId: string) => Promise<WorkOrderSummaryFileDownloadResult>;
};

export function MaintenanceReportEditorPage({
  mode,
  engineerName,
  reportId = null,
  repairRequestId = null,
  workOrderSummarySource = null,
}: {
  mode: MaintenanceReportEditorMode;
  /** 仅用于空白表单的展示名；报告归属由服务端会话裁决 */
  engineerName: string;
  reportId?: number | null;
  repairRequestId?: number | null;
  /** 工单总结只读核对页的来源工单读侧（页面层组合，features 不互相依赖） */
  workOrderSummarySource?: WorkOrderSummarySourceProps | null;
}) {
  // 2026-11-20 需求调整：工单总结为只读核对页（与历史记录单页填写分离）
  if (mode === 'WORK_ORDER_SUMMARY') {
    return repairRequestId === null || workOrderSummarySource === null ? (
      <InvalidWorkOrderPage />
    ) : (
      <WorkOrderSummaryReviewPage
        downloadSourceFile={workOrderSummarySource.downloadSourceFile}
        repairRequestId={repairRequestId}
      />
    );
  }
  return (
    <HistoricalMaintenanceRecordPage
      engineerName={engineerName}
      repairRequestId={repairRequestId}
      reportId={reportId}
    />
  );
}

function InvalidWorkOrderPage() {
  const { t } = useI18n();
  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <PageHeader title={t('maintenanceReport.summary.title')} />
      <Alert showIcon title={t('maintenanceReport.invalidWorkOrderId')} type="error" />
    </Space>
  );
}

function HistoricalMaintenanceRecordPage({
  engineerName,
  reportId,
  repairRequestId,
}: {
  engineerName: string;
  reportId: number | null;
  repairRequestId: number | null;
}) {
  const [reloadToken, setReloadToken] = useState(0);
  // 提交成功提示放在外层：重载后仍可见（内层 remount 不丢失）
  const [flash, setFlash] = useState<string | null>(null);

  return (
    <ReportLoader
      key={`${String(repairRequestId)}:${String(reportId)}:${reloadToken}`}
      engineerName={engineerName}
      flash={flash}
      mode="HISTORICAL_CASE"
      onFlash={setFlash}
      repairRequestId={repairRequestId}
      reportId={reportId}
      onRetry={() => setReloadToken((token) => token + 1)}
    />
  );
}

function ReportLoader({
  engineerName,
  flash,
  onFlash,
  mode,
  repairRequestId,
  reportId,
  onRetry,
}: {
  engineerName: string;
  flash: string | null;
  onFlash: (message: string | null) => void;
  mode: MaintenanceReportEditorMode;
  repairRequestId: number | null;
  reportId: number | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<PageState> => {
      if (reportId !== null) {
        const detail = await fetchMyMaintenanceReport(reportId);
        return {
          kind: 'ready',
          loaded: {
            form: toReportFormFromDetail(detail),
            reportId: detail.report.id,
            currentVersionNo: detail.report.currentVersionNo,
            canEdit: detail.canEdit,
            status: detail.report.status,
            requestNo: null,
            attachments: detail.attachments,
          },
        };
      }

      return {
        kind: 'ready',
        loaded: {
          form: createEmptyReportForm(engineerName),
          reportId: null,
          currentVersionNo: 0,
          canEdit: true,
          status: null,
          requestNo: null,
          attachments: [],
        },
      };
    };

    void load()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'failed',
          message: isGraphQLIngressError(error)
            ? error.userMessage
            : t('maintenanceReport.loadFailed'),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [engineerName, mode, repairRequestId, reportId, t]);

  const title =
    mode === 'HISTORICAL_CASE'
      ? t('maintenanceReport.historical.title')
      : t('maintenanceReport.summary.title');

  if (state.kind === 'loading') {
    return (
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <PageHeader description={t('maintenanceReport.loading')} title={title} />
        <Spin />
      </Space>
    );
  }

  if (state.kind === 'failed') {
    return (
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <PageHeader title={title} />
        <Alert showIcon title={state.message} type="error" />
        <Button onClick={onRetry}>{t('maintenanceReport.retry')}</Button>
      </Space>
    );
  }

  return (
    <EditorBody
      flash={flash}
      loaded={state.loaded}
      mode={mode}
      onFlash={onFlash}
      onReload={onRetry}
      repairRequestId={repairRequestId}
    />
  );
}

function EditorBody({
  flash,
  loaded,
  mode,
  onFlash,
  onReload,
  repairRequestId,
}: {
  flash: string | null;
  loaded: LoadedState;
  mode: MaintenanceReportEditorMode;
  onFlash: (message: string | null) => void;
  onReload: () => void;
  repairRequestId: number | null;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [models, setModels] = useState<EquipmentModelOption[]>([]);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [createdReportId, setCreatedReportId] = useState<number | null>(null);
  const navigateAfterCreate = useRef(false);
  // R051-01：提交标识绑定内容摘要——同内容重试沿用，内容变化才生成新标识
  const submissionKeyRef = useRef<{ digest: string; id: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // R050-01/R045-02：未保存表单的待绑附件（先暂存，随首存/正式提交绑定）
  const [pendingAttachment, setPendingAttachment] = useState<StagedMaintenanceReportFile | null>(
    null,
  );
  // R051 导出：可编辑时导出当前表单（未保存也可导出）；冻结后导出已保存版本
  const [exportingFormat, setExportingFormat] = useState<MaintenanceReportExportFormat | null>(
    null,
  );
  const [exportError, setExportError] = useState<string | null>(null);

  const sourceType: MaintenanceReportSourceType =
    mode === 'HISTORICAL_CASE' ? 'HISTORICAL_CASE' : 'WORK_ORDER_SUMMARY';

  const session = useMaintenanceReportEditor({
    fallbackSaveError: t('maintenanceReport.saveFailed'),
    fallbackSubmitError: t('maintenanceReport.submitFailed'),
    initialForm: loaded.form,
    repairRequestId,
    reportId: loaded.reportId,
    sourceType,
  });

  useEffect(() => {
    let cancelled = false;
    void fetchMaintenanceEquipmentModels()
      .then((options) => {
        if (!cancelled) setModels(options);
      })
      .catch(() => {
        // 型号库只用于带出建议；失败时仍可手填型号
        if (!cancelled) setModelsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isDirty = session.dirty;
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        isDirty && currentLocation.pathname !== nextLocation.pathname,
      [isDirty],
    ),
  );

  useEffect(() => {
    if (!isDirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  useEffect(() => {
    if (createdReportId === null || !navigateAfterCreate.current) return;
    navigateAfterCreate.current = false;
    navigate(`${MAINTENANCE_RECORDS_PATH}/${createdReportId}`, { replace: true });
  }, [createdReportId, navigate]);

  // 附件集合（R062/R050）：本地跟随服务端事实刷新，不经过表单重载，
  // 避免附件操作把未保存的表单编辑丢弃
  const [attachments, setAttachments] = useState<MaintenanceReportAttachmentRecord[]>(
    loaded.attachments,
  );
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshAttachments = useCallback(async (reportId: number) => {
    const detail = await fetchMyMaintenanceReport(reportId);
    setAttachments(detail.attachments);
  }, []);

  const handleSaveDraft = useCallback(() => {
    setSaveError(null);
    setSaveMessage(null);
    // R050-01/R050-02/R062-01：首存绑定待绑附件，续填携带更换附件；
    // 失败不提示成功（pending 保留可重试），服务端同事务裁决不丢旧关联
    const attachment = pendingAttachment;
    void session.saveDraft({ attachment }).then((outcome) => {
      if (outcome.kind === 'saved') {
        setSaveMessage(t('maintenanceReport.saveSuccess'));
        setPendingAttachment(null);
        void refreshAttachments(outcome.reportId).catch(() => undefined);
        if (outcome.created && mode === 'HISTORICAL_CASE') {
          navigateAfterCreate.current = true;
          setCreatedReportId(outcome.reportId);
        }
        return;
      }
      if (outcome.kind === 'blocked') {
        setSaveError(t('maintenanceReport.issues.title'));
        return;
      }
      setSaveError(outcome.message);
    });
  }, [mode, pendingAttachment, refreshAttachments, session, t]);

  /**
   * 正式提交：首次发送前生成稳定标识并在响应丢失后沿用（重发不换新）。
   * 服务端按 (操作者, 公司, 提交标识) 幂等裁决；成功后重载进入只读冻结态。
   */
  const handleFormalSubmit = useCallback(() => {
    setSubmitError(null);
    setSaveMessage(null);
    onFlash(null);
    const digest = serializeReportForm(session.form);
    if (submissionKeyRef.current?.digest !== digest) {
      submissionKeyRef.current = {
        digest,
        id:
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `sub-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      };
    }
    void session
      .submitFormal({
        submissionRequestId: submissionKeyRef.current.id,
        expectedVersionNo: loaded.currentVersionNo,
        // R051-01/R062-01：直接提交绑定待绑附件；已存草稿更换原件随请求提交
        attachment: pendingAttachment,
      })
      .then((outcome) => {
        if (outcome.kind === 'submitted') {
          // 提交成功：内容冻结。外层提示 + 重载读取服务端事实，进入只读展示。
          setSaveError(null);
          setSubmitError(null);
          setPendingAttachment(null);
          onFlash(t('maintenanceReport.submitSuccess'));
          onReload();
          return;
        }
        if (outcome.kind === 'blocked') {
          setSubmitError(t('maintenanceReport.issues.title'));
          return;
        }
        // 失败保留原提交标识与待绑附件：同内容重发由服务端幂等裁决
        setSubmitError(outcome.message);
      });
  }, [loaded.currentVersionNo, onFlash, onReload, pendingAttachment, session, t]);

  const confirmDiscardBranch = useCallback(
    (label: string) =>
      window.confirm(
        t('maintenanceReport.discardBranchBody', {
          label,
        }),
      ),
    [t],
  );

  /**
   * R051 导出：可编辑时导出当前表单（未保存草稿也可导出，服务端只读核验）；
   * 冻结后导出已保存的当前版本。服务端拒绝（无权/缺项/附件不可用）时展示原因。
   */
  const handleExport = useCallback(
    (format: MaintenanceReportExportFormat) => {
      if (exportingFormat !== null) return;
      if (loaded.reportId === null && !loaded.canEdit) return;
      setExportError(null);
      setExportingFormat(format);
      void (async () => {
        try {
          const result = await exportMaintenanceReport(
            loaded.canEdit
              ? {
                  format,
                  currentForm: {
                    sourceType,
                    repairRequestId,
                    draft: toReportDraftInput(session.form),
                  },
                }
              : {
                  format,
                  savedVersion: { reportId: loaded.reportId as number },
                },
          );
          downloadMaintenanceReportExport(result);
        } catch (error) {
          setExportError(
            isGraphQLIngressError(error)
              ? (readGraphQLErrorDetail(error)?.errorMessage ?? error.userMessage)
              : t('maintenanceReport.export.failed'),
          );
        } finally {
          setExportingFormat(null);
        }
      })();
    },
    [
      exportingFormat,
      loaded.canEdit,
      loaded.reportId,
      repairRequestId,
      session.form,
      sourceType,
      t,
    ],
  );

  const summary = useMemo(() => {
    if (loaded.requestNo === null) return null;
    return t('maintenanceReport.workOrder', { requestNo: loaded.requestNo });
  }, [loaded.requestNo, t]);

  /**
   * 选择文件 → 任务 11 上传暂存。
   * R062-01：单份报告最多 1 份有效原件——
   * - 未保存表单：仅本地暂存待绑（首存/提交随请求绑定）；
   * - 已保存且尚无有效原件：立即挂接（独立事务）；
   * - 已保存且已有有效原件：新原件作为「更换」本地暂存，保存/提交时由服务端
   *   同事务先退役旧关联再绑定新原件，任一步失败旧关联不丢失。
   */
  const handleAttachmentUpload = useCallback(
    async (file: File) => {
      if (attachmentBusy) return;
      setAttachmentError(null);
      setAttachmentBusy(true);
      try {
        const uploaded = await uploadMaintenanceReportOriginal(file);
        if (!uploaded.ok) {
          setAttachmentError(uploaded.message);
          return;
        }
        if (loaded.reportId === null || attachments.length > 0) {
          if (pendingAttachment !== null) {
            setAttachmentError(t('maintenanceReport.attachments.pendingReplaced'));
          }
          setPendingAttachment(uploaded.file);
          return;
        }
        const attached = await addMaintenanceReportAttachment({
          reportId: loaded.reportId,
          file: uploaded.file,
        });
        if (!attached.ok) {
          // 暂存成功但绑定失败：原件保持暂存可追踪，明确提示而非静默
          setAttachmentError(attached.message);
          return;
        }
        await refreshAttachments(loaded.reportId);
      } catch {
        setAttachmentError(t('maintenanceReport.attachments.uploadFailed'));
      } finally {
        setAttachmentBusy(false);
        if (fileInputRef.current !== null) fileInputRef.current.value = '';
      }
    },
    [attachmentBusy, attachments.length, loaded.reportId, pendingAttachment, refreshAttachments, t],
  );

  const handleAttachmentRemove = useCallback(
    async (attachmentId: number) => {
      if (loaded.reportId === null || attachmentBusy) return;
      setAttachmentError(null);
      setAttachmentBusy(true);
      try {
        const removed = await removeMaintenanceReportAttachment({
          reportId: loaded.reportId,
          attachmentId,
        });
        if (!removed.ok) {
          setAttachmentError(removed.message);
          return;
        }
        await refreshAttachments(loaded.reportId);
      } catch {
        setAttachmentError(t('maintenanceReport.attachments.removeFailed'));
      } finally {
        setAttachmentBusy(false);
      }
    },
    [attachmentBusy, loaded.reportId, refreshAttachments, t],
  );

  /** R062-03 授权下载：服务端按报告附件归属裁决，失败给明确文案 */
  const handleAttachmentDownload = useCallback(
    async (attachment: MaintenanceReportAttachmentRecord) => {
      if (attachment.fileId === null) return;
      setAttachmentError(null);
      try {
        const result = await downloadMaintenanceReportAttachment({
          fileId: attachment.fileId,
          fallbackFilename: attachment.originalFilename,
        });
        if (!result.ok) {
          setAttachmentError(result.message);
          return;
        }
        downloadBlobAsFile(result.blob, result.filename);
      } catch {
        setAttachmentError(t('maintenanceReport.attachments.downloadFailed'));
      }
    },
    [t],
  );

  return (
    <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      <PageHeader
        title={
          mode === 'HISTORICAL_CASE'
            ? t('maintenanceReport.historical.title')
            : t('maintenanceReport.summary.title')
        }
        description={
          mode === 'HISTORICAL_CASE'
            ? t('maintenanceReport.historical.subtitle')
            : t('maintenanceReport.summary.subtitle')
        }
        extra={
          <Space>
            <Button
              onClick={() =>
                void navigate(
                  mode === 'HISTORICAL_CASE' ? MAINTENANCE_RECORDS_PATH : WORK_ORDER_SUMMARIES_PATH,
                )
              }
            >
              {/* 2026-11-21 需求调整：新建页（未保存草稿）的入口按钮即「我的历史记录」，
                  首存 replace 到详情后恢复「返回列表」；列表页保留「新建历史记录」按钮，
                  不形成循环跳转 */}
              {mode === 'HISTORICAL_CASE' && loaded.reportId === null
                ? t('maintenanceReport.myHistory')
                : t('maintenanceReport.backToList')}
            </Button>
          </Space>
        }
      />

      {summary === null ? null : <Typography.Text type="secondary">{summary}</Typography.Text>}
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Space wrap>
          <Button
            disabled={exportingFormat !== null}
            loading={exportingFormat === 'DOCX'}
            onClick={() => handleExport('DOCX')}
          >
            {t('maintenanceReport.export.word')}
          </Button>
          <Button
            disabled={exportingFormat !== null}
            loading={exportingFormat === 'PDF'}
            onClick={() => handleExport('PDF')}
          >
            {t('maintenanceReport.export.pdf')}
          </Button>
          <Typography.Text type="secondary">
            {loaded.canEdit
              ? t('maintenanceReport.export.currentFormHint')
              : t('maintenanceReport.export.frozenHint')}
          </Typography.Text>
        </Space>
        {exportError === null ? null : <Alert showIcon title={exportError} type="error" />}
      </Space>
      {modelsFailed ? (
        <Alert type="warning" showIcon title={t('maintenanceReport.modelsUnavailable')} />
      ) : null}

      <MaintenanceReportFormView
        canEdit={loaded.canEdit}
        form={session.form}
        issues={session.issues}
        models={models}
        saveError={saveError ?? submitError}
        saveMessage={flash ?? saveMessage}
        saving={session.saving}
        onChange={session.setForm}
        onConfirmDiscardBranch={confirmDiscardBranch}
        onSubmitFormal={loaded.canEdit ? handleFormalSubmit : undefined}
        onSaveDraft={handleSaveDraft}
        submitting={session.saving}
      />

      {/* R062/R050 附件（可选，单份报告最多 1 份有效原件）：未保存表单先暂存待绑，
          首存/提交随请求绑定；已保存无原件走挂接接口，已有原件走同事务更换；
          本人可随时授权下载 */}
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Text strong>{t('maintenanceReport.attachments.title')}</Typography.Text>
          {loaded.canEdit ? (
            <>
              <input
                hidden
                multiple={false}
                ref={fileInputRef}
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void handleAttachmentUpload(file);
                }}
              />
              <Button
                disabled={attachmentBusy}
                loading={attachmentBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('maintenanceReport.attachments.add')}
              </Button>
              <Typography.Text type="secondary">
                {t('maintenanceReport.attachments.hint')}
              </Typography.Text>
            </>
          ) : null}
        </Space>
        {attachmentError === null ? null : <Alert showIcon title={attachmentError} type="error" />}
        {/* 待绑/更换附件：仅本地暂存事实展示，随保存/提交由服务端同事务绑定或更换 */}
        {pendingAttachment === null ? null : (
          <Space wrap>
            {attachments.length > 0 ? (
              <Tag color="orange">{t('maintenanceReport.attachments.pendingReplaceTag')}</Tag>
            ) : null}
            <Typography.Text>
              {pendingAttachment.originalFilename}（{pendingAttachment.mimeType} ·{' '}
              {pendingAttachment.byteSize} B）
            </Typography.Text>
            <Button danger size="small" onClick={() => setPendingAttachment(null)}>
              {t('maintenanceReport.attachments.pendingDiscard')}
            </Button>
          </Space>
        )}
        {pendingAttachment !== null && attachments.length > 0 ? (
          <Typography.Text type="secondary">
            {t('maintenanceReport.attachments.replaceHint')}
          </Typography.Text>
        ) : null}
        {loaded.reportId === null ? null : (
          <Space orientation="vertical" size="small" style={{ width: '100%' }}>
            {attachments.length === 0 ? (
              <Typography.Text type="secondary">
                {t('maintenanceReport.attachments.empty')}
              </Typography.Text>
            ) : (
              attachments.map((attachment) => (
                <Space key={attachment.id} wrap>
                  <Typography.Text>
                    {attachment.originalFilename}（{attachment.mimeType} · {attachment.byteSize} B）
                  </Typography.Text>
                  {attachment.fileId !== null ? (
                    <Button size="small" onClick={() => void handleAttachmentDownload(attachment)}>
                      {t('maintenanceReport.attachments.download')}
                    </Button>
                  ) : null}
                  {loaded.canEdit ? (
                    <Button
                      danger
                      disabled={attachmentBusy}
                      size="small"
                      onClick={() => void handleAttachmentRemove(attachment.id)}
                    >
                      {t('maintenanceReport.attachments.remove')}
                    </Button>
                  ) : null}
                </Space>
              ))
            )}
          </Space>
        )}
      </Space>

      <Modal
        cancelText={t('maintenanceReport.continueEdit')}
        okText={t('maintenanceReport.confirmLeave')}
        open={blocker.state === 'blocked'}
        title={t('maintenanceReport.leaveConfirmTitle')}
        onCancel={() => {
          if (blocker.state === 'blocked') blocker.reset();
        }}
        onOk={() => {
          if (blocker.state === 'blocked') blocker.proceed();
        }}
      >
        {t('maintenanceReport.leaveConfirmBody')}
      </Modal>
    </Space>
  );
}

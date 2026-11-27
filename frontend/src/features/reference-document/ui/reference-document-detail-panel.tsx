// src/features/reference-document/ui/reference-document-detail-panel.tsx

import { useState } from 'react';
import type { TableColumnsType } from 'antd';
import { Alert, Button, Card, Descriptions, Input, Modal, Skeleton, Space, Table } from 'antd';
import { useNavigate } from 'react-router';

import type { MessageKey, Translate } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { useMessageFeedback } from '@/shared/ui/message-feedback';

import { useReferenceDocumentDetail } from '../application/use-reference-document-detail';
import { useReferenceDocumentRevisions } from '../application/use-reference-document-revisions';
import type {
  ReferenceDocumentDetail,
  ReferenceDocumentFrozenAlarm,
  ReferenceDocumentFrozenReport,
  ReferenceDocumentFrozenStep,
  ReferenceDocumentStructuredContent,
} from '../infrastructure/reference-document.types';
import {
  REFERENCE_DOCUMENT_TYPE_LABELS,
  type ReferenceDocumentSourceKind,
} from '../infrastructure/reference-document.types';
import {
  adminDeleteReferenceDocument,
  correctReferenceDocumentOwnership,
  deleteReferenceDocument,
  offlineReferenceDocument,
} from '../infrastructure/reference-document-adapter';
import {
  downloadReferenceDocumentFile,
  downloadReferenceDocumentSourceAttachment,
} from '../infrastructure/reference-document-http-adapter';

import {
  ADMIN_PENDING_OWNERSHIP_LIST_PATH,
  buildAdminReferenceRevisePath,
  REFERENCE_DOCUMENTS_LIST_PATH,
} from './reference-document-paths';

const SOURCE_KIND_LABEL_KEYS: Record<ReferenceDocumentSourceKind, MessageKey> = {
  INDEPENDENT_REPORT: 'refDocDetail.sourceKind.INDEPENDENT_REPORT',
  WORK_ORDER_SUMMARY: 'refDocDetail.sourceKind.WORK_ORDER_SUMMARY',
  MATERIAL: 'refDocDetail.sourceKind.MATERIAL',
};

const CONTENT_SOURCE_LABEL_KEYS: Record<string, MessageKey> = {
  ORIGINAL: 'refDocDetail.contentSource.ORIGINAL',
  FROZEN_REPORT: 'refDocDetail.contentSource.FROZEN_REPORT',
  CURRENT_REVISION: 'refDocDetail.contentSource.CURRENT_REVISION',
};

const FAULT_BRANCH_LABEL_KEYS: Record<string, MessageKey> = {
  INITIAL: 'refDocDetail.branch.INITIAL',
  RESET_NEW_FAULT: 'refDocDetail.branch.RESET_NEW_FAULT',
  STEP_NEW_FAULT: 'refDocDetail.branch.STEP_NEW_FAULT',
};

const RESET_RESULT_LABEL_KEYS: Record<string, MessageKey> = {
  NORMAL: 'refDocDetail.resetResult.NORMAL',
  SAME_FAULT: 'refDocDetail.resetResult.SAME_FAULT',
  NEW_FAULT: 'refDocDetail.resetResult.NEW_FAULT',
};

const HANDLING_RESULT_LABEL_KEYS: Record<string, MessageKey> = {
  FIXED: 'refDocDetail.handlingResult.FIXED',
  PART_PURCHASED: 'refDocDetail.handlingResult.PART_PURCHASED',
  PROVIDE_PLAN_SELF_EXECUTE: 'refDocDetail.handlingResult.PROVIDE_PLAN_SELF_EXECUTE',
  INTERRUPTED: 'refDocDetail.handlingResult.INTERRUPTED',
  UNREPAIRABLE: 'refDocDetail.handlingResult.UNREPAIRABLE',
};

/**
 * 历史维修记录详情面板（任务 07）。
 *
 * - 历史读取（生效正文 / 历史版本 / 授权下载）保持只读口径，服务端按同一可见范围复核；
 * - 管理动作按新规则拆分（R053/R058–R061）：
 *   · 一级管理员：管理修订 / 下架 / 管理删除 / 归属更正（页面 §9.3–§9.4）；
 *   · 原作者：详情顶部唯一红色「删除资料」（R053；正式内容只读，不可编辑成品）；
 *   · 下架与管理删除分别确认，不共用入口；全部携带 expected_version，
 *     过期由后端拒绝（CONFLICT → version-conflict 提示重读）；
 *   · 权限仅用于入口显隐，服务端仍按角色 + 等级事实 + 归属裁决。
 */
export type ReferenceDocumentViewer = {
  /** 会话角色（页面层从 auth-session 会话视图映射；功能层不反向依赖会话模块） */
  role: 'SUPER_ADMIN' | 'ENGINEER' | 'CUSTOMER' | null;
  /** 管理员等级（非管理员为 null） */
  adminLevel: number | null;
};

/**
 * 详情面板变体：
 * - `library`（默认）：普通资料库详情；
 * - `pending-ownership`：归属待核实详情（任务 07 R061-01，一级管理员专用入口），
 *   走服务端专用查询；返回目标为归属待核实清单，且历史版本卡不渲染
 *   （历史版本查询与普通详情共用可见范围，对 PENDING 条目统一 NOT_FOUND）。
 */
export type ReferenceDocumentDetailPanelVariant = 'library' | 'pending-ownership';

export function ReferenceDocumentDetailPanel({
  documentId,
  viewer,
  variant = 'library',
}: {
  documentId: number | null;
  viewer: ReferenceDocumentViewer;
  variant?: ReferenceDocumentDetailPanelVariant;
}) {
  const navigate = useNavigate();
  const notify = useMessageFeedback();
  const { t } = useI18n();
  const { state, reload } = useReferenceDocumentDetail(documentId, variant);
  const revisions = useReferenceDocumentRevisions(
    variant === 'pending-ownership' ? null : documentId,
  );
  const [downloading, setDownloading] = useState(false);
  const [downloadingSource, setDownloadingSource] = useState(false);
  const backPath =
    variant === 'pending-ownership'
      ? ADMIN_PENDING_OWNERSHIP_LIST_PATH
      : REFERENCE_DOCUMENTS_LIST_PATH;

  if (state.status === 'loading') {
    return <Skeleton active paragraph={{ rows: 8 }} />;
  }

  if (state.status === 'not-found') {
    return (
      <Alert
        action={
          <Button onClick={() => navigate(backPath)} size="small">
            {t('refDocDetail.action.backToList')}
          </Button>
        }
        showIcon
        title={state.message}
        type="warning"
      />
    );
  }

  if (state.status === 'failed') {
    return (
      <Alert
        action={
          <Button onClick={reload} size="small">
            {t('common.retry')}
          </Button>
        }
        showIcon
        title={state.message}
        type="error"
      />
    );
  }

  const { detail } = state;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const result = await downloadReferenceDocumentFile(detail.id);
      if (!result.ok) {
        notify({ text: result.message, type: 'error' });
        return;
      }
      triggerBrowserSave(result.blob, result.filename);
    } finally {
      setDownloading(false);
    }
  };

  // 任务 07 P2：报告来源资料展示并可下载其来源报告冻结版本的原件；
  // 无可下载原件（sourceReportAttachment 为空）时不显示入口
  const sourceAttachment = variant === 'library' ? (detail.sourceReportAttachment ?? null) : null;

  const handleDownloadSourceAttachment = async () => {
    if (sourceAttachment === null) {
      return;
    }
    setDownloadingSource(true);
    try {
      const result = await downloadReferenceDocumentSourceAttachment(
        detail.id,
        sourceAttachment.attachmentId,
      );
      if (!result.ok) {
        notify({ text: result.message, type: 'error' });
        return;
      }
      triggerBrowserSave(result.blob, result.filename);
    } finally {
      setDownloadingSource(false);
    }
  };

  const frozenReport = detail.frozenReport;

  return (
    <div className="reference-document-detail flex flex-col gap-4">
      <Card
        extra={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate(backPath)} size="small">
              {t('refDocDetail.action.backToList')}
            </Button>
            {detail.hasFile ? (
              <Button
                loading={downloading}
                onClick={() => void handleDownload()}
                size="small"
                type="primary"
              >
                {t('refDocDetail.action.downloadFile')}
              </Button>
            ) : null}
            {sourceAttachment !== null ? (
              <Button
                loading={downloadingSource}
                onClick={() => void handleDownloadSourceAttachment()}
                size="small"
                title={sourceAttachment.originalFilename}
                type="primary"
              >
                {t('refDocDetail.action.downloadSourceReportFile')}
              </Button>
            ) : null}
          </div>
        }
        title={<span title={detail.title}>{detail.title}</span>}
      >
        <div className="flex flex-col gap-4">
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label={t('refDocDetail.label.source')}>
              {t(SOURCE_KIND_LABEL_KEYS[detail.sourceKind] ?? 'refDocDetail.sourceKind.MATERIAL')}
              {detail.sourceReportVersionId !== null
                ? t('refDocDetail.label.sourceFrozenVersion', { id: detail.sourceReportVersionId })
                : ''}
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.effectiveVersion')}>
              {detail.effectiveRevisionNo > 0
                ? t('refDocDetail.label.managedRevision', { no: detail.effectiveRevisionNo })
                : detail.contentSource === 'FROZEN_REPORT'
                  ? t('refDocDetail.contentSource.FROZEN_REPORT')
                  : t('refDocDetail.label.originalContent')}
              <span className="text-text-secondary ml-2">
                （
                {t(
                  CONTENT_SOURCE_LABEL_KEYS[detail.contentSource] ??
                    'refDocDetail.contentSource.ORIGINAL',
                )}
                ）
              </span>
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.documentType')}>
              {REFERENCE_DOCUMENT_TYPE_LABELS[detail.documentType] ?? detail.documentType}
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.equipmentModel')}>
              {detail.equipmentModelId === null
                ? t('refDocDetail.label.generalMaterial')
                : detail.equipmentModelName}
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.organization')}>
              {detail.organizationName}
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.description')}>
              {detail.description ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.originalFilename')}>
              {detail.originalFilename ?? t('refDocDetail.label.noAttachment')}
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.uploader')}>
              {detail.creatorNickname}
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.createdAt')}>
              {formatDateTimeText(detail.createdAt)}
            </Descriptions.Item>
            <Descriptions.Item label={t('refDocDetail.label.updatedAt')}>
              {formatDateTimeText(detail.updatedAt)}
            </Descriptions.Item>
          </Descriptions>

          {frozenReport !== null && detail.contentSource === 'FROZEN_REPORT' ? (
            // 报告来源且无管理修订：生效内容 = 原始冻结报告（含任务 06 扩展键的
            // 故障面板与维修结果展示，任务 04 旧快照对应区块为空态）
            <FrozenReportBlock report={frozenReport} t={t} />
          ) : detail.contentSource === 'CURRENT_REVISION' && detail.structuredContent !== null ? (
            // 生效管理修订携带结构化内容键：结构化展示生效版本，原始冻结报告
            // 保留在下方作为授权追溯（不随管理修订替换）
            <>
              <StructuredRevisionBlock content={detail.structuredContent} t={t} />
              {frozenReport !== null ? (
                <div>
                  <div className="text-text-secondary mb-2 text-sm">
                    {t('refDocDetail.note.structuredTrace')}
                  </div>
                  <FrozenReportBlock report={frozenReport} t={t} />
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div>
                <div className="mb-2 font-medium">{t('refDocDetail.label.effectiveContent')}</div>
                {detail.contentText !== null && detail.contentText.length > 0 ? (
                  <pre className="whitespace-pre-wrap break-words text-sm">
                    {detail.contentText}
                  </pre>
                ) : (
                  <div className="text-text-secondary text-sm">
                    {t('refDocDetail.empty.contentText')}
                  </div>
                )}
              </div>
              {frozenReport !== null ? (
                <div>
                  <div className="text-text-secondary mb-2 text-sm">
                    {t('refDocDetail.note.flatTrace')}
                  </div>
                  <FrozenReportBlock report={frozenReport} t={t} />
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>

      {variant === 'library' ? (
        <Card size="small" title={t('refDocDetail.section.revisions')}>
          {revisions.state.status === 'loading' ? (
            <Skeleton active paragraph={{ rows: 2 }} />
          ) : null}
          {revisions.state.status === 'failed' ? (
            <Alert showIcon title={revisions.state.message} type="error" />
          ) : null}
          {revisions.state.status === 'ready' ? (
            <div className="flex flex-col gap-2">
              <div className="text-text-secondary text-sm">
                {t('refDocDetail.label.currentEffective')}
                {revisions.state.revisions.currentRevisionNo > 0
                  ? t('refDocDetail.label.managedRevision', {
                      no: revisions.state.revisions.currentRevisionNo,
                    })
                  : revisions.state.revisions.sourceReportVersionId !== null
                    ? t('refDocDetail.label.frozenVersionWithId', {
                        id: revisions.state.revisions.sourceReportVersionId,
                      })
                    : t('refDocDetail.label.originalContent')}
              </div>
              {revisions.state.revisions.revisions.length > 0 ? (
                <Table
                  columns={makeRevisionColumns(t)}
                  dataSource={revisions.state.revisions.revisions}
                  expandable={{
                    expandedRowRender: (record) =>
                      record.contentText !== null && record.contentText.length > 0 ? (
                        <pre className="whitespace-pre-wrap break-words text-sm">
                          {record.contentText}
                        </pre>
                      ) : (
                        <div className="text-text-secondary text-sm">
                          {t('refDocDetail.empty.revisionContent')}
                        </div>
                      ),
                    rowExpandable: () => true,
                  }}
                  pagination={false}
                  rowKey="revisionNo"
                  size="small"
                />
              ) : (
                <div className="text-text-secondary text-sm">
                  {t('refDocDetail.empty.revisions')}
                </div>
              )}
            </div>
          ) : null}
        </Card>
      ) : null}

      <ReferenceDocumentManagementSection
        detail={detail}
        expectedVersion={detail.effectiveRevisionNo}
        onChanged={reload}
        onDeleted={() => navigate(backPath)}
        onRevise={() => navigate(buildAdminReferenceRevisePath(detail.id))}
        t={t}
        viewer={viewer}
      />
    </div>
  );
}

function makeRevisionColumns(t: Translate): TableColumnsType<{
  revisionNo: number;
  reason: string;
  actorNickname: string;
  createdAt: string;
  contentText: string | null;
}> {
  return [
    {
      dataIndex: 'revisionNo',
      key: 'revisionNo',
      title: t('refDocDetail.column.revisionNo'),
      width: 100,
      render: (value: number) => `v${value}`,
    },
    { dataIndex: 'reason', key: 'reason', title: t('refDocDetail.column.reason') },
    {
      dataIndex: 'actorNickname',
      key: 'actorNickname',
      title: t('refDocDetail.column.actor'),
      width: 140,
    },
    {
      dataIndex: 'createdAt',
      key: 'createdAt',
      title: t('refDocDetail.column.revisedAt'),
      width: 180,
      render: (value: string) => formatDateTimeText(value),
    },
  ];
}

type ManagedMutationOutcome = {
  ok: boolean;
  reason?: string;
  message?: string;
};

/** 管理操作错误提示（domain failure 显式结果 → 统一文案；transport 失败上抛由全局层兜底） */
function describeManagedFailure(
  result: ManagedMutationOutcome,
  fallback: string,
  t: Translate,
): string {
  if (result.reason === 'version-conflict') {
    return t('refDocDetail.error.versionConflict');
  }
  return result.message ?? fallback;
}

/**
 * 管理操作区（任务 07 R053/R058–R061）。
 *
 * - 一级管理员：「管理修订」进入独立管理修订页（结构化报告复用任务 04 编辑器，
 *   扁平正文沿用既有修订语义）；归属更正为行内表单（原因必填，前端拦截空提交）；
 *   下架 / 管理删除为 Modal 独立确认（页面 V6.5 §9.3「分别确认」），两个动作
 *   各自独立状态、不能串用；原作者「删除资料」为第三个独立确认（R053）；
 * - 取消确认（Modal onCancel）只关闭弹窗：不发出 mutation、不改变任何页面状态；
 * - 确认后沿用既有链路：expected_version 取自详情生效版本号，失败提示与
 *   成功跳转不变；busy 期间 OK 钮 loading 且二次 onOk 直接忽略（防重复提交）；
 * - 显隐仅由会话角色与 viewerIsOriginalAuthor 决定，授权由服务端最终裁决。
 */
type DangerousConfirmAction = 'offline' | 'admin-delete' | 'author-delete';

const DANGEROUS_CONFIRM_META: Record<
  DangerousConfirmAction,
  {
    danger: boolean;
    okTextKey: MessageKey;
    requiresReason: boolean;
    titleKey: MessageKey;
    warningKey: MessageKey;
  }
> = {
  offline: {
    danger: false,
    okTextKey: 'refDocDetail.confirm.okOffline',
    requiresReason: true,
    titleKey: 'refDocDetail.confirm.offlineTitle',
    warningKey: 'refDocDetail.confirm.offlineWarning',
  },
  'admin-delete': {
    danger: true,
    okTextKey: 'common.confirmDelete',
    requiresReason: true,
    titleKey: 'refDocDetail.confirm.adminDeleteTitle',
    warningKey: 'refDocDetail.confirm.adminDeleteWarning',
  },
  'author-delete': {
    danger: true,
    okTextKey: 'common.confirmDelete',
    requiresReason: false,
    titleKey: 'refDocDetail.confirm.authorDeleteTitle',
    warningKey: 'refDocDetail.confirm.authorDeleteWarning',
  },
};

function ReferenceDocumentManagementSection({
  detail,
  expectedVersion,
  onChanged,
  onDeleted,
  onRevise,
  t,
  viewer,
}: {
  detail: ReferenceDocumentDetail;
  expectedVersion: number;
  onChanged: () => void;
  onDeleted: () => void;
  onRevise: () => void;
  t: Translate;
  viewer: ReferenceDocumentViewer;
}) {
  const notify = useMessageFeedback();
  const [busy, setBusy] = useState(false);
  const [openAction, setOpenAction] = useState<'ownership' | null>(null);
  const [confirmAction, setConfirmAction] = useState<DangerousConfirmAction | null>(null);
  const [reason, setReason] = useState('');
  const [ownerAccountId, setOwnerAccountId] = useState('');
  const [ownerOrganizationId, setOwnerOrganizationId] = useState('');

  const isLevelOneAdmin = viewer.role === 'SUPER_ADMIN' && viewer.adminLevel === 1;
  const isAuthor = viewer.role !== null && detail.viewerIsOriginalAuthor;

  if (!isLevelOneAdmin && !isAuthor) {
    return null;
  }

  /** 管理动作成功后返回 true（供 Modal 确认流决定是否关闭），失败/空校验返回 false */
  const runManaged = async (
    action: () => Promise<ManagedMutationOutcome>,
    successKey: MessageKey,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        notify({ text: describeManagedFailure(result, t(successKey), t), type: 'error' });
        return false;
      }
      notify({ text: t(successKey), type: 'success' });
      onChanged();
      return true;
    } finally {
      setBusy(false);
    }
  };

  /** 原因必填前端拦截（页面 V6.5 §9.3–§9.4）：空白原因不发 mutation */
  const ensureReasonFilled = (): boolean => {
    if (reason.trim().length === 0) {
      notify({ text: t('refDocDetail.error.reasonRequired'), type: 'error' });
      return false;
    }
    return true;
  };

  const executeOffline = async (): Promise<boolean> => {
    if (!ensureReasonFilled()) {
      return false;
    }
    return runManaged(
      () => offlineReferenceDocument(detail.id, expectedVersion, reason.trim()),
      'refDocDetail.success.offline',
    );
  };

  const executeAdminDelete = async (): Promise<boolean> => {
    if (!ensureReasonFilled()) {
      return false;
    }
    return runManaged(
      () => adminDeleteReferenceDocument(detail.id, expectedVersion, reason.trim()),
      'refDocDetail.success.adminDelete',
    );
  };

  const executeOwnership = async (): Promise<boolean> => {
    if (!ensureReasonFilled()) {
      return false;
    }
    const input: {
      verificationReason: string;
      createdByAccountId?: number;
      ownerOrganizationId?: number;
    } = {
      verificationReason: reason.trim(),
    };
    if (ownerAccountId.trim().length > 0) {
      input.createdByAccountId = Number(ownerAccountId.trim());
    }
    if (ownerOrganizationId.trim().length > 0) {
      input.ownerOrganizationId = Number(ownerOrganizationId.trim());
    }
    return runManaged(
      () => correctReferenceDocumentOwnership(detail.id, expectedVersion, input),
      'refDocDetail.success.ownership',
    );
  };

  const handleOwnership = () => {
    void executeOwnership();
  };

  const executeAuthorDelete = async (): Promise<boolean> =>
    runManaged(
      () =>
        deleteReferenceDocument(detail.id, expectedVersion).then((result) => {
          if (result.ok) {
            onDeleted();
          }
          return result;
        }),
      'refDocDetail.success.authorDelete',
    );

  /** Modal 确认流：busy 期间忽略重复 onOk；动作完成且成功后才关闭弹窗 */
  const runConfirmedDangerousAction = async (): Promise<void> => {
    if (busy || confirmAction === null) {
      return;
    }
    const finished =
      confirmAction === 'offline'
        ? await executeOffline()
        : confirmAction === 'admin-delete'
          ? await executeAdminDelete()
          : await executeAuthorDelete();
    if (finished) {
      setConfirmAction(null);
    }
  };

  const reasonInput = (
    <Input.TextArea
      maxLength={500}
      onChange={(event) => setReason(event.target.value)}
      placeholder={t('refDocDetail.placeholder.reason')}
      rows={2}
      value={reason}
    />
  );

  const confirmMeta = confirmAction !== null ? DANGEROUS_CONFIRM_META[confirmAction] : null;

  return (
    <Card size="small" title={t('refDocDetail.section.management')}>
      <div className="flex flex-col gap-3">
        {isLevelOneAdmin ? (
          <>
            <Space wrap>
              <Button onClick={onRevise}>{t('refDocDetail.action.revise')}</Button>
              <Button onClick={() => setConfirmAction('offline')}>
                {t('refDocDetail.action.offline')}
              </Button>
              <Button danger onClick={() => setConfirmAction('admin-delete')}>
                {t('refDocDetail.action.delete')}
              </Button>
              <Button
                onClick={() => setOpenAction(openAction === 'ownership' ? null : 'ownership')}
              >
                {t('refDocDetail.action.ownership')}
              </Button>
            </Space>

            {openAction === 'ownership' ? (
              <div className="flex flex-col gap-2">
                <Input
                  onChange={(event) => setOwnerAccountId(event.target.value)}
                  placeholder={t('refDocDetail.placeholder.ownerAccountId')}
                  value={ownerAccountId}
                />
                <Input
                  onChange={(event) => setOwnerOrganizationId(event.target.value)}
                  placeholder={t('refDocDetail.placeholder.ownerOrganizationId')}
                  value={ownerOrganizationId}
                />
                {reasonInput}
                <Button loading={busy} onClick={handleOwnership} type="primary">
                  {t('refDocDetail.action.saveOwnership')}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {isAuthor ? (
          <div className="flex flex-col gap-2">
            {isLevelOneAdmin ? null : (
              <div className="text-text-secondary text-sm">
                {t('refDocDetail.note.readonlyForAuthor')}
              </div>
            )}
            <Button danger onClick={() => setConfirmAction('author-delete')} type="primary">
              {t('refDocDetail.action.delete')}
            </Button>
          </div>
        ) : null}
      </div>

      {confirmMeta !== null ? (
        <Modal
          cancelText={t('common.cancel')}
          confirmLoading={busy}
          okButtonProps={{ danger: confirmMeta.danger }}
          okText={t(confirmMeta.okTextKey)}
          onCancel={() => {
            // 取消确认：只关闭弹窗，不发出 mutation，不改变任何页面状态
            setConfirmAction(null);
          }}
          onOk={() => {
            void runConfirmedDangerousAction();
          }}
          open={confirmAction !== null}
          title={t(confirmMeta.titleKey)}
        >
          <div className="flex flex-col gap-3">
            <Alert showIcon title={t(confirmMeta.warningKey)} type="warning" />
            {confirmMeta.requiresReason ? reasonInput : null}
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

/** 故障面板只读卡：Main Error/Unit Error/Source/Error Type/GPIB Status/Status/Action 全字段展示 */
function StructuredFaultCard({
  fault,
  t,
}: {
  fault: ReferenceDocumentStructuredContent['faults'][number];
  t: Translate;
}) {
  const fields: Array<[string, string | null]> = [
    ['Main Error', fault.mainError],
    ['Unit Error', fault.unitError],
    ['Source', fault.source],
    ['Error Type', fault.errorType],
    ['GPIB Status', fault.gpibStatus],
    ['Status', fault.faultStatus],
    [t('refDocDetail.column.phase'), fault.phaseCode],
  ];
  const branchLabel = t(FAULT_BRANCH_LABEL_KEYS[fault.branchKind] ?? 'refDocDetail.branch.INITIAL');
  const cardTitle =
    fault.branchKind === 'STEP_NEW_FAULT' && fault.stepCode !== null
      ? `${branchLabel} ${t('refDocDetail.faultCard.stepSuffix', { step: fault.stepCode })}`
      : branchLabel;
  return (
    <Card size="small" title={cardTitle}>
      <div className="flex flex-col gap-1 text-sm">
        <div>{fault.description}</div>
        {fields
          .filter(([, value]) => value !== null && value !== '')
          .map(([label, value]) => (
            <div key={label} className="text-text-secondary">
              {label}：{value}
            </div>
          ))}
        {fault.action !== null && fault.action !== '' ? <div>Action：{fault.action}</div> : null}
      </div>
    </Card>
  );
}

/** 结构化故障区（冻结报告与管理修订共用） */
function StructuredFaultsSection({
  faults,
  t,
}: {
  faults: ReferenceDocumentStructuredContent['faults'];
  t: Translate;
}) {
  return (
    <div>
      <div className="mb-2 font-medium">{t('refDocDetail.section.faults')}</div>
      {faults.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-2">
          {faults.map((fault, index) => (
            <StructuredFaultCard fault={fault} key={`fault-${index}`} t={t} />
          ))}
        </div>
      ) : (
        <div className="text-text-secondary text-sm">{t('refDocDetail.empty.faults')}</div>
      )}
    </div>
  );
}

/** 维修结果区（处理结果/中断原因/根因/动作/验证/补充说明，仅有值字段） */
function StructuredResultSection({
  actualCause,
  closureReason,
  handlingResult,
  repairActions,
  supplementaryNote,
  t,
  verificationResult,
}: {
  actualCause: string | null;
  closureReason: string | null;
  handlingResult: string | null;
  repairActions: string | null;
  supplementaryNote: string | null;
  t: Translate;
  verificationResult: string | null;
}) {
  const rows: Array<[string, string | null]> = [
    [
      t('refDocDetail.field.handlingResult'),
      handlingResult === null
        ? null
        : t(HANDLING_RESULT_LABEL_KEYS[handlingResult] ?? 'refDocDetail.handlingResult.FIXED'),
    ],
    [t('refDocDetail.field.closureReason'), closureReason],
    [t('refDocDetail.field.actualCause'), actualCause],
    [t('refDocDetail.field.repairActions'), repairActions],
    [t('refDocDetail.field.verificationResult'), verificationResult],
    [t('refDocDetail.field.supplementaryNote'), supplementaryNote],
  ].filter(([, value]) => value !== null && value !== '') as Array<[string, string]>;
  if (rows.length === 0) {
    return null;
  }
  return (
    <div>
      <div className="mb-2 font-medium">{t('refDocDetail.section.result')}</div>
      <Descriptions bordered column={1} size="small">
        {rows.map(([label, value]) => (
          <Descriptions.Item key={label} label={label}>
            {value}
          </Descriptions.Item>
        ))}
      </Descriptions>
    </div>
  );
}

/**
 * 生效管理修订的结构化只读块（任务 07）：来自修订快照 structuredReport 键，
 * 组织与 Demo 报告详情一致（基本信息/故障现象/复位/排查步骤/维修结果）。
 */
function StructuredRevisionBlock({
  content,
  t,
}: {
  content: ReferenceDocumentStructuredContent;
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Descriptions
        bordered
        column={1}
        size="small"
        title={t('refDocDetail.section.structuredRevision')}
      >
        <Descriptions.Item label={t('refDocDetail.field.customerFactory')}>
          {content.customerFactoryName || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.equipmentModelText')}>
          {content.equipmentModelText ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.maintenanceDate')}>
          {content.maintenanceDate || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.engineerName')}>
          {content.maintenanceEngineerName || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.resetResult')}>
          {t(RESET_RESULT_LABEL_KEYS[content.resetResult] ?? 'refDocDetail.resetResult.NORMAL')}
        </Descriptions.Item>
      </Descriptions>
      <StructuredFaultsSection faults={content.faults} t={t} />
      <div>
        <div className="mb-2 font-medium">{t('refDocDetail.section.steps')}</div>
        {content.steps.length > 0 ? (
          <Table
            columns={makeStructuredStepColumns(t)}
            dataSource={content.steps}
            pagination={false}
            rowKey="stepCode"
            size="small"
            scroll={{ x: 820 }}
          />
        ) : (
          <div className="text-text-secondary text-sm">{t('refDocDetail.empty.steps')}</div>
        )}
      </div>
      <StructuredResultSection
        actualCause={content.actualCause}
        closureReason={content.closureReason}
        handlingResult={content.handlingResult}
        repairActions={content.repairActions}
        supplementaryNote={content.supplementaryNote}
        t={t}
        verificationResult={content.verificationResult}
      />
    </div>
  );
}

function makeStructuredStepColumns(
  t: Translate,
): TableColumnsType<ReferenceDocumentStructuredContent['steps'][number]> {
  return [
    {
      dataIndex: 'stepNo',
      key: 'stepNo',
      title: t('refDocDetail.column.step'),
      width: 70,
    },
    {
      dataIndex: 'phaseCode',
      key: 'phaseCode',
      title: t('refDocDetail.column.phase'),
      width: 120,
      render: (v: string | null) => v ?? '—',
    },
    {
      dataIndex: 'partName',
      key: 'partName',
      title: t('refDocDetail.column.part'),
      render: (v: string | null) => v ?? '—',
    },
    { dataIndex: 'actionText', key: 'actionText', title: t('refDocDetail.column.action') },
    {
      dataIndex: 'errorCode',
      key: 'errorCode',
      title: t('refDocDetail.column.errorCode'),
      width: 130,
      render: (v: string | null) => v ?? '—',
    },
    {
      dataIndex: 'resultCode',
      key: 'resultCode',
      title: t('refDocDetail.column.stepResult'),
      width: 120,
    },
  ];
}

/** blob 触发浏览器保存（下载共用动作） */
function triggerBrowserSave(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 冻结报告只读块：结构来自任务 06 的不可变快照，不在前端二次推断 */
function FrozenReportBlock({ report, t }: { report: ReferenceDocumentFrozenReport; t: Translate }) {
  return (
    <div className="flex flex-col gap-4">
      <Descriptions bordered column={1} size="small" title={t('refDocDetail.section.frozenReport')}>
        <Descriptions.Item label={t('refDocDetail.field.reportTitle')}>
          {report.title || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.customerFactory')}>
          {report.customerFactoryName || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.equipmentModelText')}>
          {report.equipmentModelText ??
            (report.equipmentModelId !== null ? `#${report.equipmentModelId}` : '—')}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.maintenanceDate')}>
          {report.maintenanceDate || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.engineerName')}>
          {report.maintenanceEngineerName || '—'}
        </Descriptions.Item>
        {report.repairRequestId !== null ? (
          <Descriptions.Item label={t('refDocDetail.field.sourceWorkOrder')}>
            {t('refDocDetail.field.workOrderRef', { id: report.repairRequestId })}
          </Descriptions.Item>
        ) : null}
        {report.resetResult !== null ? (
          <Descriptions.Item label={t('refDocDetail.field.resetResult')}>
            {t(RESET_RESULT_LABEL_KEYS[report.resetResult] ?? 'refDocDetail.resetResult.NORMAL')}
          </Descriptions.Item>
        ) : null}
        <Descriptions.Item label={t('refDocDetail.field.frozenVersion')}>
          {t('refDocDetail.field.frozenVersionText', {
            no: report.versionNo,
            schema: report.schemaVersion,
            time: formatDateTimeText(report.submittedAt),
          })}
        </Descriptions.Item>
        <Descriptions.Item label={t('refDocDetail.field.aiUsage')}>
          {report.ai.usage}
          {report.ai.score !== null
            ? ` · ${t('refDocDetail.field.aiScore')} ${report.ai.score}`
            : ''}
          {report.ai.correctness !== null
            ? ` · ${t('refDocDetail.field.aiCorrectness')} ${report.ai.correctness}`
            : ''}
          {report.ai.helpfulness !== null
            ? ` · ${t('refDocDetail.field.aiHelpfulness')} ${report.ai.helpfulness}`
            : ''}
        </Descriptions.Item>
        {report.ai.note !== null && report.ai.note !== '' ? (
          <Descriptions.Item label={t('refDocDetail.field.aiNote')}>
            {report.ai.note}
          </Descriptions.Item>
        ) : null}
      </Descriptions>

      <StructuredFaultsSection
        faults={report.faults.map((fault) => ({
          ...fault,
          branchKind: (fault.branchKind === 'INITIAL' ||
          fault.branchKind === 'RESET_NEW_FAULT' ||
          fault.branchKind === 'STEP_NEW_FAULT'
            ? fault.branchKind
            : 'INITIAL') as ReferenceDocumentStructuredContent['faults'][number]['branchKind'],
        }))}
        t={t}
      />

      <div>
        <div className="mb-2 font-medium">{t('refDocDetail.section.alarms')}</div>
        {report.alarms.length > 0 ? (
          <Table
            columns={makeFrozenAlarmColumns(t)}
            dataSource={report.alarms}
            pagination={false}
            rowKey="alarmIndex"
            size="small"
          />
        ) : (
          <div className="text-text-secondary text-sm">{t('refDocDetail.empty.alarms')}</div>
        )}
      </div>

      <div>
        <div className="mb-2 font-medium">{t('refDocDetail.section.steps')}</div>
        {report.steps.length > 0 ? (
          <Table
            columns={makeFrozenStepColumns(t)}
            dataSource={report.steps}
            pagination={false}
            rowKey="stepNo"
            size="small"
            scroll={{ x: 900 }}
          />
        ) : (
          <div className="text-text-secondary text-sm">{t('refDocDetail.empty.steps')}</div>
        )}
      </div>

      <StructuredResultSection
        actualCause={report.actualCause}
        closureReason={report.closureReason}
        handlingResult={report.handlingResult}
        repairActions={report.repairActions}
        supplementaryNote={report.supplementaryNote}
        t={t}
        verificationResult={report.verificationResult}
      />
    </div>
  );
}

function makeFrozenAlarmColumns(t: Translate): TableColumnsType<ReferenceDocumentFrozenAlarm> {
  return [
    {
      dataIndex: 'alarmIndex',
      key: 'alarmIndex',
      title: t('refDocDetail.column.index'),
      width: 80,
    },
    {
      dataIndex: 'alarmCode',
      key: 'alarmCode',
      title: t('refDocDetail.column.alarmCode'),
      width: 140,
    },
    {
      dataIndex: 'alarmDescription',
      key: 'alarmDescription',
      title: t('refDocDetail.column.alarmDescription'),
      render: (v: string | null) => v ?? '—',
    },
    { dataIndex: 'phaseCode', key: 'phaseCode', title: t('refDocDetail.column.phase'), width: 140 },
    {
      dataIndex: 'resetResult',
      key: 'resetResult',
      title: t('refDocDetail.column.resetResult'),
      width: 150,
    },
  ];
}

function makeFrozenStepColumns(t: Translate): TableColumnsType<ReferenceDocumentFrozenStep> {
  return [
    { dataIndex: 'stepNo', key: 'stepNo', title: t('refDocDetail.column.step'), width: 70 },
    { dataIndex: 'phaseCode', key: 'phaseCode', title: t('refDocDetail.column.phase'), width: 130 },
    {
      dataIndex: 'partName',
      key: 'partName',
      title: t('refDocDetail.column.part'),
      render: (v: string | null) => v ?? '—',
    },
    { dataIndex: 'actionText', key: 'actionText', title: t('refDocDetail.column.actionText') },
    {
      dataIndex: 'resultText',
      key: 'resultText',
      title: t('refDocDetail.column.resultText'),
      render: (v: string | null) => v ?? '—',
    },
    {
      dataIndex: 'newAlarmCode',
      key: 'newAlarmCode',
      title: t('refDocDetail.column.newAlarmCode'),
      width: 120,
      render: (v: string | null) => v ?? '—',
    },
  ];
}

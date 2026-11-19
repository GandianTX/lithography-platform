// src/features/repair-request/ui/engineer-repair-maintenance-section.tsx

/**
 * 工程师结构化内部维修记录分区（任务 04 本轮调整）。
 *
 * - 仅接单工程师本人可见（详情仅对该视角返回维修记录/步骤/面板）；
 * - 未填写且可编辑时直接显示共享编辑器，取消后可通过「填写维修记录」重新打开；
 * - 保存并读回成功后退出编辑态，以一张可展开卡片展示服务端记录；
 * - 再次编辑以已保存内容初始化编辑器，保存后更新同一张卡片，不新增重复记录；
 * - 保存失败保留输入；写入成功但读回失败时提示「已保存，刷新失败」并提供重试读取；
 * - 版本冲突保留冲突提示与刷新入口，不自动重试；
 * - 已结单 / 无编辑权限时只展示记录，不显示编辑入口；
 * - 保留既有权限、附件绑定与下载规则。
 */

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Tag } from 'antd';

import { useI18n } from '@/shared/i18n';
import { triggerBrowserDownload } from '@/shared/ui/download-blob';
import { MaintenanceRecordEditor } from '@/shared/ui/maintenance-record-editor';
import {
  createMaintenanceEditorValue,
  describePhaseCode,
  describeResetResult,
  describeStepResult,
  type MaintenanceEditorSource,
  toMaintenancePanelPayloads,
  toMaintenanceStepPayloads,
  validateMaintenanceEditorValue,
} from '@/shared/ui/maintenance-record-editor/model';

import { useRepairMaintenanceWorkbench } from '../application/use-repair-maintenance-workbench';
import { useRepairOriginalDownload } from '../application/use-repair-original-download';
import type { EngineerRepairRequestDetail } from '../infrastructure/engineer-repair-request.types';

/** 工程师详情 → 共享编辑器数据源（记录在 maintenance 节点，步骤/面板在详情顶层） */
function toMaintenanceSource(detail: EngineerRepairRequestDetail): MaintenanceEditorSource {
  return {
    maintenanceDate: detail.maintenance?.maintenanceDate ?? null,
    engineerName: detail.maintenance?.engineerName ?? null,
    resetResult: detail.maintenance?.resetResult ?? null,
    supplementaryNote: detail.maintenance?.supplementaryNote ?? null,
    attachment: detail.maintenance?.attachment ?? null,
    steps: detail.maintenanceSteps ?? [],
    panels: detail.maintenanceFaultPanels ?? [],
  };
}

export function EngineerRepairMaintenanceSection({
  canWrite,
  detail,
  readOnly,
  reload,
  requestId,
  scopeKey,
  writeEligible,
}: {
  requestId: number;
  detail: EngineerRepairRequestDetail;
  canWrite: boolean;
  readOnly: boolean;
  scopeKey?: string;
  reload: (options?: {
    shouldApply?: () => boolean;
    silent?: boolean;
    mutation?: boolean;
    onApplied?: (detail: EngineerRepairRequestDetail) => void;
  }) => Promise<unknown>;
  writeEligible?: (requestId: number | null, scopeKey: string) => boolean;
}) {
  const { t } = useI18n();
  const maintenance = detail.maintenance ?? null;
  const serverVersion = maintenance?.versionNo ?? 0;
  const steps = detail.maintenanceSteps ?? [];
  const panels = detail.maintenanceFaultPanels ?? [];
  // 后端会为接单人返回 versionNo=0、内容为空的维修对象；这不是已保存记录。
  // v0 首屏的可信姓名来自接单人资料回填，只用于只读展示，不能作为「已有记录」依据。
  const hasRecord =
    serverVersion > 0 ||
    Boolean(
      maintenance?.maintenanceDate ||
      maintenance?.resetResult ||
      maintenance?.supplementaryNote ||
      maintenance?.attachment,
    ) ||
    steps.length > 0 ||
    panels.length > 0;
  const canEdit = canWrite && !readOnly;

  const {
    stagedFile,
    uploading,
    uploadError,
    saving,
    lastResult,
    readbackFailed,
    retryingReadback,
    uploadAttachment,
    clearStagedAttachment,
    saveMaintenance,
    retryReadback,
  } = useRepairMaintenanceWorkbench(requestId, reload, {
    writeBlocked: !canWrite || readOnly,
    scopeKey,
    writeEligible,
  });
  const {
    downloadingFileId,
    error: downloadError,
    download,
    clearError: clearDownloadError,
  } = useRepairOriginalDownload();

  const [value, setValue] = useState(() =>
    createMaintenanceEditorValue(toMaintenanceSource(detail)),
  );
  const [validationIssues, setValidationIssues] = useState<string[]>([]);
  const [localDownloadError, setLocalDownloadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<boolean | null>(null);
  const [editingStartResult, setEditingStartResult] = useState(lastResult);
  const [expanded, setExpanded] = useState(false);
  const syncedVersionRef = useRef(serverVersion);

  // 服务端版本推进（保存成功回读、冲突后刷新）时以服务端事实重建编辑器；
  // 同一版本内的普通重渲染不覆盖用户正在编辑的内容。
  useEffect(() => {
    if (serverVersion === syncedVersionRef.current) {
      return;
    }
    syncedVersionRef.current = serverVersion;
    setValue(createMaintenanceEditorValue(toMaintenanceSource(detail)));
    setValidationIssues([]);
  }, [detail, serverVersion]);

  // 写入成功（含读回失败）即退出编辑态，避免用户误以为需要再次提交；
  // 保存失败保留编辑器与输入内容。
  // 通过“本次编辑开始时的结果对象”派生，而不是在 effect 中同步 setState。
  const editSessionActive =
    canEdit &&
    !readbackFailed &&
    (editing ?? !hasRecord) &&
    (saving || !lastResult?.ok || lastResult === editingStartResult);

  const handleDownload = async (fileId: string) => {
    setLocalDownloadError(null);
    clearDownloadError();
    try {
      const result = await download(fileId);
      if (result?.ok) {
        triggerBrowserDownload(result.blob, result.filename);
      }
    } catch {
      setLocalDownloadError(t('engineerDetail.downloadFailed'));
    }
  };

  const handleStartEdit = () => {
    setValue(createMaintenanceEditorValue(toMaintenanceSource(detail)));
    setValidationIssues([]);
    setEditingStartResult(lastResult);
    setEditing(true);
  };

  const handleCancelEdit = () => {
    setValue(createMaintenanceEditorValue(toMaintenanceSource(detail)));
    setValidationIssues([]);
    setEditing(false);
  };

  const handleSave = async () => {
    const issues = validateMaintenanceEditorValue(value, t);
    if (issues.length > 0) {
      setValidationIssues(issues);
      return;
    }
    setValidationIssues([]);
    await saveMaintenance(
      {
        maintenanceDate: value.maintenanceDate.trim() === '' ? null : value.maintenanceDate.trim(),
        engineerName: value.engineerName.trim() === '' ? null : value.engineerName.trim(),
        resetResult: value.resetResult === '' ? null : value.resetResult,
        supplementaryNote:
          value.supplementaryNote.trim() === '' ? null : value.supplementaryNote.trim(),
        steps: toMaintenanceStepPayloads(value),
        panels: toMaintenancePanelPayloads(value),
      },
      serverVersion,
    );
  };

  const attachment = maintenance?.attachment ?? null;
  const editDisabledByReadback = readbackFailed;

  return (
    <section className="mt-5 border-t border-border pt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h4 className="m-0 font-medium text-sm">{t('engineerDetail.maintenanceSection')}</h4>
        {hasRecord && maintenance ? <Tag>v{maintenance.versionNo}</Tag> : null}
      </div>

      <div className="flex flex-col gap-3">
        {readbackFailed ? (
          <Alert
            action={
              <Button disabled={retryingReadback} onClick={() => void retryReadback()} size="small">
                {t('maintenance.retryReadback')}
              </Button>
            }
            description={t('maintenance.readbackFailedHint')}
            showIcon
            title={t('maintenance.readbackFailed')}
            type="warning"
          />
        ) : null}
        {editSessionActive ? (
          <>
            <MaintenanceRecordEditor
              attachment={{
                onClearStaged: clearStagedAttachment,
                onDownload: (fileId) => void handleDownload(fileId),
                onSelectFile: (file) => {
                  void uploadAttachment(file).catch(() => undefined);
                },
                readOnly,
                stagedFile,
                uploading,
                downloadingFileId,
              }}
              disabled={saving || uploading}
              engineerNameReadOnly
              onChange={(next) => {
                setValue(next);
                if (validationIssues.length > 0) setValidationIssues([]);
              }}
              readOnly={readOnly}
              value={value}
            />

            {uploadError ? <Alert showIcon title={uploadError} type="error" /> : null}
            {(downloadError ?? localDownloadError) ? (
              <Alert showIcon title={downloadError ?? localDownloadError ?? ''} type="error" />
            ) : null}

            {validationIssues.length > 0 ? (
              <Alert
                description={
                  <ul className="m-0 pl-4">
                    {validationIssues.map((issue, index) => (
                      <li key={`${index}-${issue}`}>{issue}</li>
                    ))}
                  </ul>
                }
                showIcon
                title={t('maintenance.validationSummary')}
                type="error"
              />
            ) : null}

            {lastResult && !lastResult.ok ? (
              lastResult.reason === 'conflict' ? (
                <Alert
                  action={
                    <Button onClick={() => void reload()} size="small">
                      {t('maintenance.reloadDetail')}
                    </Button>
                  }
                  showIcon
                  title={lastResult.message || t('maintenance.conflict')}
                  type="warning"
                />
              ) : (
                <Alert showIcon title={lastResult.message} type="error" />
              )
            ) : null}

            {uploading ? (
              <div className="text-text-secondary text-xs">
                {t('maintenance.attachmentUploadBusy')}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={uploading || saving}
                loading={saving}
                onClick={() => void handleSave()}
                type="primary"
              >
                {stagedFile ? t('maintenance.saveWithAttachment') : t('maintenance.save')}
              </Button>
              <Button disabled={saving} onClick={handleCancelEdit}>
                {t('engineerDetail.maintenanceCancelEdit')}
              </Button>
            </div>
          </>
        ) : hasRecord ? (
          <>
            <div className="rounded-lg border border-[var(--panel-border)]">
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <div className="text-text-secondary text-xs">
                      {t('engineerDetail.maintenanceDate')}
                    </div>
                    <div className="text-sm">
                      {maintenance?.maintenanceDate ?? t('engineerRepairHistory.value.empty')}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-secondary text-xs">
                      {t('engineerDetail.maintenanceEngineer')}
                    </div>
                    <div className="text-sm">
                      {maintenance?.engineerName ?? t('engineerRepairHistory.value.empty')}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-secondary text-xs">
                      {t('engineerDetail.maintenanceReset')}
                    </div>
                    <div className="text-sm">
                      {describeResetResult(maintenance?.resetResult ?? null, t)}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-secondary text-xs">
                      {t('engineerDetail.maintenanceStepCount')}
                    </div>
                    <div className="text-sm">
                      {t('engineerDetail.maintenanceStepCountValue', { count: steps.length })}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {canEdit && !editDisabledByReadback ? (
                    <Button onClick={handleStartEdit} size="small">
                      {t('engineerDetail.maintenanceEdit')}
                    </Button>
                  ) : null}
                  <Button onClick={() => setExpanded((prev) => !prev)} size="small" type="text">
                    {expanded
                      ? t('engineerDetail.maintenanceCollapse')
                      : t('engineerDetail.maintenanceExpand')}
                  </Button>
                </div>
              </div>

              {editDisabledByReadback && canEdit ? (
                <div className="px-4 pb-3 text-text-secondary text-xs">
                  {t('engineerDetail.maintenanceReadbackRetryHint')}
                </div>
              ) : null}

              {expanded ? (
                <div className="flex flex-col gap-4 border-t border-border p-4">
                  {maintenance?.supplementaryNote ? (
                    <div>
                      <div className="text-text-secondary text-xs">
                        {t('engineerRepairHistory.field.supplementaryNote')}
                      </div>
                      <div className="text-sm whitespace-pre-wrap">
                        {maintenance.supplementaryNote}
                      </div>
                    </div>
                  ) : null}

                  <div>
                    <div className="mb-2 font-medium text-sm">
                      {t('engineerDetail.maintenancePanels')}
                    </div>
                    {panels.length === 0 ? (
                      <div className="text-sm text-text-secondary">
                        {t('engineerDetail.maintenanceNoPanels')}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {panels.map((panel) => (
                          <div
                            className="rounded-lg border border-[var(--panel-border)] p-3"
                            key={panel.id}
                          >
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                              <Tag>{panel.panelType}</Tag>
                              <span>{describePhaseCode(panel.phaseCode, t)}</span>
                            </div>
                            <div className="text-sm whitespace-pre-wrap">{panel.description}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="mb-2 font-medium text-sm">
                      {t('engineerDetail.maintenanceSteps')}
                    </div>
                    {steps.length === 0 ? (
                      <div className="text-sm text-text-secondary">
                        {t('engineerDetail.maintenanceNoSteps')}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {steps.map((step) => (
                          <div
                            className="rounded-lg border border-[var(--panel-border)] p-3"
                            key={step.id}
                          >
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                              <span className="font-medium">#{step.stepNo}</span>
                              <Tag>{describeStepResult(step.resultCode, t)}</Tag>
                              {step.errorCode ? <span>{step.errorCode}</span> : null}
                              {step.partName ? <span>{step.partName}</span> : null}
                            </div>
                            <div className="text-sm whitespace-pre-wrap">{step.actionText}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="mb-2 font-medium text-sm">
                      {t('engineerDetail.maintenanceAttachment')}
                    </div>
                    {attachment ? (
                      <Button
                        loading={downloadingFileId === attachment.fileId}
                        onClick={() => void handleDownload(attachment.fileId)}
                        size="small"
                      >
                        {attachment.originalFilename}
                      </Button>
                    ) : (
                      <div className="text-sm text-text-secondary">
                        {t('engineerRepairHistory.value.empty')}
                      </div>
                    )}
                  </div>

                  {(downloadError ?? localDownloadError) ? (
                    <Alert
                      showIcon
                      title={downloadError ?? localDownloadError ?? ''}
                      type="error"
                    />
                  ) : null}
                </div>
              ) : null}
            </div>

            {!canEdit ? (
              <div className="text-sm text-text-secondary">
                {readOnly
                  ? t('engineerDetail.maintenanceClosedReadOnly')
                  : t('maintenance.readOnlyHint')}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-sm text-text-secondary">
              {t('engineerDetail.maintenanceNoRecord')}
            </div>
            {canEdit ? (
              <div>
                <Button
                  disabled={editDisabledByReadback}
                  onClick={handleStartEdit}
                  size="small"
                  type="primary"
                >
                  {t('engineerDetail.maintenanceFill')}
                </Button>
              </div>
            ) : readOnly ? (
              <div className="text-sm text-text-secondary">
                {t('engineerDetail.maintenanceClosedReadOnly')}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

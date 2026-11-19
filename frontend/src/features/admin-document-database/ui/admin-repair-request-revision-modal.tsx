// src/features/admin-document-database/ui/admin-repair-request-revision-modal.tsx

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Divider, Input, message, Modal, Select, Space, Typography } from 'antd';

import { useI18n } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { MaintenanceRecordEditor } from '@/shared/ui/maintenance-record-editor';
import {
  createMaintenanceEditorValue,
  serializeMaintenanceEditorValue,
  toMaintenancePanelPayloads,
  toMaintenanceStepPayloads,
  validateMaintenanceEditorValue,
} from '@/shared/ui/maintenance-record-editor/model';
import { REPAIR_HANDLING_RESULT_OPTIONS } from '@/shared/ui/repair-request-status-labels';

import type {
  AdminRepairHandlingResult,
  AdminRepairRequestSummary,
  AdminRepairRevisionInput,
} from '../infrastructure/admin-document-database.types';
import { appendAdminRepairRequestRevision } from '../infrastructure/admin-document-database-adapter';

/** 修订弹窗与工程师结单共用五项中文全称（shared 单一真源） */
const HANDLING_RESULT_OPTIONS: Array<{ label: string; value: AdminRepairHandlingResult }> =
  REPAIR_HANDLING_RESULT_OPTIONS;

function requiresClosureReason(result: AdminRepairHandlingResult | null): boolean {
  return result === 'INTERRUPTED' || result === 'UNREPAIRABLE';
}

type ProcessEdit = { operationText: string; testResult: string };

/**
 * 管理员工单修订弹窗。
 *
 * 只允许订正已提交的正文、处理结果、结单原因与过程文本；客户原始提交、设备、
 * 接单人、状态机事实与组织归属由服务端拒绝改写。请求携带工单与过程版本号，
 * 冲突时保留弹窗并提示刷新，不做本地自动合并；成功后由父组件重新读取详情。
 */
export function AdminRepairRequestRevisionModal({
  detail,
  open,
  onClose,
  onDownloadAttachment,
  onSaved,
}: {
  detail: AdminRepairRequestSummary;
  open: boolean;
  onClose: () => void;
  onDownloadAttachment: (fileId: string) => Promise<{ ok: boolean; message?: string }>;
  onSaved: () => void | Promise<boolean>;
}) {
  const { t } = useI18n();
  const initialMaintenanceValue = useMemo(
    () =>
      createMaintenanceEditorValue({
        maintenanceDate: detail.maintenance?.maintenanceDate ?? null,
        engineerName: detail.maintenance?.engineerName ?? null,
        resetResult: detail.maintenance?.resetResult ?? null,
        supplementaryNote: detail.maintenance?.supplementaryNote ?? null,
        attachment: detail.maintenance?.attachment ?? null,
        steps: detail.maintenanceSteps ?? [],
        panels: detail.maintenanceFaultPanels ?? [],
      }),
    [detail],
  );
  const initialMaintenanceSerialized = useMemo(
    () => serializeMaintenanceEditorValue(initialMaintenanceValue),
    [initialMaintenanceValue],
  );
  const [maintenanceValue, setMaintenanceValue] = useState(initialMaintenanceValue);
  const [maintenanceDownloadError, setMaintenanceDownloadError] = useState<string | null>(null);
  const [contentMd, setContentMd] = useState(detail.contentMd);
  const [handlingResult, setHandlingResult] = useState<AdminRepairHandlingResult | null>(
    detail.handlingResult,
  );
  const [closureReason, setClosureReason] = useState(detail.closureReason ?? '');
  const [processEdits, setProcessEdits] = useState<Record<string, ProcessEdit>>(() =>
    Object.fromEntries(
      detail.processEntries.map((entry) => [
        entry.id,
        { operationText: entry.operationText, testResult: entry.testResult ?? '' },
      ]),
    ),
  );
  const [reason, setReason] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 迟到响应守卫：只认「当前弹窗实例 + 当前工单 + 最近一次提交」的响应。
  // 弹窗随工单/版本/开关重新挂载；旧实例的迟到成功不得关闭或重载新工单的弹窗，
  // 迟到失败也不得覆盖新弹窗的输入与错误。服务端提交本身不回滚、不取消。
  const mountedRef = useRef(true);
  const detailIdRef = useRef(detail.id);
  const submitSeqRef = useRef(0);

  useEffect(() => {
    detailIdRef.current = detail.id;
  }, [detail.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const revisionFields = useMemo(() => {
    const changedProcessEntries = detail.processEntries
      .filter((entry) => {
        const edit = processEdits[entry.id];
        if (!edit) {
          return false;
        }
        return (
          edit.operationText !== entry.operationText || edit.testResult !== (entry.testResult ?? '')
        );
      })
      .map((entry) => ({
        entryId: entry.id,
        expectedVersion: entry.versionNo,
        operationText: processEdits[entry.id].operationText,
        testResult:
          processEdits[entry.id].testResult.trim() === ''
            ? null
            : processEdits[entry.id].testResult,
      }));

    return {
      contentChanged: contentMd !== detail.contentMd,
      handlingChanged: (handlingResult ?? null) !== detail.handlingResult,
      closureReasonChanged: closureReason !== (detail.closureReason ?? ''),
      changedProcessEntries,
      maintenanceChanged:
        serializeMaintenanceEditorValue(maintenanceValue) !== initialMaintenanceSerialized,
    };
  }, [
    detail,
    contentMd,
    handlingResult,
    closureReason,
    processEdits,
    maintenanceValue,
    initialMaintenanceSerialized,
  ]);

  const hasChanges =
    revisionFields.contentChanged ||
    revisionFields.handlingChanged ||
    revisionFields.closureReasonChanged ||
    revisionFields.changedProcessEntries.length > 0 ||
    revisionFields.maintenanceChanged;

  const effectiveHandlingResult = handlingResult ?? detail.handlingResult;

  const submit = async () => {
    setSubmitError(null);
    if (reason.trim() === '') {
      setSubmitError('请填写修订原因。');
      return;
    }
    if (!hasChanges) {
      setSubmitError('未检测到需要修订的字段。');
      return;
    }
    if (requiresClosureReason(effectiveHandlingResult) && closureReason.trim() === '') {
      setSubmitError('中断或无法修复时必须填写结单原因。');
      return;
    }

    const input: AdminRepairRevisionInput = {
      requestId: detail.id,
      expectedVersion: detail.currentRevisionNo,
      reason: reason.trim(),
    };
    if (revisionFields.contentChanged) {
      input.contentMd = contentMd;
    }
    if (revisionFields.handlingChanged && handlingResult !== null) {
      input.handlingResult = handlingResult;
    }
    if (revisionFields.closureReasonChanged) {
      input.closureReason = closureReason.trim() === '' ? null : closureReason;
    }
    if (revisionFields.changedProcessEntries.length > 0) {
      input.processEntries = revisionFields.changedProcessEntries;
    }
    if (revisionFields.maintenanceChanged) {
      const issues = validateMaintenanceEditorValue(maintenanceValue, t);
      if (issues.length > 0) {
        setSubmitError(issues.join('；'));
        return;
      }
      input.expectedMaintenanceVersion = detail.maintenanceVersionNo ?? 0;
      input.maintenance = {
        maintenanceDate:
          maintenanceValue.maintenanceDate.trim() === ''
            ? null
            : maintenanceValue.maintenanceDate.trim(),
        engineerName:
          maintenanceValue.engineerName.trim() === '' ? null : maintenanceValue.engineerName.trim(),
        resetResult: maintenanceValue.resetResult === '' ? null : maintenanceValue.resetResult,
        supplementaryNote:
          maintenanceValue.supplementaryNote.trim() === ''
            ? null
            : maintenanceValue.supplementaryNote.trim(),
        steps: toMaintenanceStepPayloads(maintenanceValue),
        panels: toMaintenancePanelPayloads(maintenanceValue),
      };
    }

    const requestId = detail.id;
    const submitSeq = submitSeqRef.current + 1;
    submitSeqRef.current = submitSeq;
    const isCurrentSubmission = (): boolean =>
      mountedRef.current && submitSeqRef.current === submitSeq && detailIdRef.current === requestId;

    setSubmitting(true);
    try {
      const outcome = await appendAdminRepairRequestRevision(input);
      if (!isCurrentSubmission()) {
        return;
      }
      if (!outcome.ok) {
        setSubmitError(outcome.message);
        return;
      }
      message.success('工单修订已保存。');
      onClose();
      // 修订已在服务端提交成功：详情刷新属于独立的后续读取。
      // 刷新失败只能提示「已保存但刷新失败」，绝不能改写为保存失败，
      // 否则会诱导用户用旧版本重复提交。
      let refreshed = true;
      try {
        refreshed = (await onSaved()) !== false;
      } catch {
        refreshed = false;
      }
      if (!refreshed) {
        message.warning('修订已保存，但详情刷新失败，请刷新页面后查看最新版本。');
      }
    } catch {
      if (!isCurrentSubmission()) {
        return;
      }
      setSubmitError('修订保存失败，请稍后重试。');
    } finally {
      if (isCurrentSubmission()) {
        setSubmitting(false);
      }
    }
  };

  const handleMaintenanceDownload = async (fileId: string) => {
    setMaintenanceDownloadError(null);
    const result = await onDownloadAttachment(fileId);
    if (!result.ok) {
      setMaintenanceDownloadError(
        result.message ?? t('adminRepairRequest.versionHistory.downloadFailed'),
      );
    }
  };

  return (
    <Modal
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button
            disabled={!hasChanges}
            htmlType="button"
            loading={submitting}
            onClick={() => void submit()}
            type="primary"
          >
            保存修订
          </Button>
        </Space>
      }
      onCancel={onClose}
      open={open}
      title={`修订工单 · ${detail.requestNo}（当前版本 ${detail.currentRevisionNo}）`}
      width={960}
    >
      <div className="flex flex-col gap-4">
        <Alert
          showIcon
          title="仅订正已提交事实。客户原始提交、设备、接单人、状态机事实与组织归属不可改写；AI 会话与报告内容不在此处开放。"
          type="info"
        />

        <div>
          <p className="mb-1 font-medium">申请正文</p>
          <Input.TextArea
            autoSize={{ minRows: 6, maxRows: 14 }}
            onChange={(event) => setContentMd(event.target.value)}
            value={contentMd}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="mb-1 font-medium">处理结果</p>
            <Select<AdminRepairHandlingResult>
              disabled={!detail.isAccepted && detail.handlingResult === null}
              onChange={(value) => setHandlingResult(value)}
              options={HANDLING_RESULT_OPTIONS}
              placeholder={detail.handlingResult ? undefined : '尚未设置处理结果'}
              style={{ width: '100%' }}
              value={handlingResult ?? undefined}
            />
            {!detail.isAccepted && detail.handlingResult === null ? (
              <Typography.Text type="secondary">工单未接单，不能设置处理结果。</Typography.Text>
            ) : null}
          </div>
          <div>
            <p className="mb-1 font-medium">结单原因</p>
            <Input
              disabled={effectiveHandlingResult === null}
              maxLength={255}
              onChange={(event) => setClosureReason(event.target.value)}
              placeholder={requiresClosureReason(effectiveHandlingResult) ? '必填' : '可选'}
              value={closureReason}
            />
          </div>
        </div>

        <Divider style={{ marginBlock: 0 }} />

        <div>
          <p className="mb-2 font-medium">内部维修过程（仅订正文本）</p>
          {detail.processEntries.length === 0 ? (
            <Typography.Text type="secondary">暂无已提交过程。</Typography.Text>
          ) : (
            <div className="flex flex-col gap-3">
              {detail.processEntries.map((entry) => {
                const edit = processEdits[entry.id] ?? {
                  operationText: entry.operationText,
                  testResult: entry.testResult ?? '',
                };
                return (
                  <div className="rounded border border-[var(--panel-border)] p-3" key={entry.id}>
                    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
                      <span>版本 v{entry.versionNo}</span>
                      <span>{formatDateTimeText(entry.createdAt)}</span>
                      <span>时间来源 {entry.timeSource === 'SERVER' ? '服务端' : '人工'}</span>
                      {entry.file ? (
                        <span>
                          原件：{entry.file.originalFilename}（{entry.file.byteSize} 字节）
                        </span>
                      ) : null}
                    </div>
                    <Input.TextArea
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      onChange={(event) =>
                        setProcessEdits((previous) => ({
                          ...previous,
                          [entry.id]: {
                            ...edit,
                            operationText: event.target.value,
                          },
                        }))
                      }
                      value={edit.operationText}
                    />
                    <div className="mt-2">
                      <Input
                        maxLength={255}
                        onChange={(event) =>
                          setProcessEdits((previous) => ({
                            ...previous,
                            [entry.id]: {
                              ...edit,
                              testResult: event.target.value,
                            },
                          }))
                        }
                        placeholder="测试结果（可选）"
                        value={edit.testResult}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Divider style={{ marginBlock: 0 }} />

        <div>
          <p className="mb-1 font-medium">{t('adminRepairRequest.revisionModal.maintenance')}</p>
          <p className="mb-2 text-xs text-text-secondary">
            {t('adminRepairRequest.revisionModal.maintenanceHint')}
          </p>
          <MaintenanceRecordEditor
            attachment={{
              onClearStaged: () => undefined,
              onDownload: (fileId) => void handleMaintenanceDownload(fileId),
              onSelectFile: () => undefined,
              readOnly: true,
              stagedFile: null,
              uploading: false,
            }}
            disabled={submitting}
            onChange={setMaintenanceValue}
            value={maintenanceValue}
          />
          {maintenanceDownloadError ? (
            <div className="mt-2">
              <Alert showIcon title={maintenanceDownloadError} type="error" />
            </div>
          ) : null}
        </div>

        <div>
          <p className="mb-1 font-medium">修订原因（必填，最多 1000 字符）</p>
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 5 }}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明本次修订的原因与依据"
            value={reason}
          />
        </div>

        {submitError ? <Alert showIcon title={submitError} type="error" /> : null}
      </div>
    </Modal>
  );
}

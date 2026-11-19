// src/features/repair-request/ui/engineer-repair-process-section.tsx

/**
 * 内部维修过程 / 原件 / 结单分区（任务 04 第一轮）。
 *
 * - 仅接单工程师本人看到本分区（processEntries 也仅对该视角返回）；
 * - 「已上传暂存」与「已保存绑定」用不同标签与文案区分，避免把暂存误认为已绑定；
 * - 编辑无原件过程时可补传一份暂存原件；已有原件的过程编辑只读展示，不提供替换/移除；
 * - 暂存原件进入编辑前显式交接或拦截，不进编辑后静默丢弃；
 * - 保存过程后走正式详情读接口回读，列表以读回结果为准；
 * - 编辑按 expectedVersion 提交，冲突不自动重试；
 * - 结单二次确认，成功后由应用层回读详情并转为只读。
 */

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Popconfirm, Select, Tag, Timeline } from 'antd';

import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { REPAIR_HANDLING_RESULT_OPTIONS } from '@/shared/ui/repair-request-status-labels';

import type { RepairProcessFormInput } from '../application/use-engineer-repair-process-workbench';
import { useEngineerRepairProcessWorkbench } from '../application/use-engineer-repair-process-workbench';
import type {
  CloseRepairRequestResult,
  EngineerRepairProcessEntry,
  RepairProcessWriteResult,
  RepairRequestHandlingResult,
} from '../infrastructure/engineer-repair-request.types';

/** 五项处理结果文案与管理员侧共用 shared 真源，避免两套中文全称 */
const HANDLING_RESULT_OPTIONS: Array<{ value: RepairRequestHandlingResult; label: string }> =
  REPAIR_HANDLING_RESULT_OPTIONS;

function requiresReason(result: RepairRequestHandlingResult | undefined): boolean {
  return result === 'INTERRUPTED' || result === 'UNREPAIRABLE';
}

/** 与后端 stored-file 上传合同保持一致的格式与大小上限（后端仍是最终裁决方） */
const PROCESS_FILE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.md,.csv';
const PROCESS_FILE_ACCEPTED_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'txt',
  'md',
  'csv',
];
const PROCESS_FILE_MAX_BYTES = 20_000_000;

function validateProcessFile(file: File): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!PROCESS_FILE_ACCEPTED_EXTENSIONS.includes(extension)) {
    return '不支持该文件类型，请选择 PDF、Word、Excel、PPT、图片、TXT、MD 或 CSV。';
  }
  if (file.size === 0) {
    return '原件不能为空，请重新选择。';
  }
  if (file.size > PROCESS_FILE_MAX_BYTES) {
    return '原件不能超过 20 MB，请压缩后重试。';
  }
  return null;
}

type ProcessFormValues = {
  operationText: string;
  testResult?: string;
  occurredAt?: string;
};

function toIsoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function ProcessFeedbackAlert({
  result,
  onReload,
  readbackFailed,
  readbackRetrying,
  onRetryReadback,
}: {
  result: RepairProcessWriteResult | null;
  onReload: () => void;
  readbackFailed: boolean;
  readbackRetrying: boolean;
  onRetryReadback: () => void;
}) {
  // 保存成功会按既有合同退出编辑并清空 lastProcessResult；
  // 刷新失败提示必须独立于此存活，避免“保存成功但未刷新”被静默吞掉。
  if (readbackFailed) {
    return (
      <Alert
        action={
          <Button disabled={readbackRetrying} onClick={onRetryReadback} size="small">
            重试刷新
          </Button>
        }
        description="保存已成功，当前页面可能未刷新；请重试刷新以确认最新过程记录。"
        showIcon
        title="内部维修过程已保存，但详情刷新失败。"
        type="warning"
      />
    );
  }
  if (!result) return null;
  if (result.ok) {
    return <Alert showIcon title="内部维修过程已保存。" type="success" />;
  }
  if (result.reason === 'conflict') {
    return (
      <Alert
        action={
          <Button onClick={onReload} size="small">
            刷新详情
          </Button>
        }
        showIcon
        title={result.message}
        type="warning"
      />
    );
  }
  return <Alert showIcon title={result.message} type="error" />;
}

function CloseReadbackUnconfirmedAlert({
  onRetryReadback,
  readbackRetrying,
}: {
  onRetryReadback: () => void;
  readbackRetrying: boolean;
}) {
  return (
    <Alert
      action={
        <Button disabled={readbackRetrying} onClick={onRetryReadback} size="small">
          重试刷新
        </Button>
      }
      description="结单已成功，当前页面尚未确认服务端的结束状态；内部维修过程与回复保持只读。请重试刷新。"
      showIcon
      title="工单已结单，但详情尚未确认。"
      type="warning"
    />
  );
}

function CloseFeedbackAlert({
  result,
  onReload,
  readbackFailed,
  readbackRetrying,
  onRetryReadback,
}: {
  result: CloseRepairRequestResult | null;
  onReload: () => void;
  readbackFailed: boolean;
  readbackRetrying: boolean;
  onRetryReadback: () => void;
}) {
  if (!result) return null;
  if (result.ok) {
    if (readbackFailed) {
      return (
        <CloseReadbackUnconfirmedAlert
          onRetryReadback={onRetryReadback}
          readbackRetrying={readbackRetrying}
        />
      );
    }
    return <Alert showIcon title="工单已结单，过程与回复已转为只读。" type="success" />;
  }
  if (result.reason === 'closed') {
    return (
      <Alert
        action={
          <Button onClick={onReload} size="small">
            刷新详情
          </Button>
        }
        showIcon
        title={result.message}
        type="warning"
      />
    );
  }
  return <Alert showIcon title={result.message} type="error" />;
}

function ProcessEntryItem({
  entry,
  onDownload,
  onEdit,
  disabled,
}: {
  entry: EngineerRepairProcessEntry;
  onDownload: (fileId: string) => void;
  onEdit: (entry: EngineerRepairProcessEntry) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">
          {entry.occurredAt ? formatDateTimeText(entry.occurredAt) : '服务端记录时间'}
        </span>
        <Tag color={entry.timeSource === 'MANUAL' ? 'blue' : 'default'}>
          {entry.timeSource === 'MANUAL' ? '人工时间' : '系统时间'}
        </Tag>
        <span className="text-text-secondary text-xs">版本 {entry.versionNo}</span>
        {!disabled ? (
          <Button onClick={() => onEdit(entry)} size="small" type="link">
            编辑
          </Button>
        ) : null}
      </div>
      <div className="text-sm whitespace-pre-wrap">{entry.operationText}</div>
      {entry.testResult ? (
        <div className="text-sm text-text-secondary whitespace-pre-wrap">
          测试事实：{entry.testResult}
        </div>
      ) : null}
      {entry.file ? (
        <div className="flex flex-wrap items-center gap-2">
          <Tag color="green">已保存绑定</Tag>
          <span className="text-sm">{entry.file.originalFilename}</span>
          <span className="text-text-secondary text-xs">
            {entry.file.byteSize} 字节 · SHA-256 {entry.file.checksumSha256.slice(0, 12)}…
          </span>
          <Button onClick={() => onDownload(entry.file!.fileId)} size="small">
            下载原件
          </Button>
        </div>
      ) : null}
      <div className="text-text-secondary text-xs">
        记录于 {formatDateTimeText(entry.createdAt)}
      </div>
    </div>
  );
}

export function EngineerRepairProcessSection({
  requestId,
  scopeKey,
  canWrite,
  readOnly,
  processEntries,
  reload,
  writeEligible,
}: {
  requestId: number;
  scopeKey?: string;
  canWrite: boolean;
  readOnly: boolean;
  processEntries: EngineerRepairProcessEntry[];
  reload: (options?: { shouldApply?: () => boolean; silent?: boolean }) => Promise<unknown>;
  writeEligible?: (requestId: number | null, scopeKey: string) => boolean;
}) {
  const {
    stagedFile,
    stagedDiscardNotice,
    uploading,
    saving,
    lastProcessResult,
    processReadbackFailed,
    processReadbackRetrying,
    uploadFile,
    clearStagedFile,
    beginEditScope,
    saveProcess,
    retryProcessReadback,
    downloadFile,
  } = useEngineerRepairProcessWorkbench(requestId, reload, {
    writeBlocked: !canWrite || readOnly,
    scopeKey,
    writeEligible,
  });

  const [form] = Form.useForm<ProcessFormValues>();
  const [editingEntry, setEditingEntry] = useState<EngineerRepairProcessEntry | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [editBlockedMessage, setEditBlockedMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 编辑上下文只随「正在编辑的过程」变化；换工单/账号由面板 key 强制重挂载清空
    if (editingEntry) {
      form.setFieldsValue({
        operationText: editingEntry.operationText,
        testResult: editingEntry.testResult ?? undefined,
        occurredAt: editingEntry.occurredAt
          ? toDateTimeLocalValue(editingEntry.occurredAt)
          : undefined,
      });
    } else {
      form.resetFields();
    }
  }, [editingEntry, form]);

  const handleUpload = async (file: File | null | undefined) => {
    if (!file || !canWrite || readOnly) return;
    setUploadError(null);
    setEditBlockedMessage(null);
    const validationError = validateProcessFile(file);
    if (validationError) {
      setUploadError(validationError);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    const result = await uploadFile(file);
    if (result && !result.ok) {
      setUploadError(result.message);
    }
  };

  /**
   * 已有原件的过程不允许通过编辑替换/移除，因此暂存原件只能用于「无原件过程」的补传；
   * 目标过程已有原件时显式拦截，绝不静默丢弃暂存文件。
   */
  const handleStartEdit = (entry: EngineerRepairProcessEntry) => {
    if (stagedFile && entry.fileId !== null) {
      setEditBlockedMessage('该过程已有原件，编辑不能替换或移除；已有暂存原件请先保存为新增过程。');
      return;
    }
    setEditBlockedMessage(null);
    setUploadError(null);
    beginEditScope(entry.id);
    setEditingEntry(entry);
  };

  const handleCancelEdit = () => {
    setUploadError(null);
    beginEditScope('new');
    setEditingEntry(null);
  };

  const handleDownload = async (fileId: string) => {
    setDownloadError(null);
    const result = await downloadFile(fileId);
    if (!result.ok) {
      setDownloadError(result.message);
      return;
    }
    triggerBrowserDownload(result.blob, result.filename);
  };

  const handleSubmit = async (values: ProcessFormValues) => {
    const input: RepairProcessFormInput = {
      operationText: values.operationText,
      testResult: values.testResult?.trim() ? values.testResult : null,
      occurredAt: toIsoOrNull(values.occurredAt),
    };
    const result = await saveProcess(input, editingEntry);
    if (result?.ok) {
      beginEditScope('new');
      setEditingEntry(null);
      setEditBlockedMessage(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (!canWrite && processEntries.length === 0) {
    return null;
  }

  return (
    <section className="mt-5 border-t border-border pt-4">
      <h4 className="mb-3 font-medium text-sm">内部维修过程</h4>
      <div className="flex flex-col gap-4">
        {processEntries.length > 0 ? (
          <Timeline
            items={processEntries.map((entry) => ({
              content: (
                <ProcessEntryItem
                  disabled={!canWrite || readOnly}
                  entry={entry}
                  onDownload={(fileId) => void handleDownload(fileId)}
                  onEdit={handleStartEdit}
                />
              ),
              key: entry.entryUuid,
            }))}
          />
        ) : (
          <div className="text-sm text-text-secondary">暂无内部维修过程。</div>
        )}

        {editBlockedMessage ? <Alert showIcon title={editBlockedMessage} type="warning" /> : null}

        {stagedDiscardNotice ? <Alert showIcon title={stagedDiscardNotice} type="warning" /> : null}

        {downloadError ? <Alert showIcon title={downloadError} type="error" /> : null}

        {canWrite && !readOnly ? (
          <div className="flex flex-col gap-3">
            <div className="font-medium text-sm">
              {editingEntry ? '编辑维修过程' : '新增维修过程'}
            </div>
            <Form form={form} layout="vertical" onFinish={(values) => void handleSubmit(values)}>
              <Form.Item
                label="执行操作"
                name="operationText"
                rules={[{ message: '请填写执行操作。', required: true, whitespace: true }]}
              >
                <Input.TextArea disabled={saving} placeholder="记录实际执行的操作…" rows={3} />
              </Form.Item>
              <Form.Item label="测试事实" name="testResult">
                <Input.TextArea disabled={saving} placeholder="记录测试结果（可选）…" rows={2} />
              </Form.Item>
              <Form.Item
                label="事件时间（可选；留空使用服务端时间）"
                name="occurredAt"
                extra="人工填写时按本机时区转换为 ISO 时间保存。"
              >
                <Input disabled={saving} type="datetime-local" />
              </Form.Item>

              {editingEntry && editingEntry.fileId !== null ? (
                <div className="mb-4 text-text-secondary text-xs">
                  编辑不修改已绑定原件；如需追加另一份原件请新建过程记录。
                </div>
              ) : (
                <Form.Item
                  extra="步骤：选择文件后自动上传为暂存 → 点击「保存过程」才把原件绑定到该记录。"
                  label={editingEntry ? '补传原件（可选）' : '原件（可选）'}
                >
                  <div className="flex flex-col gap-2">
                    {stagedFile ? (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--panel-border)] p-3">
                        <Tag color="orange">已上传暂存</Tag>
                        <span className="text-text-secondary text-xs">未保存</span>
                        <span className="text-sm">{stagedFile.originalFilename}</span>
                        <span className="text-text-secondary text-xs">
                          {stagedFile.byteSize} 字节
                        </span>
                        <Button
                          disabled={saving}
                          onClick={() => {
                            clearStagedFile();
                            setUploadError(null);
                            if (fileInputRef.current) fileInputRef.current.value = '';
                          }}
                          size="small"
                          type="link"
                        >
                          移除暂存
                        </Button>
                      </div>
                    ) : (
                      <label
                        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--panel-border)] px-4 py-6 text-center transition-colors hover:border-[var(--accent)] hover:bg-[var(--filter-bar-bg)] ${
                          saving || uploading ? 'cursor-not-allowed opacity-60' : ''
                        }`}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (saving || uploading) return;
                          void handleUpload(event.dataTransfer.files?.[0]);
                        }}
                      >
                        <input
                          accept={PROCESS_FILE_ACCEPT}
                          aria-label="选择过程原件"
                          className="hidden"
                          disabled={saving || uploading}
                          onChange={(event) => void handleUpload(event.target.files?.[0])}
                          ref={fileInputRef}
                          type="file"
                        />
                        {uploading ? (
                          <>
                            <Tag color="processing">上传中</Tag>
                            <span className="text-sm">正在上传原件，请稍候…</span>
                          </>
                        ) : (
                          <>
                            <span className="text-sm font-medium">点击选择或拖拽文件到此处</span>
                            <span className="text-text-secondary text-xs">
                              支持 PDF / Word / Excel / PPT / 图片 / TXT / MD / CSV，单个文件不超过
                              20 MB。
                            </span>
                          </>
                        )}
                      </label>
                    )}
                    {stagedFile ? (
                      <div className="text-text-secondary text-xs">
                        暂存尚未绑定：保存过程后才会出现在该记录的「已保存绑定」中，并可下载。
                      </div>
                    ) : null}
                  </div>
                </Form.Item>
              )}

              {uploadError ? <Alert showIcon title={uploadError} type="error" /> : null}
              <ProcessFeedbackAlert
                onReload={() => void reload()}
                onRetryReadback={() => void retryProcessReadback()}
                readbackFailed={processReadbackFailed}
                readbackRetrying={processReadbackRetrying}
                result={lastProcessResult}
              />

              <div className="flex flex-wrap gap-2">
                <Button htmlType="submit" loading={saving} type="primary">
                  {editingEntry
                    ? stagedFile
                      ? '保存修改并绑定原件'
                      : '保存修改'
                    : stagedFile
                      ? '保存过程并绑定原件'
                      : '保存过程'}
                </Button>
                {editingEntry ? (
                  <Button disabled={saving} onClick={handleCancelEdit}>
                    取消编辑
                  </Button>
                ) : null}
              </div>
            </Form>
          </div>
        ) : null}

        {readOnly ? (
          <div className="text-sm text-text-secondary">工单已结单，内部维修过程只读。</div>
        ) : null}
      </div>
    </section>
  );
}

export function EngineerRepairCloseSection({
  requestId,
  scopeKey,
  canWrite,
  reload,
  closedByMutation,
  onCloseSucceeded,
  onCloseReadbackSucceeded,
  writeEligible,
}: {
  requestId: number;
  scopeKey: string;
  canWrite: boolean;
  reload: (options?: { shouldApply?: () => boolean; silent?: boolean }) => Promise<unknown>;
  closedByMutation: boolean;
  onCloseSucceeded: () => void;
  onCloseReadbackSucceeded: () => void;
  writeEligible?: (requestId: number | null, scopeKey: string) => boolean;
}) {
  const {
    closing,
    lastCloseResult,
    lastInterruptResult,
    closeReadbackFailed,
    closeReadbackRetrying,
    closeRequest,
    interruptRequest,
    retryCloseReadback,
  } = useEngineerRepairProcessWorkbench(requestId, reload, {
    writeBlocked: closedByMutation,
    scopeKey,
    writeEligible,
    onCloseSucceeded,
    onCloseReadbackSucceeded,
  });
  const [form] = Form.useForm<{
    handlingResult: RepairRequestHandlingResult;
    closureReason?: string;
  }>();
  const selectedResult = Form.useWatch('handlingResult', form);

  useEffect(() => {
    form.resetFields();
  }, [requestId, scopeKey, form]);

  if (!canWrite) {
    return null;
  }

  if (closedByMutation) {
    return (
      <section className="mt-5 border-t border-border pt-4">
        <h4 className="mb-3 font-medium text-sm">结单</h4>
        <div className="flex flex-col gap-3">
          {lastCloseResult ? (
            <CloseFeedbackAlert
              onReload={() => void reload()}
              onRetryReadback={() => void retryCloseReadback()}
              readbackFailed={closeReadbackFailed}
              readbackRetrying={closeReadbackRetrying}
              result={lastCloseResult}
            />
          ) : (
            /*
             * 结单成功事实来自会话级存储（页面重挂载前已明确成功），
             * 本实例没有 mutation 结果但屏障仍在：保留“尚未确认 + 重试”，
             * 让用户仍可刷新采用服务端已结束详情，而不是静默丢失入口。
             */
            <CloseReadbackUnconfirmedAlert
              onRetryReadback={() => void retryCloseReadback()}
              readbackRetrying={closeReadbackRetrying}
            />
          )}
          <div className="text-sm text-text-secondary">
            工单已结单，内部维修过程与回复已转为只读。
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-5 border-t border-border pt-4">
      <h4 className="mb-3 font-medium text-sm">结单</h4>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          const reason = values.closureReason?.trim() ? values.closureReason.trim() : null;
          // 维修中断与结单分离：中断只记录原因与处理状态，不结单、不建立只读屏障。
          if (values.handlingResult === 'INTERRUPTED') {
            void interruptRequest(reason ?? '');
            return;
          }
          void closeRequest(values.handlingResult, reason);
        }}
      >
        <Form.Item
          label="处理结果"
          name="handlingResult"
          rules={[{ message: '请选择处理结果。', required: true }]}
        >
          <Select disabled={closing} options={HANDLING_RESULT_OPTIONS} placeholder="选择处理结果" />
        </Form.Item>
        <Form.Item
          extra={
            requiresReason(selectedResult) ? '中断或无法修复时必须填写原因。' : '可填写补充说明。'
          }
          label="结单原因"
          name="closureReason"
          rules={[
            {
              validator: (_rule, value: string | undefined) =>
                requiresReason(selectedResult) && !value?.trim()
                  ? Promise.reject(new Error('中断或无法修复时必须填写结单原因。'))
                  : Promise.resolve(),
            },
          ]}
        >
          <Input.TextArea disabled={closing} placeholder="说明结单原因…" rows={3} />
        </Form.Item>
        <CloseFeedbackAlert
          onReload={() => void reload()}
          onRetryReadback={() => void retryCloseReadback()}
          readbackFailed={closeReadbackFailed}
          readbackRetrying={closeReadbackRetrying}
          result={lastCloseResult}
        />
        {lastInterruptResult ? (
          <div className="mb-3">
            <Alert
              title={
                lastInterruptResult.ok
                  ? '已记录维修中断，工单未结单，仍可继续保存维修记录和回复。'
                  : lastInterruptResult.message
              }
              showIcon
              type={lastInterruptResult.ok ? 'success' : 'error'}
            />
          </div>
        ) : null}
        <Popconfirm
          cancelText="取消"
          description={
            selectedResult === 'INTERRUPTED'
              ? '记录中断不会结单，之后仍可继续处理。'
              : '结单后内部过程与回复将只读，且不可再次结单。'
          }
          okText={selectedResult === 'INTERRUPTED' ? '记录中断' : '确认结单'}
          onConfirm={() => form.submit()}
          title={
            selectedResult === 'INTERRUPTED' ? '确认记录本次维修中断？' : '确认结单该维修申请？'
          }
        >
          <Button loading={closing} type="primary">
            {selectedResult === 'INTERRUPTED' ? '记录中断' : '结单'}
          </Button>
        </Popconfirm>
      </Form>
    </section>
  );
}

function toDateTimeLocalValue(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// src/shared/ui/maintenance-record-editor/index.tsx

/**
 * 结构化内部维修记录编辑器（任务 04）。
 *
 * - 受控组件：值由调用方持有，本组件只负责渲染与局部编辑；
 * - 工程师端与管理员修订弹窗共用；
 * - 只读/禁用态保留全部内容与附件展示，仅关闭编辑与操作入口；
 * - 值模型与纯函数见 ./model。
 */

import { type ReactNode, useRef } from 'react';
import { Button, Input, Popconfirm, Select, Tag } from 'antd';

import { useI18n } from '@/shared/i18n';

import {
  createEmptyPanel,
  findInitialPanel,
  findResetPanel,
  findStepPanel,
  MAINTENANCE_PHASE_CODES,
  MAINTENANCE_RESET_RESULTS,
  MAINTENANCE_STEP_RESULTS,
  type MaintenanceAttachmentValue,
  type MaintenanceEditorValue,
  type MaintenancePanelValue,
  type MaintenancePhaseCode,
  type MaintenanceResetResult,
  type MaintenanceStepResult,
  type MaintenanceStepValue,
  MAX_ENGINEER_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PANEL_TEXT_LENGTH,
  MAX_STEP_TEXT_LENGTH,
  nextLocalKey,
  PHASE_LABEL_KEYS,
  RESET_RESULT_LABEL_KEYS,
  STEP_RESULT_LABEL_KEYS,
  toStepResult,
} from './model';

function Field({
  children,
  label,
  wide = false,
}: {
  children: ReactNode;
  label: string;
  wide?: boolean;
}) {
  return (
    <label
      className={`flex min-w-0 flex-col gap-1 text-sm ${wide ? 'sm:col-span-2 lg:col-span-3' : ''}`}
    >
      <span className="text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function PanelFields({
  disabled,
  label,
  onChange,
  panel,
}: {
  disabled: boolean;
  label: string;
  onChange: (panel: MaintenancePanelValue) => void;
  panel: MaintenancePanelValue;
}) {
  const { t } = useI18n();
  const update = (patch: Partial<MaintenancePanelValue>) => onChange({ ...panel, ...patch });

  return (
    <div className="rounded-lg border border-[var(--panel-border)] p-3">
      <div className="mb-2 font-medium text-sm">{label}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t('maintenance.panel.mainError')}>
          <Input
            disabled={disabled}
            maxLength={MAX_PANEL_TEXT_LENGTH}
            onChange={(event) => update({ mainError: event.target.value })}
            value={panel.mainError}
          />
        </Field>
        <Field label={t('maintenance.panel.unitError')}>
          <Input
            disabled={disabled}
            maxLength={MAX_PANEL_TEXT_LENGTH}
            onChange={(event) => update({ unitError: event.target.value })}
            value={panel.unitError}
          />
        </Field>
        <Field label={t('maintenance.panel.source')}>
          <Input
            disabled={disabled}
            maxLength={MAX_PANEL_TEXT_LENGTH}
            onChange={(event) => update({ source: event.target.value })}
            value={panel.source}
          />
        </Field>
        <Field label={t('maintenance.panel.errorType')}>
          <Input
            disabled={disabled}
            maxLength={MAX_PANEL_TEXT_LENGTH}
            onChange={(event) => update({ errorType: event.target.value })}
            value={panel.errorType}
          />
        </Field>
        <Field label={t('maintenance.panel.gpibStatus')}>
          <Input
            disabled={disabled}
            maxLength={MAX_PANEL_TEXT_LENGTH}
            onChange={(event) => update({ gpibStatus: event.target.value })}
            value={panel.gpibStatus}
          />
        </Field>
        <Field label={t('maintenance.panel.faultStatus')}>
          <Input
            disabled={disabled}
            maxLength={MAX_PANEL_TEXT_LENGTH}
            onChange={(event) => update({ faultStatus: event.target.value })}
            value={panel.faultStatus}
          />
        </Field>
        <Field label={t('maintenance.panel.phaseCode')}>
          <Select
            allowClear
            disabled={disabled}
            onChange={(next: MaintenancePhaseCode | undefined) =>
              update({ phaseCode: next ?? '' })
            }
            options={MAINTENANCE_PHASE_CODES.map((code) => ({
              label: t(PHASE_LABEL_KEYS[code]),
              value: code,
            }))}
            placeholder={t('maintenance.panel.phasePlaceholder')}
            style={{ width: '100%' }}
            value={panel.phaseCode === '' ? undefined : panel.phaseCode}
          />
        </Field>
        <Field label={`${t('maintenance.panel.description')} *`} wide>
          <Input.TextArea
            disabled={disabled}
            maxLength={MAX_NOTE_LENGTH}
            onChange={(event) => update({ description: event.target.value })}
            placeholder={t('maintenance.panel.descriptionPlaceholder')}
            rows={3}
            value={panel.description}
          />
        </Field>
        <Field label={t('maintenance.panel.action')} wide>
          <Input.TextArea
            disabled={disabled}
            maxLength={MAX_NOTE_LENGTH}
            onChange={(event) => update({ action: event.target.value })}
            placeholder={t('maintenance.panel.actionPlaceholder')}
            rows={2}
            value={panel.action}
          />
        </Field>
      </div>
    </div>
  );
}

export type MaintenanceEditorAttachmentProps = {
  stagedFile: MaintenanceAttachmentValue | null;
  uploading: boolean;
  downloadingFileId?: string | null;
  onSelectFile: (file: File) => void;
  onClearStaged: () => void;
  onDownload: (fileId: string) => void;
  readOnly?: boolean;
};

const ATTACHMENT_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.md,.csv';

function AttachmentArea({
  attachment,
  disabled,
  value,
}: {
  attachment: MaintenanceEditorAttachmentProps;
  disabled: boolean;
  value: MaintenanceEditorValue;
}) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readOnly = attachment.readOnly === true;

  if (value.attachment) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--panel-border)] p-3">
          <Tag color="green">{t('maintenance.attachmentBound')}</Tag>
          <span className="text-sm">{value.attachment.originalFilename}</span>
          <span className="text-text-secondary text-xs">
            {value.attachment.byteSize} B
          </span>
          <Button
            loading={attachment.downloadingFileId === value.attachment.fileId}
            onClick={() => attachment.onDownload(value.attachment!.fileId)}
            size="small"
          >
            {t('maintenance.attachmentDownload')}
          </Button>
        </div>
        <div className="text-text-secondary text-xs">
          {readOnly ? t('maintenance.attachmentAdminReadOnly') : t('maintenance.attachmentImmutable')}
        </div>
      </div>
    );
  }

  if (readOnly) {
    return <div className="text-sm text-text-secondary">—</div>;
  }

  if (attachment.stagedFile) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--panel-border)] p-3">
          <Tag color="orange">{t('maintenance.attachmentStaged')}</Tag>
          <span className="text-text-secondary text-xs">{t('maintenance.attachmentNotSaved')}</span>
          <span className="text-sm">{attachment.stagedFile.originalFilename}</span>
          <span className="text-text-secondary text-xs">{attachment.stagedFile.byteSize} B</span>
          <Button
            disabled={disabled}
            onClick={() => {
              attachment.onClearStaged();
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
            size="small"
            type="link"
          >
            {t('maintenance.attachmentRemoveStaged')}
          </Button>
        </div>
        <div className="text-text-secondary text-xs">{t('maintenance.attachmentHint')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--panel-border)] px-4 py-6 text-center transition-colors hover:border-[var(--accent)] hover:bg-[var(--filter-bar-bg)] ${
          disabled || attachment.uploading ? 'cursor-not-allowed opacity-60' : ''
        }`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (disabled || attachment.uploading) return;
          const file = event.dataTransfer.files?.[0];
          if (file) attachment.onSelectFile(file);
        }}
      >
        <input
          accept={ATTACHMENT_ACCEPT}
          aria-label={t('maintenance.attachment')}
          className="hidden"
          disabled={disabled || attachment.uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) attachment.onSelectFile(file);
          }}
          ref={fileInputRef}
          type="file"
        />
        {attachment.uploading ? (
          <>
            <Tag color="processing">{t('maintenance.attachmentUploading')}</Tag>
            <span className="text-sm">{t('maintenance.attachmentSelect')}</span>
          </>
        ) : (
          <>
            <span className="font-medium text-sm">{t('maintenance.attachmentSelect')}</span>
            <span className="text-text-secondary text-xs">{t('maintenance.attachmentTypeHint')}</span>
          </>
        )}
      </label>
      <div className="text-text-secondary text-xs">{t('maintenance.attachmentHint')}</div>
    </div>
  );
}

export function MaintenanceRecordEditor({
  attachment,
  disabled = false,
  onChange,
  readOnly = false,
  value,
}: {
  value: MaintenanceEditorValue;
  onChange: (value: MaintenanceEditorValue) => void;
  readOnly?: boolean;
  disabled?: boolean;
  attachment?: MaintenanceEditorAttachmentProps;
}) {
  const { t } = useI18n();
  const locked = readOnly || disabled;

  const updateStep = (key: string, patch: Partial<MaintenanceStepValue>) => {
    onChange({
      ...value,
      steps: value.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
    });
  };

  const updatePanel = (key: string, nextPanel: MaintenancePanelValue) => {
    onChange({
      ...value,
      panels: value.panels.map((panel) => (panel.key === key ? nextPanel : panel)),
    });
  };

  const changeStepResult = (step: MaintenanceStepValue, resultCode: string) => {
    const nextResult = toStepResult(resultCode);
    const existingPanel = findStepPanel(value, step.key);
    const panels = value.panels.filter(
      (panel) => !(panel.panelType === 'STEP_NEW_FAULT' && panel.stepKey === step.key),
    );
    if (nextResult === 'NEW_FAULT') {
      panels.push(existingPanel ?? createEmptyPanel('STEP_NEW_FAULT', step.key));
    }
    onChange({
      ...value,
      steps: value.steps.map((item) =>
        item.key === step.key ? { ...item, resultCode: nextResult } : item,
      ),
      panels,
    });
  };

  const changeResetResult = (next: MaintenanceResetResult | undefined) => {
    const resetResult = next ?? '';
    const panels = value.panels.filter((panel) => panel.panelType !== 'RESET_NEW_FAULT');
    if (resetResult === 'NEW_FAULT') {
      const existing = findResetPanel(value);
      panels.push(existing ?? createEmptyPanel('RESET_NEW_FAULT'));
    }
    onChange({ ...value, resetResult, panels });
  };

  const removeStep = (step: MaintenanceStepValue) => {
    onChange({
      ...value,
      steps: value.steps.filter((item) => item.key !== step.key),
      panels: value.panels.filter(
        (panel) => !(panel.panelType === 'STEP_NEW_FAULT' && panel.stepKey === step.key),
      ),
    });
  };

  const moveStep = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= value.steps.length) {
      return;
    }
    const steps = [...value.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    onChange({ ...value, steps });
  };

  const initialPanel = findInitialPanel(value) ?? createEmptyPanel('INITIAL');
  const resetPanel = findResetPanel(value);

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h5 className="m-0 font-medium text-sm">{t('maintenance.basicInfo')}</h5>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('maintenance.maintenanceDate')}>
            <Input
              disabled={locked}
              onChange={(event) => onChange({ ...value, maintenanceDate: event.target.value })}
              type="date"
              value={value.maintenanceDate}
            />
          </Field>
          <Field label={t('maintenance.engineerName')}>
            <Input
              disabled={locked}
              maxLength={MAX_ENGINEER_NAME_LENGTH}
              onChange={(event) => onChange({ ...value, engineerName: event.target.value })}
              placeholder={t('maintenance.engineerNamePlaceholder')}
              value={value.engineerName}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h5 className="m-0 font-medium text-sm">{t('maintenance.initialFault')}</h5>
        <PanelFields
          disabled={locked}
          label={t('maintenance.initialFault')}
          onChange={(panel) => {
            const exists = findInitialPanel(value);
            onChange({
              ...value,
              panels: exists
                ? value.panels.map((item) => (item.key === panel.key ? panel : item))
                : [...value.panels, panel],
            });
          }}
          panel={initialPanel}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h5 className="m-0 font-medium text-sm">{t('maintenance.resetResult')}</h5>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('maintenance.resetResult')}>
            <Select
              allowClear
              disabled={locked}
              onChange={(next: MaintenanceResetResult | undefined) => changeResetResult(next)}
              options={MAINTENANCE_RESET_RESULTS.map((result) => ({
                label: t(RESET_RESULT_LABEL_KEYS[result]),
                value: result,
              }))}
              placeholder={t('maintenance.resetResultPlaceholder')}
              style={{ width: '100%' }}
              value={value.resetResult === '' ? undefined : value.resetResult}
            />
          </Field>
        </div>
        {value.resetResult === 'NEW_FAULT' && resetPanel ? (
          <PanelFields
            disabled={locked}
            label={t('maintenance.resetNewFault')}
            onChange={(panel) => updatePanel(panel.key, panel)}
            panel={resetPanel}
          />
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h5 className="m-0 font-medium text-sm">{t('maintenance.steps')}</h5>
        {value.steps.length === 0 ? (
          <div className="text-sm text-text-secondary">{t('maintenance.stepsEmpty')}</div>
        ) : null}
        {value.steps.map((step, index) => {
          const stepPanel = findStepPanel(value, step.key);
          return (
            <div className="flex flex-col gap-3" key={step.key}>
              <div className="rounded-lg border border-[var(--panel-border)] p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-sm">
                    {t('maintenance.stepTitle', { index: index + 1 })}
                  </span>
                  {!locked ? (
                    <div className="flex flex-wrap gap-1">
                      <Button
                        disabled={index === 0}
                        onClick={() => moveStep(index, -1)}
                        size="small"
                      >
                        {t('maintenance.moveUp')}
                      </Button>
                      <Button
                        disabled={index === value.steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                        size="small"
                      >
                        {t('maintenance.moveDown')}
                      </Button>
                      <Popconfirm
                        cancelText={t('common.cancel')}
                        description={t('maintenance.removeStepConfirmDescription')}
                        okText={t('common.delete')}
                        onConfirm={() => removeStep(step)}
                        title={t('maintenance.removeStepConfirmTitle')}
                      >
                        <Button danger size="small">
                          {t('maintenance.removeStep')}
                        </Button>
                      </Popconfirm>
                    </div>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('maintenance.stepErrorCode')}>
                    <Input
                      disabled={locked}
                      maxLength={MAX_STEP_TEXT_LENGTH}
                      onChange={(event) => updateStep(step.key, { errorCode: event.target.value })}
                      value={step.errorCode}
                    />
                  </Field>
                  <Field label={t('maintenance.stepPartName')}>
                    <Input
                      disabled={locked}
                      maxLength={MAX_STEP_TEXT_LENGTH}
                      onChange={(event) => updateStep(step.key, { partName: event.target.value })}
                      value={step.partName}
                    />
                  </Field>
                  <Field label={`${t('maintenance.stepAction')} *`} wide>
                    <Input.TextArea
                      disabled={locked}
                      onChange={(event) =>
                        updateStep(step.key, { actionText: event.target.value })
                      }
                      placeholder={t('maintenance.stepActionPlaceholder')}
                      rows={3}
                      value={step.actionText}
                    />
                  </Field>
                  <Field label={`${t('maintenance.stepResult')} *`}>
                    <Select
                      allowClear
                      disabled={locked}
                      onChange={(next: MaintenanceStepResult | undefined) =>
                        changeStepResult(step, next ?? '')
                      }
                      options={MAINTENANCE_STEP_RESULTS.map((result) => ({
                        label: t(STEP_RESULT_LABEL_KEYS[result]),
                        value: result,
                      }))}
                      placeholder={t('maintenance.stepResultPlaceholder')}
                      style={{ width: '100%' }}
                      value={step.resultCode === '' ? undefined : step.resultCode}
                    />
                  </Field>
                </div>
              </div>
              {step.resultCode === 'NEW_FAULT' && stepPanel ? (
                <PanelFields
                  disabled={locked}
                  label={t('maintenance.stepNewFault', { index: index + 1 })}
                  onChange={(panel) => updatePanel(panel.key, panel)}
                  panel={stepPanel}
                />
              ) : null}
            </div>
          );
        })}
        {!locked ? (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                onChange({
                  ...value,
                  steps: [
                    ...value.steps,
                    {
                      key: nextLocalKey('step'),
                      id: null,
                      errorCode: '',
                      partName: '',
                      actionText: '',
                      resultCode: '',
                    },
                  ],
                })
              }
            >
              {t('maintenance.addStep')}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h5 className="m-0 font-medium text-sm">{t('maintenance.supplementaryNote')}</h5>
        <Input.TextArea
          disabled={locked}
          maxLength={MAX_NOTE_LENGTH}
          onChange={(event) => onChange({ ...value, supplementaryNote: event.target.value })}
          placeholder={t('maintenance.supplementaryNotePlaceholder')}
          rows={3}
          value={value.supplementaryNote}
        />
      </section>

      {attachment ? (
        <section className="flex flex-col gap-3">
          <h5 className="m-0 font-medium text-sm">{t('maintenance.attachment')}</h5>
          <AttachmentArea attachment={attachment} disabled={locked} value={value} />
        </section>
      ) : null}
    </div>
  );
}

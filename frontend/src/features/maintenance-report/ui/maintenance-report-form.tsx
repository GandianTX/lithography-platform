// src/features/maintenance-report/ui/maintenance-report-form.tsx
//
// 维修报告表单（任务 06，2026-11-20 需求调整）：取消分步切换，改为单页纵向滚动，
// 依次为 基本信息 → 初始故障与复位 → 排查步骤 → 维修结果与说明。
// 右侧纵向目录：点击跳转、随滚动/当前输入区域变化高亮当前位置——
// 高亮只表示"正在查看的位置"，不代表保存成功或校验通过。
// 故障/复位/步骤/说明四段直接复用任务 04 的纯编辑组件，按分区拆三个受控实例。
//
// 2026-11-21 需求调整：填写页不再内嵌预览区域；「查看预览」按钮用弹窗展示
// 当前表单（只取有效分支）的只读预览——开/关弹窗是纯本地状态，不创建报告、
// 不保存草稿、不上传附件、不提交，关闭后输入/附件/滚动位置均保留。
//
// 纯受控组件：不发请求、不自动保存；打开页面、滚动、跳转与预览都不创建或修改报告。
// 窄屏（<lg）目录收起，不遮挡表单。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';

import { type MessageKey, useI18n } from '@/shared/i18n';
import { MaintenanceRecordEditor } from '@/shared/ui/maintenance-record-editor';
import type { MaintenanceEditorValue } from '@/shared/ui/maintenance-record-editor/model';

import type { EquipmentModelOption } from '../infrastructure/maintenance-report.types';
import {
  CLOSURE_REASON_REQUIRED_RESULTS,
  type MaintenanceReportForm,
  REPORT_HANDLING_RESULTS,
  REPORT_TEXT_LIMITS,
  type ReportFormIssue,
  toReportDraftInput,
} from '../model/report-form';

const { TextArea } = Input;

/** 单页分区（与右侧目录一一对应）；预览已改为弹窗，不再占目录项 */
const SECTION_KEYS = ['basic', 'fault', 'troubleshoot', 'result'] as const;
type ReportSectionKey = (typeof SECTION_KEYS)[number];

const SECTION_LABEL_KEYS: Record<ReportSectionKey, MessageKey> = {
  basic: 'maintenanceReport.step.basic',
  fault: 'maintenanceReport.step.fault',
  troubleshoot: 'maintenanceReport.step.troubleshoot',
  result: 'maintenanceReport.step.result',
};

const SECTION_DOM_IDS: Record<ReportSectionKey, string> = {
  basic: 'maintenance-report-section-basic',
  fault: 'maintenance-report-section-fault',
  troubleshoot: 'maintenance-report-section-troubleshoot',
  result: 'maintenance-report-section-result',
};

const HANDLING_LABEL_KEYS: Record<(typeof REPORT_HANDLING_RESULTS)[number], MessageKey> = {
  FIXED: 'status.handlingResult.FIXED',
  PART_PURCHASED: 'status.handlingResult.PART_PURCHASED',
  PROVIDE_PLAN_SELF_EXECUTE: 'status.handlingResult.PROVIDE_PLAN_SELF_EXECUTE',
  INTERRUPTED: 'status.handlingResult.INTERRUPTED',
  UNREPAIRABLE: 'status.handlingResult.UNREPAIRABLE',
};

const ISSUE_FIELD_LABEL_KEYS: Record<ReportFormIssue['field'], MessageKey> = {
  customerFactoryName: 'maintenanceReport.field.customerFactory',
  equipmentModelText: 'maintenanceReport.field.equipmentModel',
  actualCause: 'maintenanceReport.field.actualCause',
  repairActions: 'maintenanceReport.field.repairActions',
  verificationResult: 'maintenanceReport.field.verification',
  supplementaryNote: 'maintenanceReport.section.note',
  closureReason: 'maintenanceReport.field.closureReason',
  handlingResult: 'maintenanceReport.field.handlingResult',
};

export type MaintenanceReportFormViewProps = {
  form: MaintenanceReportForm;
  onChange: (next: MaintenanceReportForm) => void;
  onSaveDraft: () => void;
  saving: boolean;
  canEdit: boolean;
  issues: ReportFormIssue[];
  saveError: string | null;
  saveMessage: string | null;
  models: EquipmentModelOption[];
  /** 正式提交（R051-01）：组件只负责确认，幂等与归属裁决在服务端 */
  onSubmitFormal?: () => void;
  submitting?: boolean;
  /** 切走已填写故障分支前的确认；返回 false 保持原分支 */
  onConfirmDiscardBranch: (label: string) => boolean;
};

export function MaintenanceReportFormView({
  form,
  onChange,
  onSaveDraft,
  saving,
  canEdit,
  issues,
  saveError,
  saveMessage,
  models,
  onSubmitFormal,
  submitting = false,
  onConfirmDiscardBranch,
}: MaintenanceReportFormViewProps) {
  const { t } = useI18n();
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  /** 2026-11-21：预览弹窗（纯本地状态，开关不产生任何写请求） */
  const [previewOpen, setPreviewOpen] = useState(false);
  /** 当前所在分区（滚动监听更新）：只表示查看位置，不代表保存/校验状态 */
  const [activeSection, setActiveSection] = useState<ReportSectionKey>('basic');
  const sectionRefs = useRef<Partial<Record<ReportSectionKey, HTMLElement | null>>>({});

  const changeEditor = (editor: MaintenanceEditorValue) => {
    onChange({ ...form, editor });
  };

  const patch = (next: Partial<MaintenanceReportForm>) => {
    onChange({ ...form, ...next });
  };

  const closureReasonRequired =
    form.handlingResult !== '' && CLOSURE_REASON_REQUIRED_RESULTS.includes(form.handlingResult);

  // 滚动监听：以「视口顶部之下最近的分区」为当前位置；只更新高亮，不写库
  useEffect(() => {
    let frame = 0;
    const updateActive = () => {
      frame = 0;
      let current: ReportSectionKey = 'basic';
      for (const key of SECTION_KEYS) {
        const element = sectionRefs.current[key];
        if (element === undefined || element === null) continue;
        if (element.getBoundingClientRect().top <= 140) current = key;
      }
      setActiveSection((previous) => (previous === current ? previous : current));
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(updateActive);
    };
    updateActive();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  const jumpToSection = (key: ReportSectionKey) => {
    const element = sectionRefs.current[key];
    if (element === undefined || element === null) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const issueText = (issue: ReportFormIssue): string => {
    const field = t(ISSUE_FIELD_LABEL_KEYS[issue.field]);
    if (issue.kind === 'closureReasonRequired') {
      return t('maintenanceReport.issues.closureReasonRequired');
    }
    if (issue.kind === 'closureReasonNotAllowed') {
      return t('maintenanceReport.issues.closureReasonNotAllowed');
    }
    return t('maintenanceReport.issues.tooLong', {
      field,
      limit: issue.limit ?? 0,
    });
  };

  const actionButtons = (
    <Space wrap>
      {canEdit ? (
        <Button loading={saving} type="primary" onClick={onSaveDraft}>
          {saving ? t('maintenanceReport.saving') : t('maintenanceReport.saveDraft')}
        </Button>
      ) : null}
      {canEdit && onSubmitFormal ? (
        <Button danger loading={submitting} onClick={() => setConfirmingSubmit(true)}>
          {submitting ? t('maintenanceReport.submitting') : t('maintenanceReport.submitFormal')}
        </Button>
      ) : null}
      <Button onClick={() => setPreviewOpen(true)}>{t('maintenanceReport.preview.view')}</Button>
    </Space>
  );

  return (
    <Row gutter={[24, 24]}>
      <Col lg={19} xs={24}>
        <Space orientation="vertical" size="large" style={{ width: '100%' }}>
          <Alert type="info" showIcon title={t('maintenanceReport.currentStepHint')} />

          {canEdit ? null : (
            <Alert
              type="warning"
              showIcon
              title={t('maintenanceReport.readOnly')}
              description={t('maintenanceReport.readOnlyHint')}
            />
          )}

          {saveError === null ? null : <Alert type="error" showIcon title={saveError} />}
          {saveMessage === null ? null : <Alert type="success" showIcon title={saveMessage} />}
          {issues.length === 0 ? null : (
            <Alert
              type="warning"
              showIcon
              title={t('maintenanceReport.issues.title')}
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {issues.map((issue, index) => (
                    <li key={`${issue.kind}-${String(issue.field)}-${index}`}>
                      {issueText(issue)}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {actionButtons}

          <div
            id={SECTION_DOM_IDS.basic}
            ref={(element) => {
              sectionRefs.current.basic = element;
            }}
          >
            <Card title={t('maintenanceReport.step.basic')}>
              <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                <Field label={t('maintenanceReport.field.customerFactory')}>
                  <Input
                    aria-label={t('maintenanceReport.field.customerFactory')}
                    disabled={!canEdit}
                    maxLength={REPORT_TEXT_LIMITS.customerFactoryName}
                    placeholder={t('maintenanceReport.factoryPlaceholder')}
                    value={form.customerFactoryName}
                    onChange={(event) => patch({ customerFactoryName: event.target.value })}
                  />
                </Field>
                <Field label={t('maintenanceReport.field.equipmentModel')}>
                  <Space orientation="vertical" size="small" style={{ width: '100%' }}>
                    <Select
                      allowClear
                      aria-label={t('maintenanceReport.field.equipmentModelLibrary')}
                      disabled={!canEdit}
                      options={models.map((model) => ({
                        value: model.id,
                        label: `${model.modelCode} · ${model.modelName}`,
                      }))}
                      placeholder={t('maintenanceReport.field.equipmentModelLibrary')}
                      showSearch={{ optionFilterProp: 'label' }}
                      style={{ width: '100%' }}
                      value={form.equipmentModelId ?? undefined}
                      onChange={(value) =>
                        // R041：机型 ID 与手填文字互斥——选库清空手填，手填清空选库
                        patch({
                          equipmentModelId: value ?? null,
                          equipmentModelText: value ? '' : form.equipmentModelText,
                        })
                      }
                    />
                    <Input
                      aria-label={t('maintenanceReport.field.equipmentModelManual')}
                      disabled={!canEdit}
                      maxLength={REPORT_TEXT_LIMITS.equipmentModelText}
                      placeholder={t('maintenanceReport.field.equipmentModelManual')}
                      value={form.equipmentModelText}
                      onChange={(event) => {
                        const text = event.target.value;
                        patch({
                          equipmentModelText: text,
                          equipmentModelId: text.trim().length > 0 ? null : form.equipmentModelId,
                        });
                      }}
                    />
                    <Typography.Text type="secondary">
                      {t('maintenanceReport.field.equipmentModelManualHint')}
                    </Typography.Text>
                  </Space>
                </Field>
                <Field label={t('maintenanceReport.field.maintenanceDate')}>
                  <Space orientation="vertical" size="small" style={{ width: '100%' }}>
                    <DatePicker
                      aria-label={t('maintenanceReport.field.maintenanceDate')}
                      disabled={!canEdit}
                      style={{ width: '100%' }}
                      value={
                        form.editor.maintenanceDate ? dayjs(form.editor.maintenanceDate) : null
                      }
                      onChange={(value) =>
                        changeEditor({
                          ...form.editor,
                          maintenanceDate: value === null ? '' : value.format('YYYY-MM-DD'),
                        })
                      }
                    />
                    <Typography.Text type="secondary">
                      {t('maintenanceReport.dateHint')}
                    </Typography.Text>
                  </Space>
                </Field>
                <Field label={t('maintenanceReport.field.engineer')}>
                  <Input
                    aria-label={t('maintenanceReport.field.engineer')}
                    disabled
                    value={form.editor.engineerName}
                  />
                </Field>
              </Space>
            </Card>
          </div>

          <div
            id={SECTION_DOM_IDS.fault}
            ref={(element) => {
              sectionRefs.current.fault = element;
            }}
          >
            <Card title={t('maintenanceReport.step.fault')}>
              <MaintenanceRecordEditor
                engineerNameReadOnly
                readOnly={!canEdit}
                value={form.editor}
                visibleSections={['initialFault', 'reset'] as const}
                onChange={changeEditor}
                onBeforeDiscardBranch={onConfirmDiscardBranch}
              />
            </Card>
          </div>

          <div
            id={SECTION_DOM_IDS.troubleshoot}
            ref={(element) => {
              sectionRefs.current.troubleshoot = element;
            }}
          >
            <Card title={t('maintenanceReport.step.troubleshoot')}>
              <MaintenanceRecordEditor
                engineerNameReadOnly
                readOnly={!canEdit}
                value={form.editor}
                visibleSections={['steps'] as const}
                onChange={changeEditor}
                onBeforeDiscardBranch={onConfirmDiscardBranch}
              />
            </Card>
          </div>

          <div
            id={SECTION_DOM_IDS.result}
            ref={(element) => {
              sectionRefs.current.result = element;
            }}
          >
            <Card title={t('maintenanceReport.step.result')}>
              <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                <MaintenanceRecordEditor
                  engineerNameReadOnly
                  readOnly={!canEdit}
                  value={form.editor}
                  visibleSections={['supplementaryNote'] as const}
                  onChange={changeEditor}
                  onBeforeDiscardBranch={onConfirmDiscardBranch}
                />
                <Field label={t('maintenanceReport.field.handlingResult')}>
                  <Select
                    allowClear
                    aria-label={t('maintenanceReport.field.handlingResult')}
                    disabled={!canEdit}
                    options={REPORT_HANDLING_RESULTS.map((value) => ({
                      value,
                      label: t(HANDLING_LABEL_KEYS[value]),
                    }))}
                    placeholder={t('maintenanceReport.field.handlingResult')}
                    style={{ width: '100%' }}
                    value={form.handlingResult === '' ? undefined : form.handlingResult}
                    onChange={(value) =>
                      patch({
                        handlingResult: value ?? '',
                        closureReason: value === undefined ? '' : form.closureReason,
                      })
                    }
                  />
                </Field>
                {closureReasonRequired ? (
                  <Field label={t('maintenanceReport.field.closureReason')} required>
                    <TextArea
                      aria-label={t('maintenanceReport.field.closureReason')}
                      disabled={!canEdit}
                      maxLength={REPORT_TEXT_LIMITS.closureReason}
                      rows={3}
                      value={form.closureReason}
                      onChange={(event) => patch({ closureReason: event.target.value })}
                    />
                  </Field>
                ) : null}
                <Field label={t('maintenanceReport.field.actualCause')}>
                  <TextArea
                    aria-label={t('maintenanceReport.field.actualCause')}
                    disabled={!canEdit}
                    maxLength={REPORT_TEXT_LIMITS.actualCause}
                    rows={3}
                    value={form.actualCause}
                    onChange={(event) => patch({ actualCause: event.target.value })}
                  />
                </Field>
                <Field label={t('maintenanceReport.field.repairActions')}>
                  <TextArea
                    aria-label={t('maintenanceReport.field.repairActions')}
                    disabled={!canEdit}
                    maxLength={REPORT_TEXT_LIMITS.repairActions}
                    rows={4}
                    value={form.repairActions}
                    onChange={(event) => patch({ repairActions: event.target.value })}
                  />
                </Field>
                <Field label={t('maintenanceReport.field.verification')}>
                  <TextArea
                    aria-label={t('maintenanceReport.field.verification')}
                    disabled={!canEdit}
                    maxLength={REPORT_TEXT_LIMITS.verificationResult}
                    rows={3}
                    value={form.verificationResult}
                    onChange={(event) => patch({ verificationResult: event.target.value })}
                  />
                </Field>
              </Space>
            </Card>
          </div>

          {actionButtons}
        </Space>
      </Col>
      <Col lg={5} xs={0}>
        <nav aria-label={t('maintenanceReport.toc.title')} style={{ position: 'sticky', top: 96 }}>
          <Card size="small" title={t('maintenanceReport.toc.title')}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {SECTION_KEYS.map((key) => (
                <li key={key} style={{ marginBottom: 4 }}>
                  <Button
                    block
                    size="small"
                    style={{
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      ...(activeSection === key
                        ? { background: '#e6f4ff', borderColor: '#91caff' }
                        : {}),
                    }}
                    type="text"
                    onClick={() => jumpToSection(key)}
                  >
                    {t(SECTION_LABEL_KEYS[key])}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </nav>
      </Col>

      <Modal
        cancelText={t('maintenanceReport.cancel')}
        okText={t('maintenanceReport.submitFormal')}
        okButtonProps={{ danger: true, loading: submitting }}
        onCancel={() => setConfirmingSubmit(false)}
        onOk={() => {
          setConfirmingSubmit(false);
          onSubmitFormal?.();
        }}
        open={confirmingSubmit}
        title={t('maintenanceReport.submitConfirmTitle')}
      >
        {t('maintenanceReport.submitConfirmBody')}
      </Modal>

      {/* 2026-11-21 需求调整：查看预览改为弹窗——只读渲染当前表单（含有效分支
          派生的故障/步骤），开/关均为纯本地状态，不创建/保存/上传/提交 */}
      <Modal
        cancelText={t('maintenanceReport.cancel')}
        footer={
          <Button type="primary" onClick={() => setPreviewOpen(false)}>
            {t('maintenanceReport.cancel')}
          </Button>
        }
        onCancel={() => setPreviewOpen(false)}
        open={previewOpen}
        title={t('maintenanceReport.previewTitle')}
        width={860}
      >
        <MaintenanceReportPreview form={form} models={models} />
      </Modal>
    </Row>
  );
}

/**
 * 预览：只读取当前表单输入并渲染将要保存的草稿内容。
 * 不调用任何写接口——预览本身不会创建报告。
 */
export function MaintenanceReportPreview({
  form,
  models = [],
}: {
  form: MaintenanceReportForm;
  models?: EquipmentModelOption[];
}) {
  const { t } = useI18n();
  const draft = useMemo(() => toReportDraftInput(form), [form]);
  const steps = draft.steps ?? [];
  const faults = draft.faults ?? [];

  return (
    <Card title={t('maintenanceReport.previewTitle')}>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Alert type="info" showIcon title={t('maintenanceReport.previewHint')} />
        <PreviewRow
          label={t('maintenanceReport.field.customerFactory')}
          value={form.customerFactoryName}
        />
        <PreviewRow
          label={t('maintenanceReport.field.equipmentModel')}
          value={
            form.frozenEquipmentModelName !== null
              ? form.frozenEquipmentModelName
              : form.equipmentModelText.trim() ||
                resolveModelLabel(form.equipmentModelId, models) ||
                ''
          }
        />
        <PreviewRow
          label={t('maintenanceReport.field.maintenanceDate')}
          value={form.editor.maintenanceDate}
        />
        <PreviewRow
          label={t('maintenanceReport.field.engineer')}
          value={form.editor.engineerName}
        />
        <PreviewRow
          label={t('maintenanceReport.field.handlingResult')}
          value={form.handlingResult === '' ? '' : t(HANDLING_LABEL_KEYS[form.handlingResult])}
        />
        <PreviewRow label={t('maintenanceReport.field.closureReason')} value={form.closureReason} />
        <PreviewRow label={t('maintenanceReport.field.actualCause')} value={form.actualCause} />
        <PreviewRow label={t('maintenanceReport.field.repairActions')} value={form.repairActions} />
        <PreviewRow
          label={t('maintenanceReport.field.verification')}
          value={form.verificationResult}
        />
        <PreviewRow
          label={t('maintenanceReport.section.note')}
          value={form.editor.supplementaryNote}
        />

        <div>
          <Typography.Title level={5}>{t('maintenanceReport.preview.faults')}</Typography.Title>
          {faults.length === 0 ? (
            <Empty description={t('maintenanceReport.preview.faultEmpty')} />
          ) : (
            <Space orientation="vertical" size="small" style={{ width: '100%' }}>
              {faults.map((fault, index) => (
                <Card key={`${fault.branchKind}-${String(fault.stepNo ?? index)}`} size="small">
                  <Space wrap size="small">
                    <Tag color="blue">{t(branchLabelKey(fault.branchKind))}</Tag>
                    {fault.phaseCode === null ? null : <Tag>{fault.phaseCode}</Tag>}
                  </Space>
                  <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{fault.description}</div>
                  {fault.action ? (
                    <Typography.Text type="secondary">{fault.action}</Typography.Text>
                  ) : null}
                </Card>
              ))}
            </Space>
          )}
        </div>

        <div>
          <Typography.Title level={5}>{t('maintenanceReport.preview.steps')}</Typography.Title>
          {steps.length === 0 ? (
            <Empty description={t('maintenanceReport.noSteps')} />
          ) : (
            <ol style={{ margin: 0, paddingInlineStart: 20 }}>
              {steps.map((step, index) => (
                <li key={`${String(step.stepCode)}-${index}`} style={{ marginBottom: 8 }}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{step.actionText}</div>
                  <Typography.Text type="secondary">
                    {t('maintenanceReport.preview.stepResult')}：
                    {step.resultCode === null ? '' : t(stepResultKey(step.resultCode))}
                  </Typography.Text>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Space>
    </Card>
  );
}

function resolveModelLabel(modelId: number | null, models: EquipmentModelOption[]): string {
  if (modelId === null) return '';
  const model = models.find((option) => option.id === modelId);
  return model === undefined ? '' : `${model.modelCode} · ${model.modelName}`;
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <div style={{ whiteSpace: 'pre-wrap' }}>{value.trim().length === 0 ? '—' : value}</div>
    </div>
  );
}

function Field({
  children,
  label,
  required = false,
}: {
  children: React.ReactNode;
  label: string;
  required?: boolean;
}) {
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <Typography.Text>
          {label}
          {required ? ' *' : ''}
        </Typography.Text>
      </div>
      {children}
    </div>
  );
}

function branchLabelKey(branchKind: string): MessageKey {
  if (branchKind === 'INITIAL') return 'maintenance.initialFault';
  if (branchKind === 'RESET_NEW_FAULT') return 'maintenance.resetNewFault';
  return 'maintenance.stepNewFault';
}

function stepResultKey(resultCode: string): MessageKey {
  if (resultCode === 'RESOLVED') return 'maintenance.stepResult.RESOLVED';
  if (resultCode === 'UNRESOLVED') return 'maintenance.stepResult.UNRESOLVED';
  return 'maintenance.stepResult.NEW_FAULT';
}

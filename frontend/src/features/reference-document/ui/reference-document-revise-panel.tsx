// src/features/reference-document/ui/reference-document-revise-panel.tsx
// 独立管理修订页（任务 07，仅一级管理员；入口 = 资料详情「管理修订」）。
//
// - 结构化模式（报告来源正式资料）：复用任务 04 共享结构化编辑器
//   （基本信息/故障现象/复位/排查步骤/补充说明，不调用工单保存接口），
//   外加维修结果字段、资料形态（标题/说明）、客户厂家文本与机型改选
//   （复用列表筛选同一候选查询：仅启用型号；改选目标按 ID 服务端校验）；
//   管理修订原因必填；
// - 扁平模式（普通资料 / 旧扁平修订）：沿用既有修订语义（标题/说明/正文），
//   不伪造缺失的故障数据，也不把普通资料转换成结构化报告；
// - 取消只返回资料详情，不发出任何请求、不改变服务端状态；
// - 保存失败保留全部用户输入（编辑态不随失败重置）；
// - 权限仅用于页面装配显隐，授权由服务端最终裁决（守卫 + 等级事实复核）。

import { useState } from 'react';
import { Alert, Button, Card, Input, Select, Skeleton } from 'antd';
import { useNavigate } from 'react-router';

import type { Translate } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import { MaintenanceRecordEditor } from '@/shared/ui/maintenance-record-editor';
import { useMessageFeedback } from '@/shared/ui/message-feedback';

import { useReferenceDocumentEditableContent } from '../application/use-reference-document-editable-content';
import { useReferenceEquipmentModels } from '../application/use-reference-equipment-models';
import type { ReferenceDocumentEditableContent } from '../infrastructure/reference-document.types';
import {
  reviseReferenceDocument,
  reviseReferenceDocumentStructured,
} from '../infrastructure/reference-document-adapter';
import {
  collectReviseIssues,
  createFlatReviseFormFromEditableContent,
  createReviseFormFromEditableContent,
  type ReferenceDocumentFlatReviseForm,
  type ReferenceDocumentReviseForm,
  REVISE_CLOSURE_REASON_REQUIRED_RESULTS,
  REVISE_HANDLING_RESULT_OPTIONS,
  toStructuredRevisePayload,
} from '../model/revise-form';

import type { ReferenceDocumentViewer } from './reference-document-detail-panel';
import { buildReferenceDocumentDetailPath } from './reference-document-paths';

/** 编辑态（随加载内容派生初值；保存失败保留用户输入） */
type ReferenceDocumentReviseEditState = {
  content: ReferenceDocumentEditableContent;
  mode: 'STRUCTURED' | 'FLAT';
  expectedVersion: number;
  faultCaseProtected: boolean;
  form: ReferenceDocumentReviseForm | null;
  flatForm: ReferenceDocumentFlatReviseForm | null;
  reason: string;
};

export function ReferenceDocumentRevisePanel({
  documentId,
  viewer,
}: {
  documentId: number | null;
  viewer: ReferenceDocumentViewer;
}) {
  const navigate = useNavigate();
  const notify = useMessageFeedback();
  const { t } = useI18n();

  const [busy, setBusy] = useState(false);

  const isLevelOneAdmin = viewer.role === 'SUPER_ADMIN' && viewer.adminLevel === 1;
  const backPath = documentId === null ? null : buildReferenceDocumentDetailPath(documentId);
  // 非一级管理员不发起编辑初值请求（页面仅提示无权限）；服务端仍最终裁决
  const { state, reload } = useReferenceDocumentEditableContent(
    isLevelOneAdmin ? documentId : null,
  );
  // 机型候选（复用列表筛选同一查询：仅启用型号；前端仅装配，授权与服务端裁决一致）
  const models = useReferenceEquipmentModels();

  /**
   * 编辑态派生：React「渲染期调整状态」模式——新内容对象到达时按初值重建
   * 表单（保留已输入原因），避免 effect 内同步 setState 的级联渲染。
   */
  const content = state.status === 'ready' ? state.content : null;
  const [editState, setEditState] = useState<ReferenceDocumentReviseEditState | null>(null);
  if (content !== null && (editState === null || editState.content !== content)) {
    setEditState({
      content,
      mode: content.mode,
      expectedVersion: content.expectedVersion,
      faultCaseProtected: content.faultCaseProtected,
      form: content.mode === 'STRUCTURED' ? createReviseFormFromEditableContent(content) : null,
      flatForm: content.mode === 'FLAT' ? createFlatReviseFormFromEditableContent(content) : null,
      reason: editState?.reason ?? '',
    });
  }

  if (!isLevelOneAdmin) {
    return (
      <Alert
        showIcon
        title={t('refDocRevise.error.levelOneOnly')}
        type="warning"
        action={
          backPath !== null ? (
            <Button onClick={() => navigate(backPath)} size="small">
              {t('refDocRevise.action.backToDetail')}
            </Button>
          ) : null
        }
      />
    );
  }

  if (state.status === 'loading') {
    return <Skeleton active paragraph={{ rows: 8 }} />;
  }

  if (state.status === 'failed') {
    return (
      <Alert
        action={
          <div className="flex gap-2">
            <Button onClick={reload} size="small">
              {t('common.retry')}
            </Button>
            {backPath !== null ? (
              <Button onClick={() => navigate(backPath)} size="small">
                {t('refDocRevise.action.backToDetail')}
              </Button>
            ) : null}
          </div>
        }
        showIcon
        title={state.message}
        type="warning"
      />
    );
  }

  const handleCancel = (): void => {
    // 取消：只返回资料详情，不发出请求、不改变任何状态
    if (backPath !== null) {
      navigate(backPath);
    }
  };

  if (editState === null) {
    return <Skeleton active paragraph={{ rows: 8 }} />;
  }

  const { form, flatForm } = editState;

  const setForm = (next: ReferenceDocumentReviseForm): void => {
    setEditState((prev) => (prev === null ? prev : { ...prev, form: next }));
  };

  const setFlatForm = (next: ReferenceDocumentFlatReviseForm): void => {
    setEditState((prev) => (prev === null ? prev : { ...prev, flatForm: next }));
  };

  const setReason = (value: string): void => {
    setEditState((prev) => (prev === null ? prev : { ...prev, reason: value }));
  };

  const reasonInput = (
    <div className="flex flex-col gap-1">
      <div className="font-medium">{t('refDocRevise.label.reason')}</div>
      <Input.TextArea
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t('refDocRevise.placeholder.reason')}
        rows={3}
        value={editState.reason}
      />
    </div>
  );

  const ensureReasonFilled = (): boolean => {
    if (editState.reason.trim().length === 0) {
      notify({ text: t('refDocRevise.error.reasonRequired'), type: 'error' });
      return false;
    }
    return true;
  };

  const handleSaveStructured = async (): Promise<void> => {
    if (form === null || busy) {
      return;
    }
    const issues = collectReviseIssues(form, t);
    if (form.title.trim().length === 0) {
      issues.unshift(t('refDocRevise.error.titleRequired'));
    }
    if (issues.length > 0) {
      notify({ text: issues.join(' '), type: 'error' });
      return;
    }
    if (!ensureReasonFilled()) {
      return;
    }
    setBusy(true);
    try {
      // 机型仅改选时提交（undefined=保持原关联；显式清空不支持，Select 不提供清除）
      const modelChanged =
        form.equipmentModelId !== null &&
        form.equipmentModelId !== editState.content.equipmentModelId;
      const result = await reviseReferenceDocumentStructured(documentId as number, {
        expectedVersion: editState.expectedVersion,
        reason: editState.reason.trim(),
        title: form.title.trim(),
        description: form.description.trim().length === 0 ? null : form.description.trim(),
        structured: toStructuredRevisePayload(form),
        ...(modelChanged ? { equipmentModelId: form.equipmentModelId } : {}),
      });
      if (!result.ok) {
        notify({ text: describeReviseFailure(result, t), type: 'error' });
        return;
      }
      notify({ text: t('refDocRevise.success.saved'), type: 'success' });
      navigate(backPath as string);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveFlat = async (): Promise<void> => {
    if (flatForm === null || busy) {
      return;
    }
    const patch: { title?: string; description?: string | null; contentText?: string | null } = {};
    if (flatForm.title.trim().length > 0) patch.title = flatForm.title.trim();
    if (flatForm.description.trim().length > 0) patch.description = flatForm.description.trim();
    if (flatForm.contentText.trim().length > 0) patch.contentText = flatForm.contentText;
    if (Object.keys(patch).length === 0) {
      notify({ text: t('refDocRevise.error.flatEmptyPatch'), type: 'error' });
      return;
    }
    if (!ensureReasonFilled()) {
      return;
    }
    setBusy(true);
    try {
      const result = await reviseReferenceDocument(
        documentId as number,
        editState.expectedVersion,
        patch,
        editState.reason.trim(),
      );
      if (!result.ok) {
        notify({ text: describeReviseFailure(result, t), type: 'error' });
        return;
      }
      notify({ text: t('refDocRevise.success.saved'), type: 'success' });
      navigate(backPath as string);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reference-document-revise flex flex-col gap-4">
      <Card
        extra={
          <Button onClick={handleCancel} size="small">
            {t('refDocRevise.action.backToDetail')}
          </Button>
        }
        title={
          editState.mode === 'STRUCTURED'
            ? t('refDocRevise.title.structured', { title: editState.content.title })
            : t('refDocRevise.title.flat', { title: editState.content.title })
        }
      >
        <div className="text-text-secondary text-sm">{t('refDocRevise.note.preamble')}</div>
      </Card>

      {editState.faultCaseProtected ? (
        <Alert showIcon title={t('refDocRevise.note.faultCaseProtected')} type="warning" />
      ) : null}

      {editState.mode === 'STRUCTURED' && form !== null ? (
        <>
          <Card size="small" title={t('refDocRevise.section.form')}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <div className="font-medium">{t('refDocRevise.label.title')}</div>
                <Input
                  maxLength={255}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  value={form.title}
                />
              </div>
              <div className="flex flex-col gap-1">
                <div className="font-medium">{t('refDocRevise.label.description')}</div>
                <Input.TextArea
                  maxLength={2000}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  rows={2}
                  value={form.description}
                />
              </div>
              <div className="flex flex-col gap-1">
                <div className="font-medium">{t('refDocRevise.label.customerFactory')}</div>
                <Input
                  maxLength={200}
                  onChange={(event) =>
                    setForm({ ...form, customerFactoryName: event.target.value })
                  }
                  value={form.customerFactoryName}
                />
              </div>
              <div className="flex flex-col gap-1">
                <div className="font-medium">{t('refDocRevise.label.equipmentModel')}</div>
                <Select
                  aria-label={t('refDocRevise.aria.selectModel')}
                  loading={models.state.status === 'loading'}
                  onChange={(value) => setForm({ ...form, equipmentModelId: value })}
                  options={buildEquipmentModelOptions(
                    models.state,
                    editState.content.equipmentModelId,
                    editState.content.equipmentModelName,
                    t,
                  )}
                  placeholder={t('refDocRevise.placeholder.selectModel')}
                  showSearch
                  optionFilterProp="label"
                  style={{ maxWidth: 480 }}
                  value={form.equipmentModelId === null ? undefined : form.equipmentModelId}
                />
                <div className="text-text-secondary text-sm">
                  {t('refDocRevise.note.modelRules')}
                </div>
              </div>
            </div>
          </Card>

          <Card size="small" title={t('refDocRevise.section.structured')}>
            <div className="flex flex-col gap-3">
              <MaintenanceRecordEditor
                onChange={(editor) => setForm({ ...form, editor })}
                value={form.editor}
              />
              <div className="flex flex-col gap-3 border-t border-border pt-3">
                <div className="font-medium">{t('refDocRevise.label.handlingResult')}</div>
                <Select
                  allowClear
                  onChange={(value) => setForm({ ...form, handlingResult: value ?? '' })}
                  options={REVISE_HANDLING_RESULT_OPTIONS.map((option) => ({
                    label: t(option.messageKey),
                    value: option.value,
                  }))}
                  placeholder={t('refDocRevise.placeholder.handlingResult')}
                  style={{ maxWidth: 320 }}
                  value={form.handlingResult === '' ? undefined : form.handlingResult}
                />
                {form.handlingResult !== '' &&
                REVISE_CLOSURE_REASON_REQUIRED_RESULTS.includes(form.handlingResult) ? (
                  <div className="flex flex-col gap-1">
                    <div className="font-medium">{t('refDocRevise.label.closureReason')}</div>
                    <Input.TextArea
                      maxLength={10000}
                      onChange={(event) => setForm({ ...form, closureReason: event.target.value })}
                      rows={2}
                      value={form.closureReason}
                    />
                  </div>
                ) : null}
                <div className="flex flex-col gap-1">
                  <div className="font-medium">{t('refDocDetail.field.actualCause')}</div>
                  <Input.TextArea
                    maxLength={2000}
                    onChange={(event) => setForm({ ...form, actualCause: event.target.value })}
                    rows={2}
                    value={form.actualCause}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="font-medium">{t('refDocDetail.field.repairActions')}</div>
                  <Input.TextArea
                    maxLength={10000}
                    onChange={(event) => setForm({ ...form, repairActions: event.target.value })}
                    rows={2}
                    value={form.repairActions}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="font-medium">{t('refDocDetail.field.verificationResult')}</div>
                  <Input.TextArea
                    maxLength={2000}
                    onChange={(event) =>
                      setForm({ ...form, verificationResult: event.target.value })
                    }
                    rows={2}
                    value={form.verificationResult}
                  />
                </div>
              </div>
            </div>
          </Card>

          <Card size="small" title={t('refDocRevise.section.submit')}>
            <div className="flex flex-col gap-3">
              {reasonInput}
              <div className="flex gap-2">
                <Button loading={busy} onClick={() => void handleSaveStructured()} type="primary">
                  {t('refDocRevise.action.save')}
                </Button>
                <Button disabled={busy} onClick={handleCancel}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          </Card>
        </>
      ) : null}

      {editState.mode === 'FLAT' && flatForm !== null ? (
        <Card size="small" title={t('refDocRevise.section.flatContent')}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="font-medium">{t('refDocRevise.label.flatTitle')}</div>
              <Input
                maxLength={255}
                onChange={(event) => setFlatForm({ ...flatForm, title: event.target.value })}
                value={flatForm.title}
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="font-medium">{t('refDocRevise.label.flatDescription')}</div>
              <Input.TextArea
                maxLength={2000}
                onChange={(event) => setFlatForm({ ...flatForm, description: event.target.value })}
                rows={2}
                value={flatForm.description}
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="font-medium">{t('refDocRevise.label.flatContentText')}</div>
              <Input.TextArea
                maxLength={200000}
                onChange={(event) => setFlatForm({ ...flatForm, contentText: event.target.value })}
                rows={8}
                value={flatForm.contentText}
              />
            </div>
            {reasonInput}
            <div className="flex gap-2">
              <Button loading={busy} onClick={() => void handleSaveFlat()} type="primary">
                {t('refDocRevise.action.saveFlat')}
              </Button>
              <Button disabled={busy} onClick={handleCancel}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/** 管理修订失败提示（version-conflict → 显式重读；其余用后端消息或兜底文案） */
function describeReviseFailure(
  result: { ok: false; message: string; reason: string },
  t: Translate,
): string {
  if (result.reason === 'version-conflict') {
    return t('refDocRevise.error.versionConflict');
  }
  if (result.reason === 'invalid-input') {
    return result.message || t('refDocRevise.error.invalidInput');
  }
  return result.message || t('refDocRevise.error.saveFailed');
}

/**
 * 机型改选候选（本轮确认需求 二.2）：复用列表筛选同一候选查询（仅启用型号）；
 * 候选未包含当前关联机型（如已停用）时补入当前值选项并标注停用——
 * 保持「未改机型＝保持原值」语义可选，但不提供其他停用目标。
 */
function buildEquipmentModelOptions(
  modelsState: ReturnType<typeof useReferenceEquipmentModels>['state'],
  currentModelId: number | null,
  currentModelName: string | null,
  t: Translate,
): Array<{ label: string; value: number }> {
  const options =
    modelsState.status === 'ready'
      ? modelsState.models.map((model) => ({
          label: `${model.modelName}（${model.modelCode}）`,
          value: model.id,
        }))
      : [];
  if (currentModelId !== null && !options.some((option) => option.value === currentModelId)) {
    options.unshift({
      label:
        modelsState.status === 'ready'
          ? `${currentModelName ?? t('refDocRevise.label.modelFallback', { id: currentModelId })} ${t('refDocRevise.label.modelDisabledSuffix')}`
          : (currentModelName ?? t('refDocRevise.label.modelFallback', { id: currentModelId })),
      value: currentModelId,
    });
  }
  return options;
}

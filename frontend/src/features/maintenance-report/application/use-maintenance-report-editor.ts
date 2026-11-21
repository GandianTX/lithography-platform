// src/features/maintenance-report/application/use-maintenance-report-editor.ts
//
// 报告编辑会话：脏检查、草稿保存（首次创建 / 后续更新）、R051-01 正式提交、错误透传。
// 打开页面、切换步骤、预览都不调用任何写接口——只有显式保存/提交才发请求。

import { useCallback, useMemo, useRef, useState } from 'react';

import { isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  MaintenanceReportSourceType,
  MaintenanceReportSubmitResult,
} from '../infrastructure/maintenance-report.types';
import {
  createMaintenanceReportDraft,
  type StagedAttachmentPayload,
  submitMaintenanceReport,
  updateMaintenanceReportDraft,
} from '../infrastructure/maintenance-report-adapter';
import {
  collectReportFormIssues,
  type MaintenanceReportForm,
  type ReportFormIssue,
  serializeReportForm,
  toReportDraftInput,
} from '../model/report-form';

export type ReportSaveOutcome =
  | { kind: 'saved'; reportId: number; created: boolean }
  | { kind: 'blocked'; issues: ReportFormIssue[] }
  | { kind: 'failed'; message: string };

export type ReportSubmitOutcome =
  | { kind: 'submitted'; result: MaintenanceReportSubmitResult }
  | { kind: 'blocked'; issues: ReportFormIssue[] }
  | { kind: 'failed'; message: string };

export type MaintenanceReportSubmitParams = {
  /** 同次提交稳定标识：响应丢失后重发沿用，内容变化才换新 */
  submissionRequestId: string;
  /** 已有草稿首次提交时的展示版本；幂等重试不因旧版本被拒 */
  expectedVersionNo: number | null;
  /** R051-01/R062-01 随提交绑定的本轮暂存原件（直接提交绑定、已有草稿更换均适用） */
  attachment?: StagedAttachmentPayload | null;
};

export type MaintenanceReportEditorSession = {
  form: MaintenanceReportForm;
  setForm: (next: MaintenanceReportForm) => void;
  updateForm: (updater: (current: MaintenanceReportForm) => MaintenanceReportForm) => void;
  dirty: boolean;
  saving: boolean;
  issues: ReportFormIssue[];
  reportId: number | null;
  saveDraft: (options?: {
    attachment?: StagedAttachmentPayload | null;
  }) => Promise<ReportSaveOutcome>;
  submitFormal: (params: MaintenanceReportSubmitParams) => Promise<ReportSubmitOutcome>;
  resetBaseline: () => void;
};

function toUserMessage(error: unknown, fallback: string): string {
  if (isGraphQLIngressError(error)) {
    const detail = readGraphQLErrorDetail(error);
    return detail?.errorMessage ?? error.userMessage ?? fallback;
  }
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function useMaintenanceReportEditor(params: {
  initialForm: MaintenanceReportForm;
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  reportId: number | null;
  fallbackSaveError: string;
  fallbackSubmitError: string;
}): MaintenanceReportEditorSession {
  const [form, setForm] = useState<MaintenanceReportForm>(params.initialForm);
  const [baseline, setBaseline] = useState(() => serializeReportForm(params.initialForm));
  const [reportId, setReportId] = useState<number | null>(params.reportId);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const issues = useMemo(() => collectReportFormIssues(form), [form]);
  const currentSnapshot = useMemo(() => serializeReportForm(form), [form]);
  const dirty = currentSnapshot !== baseline;

  const updateForm = useCallback(
    (updater: (current: MaintenanceReportForm) => MaintenanceReportForm) => {
      setForm((current) => updater(current));
    },
    [],
  );

  const resetBaseline = useCallback(() => {
    setBaseline(serializeReportForm(form));
  }, [form]);

  const saveDraft = useCallback(
    async (options?: {
      attachment?: StagedAttachmentPayload | null;
    }): Promise<ReportSaveOutcome> => {
      if (savingRef.current) {
        return { kind: 'blocked', issues: [] };
      }
      const blockingIssues = collectReportFormIssues(form);
      if (blockingIssues.length > 0) {
        return { kind: 'blocked', issues: blockingIssues };
      }

      savingRef.current = true;
      setSaving(true);
      try {
        const draft = toReportDraftInput(form);
        const created = reportId === null;
        const result = created
          ? await createMaintenanceReportDraft({
              sourceType: params.sourceType,
              repairRequestId: params.repairRequestId,
              draft,
              // R050-01/R045-02：首存同事务绑定暂存原件
              attachment: options?.attachment ?? null,
            })
          : await updateMaintenanceReportDraft({
              reportId: reportId as number,
              draft,
              // R050-02/R062-01：续填同事务绑定/更换暂存原件（服务端裁决替换顺序）
              attachment: options?.attachment ?? null,
            });
        setReportId(result.reportId);
        setBaseline(serializeReportForm(form));
        return { kind: 'saved', reportId: result.reportId, created };
      } catch (error) {
        return { kind: 'failed', message: toUserMessage(error, params.fallbackSaveError) };
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [form, params.fallbackSaveError, params.repairRequestId, params.sourceType, reportId],
  );

  /**
   * R051-01 正式提交：当前表单整体作为提交内容发送。
   * 提交标识与展示版本由页面层持有；服务端负责幂等与冲突裁决。
   */
  const submitFormal = useCallback(
    async (submitParams: MaintenanceReportSubmitParams): Promise<ReportSubmitOutcome> => {
      if (savingRef.current) {
        return { kind: 'blocked', issues: [] };
      }
      const blockingIssues = collectReportFormIssues(form);
      if (blockingIssues.length > 0) {
        return { kind: 'blocked', issues: blockingIssues };
      }

      savingRef.current = true;
      setSaving(true);
      try {
        const result = await submitMaintenanceReport({
          sourceType: params.sourceType,
          repairRequestId: params.repairRequestId,
          reportId,
          expectedVersionNo: submitParams.expectedVersionNo,
          submissionRequestId: submitParams.submissionRequestId,
          draft: toReportDraftInput(form),
          // R051-01/R062-01：未保存表单直接提交与已存草稿更换原件均随请求绑定（服务端 replace 裁决）
          attachment: submitParams.attachment ?? null,
        });
        setBaseline(serializeReportForm(form));
        return { kind: 'submitted', result };
      } catch (error) {
        return { kind: 'failed', message: toUserMessage(error, params.fallbackSubmitError) };
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [form, params.fallbackSubmitError, params.repairRequestId, params.sourceType, reportId],
  );

  return {
    form,
    setForm,
    updateForm,
    dirty,
    saving,
    issues,
    reportId,
    saveDraft,
    resetBaseline,
    submitFormal,
  };
}

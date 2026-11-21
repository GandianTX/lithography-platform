// src/features/maintenance-report/infrastructure/maintenance-report-adapter.ts
// 维修报告 GraphQL 适配层：只负责文档、变量与错误透传，不承载业务状态。

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';
import {
  fetchRestWithAuthRetry,
  parseAttachmentFilename,
  readRestErrorField,
  type RestErrorEnvelope,
  toRestErrorEnvelope,
} from '@/shared/http';

import type {
  EquipmentModelOption,
  MaintenanceReportAttachmentDownloadResult,
  MaintenanceReportAttachmentMutationResult,
  MaintenanceReportDetail,
  MaintenanceReportDraftInput,
  MaintenanceReportDraftResult,
  MaintenanceReportExportFormat,
  MaintenanceReportExportResult,
  MaintenanceReportPage,
  MaintenanceReportSourceType,
  MaintenanceReportSubmitResult,
  MaintenanceReportUploadFailureReason,
  MaintenanceReportUploadResult,
  MyWorkOrderSummaryEntry,
  ReportFaultBranchKind,
  ReportStepResult,
  StagedMaintenanceReportFile,
  WorkOrderSummaryAiConversation,
  WorkOrderSummaryCandidatePage,
} from './maintenance-report.types';

const FAULT_FIELDS = `
  id
  branchKind
  stepCode
  phaseCode
  mainError
  unitError
  source
  errorType
  gpibStatus
  faultStatus
  description
  action
`;

const STEP_FIELDS = `
  id
  stepNo
  stepCode
  partName
  actionText
  resultCode
  errorCode
  resultText
`;

const REPORT_FIELDS = `
  id
  sourceType
  repairRequestId
  status
  title
  customerFactoryName
  equipmentModelId
  equipmentModelText
  maintenanceDate
  engineerName
  handlingResult
  closureReason
  resetResult
  actualCause
  repairActions
  verificationResult
  supplementaryNote
  currentVersionNo
  updatedAt
  aiUsage
  aiSourceType
  aiSourceId
  aiSourceVersion
  aiScore
  aiCorrectness
  aiHelpfulness
  aiNote
`;

const REPORT_DETAIL_FIELDS = `
  report { ${REPORT_FIELDS} }
  steps { ${STEP_FIELDS} }
  faults { ${FAULT_FIELDS} }
  attachments { id fileId originalFilename mimeType byteSize sortOrder }
  frozenEquipmentModelName
  canEdit
`;

const DRAFT_RESULT_FIELDS = 'reportId status currentVersionNo updatedAt';

const SUBMIT_RESULT_FIELDS =
  'reportId versionId versionNo status submissionRequestId referenceDocumentId';

const SUBMIT_MUTATION = `
  mutation SubmitMaintenanceReport($input: SubmitMaintenanceReportInput!) {
    submitMaintenanceReport(input: $input) { ${SUBMIT_RESULT_FIELDS} }
  }
`;

const CREATE_DRAFT_MUTATION = `
  mutation CreateMaintenanceReportDraft($input: CreateMaintenanceReportDraftInput!) {
    createMaintenanceReportDraft(input: $input) { ${DRAFT_RESULT_FIELDS} }
  }
`;

const UPDATE_DRAFT_MUTATION = `
  mutation UpdateMaintenanceReportDraft($input: UpdateMaintenanceReportDraftInput!) {
    updateMaintenanceReportDraft(input: $input) { ${DRAFT_RESULT_FIELDS} }
  }
`;

const MY_REPORT_QUERY = `
  query MyMaintenanceReport($reportId: Int!) {
    myMaintenanceReport(reportId: $reportId) { ${REPORT_DETAIL_FIELDS} }
  }
`;

const MY_REPORTS_QUERY = `
  query MyMaintenanceReports(
    $pagination: MaintenanceReportPaginationInput
    $filter: MyMaintenanceReportFilterInput
  ) {
    myMaintenanceReports(pagination: $pagination, filter: $filter) {
      items {
        id
        sourceType
        repairRequestId
        title
        status
        currentVersionNo
        maintenanceDate
        updatedAt
      }
      total
      page
      pageSize
    }
  }
`;

const MY_WORK_ORDER_SUMMARY_QUERY = `
  query MyWorkOrderSummary($repairRequestId: Int!) {
    myWorkOrderSummary(repairRequestId: $repairRequestId) {
      repairRequestId
      requestNo
      equipmentModelId
      equipmentModelCode
      equipmentModelName
      closedAt
      sourceChangedSinceDraft sourceConfirmation
      sourcePreview {
        customerCompanyName handlingResult closureReason
        maintenanceDate engineerName resetResult supplementaryNote
        attachment { fileId originalFilename byteSize }
        intakeFaultDescription
        intakeCustomerFile { fileId originalFilename byteSize }
        steps { stepNo errorCode partName actionText resultCode }
        panels {
          panelType stepNo phaseCode mainError unitError source errorType
          gpibStatus faultStatus description action
        }
      }
      report { ${REPORT_DETAIL_FIELDS} }
    }
  }
`;

const MY_WORK_ORDER_SUMMARIES_QUERY = `
  query MyWorkOrderSummaryCandidates($pagination: MaintenanceReportPaginationInput) {
    myWorkOrderSummaryCandidates(pagination: $pagination) {
      items {
        repairRequestId
        requestNo
        equipmentModelCode
        equipmentModelName
        closedAt
        handlingResult
        intakeFaultDescription
        reportId
        reportStatus
        reportUpdatedAt
      }
      total
      page
      pageSize
    }
  }
`;

const MY_WORK_ORDER_SUMMARY_AI_CONVERSATIONS_QUERY = `
  query MyWorkOrderSummaryAiConversations($repairRequestId: Int!) {
    myWorkOrderSummaryAiConversations(repairRequestId: $repairRequestId) {
      conversationId
      contentVersion
      lastMessageSeq
      effectiveReplyCount
      createdAt
      completedAt
    }
  }
`;

const EQUIPMENT_MODELS_QUERY = `
  query MaintenanceReportEquipmentModels {
    equipmentModels { id modelCode modelName }
  }
`;

const EXPORT_MUTATION = `
  mutation ExportMaintenanceReport($input: MaintenanceReportExportInput!) {
    exportMaintenanceReport(input: $input) {
      format
      fileName
      mimeType
      byteSize
      contentBase64
    }
  }
`;

/**
 * 组装 GraphQL 变量：把前端表单模型转换成后端输入契约。
 * 只发送用户可编辑字段，作者/公司由服务端会话决定。
 */
export type DraftPayload = MaintenanceReportDraftInput;

function toGraphQLDraftInput(draft: DraftPayload) {
  return {
    title: draft.title ?? undefined,
    customerFactoryName: draft.customerFactoryName ?? undefined,
    equipmentModelId: draft.equipmentModelId ?? undefined,
    equipmentModelText: draft.equipmentModelText ?? undefined,
    maintenanceDate: draft.maintenanceDate ?? undefined,
    handlingResult: draft.handlingResult ?? undefined,
    closureReason: draft.closureReason ?? undefined,
    resetResult: draft.resetResult ?? undefined,
    actualCause: draft.actualCause ?? undefined,
    repairActions: draft.repairActions ?? undefined,
    verificationResult: draft.verificationResult ?? undefined,
    supplementaryNote: draft.supplementaryNote ?? undefined,
    steps:
      draft.steps === undefined
        ? undefined
        : draft.steps.map((step) => ({
            stepCode: step.stepCode,
            partName: step.partName,
            actionText: step.actionText,
            resultCode: step.resultCode as ReportStepResult | null,
            errorCode: step.errorCode,
            resultText: step.resultText,
          })),
    faults:
      draft.faults === undefined
        ? undefined
        : draft.faults.map((fault) => ({
            branchKind: fault.branchKind as ReportFaultBranchKind,
            stepNo: fault.stepNo,
            phaseCode: fault.phaseCode,
            mainError: fault.mainError,
            unitError: fault.unitError,
            source: fault.source,
            errorType: fault.errorType,
            gpibStatus: fault.gpibStatus,
            faultStatus: fault.faultStatus,
            description: fault.description,
            action: fault.action,
          })),
    // AI 评价组：undefined 表示沿用服务端落库值
    aiUsage: draft.aiUsage ?? undefined,
    aiSourceType: draft.aiSourceType ?? undefined,
    aiSourceId: draft.aiSourceId ?? undefined,
    aiSourceVersion: draft.aiSourceVersion ?? undefined,
    aiScore: draft.aiScore ?? undefined,
    aiCorrectness: draft.aiCorrectness ?? undefined,
    aiHelpfulness: draft.aiHelpfulness ?? undefined,
    aiNote: draft.aiNote ?? undefined,
  };
}

/** 首次保存/直接提交随请求绑定的暂存原件（R050-01/R045-02/R051-01） */
export type StagedAttachmentPayload = {
  fileId: string;
  uploadContextId: string;
};

/**
 * R050-01/R045-02/R051-01 契约边界：`MaintenanceReportStagedAttachmentInputDTO`
 * 只接受 `{fileId, uploadContextId}`。任务 11 上传返回的暂存记录还带
 * originalFilename/status/bindingStatus 等服务端只读字段，发送前必须裁剪，
 * 不放宽 GraphQL 输入校验（2026-11-21 实库验收缺陷修复）。
 */
function toGraphQLAttachmentInput(
  attachment: StagedAttachmentPayload | null | undefined,
): { fileId: string; uploadContextId: string } | undefined {
  if (attachment === null || attachment === undefined) return undefined;
  return { fileId: attachment.fileId, uploadContextId: attachment.uploadContextId };
}

export async function createMaintenanceReportDraft(params: {
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  draft: DraftPayload;
  attachment?: StagedAttachmentPayload | null;
}): Promise<MaintenanceReportDraftResult> {
  const data = await executeGraphQL<
    { createMaintenanceReportDraft: MaintenanceReportDraftResult },
    { input: Record<string, unknown> }
  >(CREATE_DRAFT_MUTATION, {
    input: {
      sourceType: params.sourceType,
      repairRequestId: params.repairRequestId ?? undefined,
      draft: toGraphQLDraftInput(params.draft),
      attachment: toGraphQLAttachmentInput(params.attachment),
    },
  });
  return data.createMaintenanceReportDraft;
}

export async function updateMaintenanceReportDraft(params: {
  reportId: number;
  draft: DraftPayload;
  /** R050-02/R062-01：续填同事务绑定/更换暂存原件（可选） */
  attachment?: StagedAttachmentPayload | null;
}): Promise<MaintenanceReportDraftResult> {
  const data = await executeGraphQL<
    { updateMaintenanceReportDraft: MaintenanceReportDraftResult },
    { input: Record<string, unknown> }
  >(UPDATE_DRAFT_MUTATION, {
    input: {
      reportId: params.reportId,
      draft: toGraphQLDraftInput(params.draft),
      attachment: toGraphQLAttachmentInput(params.attachment),
    },
  });
  return data.updateMaintenanceReportDraft;
}

/**
 * R051-01 正式提交：草稿提交与未保存表单直接提交共用。
 * submissionRequestId 由调用方生成并在同次提交重试时复用（响应丢失不换新标识）。
 */
export async function submitMaintenanceReport(params: {
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  reportId: number | null;
  expectedVersionNo: number | null;
  submissionRequestId: string;
  sourceConfirmation?: string;
  draft: DraftPayload;
  attachment?: StagedAttachmentPayload | null;
}): Promise<MaintenanceReportSubmitResult> {
  const data = await executeGraphQL<
    { submitMaintenanceReport: MaintenanceReportSubmitResult },
    { input: Record<string, unknown> }
  >(SUBMIT_MUTATION, {
    input: {
      sourceType: params.sourceType,
      repairRequestId: params.repairRequestId ?? undefined,
      reportId: params.reportId ?? undefined,
      expectedVersionNo: params.expectedVersionNo ?? undefined,
      submissionRequestId: params.submissionRequestId,
      sourceConfirmation: params.sourceConfirmation,
      draft: toGraphQLDraftInput(params.draft),
      attachment: toGraphQLAttachmentInput(params.attachment),
    },
  });
  return data.submitMaintenanceReport;
}

export async function fetchMyMaintenanceReport(reportId: number): Promise<MaintenanceReportDetail> {
  const data = await executeGraphQL<
    { myMaintenanceReport: MaintenanceReportDetail },
    { reportId: number }
  >(MY_REPORT_QUERY, { reportId });
  return data.myMaintenanceReport;
}

export async function fetchMyMaintenanceReports(params: {
  page?: number;
  pageSize?: number;
  sourceType?: MaintenanceReportSourceType;
}): Promise<MaintenanceReportPage> {
  const data = await executeGraphQL<
    { myMaintenanceReports: MaintenanceReportPage },
    { pagination?: Record<string, unknown>; filter?: Record<string, unknown> }
  >(MY_REPORTS_QUERY, {
    pagination: { page: params.page, pageSize: params.pageSize, withTotal: true },
    filter: params.sourceType === undefined ? undefined : { sourceType: params.sourceType },
  });
  return data.myMaintenanceReports;
}

export async function fetchMyWorkOrderSummary(
  repairRequestId: number,
): Promise<MyWorkOrderSummaryEntry> {
  const data = await executeGraphQL<
    { myWorkOrderSummary: MyWorkOrderSummaryEntry },
    { repairRequestId: number }
  >(MY_WORK_ORDER_SUMMARY_QUERY, { repairRequestId });
  return data.myWorkOrderSummary;
}

export async function fetchMyWorkOrderSummaryCandidates(params: {
  page?: number;
  pageSize?: number;
}): Promise<WorkOrderSummaryCandidatePage> {
  const data = await executeGraphQL<
    { myWorkOrderSummaryCandidates: WorkOrderSummaryCandidatePage },
    { pagination?: Record<string, unknown> }
  >(MY_WORK_ORDER_SUMMARIES_QUERY, {
    pagination: { page: params.page, pageSize: params.pageSize, withTotal: true },
  });
  return data.myWorkOrderSummaryCandidates;
}

/**
 * 工单总结 AI 评价候选会话（任务 05 真实读侧）。
 *
 * 空数组 = 服务端确认没有符合条件的会话；请求失败会抛出 GraphQL 错误，
 * 调用方必须区分「确认无会话」与「无法确认」，不能把失败当成无会话。
 */
export async function fetchWorkOrderSummaryAiConversations(
  repairRequestId: number,
): Promise<WorkOrderSummaryAiConversation[]> {
  const data = await executeGraphQL<
    { myWorkOrderSummaryAiConversations: WorkOrderSummaryAiConversation[] },
    { repairRequestId: number }
  >(MY_WORK_ORDER_SUMMARY_AI_CONVERSATIONS_QUERY, { repairRequestId });
  return data.myWorkOrderSummaryAiConversations;
}

/**
 * 型号库选项（只读）。
 * 与报修申请创建页共用同一后端查询；此处保留独立文档以避免跨 feature 依赖。
 */
export async function fetchMaintenanceEquipmentModels(): Promise<EquipmentModelOption[]> {
  const data = await executeGraphQL<
    { equipmentModels: EquipmentModelOption[] },
    Record<string, never>
  >(EQUIPMENT_MODELS_QUERY, {});
  return data.equipmentModels;
}

/**
 * R051 导出：当前表单（含未保存草稿）或有权已保存版本 → DOCX/PDF。
 * 只读接口：不创建报告、不登记机型；权限与完整性由服务端裁决。
 */
export async function exportMaintenanceReport(
  params: ExportMaintenanceReportParams,
): Promise<MaintenanceReportExportResult> {
  const input: Record<string, unknown> = { format: params.format };
  if (params.currentForm) {
    input.currentForm = {
      sourceType: params.currentForm.sourceType,
      repairRequestId: params.currentForm.repairRequestId ?? undefined,
      draft: toGraphQLDraftInput(params.currentForm.draft),
    };
  }
  if (params.savedVersion) {
    input.savedVersion = {
      reportId: params.savedVersion.reportId,
      versionNo: params.savedVersion.versionNo ?? undefined,
    };
  }
  const data = await executeGraphQL<
    { exportMaintenanceReport: MaintenanceReportExportResult },
    { input: Record<string, unknown> }
  >(EXPORT_MUTATION, { input });
  return data.exportMaintenanceReport;
}

export type ExportMaintenanceReportParams = {
  format: MaintenanceReportExportFormat;
  currentForm?: {
    sourceType: MaintenanceReportSourceType;
    repairRequestId: number | null;
    draft: DraftPayload;
  };
  savedVersion?: {
    reportId: number;
    versionNo?: number | null;
  };
};

/* ---------------------------- 原件上传与附件挂接（R062/R050） ---------------------------- */

const STORED_FILE_UPLOAD_ENDPOINT = '/api/stored-files';

const ADD_MAINTENANCE_REPORT_ATTACHMENT_MUTATION = `
  mutation AddMaintenanceReportAttachment($input: AddMaintenanceReportAttachmentInput!) {
    addMaintenanceReportAttachment(input: $input) {
      reportId
      attachmentIds
      currentBytes
    }
  }
`;

const REMOVE_MAINTENANCE_REPORT_ATTACHMENT_MUTATION = `
  mutation RemoveMaintenanceReportAttachment($input: RemoveMaintenanceReportAttachmentInput!) {
    removeMaintenanceReportAttachment(input: $input) {
      reportId
      attachmentIds
      currentBytes
    }
  }
`;

const UPLOAD_FAILURE_REASON_BY_CODE: Record<string, MaintenanceReportUploadFailureReason> = {
  STORED_FILE_UPLOAD_FILE_TOO_LARGE: 'file-too-large',
  STORED_FILE_UPLOAD_FILE_TYPE_NOT_ALLOWED: 'file-type-not-allowed',
  STORED_FILE_INVALID_PARAMS: 'invalid-input',
  STORED_FILE_PURPOSE_NOT_SUPPORTED: 'invalid-input',
  STORED_FILE_UPLOAD_FILE_MISSING: 'invalid-input',
  FORBIDDEN: 'insufficient-permission',
};

/** 上传/挂接/移除失败的统一兜底文案（服务端 userMessage 缺失时使用） */
const ATTACHMENT_FALLBACK_MESSAGES = {
  'invalid-input': '上传内容不符合要求，请检查后重试',
  'file-too-large': '原件超过大小限制',
  'file-type-not-allowed': '不允许上传该类型的原件',
  'insufficient-permission': '当前账号无权上传报告原件',
  'upload-failed': '原件上传失败，请检查网络后重试',
  'add-failed': '附件登记失败，请稍后重试',
  'remove-failed': '附件移除失败，请稍后重试',
} as const;

/**
 * 上传报告原件（REST，暂存态）：任务 11 真实入口，MAINTENANCE_REPORT 用途。
 * 成功仅代表暂存完成；绑定发生在"添加附件"且服务端核验通过后。
 */
export async function uploadMaintenanceReportOriginal(
  file: File,
): Promise<MaintenanceReportUploadResult> {
  const formData = new FormData();
  formData.append('businessType', 'MAINTENANCE_REPORT');
  formData.append('file', file, file.name);

  let response: Response;
  try {
    response = await fetchRestWithAuthRetry(STORED_FILE_UPLOAD_ENDPOINT, {
      method: 'POST',
      body: formData,
    });
  } catch {
    return {
      ok: false,
      reason: 'upload-failed',
      message: ATTACHMENT_FALLBACK_MESSAGES['upload-failed'],
    };
  }

  if (response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        ok: false,
        reason: 'upload-failed',
        message: ATTACHMENT_FALLBACK_MESSAGES['upload-failed'],
      };
    }

    const data = (payload as { data?: Partial<StagedMaintenanceReportFile> } | null)?.data;
    if (
      data &&
      typeof data.fileId === 'string' &&
      typeof data.uploadContextId === 'string' &&
      typeof data.originalFilename === 'string' &&
      typeof data.mimeType === 'string' &&
      typeof data.byteSize === 'number' &&
      typeof data.checksumSha256 === 'string'
    ) {
      return { ok: true, file: data as StagedMaintenanceReportFile };
    }

    return {
      ok: false,
      reason: 'upload-failed',
      message: ATTACHMENT_FALLBACK_MESSAGES['upload-failed'],
    };
  }

  let envelope: RestErrorEnvelope = {};
  try {
    envelope = toRestErrorEnvelope(await response.json());
  } catch {
    // 非 JSON 错误体，走兜底
  }

  const code = readRestErrorField(envelope, 'code');
  const message = readRestErrorField(envelope, 'message');
  const reason = code ? UPLOAD_FAILURE_REASON_BY_CODE[code] : undefined;
  if (reason) {
    return {
      ok: false,
      reason,
      message: message ?? ATTACHMENT_FALLBACK_MESSAGES[reason],
    };
  }
  return {
    ok: false,
    reason: 'upload-failed',
    message: ATTACHMENT_FALLBACK_MESSAGES['upload-failed'],
  };
}

/** 附件挂接/移除的 GraphQL 失败兜底：错误码透传 userMessage，缺失时给明确文案 */
function toAttachmentMutationResult(
  error: unknown,
  fallback: string,
): MaintenanceReportAttachmentMutationResult {
  const detail = readGraphQLErrorDetail(error);
  return { ok: false, message: detail?.errorMessage ?? fallback };
}

/**
 * 挂接暂存原件到本人可编辑报告：服务端同事务核验暂存事实并原子绑定。
 * 上传未完成、无权或文件失效时明确失败，不伪称成功。
 */
export async function addMaintenanceReportAttachment(params: {
  reportId: number;
  file: StagedMaintenanceReportFile;
}): Promise<MaintenanceReportAttachmentMutationResult> {
  try {
    await executeGraphQL<Record<string, unknown>, { input: Record<string, unknown> }>(
      ADD_MAINTENANCE_REPORT_ATTACHMENT_MUTATION,
      {
        input: {
          reportId: params.reportId,
          fileId: params.file.fileId,
          uploadContextId: params.file.uploadContextId,
        },
      },
    );
    return { ok: true };
  } catch (error) {
    return toAttachmentMutationResult(error, ATTACHMENT_FALLBACK_MESSAGES['add-failed']);
  }
}

/** 移除（退役）本人可编辑报告的当前附件；已冻结版本历史不受影响 */
export async function removeMaintenanceReportAttachment(params: {
  reportId: number;
  attachmentId: number;
}): Promise<MaintenanceReportAttachmentMutationResult> {
  try {
    await executeGraphQL<Record<string, unknown>, { input: Record<string, unknown> }>(
      REMOVE_MAINTENANCE_REPORT_ATTACHMENT_MUTATION,
      {
        input: { reportId: params.reportId, attachmentId: params.attachmentId },
      },
    );
    return { ok: true };
  } catch (error) {
    return toAttachmentMutationResult(error, ATTACHMENT_FALLBACK_MESSAGES['remove-failed']);
  }
}

/* ---------------------------- 报告附件授权下载（R062-03） ---------------------------- */

const DOWNLOAD_FAILURE_REASON_BY_CODE: Record<
  string,
  'insufficient-permission' | 'not-found' | 'not-available'
> = {
  FORBIDDEN: 'insufficient-permission',
  STORED_FILE_NOT_FOUND: 'not-found',
  STORED_FILE_FILE_NOT_AVAILABLE: 'not-available',
};

const DOWNLOAD_FALLBACK_MESSAGE_BY_REASON: Record<
  'download-failed' | 'insufficient-permission' | 'not-found' | 'not-available',
  string
> = {
  'download-failed': '附件下载失败，请检查网络后重试',
  'insufficient-permission': '当前账号无权下载该附件',
  'not-found': '附件不存在或无权访问',
  'not-available': '附件文件暂时不可用',
};

/**
 * 按附件行的 fileId 走 REST 授权下载（R062-03）：服务端按报告附件归属裁决，
 * 已移除附件、他人草稿与越权账号统一拒绝；客户端只拿 fileId，不经手存储引用。
 */
export async function downloadMaintenanceReportAttachment(params: {
  fileId: string;
  fallbackFilename: string;
}): Promise<MaintenanceReportAttachmentDownloadResult> {
  let response: Response;
  try {
    response = await fetchRestWithAuthRetry(
      `/api/stored-files/${encodeURIComponent(params.fileId)}/download`,
      {},
    );
  } catch {
    return {
      ok: false,
      reason: 'download-failed',
      message: DOWNLOAD_FALLBACK_MESSAGE_BY_REASON['download-failed'],
    };
  }

  if (response.ok) {
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      return {
        ok: false,
        reason: 'download-failed',
        message: DOWNLOAD_FALLBACK_MESSAGE_BY_REASON['download-failed'],
      };
    }
    const filename =
      parseAttachmentFilename(response.headers.get('Content-Disposition')) ??
      params.fallbackFilename;
    return { ok: true, blob, filename };
  }

  let envelope: RestErrorEnvelope = {};
  try {
    envelope = toRestErrorEnvelope(await response.json());
  } catch {
    // 非 JSON 错误体，走兜底
  }
  const code = readRestErrorField(envelope, 'code');
  const message = readRestErrorField(envelope, 'message');
  const reason = code ? DOWNLOAD_FAILURE_REASON_BY_CODE[code] : undefined;
  if (reason) {
    return { ok: false, reason, message: message ?? DOWNLOAD_FALLBACK_MESSAGE_BY_REASON[reason] };
  }
  return {
    ok: false,
    reason: 'download-failed',
    message: message ?? DOWNLOAD_FALLBACK_MESSAGE_BY_REASON['download-failed'],
  };
}

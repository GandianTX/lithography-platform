// src/features/content-submission/infrastructure/content-submission-attachment-adapter.ts

import {
  fetchRestWithAuthRetry,
  parseAttachmentFilename,
  readRestErrorField,
  type RestErrorEnvelope,
  toRestErrorEnvelope,
} from '@/shared/http';

import type {
  ContentSubmissionAttachmentDownloadResult,
  ContentSubmissionAttachmentRemoveResult,
  ContentSubmissionAttachmentUploadResult,
} from './content-submission.types';

/**
 * 内容投稿附件 REST 数据访问层（A-PR0 §4.2：单附件上传 / 移除 / 下载）。
 *
 * 与 GraphQL adapter 的差异（有意为之，非违反「adapter 不读写 Session」约定）：
 * - 带鉴权 REST 请求与统一响应信封解析复用 shared/http（Token 读取沿用
 *   configureGraphQLRuntime 注入的 getAccessToken；401 与 GraphQL 链路同口径：
 *   refreshSession 刷新后重试一次，无刷新能力 / 刷新失败 / 重试仍 401 时宣布会话失效）；
 * - REST 边界无 GraphQL extensions 错误契约，响应为统一信封
 *   { success, data: { statusCode, code, message } }，本层把所有失败
 *   （transport / auth / 业务拒绝）统一归并为显式失败结果，调用方只消费 reason / message。
 *
 * 契约依据：backend/src/adapters/api/rest/content-submission/content-submission-rest.controller.ts
 * （错误码唯一真源 backend/src/core/common/errors/domain-error.ts）。
 */

function attachmentEndpoint(submissionId: number): string {
  return `/api/content-submissions/${submissionId}/attachment`;
}

function downloadEndpoint(submissionId: number, attachmentId: number): string {
  return `/api/content-submissions/${submissionId}/attachments/${attachmentId}/download`;
}

/** 上传失败原因映射（唯一真源：后端 CONTENT_SUBMISSION_ERROR 码组 + 守卫权限码） */
const UPLOAD_REASON_BY_CODE: Record<
  string,
  Exclude<
    Extract<ContentSubmissionAttachmentUploadResult, { ok: false }>['reason'],
    'upload-failed'
  >
> = {
  CONTENT_SUBMISSION_NOT_FOUND: 'not-found',
  CONTENT_SUBMISSION_INVALID_PARAMS: 'invalid-input',
  CONTENT_SUBMISSION_UPLOAD_FILE_MISSING: 'invalid-input',
  CONTENT_SUBMISSION_UPLOAD_FILE_TOO_LARGE: 'file-too-large',
  CONTENT_SUBMISSION_UPLOAD_FILE_TYPE_NOT_ALLOWED: 'file-type-not-allowed',
  CONTENT_SUBMISSION_STATE_NOT_EDITABLE: 'state-conflict',
  INSUFFICIENT_PERMISSIONS: 'forbidden',
  ACCESS_DENIED: 'forbidden',
  ROLE_REQUIRED: 'forbidden',
  // 可信组织上下文（已认证的权限类拒绝，后端 REST 映射 403）：与守卫权限码同口径
  ORGANIZATION_NO_ACTIVE_MEMBERSHIP: 'forbidden',
  ORGANIZATION_AMBIGUOUS_MEMBERSHIP: 'forbidden',
};

const UPLOAD_FALLBACK_MESSAGE_BY_REASON: Record<
  Exclude<
    Extract<ContentSubmissionAttachmentUploadResult, { ok: false }>['reason'],
    'upload-failed'
  >,
  string
> = {
  'not-found': '投稿不存在或不可上传附件。',
  'invalid-input': '上传内容不符合要求，请检查后重新提交。',
  'file-too-large': '上传文件超过大小限制。',
  'file-type-not-allowed': '不允许上传该类型的文件。',
  'state-conflict': '当前状态不允许变更附件，请刷新后重试。',
  forbidden: '当前账号没有上传投稿附件的权限。',
};

/** 移除失败原因映射 */
const REMOVE_REASON_BY_CODE: Record<
  string,
  Exclude<
    Extract<ContentSubmissionAttachmentRemoveResult, { ok: false }>['reason'],
    'remove-failed'
  >
> = {
  CONTENT_SUBMISSION_NOT_FOUND: 'not-found',
  CONTENT_SUBMISSION_STATE_NOT_EDITABLE: 'state-conflict',
  INSUFFICIENT_PERMISSIONS: 'forbidden',
  ACCESS_DENIED: 'forbidden',
  ROLE_REQUIRED: 'forbidden',
  // 可信组织上下文（已认证的权限类拒绝，后端 REST 映射 403）：与守卫权限码同口径
  ORGANIZATION_NO_ACTIVE_MEMBERSHIP: 'forbidden',
  ORGANIZATION_AMBIGUOUS_MEMBERSHIP: 'forbidden',
};

const REMOVE_FALLBACK_MESSAGE_BY_REASON: Record<
  Exclude<
    Extract<ContentSubmissionAttachmentRemoveResult, { ok: false }>['reason'],
    'remove-failed'
  >,
  string
> = {
  'not-found': '投稿不存在或不可移除附件。',
  'state-conflict': '当前状态不允许变更附件，请刷新后重试。',
  forbidden: '当前账号没有变更投稿附件的权限。',
};

/** 下载失败原因映射 */
const DOWNLOAD_REASON_BY_CODE: Record<
  string,
  Exclude<
    Extract<ContentSubmissionAttachmentDownloadResult, { ok: false }>['reason'],
    'download-failed'
  >
> = {
  CONTENT_SUBMISSION_NOT_FOUND: 'not-found',
  CONTENT_SUBMISSION_FILE_NOT_AVAILABLE: 'file-not-available',
  INSUFFICIENT_PERMISSIONS: 'forbidden',
  ACCESS_DENIED: 'forbidden',
  ROLE_REQUIRED: 'forbidden',
  // 可信组织上下文（已认证的权限类拒绝，后端 REST 映射 403）：与守卫权限码同口径
  ORGANIZATION_NO_ACTIVE_MEMBERSHIP: 'forbidden',
  ORGANIZATION_AMBIGUOUS_MEMBERSHIP: 'forbidden',
};

const DOWNLOAD_FALLBACK_MESSAGE_BY_REASON: Record<
  Exclude<
    Extract<ContentSubmissionAttachmentDownloadResult, { ok: false }>['reason'],
    'download-failed'
  >,
  string
> = {
  'not-found': '投稿附件不存在或不可查看。',
  'file-not-available': '该附件没有可下载的文件。',
  forbidden: '当前账号没有下载投稿附件的权限。',
};

/** 读取错误信封（解析失败给空信封走兜底）；供三类操作共用的错误分支 */
async function readErrorEnvelope(response: Response): Promise<{
  code: string | null;
  message: string | null;
}> {
  let envelope: RestErrorEnvelope = {};

  try {
    envelope = toRestErrorEnvelope(await response.json());
  } catch {
    // 非 JSON 错误体（网关/代理错误页），走调用方兜底
  }

  return {
    code: readRestErrorField(envelope, 'code'),
    message: readRestErrorField(envelope, 'message'),
  };
}

/**
 * REST multipart 单附件上传（仅工程师；每次上传替换当前附件）。
 * 成功信封 { success: true, data: { attachmentId, originalFilename, mimeType, byteSize } }。
 */
export async function uploadContentSubmissionAttachment(
  submissionId: number,
  file: File,
): Promise<ContentSubmissionAttachmentUploadResult> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  let response: Response;

  try {
    response = await fetchRestWithAuthRetry(attachmentEndpoint(submissionId), {
      method: 'POST',
      body: formData,
    });
  } catch {
    return {
      ok: false,
      reason: 'upload-failed',
      message: '附件上传失败，请检查网络后重试。',
    };
  }

  if (response.ok) {
    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      return { ok: false, reason: 'upload-failed', message: '附件上传失败，请稍后重试。' };
    }

    const data = (payload as { data?: Record<string, unknown> } | null)?.data;

    if (
      data &&
      typeof data.attachmentId === 'number' &&
      typeof data.originalFilename === 'string' &&
      typeof data.mimeType === 'string' &&
      typeof data.byteSize === 'number'
    ) {
      return {
        ok: true,
        attachment: {
          id: data.attachmentId,
          originalFilename: data.originalFilename,
          mimeType: data.mimeType,
          byteSize: data.byteSize,
        },
      };
    }

    return { ok: false, reason: 'upload-failed', message: '附件上传失败，请稍后重试。' };
  }

  const { code, message } = await readErrorEnvelope(response);

  if (code && UPLOAD_REASON_BY_CODE[code]) {
    const reason = UPLOAD_REASON_BY_CODE[code];

    return { ok: false, reason, message: message ?? UPLOAD_FALLBACK_MESSAGE_BY_REASON[reason] };
  }

  return {
    ok: false,
    reason: 'upload-failed',
    message: message ?? '附件上传失败，请稍后重试。',
  };
}

/**
 * REST 移除当前附件（仅工程师本人；无当前附件时幂等成功 204）。
 * 错误分支仅业务拒绝（不存在 / 状态冲突 / 权限），其余落 remove-failed 兜底。
 */
export async function removeContentSubmissionAttachment(
  submissionId: number,
): Promise<ContentSubmissionAttachmentRemoveResult> {
  let response: Response;

  try {
    response = await fetchRestWithAuthRetry(attachmentEndpoint(submissionId), {
      method: 'DELETE',
    });
  } catch {
    return {
      ok: false,
      reason: 'remove-failed',
      message: '附件移除失败，请检查网络后重试。',
    };
  }

  if (response.ok) {
    return { ok: true };
  }

  const { code, message } = await readErrorEnvelope(response);

  if (code && REMOVE_REASON_BY_CODE[code]) {
    const reason = REMOVE_REASON_BY_CODE[code];

    return { ok: false, reason, message: message ?? REMOVE_FALLBACK_MESSAGE_BY_REASON[reason] };
  }

  return {
    ok: false,
    reason: 'remove-failed',
    message: message ?? '附件移除失败，请稍后重试。',
  };
}

/**
 * REST 流式下载投稿附件（工程师与管理员）：fetch blob 后交由调用方触发浏览器保存。
 * 附件不可访问统一 not-found；存储对象缺失统一 file-not-available。
 */
export async function downloadContentSubmissionAttachment(
  submissionId: number,
  attachmentId: number,
): Promise<ContentSubmissionAttachmentDownloadResult> {
  let response: Response;

  try {
    response = await fetchRestWithAuthRetry(downloadEndpoint(submissionId, attachmentId), {});
  } catch {
    return {
      ok: false,
      reason: 'download-failed',
      message: '下载失败，请检查网络后重试。',
    };
  }

  if (response.ok) {
    let blob: Blob;

    try {
      blob = await response.blob();
    } catch {
      return { ok: false, reason: 'download-failed', message: '下载失败，请稍后重试。' };
    }

    const filename =
      parseAttachmentFilename(response.headers.get('Content-Disposition')) ??
      `content-submission-attachment-${attachmentId}`;

    return { ok: true, blob, filename };
  }

  const { code, message } = await readErrorEnvelope(response);

  if (code && DOWNLOAD_REASON_BY_CODE[code]) {
    const reason = DOWNLOAD_REASON_BY_CODE[code];

    return { ok: false, reason, message: message ?? DOWNLOAD_FALLBACK_MESSAGE_BY_REASON[reason] };
  }

  return {
    ok: false,
    reason: 'download-failed',
    message: message ?? '下载失败，请稍后重试。',
  };
}

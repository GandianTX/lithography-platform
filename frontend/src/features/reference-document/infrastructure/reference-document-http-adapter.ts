// src/features/reference-document/infrastructure/reference-document-http-adapter.ts

import {
  fetchRestWithAuthRetry,
  parseAttachmentFilename,
  readRestErrorField,
  type RestErrorEnvelope,
  toRestErrorEnvelope,
} from '@/shared/http';

import type { ReferenceDocumentFileDownloadResult } from './reference-document.types';

/**
 * 历史维修记录库文件下载 REST 数据访问层。
 *
 * 与 GraphQL adapter 的差异（有意为之，非违反「adapter 不读写 Session」约定）：
 * - 带鉴权 REST 请求与统一响应信封解析复用 shared/http（Token 读取沿用
 *   configureGraphQLRuntime 注入的 getAccessToken，与 GraphQL authLink 的注入模式同源，
 *   项目使用 Authorization 头鉴权，REST 下载无法用 window.open / <a href> 直链；
 *   401 与 GraphQL 链路同口径：refreshSession 刷新后重试一次，无刷新能力 / 刷新失败 /
 *   重试仍 401 时宣布会话失效 onAuthFailure，由 app 装配统一清理与跳转）；
 * - REST 边界无 GraphQL extensions 错误契约，响应为统一信封
 *   { success, data: { statusCode, code, message } }，本层把所有失败
 *   （transport / auth / 业务拒绝）统一归并为显式失败结果，详情层
 *   只消费 reason / message，不感知 HTTP 细节。
 *
 * 契约依据：backend/src/adapters/api/rest/reference-document/reference-document-rest.controller.ts
 * （错误码唯一真源 backend/src/core/common/errors/domain-error.ts）。
 *
 * 任务 07 确认需求收口：旧 REST multipart 上传创建（POST /api/reference-documents/upload）
 * 已随服务端生产写入口一并关闭——本期普通资料新增取消，前端不再持有对应调用；
 * 合法的历史原件授权下载能力保留于 downloadReferenceDocumentFile。
 */

const DOWNLOAD_ENDPOINT_BASE = '/api/reference-documents';

const DOWNLOAD_REASON_BY_CODE: Record<
  string,
  Extract<ReferenceDocumentFileDownloadResult, { ok: false }>['reason']
> = {
  // 任务 07 P2：来源报告原件下载统一 NOT_FOUND 大类为完整错误码串（REST 信封 code = DomainError.code）
  NOT_FOUND: 'not-found',
  REFERENCE_DOCUMENT_NOT_FOUND: 'not-found',
  REFERENCE_DOCUMENT_FILE_NOT_AVAILABLE: 'file-not-available',
  FORBIDDEN: 'forbidden',
};

const DOWNLOAD_FALLBACK_MESSAGE_BY_REASON: Record<
  Extract<ReferenceDocumentFileDownloadResult, { ok: false }>['reason'],
  string
> = {
  'not-found': '历史维修记录不存在或不可查看。',
  'file-not-available': '该资料没有可下载的文件。',
  forbidden: '您没有下载该资料原件的权限。',
  'download-failed': '下载失败，请稍后重试。',
};

function downloadEndpoint(id: number): string {
  return `${DOWNLOAD_ENDPOINT_BASE}/${id}/download`;
}

/** 来源报告原件下载端点（任务 07 P2：扩展现有资料下载入口） */
function sourceAttachmentDownloadEndpoint(id: number, attachmentId: number): string {
  return `${DOWNLOAD_ENDPOINT_BASE}/${id}/source-attachments/${attachmentId}/download`;
}

/**
 * REST 流式下载（所有已登录角色）：fetch blob 后交由调用方触发浏览器保存。
 * 资料不存在 / 已软删统一 not-found；纯文本资料与存储对象缺失统一 file-not-available。
 */
export async function downloadReferenceDocumentFile(
  id: number,
): Promise<ReferenceDocumentFileDownloadResult> {
  return fetchDownloadBlob(downloadEndpoint(id), `reference-document-${id}`);
}

/**
 * 来源报告冻结版本原件下载（任务 07 P2）：报告来源资料的授权下载入口。
 * 服务端先按正式资料读取范围授权，再核验冻结版本附件绑定后回写文件流；
 * 资料不可见 / 原件未绑定该冻结版本统一 not-found，存储失效统一 file-not-available。
 */
export async function downloadReferenceDocumentSourceAttachment(
  id: number,
  attachmentId: number,
): Promise<ReferenceDocumentFileDownloadResult> {
  return fetchDownloadBlob(
    sourceAttachmentDownloadEndpoint(id, attachmentId),
    `reference-document-${id}-attachment-${attachmentId}`,
  );
}

/** 共用下载流程：fetch（带鉴权重试）→ blob → 解析 Content-Disposition 文件名 → 统一错误信封归并 */
async function fetchDownloadBlob(
  endpoint: string,
  fallbackFilename: string,
): Promise<ReferenceDocumentFileDownloadResult> {
  let response: Response;

  try {
    response = await fetchRestWithAuthRetry(endpoint, {});
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
      parseAttachmentFilename(response.headers.get('Content-Disposition')) ?? fallbackFilename;

    return { ok: true, blob, filename };
  }

  let envelope: RestErrorEnvelope = {};

  try {
    envelope = toRestErrorEnvelope(await response.json());
  } catch {
    // 非 JSON 错误体，走下方兜底
  }

  const code = readRestErrorField(envelope, 'code');
  const message = readRestErrorField(envelope, 'message');

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

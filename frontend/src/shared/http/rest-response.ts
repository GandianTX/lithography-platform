// src/shared/http/rest-response.ts

/**
 * REST 统一响应信封工具（后端 FormatResponseMiddleware 包装：
 * 成功与错误都在 body.data 内，错误体为 { statusCode, code, message }）。
 * 通用技术底座：只做结构解析，不携带业务错误码映射（映射留在各 feature/infrastructure）。
 */

/** REST 统一错误信封（只取用到的字段，收窄 unknown） */
export type RestErrorEnvelope = {
  data?: { statusCode?: unknown; code?: unknown; message?: unknown };
};

export function toRestErrorEnvelope(payload: unknown): RestErrorEnvelope {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }

  const data = (payload as { data?: unknown }).data;

  if (typeof data !== 'object' || data === null) {
    return {};
  }

  return { data: data as RestErrorEnvelope['data'] };
}

export function readRestErrorField(
  envelope: RestErrorEnvelope,
  field: 'code' | 'message',
): string | null {
  const value = envelope.data?.[field];

  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 解析 RFC 5987 编码的附件文件名；无 Content-Disposition 时返回 null 由调用方兜底 */
export function parseAttachmentFilename(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);

  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      return utf8Match[1].trim();
    }
  }

  const plainMatch = /filename="?([^";]+)"?/i.exec(header);

  return plainMatch ? plainMatch[1] : null;
}

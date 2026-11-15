// src/core/stored-file/policy/stored-file-input.policy.ts

/** 稳定编号格式：36 位 UUID（服务端 randomUUID 生成，数据库 char(36) 存储） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 归一化 fileId；格式不合法返回 null（由用例映射 INVALID_PARAMS） */
export function normalizeStoredFileId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * 归一化 uploadContextId；缺失/空/格式不合法返回 null。
 * 暂存读取要求非 null 且精确匹配，因此非法上下文按「无上下文」处理（最终 NOT_FOUND）。
 */
export function normalizeUploadContextId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

// src/usecases/stored-file/stored-file-input.normalize.ts

/**
 * 共用业务原件输入归一化（usecase 输入收敛单一真源）。
 * 只做空白/文件名安全收敛，不做权限、组织或业务状态判断。
 */

/** 业务用途：非字符串或空白归为空串，由用例映射 INVALID_PARAMS / PURPOSE_NOT_SUPPORTED */
export function normalizeStoredFileBusinessType(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 仅保留文件名本身，拒绝路径片段、空名、控制字符与超长名（数据库 255 上限） */
export function normalizeStoredFileOriginalFilename(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const basename = value.split(/[\\/]/).pop()?.trim() ?? '';
  if (!basename || basename.length > 255 || basename.includes('\0')) {
    return null;
  }
  return basename;
}

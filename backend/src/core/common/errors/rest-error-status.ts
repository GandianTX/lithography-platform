// src/core/common/errors/rest-error-status.ts

import {
  AUTH_ERROR,
  CONTENT_SUBMISSION_ERROR,
  JWT_ERROR,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from './domain-error';

/**
 * DomainError 业务码 → REST HTTP 状态码映射（单一口径）。
 *
 * - REST 边界（multipart 上传/下载）不走 GraphQL error 契约，统一返回
 *   HTTP 状态码 + { statusCode, code, message } JSON 体；
 * - 由 REST 控制器与全局异常过滤器共用：守卫/用例在 REST 上下文抛出的
 *   DomainError 均按本映射渲染，避免兜底成 500 丢失语义；
 * - 未登记的业务码一律 500，不猜测语义。
 */
export function resolveRestStatus(code: string): number {
  // 认证侧（守卫 JWT 失败、登录态问题）统一 401
  if (Object.values(JWT_ERROR).includes(code as (typeof JWT_ERROR)[keyof typeof JWT_ERROR])) {
    return 401;
  }
  if (Object.values(AUTH_ERROR).includes(code as (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR])) {
    return 401;
  }

  // 权限侧统一 403
  if (
    Object.values(PERMISSION_ERROR).includes(
      code as (typeof PERMISSION_ERROR)[keyof typeof PERMISSION_ERROR],
    )
  ) {
    return 403;
  }

  // 输入规范化问题统一 400
  if (code.startsWith('INPUT_NORMALIZE_')) {
    return 400;
  }

  const byCode: Record<string, number> = {
    [REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS]: 400,
    [REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND]: 400,
    [REFERENCE_DOCUMENT_ERROR.CONTENT_SOURCE_EMPTY]: 400,
    [REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_MISSING]: 400,
    [REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TOO_LARGE]: 413,
    [REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED]: 415,
    [REFERENCE_DOCUMENT_ERROR.NOT_FOUND]: 404,
    [REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE]: 404,
    // 内容投稿（A-PR0 §4.2）：输入类 400；他人/跨组织/不存在 404；状态冲突 409；
    // 系统侧失败不登记 → 默认 500，不猜测语义
    [CONTENT_SUBMISSION_ERROR.INVALID_PARAMS]: 400,
    [CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY]: 400,
    [CONTENT_SUBMISSION_ERROR.EQUIPMENT_MODEL_NOT_FOUND]: 400,
    [CONTENT_SUBMISSION_ERROR.NOT_FOUND]: 404,
    [CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE]: 409,
    // 投稿附件链路（A-PR0 §4.2）与参考资料上传同口径：缺失 400、超限 413、
    // 类型不允许 415、存储对象缺失 404
    [CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_MISSING]: 400,
    [CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TOO_LARGE]: 413,
    [CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED]: 415,
    [CONTENT_SUBMISSION_ERROR.FILE_NOT_AVAILABLE]: 404,
    // 可信组织上下文（A-PR0 §2.1）：已认证账号的成员事实缺失/歧义属权限类拒绝，
    // REST 与 GraphQL（FORBIDDEN）同语义 → 403；不得兜底成 500 丢失语义
    [ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP]: 403,
    [ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP]: 403,
  };

  return byCode[code] ?? 500;
}

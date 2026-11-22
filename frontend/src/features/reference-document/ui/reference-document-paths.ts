// src/features/reference-document/ui/reference-document-paths.ts

/** 参考资料库路由路径（路由真源在 app/router；此处仅供 feature 内导航与面包屑使用） */
export const REFERENCE_DOCUMENTS_LIST_PATH = '/reference-documents';

/**
 * 归属待核实管理路径（任务 07 R061-01，一级管理员专用入口）：
 * 与普通资料库分开的清单路由，路由层按 GLOBAL 管理范围守卫（一级仅放行）。
 */
export const ADMIN_PENDING_OWNERSHIP_LIST_PATH = '/admin/reference-ownership';

/**
 * 独立管理修订页路径（任务 07，一级管理员专用入口）：
 * 从资料详情「管理修订」进入，按 GLOBAL 管理范围守卫（仅一级放行）。
 */
export const ADMIN_REFERENCE_REVISE_PATH = '/admin/reference-revise';

export function buildAdminReferenceRevisePath(documentId: number): string {
  return `${ADMIN_REFERENCE_REVISE_PATH}/${documentId}`;
}

export function buildReferenceDocumentDetailPath(documentId: number): string {
  return `/reference-documents/${documentId}`;
}

/** 归属待核实详情路径：待核实清单条目点击进入（一级管理员专用） */
export function buildPendingOwnershipDetailPath(documentId: number): string {
  return `${ADMIN_PENDING_OWNERSHIP_LIST_PATH}/${documentId}`;
}

/**
 * 详情路由参数解析：只接受安全正整数字面量，其余（abc/0/负数/小数/空）
 * 一律归为 null，由页面直接呈现统一 not-found，不发 GraphQL 请求——
 * 非法值若直接进 Int! 变量会成为输入/序列化错误被归入 failed，
 * 出现「重试仍失败」的死循环入口（负责人 0909 修复要求）。
 */
export function parseReferenceDocumentIdParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }

  const parsed = Number(raw);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

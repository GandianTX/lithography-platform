// src/modules/lithography/management-audit.types.ts

import type { ManagementAuditDetailView } from '@core/management-audit/policy/management-audit-detail.policy';

/**
 * 关键操作记录的稳定读契约（任务 10）。
 *
 * 与存储的关系：`management_audit_event.operation` 的 CHECK 允许五类值
 * （三类业务事实 + 两类凭据补发/重置），本契约**只暴露三类**，凭据类即使入库也
 * 不会出现在本读链路；`result` 三值全保留。
 */

/** 查询白名单：R089 规定的三类管理事实。 */
export const managementAuditOperationValues = {
  ADMIN_DELETE_DOCUMENT: 'ADMIN_DELETE_DOCUMENT',
  CORRECT_DOCUMENT_OWNERSHIP: 'CORRECT_DOCUMENT_OWNERSHIP',
  RESTORE_LOCAL_BUSINESS: 'RESTORE_LOCAL_BUSINESS',
} as const;

export type ManagementAuditQueryOperation = keyof typeof managementAuditOperationValues;

/** 供仓储层 `IN (...)` 使用的固定集合（顺序即枚举声明顺序）。 */
export const MANAGEMENT_AUDIT_QUERY_OPERATIONS: ReadonlyArray<ManagementAuditQueryOperation> =
  Object.freeze(Object.keys(managementAuditOperationValues) as ManagementAuditQueryOperation[]);

/** 结果三值：与 `chk_management_audit_result` 一致。 */
export const managementAuditResultValues = {
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  DENIED: 'DENIED',
} as const;

export type ManagementAuditResultValue = keyof typeof managementAuditResultValues;

/** operation 字符串是否属于查询白名单（防御式校验，不信任仓储返回类型）。 */
export function isManagementAuditQueryOperation(
  value: string,
): value is ManagementAuditQueryOperation {
  return Object.prototype.hasOwnProperty.call(managementAuditOperationValues, value);
}

/** result 字符串是否为合法三值。 */
export function isManagementAuditResultValue(value: string): value is ManagementAuditResultValue {
  return Object.prototype.hasOwnProperty.call(managementAuditResultValues, value);
}

/** 列表分页：仅 OFFSET，排序由契约固定，不提供客户端排序。 */
export type ManagementAuditListPagination = {
  readonly page: number;
  readonly pageSize: number;
  readonly withTotal: boolean;
};

/**
 * 仓储读取结果（模块内部）。
 *
 * `detail` 保留原值，仅允许 QueryService 在投影为 ReadModel 时读取一次；
 * 该结构不得越过 modules 层。
 */
export type ManagementAuditEventQueryResult = {
  readonly eventId: string;
  readonly actorAccountId: number;
  readonly actorAdminLevel: number;
  readonly organizationId: number | null;
  readonly operation: ManagementAuditQueryOperation;
  readonly targetType: string;
  readonly targetId: string;
  readonly result: ManagementAuditResultValue;
  readonly detail: string | null;
  readonly createdAt: Date;
};

/** QueryService 输出：`detail` 已投影为白名单摘要，不含原值。 */
export type ManagementAuditEventReadModel = Omit<ManagementAuditEventQueryResult, 'detail'> & {
  readonly detail: ManagementAuditDetailView | null;
};

/** 对外列表项：去掉操作者账号 ID，补操作者昵称与公司名。 */
export type ManagementAuditEventView = Omit<
  ManagementAuditEventReadModel,
  'actorAccountId' | 'createdAt'
> & {
  readonly occurredAt: Date;
  readonly actorNickname: string;
  readonly organizationName: string | null;
};

/** 列表页输出。 */
export type ManagementAuditEventListPage = {
  readonly items: ManagementAuditEventView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
};

// src/core/repair-request/policy/repair-request-handling.policy.ts
// 工单处理结果 → 实际处理状态的固定映射与终结态判定。
// 这是领域策略而非稳定契约，故放在 core（types 层只保留枚举契约）。

import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';

/**
 * 五类结果 → 三态实际状态固定映射（唯一行为真源）。
 * 服务端写路径必须调用本映射，禁止调用方自报状态。
 */
export const REPAIR_REQUEST_HANDLING_STATUS_BY_RESULT: Readonly<
  Record<RepairRequestHandlingResult, RepairRequestHandlingStatus>
> = {
  [RepairRequestHandlingResult.FIXED]: RepairRequestHandlingStatus.COMPLETED,
  [RepairRequestHandlingResult.PART_PURCHASED]: RepairRequestHandlingStatus.COMPLETED,
  [RepairRequestHandlingResult.PROVIDE_PLAN_SELF_EXECUTE]: RepairRequestHandlingStatus.COMPLETED,
  [RepairRequestHandlingResult.INTERRUPTED]: RepairRequestHandlingStatus.IN_PROGRESS,
  [RepairRequestHandlingResult.UNREPAIRABLE]: RepairRequestHandlingStatus.UNRESOLVED,
};

export function resolveRepairRequestHandlingStatus(
  result: RepairRequestHandlingResult,
): RepairRequestHandlingStatus {
  return REPAIR_REQUEST_HANDLING_STATUS_BY_RESULT[result];
}

/** 终结态（完成/未完成）需要终结时间；处理中不得有终结时间 */
export function isTerminalHandlingStatus(status: RepairRequestHandlingStatus): boolean {
  return (
    status === RepairRequestHandlingStatus.COMPLETED ||
    status === RepairRequestHandlingStatus.UNRESOLVED
  );
}

// src/core/repair-request/policy/repair-process-write.policy.ts
// 内部维修过程/回复的只读边界判定（纯领域策略，不依赖数据库与框架）。

import {
  RepairRequestHandlingStatus,
  RepairRequestHandlingResult,
} from '@app-types/models/repair-request.types';

const CLOSED_CLOSURE_STATUS = 'CLOSED';

/** 工单是否已结束（结单或处理结果已终结）；结束后过程与回复只读 */
export function isRepairRequestEnded(facts: {
  handlingStatus: string | null;
  closureStatus: string | null;
}): boolean {
  return (
    facts.closureStatus === CLOSED_CLOSURE_STATUS ||
    facts.handlingStatus === RepairRequestHandlingStatus.COMPLETED ||
    facts.handlingStatus === RepairRequestHandlingStatus.UNRESOLVED
  );
}

/** 结单时要求填写原因的结果类型（中断/无法修复） */
export function requiresClosureReason(result: RepairRequestHandlingResult): boolean {
  return (
    result === RepairRequestHandlingResult.INTERRUPTED ||
    result === RepairRequestHandlingResult.UNREPAIRABLE
  );
}

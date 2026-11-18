// src/shared/ui/repair-request-status-labels.ts

/**
 * 维修工单结单/处理状态的公共展示文案。
 *
 * 工程师与管理员两个 feature 都需要展示同一组后端枚举，故收敛到 shared：
 * 不复制第二套中文全称，也不把枚举判定散落到各页面。
 * 值域与后端 R026 / repair-request-handling.policy.ts 保持一致。
 */

export type RepairHandlingResultValue =
  | 'FIXED'
  | 'PART_PURCHASED'
  | 'PROVIDE_PLAN_SELF_EXECUTE'
  | 'INTERRUPTED'
  | 'UNREPAIRABLE';

export type RepairHandlingStatusValue = 'IN_PROGRESS' | 'COMPLETED' | 'UNRESOLVED';

/** 五项结单处理结果中文全称（唯一文案真源） */
export const REPAIR_HANDLING_RESULT_LABELS: Record<RepairHandlingResultValue, string> = {
  FIXED: '故障修复',
  PART_PURCHASED: '购买新部件',
  PROVIDE_PLAN_SELF_EXECUTE: '提供维修方案由厂方自行执行',
  INTERRUPTED: '因厂方或其他原因中断维修',
  UNREPAIRABLE: '无法修复',
};

/** 三态实际处理状态中文文案 */
export const REPAIR_HANDLING_STATUS_LABELS: Record<RepairHandlingStatusValue, string> = {
  IN_PROGRESS: '处理中',
  COMPLETED: '已完成',
  UNRESOLVED: '未解决',
};

export const REPAIR_HANDLING_RESULT_OPTIONS = (
  Object.entries(REPAIR_HANDLING_RESULT_LABELS) as [RepairHandlingResultValue, string][]
).map(([value, label]) => ({ label, value }));

/** 结单事实只由 closureStatus 表达；处理状态终结不得推断为已结单 */
export function isRepairRequestClosed(closureStatus: string | null | undefined): boolean {
  return closureStatus === 'CLOSED';
}

/**
 * 结单状态三态判定（closureStatus + closedAt 联合判定）：
 * - CLOSED：closureStatus = CLOSED 且 closedAt 为有效的非空时间；
 * - OPEN：closureStatus = OPEN 且 closedAt 明确为 null，
 *   或 closureStatus 明确为 null 且 closedAt 明确为 null
 *   （当前数据库合法合同：创建时未写结单字段）；
 * - UNKNOWN：字段缺失、未知状态值、非法时间，或状态与时间矛盾；
 *   不得推断为已结单或未结单。
 *
 * 入参必须以「字段缺失 = undefined」与「字段存在且值为 null = null」区分，
 * adapter 不得用 `?? null` 合并二者后再传入。
 */
export type RepairClosureState = 'CLOSED' | 'OPEN' | 'UNKNOWN';

/** 有效结单时间：非空字符串且可解析为合法时间（ISO 字符串来自 GraphQL Date 标量） */
function isValidClosedAt(closedAt: string | null | undefined): boolean {
  if (typeof closedAt !== 'string') return false;
  const trimmed = closedAt.trim();
  if (trimmed === '') return false;
  return Number.isFinite(Date.parse(trimmed));
}

export function resolveRepairClosureState(
  closureStatus: string | null | undefined,
  closedAt: string | null | undefined,
): RepairClosureState {
  if (closureStatus === 'CLOSED') {
    return isValidClosedAt(closedAt) ? 'CLOSED' : 'UNKNOWN';
  }
  if (closureStatus === 'OPEN') {
    return closedAt === null ? 'OPEN' : 'UNKNOWN';
  }
  if (closureStatus === null) {
    return closedAt === null ? 'OPEN' : 'UNKNOWN';
  }
  // undefined（响应缺少字段）或未知状态值：不可确认，不得推断
  return 'UNKNOWN';
}

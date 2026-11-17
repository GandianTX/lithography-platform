// src/features/repair-request/application/repair-request-ended.ts

import type { EngineerRepairRequestDetail } from '../infrastructure/engineer-repair-request.types';

/**
 * 详情是否已按项目现有结束状态规则终结。
 *
 * 结单与处理终结共用同一只读边界：
 * - closureStatus === 'CLOSED'：已结单；
 * - handlingStatus === 'COMPLETED' / 'UNRESOLVED'：处理已终结。
 *
 * 面板只读判定与结单写后回读的“服务端已结束”确认共用本函数，
 * 避免两处规则漂移；本函数只读详情字段，不修改任何服务端事实。
 */
export function isEngineerRepairRequestEnded(
  detail: Pick<EngineerRepairRequestDetail, 'closureStatus' | 'handlingStatus'>,
): boolean {
  return (
    detail.closureStatus === 'CLOSED' ||
    detail.handlingStatus === 'COMPLETED' ||
    detail.handlingStatus === 'UNRESOLVED'
  );
}

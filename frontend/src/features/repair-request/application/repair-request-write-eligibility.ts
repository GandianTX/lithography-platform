// src/features/repair-request/application/repair-request-write-eligibility.ts

import type { EngineerRepairRequestDetail } from '../infrastructure/engineer-repair-request.types';

import { hasRepairRequestClosureSucceeded } from './repair-request-closure-barrier';
import { isEngineerRepairRequestEnded } from './repair-request-ended';

/**
 * 工程师详情写入口的统一资格判定（回复 / 上传 / 过程新增编辑 / 结单共用）。
 *
 * 只回答“此刻能否向后端发起写入”，不替代后端授权与状态检查：
 * - 必须是当前工单，且共享详情已实际采用该工单的快照（未就绪/加载失败/旧工单详情一律不写）；
 * - 详情未结束，且当前身份/会话没有“结单 mutation 已明确成功”的本地只读屏障；
 * - 各写操作自身的权限、编辑实例与提交条件仍由调用方继续判断。
 *
 * 调用方必须传入调用时刻读取到的当前上下文，不得复用旧 render 的闭包快照。
 */
export type RepairRequestWriteContext = {
  requestId: number | null;
  scopeKey: string;
  detail: EngineerRepairRequestDetail | null;
};

export function isRepairRequestWritableNow({
  requestId,
  scopeKey,
  detail,
}: RepairRequestWriteContext): boolean {
  if (requestId === null || detail === null || detail.id !== requestId) {
    return false;
  }

  if (isEngineerRepairRequestEnded(detail)) {
    return false;
  }

  return !hasRepairRequestClosureSucceeded(scopeKey, requestId);
}

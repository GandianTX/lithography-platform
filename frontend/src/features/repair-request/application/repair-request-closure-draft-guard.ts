// src/features/repair-request/application/repair-request-closure-draft-guard.ts

/**
 * 结单前的维修草稿门禁（任务 04 P2 回归）。
 *
 * - 结构化维修记录编辑器把「与上次成功读回记录不同」的草稿状态上报给详情面板，
 *   详情面板只做搬运，结单区按本模块的纯规则决定是否放行；
 * - 未保存变更：编辑器里的内容与上次成功读回的服务端记录不一致
 *   （含只改补充说明、含已上传但未绑定的暂存原件），只打开编辑器不算；
 * - 写入未落定：维修记录正在保存/上传，或已保存但最新版本尚未读回；
 *   此时即使草稿看起来与旧记录一致也不能结单，避免用旧版本号结单；
 * - 本模块不判断服务端版本冲突，乐观并发仍由后端与结单 mutation 负责。
 */

/** 维修记录草稿门禁状态（由维修记录分区计算，结单区消费） */
export type MaintenanceDraftGuardState = {
  /** 编辑器草稿与上次成功读回记录存在差异（含只改补充说明、含未绑定暂存原件） */
  hasUnsavedChanges: boolean;
  /** 正在保存/上传，或已保存但最新版本尚未读回 */
  writePending: boolean;
};

/** 空闲态：没有草稿差异，也没有在途写入；用于尚未上报/换工单时的失败关闭兜底 */
export const MAINTENANCE_DRAFT_GUARD_IDLE: MaintenanceDraftGuardState = {
  hasUnsavedChanges: false,
  writePending: false,
};

export type MaintenanceClosureBlockReason = 'write-pending' | 'unsaved-changes';

/**
 * 结单拦截原因；null 表示可以进入结单确认。
 * 写入未落定优先于草稿差异：保存中/待读回时提示先等待刷新，
 * 而不是让用户误以为再保存一次即可。
 */
export function resolveMaintenanceClosureBlockReason(
  state: MaintenanceDraftGuardState,
): MaintenanceClosureBlockReason | null {
  if (state.writePending) {
    return 'write-pending';
  }
  if (state.hasUnsavedChanges) {
    return 'unsaved-changes';
  }
  return null;
}

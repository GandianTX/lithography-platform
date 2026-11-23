// src/core/local-runtime/policy/local-restore-audit.policy.ts

/**
 * 恢复终态事件与**任务 10 读侧契约**的对齐口径（任务 09 新计划第 06 项）。
 *
 * ## 为什么需要这一层
 *
 * 任务 10 的"关键操作记录"页把 `management_audit_event.detail` 按**固定白名单**投影：
 * `reason`／`stage`／`changedFields`／`attemptNo`／`beforeOrganizationName`／`afterOrganizationName`。
 * 恢复事件此前把 `detail` 写成 `restore_id`／`backup_id`／`reason_code`／`counts`
 * 这些**不在白名单内**的键 ⇒ 读侧全部丢弃 ⇒ 恢复记录在任务 10 页面上**读不出原因与阶段**。
 *
 * 本策略让恢复事件**按任务 10 的白名单契约写入**：
 * - `reason` ← 受控原因码（如 `RESTORE_EXECUTION_FAILED`）；
 * - `stage` ← 恢复阶段标识（大写下划线，受读侧字符集约束）；
 * - 其余键（包 ID、计数等）**不写进 detail**：恢复 ID 已在事件列 `target_id`，
 *   公司在 `organization_id`，操作者在 `actor_account_id`／`actor_admin_level`。
 *
 * 安全：`detail` 里**不出现**包正文、原件字节、文件路径、密钥、堆栈或计数明细。
 */

import {
  serializeManagementAuditDetail,
  type ManagementAuditDetailView,
} from '@core/management-audit/policy/management-audit-detail.policy';

/**
 * 恢复终态阶段。
 *
 * 受任务 10 读侧 `stage` 的**字符集与长度**约束：`^[A-Z][A-Z0-9_]{0,31}$`
 * （最多 32 个字符）——超出会被读侧**截断**，读出来的阶段名就不完整了。
 */
export const LOCAL_RESTORE_AUDIT_STAGES = {
  /** 恢复执行到达终态（成功） */
  EXECUTION_SUCCEEDED: 'RESTORE_SUCCEEDED',
  /** 恢复执行失败，且已按保护副本回滚（本机保持恢复前状态） */
  EXECUTION_ROLLED_BACK: 'RESTORE_ROLLED_BACK',
  /** 恢复执行失败，且**回滚也失败**（保留保护副本、设备继续停写停传） */
  EXECUTION_ROLLBACK_FAILED: 'RESTORE_ROLLBACK_FAILED',
  /**
   * 恢复执行失败，数据**已按保护副本回滚**，但**冻结解除失败**
   * ⇒ 设备继续停写停传，需人工处置。
   *
   * 与 `EXECUTION_ROLLED_BACK` 的差别：数据侧一样（保持恢复前状态），
   * 但**停写停传没有解除**——这是必须单独留痕的事实
   * （否则运维会以为"回滚完就没事了"，实际设备仍被冻结）。
   */
  EXECUTION_HOLD_RETAINED: 'RESTORE_HOLD_RETAINED',
} as const;

export type LocalRestoreAuditStage =
  (typeof LOCAL_RESTORE_AUDIT_STAGES)[keyof typeof LOCAL_RESTORE_AUDIT_STAGES];

/**
 * 组装恢复终态事件的白名单摘要。
 *
 * @param result 真实终态（成功／失败）
 * @param stage 恢复阶段
 * @param reasonCode 受控原因码（失败时必填；成功时可不填）
 */
export function buildLocalRestoreAuditDetail(input: {
  result: 'SUCCEEDED' | 'FAILED';
  stage: LocalRestoreAuditStage;
  reasonCode?: string | null;
}): ManagementAuditDetailView {
  const reason =
    input.reasonCode === undefined || input.reasonCode === null || input.reasonCode === ''
      ? undefined
      : input.reasonCode;
  return reason === undefined ? { stage: input.stage } : { stage: input.stage, reason };
}

/** 把白名单摘要序列化为可入库的 `detail` 文本（与任务 10 读侧共用同一套规则）。 */
export function serializeLocalRestoreAuditDetail(
  input: Parameters<typeof buildLocalRestoreAuditDetail>[0],
): string | null {
  return serializeManagementAuditDetail(buildLocalRestoreAuditDetail(input));
}

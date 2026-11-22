// src/features/my-records/application/task-06-editor-entry.ts

/**
 * 任务 06（维修报告录入）编辑器的唯一对接点。
 *
 * 任务 06 已合入主线（PR #28）：草稿续填按记录来源指向真实路由——
 * - 独立历史记录（HISTORICAL_CASE）草稿：`/engineer/maintenance-records/:reportId`
 *   （任务 06 报告编辑器，路由参数为报告 id）；
 * - 工单总结（WORK_ORDER_SUMMARY）草稿：`/engineer/work-order-summaries/:repairRequestId`
 *   （任务 06 只读核对页，路由参数为来源工单 id，核对后正式提交；内容不可编辑）。
 * 页面与测试不感知路由细节，避免第二处硬编码。
 *
 * 权限说明（纵深防御，不替代后端授权）：
 * - 列表/详情只返回本人记录（后端作者 [+ 本组织] 谓词），他人草稿不出现在本页；
 * - activeRole 非 ENGINEER（管理员/客户）时入口不可用——任务 06 写入口仅工程师，
 *   管理员不能借任务 07 新建报告、续填他人草稿或绕过任务 06 的后端授权；
 * - 详情侧另以后端 canEdit（草稿/退回态）作为第二道展示条件；
 * - 任务 09 同步适配层未接入：本对接点不提供任何「已同步」展示或冲突处理入口。
 */
export const TASK_06_EDITOR_INTEGRATION_STATUS = 'READY' as const;

export type Task06EditorEntrySourceType = 'HISTORICAL_CASE' | 'WORK_ORDER_SUMMARY';

export type Task06EditorEntryRequest = {
  reportId: number;
  sourceType: Task06EditorEntrySourceType;
  /** 工单总结草稿的真实路由参数（来源工单 id）；独立历史记录不需要 */
  repairRequestId?: number | null;
  /** 当前登录角色快照；未提供时仅按记录字段判定（调用方应传真实角色） */
  activeRole?: string;
};

export type Task06EditorIntegration = {
  available: boolean;
  /** 不可用原因键：由页面按当前语言翻译 */
  reasonKey: 'workOrderMissing' | null;
  path: string | null;
};

/** 独立历史记录草稿续填：任务 06 报告编辑器真实路由（单一真源） */
export function buildTask06HistoricalEditorPath(reportId: number): string {
  return `/engineer/maintenance-records/${reportId}`;
}

/** 工程师新建独立历史记录：任务 06 新建页真实路由（单一真源） */
export function buildTask06HistoricalNewPath(): string {
  return '/engineer/maintenance-records/new';
}

/** 工单总结核对入口：任务 06 只读核对页真实路由（参数为来源工单 id） */
export function buildTask06WorkOrderSummaryPath(repairRequestId: number): string {
  return `/engineer/work-order-summaries/${repairRequestId}`;
}

/** 草稿续填入口：按来源类型解析任务 06 真实路径，管理员与数据不完整时明确不可用 */
export function resolveTask06DraftEditorEntry(
  request: Task06EditorEntryRequest,
): Task06EditorIntegration {
  const { reportId, sourceType, repairRequestId, activeRole } = request;

  if (!Number.isInteger(reportId) || reportId <= 0) {
    return { available: false, reasonKey: null, path: null };
  }
  if (activeRole !== undefined && activeRole !== 'ENGINEER') {
    // 管理员/客户不可续填（任务 06 写入口仅工程师；前端隐藏不替代后端判断）
    return { available: false, reasonKey: null, path: null };
  }
  if (sourceType === 'WORK_ORDER_SUMMARY') {
    const repairRequestIdValue = repairRequestId ?? Number.NaN;
    if (!Number.isInteger(repairRequestIdValue) || repairRequestIdValue <= 0) {
      // 工单总结路由参数是来源工单 id；缺失时不可用（不硬凑、不落到报告 id）
      return { available: false, reasonKey: 'workOrderMissing', path: null };
    }
    return {
      available: true,
      reasonKey: null,
      path: buildTask06WorkOrderSummaryPath(repairRequestIdValue),
    };
  }
  return { available: true, reasonKey: null, path: buildTask06HistoricalEditorPath(reportId) };
}

/**
 * 新建独立历史记录入口（工程师专属）：指向任务 06 新建页真实路由
 * `/engineer/maintenance-records/new`。
 *
 * 仅显式 ENGINEER 角色可用（角色未知/加载中不显示，避免管理员会话快照
 * 未就绪时闪现入口）；管理员（一级/二级）与客户恒不可用——「我的资料记录」
 * 页面不为管理员提供新建历史记录或工单维修总结的入口（2026-11-21 页面
 * 设计确认）；后端写入口同样仅工程师（assertMaintenanceReportAuthorRole），
 * 前端隐藏不替代后端判断。工单总结无新建入口：只能从已结单工单进入只读
 * 核对页派生（服务端事实来源），不存在页面级新建。
 */
export function resolveTask06CreateEntry(activeRole?: string): Task06EditorIntegration {
  if (activeRole !== 'ENGINEER') {
    return { available: false, reasonKey: null, path: null };
  }
  return { available: true, reasonKey: null, path: buildTask06HistoricalNewPath() };
}

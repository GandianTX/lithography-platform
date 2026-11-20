// src/usecases/common/ports/ai-conversation-execution.contract.ts
// 任务05 F04：当前有效执行判定所需的窄端口。
//
// 背景：同一问题 UUID 在重试后会启动新的工作流执行；UUID 只保证问题幂等，
// 不能区分「哪次执行」。通用工作流上下文表已按业务目标（biz_type／biz_sub_key）
// 记录每次执行，因此由数据 owner 模块提供一个只读查询，避免 05 直接读取该表。
//
// F04 修订：判定依据从「最近创建的 workflow」改为「当前活动执行」。
// 活动去重唯一键保证同一（workflowType，去重键）最多一条未终态记录，
// 所以无需按 createdAt 排序推断代次；旧执行终态后不再占用活动位。
//
// 直接调用方：`AiConversationReplyWorkflowHandler`（模型调用前与写回事务内各校验一次）。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

export const AI_CONVERSATION_EXECUTION_LOOKUP = Symbol('AI_CONVERSATION_EXECUTION_LOOKUP');

/** 当前活动执行的只读身份（不含负载内容） */
export interface AiConversationActiveExecution {
  readonly workflowId: string;
  readonly status: string;
  readonly jobId: string | null;
  /** 待准入到期投递时间（非待准入状态为 null） */
  readonly nextEnqueueAt: Date | null;
  /** 准入截止时间；过期即不再自动投递，需由消费方收敛为可重试失败 */
  readonly admissionExpiresAt: Date | null;
}

/**
 * 某业务目标最近一次执行（含终态）。
 *
 * 用于「执行已失败但业务侧状态还没收敛」的判定：活动执行读不到时，
 * 仍要能区分「从没有执行」与「执行失败/取消」。
 */
export type AiConversationLatestExecution = AiConversationActiveExecution;

/**
 * 已进入终态的执行摘要（只读，用于业务侧状态收敛）。
 *
 * 背景：状态查询必须保持只读，而「执行已终止但 analysis 仍 PENDING」的收敛
 * 需要由正式运行入口（Worker 生命周期）扫描完成，因此端口提供按时间窗口的
 * 终态执行清单，而不是让读路径逐条查。
 */
export interface AiConversationTerminatedExecution {
  readonly workflowId: string;
  /** 业务子键（05 场景为 questionUuid）；表中允许为空，查询侧已过滤 */
  readonly bizSubKey: string;
  readonly status: string;
  readonly updatedAt: Date;
}

export interface AiConversationExecutionLookupPort {
  /**
   * 该业务目标当前的活动执行。
   *
   * - 只返回未终态记录；同一目标最多一条，因此不按创建时间推断；
   * - `forUpdate` 用于写回事务内的当前读，避免以 MVCC 旧快照宣称没有 TOCTOU；
   * - 读取失败按「无法证明当前执行」由调用方失败关闭。
   *
   * @returns 无活动执行时返回 null
   */
  findActiveExecutionByBizTarget(input: {
    readonly workflowType: string;
    readonly bizType: string;
    readonly bizSubKey: string;
    readonly transactionContext?: PersistenceTransactionContext;
    readonly forUpdate?: boolean;
  }): Promise<AiConversationActiveExecution | null>;

  /**
   * 该业务目标最近创建的一次执行（不区分状态）。
   *
   * @returns 从未创建过执行时返回 null
   */
  findLatestExecutionByBizTarget(input: {
    readonly workflowType: string;
    readonly bizType: string;
    readonly bizSubKey: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiConversationLatestExecution | null>;

  /**
   * 在指定时刻之后进入终态的执行（按 `updatedAt` 升序，带批量上限）。
   *
   * 供 Worker 侧恢复扫描使用：扫描窗口内的终态执行，把仍未收敛的 analysis
   * 补写为可重试失败。写入本身由业务侧的「仅 PENDING 生效」条件更新兜底，
   * 因此重复扫描不会覆盖已成功轮次。
   */
  listTerminalExecutionsSince(input: {
    readonly workflowType: string;
    readonly updatedSince: Date;
    readonly limit: number;
  }): Promise<readonly AiConversationTerminatedExecution[]>;
}

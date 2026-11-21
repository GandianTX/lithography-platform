// src/usecases/common/ports/local-conflict-resolution.contract.ts

import type { SyncConflictSummary } from '@src/modules/lithography/sync.types';

/**
 * 「保留本地」冲突裁决的跨域结果契约（任务 09 R-03）。
 *
 * 为什么放在 `usecases/common`：保留本地裁决的编排落在**管理员文档库域**
 * （该域拥有工单受控修订入口与管理员授权口径），而读侧与"使用云端/稍后处理"
 * 落在**本地运行域**；两个域都要向 GraphQL 层交出同一种结果形状，
 * 共享契约放在 common 才能既不跨域依赖、又不复制一份类型。
 *
 * 结果一律只带冲突**摘要**（不含本地/云端两份正文快照）：
 * 裁决是一次写动作，返回体没有必要再带正文与原件引用。
 */
export type LocalConflictResolutionOutcome = {
  /** resolved＝本次写入；existing＝重复请求或并发已裁决，返回既有事实 */
  outcome: 'resolved' | 'existing';
  conflict: SyncConflictSummary | null;
};

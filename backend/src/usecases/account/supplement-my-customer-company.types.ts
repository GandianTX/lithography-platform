// src/usecases/account/supplement-my-customer-company.types.ts

import type { SessionRestriction } from '@app-types/auth/session-restriction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { MyAccountSettingsView } from '@src/modules/account/account.types';

/**
 * 缺归属客户补录（任务 02.4）的执行契约。
 *
 * 依 `type.rules.md`：执行输入/结果留在相邻 `*.types.ts`（只有类型、无运行时值），
 * adapter 只能 type-only 导入，不得从实现文件借类型。
 */

/** 补录公司分支：选择受管候选，或手填自家公司名称；严格二选一 */
export type CustomerCompanySupplementChoice =
  | { readonly kind: 'EXISTING'; readonly organizationId: number }
  | { readonly kind: 'SELF_FILLED'; readonly organizationName: string };

/**
 * 补录命令：**只有 Session，没有任何目标账号 ID 参数**。
 *
 * 目标账号只能来自已认证 Session；`restriction` 是请求期复核后的会话限制状态，
 * 非 `NONE` 时整体拒绝（受限会话的公司归属由注册审核链路决定）。
 * 两个字段保持 `unknown` 形态，合法性全部由 Usecase 的 normalize 裁决。
 */
export interface SupplementMyCustomerCompanyCommand {
  readonly session: UsecaseSession;
  readonly restriction: SessionRestriction;
  readonly organizationId: unknown;
  readonly organizationName: unknown;
}

/**
 * 补录结果：`isUpdated` 表达本次是否有落库（已归属且选择同一候选时幂等返回 false），
 * `settings` 是写入后的稳定公开读视图，`sameNamedCompanyName` 是手填名与既有受管公司
 * 精确同名时回带的提示（不自动合并，仅提示用户）。
 */
export interface SupplementMyCustomerCompanyOutcome {
  readonly isUpdated: boolean;
  readonly settings: MyAccountSettingsView;
  readonly sameNamedCompanyName: string | null;
}

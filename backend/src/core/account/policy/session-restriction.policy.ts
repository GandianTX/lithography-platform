// src/core/account/policy/session-restriction.policy.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';

/**
 * 受限会话判定所需的数据库事实（按来源列分组，调用方直接传入原始值）。
 *
 * - `mustChangePassword`：`base_user_account.must_change_password`；
 * - `identityHint`：`base_user_account.identity_hint`（可能为 `null` / 非法历史值）；
 * - `accountStatus` / `userState`：双状态字段（`null` 表示账号或资料行缺失）；
 * - `latestEngineerApplicationStatus`：账号最新一份工程师申请状态，无申请记录时为 `null`。
 */
export interface SessionRestrictionFacts {
  readonly mustChangePassword: boolean;
  readonly identityHint: string | null;
  readonly accountStatus: AccountStatus | null;
  readonly userState: UserState | null;
  readonly latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus | null;
}

/**
 * 计算会话限制状态。
 *
 * 判定顺序（优先级从高到低）：
 * 1. 必须改密——管理员显式要求，任何其他状态都不得覆盖；
 * 2. 最新工程师申请为 `PENDING` → `ENGINEER_PENDING`；
 * 3. 最新工程师申请为 `REJECTED` → `ENGINEER_REJECTED`；
 * 4. 无申请记录时回落到状态事实：`identity_hint=ENGINEER` 且账号或资料为 `PENDING`
 *    → `ENGINEER_PENDING`（覆盖历史待审账号在申请表中无记录的情况）；
 * 5. 其余（含申请已 `APPROVED`）→ `NONE`。
 *
 * 第 2/3 步以申请状态为准、先于第 4 步：待审与拒绝工程师的账号/资料可能同时为
 * `PENDING`，若先按状态回落会把「已拒绝」误判为「待审」。
 *
 * 本函数是纯函数：确定性、无 I/O、无 DI、无 ORM、无日志、不修改入参。
 */
export function resolveSessionRestriction(facts: SessionRestrictionFacts): SessionRestriction {
  if (facts.mustChangePassword) {
    return SessionRestriction.MUST_CHANGE_PASSWORD;
  }

  const applicationStatus = facts.latestEngineerApplicationStatus;
  if (applicationStatus === EngineerRegistrationApplicationStatus.PENDING) {
    return SessionRestriction.ENGINEER_PENDING;
  }
  if (applicationStatus === EngineerRegistrationApplicationStatus.REJECTED) {
    return SessionRestriction.ENGINEER_REJECTED;
  }

  if (
    facts.identityHint === IdentityTypeEnum.ENGINEER &&
    (facts.accountStatus === AccountStatus.PENDING || facts.userState === UserState.PENDING)
  ) {
    return SessionRestriction.ENGINEER_PENDING;
  }

  return SessionRestriction.NONE;
}

/**
 * 会话状态门禁的公共事实。
 *
 * `allowRestrictedSession` 表达调用场景是否允许受限会话通过状态门禁：
 * - 登录入口取请求参数（Web 端传 `true`，旧调用方默认 `false`）；
 * - 每一次受保护请求由 `ValidateAccessTokenSessionUsecase` 复核，固定为 `true`，
 *   业务入口的限制由守卫继续拦截。
 */
export interface SessionStatusGateFacts {
  readonly restriction: SessionRestriction;
  readonly allowRestrictedSession: boolean;
}

/**
 * 账号状态门禁：`ACTIVE` 放行；`PENDING` 仅在「存在明确限制且允许受限会话」时放行。
 *
 * 登录与每请求复核共用本判定，避免两处各自手写 ACTIVE/PENDING 分支而漂移；
 * 封禁 / 删除 / 暂停 / 缺失等其余状态一律失败关闭。
 */
export function isAccountStatusAllowedForSession(
  facts: SessionStatusGateFacts & { readonly accountStatus: AccountStatus | null },
): boolean {
  if (!isRestrictedSessionPermitted(facts)) {
    return false;
  }

  const allowPendingStatus = resolveAllowPendingStatus(facts);
  return (
    facts.accountStatus === AccountStatus.ACTIVE ||
    (facts.accountStatus === AccountStatus.PENDING && allowPendingStatus)
  );
}

/**
 * 资料状态门禁：口径与 {@link isAccountStatusAllowedForSession} 一致，作用于
 * `base_user_info.user_state`。每请求复核需分别定位是账号还是资料未通过，故拆成两个纯函数。
 */
export function isUserStateAllowedForSession(
  facts: SessionStatusGateFacts & { readonly userState: UserState | null },
): boolean {
  if (!isRestrictedSessionPermitted(facts)) {
    return false;
  }

  const allowPendingStatus = resolveAllowPendingStatus(facts);
  return (
    facts.userState === UserState.ACTIVE ||
    (facts.userState === UserState.PENDING && allowPendingStatus)
  );
}

/** 存在限制时，调用方必须显式允许受限会话；否则任何状态都不通过 */
function isRestrictedSessionPermitted(facts: SessionStatusGateFacts): boolean {
  return facts.restriction === SessionRestriction.NONE || facts.allowRestrictedSession;
}

/** 只有「限制非 NONE 且调用方允许受限会话」时，PENDING 才可通过状态门禁 */
function resolveAllowPendingStatus(facts: SessionStatusGateFacts): boolean {
  return facts.allowRestrictedSession && facts.restriction !== SessionRestriction.NONE;
}

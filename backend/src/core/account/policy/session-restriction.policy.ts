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
 * - `latestEngineerApplicationStatus`：账号最新一份工程师申请状态，无申请记录时为 `null`；
 * - `latestEngineerApplicationOrganizationId`：最新申请的目标公司，无申请记录时为 `null`；
 * - `effectiveEngineerOrganizationIds`：账号持有有效 `ENGINEER` 成员关系的组织集合
 *   （成员 ACTIVE 且组织 ACTIVE，由 `OrganizationMembershipQueryService` 过滤后传入）；
 * - `adminLevel`：账号管理员等级（`base_user_account.admin_level`，非管理员为 `null`）；
 * - `effectiveAdminOrganizationIds`：账号持有有效 `SUPER_ADMIN` 成员关系的组织集合
 *   （成员 ACTIVE 且组织 ACTIVE，同一查询服务过滤后传入）。
 */
export interface SessionRestrictionFacts {
  readonly mustChangePassword: boolean;
  readonly identityHint: string | null;
  readonly accountStatus: AccountStatus | null;
  readonly userState: UserState | null;
  readonly latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus | null;
  readonly latestEngineerApplicationOrganizationId: number | null;
  readonly effectiveEngineerOrganizationIds: readonly number[];
  readonly adminLevel: number | null;
  readonly effectiveAdminOrganizationIds: readonly number[];
}

/**
 * 计算会话限制状态。
 *
 * 判定顺序（优先级从高到低）：
 * 1. 必须改密——管理员显式要求，任何其他状态都不得覆盖；
 * 2. 最新工程师申请为 `PENDING` → `ENGINEER_PENDING`；
 * 3. 最新工程师申请为 `REJECTED` → `ENGINEER_REJECTED`；
 * 4. 最新工程师申请为 `APPROVED` 但资格未生效 → `ENGINEER_INACTIVE`。资格生效要求
 *    账号与资料同时 `ACTIVE`，且申请目标组织在有效 `ENGINEER` 成员组织集合内
 *    （组织停用、成员缺失、成员角色不符、目标组织不一致都视为未生效）；
 * 5. 无申请记录时回落到状态事实：`identity_hint=ENGINEER` 且账号或资料为 `PENDING`
 *    → `ENGINEER_PENDING`（覆盖历史待审账号在申请表中无记录的情况）；
 * 6. `admin_level=2` 且没有**恰好一条**有效 `SUPER_ADMIN` 成员组织（组织 ACTIVE、成员
 *    ACTIVE）→ `ADMIN_ORGANIZATION_INACTIVE`：公司停用、成员缺失、角色不符或多公司歧义
 *    都视为二级管理员失去可信公司，一切管理业务失败关闭；
 * 7. 其余（含申请已 `APPROVED` 且资格生效、无申请记录的存量工程师）→ `NONE`。
 *
 * 第 6 步位于工程师判定之后：待审 / 已拒绝 / 资格未生效本身已是受限会话，先按更具体的
 * 原因展示；必须改密仍最高优先。`admin_level=1` 是平台级身份，不因缺少成员组织受限。
 *
 * 第 2/3 步以申请状态为准、先于第 5 步：待审与拒绝工程师的账号/资料可能同时为
 * `PENDING`，若先按状态回落会把「已拒绝」误判为「待审」。
 *
 * 存量规则：没有任何工程师申请记录的历史工程师账号不追加成员事实要求，继续沿用
 * 「双状态 ACTIVE 即 `NONE`」的既有准入口径，避免批量阻断旧数据。
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
    applicationStatus === EngineerRegistrationApplicationStatus.APPROVED &&
    facts.identityHint === IdentityTypeEnum.ENGINEER &&
    !isEngineerQualificationEffective(facts)
  ) {
    return SessionRestriction.ENGINEER_INACTIVE;
  }

  if (
    facts.identityHint === IdentityTypeEnum.ENGINEER &&
    (facts.accountStatus === AccountStatus.PENDING || facts.userState === UserState.PENDING)
  ) {
    return SessionRestriction.ENGINEER_PENDING;
  }

  // 二级管理员的可信公司是全部管理业务的作用域来源：唯一有效 SUPER_ADMIN 成员组织缺失、
  // 公司停用（查询服务已过滤）、角色不符或多公司歧义时不得回到普通会话。
  // 一级管理员是平台级身份，不走本规则。
  if (facts.adminLevel === 2 && facts.effectiveAdminOrganizationIds.length !== 1) {
    return SessionRestriction.ADMIN_ORGANIZATION_INACTIVE;
  }

  return SessionRestriction.NONE;
}

/**
 * 已批准申请是否已具备可开通资格：
 * 双状态同时 ACTIVE，且账号恰有一个有效 `ENGINEER` 成员组织，并且该组织就是申请目标组织。
 * 多组织成员关系视为歧义（无法确定可信组织），与「无成员 / 组织停用 / 角色不符」同样未生效。
 */
function isEngineerQualificationEffective(facts: SessionRestrictionFacts): boolean {
  if (facts.accountStatus !== AccountStatus.ACTIVE || facts.userState !== UserState.ACTIVE) {
    return false;
  }
  const applicationOrganizationId = facts.latestEngineerApplicationOrganizationId;
  return (
    applicationOrganizationId !== null &&
    facts.effectiveEngineerOrganizationIds.length === 1 &&
    facts.effectiveEngineerOrganizationIds[0] === applicationOrganizationId
  );
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
 * 双状态组合门禁的拒绝原因。
 *
 * 仅用于调用方日志分类（区分受限开关、缺行、单边状态不一致与禁用状态），
 * 不进入任何 GraphQL 错误契约：密码登录统一映射 `ACCOUNT_INACTIVE`，
 * 每请求复核统一抛 `JWT_ERROR.AUTHENTICATION_FAILED`。
 */
export type SessionStatusRejectionReason =
  | 'RESTRICTED_SESSION_NOT_ALLOWED'
  | 'ACCOUNT_STATUS_MISSING'
  | 'USER_STATE_MISSING'
  | 'STATUS_COMBINATION_MISMATCH'
  | 'STATUS_NOT_ALLOWED';

export type SessionStatusCombinationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly rejection: SessionStatusRejectionReason };

/**
 * 账号状态与资料状态的组合门禁。
 *
 * 允许的只有两种组合：
 * - `ACTIVE` / `ACTIVE`：正常会话，前提仍满足既有受限会话开关
 *   （存在限制时必须由入口显式允许受限会话）；
 * - `PENDING` / `PENDING`：仅在「存在明确限制且入口显式允许受限会话」时放行。
 *
 * 其余组合一律失败关闭：任意一侧为 PENDING 而另一侧不是（单边状态不一致）、
 * 两侧 PENDING 但不存在限制或未允许受限会话、缺行，以及封禁 / 删除 / 暂停等禁用状态。
 * 首次改密优先级与既有禁用条件由 {@link resolveSessionRestriction} 与状态枚举继续保证。
 *
 * 登录与每请求复核共用本判定，避免两处各自手写 ACTIVE/PENDING 分支后重新出现
 * 「单边 PENDING 也能通过」的口径漂移。
 */
export function evaluateSessionStatusCombination(
  facts: SessionStatusGateFacts & {
    readonly accountStatus: AccountStatus | null;
    readonly userState: UserState | null;
  },
): SessionStatusCombinationDecision {
  if (!isRestrictedSessionPermitted(facts)) {
    return { allowed: false, rejection: 'RESTRICTED_SESSION_NOT_ALLOWED' };
  }

  const { accountStatus, userState } = facts;
  if (accountStatus === null) {
    return { allowed: false, rejection: 'ACCOUNT_STATUS_MISSING' };
  }
  if (userState === null) {
    return { allowed: false, rejection: 'USER_STATE_MISSING' };
  }

  if (accountStatus === AccountStatus.ACTIVE && userState === UserState.ACTIVE) {
    return { allowed: true };
  }

  if (
    resolveAllowPendingStatus(facts) &&
    accountStatus === AccountStatus.PENDING &&
    userState === UserState.PENDING
  ) {
    return { allowed: true };
  }

  // 仅一侧为 PENDING：账号与资料对同一会话给出相反结论，按不一致拒绝。
  if ((accountStatus === AccountStatus.PENDING) !== (userState === UserState.PENDING)) {
    return { allowed: false, rejection: 'STATUS_COMBINATION_MISMATCH' };
  }

  return { allowed: false, rejection: 'STATUS_NOT_ALLOWED' };
}

/** 存在限制时，调用方必须显式允许受限会话；否则任何状态都不通过 */
function isRestrictedSessionPermitted(facts: SessionStatusGateFacts): boolean {
  return facts.restriction === SessionRestriction.NONE || facts.allowRestrictedSession;
}

/** 只有「限制非 NONE 且调用方允许受限会话」时，PENDING 才可通过状态门禁 */
function resolveAllowPendingStatus(facts: SessionStatusGateFacts): boolean {
  return facts.allowRestrictedSession && facts.restriction !== SessionRestriction.NONE;
}

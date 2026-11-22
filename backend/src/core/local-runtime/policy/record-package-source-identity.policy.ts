// src/core/local-runtime/policy/record-package-source-identity.policy.ts

import { AccountStatus } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';

/**
 * 记录包导入的**来源身份本机可信裁决**（任务 09 S3 补丁 P4）。
 *
 * 为什么需要这一层：
 * - 包清单里的 `source_account_id` 是**包内自报**的事实。导入写入方据此落
 *   「原作者／责任工程师」列，因此它必须先在本机被可信事实核验，
 *   否则等于允许任意包冒用他人身份写业务；
 * - 只靠数据库外键兜底**不是授权**：外键只能证明「该账号行存在」，
 *   证明不了「该账号仍启用」「仍属于本公司」「导入者对它有当前权限」；
 * - 口径只有这一份（纯函数），编排侧与来源域写入侧共用，避免两套判定漂移。
 *
 * 需求依据：
 * - V5.6 R072-01「工程师只能导入本公司当前有权记录」、操作流程「复核包版本与**当前权限**」；
 * - V6.5 §11.3「确认导入：仅对检查合格范围执行，仍复核**当前权限**与删除下架事实」；
 * - V6.5 §9.2 / R052（任务 07 页面口径）「工程师只展示**本人创建且本人有权访问**的记录」；
 * - 任务书「工程师和二级管理员按本机本公司访问有权元数据与包，一级按当前授权范围」。
 *
 * 判定顺序（任一不满足即拒绝，并给出可读原因；**不静默改归属、不冒用导入人**）：
 * 1. 包内未携带来源账号 → 拒绝（不得以导入人冒充原作者）；
 * 2. 包内归属公司与导入目标公司不一致 → 拒绝；
 * 3. 来源账号在本机不存在 → 拒绝；
 * 4. 来源账号已停用（`account_status` 非 ACTIVE）→ 拒绝；
 * 5. 来源账号资料缺失或已停用（`user_state` 非 ACTIVE）→ 拒绝；
 * 6. 来源账号不是目标公司的在职成员（归属变更／已离开／组织停用）→ 拒绝；
 * 7. 导入者对该来源账号没有当前权限 → 拒绝：
 *    - 本人导入本人同公司记录 → 允许；
 *    - 二级管理员按本公司范围 → 允许（任务书「二级管理员按本机本公司访问有权元数据与包」）；
 *    - 其余（工程师导入同公司他人记录、一级管理员）→ 拒绝。
 *
 * 本函数是纯函数：确定性、无 I/O、无 DI、无 ORM、无日志、不修改入参。
 */

/** 来源账号的成员关系事实（`organization_membership` ＋ `organization` 当前状态） */
export type RecordPackageSourceMembershipFact = {
  readonly organizationId: number;
  /** 成员关系状态：`ACTIVE`=在职，`LEFT`=已退出 */
  readonly membershipStatus: string;
  /** 组织状态：`ACTIVE`=启用，`DISABLED`=停用 */
  readonly organizationStatus: string;
};

/** 裁决所需的本机可信事实（调用方按本机数据库当前事实组装） */
export type RecordPackageSourceIdentityFacts = {
  /** 包内登记的来源账号；`null` = 包内未携带来源身份 */
  readonly sourceAccountId: number | null;
  /** 来源账号在本机的账号状态；`null` = 本机不存在该账号 */
  readonly accountStatus: AccountStatus | null;
  /** 来源账号在本机的资料状态；`null` = 本机没有该账号的资料 */
  readonly userState: UserState | null;
  /** 来源账号在本机的全部成员关系（含已退出、停用组织上的关系） */
  readonly memberships: readonly RecordPackageSourceMembershipFact[];
  /** 包内登记的来源归属公司；`null` = 包内未登记 */
  readonly ownerOrganizationId: number | null;
  /** 导入目标公司（导入者可信公司数据区） */
  readonly targetOrganizationId: number;
  /** 执行导入的账号 */
  readonly importerAccountId: number;
  /** 执行导入账号的管理员等级（账号当前事实）；`null` = 非管理员 */
  readonly importerAdminLevel: number | null;
};

/** 裁决结论（放行时带回**已核验**的来源账号 id，调用方不再自行使用包内原值） */
export type RecordPackageSourceIdentityDecision =
  | { readonly allowed: true; readonly sourceAccountId: number }
  | { readonly allowed: false; readonly reason: string };

/**
 * 来源账号在本机目标公司内是否有**在职**成员关系。
 *
 * 区分三种不可信情形：
 * - 没有任何该公司的成员关系 → 归属变更（换公司）或从未归属本公司；
 * - 成员关系已 `LEFT` → 已离开本公司；
 * - 成员关系在职但组织已停用 → 本公司已停用。
 */
function resolveTargetMembership(
  facts: RecordPackageSourceIdentityFacts,
): { kind: 'ACTIVE' } | { kind: 'LEFT' } | { kind: 'ORGANIZATION_DISABLED' } | { kind: 'NONE' } {
  const membership = facts.memberships.find(
    (candidate) => candidate.organizationId === facts.targetOrganizationId,
  );
  if (membership === undefined) {
    return { kind: 'NONE' };
  }
  if (membership.membershipStatus !== 'ACTIVE') {
    return { kind: 'LEFT' };
  }
  if (membership.organizationStatus !== 'ACTIVE') {
    return { kind: 'ORGANIZATION_DISABLED' };
  }
  return { kind: 'ACTIVE' };
}

/**
 * 裁决导入者对来源账号记录的当前权限。
 *
 * 口径（与本文件头部需求依据一致）：
 * - 本人导入本人记录 → 允许；
 * - 二级管理员（`admin_level=2`）按本公司范围 → 允许；
 * - 一级管理员（`admin_level=1`）是平台级角色、没有业务所属公司 → 拒绝；
 * - 工程师导入同公司**他人**的记录 → 拒绝（R072「工程师只能导入本公司当前有权记录」；
 *   任务 07 的读者口径也是「本人创建且本人有权访问」，他人正式资料走参考资料库与
 *   管理员文档数据库，不在本导入通道内）。
 */
function evaluateImporterAuthority(
  facts: RecordPackageSourceIdentityFacts,
): RecordPackageSourceIdentityDecision {
  if (facts.sourceAccountId !== null && facts.importerAccountId === facts.sourceAccountId) {
    return { allowed: true, sourceAccountId: facts.sourceAccountId };
  }
  if (facts.importerAdminLevel === 2 && facts.sourceAccountId !== null) {
    return { allowed: true, sourceAccountId: facts.sourceAccountId };
  }
  if (facts.importerAdminLevel === 1) {
    return {
      allowed: false,
      reason: '一级管理员没有业务所属公司，不能按公司范围接收他人记录，该条未导入',
    };
  }
  return {
    allowed: false,
    reason: '工程师只能导入本公司当前有权记录（包内来源账号为同公司他人），该条未导入',
  };
}

/**
 * 裁决包内来源身份是否可以作为本次导入的作者事实。
 *
 * 纯函数：所有判定输入由调用方按**本机数据库当前事实**组装；
 * 包内自报身份只作为「待核验的账号 id」进入，不作为授权真源。
 */
export function evaluateRecordPackageSourceIdentity(
  facts: RecordPackageSourceIdentityFacts,
): RecordPackageSourceIdentityDecision {
  if (facts.sourceAccountId === null) {
    return {
      allowed: false,
      reason: '包内未携带来源账号，原作者不可核验（不以导入人冒充原作者），该条未导入',
    };
  }
  if (
    facts.ownerOrganizationId !== null &&
    facts.ownerOrganizationId !== facts.targetOrganizationId
  ) {
    return {
      allowed: false,
      reason: '包内归属公司与导入目标公司不一致，该条未导入',
    };
  }
  if (facts.accountStatus === null) {
    return {
      allowed: false,
      reason: '包内来源账号在本机不存在，原作者不可核验，该条未导入',
    };
  }
  if (facts.accountStatus !== AccountStatus.ACTIVE) {
    return {
      allowed: false,
      reason: `包内来源账号已停用（${facts.accountStatus}），该条未导入`,
    };
  }
  if (facts.userState === null) {
    return {
      allowed: false,
      reason: '包内来源账号在本机没有资料记录，原作者不可核验，该条未导入',
    };
  }
  if (facts.userState !== UserState.ACTIVE) {
    return {
      allowed: false,
      reason: `包内来源账号的资料已停用（${facts.userState}），该条未导入`,
    };
  }

  const membership = resolveTargetMembership(facts);
  if (membership.kind === 'NONE') {
    return {
      allowed: false,
      reason: '包内来源账号不是本公司的在职成员（归属已变更或从未归属本公司），该条未导入',
    };
  }
  if (membership.kind === 'LEFT') {
    return {
      allowed: false,
      reason: '包内来源账号已离开本公司，该条未导入',
    };
  }
  if (membership.kind === 'ORGANIZATION_DISABLED') {
    return {
      allowed: false,
      reason: '本公司已停用，该条未导入',
    };
  }

  return evaluateImporterAuthority(facts);
}

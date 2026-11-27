// src/core/local-runtime/policy/record-package-portable-identity.policy.ts

/**
 * 记录包来源账号的**跨端可移植身份**裁决（任务 09 S1-2）。
 *
 * 要解决的问题：
 * - 记录包在**跨设备**搬运时，包内 `source_account_id` 是**源机自增主键**；
 *   目标机上「id=7」完全可能是**另一个人**（两台设备各自建号是常态）。
 *   按数字 id 选作者 ⇒ **错归属**：源机工程师的正式报告被记到目标机
 *   另一个工程师名下。
 * - 因此"跨端身份"必须**真实产生、持久、可查找**，且在目标机可核验。
 *
 * 本仓提供的两个跨端标识（都是既有持久化列，不需要新增结构）：
 * - `account_uuid`：账号的**不可变**稳定标识（创建入口一次性生成，唯一索引）。
 *   命中 ⇒ 两个账号行是同一条账号事实（数据库克隆／同步场景），最强证据。
 * - `login_name`（账号名）：工程师的**工作账号名**，跨设备可携带；
 *   但本人可自助改名，因此只作**次级**映射依据，需配合公司编码与姓名快照核对。
 *
 * 公司维度同理：源机的 `organization_id` 在目标机无意义，必须用
 * `organization.organization_code`（业务编码，名称可改、编号不变）对齐。
 *
 * 失败关闭：任一标识缺失或无法核验 ⇒ **逐条拒绝**，绝不回退到数字 id 猜测，
 * 也不静默把导入人写成原作者。
 *
 * 纯函数：确定性、无 I/O、无 DI、无 ORM；所有事实由上层从本机数据库当前事实组装。
 */

/** 包内携带的**可移植来源身份**（缺失即"未携带"，不猜测） */
export type RecordPackagePortableSourceIdentity = {
  /** 来源账号的跨端稳定标识（`base_user_account.account_uuid`） */
  readonly sourceAccountUuid: string | null;
  /** 来源账号的可移植账号名（`base_user_account.login_name`） */
  readonly sourceAccountLoginName: string | null;
  /** 来源账号的姓名快照（仅作交叉核对，不作唯一判据） */
  readonly sourceAccountName: string | null;
  /** 来源公司的稳定业务编码（`organization.organization_code`） */
  readonly sourceOrganizationCode: string | null;
};

/** 映射依据：来源账号在目标机上被定位到的方式（写入逐条结果，供人工复核） */
export type RecordPackagePortableIdentityBasis = 'STABLE_ID' | 'LOGIN_NAME_IN_COMPANY';

/** 裁决结论 */
export type RecordPackagePortableIdentityDecision =
  | {
      readonly allowed: true;
      /** 已核验的来源账号（本机账号 id）；调用方不再使用包内原值 */
      readonly sourceAccountId: number;
      readonly basis: RecordPackagePortableIdentityBasis;
    }
  | { readonly allowed: false; readonly reason: string };

/** 上层按本机数据库当前事实组装的裁决输入 */
export type RecordPackagePortableIdentityFacts = {
  /** 包内携带的可移植身份 */
  readonly portable: RecordPackagePortableSourceIdentity;
  /** 按稳定标识（`account_uuid`）在本机命中的账号 */
  readonly matchedByStableId: { readonly accountId: number } | null;
  /** 按账号名（`login_name`）在本机命中的账号 */
  readonly matchedByLoginName: {
    readonly accountId: number;
    readonly realName: string | null;
  } | null;
};

function normalizeName(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 裁决包内来源账号能否作为本次导入的作者事实。
 *
 * 判定顺序：
 * 1. 包内既无稳定标识也无账号名 → 拒绝（**不回退到数字 id**：
 *    旧包只带 `source_account_id`，无法区分"同号不同人"，按不可核验拒绝）；
 * 2. 稳定标识在本机命中 → 放行（依据 `STABLE_ID`，最强证据）；
 * 3. 账号名在本机命中 → 交叉核对姓名快照：
 *    - 包内携带姓名快照且本机账号姓名**存在且不一致** → 拒绝
 *      （账号被复用／改名后另一个人占用同一账号名）；
 *    - 其余 → 放行（依据 `LOGIN_NAME_IN_COMPANY`）；
 * 4. 两个标识都未在本机命中 → 拒绝。
 */
export function evaluateRecordPackagePortableIdentity(
  facts: RecordPackagePortableIdentityFacts,
): RecordPackagePortableIdentityDecision {
  const { portable } = facts;
  if (portable.sourceAccountUuid === null && portable.sourceAccountLoginName === null) {
    return {
      allowed: false,
      reason:
        '包内缺少跨端可移植的来源账号标识（稳定账号标识与账号名均未携带），原作者不可核验，该条未导入',
    };
  }

  if (facts.matchedByStableId !== null) {
    return {
      allowed: true,
      sourceAccountId: facts.matchedByStableId.accountId,
      basis: 'STABLE_ID',
    };
  }

  if (facts.matchedByLoginName !== null) {
    const sourceName = normalizeName(portable.sourceAccountName);
    const localName = normalizeName(facts.matchedByLoginName.realName);
    if (sourceName !== null && localName !== null && sourceName !== localName) {
      return {
        allowed: false,
        reason:
          '包内来源账号姓名快照与本机同账号名账号的姓名不一致（来源身份不可核验，可能为账号名被复用），该条未导入',
      };
    }
    return {
      allowed: true,
      sourceAccountId: facts.matchedByLoginName.accountId,
      basis: 'LOGIN_NAME_IN_COMPANY',
    };
  }

  return {
    allowed: false,
    reason: '本机不存在可核验的来源账号（按稳定账号标识与账号名均未命中），该条未导入',
  };
}

/**
 * 公司身份裁决（跨安装口径）。
 *
 * - 包内携带公司编码 → 必须与目标公司编码一致（跨机时数字 id 本就不同，不再比较）；
 * - 包内未携带（旧包）→ 回退数字 id 比较（同机口径）；
 * - 目标公司编码取不到（读取失败）→ 失败关闭，不放行。
 */
export type RecordPackageCompanyIdentityFacts = {
  /** 包内携带的公司编码（旧包为 null） */
  readonly sourceOrganizationCode: string | null;
  /** 包内携带的公司数字 id（旧包仍有） */
  readonly sourceOrganizationId: number | null;
  /** 目标公司（本机）的稳定业务编码；读取不到时为 null */
  readonly targetOrganizationCode: string | null;
  /** 目标公司（本机）的数字 id */
  readonly targetOrganizationId: number;
};

export type RecordPackageCompanyIdentityDecision =
  | { readonly allowed: true; readonly basis: 'ORGANIZATION_CODE' | 'ORGANIZATION_ID' }
  | { readonly allowed: false; readonly reason: string };

export function evaluateRecordPackageCompanyIdentity(
  facts: RecordPackageCompanyIdentityFacts,
): RecordPackageCompanyIdentityDecision {
  if (facts.sourceOrganizationCode !== null) {
    if (facts.targetOrganizationCode === null) {
      return {
        allowed: false,
        reason: '本机公司身份不可核验，不能确认记录包归属，该条未导入',
      };
    }
    if (facts.targetOrganizationCode === facts.sourceOrganizationCode) {
      return { allowed: true, basis: 'ORGANIZATION_CODE' };
    }
    return {
      allowed: false,
      reason: '包内来源公司与导入目标公司不一致，该条未导入',
    };
  }

  if (
    facts.sourceOrganizationId !== null &&
    facts.sourceOrganizationId !== facts.targetOrganizationId
  ) {
    return {
      allowed: false,
      reason: '包内归属公司与导入目标公司不一致，该条未导入',
    };
  }

  return { allowed: true, basis: 'ORGANIZATION_ID' };
}

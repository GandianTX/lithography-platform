// src/usecases/account/my-account-settings.input.normalize.ts

import { DomainError, INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import { normalizeOptionalText } from '@core/common/input-normalize/input-normalize.policy';
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  normalizeAdminUserCompanyNameInput,
  normalizeAdminUserContactEmailInput,
  normalizeAdminUserLoginEmailInput,
  normalizeAdminUserLoginNameInput,
  normalizeAdminUserNicknameInput,
  normalizeAdminUserPasswordInput,
  normalizeAdminUserPhoneInput,
} from './admin-user-management.input.normalize';
import type {
  UpdateMyAccountSettingsNormalizeInput,
  UpdateMyAccountSettingsNormalizeOutput,
} from './my-account-settings.types';

/**
 * 当前用户账号设置场景的输入规范化（P1 只读 + P2 设置更新 + P3 自助改密）。
 *
 * 分层边界（`docs/project-convention/input-field-design.md`）：不做 I/O、不读配置、不查数据库、
 * 不做权限判断、不组装 DTO；本文件不导出 interface 供 adapter 使用（执行契约类型在相邻
 * `my-account-settings.types.ts`），以免触发 eslint `no-adapter-types-from-usecase-implementations`。
 *
 * P1 读取场景**没有任何客户端提交的字段**：`myAccountSettings` Query 无参数，目标账号只能来自
 * 已认证 Session。因此读取场景的规范化职责是对 Session 携带的 `accountId` 做**防御性前置校验**，
 * 在进入数据库读取之前失败关闭——这与 `AccountQueryService.getAccountById()` 既有的
 * `Number.isInteger(targetAccountId) && > 0` 前置断言同源，避免把畸形主键透传进 `findOne({ where })`。
 *
 * P2 / P3 写入场景的字段收敛在本文件扩展（`normalizeMyAccountSettingsUpdateInput()` /
 * `normalizeMyAccountPasswordInput()`）：**三态语义**（省略 / 清空 / 设置）在本文件持有，
 * 而单字段的 trim / NFKC / 长度上限 / 字符集 / 邮箱归一**委托 admin 场景的同名收敛函数**——
 * 可复用其「底层事实和设计经验」，且长度上限（列宽）、登录名字符集等规则
 * 单一真源不得复制第二份；本文件不重新声明任何数值边界。
 *
 * 错误口径：统一透传通用 `INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE`，由全局 GraphQL 异常过滤器
 * 映射为 `extensions.code === 'BAD_USER_INPUT'`。复用依据与 `admin-user-management.input.normalize.ts`
 * 对账号 ID 的既有裁决同源（该码原语义是 limit 数值非法，此处沿用既有先例，不新增场景专用码）；
 * 对外大类当前依赖过滤器映射表的默认兜底达成（`INPUT_NORMALIZE_*` 无显式映射条目）。
 * 刻意不使用 `AUTH_ERROR.*` / `JWT_ERROR.*`
 * （会被映射为 `UNAUTHENTICATED`，导致前端误判会话失效并清理 Session 跳转登录页）：一个已通过
 * `JwtAuthGuard` 的会话却携带非法 `accountId` 属服务端/令牌异常，应失败关闭为输入类错误而非
 * 「未认证」，也不得塌缩为 `INTERNAL_SERVER_ERROR` 之外的语义。
 */

/**
 * 校验并返回 Session 携带的可信 `accountId`。
 *
 * @param session 由 adapter 经 `mapJwtToUsecaseSession()` 转换而来的会话
 * @returns 通过校验的正整数 `accountId`
 * @throws {DomainError} `accountId` 非有限正整数时失败关闭（`INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE`）
 */
export function normalizeMyAccountSettingsAccountId(session: UsecaseSession): number {
  const accountId = session.accountId;
  if (!Number.isInteger(accountId) || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE,
      '当前会话账号标识非法，无法读取账号设置',
    );
  }
  return accountId;
}

/** 真实姓名长度上限：与 `base_user_info.real_name`（varchar(200)）列宽一致 */
const MY_ACCOUNT_REAL_NAME_MAX_LENGTH = 200;

/**
 * 账号设置更新（P2）的组合收敛：七个白名单字段逐一收敛，输出严格三态。
 *
 * 与 admin 资料更新收敛（`normalizeAdminUserProfileUpdateInput()`）的结构差异只有一点：
 * 本场景**多出两个登录凭据字段**（`loginName` / `loginEmail`），它们的「至少保留一个」
 * 组合约束**不在此判定**——该约束必须基于「input 与数据库当前值的合并结果」，合并需要
 * 锁内事实，属 Usecase 在事务内的裁决；输入层无从裁决，也不得虚构。
 *
 * 委托说明：`null` / `''` / 纯空白到「清空（null）」的收敛、以及非空字符串的
 * trim / NFKC / 长度 / 格式校验，全部复用 admin 场景的单字段收敛函数
 * （依据见文件头）；本函数只持有三态语义的组合，不重复实现任何单字段规则。
 * `realName` 的「空白即清空 + 列宽上限」见 `normalizeMyAccountRealNameInput()`。
 */
export function normalizeMyAccountSettingsUpdateInput(
  input: UpdateMyAccountSettingsNormalizeInput,
): UpdateMyAccountSettingsNormalizeOutput {
  return {
    loginName: normalizeMyAccountSettingsLoginName(input.loginName),
    loginEmail: normalizeMyAccountSettingsLoginEmail(input.loginEmail),
    nickname: normalizeMyAccountSettingsNickname(input.nickname),
    realName: normalizeMyAccountRealNameInput(input.realName),
    companyName: normalizeMyAccountSettingsCompanyName(input.companyName),
    phone: normalizeMyAccountSettingsPhone(input.phone),
    contactEmail: normalizeMyAccountSettingsContactEmail(input.contactEmail),
  };
}

/**
 * 真实姓名三态收敛：`undefined` = 不修改；`null` / `''` / 纯空白 = 清空；
 * 非空字符串 trim 后校验长度不超过列宽 200。空白收敛统一走通用
 * `normalizeOptionalText(..., 'to_null')`，不另写一份空白判定。
 */
function normalizeMyAccountRealNameInput(input: unknown): string | null | undefined {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '姓名' });
  if (normalized === null || normalized === undefined) {
    return normalized;
  }
  if (normalized.length > MY_ACCOUNT_REAL_NAME_MAX_LENGTH) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE,
      `姓名长度不能超过 ${MY_ACCOUNT_REAL_NAME_MAX_LENGTH} 个字符`,
    );
  }
  return normalized;
}

/**
 * 登录名三态收敛：`undefined` = 不修改（原样保留）；其余（显式 `null`、`''`、纯空白、
 * 非空字符串）交给 admin 收敛函数——显式 `null` 与空白字符串均收敛为 `null`（清空），
 * 非空字符串经长度区间（4~30）与字符集校验后返回。
 */
function normalizeMyAccountSettingsLoginName(input: unknown): string | null | undefined {
  if (input === undefined) {
    return undefined;
  }
  return normalizeAdminUserLoginNameInput(input);
}

/** 登录邮箱三态收敛：语义同登录名；非空值复用 `normalizeEmail()`（trim + 转小写）。 */
function normalizeMyAccountSettingsLoginEmail(input: unknown): string | null | undefined {
  if (input === undefined) {
    return undefined;
  }
  return normalizeAdminUserLoginEmailInput(input);
}

/**
 * 昵称收敛（P2）：`undefined` = 不修改；显式 `null` 在此即拒绝（昵称无「清空」语义——
 * 必填字段不接受 null，「未提供」是不同意图，必须显式拒绝而不是静默视为不修改）；其余经 admin 必填昵称规则
 * （trim + NFKC + 非空 + 长度上限 50）。昵称不做唯一性检查（可重复）。
 */
function normalizeMyAccountSettingsNickname(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY, '昵称不能为空');
  }
  return normalizeAdminUserNicknameInput(input);
}

/** 公司名称三态收敛：`undefined` = 不修改，`null` / 空白 = 清空，字符串 = 设置。 */
function normalizeMyAccountSettingsCompanyName(input: unknown): string | null | undefined {
  if (input === undefined) {
    return undefined;
  }
  return normalizeAdminUserCompanyNameInput(input);
}

/** 电话三态收敛：语义同公司名称；保留用户填写原值形态，不套用 `normalizePhone()`。 */
function normalizeMyAccountSettingsPhone(input: unknown): string | null | undefined {
  if (input === undefined) {
    return undefined;
  }
  return normalizeAdminUserPhoneInput(input);
}

/** 联系邮箱三态收敛：写入 `base_user_info.email`，与登录凭据列严格区分、不触发唯一索引。 */
function normalizeMyAccountSettingsContactEmail(input: unknown): string | null | undefined {
  if (input === undefined) {
    return undefined;
  }
  return normalizeAdminUserContactEmailInput(input);
}

/**
 * 密码非空前置断言（P3 自助改密的当前密码与新密码共用）：只判定「是非空字符串」，
 * 不做 trim、不碰强度规则。
 *
 * 复用 `normalizeAdminUserPasswordInput()`（底层事实复用；该函数不含任何
 * 管理员目标逻辑）：调用方必须在拿到返回值后立即对**新密码**执行
 * `PasswordPolicyService.validatePassword()`（本场景经 `assertAdminUserPasswordPolicy()`
 * 共享断言），对**当前密码**不得做策略校验——存量账号的密码可能先于现行策略设立，
 * 策略校验会把本来正确的当前密码误判为非法。
 *
 * 该断言对当前密码同样是必须的前置条件：`AccountService.verifyPassword()` 内部的
 * `preprocessPassword()` 会对空值抛 `AUTH_ERROR.INVALID_PASSWORD`（过滤器映射
 * `UNAUTHENTICATED`），先行失败关闭为输入类错误。
 */
export function normalizeMyAccountPasswordInput(input: unknown, fieldName: string): string {
  return normalizeAdminUserPasswordInput(input, fieldName);
}

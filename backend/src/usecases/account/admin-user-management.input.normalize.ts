// src/usecases/account/admin-user-management.input.normalize.ts

import { DomainError, INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import {
  LOGIN_NAME_MAX_LENGTH,
  LOGIN_NAME_MIN_LENGTH,
  LOGIN_NAME_PATTERN,
} from '@core/account/policy/login-name.policy';
import {
  normalizeEnumValue,
  normalizeOptionalText,
  normalizeRequiredText,
} from '@core/common/input-normalize/input-normalize.policy';
import { normalizeEmail } from '@core/common/normalize/normalize.helper';
import type {
  AdminUserListRoleFilter,
  AdminUserListStatusFilter,
  AdminUserWritableRole,
  AdminUserWritableStatus,
} from '@src/modules/account/account.types';
import type {
  AdminUserCredentialNormalizeInput,
  AdminUserCredentialNormalizeOutput,
  AdminUserProfileNormalizeInput,
  AdminUserProfileNormalizeOutput,
  AdminUserProfileUpdateNormalizeInput,
  AdminUserProfileUpdateNormalizeOutput,
} from './admin-user-management.types';
import {
  ADMIN_USER_LIST_ROLE_FILTERS,
  ADMIN_USER_LIST_STATUS_FILTERS,
  ADMIN_USER_WRITABLE_ROLES,
  ADMIN_USER_WRITABLE_STATUSES,
} from './admin-user-permission';

/**
 * 管理员用户管理场景输入语义：`usecases/account` 内列表、创建、资料编辑、
 * 状态修改与管理员重置密码等用例共享的单一收敛入口，不各写一份。
 *
 * 分层边界（见 `docs/project-convention/input-field-design.md`）：
 * - 只组合 `core/common/input-normalize` 的 primitive 与 `core/common/normalize` 的邮箱规则，
 *   不复制 trim、NFKC、邮箱、密码规则，也不新增与之平行的第二套实现；
 * - 不做 I/O、不读配置、不查数据库、不做唯一性判断、不做权限判断、不组装 DTO；
 * - 白名单值域来自同目录 `admin-user-permission.ts`，本文件不重新声明第二份角色/状态清单；
 * - 执行契约类型（输入/输出形状）在同目录 `admin-user-management.types.ts`，本文件不导出
 *   interface：`type.rules.md` 要求 Usecase 与其调用 adapter 共享的执行输入/结果留在相邻
 *   `*.types.ts`，而 eslint `no-adapter-types-from-usecase-implementations` 禁止 adapter 从
 *   normalize 文件借类型；
 * - 密码强度不在本文件收敛：唯一路径是 `PasswordPolicyService.validatePassword()`
 *   （内部已完成 NFKC、纯空白拒绝与首尾空格拒绝）+ `AccountService.hashPasswordWithTimestamp()`，
 *   管理员创建与管理员重置密码都必须走该路径，不得在此新增密码长度或复杂度规则；
 *   本文件只提供 `normalizeAdminUserPasswordInput()` 做「非空字符串」前置断言。该断言是
 *   **必须执行**的前置条件：`AccountCreateData.loginPassword` 是可选字段，
 *   `CreateAccountUsecase.doCreate()` 的 `if (accountData.loginPassword)` 分支在值为
 *   `undefined` / `''` 时会跳过整个密码策略校验，随后仍执行
 *   `hashPasswordWithTimestamp(String(accountData.loginPassword), …)`，而
 *   `String(undefined) === 'undefined'`——会产出一个明文口令为已知字符串的可登录账号；
 * - 分页不在本文件收敛：唯一路径是 `@core/pagination/pagination.policy` 的
 *   `applyDefaults()` + `enforceMaxPageSize()`，避免出现第二份 page/pageSize 规则；
 * - 邮箱格式（RFC 校验）留在 adapter 的 `@IsEmail`，本文件只做 trim + 小写 + 长度上限；
 * - 电话只做 trim + 长度上限，刻意不套用 `normalizePhone()`：该 helper 仅服务验证码
 *   手机号比对，会剥离 `+`、`-`、空格等字符，用于资料存储会破坏用户填写的原值。
 *
 * 空值语义（三态，不合并，见 `input-field-design.md` 第 4 节）：
 * - `undefined`：调用方未提供该字段。资料更新场景表示「不修改该列」；
 * - `null`：调用方明确提供空值。资料更新场景表示「清空该列」，创建场景表示「不写入」；
 * - `''` 与空白字符串：按各函数显式声明的 `EmptyPolicy` 收敛，必填字段拒绝、
 *   可空字段收敛为 `null`，与目标列 nullable 的数据库事实一致；
 * - adapter 不得提前把空白字符串转成 `undefined` 或 `null`，否则本层三态语义失效。
 *
 * 错误口径：统一透传通用 `INPUT_NORMALIZE_ERROR.*`，由全局 GraphQL 异常过滤器映射为
 * `extensions.code === 'BAD_USER_INPUT'`。本文件不映射为账号场景码，也不使用
 * `AUTH_ERROR.*` / `JWT_ERROR.*`（会被映射为 `UNAUTHENTICATED`，导致前端误判会话失效
 * 并清理 Session 跳转登录页）。唯一性冲突、目标不存在等语义由 Usecase 在数据库事实
 * 之上裁决，不属于输入收敛职责。
 *
 * 显式依赖声明（当前依据的是实现细节，不是 tracked 契约）：
 * `graphql-error-contract-current.md` 只约束 `extensions.code` 大类，不列举码值到类别的映射表；
 * `INPUT_NORMALIZE_ERROR.*` 在 `graphql-exception.filter.ts` 的 `mapDomainErrorToGqlCode()` 中
 * **没有显式条目**，其 `BAD_USER_INPUT` 结果来自该函数的未命中默认分支。若默认分支被收紧
 * （例如未知码改判 `INTERNAL_SERVER_ERROR`），本文件全部输入错误会静默变成 5xx 类，
 * 且不违反任何契约文档、review 也拦不住。因此默认分支策略一旦变更，必须同步复核本文件
 */

/**
 * 单一真源（4~30 个字符、`/^[a-zA-Z0-9_-]+$/`），本文件与 `AdminCreateUserInput` /
 * `RegisterInput` 同源引用，本文件不再持有第二份字面。历史裁决记录（不采用
 * `CreateAccountInput` 的 `@MinLength(3)`）见该 policy 文件 JSDoc。
 */

/** 登录邮箱长度上限：`base_user_account.login_email` varchar(100) */
const LOGIN_EMAIL_MAX_LENGTH = 100;

/** 昵称长度上限：`base_user_info.nickname` varchar(50)，与同域既有昵称规则一致 */
const NICKNAME_MAX_LENGTH = 50;

/** 公司名称长度上限：`base_user_info.company_name` varchar(100) */
const COMPANY_NAME_MAX_LENGTH = 100;

/** 电话长度上限：`base_user_info.phone` varchar(20) */
const PHONE_MAX_LENGTH = 20;

/** 联系邮箱长度上限：`base_user_info.email` varchar(50) */
const CONTACT_EMAIL_MAX_LENGTH = 50;

/**
 * 列表关键字长度上限：**防御性上限**，阻止超长字符串进入 `LIKE` 参数
 * （前置通配 `%kw%` 已注定全表扫描，超长关键字只会放大逐行比较的无意义成本）。
 *
 * 刻意不以「与可搜索列宽对齐」为理由：搜索是 `LIKE '%kw%'` 的子串匹配，关键字长于
 * 列内容只是匹配不到，既不会截断存储也不影响正确性，因此列宽（`login_email`
 * varchar(100)）与本上限之间**没有因果关系**。调整本值只需重新评估防御成本，
 * 不需要复核任何 DDL；反之，可搜索列改宽窄也**不构成**修改本值的理由。
 */
const KEYWORD_MAX_LENGTH = 100;

/**
 * 登录名收敛：可选凭据，空白按 `to_null` 收敛，非空时校验长度区间与字符集。
 *
 * 规则口径与当前实际注册入口 `RegisterInput.loginName` 一致：最少 4 个字符、
 * 最多 30 个字符、只允许英文字母 / 数字 / 下划线 / 短横线。
 *
 * - **不执行大小写改写**：`uk_login_name` 建在 `login_name` 上，该列继承 `_ci` 排序规则，
 *   比较本身已大小写不敏感；在此改写大小写属于静默改写用户填写的凭据形态，
 *   并与既有注册链路写入的存量值产生新的展示差异；
 * - **不在此做唯一性判断**：normalize 层不得查数据库（`input-field-design.md` 第 9 节、
 *   `input-normalize-v1-boundaries.md` 第 7 节）。唯一性最终由数据库唯一索引
 *   `uk_login_name` 兜底；Usecase 侧的预检查只用于友好错误提示，并发竞争仍由该索引裁决
 */
export function normalizeAdminUserLoginNameInput(input: unknown): string | null {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '登录名' });
  if (normalized === null || normalized === undefined) {
    return null;
  }
  assertAdminUserTextLength(normalized, {
    fieldName: '登录名',
    minLength: LOGIN_NAME_MIN_LENGTH,
    maxLength: LOGIN_NAME_MAX_LENGTH,
  });
  if (!LOGIN_NAME_PATTERN.test(normalized)) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      '登录名只能包含英文字母、数字、下划线和短横线',
    );
  }
  return normalized;
}

/**
 * 登录邮箱收敛：可选凭据，空白按 `to_null` 收敛，非空时复用 `normalizeEmail()`
 * （trim + 转小写）并校验长度上限。
 *
 * 不在此实现 RFC 邮箱格式校验：格式属于 adapter 的 `@IsEmail` 职责，
 * 唯一性属于 Usecase 结合数据库预检查与 `uk_login_email` 的职责。
 */
export function normalizeAdminUserLoginEmailInput(input: unknown): string | null {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '登录邮箱' });
  if (normalized === null || normalized === undefined) {
    return null;
  }
  const loginEmail = normalizeEmail(normalized);
  assertAdminUserTextLength(loginEmail, {
    fieldName: '登录邮箱',
    maxLength: LOGIN_EMAIL_MAX_LENGTH,
  });
  return loginEmail;
}

/**
 * 管理员创建普通用户的凭据组合约束：登录名与登录邮箱至少填写一个。
 *
 * - 组合约束属于场景输入语义，只在 Usecase 侧的 normalize 层表达；
 *   adapter 的 `@IsOptional()` 无法表达跨字段约束，也不允许在 DTO 内写跨字段业务编排；
 * - 两个字段各自先完成独立收敛（trim、小写、长度），再判定组合，
 *   使「只填了空白字符串」与「两个都没填」得到同一个明确拒绝；
 * - 拒绝时使用 `REQUIRED_TEXT_EMPTY`（映射 `BAD_USER_INPUT`），
 *   不使用权限类错误码，避免把输入问题表达成授权问题；
 * - 本函数**不覆盖密码**：创建用例必须同时调用 `normalizeAdminUserPasswordInput()`，
 *   不得只收敛凭据就把输入映射成 `AccountCreateData`（原因见该函数与文件头注释）。
 */
export function normalizeAdminUserCredentialInput(
  input: AdminUserCredentialNormalizeInput,
): AdminUserCredentialNormalizeOutput {
  const loginName = normalizeAdminUserLoginNameInput(input.loginName);
  const loginEmail = normalizeAdminUserLoginEmailInput(input.loginEmail);

  if (loginName === null && loginEmail === null) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      '登录名与登录邮箱至少需要填写一个',
    );
  }

  return { loginName, loginEmail };
}

/**
 * 密码前置断言：只判定「是非空字符串」，不碰任何强度规则。
 *
 * 为什么需要这一层（安全前置条件，管理员创建与管理员重置密码共用）：
 * `CreateAccountUsecase.doCreate()` 用 `if (accountData.loginPassword)` 守卫密码策略校验，
 * 而 `AccountCreateData.loginPassword` 是可选字段；值为 `undefined` / `''` 时校验被整体跳过，
 * 随后仍执行 `hashPasswordWithTimestamp(String(accountData.loginPassword), …)`，
 * 而 `String(undefined) === 'undefined'`——结果是产出一个**明文口令为已知字符串**的可登录账号。
 *
 * 刻意不调用 `normalizeRequiredText()`：该 primitive 会 `trim()`，对密码而言是静默改写秘密——
 * 它会把用户填写的首尾空格删掉并写入，从而掩盖 `PasswordPolicyService.validatePassword()`
 * 本来会给出的「密码首尾不能包含空格」拒绝。本函数只做类型与存在判定，原值原样交给策略层。
 *
 * 调用方约束（P0-3 / P0-6，P3 起含自助修改密码经
 * `my-account-settings.input.normalize.ts` 的 `normalizeMyAccountPasswordInput()` 委托）：
 * - 本函数返回后必须紧接着调用 `PasswordPolicyService.validatePassword()`，
 *   不得依赖 `CreateAccountUsecase` 内部的 `if (loginPassword)` 分支；
 * - 策略失败时必须抛映射为 `BAD_USER_INPUT` 的码（如 `INPUT_NORMALIZE_ERROR.INVALID_TEXT`），
 *   **不得沿用** `CreateAccountUsecase` 的 `AUTH_ERROR.INVALID_PASSWORD`：后者被全局过滤器
 *   映射为 `UNAUTHENTICATED`，会使「管理员填了弱密码」被前端误判为会话失效并清理 Session
 *   跳转登录页，违反 `graphql-error-contract-current.md`「input 不得塌缩为 `UNAUTHENTICATED`」。
 *   先行校验后，该 `INVALID_PASSWORD` 分支对管理员路径不可达；
 *
 * @param input 待断言的密码原值（adapter 结构校验后）
 * @param fieldName 仅用于拒绝提示的字段名（如「初始密码」「新密码」）
 */
export function normalizeAdminUserPasswordInput(input: unknown, fieldName: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY, `${fieldName}不能为空`);
  }
  return input;
}

/**
 * 部署侧默认密码配置的「是否可用」收敛：不是字符串或 trim 后为空 → `null`。
 *
 * 刻意返回 `null` 而不是抛 `INPUT_NORMALIZE_ERROR`：默认密码来自服务端配置，
 * 缺失属于部署配置问题，调用方必须收敛为 `DEFAULT_PASSWORD_NOT_CONFIGURED`
 * 而不是用户输入错误；同时保留原值（不 trim 返回值），强度判定仍由
 * `PasswordPolicyService.validatePassword()` 单点负责。
 */
export function normalizeAdminUserDefaultPasswordSetting(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  return input.trim().length === 0 ? null : input;
}

/**
 * 昵称收敛：必填，执行 trim + NFKC + 长度上限。
 *
 * 不做唯一性校验。管理员创建（P0-3）与资料编辑（P0-4）流程**不得调用**
 * `AccountQueryService.checkNicknameExists()`，也不得以任何其它形式在管理员路径上重新引入
 * 昵称查重；`nickname` 列不新增数据库唯一约束。
 *
 * 本层不查数据库另有一条独立的分层硬约束（`input-normalize-v1-boundaries.md` 第 7 节与
 * `input-field-design.md` 第 9 节：不得在 normalize 中做数据库查重）：即使将来业务口径改变，
 * 查重也属 Usecase 结合数据库事实的职责，不得下沉到本文件。
 *
 * 至今仍保留昵称查重行为。本文件不回改这些旧流程，也不修改 `checkNicknameExists()` 本身。
 *
 * - NFKC 之后必须重新 trim 并复检非空：这是**边界空白归一**——确有码位（如 U+00A8、
 *   U+00AF、U+00B4、U+02D8）NFKC 后会产生前导/尾随空白；穷举 U+0000–U+2FFFF 后确认
 *   不存在「前置 trim 非空、NFKC 后 trim 变空」的字符，故下方空值复检分支实际不可达，
 *   保留作为防御，不依赖它表达业务语义；
 * - 只做 Unicode 兼容归一，不做 emoji 剥离、字符集白名单或全角转半角等额外改写：
 *   注册链路的历史昵称规则属于该场景的兼容例外（见 `input-normalize-v1-boundaries.md`
 *   第 11 节），不并入管理员场景，也不提升到 `core/common`；
 * - 长度上限对齐 `base_user_info.nickname` varchar(50) 与同域既有资料昵称规则，
 *   避免出现第二套昵称长度真源。
 */
export function normalizeAdminUserNicknameInput(input: unknown): string {
  const trimmed = normalizeRequiredText(input, { fieldName: '昵称' });
  const normalized = trimmed.normalize('NFKC').trim();

  if (normalized.length === 0) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY, '昵称不能为空');
  }

  assertAdminUserTextLength(normalized, {
    fieldName: '昵称',
    maxLength: NICKNAME_MAX_LENGTH,
  });
  return normalized;
}

/**
 * 公司名称收敛：可选资料字段，三态语义（`undefined` 未提供 / `null` 清空 / `string` 新值）。
 */
export function normalizeAdminUserCompanyNameInput(input: unknown): string | null | undefined {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '公司名称' });
  if (normalized === undefined || normalized === null) {
    return normalized;
  }
  assertAdminUserTextLength(normalized, {
    fieldName: '公司名称',
    maxLength: COMPANY_NAME_MAX_LENGTH,
  });
  return normalized;
}

/**
 * 电话收敛：可选资料字段，三态语义；只做 trim 与长度上限，保留用户填写的原值形态。
 */
export function normalizeAdminUserPhoneInput(input: unknown): string | null | undefined {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '电话' });
  if (normalized === undefined || normalized === null) {
    return normalized;
  }
  assertAdminUserTextLength(normalized, { fieldName: '电话', maxLength: PHONE_MAX_LENGTH });
  return normalized;
}

/**
 * 联系邮箱收敛：可选资料字段，三态语义；非空时复用 `normalizeEmail()`（trim + 转小写）。
 *
 * 联系邮箱写入 `base_user_info.email`，与登录凭据 `base_user_account.login_email`
 * 是两个不同字段：本函数不参与登录，不触发唯一索引，也不得被当作登录邮箱使用。
 */
export function normalizeAdminUserContactEmailInput(input: unknown): string | null | undefined {
  const normalized = normalizeOptionalText(input, 'to_null', { fieldName: '联系邮箱' });
  if (normalized === undefined || normalized === null) {
    return normalized;
  }
  const contactEmail = normalizeEmail(normalized);
  assertAdminUserTextLength(contactEmail, {
    fieldName: '联系邮箱',
    maxLength: CONTACT_EMAIL_MAX_LENGTH,
  });
  return contactEmail;
}

/**
 * 管理员创建资料组合收敛：昵称必填 + 三个可选资料字段的三态语义。
 *
 * 创建流程继续通过 `normalizeAdminUserNicknameInput()` 强制昵称存在，不因资料更新改为
 * 差异提交而放宽创建契约或数据库昵称必填的最终状态约束。
 */
export function normalizeAdminUserProfileInput(
  input: AdminUserProfileNormalizeInput,
): AdminUserProfileNormalizeOutput {
  return {
    nickname: normalizeAdminUserNicknameInput(input.nickname),
    companyName: normalizeAdminUserCompanyNameInput(input.companyName),
    phone: normalizeAdminUserPhoneInput(input.phone),
    contactEmail: normalizeAdminUserContactEmailInput(input.contactEmail),
  };
}

/**
 * 管理员资料更新专用组合收敛。
 *
 * 昵称只在传入时复用既有必填昵称规则，因此输出为 `string | undefined`：
 * `undefined` 表示不修改；string 表示修改；显式 null、空字符串与纯空白仍由
 * `normalizeAdminUserNicknameInput()` 拒绝。其余字段保持既有三态语义。
 *
 * 本函数只收敛字段，不裁决空 patch；仅含 accountId 的空更新由用例在事务前明确拒绝。
 */
export function normalizeAdminUserProfileUpdateInput(
  input: AdminUserProfileUpdateNormalizeInput,
): AdminUserProfileUpdateNormalizeOutput {
  return {
    nickname:
      input.nickname === undefined ? undefined : normalizeAdminUserNicknameInput(input.nickname),
    companyName: normalizeAdminUserCompanyNameInput(input.companyName),
    phone: normalizeAdminUserPhoneInput(input.phone),
    contactEmail: normalizeAdminUserContactEmailInput(input.contactEmail),
  };
}

/**
 * 可写单角色收敛：只接受 `ENGINEER` / `CUSTOMER`，`SUPER_ADMIN` 在此即被拒绝。
 *
 * - 值域来自 `ADMIN_USER_WRITABLE_ROLES` 单一真源，未来新增角色默认不可写（失败关闭）；
 * - 严格大小写匹配，不猜测近似值、不做大小写收敛后放行；
 * - 这里拒绝的是「把管理员角色写进普通用户」这一非法输入；针对已存在管理员账号的
 *   写保护由 `assertWritableAdminUserTargetRole()` 依数据库事实裁决，两者不可互相替代。
 */
export function normalizeAdminUserWritableRole(input: unknown): AdminUserWritableRole {
  return normalizeEnumValue(input, ADMIN_USER_WRITABLE_ROLES, { fieldName: '角色' });
}

/**
 * 可写账号状态收敛：只接受 `ACTIVE` / `INACTIVE`。
 *
 * `PENDING`、`SUSPENDED`、`BANNED`、`DELETED` 不是管理员页面可写值，
 * 绕过前端提交这些值在此被拒绝；账号不做硬删除，因此不存在「删除」状态写入路径。
 */
export function normalizeAdminUserWritableStatus(input: unknown): AdminUserWritableStatus {
  return normalizeEnumValue(input, ADMIN_USER_WRITABLE_STATUSES, { fieldName: '账号状态' });
}

/**
 * 列表角色筛选收敛：可选，缺省（`undefined` / `null`）表示不按角色筛选。
 *
 * 筛选值域比可写值域多出 `SUPER_ADMIN`，因为管理页面需要只读展示已有管理员账号；
 * 该差异由 `ADMIN_USER_LIST_ROLE_FILTERS` 与 `ADMIN_USER_WRITABLE_ROLES` 分开表达，
 * 不得把筛选值域当作可写值域传入写用例。
 *
 * 空串与纯空白字符串（`''` / `'   '`）**刻意判为非法**（与 `normalizeAdminUserKeyword` 的
 * 「空白视为不筛选」相反）：`''` 不是合法枚举值，`normalizeEnumValue` 会抛
 * `INVALID_ENUM_VALUE`（同为 `BAD_USER_INPUT`）。这是有意为之的失败关闭，不是 bug，
 * 不得改成「空白视为不筛选」。
 *
 * `normalizeEnumValue` trim 后接受，与全仓文本字段口径一致；本函数只把
 * 「trim 后为空」的输入判为非法。GraphQL enum 解析器不会产生带空白的枚举字面量，
 * 该路径仅对未来非 GraphQL 入口（REST / worker）有意义。
 */
export function normalizeAdminUserListRoleFilter(
  input: unknown,
): AdminUserListRoleFilter | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  return normalizeEnumValue(input, ADMIN_USER_LIST_ROLE_FILTERS, { fieldName: '角色筛选' });
}

/**
 * 列表状态筛选收敛：可选，缺省（`undefined` / `null`）表示不按状态筛选。
 *
 * `AdminUserListStatusFilter` 与 `ADMIN_USER_LIST_STATUS_FILTERS`，不复用可写侧的
 * `AdminUserWritableStatus` / `ADMIN_USER_WRITABLE_STATUSES`：两者一旦在类型与运行时值域上焊死，
 * 任何一侧的合理演进都会静默改变另一侧——开放写入 `SUSPENDED` 会让筛选自动获得该能力
 * （未经产品决策），反之为「筛出存量 `PENDING` 账号」放宽筛选会同时放宽写入白名单，
 * 属于授权面被动扩大。与角色的读/写值域拆分方式保持对称。
 *
 * 存量 `PENDING` 等状态账号不在管理页面第一版的筛选口径内，但会按真实状态出现在列表中
 *
 */
export function normalizeAdminUserListStatusFilter(
  input: unknown,
): AdminUserListStatusFilter | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  return normalizeEnumValue(input, ADMIN_USER_LIST_STATUS_FILTERS, { fieldName: '状态筛选' });
}

/**
 * 列表关键字收敛：可选，trim 后为空视为未提供（不搜索），而不是搜索空串。
 *
 * 只做 trim 与长度上限，**刻意不做小写归一**：
 * - 大小写不敏感由列 collation 保证——建库语句使用 `utf8mb4_0900_ai_ci`
 *   （`infrastructure/database/verify-empty-db-migrations.ts`），连接配置为
 *   `utf8mb4_unicode_ci`（`infrastructure/config/database.config.ts`），Entity 与 Migration
 *   均未对列显式指定 collation，因此三个可搜索列继承的均为 `_ci`（大小写与重音不敏感）排序规则；
 * - 对 `_ci` 列做小写归一是冗余的；对假想的 `_bin` / `_cs` 列它也不足以解决问题
 *   （那需要 `LOWER(col) LIKE LOWER(:kw)` 双侧归一，属查询构造职责）。两种情况下把它放进
 *   本层都不是正确落点，`input-field-design.md` 第 4 节的「大小写统一」只适用于
 *   **写入前需要固定存储形态**的字段（如 `loginEmail`），不适用于只读搜索关键字；
 * - 若将来任何可搜索列改为大小写敏感 collation，必须回到本函数与 QueryService 重新裁决，
 *   不得只在其中一侧单方面加小写。
 *
 * `LIKE` 通配符转义（`%`、`_`、`\`）属 QueryService 的参数化查询职责（SQL 构造安全），
 * 本层不拼接任何 SQL 片段、也不提前剥离通配符——那会静默改写用户的搜索意图。
 */
export function normalizeAdminUserKeyword(input: unknown): string | undefined {
  const normalized = normalizeOptionalText(input, 'to_undefined', { fieldName: '搜索关键字' });
  if (normalized === undefined || normalized === null) {
    return undefined;
  }
  assertAdminUserTextLength(normalized, {
    fieldName: '搜索关键字',
    maxLength: KEYWORD_MAX_LENGTH,
  });
  return normalized;
}

/**
 * 目标账号 ID 收敛：必须为正整数，供资料编辑、状态修改与管理员重置密码共用。
 *
 * 刻意不使用 `normalizeLimit()`：该 primitive 会把越界值 clamp 到边界，
 * 对分页参数是期望行为，对标识符则会把非法 ID 静默改写成另一个合法 ID，
 * 从而指向错误账号。标识符只做校验、不做修复。
 *
 * 目标账号是否存在、是否为只读管理员，由 Usecase 依数据库事实与
 * `assertWritableAdminUserTargetRole()` 裁决，不在本层判断。
 *
 * 已知限制（已裁决保留）：`INPUT_NORMALIZE_ERROR` 码表没有标识符语义的码值，此处借用
 * `INVALID_LIMIT_VALUE`（原语义是 `normalizeLimit` 的分页/limit 数值非法）。大类同为
 * `BAD_USER_INPUT`，且 `graphql-error-contract-current.md` 第 16-17 行明确前端不得依赖
 * `extensions.errorCode` 做生产分支（它只服务调试、测试与观测，生产可被隐藏），
 * 因此这只影响排查体验、不构成契约风险。补一个标识符语义码需要修改
 * P0-4 / P0-8 最小扩展该文件，但 P0-1 不提前实现，本轮沿用借用码。
 */
export function normalizeAdminUserTargetAccountId(input: unknown): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE, '用户账号 ID 无效');
  }
  return input;
}

/**
 * 字段长度边界断言（本场景私有）：超限即拒绝，不截断、不修复。
 *
 * 长度上限一律来自既有 Entity 列宽或既有 DTO 声明，不在此另立标准；
 * 截断会让写入值与用户输入不一致，并可能把唯一性冲突伪装成成功写入。
 */
function assertAdminUserTextLength(
  value: string,
  options: { readonly fieldName: string; readonly minLength?: number; readonly maxLength: number },
): void {
  const minLength = options.minLength ?? 0;
  if (value.length < minLength) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `${options.fieldName}长度不能少于 ${minLength} 个字符`,
      { minLength, maxLength: options.maxLength },
    );
  }
  if (value.length > options.maxLength) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `${options.fieldName}长度不能超过 ${options.maxLength} 个字符`,
      { maxLength: options.maxLength },
    );
  }
}

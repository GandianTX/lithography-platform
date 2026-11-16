// src/usecases/account/admin-user-management.types.ts

/**
 * 管理员用户管理的执行契约类型（L3：Usecase 相邻 `*.types.ts`）。
 *
 * 放置依据（`docs/common/type.rules.md`）：这些形状只服务 `usecases/account` 内管理员用例
 * 与其 GraphQL adapter 之间的执行输入/结果传递，既不是跨域稳定读模型（稳定 View 在
 * `src/modules/account/account.types.ts`），也不是 L1 跨域类型，因此留在 Usecase 相邻
 * `*.types.ts`；precedent 见 `src/usecases/repair-request/create-engineer-response.types.ts`。
 *
 * 本文件**只有类型、没有运行时值**：依 eslint
 * `no-adapter-types-from-usecase-implementations`，adapter 只能从 Usecase 相邻 `*.types.ts`
 * 做 type-only 导入，禁止从 `*.input.normalize.ts`、helper 或 registry 借类型。执行契约若留在
 * normalize 文件内导出，adapter 就没有合法引用路径，故单点收敛到本文件；运行时白名单仍由
 * `./admin-user-permission.ts` 持有，不下沉到 modules、也不上浮到本类型文件。
 *
 * 命名沿用 `src/usecases/registration/registration-input.normalize.ts` 的
 * `*NormalizeInput` / `*NormalizeOutput` 口径。
 */

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PaginationParams } from '@core/pagination/pagination.types';

/**
 * 管理员用户列表用例的执行入参。
 *
 * - `session` 由 adapter 从可信 JWT 透传，**不接受前端传入的账号 ID 或角色**；
 * - `pagination` 沿用全仓统一的 `PaginationParams`（precedent：`ListMyRepairRequestsUsecase`），
 *   第一版只接受 `OFFSET`；`sorts` 与 `withTotal` 即使被传入也会被用例丢弃，
 * - `keyword` / `role` / `status` 刻意保持 `unknown`：协议 shape 由 adapter 的 class-validator
 *   负责，值收敛（trim、长度上限、枚举白名单）统一由 `./admin-user-management.input.normalize`
 *   负责，本类型不预设任何字段已经合法。
 */
export interface ListAdminUsersCommand {
  readonly session: UsecaseSession;
  readonly pagination: PaginationParams;
  readonly keyword?: unknown;
  readonly role?: unknown;
  readonly status?: unknown;
}

/**
 * 管理员创建普通用户用例的执行入参。
 *
 * - `loginName` / `loginEmail` **至少一个**，两者均可为 `undefined` / `null` / 空白，
 *   组合约束由 `normalizeAdminUserCredentialInput()` 裁决；第一版不开放创建后修改登录凭据；
 * - `loginPassword` 是**初始密码明文**，只允许存在于本入参与用例局部变量，
 *   不得进入日志、错误文案、`DomainError.details` 或返回结果；
 * - `role` 只接受单一 `ENGINEER` / `CUSTOMER`，`SUPER_ADMIN`、空值与多角色均被拒绝；
 * - `companyName` / `phone` / `contactEmail` 可选；`contactEmail` 是联系邮箱，
 *   **不得**被写入 `base_user_account.login_email`。
 *
 * 开放入参会让「创建一个停用账号」绕过 P0-5 的双字段同步语义。
 */
export interface AdminCreateUserCommand {
  readonly session: UsecaseSession;
  readonly loginName?: unknown;
  readonly loginEmail?: unknown;
  readonly loginPassword?: unknown;
  readonly role?: unknown;
  readonly nickname?: unknown;
  readonly companyName?: unknown;
  readonly phone?: unknown;
  readonly contactEmail?: unknown;
}

/**
 * 管理员创建普通用户的登录凭据规范化输入。
 *
 * 字段刻意保持 `unknown`：协议 shape 与结构校验由 adapter 的 class-validator 负责，
 * 值收敛由 normalize 层负责，本类型不预设任何字段已经合法。
 */
export interface AdminUserCredentialNormalizeInput {
  readonly loginName?: unknown;
  readonly loginEmail?: unknown;
}

/**
 * 登录凭据规范化输出。
 *
 * `null` 表示该凭据不写入（`base_user_account.login_name` / `login_email` 均 nullable，
 * 且各自带唯一索引）；两者不会同时为 `null`，该组合约束由 normalize 层保证。
 */
export interface AdminUserCredentialNormalizeOutput {
  readonly loginName: string | null;
  readonly loginEmail: string | null;
}

/**
 * 管理员创建普通用户时可写资料字段的规范化输入。
 * `nickname` 在执行契约中保持 unknown/可选形态，但创建场景 normalize 会强制要求其存在。
 */
export interface AdminUserProfileNormalizeInput {
  readonly nickname?: unknown;
  readonly companyName?: unknown;
  readonly phone?: unknown;
  readonly contactEmail?: unknown;
}

/**
 * 管理员创建普通用户时可写资料字段的规范化输出。
 *
 * - `nickname` 必填，保持数据库最终状态的昵称非空约束；
 * - 其余字段保持三态：`undefined` = 未提供、`null` = 明确清空、
 *   `string` = 收敛后的新值；
 * - 本结构不携带 `accountId`、登录名、登录邮箱、角色、状态或密码；这些字段由创建用例的
 */
export interface AdminUserProfileNormalizeOutput {
  readonly nickname: string;
  readonly companyName: string | null | undefined;
  readonly phone: string | null | undefined;
  readonly contactEmail: string | null | undefined;
}

/** 管理员资料更新专用规范化输入；四个字段均可省略，省略即不修改。 */
export interface AdminUserProfileUpdateNormalizeInput {
  readonly nickname?: unknown;
  readonly companyName?: unknown;
  readonly phone?: unknown;
  readonly contactEmail?: unknown;
}

/**
 * 管理员资料更新专用规范化输出。
 *
 * - `nickname`: `undefined` = 不修改，`string` = 修改；显式 `null`、空字符串与纯空白均拒绝；
 * - 其余字段：`undefined` = 不修改，`null` = 清空，`string` = 修改；
 * - 消费方禁止直接展开本结构进入 repository update，必须逐字段构造 patch。
 */
export interface AdminUserProfileUpdateNormalizeOutput {
  readonly nickname: string | undefined;
  readonly companyName: string | null | undefined;
  readonly phone: string | null | undefined;
  readonly contactEmail: string | null | undefined;
}

/**
 * 管理员编辑普通用户资料用例的执行入参（P0-4）。
 *
 * - `accountId` 为目标账号 ID，语义上必填，类型刻意保持 `unknown`：
 *   协议 shape 由 adapter 的 class-validator 负责，正整数收敛由
 *   `normalizeAdminUserTargetAccountId()` 统一裁决（标识符只校验、不修复）；
 *   刻意**不含**登录名、登录邮箱、角色、状态与密码——角色只在创建时写入、创建后只读，
 *   状态与密码由各自专用用例处理；
 *   昵称允许重复，不调用昵称唯一性检查 `checkNicknameExists()`；
 * - 四个资料字段全部省略时由用例在事务前明确拒绝，不产生数据库写入。
 */
export interface AdminUpdateUserProfileCommand {
  readonly session: UsecaseSession;
  readonly accountId: unknown;
  readonly nickname?: unknown;
  readonly companyName?: unknown;
  readonly phone?: unknown;
  readonly contactEmail?: unknown;
}

/**
 * 管理员设置用户状态用例的执行入参（P0-5）。
 *
 * `status` 刻意保持 `unknown`：`ACTIVE` / `INACTIVE` 白名单由
 * `normalizeAdminUserWritableStatus()` 统一裁决，`PENDING` / `SUSPENDED` / `BANNED` /
 */
export interface AdminSetUserStatusCommand {
  readonly session: UsecaseSession;
  readonly accountId: unknown;
  readonly status?: unknown;
}

/**
 * 管理员重置普通用户密码用例的执行入参（P0-6）。
 *
 * - `accountId` 为目标账号 ID，语义上必填，类型刻意保持 `unknown`：协议 shape 由
 *   adapter 的 class-validator 负责，正整数收敛由 `normalizeAdminUserTargetAccountId()`
 *   统一裁决（标识符只校验、不修复），与 P0-4 / P0-5 同口径；
 * - `newPassword` 是**新密码明文**，只允许存在于本入参与用例局部变量，不得进入日志、
 *   错误文案、`DomainError.details` 或返回结果；「非空字符串」前置断言由
 *   `normalizeAdminUserPasswordInput()` 承担（刻意不 trim，理由见该函数注释），
 *   强度校验由 `PasswordPolicyService.validatePassword()` 单一路径承担，
 *   本类型不预设任何字段已经合法；
 * - 刻意不含旧密码、验证 token、验证记录 ID 或任何 verification 流程字段：管理员重置
 *   第 1 项），本入参的形状本身就在结构上禁止把公开流程参数透传进来。
 */
export interface AdminResetUserPasswordCommand {
  readonly session: UsecaseSession;
  readonly accountId: unknown;
  readonly newPassword?: unknown;
}

/**
 * 管理员把普通用户密码重置为系统默认密码的执行入参（任务 08.4）。
 *
 * - `accountId` 与旧重置同口径：语义必填，类型保持 `unknown`，正整数收敛由
 *   `normalizeAdminUserTargetAccountId()` 统一裁决；
 * - **不含**新密码字段：默认密码只来自运行期配置，绝不接受客户端自报，
 *   因此本类型在结构上禁止把任意密码写入目标账号。
 */
export interface AdminResetUserPasswordToDefaultCommand {
  readonly session: UsecaseSession;
  readonly accountId: unknown;
}

/**
 * 管理员重置普通用户密码用例的执行结果（P0-6）。
 *
 * 只含目标账号 ID、是否执行了更新与固定安全提示三项；**严禁**出现新密码、旧密码、
 * `notice` 文案由用例单点持有，不是调用方可控的自由文本，防止任何动态内容经该字段外泄。
 *
 * 「事务成功提交」这一用例级事实，而非逐行受影响计数：`updateAccountPasswordHash()`
 * 返回 `void`、未暴露受影响行数，本轮不为其扩展返回值（会波及注册 / 公开重置等
 * 全部既有调用方，超出 P0-6 范围）；真实落库由后续独立测试计划端到端用例
 * 「重置后新密码可登录」覆盖。
 */
export interface AdminResetUserPasswordResult {
  readonly accountId: number;
  readonly isUpdated: boolean;
  readonly notice: string;
}

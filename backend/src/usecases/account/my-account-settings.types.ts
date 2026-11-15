// src/usecases/account/my-account-settings.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { SessionRestriction } from '@app-types/auth/session-restriction.types';
import type { MyAccountSettingsView } from '@src/modules/account/account.types';

/**
 * 当前用户账号设置用例（P1 读取 + P2 设置更新 + P3 自助改密）的执行契约。
 *
 * 依 `type.rules.md`：Usecase 与其调用 adapter 共享的执行输入/结果留在相邻 `*.types.ts`
 * （只有类型、无运行时值）；adapter 只能从本文件 type-only 导入，不得从 normalize 文件借类型
 * （eslint `no-adapter-types-from-usecase-implementations`）。
 *
 * P2 / P3 落地后，`updateMyAccountSettings` / `changeMyPassword` 的写入 Command 与 Outcome
 * 已随实现并入本文件，与读取契约同文件共享，不再有无生产者/消费者的孤儿契约。
 */

/**
 * 可信组织事实：由 Resolver 从请求期会话（`AuthenticatedSessionUser`）取出后传入，
 * 不得从 GraphQL 入参读取。`null` 表示该角色无唯一有效组织归属。
 */
export interface MyAccountTrustedOrganizationFacts {
  readonly customerOrganizationId: number | null;
  readonly engineerOrganizationId: number | null;
  readonly adminOrganizationId: number | null;
}

/**
 * 读取当前账号设置的命令：**只有 Session，没有任何目标账号 ID 参数**。
 *
 * 目标账号只能来自已认证 Session（GraphQL 不接收目标
 * 账号 ID）。`session.accountId` 是可信账号主键，由 Usecase 传入 QueryService 的窄读取方法；
 * 结构上不存在 `targetAccountId` 字段，比运行时校验更可靠地杜绝「读取他人设置」的越权入口。
 */
export interface GetMyAccountSettingsCommand {
  readonly session: UsecaseSession;
  /** 请求期会话解析出的可信组织归属，用于按当前角色解析可信公司名称 */
  readonly trustedOrganizations: MyAccountTrustedOrganizationFacts;
}

/**
 * 读取当前账号设置的结果：即稳定公开读视图 `MyAccountSettingsView` 本身。
 *
 * P1 读取场景没有额外的业务结果字段（不像 P2 更新需要表达 `isUpdated`），故 Outcome 与 View
 * 同形。刻意保留本别名而非让 Usecase 直接返回 `MyAccountSettingsView`：使「读用例的稳定产出」
 * 在本执行契约文件里显式可见，并与 P2/P3 将引入的、结构不同的写入 Outcome 命名对称。
 * View 不含 `accountId`（负责人要求「不暴露目标 accountId」），也不含密码 / Token / identityHint /
 * metaDigest / accessGroup / userState 等敏感或内部字段。
 */
export type GetMyAccountSettingsOutcome = MyAccountSettingsView;

/**
 * 账号设置更新（P2）的规范化输入：adapter 传入的七个白名单字段原值（unknown 形态，
 * 与 `AdminUserProfileUpdateNormalizeInput` 同口径），由
 * `normalizeMyAccountSettingsUpdateInput()` 收敛。
 */
export interface UpdateMyAccountSettingsNormalizeInput {
  readonly loginName: unknown;
  readonly loginEmail: unknown;
  readonly nickname: unknown;
  readonly realName: unknown;
  readonly companyName: unknown;
  readonly phone: unknown;
  readonly contactEmail: unknown;
}

/**
 * 账号设置更新（P2）的规范化输出——**严格三态**（`input-field-design.md` 第 4 节）：
 *
 * - `undefined`：调用方未提供该字段 → 不修改该列，不进入 patch；
 * - `null`：调用方明确提供空值 → 清空该列（凭据清空受「至少保留一个」约束；
 *   `nickname` 刻意没有 `null` 成员——必填字段不接受 null，输出类型在结构上排除它）；
 * - `string`：收敛后的新值（trim / NFKC / 长度 / 格式已通过场景规则）→ 设置该列。
 *
 * 「合并当前值后至少保留一个登录凭据」不是输入收敛职责（合并需要数据库当前值），
 * 由 Usecase 在锁内裁决；本输出只表达逐字段的三态意图。
 */
export interface UpdateMyAccountSettingsNormalizeOutput {
  readonly loginName: string | null | undefined;
  readonly loginEmail: string | null | undefined;
  readonly nickname: string | undefined;
  readonly realName: string | null | undefined;
  readonly companyName: string | null | undefined;
  readonly phone: string | null | undefined;
  readonly contactEmail: string | null | undefined;
}

/**
 * 账号设置更新（P2）的执行入参：Session + 七个白名单字段原值。
 *
 * **结构上不存在** `accountId` / `userId` / 角色 / 状态 / 密码字段——目标账号只能来自
 * 已认证 Session，与读取用例的 Command 同一约束；字段保持 `unknown`
 * 形态（与 `AdminUpdateUserProfileCommand` 同口径），合法性全部由场景 normalize 裁决，
 * 本类型不预设字段已合法。
 */
export interface UpdateMyAccountSettingsCommand {
  readonly session: UsecaseSession;
  /**
   * 本次请求复核后的会话限制状态（`ValidateAccessTokenSessionUsecase` 每请求计算）。
   *
   * 非 `NONE` 时只允许维护昵称、电话、联系邮箱三个本人字段；登录凭据与公司名称由
   * 服务端白名单整体拒绝（见 `UpdateMyAccountSettingsUsecase`）。该值只能来自已认证
   * 请求上下文，不得从 GraphQL 入参读取。
   */
  readonly restriction: SessionRestriction;
  /** 请求期会话解析出的可信组织归属，用于按当前角色解析可信公司名称 */
  readonly trustedOrganizations: MyAccountTrustedOrganizationFacts;
  readonly loginName: unknown;
  readonly loginEmail: unknown;
  readonly nickname: unknown;
  readonly realName: unknown;
  readonly companyName: unknown;
  readonly phone: unknown;
  readonly contactEmail: unknown;
}

/**
 * 账号设置更新（P2）的执行结果：`isUpdated` 表达本次是否发生任何落库
 * （全字段同值或未提供时不写库、返回当前 View 且 `isUpdated: false`），
 * `settings` 是写入后（或未变更时）的稳定公开读视图。
 */
export interface UpdateMyAccountSettingsOutcome {
  readonly isUpdated: boolean;
  readonly settings: MyAccountSettingsView;
}

/**
 * 自助修改密码（P3）的执行入参：Session + 当前密码 + 新密码。
 *
 * **结构上不存在**账号 ID 字段；两个字段保持 `unknown` 形态（与
 * `AdminResetUserPasswordCommand` 同口径），非空断言由场景 normalize 裁决且**不做 trim**——
 * trim 会静默改写秘密，掩盖策略层「首尾不能包含空格」的拒绝语义。
 * 前端确认密码只做表单一致性检查，不是持久化字段，本契约不收录。
 */
export interface ChangeMyPasswordCommand {
  readonly session: UsecaseSession;
  readonly currentPassword: unknown;
  readonly newPassword: unknown;
}

/**
 * 自助修改密码（P3）的执行结果：只含 `isUpdated` 与固定成功 `notice`。
 *
 * **严禁**出现当前密码、新密码、密码哈希或验证细节（与 `AdminResetUserPasswordResult`
 * 同一最小信息面）。`notice` 是固定文案，不声称服务端撤销了已签发 Token——旧 Access Token
 * 按 `JWT_EXPIRES_IN` 自然过期，前端收到成功结果后清除本地 Session 并跳转登录
 * （客户端会话收口）。
 */
export interface ChangeMyPasswordOutcome {
  readonly isUpdated: boolean;
  readonly notice: string;
}

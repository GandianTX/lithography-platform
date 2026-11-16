// src/modules/account/admin-account-reset.contract.ts

/**
 * 管理员默认密码重置的运行期配置（DI token + 归一化形状，任务 08.4）。
 *
 * 归属 account 模块的 boundary contract：值由模块级 provider factory（
 * `account-installer.module.ts`）从 `ConfigService` 读取并归一化后注入；
 * Usecase 只消费已归一化的 options，**不读** `ConfigService` / `process.env`
 * （`docs/common/modules.rules.md`）。
 *
 * `defaultPassword` 缺失即拒绝，不设代码默认值，避免把硬编码弱口令变成可用凭据。
 */
export interface AdminAccountResetOptions {
  readonly defaultPassword?: string;
}

export const ADMIN_ACCOUNT_RESET_OPTIONS = Symbol('ADMIN_ACCOUNT_RESET_OPTIONS');

// src/modules/account/account-installer.module.ts
import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  ADMIN_ACCOUNT_RESET_OPTIONS,
  type AdminAccountResetOptions,
} from './admin-account-reset.contract';
import { AccountModule } from './account.module';

/** 可注入的配置 Token（使用 Symbol 避免字符串冲突） */
export const IDENTITY_PRIORITY_TOKEN = Symbol('IDENTITY_PRIORITY_TOKEN');

/** 通用账号角色优先级（不再承载业务身份包优先级） */
export const DEFAULT_IDENTITY_PRIORITY = {
  fallback: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER],
  hintAutoPromote: false,
  hintAutoPromoteOnReactivate: false,
} as const;

/** 通过值推导的类型 */
export type IdentityPriorityConfig = typeof DEFAULT_IDENTITY_PRIORITY;

/** 从常量推导的身份键类型（避免手写联合类型） */
export type IdentityKey = (typeof DEFAULT_IDENTITY_PRIORITY.fallback)[number];

// eslint-disable-next-line @typescript-eslint/naming-convention
const IdentityPriorityProvider: Provider = {
  provide: IDENTITY_PRIORITY_TOKEN,
  useValue: DEFAULT_IDENTITY_PRIORITY,
};

/**
 * 管理员默认密码重置配置（任务 08.4）。
 *
 * 只在模块级 DI wiring 读取 `ConfigService`，把运行时配置归一化为
 * `AdminAccountResetOptions` 后经 token 注入；Usecase 不直接读取配置。
 * 缺失时**不提供默认值**：重置用例在运行期以 `DEFAULT_PASSWORD_NOT_CONFIGURED`
 * 失败关闭，避免把硬编码弱口令变成可用凭据。
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const AdminAccountResetOptionsProvider: Provider = {
  provide: ADMIN_ACCOUNT_RESET_OPTIONS,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AdminAccountResetOptions => ({
    defaultPassword: config.get<string>('adminAccountReset.defaultPassword'),
  }),
};

/**
 * 账户安装器模块（非全局）
 * - 只在这里调用一次 AccountModule.forRoot() 完成账号 base 装配
 * - 通过 re-export，让下游模块都能拿到 AccountModule 的导出（AccountService 等）
 * - 提供通用账号角色优先级配置，可通过 IDENTITY_PRIORITY_TOKEN 注入使用
 * - 提供管理员默认密码重置配置，可通过 ADMIN_ACCOUNT_RESET_OPTIONS 注入使用
 */
@Module({
  imports: [AccountModule.forRoot()],
  providers: [IdentityPriorityProvider, AdminAccountResetOptionsProvider],
  // 关键点：直接导出 AccountModule，本模块的下游即可获得它导出的账号 base provider
  exports: [AccountModule, IdentityPriorityProvider, AdminAccountResetOptionsProvider],
})
export class AccountInstallerModule {}

/*
用法示例（任意 Service 内）：
import { Inject, Injectable } from '@nestjs/common';
@Injectable()
class IdentityHintUpdater {
  constructor(
    @Inject(IDENTITY_PRIORITY_TOKEN)
    private readonly priority: IdentityPriorityConfig,
  ) {}
  // this.priority.fallback 可直接使用
}
*/

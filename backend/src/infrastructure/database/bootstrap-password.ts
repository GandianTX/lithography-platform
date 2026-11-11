import { PasswordPolicyService } from '@core/common/password/password-policy.service';

const passwordPolicy = new PasswordPolicyService();

/**
 * 初始化账号（管理员／开发样例）的统一密码前置校验。
 *
 * 复用登录与注册链路同一个 `PasswordPolicyService`，不另立“看起来复杂”的规则；
 * 错误信息只包含账号标签与策略原因，不回显密码本身。
 */
export function assertBootstrapPassword(label: string, password: string): void {
  const result = passwordPolicy.validatePassword(password);
  if (!result.isValid) {
    throw new Error(`${label} 的密码不符合项目密码策略：${result.errors.join('；')}`);
  }
}

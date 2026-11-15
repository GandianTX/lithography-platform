// src/features/account-settings/index.ts

/**
 * 账号设置 feature 的公开出口：跨模块引用只允许经由本文件，
 * 页面装配层从这里取面板组件，不深入 feature 内部结构。
 */

export type {
  AccountSettingsView,
  ChangePasswordSessionIdentity,
} from './application/account-settings.types';
export { useAccountSettings } from './application/use-account-settings';
export { AccountProfileForm } from './ui/account-profile-form';
export { AccountSettingsPanel } from './ui/account-settings-panel';
export { ChangePasswordForm } from './ui/change-password-form';

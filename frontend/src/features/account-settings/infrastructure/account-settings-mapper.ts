// src/features/account-settings/infrastructure/account-settings-mapper.ts

/**
 * 账号设置 feature 的 GraphQL DTO → feature 内部模型 mapper（防腐层）。
 * 职责：字段归一（可选文本 trim 与空值兜底）、枚举守卫、结构映射；
 * 不承载业务规则与流程编排。application 只消费本文件的输出，不接触原始 DTO。
 */

import type {
  AccountSettingsRole,
  AccountSettingsStatus,
  AccountSettingsView,
} from '../application/account-settings.types';
import {
  ACCOUNT_SETTINGS_ROLES,
  ACCOUNT_SETTINGS_STATUSES,
} from '../application/account-settings.types';

import type { MyAccountSettingsDto } from './account-settings.dto';

/**
 * 可选文本归一：空串、纯空白与非字符串一律归 null，不让脏值流入内部模型。
 */
function toOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 枚举守卫（失败关闭）：后端契约保证 role / status 是枚举值，
 * 但 mapper 不信任外部数据——无法识别的值让整次映射失败，而不是降级成错误展示。
 */
function isKnownRole(value: unknown): value is AccountSettingsRole {
  return typeof value === 'string' && (ACCOUNT_SETTINGS_ROLES as readonly string[]).includes(value);
}

function toKnownRole(value: unknown): AccountSettingsRole {
  if (!isKnownRole(value)) {
    throw new Error('账号设置返回了无法识别的角色。');
  }

  return value;
}

function isKnownStatus(value: unknown): value is AccountSettingsStatus {
  return (
    typeof value === 'string' && (ACCOUNT_SETTINGS_STATUSES as readonly string[]).includes(value)
  );
}

function toKnownStatus(value: unknown): AccountSettingsStatus {
  if (!isKnownStatus(value)) {
    throw new Error('账号设置返回了无法识别的状态。');
  }

  return value;
}

/**
 * 等级归一（失败关闭）：null 表示未设置；仅接受有限整数，其他类型 / 小数 /
 * 非有限值一律让整次映射失败，不降级成错误展示。
 */
function toAdminLevel(value: unknown): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  throw new Error('账号设置返回了无法识别的等级。');
}

export function mapMyAccountSettingsDtoToView(dto: MyAccountSettingsDto): AccountSettingsView {
  const nickname = typeof dto.nickname === 'string' ? dto.nickname.trim() : '';

  if (!nickname) {
    throw new Error('账号设置返回了缺失的昵称。');
  }

  return {
    adminLevel: toAdminLevel(dto.adminLevel),
    companyName: toOptionalText(dto.companyName),
    contactEmail: toOptionalText(dto.contactEmail),
    loginEmail: toOptionalText(dto.loginEmail),
    loginName: toOptionalText(dto.loginName),
    nickname,
    phone: toOptionalText(dto.phone),
    realName: toOptionalText(dto.realName),
    role: toKnownRole(dto.role),
    status: toKnownStatus(dto.status),
    trustedCompanyName: toOptionalText(dto.trustedCompanyName),
    updatedAt: dto.updatedAt,
  };
}

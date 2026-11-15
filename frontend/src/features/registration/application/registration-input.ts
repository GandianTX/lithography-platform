// src/features/registration/application/registration-input.ts

/**
 * 客户 / 工程师注册共用的输入归一与提交门槛。
 *
 * 两类注册的可选字段处理与「服务端显式失败」判据完全一致；集中在本文件，
 * 避免两个 application 模块各写一份而漂移。公司分支差异仍留在各自模块。
 */

import { translateNow } from '@/shared/i18n';

/** 可选文本：去首尾空白，空白视为未填（undefined 表示不下发该字段） */
export function normalizeOptionalText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 服务端显式失败（success=false）统一抛出，由文案映射统一收敛 */
export function assertRegistrationSucceeded(result: { message: string; success: boolean }): void {
  if (!result.success) {
    throw new Error(result.message || translateNow('register.failed'));
  }
}

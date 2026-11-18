// src/usecases/account/supplement-my-customer-company.normalize.ts

import { DomainError, MY_ACCOUNT_ERROR } from '@core/common/errors/domain-error';
import type { CustomerCompanySupplementChoice } from './supplement-my-customer-company.types';

/** 公司名称长度上限（与 `organization.name` / `base_user_info.company_name` 列长一致） */
export const COMPANY_NAME_MAX_LENGTH = 100;

/**
 * 二选一输入收敛：`organizationId` 与 `organizationName` 必须恰好提供一个。
 *
 * 显式 `null` 与缺省都表示未提供；同时提供（含手填纯空白后再提供 ID）与都不提供
 * 一律 `BAD_USER_INPUT`，不猜测用户意图。
 */
export function resolveCompanyChoice(input: {
  organizationId: unknown;
  organizationName: unknown;
}): CustomerCompanySupplementChoice {
  const hasOrganizationId = input.organizationId !== undefined && input.organizationId !== null;
  const hasOrganizationName =
    input.organizationName !== undefined &&
    input.organizationName !== null &&
    !(typeof input.organizationName === 'string' && input.organizationName.trim().length === 0);

  if (hasOrganizationId && hasOrganizationName) {
    throw new DomainError(
      MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID,
      '只能选择名单内公司或手填公司名称，二者不能同时提交',
    );
  }
  if (hasOrganizationId) {
    if (
      typeof input.organizationId !== 'number' ||
      !Number.isInteger(input.organizationId) ||
      input.organizationId <= 0
    ) {
      throw new DomainError(MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID, '公司 ID 无效');
    }
    return { kind: 'EXISTING', organizationId: input.organizationId };
  }
  if (hasOrganizationName) {
    if (typeof input.organizationName !== 'string') {
      throw new DomainError(
        MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID,
        '公司名称必须是字符串',
      );
    }
    const normalized = input.organizationName.trim();
    if (normalized.length === 0) {
      throw new DomainError(MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID, '请输入公司名称');
    }
    if (normalized.length > COMPANY_NAME_MAX_LENGTH) {
      throw new DomainError(
        MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID,
        `公司名称不能超过 ${COMPANY_NAME_MAX_LENGTH} 个字符`,
      );
    }
    return { kind: 'SELF_FILLED', organizationName: normalized };
  }
  throw new DomainError(
    MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID,
    '请选择名单内公司或填写公司名称',
  );
}

/** 同名比较归一化：去首尾空白、连续空白合并、统一小写；不改变落库原值 */
export function normalizeCompanyNameForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

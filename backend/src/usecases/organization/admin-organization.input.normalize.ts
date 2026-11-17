// src/usecases/organization/admin-organization.input.normalize.ts

import { DomainError, INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import type {
  CreateManagedCompanyData,
  OrganizationStatus,
  UpdateManagedCompanyPatch,
} from '@src/modules/lithography/organization.types';

/** 字段长度上限与实体列定义保持一致 */
export const ADMIN_ORGANIZATION_NAME_MAX_LENGTH = 200;
export const ADMIN_ORGANIZATION_SHORT_NAME_MAX_LENGTH = 100;
export const ADMIN_ORGANIZATION_CONTACT_NAME_MAX_LENGTH = 200;
export const ADMIN_ORGANIZATION_CONTACT_PHONE_MAX_LENGTH = 100;
export const ADMIN_ORGANIZATION_CONTACT_EMAIL_MAX_LENGTH = 254;
export const ADMIN_ORGANIZATION_ADDRESS_MAX_LENGTH = 1000;
/** `remark` 列为 text，无数据库上限；用例层加管理端可接受的长度护栏 */
export const ADMIN_ORGANIZATION_REMARK_MAX_LENGTH = 2000;
/** 公司列表 / 名称名单关键字上限 */
export const ADMIN_ORGANIZATION_KEYWORD_MAX_LENGTH = 100;
/** 二级管理员凭据重置原因上限（管理端备注级文案） */
export const ADMIN_CREDENTIAL_RESET_REASON_MAX_LENGTH = 200;

const ORGANIZATION_STATUSES: readonly OrganizationStatus[] = ['ACTIVE', 'DISABLED'];

/** 仅做基础格式校验：任务要求邮箱不限制企业域，也不做域名白名单 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 公司关键字：去首尾空白；空白视为未填；非字符串或超长拒绝（不静默截断）。
 *
 * 名称名单（S1）与完整列表（S2）共用同一口径。
 */
export function normalizeOrganizationKeyword(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '公司名称 必须是字符串', {
      field: 'keyword',
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > ADMIN_ORGANIZATION_KEYWORD_MAX_LENGTH) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `公司名称最多 ${ADMIN_ORGANIZATION_KEYWORD_MAX_LENGTH} 个字符`,
      { field: 'keyword' },
    );
  }
  return trimmed;
}

/** 目标主键：必须为正整数，不接受字符串或浮点 */
export function normalizeOrganizationId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '公司 ID 必须是正整数', {
      field: 'organizationId',
    });
  }
  return value;
}

/** 目标账号主键：必须为正整数，不接受字符串或浮点 */
export function normalizeAccountId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '管理员账号 ID 必须是正整数', {
      field: 'adminAccountId',
    });
  }
  return value;
}

/** 必填文本：必须是字符串，trim 后非空，且不超过上限 */
export function normalizeRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  label: string,
): string {
  if (typeof value !== 'string') {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, `${label}必须是字符串`, {
      field,
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY, `${label}不能为空`, {
      field,
    });
  }
  if (trimmed.length > maxLength) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, `${label}最多 ${maxLength} 个字符`, {
      field,
    });
  }
  return trimmed;
}

/**
 * 可选文本：缺省 / null / 空白都归一为 null；否则 trim 后返回。
 *
 * 更新语义由调用方区分「键缺省 = 不修改」与「显式 null / 空白 = 清空」：
 * 本函数只负责把已提供的值收敛为 null 或非空字符串。
 */
export function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
  label: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, `${label}必须是字符串`, {
      field,
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, `${label}最多 ${maxLength} 个字符`, {
      field,
    });
  }
  return trimmed;
}

/** 可选邮箱：先按可选文本收敛，非空时再做格式校验 */
export function normalizeOptionalEmail(value: unknown): string | null {
  const email = normalizeOptionalText(
    value,
    'contactEmail',
    ADMIN_ORGANIZATION_CONTACT_EMAIL_MAX_LENGTH,
    '公司邮箱',
  );
  if (email !== null && !EMAIL_PATTERN.test(email)) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '公司邮箱格式不正确', {
      field: 'contactEmail',
    });
  }
  return email;
}

/** 状态：只接受 ACTIVE / DISABLED */
export function normalizeOrganizationStatus(value: unknown): OrganizationStatus {
  if (typeof value !== 'string' || !ORGANIZATION_STATUSES.includes(value as OrganizationStatus)) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE, '公司状态无效', {
      field: 'status',
    });
  }
  return value as OrganizationStatus;
}

/** 布尔开关：只接受真正的布尔值，不接受字符串或数字 */
export function normalizeBooleanFlag(value: unknown, field: string, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, `${label}必须是布尔值`, {
      field,
    });
  }
  return value;
}

/**
 * 新增公司输入收敛：全称与联系电话必填，其余可选，维修资格缺省为 false，
 * 状态缺省 `ACTIVE`（保留未传默认启用的兼容语义），显式传入只接受 ACTIVE / DISABLED。
 */
export function normalizeAdminOrganizationCreateInput(raw: {
  name: unknown;
  contactPhone: unknown;
  shortName?: unknown;
  contactName?: unknown;
  contactEmail?: unknown;
  address?: unknown;
  remark?: unknown;
  status?: unknown;
  isServiceProvider?: unknown;
}): CreateManagedCompanyData {
  return {
    name: normalizeRequiredText(raw.name, 'name', ADMIN_ORGANIZATION_NAME_MAX_LENGTH, '公司全称'),
    contactPhone: normalizeRequiredText(
      raw.contactPhone,
      'contactPhone',
      ADMIN_ORGANIZATION_CONTACT_PHONE_MAX_LENGTH,
      '联系电话',
    ),
    shortName: normalizeOptionalText(
      raw.shortName,
      'shortName',
      ADMIN_ORGANIZATION_SHORT_NAME_MAX_LENGTH,
      '公司简称',
    ),
    contactName: normalizeOptionalText(
      raw.contactName,
      'contactName',
      ADMIN_ORGANIZATION_CONTACT_NAME_MAX_LENGTH,
      '联系人姓名',
    ),
    contactEmail: normalizeOptionalEmail(raw.contactEmail),
    address: normalizeOptionalText(
      raw.address,
      'address',
      ADMIN_ORGANIZATION_ADDRESS_MAX_LENGTH,
      '地址',
    ),
    remark: normalizeOptionalText(
      raw.remark,
      'remark',
      ADMIN_ORGANIZATION_REMARK_MAX_LENGTH,
      '备注',
    ),
    status:
      raw.status === undefined || raw.status === null
        ? 'ACTIVE'
        : normalizeOrganizationStatus(raw.status),
    isServiceProvider:
      raw.isServiceProvider === undefined
        ? false
        : normalizeBooleanFlag(raw.isServiceProvider, 'isServiceProvider', '提供维修服务'),
  };
}

/**
 * 编辑公司输入收敛：只产出白名单补丁。
 *
 * - 键缺省（`undefined`）= 不修改；
 * - 可选文本显式 `null` 或纯空白 = 清空；
 * - 全称 / 联系电话若提供则 trim 后必须非空；
 * - 编号、受管归类、类别不在补丁内，调用方无法通过任何输入改写。
 */
export function normalizeAdminOrganizationUpdateInput(raw: {
  organizationId: unknown;
  name?: unknown;
  contactPhone?: unknown;
  shortName?: unknown;
  contactName?: unknown;
  contactEmail?: unknown;
  address?: unknown;
  remark?: unknown;
  status?: unknown;
  isServiceProvider?: unknown;
}): { organizationId: number; patch: UpdateManagedCompanyPatch } {
  const patch: {
    name?: string;
    shortName?: string | null;
    contactName?: string | null;
    contactPhone?: string;
    contactEmail?: string | null;
    address?: string | null;
    remark?: string | null;
    status?: OrganizationStatus;
    isServiceProvider?: boolean;
  } = {};

  if (raw.name !== undefined) {
    patch.name = normalizeRequiredText(
      raw.name,
      'name',
      ADMIN_ORGANIZATION_NAME_MAX_LENGTH,
      '公司全称',
    );
  }
  if (raw.contactPhone !== undefined) {
    patch.contactPhone = normalizeRequiredText(
      raw.contactPhone,
      'contactPhone',
      ADMIN_ORGANIZATION_CONTACT_PHONE_MAX_LENGTH,
      '联系电话',
    );
  }
  if (raw.shortName !== undefined) {
    patch.shortName = normalizeOptionalText(
      raw.shortName,
      'shortName',
      ADMIN_ORGANIZATION_SHORT_NAME_MAX_LENGTH,
      '公司简称',
    );
  }
  if (raw.contactName !== undefined) {
    patch.contactName = normalizeOptionalText(
      raw.contactName,
      'contactName',
      ADMIN_ORGANIZATION_CONTACT_NAME_MAX_LENGTH,
      '联系人姓名',
    );
  }
  if (raw.contactEmail !== undefined) {
    patch.contactEmail = normalizeOptionalEmail(raw.contactEmail);
  }
  if (raw.address !== undefined) {
    patch.address = normalizeOptionalText(
      raw.address,
      'address',
      ADMIN_ORGANIZATION_ADDRESS_MAX_LENGTH,
      '地址',
    );
  }
  if (raw.remark !== undefined) {
    patch.remark = normalizeOptionalText(
      raw.remark,
      'remark',
      ADMIN_ORGANIZATION_REMARK_MAX_LENGTH,
      '备注',
    );
  }
  if (raw.status !== undefined) {
    patch.status = normalizeOrganizationStatus(raw.status);
  }
  if (raw.isServiceProvider !== undefined) {
    patch.isServiceProvider = normalizeBooleanFlag(
      raw.isServiceProvider,
      'isServiceProvider',
      '提供维修服务',
    );
  }

  return {
    organizationId: normalizeOrganizationId(raw.organizationId),
    patch,
  };
}

// src/features/admin-user-management/infrastructure/admin-user-management-mapper.ts

/**
 * 管理员用户管理的 GraphQL DTO → feature 内部模型 mapper（防腐层）。
 * 职责：字段归一（可选文本 trim 与空值兜底）、枚举守卫、结构映射；
 * 不承载业务规则与流程编排。application 只消费本文件的输出，不接触原始 DTO。
 */

import type {
  AdminBoundLevelTwoAdmin,
  AdminBoundLevelTwoAdminPage,
  AdminLevelTwoCredentialResult,
  AdminUserListPage,
  AdminUserRole,
  AdminUserRow,
} from '../application/admin-user-management.types';

import type {
  AdminBoundLevelTwoAdminDto,
  AdminBoundLevelTwoAdminPageDto,
  AdminLevelTwoCredentialResultDto,
  AdminUserDto,
  AdminUserListPageDto,
} from './admin-user-management.dto';

const KNOWN_ROLES: readonly AdminUserRole[] = ['SUPER_ADMIN', 'ENGINEER', 'CUSTOMER'];

/**
 * 可选文本归一：空串、纯空白与非字符串一律归 null，不让脏值流入内部模型。
 * 除 DTO 映射外，adapter 的错误 extensions 细节归一共用本函数。
 */
export function toOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 角色枚举守卫（失败关闭）：后端契约保证 role 是 IdentityTypeEnum，
 * 但 mapper 不信任外部数据——无法识别的值让整次映射失败，而不是降级成错误展示。
 */
function isKnownRole(value: string): value is AdminUserRole {
  return (KNOWN_ROLES as readonly string[]).includes(value);
}

function toKnownRole(value: unknown): AdminUserRole {
  if (typeof value === 'string' && isKnownRole(value)) {
    return value;
  }

  throw new Error('管理员用户数据返回了无法识别的角色。');
}

export function mapAdminUserDtoToRow(dto: AdminUserDto): AdminUserRow {
  return {
    accountId: dto.id,
    companyName: toOptionalText(dto.companyName),
    contactEmail: toOptionalText(dto.contactEmail),
    createdAt: dto.createdAt,
    loginEmail: toOptionalText(dto.loginEmail),
    loginName: toOptionalText(dto.loginName),
    nickname: dto.nickname,
    phone: toOptionalText(dto.phone),
    role: toKnownRole(dto.role),
    status: dto.status,
    updatedAt: dto.updatedAt,
  };
}

export function mapAdminUserListPageDtoToListPage(dto: AdminUserListPageDto): AdminUserListPage {
  return {
    items: dto.items.map((item) => mapAdminUserDtoToRow(item)),
    page: dto.page,
    pageSize: dto.pageSize,
    total: dto.total,
  };
}

export function mapAdminBoundLevelTwoAdminDto(
  dto: AdminBoundLevelTwoAdminDto,
): AdminBoundLevelTwoAdmin {
  return {
    accountDisabled: dto.accountDisabled === true,
    accountId: dto.accountId,
    companyName: dto.companyName,
    companyStatus: dto.companyStatus,
    loginName: dto.loginName,
    nickname: toOptionalText(dto.nickname),
    organizationCode: dto.organizationCode,
    organizationId: dto.organizationId,
  };
}

export function mapAdminBoundLevelTwoAdminPageDto(
  dto: AdminBoundLevelTwoAdminPageDto,
): AdminBoundLevelTwoAdminPage {
  return {
    items: dto.items.map((item) => mapAdminBoundLevelTwoAdminDto(item)),
    page: dto.page,
    pageSize: dto.pageSize,
    total: dto.total,
  };
}

/**
 * 凭据结果守卫：口令缺失或空白一律让本次映射失败（而不是展示空口令），
 * 避免一次异常响应被当成「成功但无凭据」而误导管理员。
 */
export function mapAdminLevelTwoCredentialResultDto(
  dto: AdminLevelTwoCredentialResultDto,
): AdminLevelTwoCredentialResult {
  const temporaryPassword = toOptionalText(dto.temporaryPassword);

  if (temporaryPassword === null) {
    throw new Error('二级管理员凭据结果缺少临时密码。');
  }

  return {
    adminAccountId: dto.adminAccountId,
    loginName: dto.loginName,
    mustChangePassword: dto.mustChangePassword === true,
    nickname: toOptionalText(dto.nickname),
    organizationId: dto.organizationId,
    temporaryPassword,
  };
}

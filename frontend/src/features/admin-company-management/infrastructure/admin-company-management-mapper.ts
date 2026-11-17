// src/features/admin-company-management/infrastructure/admin-company-management-mapper.ts

/**
 * 公司档案管理的 GraphQL DTO → feature 内部模型 mapper（防腐层）。
 * 职责：字段归一（可选文本 trim 与空值兜底）、枚举守卫、结构映射；
 * 不承载业务规则与流程编排。application 只消费本文件的输出，不接触原始 DTO。
 */

import type {
  AdminCompanyAdminAccountDetail,
  AdminCompanyAdminBinding,
  AdminCompanyAdminBindingStatus,
  AdminCompanyCredentialResult,
  AdminCompanyListPage,
  AdminCompanyNameOption,
  AdminCompanyProvisionResult,
  AdminCompanyRow,
  AdminOrganizationKind,
  AdminOrganizationStatus,
} from '../application/admin-company-management.types';

import type {
  AdminCompanyAdminAccountDetailDto,
  AdminCompanyAdminBindingDto,
  AdminCompanyProvisioningResultDto,
  AdminLevelTwoCredentialResultDto,
  AdminOrganizationDto,
  AdminOrganizationNameDto,
  AdminOrganizationNamePageDto,
  AdminOrganizationPageDto,
} from './admin-company-management.dto';

const KNOWN_STATUSES: readonly AdminOrganizationStatus[] = ['ACTIVE', 'DISABLED'];
const KNOWN_KINDS: readonly AdminOrganizationKind[] = ['CLIENT', 'PEER'];
const KNOWN_BINDING_STATUSES: readonly AdminCompanyAdminBindingStatus[] = [
  'BOUND',
  'UNCONFIGURED',
  'CONFLICT',
  'COMPANY_DISABLED',
];

/** 可选文本归一：空串、纯空白与非字符串一律归 null，不让脏值流入内部模型 */
export function toOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 枚举守卫（失败关闭）：后端契约保证值域，但 mapper 不信任外部数据，
 * 无法识别的值让整次映射失败，而不是降级成错误展示。
 */
function toKnownStatus(value: unknown): AdminOrganizationStatus {
  if (typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)) {
    return value as AdminOrganizationStatus;
  }

  throw new Error('公司档案数据返回了无法识别的状态。');
}

function toKnownKind(value: unknown): AdminOrganizationKind {
  if (typeof value === 'string' && (KNOWN_KINDS as readonly string[]).includes(value)) {
    return value as AdminOrganizationKind;
  }

  throw new Error('公司档案数据返回了无法识别的类别。');
}

export function mapAdminOrganizationDtoToRow(dto: AdminOrganizationDto): AdminCompanyRow {
  return {
    organizationId: dto.id,
    organizationCode: dto.organizationCode,
    name: dto.name,
    shortName: toOptionalText(dto.shortName),
    contactName: toOptionalText(dto.contactName),
    contactPhone: toOptionalText(dto.contactPhone),
    contactEmail: toOptionalText(dto.contactEmail),
    address: toOptionalText(dto.address),
    remark: toOptionalText(dto.remark),
    isServiceProvider: dto.isServiceProvider,
    isManagedCompany: dto.isManagedCompany,
    kind: toKnownKind(dto.kind),
    status: toKnownStatus(dto.status),
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

export function mapAdminOrganizationPageDtoToListPage(
  dto: AdminOrganizationPageDto,
): AdminCompanyListPage {
  return {
    kind: 'full',
    items: dto.items.map((item) => mapAdminOrganizationDtoToRow(item)),
    page: dto.page,
    pageSize: dto.pageSize,
    total: dto.total,
  };
}

function mapNameOption(dto: AdminOrganizationNameDto): AdminCompanyNameOption {
  return { id: dto.id, name: dto.name };
}

export function mapAdminOrganizationNamePageDtoToListPage(
  dto: AdminOrganizationNamePageDto,
): AdminCompanyListPage {
  return {
    kind: 'name',
    items: dto.items.map((item) => mapNameOption(item)),
    page: dto.page,
    pageSize: dto.pageSize,
    total: dto.total,
  };
}

function toKnownBindingStatus(value: unknown): AdminCompanyAdminBindingStatus {
  if (typeof value === 'string' && (KNOWN_BINDING_STATUSES as readonly string[]).includes(value)) {
    return value as AdminCompanyAdminBindingStatus;
  }

  throw new Error('公司绑定数据返回了无法识别的状态。');
}

/** 绑定事实：只映射安全字段，`boundLoginNameMasked` 之外的登录名一律不进入内部模型 */
export function mapAdminCompanyAdminBindingDto(
  dto: AdminCompanyAdminBindingDto,
): AdminCompanyAdminBinding {
  return {
    organizationId: dto.organizationId,
    organizationCode: dto.organizationCode,
    companyName: dto.companyName,
    isManagedCompany: dto.isManagedCompany,
    companyStatus: toKnownStatus(dto.companyStatus),
    status: toKnownBindingStatus(dto.status),
    reason: toOptionalText(dto.reason),
    boundAccountId: typeof dto.boundAccountId === 'number' ? dto.boundAccountId : null,
    boundLoginNameMasked: toOptionalText(dto.boundLoginNameMasked),
    candidateCount: typeof dto.candidateCount === 'number' ? dto.candidateCount : 0,
    accountDisabled: dto.accountDisabled === true,
  };
}

/** 账号详情：同绑定事实口径，账号字段只在唯一合法绑定时透出，其余保持 null */
export function mapAdminCompanyAdminAccountDetailDto(
  dto: AdminCompanyAdminAccountDetailDto,
): AdminCompanyAdminAccountDetail {
  return {
    organizationId: dto.organizationId,
    organizationCode: dto.organizationCode,
    companyName: dto.companyName,
    isManagedCompany: dto.isManagedCompany,
    companyStatus: toKnownStatus(dto.companyStatus),
    status: toKnownBindingStatus(dto.status),
    reason: toOptionalText(dto.reason),
    accountId: typeof dto.accountId === 'number' ? dto.accountId : null,
    loginName: toOptionalText(dto.loginName),
    nickname: toOptionalText(dto.nickname),
    mustChangePassword: typeof dto.mustChangePassword === 'boolean' ? dto.mustChangePassword : null,
    accountDisabled: dto.accountDisabled === true,
    candidateCount: typeof dto.candidateCount === 'number' ? dto.candidateCount : 0,
  };
}

/** 新增公司结果：回放时 `temporaryPassword` 必须为空，不因外部脏值把口令带出 */
export function mapAdminCompanyProvisioningResultDto(
  dto: AdminCompanyProvisioningResultDto,
): Extract<AdminCompanyProvisionResult, { ok: true }> {
  return {
    ok: true,
    organization: mapAdminOrganizationDtoToRow(dto.organization),
    provisionedAdmin: {
      accountId: dto.provisionedAdmin.accountId,
      loginName: dto.provisionedAdmin.loginName,
      nickname: dto.provisionedAdmin.nickname,
      mustChangePassword: dto.provisionedAdmin.mustChangePassword,
    },
    submission: {
      submissionId: dto.submission?.submissionId ?? null,
      replayed: dto.submission?.replayed === true,
    },
    temporaryPassword: toOptionalText(dto.temporaryPassword),
  };
}

/** 补发 / 重置结果：成功响应必须带可用临时密码，缺失按契约破坏失败关闭 */
export function mapAdminLevelTwoCredentialResultDto(
  dto: AdminLevelTwoCredentialResultDto,
): Extract<AdminCompanyCredentialResult, { ok: true }> {
  const temporaryPassword = toOptionalText(dto.temporaryPassword);

  if (temporaryPassword === null) {
    throw new Error('凭据结果缺少临时密码。');
  }

  return {
    ok: true,
    organizationId: dto.organizationId,
    adminAccountId: dto.adminAccountId,
    loginName: dto.loginName,
    nickname: toOptionalText(dto.nickname),
    mustChangePassword: dto.mustChangePassword === true,
    temporaryPassword,
  };
}

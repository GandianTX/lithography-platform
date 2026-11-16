// src/features/admin-company-management/infrastructure/admin-company-management-mapper.ts

/**
 * 公司档案管理的 GraphQL DTO → feature 内部模型 mapper（防腐层）。
 * 职责：字段归一（可选文本 trim 与空值兜底）、枚举守卫、结构映射；
 * 不承载业务规则与流程编排。application 只消费本文件的输出，不接触原始 DTO。
 */

import type {
  AdminCompanyListPage,
  AdminCompanyNameOption,
  AdminCompanyRow,
  AdminOrganizationKind,
  AdminOrganizationStatus,
} from '../application/admin-company-management.types';

import type {
  AdminOrganizationDto,
  AdminOrganizationNameDto,
  AdminOrganizationNamePageDto,
  AdminOrganizationPageDto,
} from './admin-company-management.dto';

const KNOWN_STATUSES: readonly AdminOrganizationStatus[] = ['ACTIVE', 'DISABLED'];
const KNOWN_KINDS: readonly AdminOrganizationKind[] = ['CLIENT', 'PEER'];

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

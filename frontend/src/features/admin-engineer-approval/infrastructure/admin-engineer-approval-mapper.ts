// src/features/admin-engineer-approval/infrastructure/admin-engineer-approval-mapper.ts

/**
 * 工程师注册审批的 GraphQL DTO → feature 内部模型 mapper（防腐层）。
 * 职责：字段归一（可选文本 trim 与空值兜底）、枚举守卫、结构映射；
 * 不承载业务规则与流程编排。application 只消费本文件的输出，不接触原始 DTO。
 */

import type {
  AdminEngineerRegistrationDetail,
  AdminEngineerRegistrationListPage,
  AdminEngineerRegistrationRow,
  AdminEngineerRegistrationStatus,
} from '../application/admin-engineer-approval.types';

import type {
  AdminEngineerRegistrationApplicationDto,
  AdminEngineerRegistrationDetailDto,
  AdminEngineerRegistrationItemDto,
  AdminEngineerRegistrationPageDto,
} from './admin-engineer-approval.dto';

const KNOWN_STATUSES: readonly AdminEngineerRegistrationStatus[] = [
  'APPROVED',
  'PENDING',
  'REJECTED',
];

/** 可选文本归一：空串、纯空白与非字符串一律归 null，不让脏值流入内部模型 */
export function toOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 枚举守卫（失败关闭）：后端契约保证值域，但 mapper 不信任外部数据，
 * 无法识别的值让整次映射失败，而不是降级成错误展示。
 */
function toKnownStatus(value: unknown): AdminEngineerRegistrationStatus {
  if (typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)) {
    return value as AdminEngineerRegistrationStatus;
  }

  throw new Error('注册申请数据返回了无法识别的状态。');
}

/** 申请事实归一（列表行与详情共用同一口径） */
function toApplicationFacts(application: AdminEngineerRegistrationApplicationDto) {
  return {
    applicationId: application.id,
    accountId: application.accountId,
    organizationId: application.organizationId,
    status: toKnownStatus(application.status),
    applicationNote: toOptionalText(application.applicationNote),
    submittedAt: application.submittedAt,
    reviewedAt: application.reviewedAt,
    reviewComment: toOptionalText(application.reviewComment),
  };
}

function toApplicationRow(
  application: AdminEngineerRegistrationApplicationDto,
  item: AdminEngineerRegistrationItemDto,
): AdminEngineerRegistrationRow {
  return {
    ...toApplicationFacts(application),
    organizationName: toOptionalText(item.organizationName),
    applicant: {
      nickname: item.applicant.nickname,
      loginName: toOptionalText(item.applicant.loginName),
      loginEmail: toOptionalText(item.applicant.loginEmail),
      phone: toOptionalText(item.applicant.phone),
      contactEmail: toOptionalText(item.applicant.contactEmail),
      companyName: toOptionalText(item.applicant.companyName),
    },
  };
}

export function mapAdminEngineerRegistrationItemDtoToRow(
  item: AdminEngineerRegistrationItemDto,
): AdminEngineerRegistrationRow {
  return toApplicationRow(item.application, item);
}

/**
 * 详情 DTO → 详情模型。
 * `realName` 空串 / 空白归 null，保持「未知」语义；绝不回填昵称，避免用昵称冒充真实姓名。
 */
export function mapAdminEngineerRegistrationDetailDtoToDetail(
  dto: AdminEngineerRegistrationDetailDto,
): AdminEngineerRegistrationDetail {
  return {
    ...toApplicationFacts(dto.application),
    organizationName: toOptionalText(dto.organizationName),
    applicant: {
      id: dto.applicant.id,
      loginName: toOptionalText(dto.applicant.loginName),
      nickname: dto.applicant.nickname,
      realName: toOptionalText(dto.applicant.realName),
      phone: toOptionalText(dto.applicant.phone),
      contactEmail: toOptionalText(dto.applicant.contactEmail),
    },
  };
}

export function mapAdminEngineerRegistrationPageDtoToListPage(
  dto: AdminEngineerRegistrationPageDto,
): AdminEngineerRegistrationListPage {
  return {
    items: dto.items.map((item) => mapAdminEngineerRegistrationItemDtoToRow(item)),
    page: dto.page,
    pageSize: dto.pageSize,
    total: dto.total,
  };
}

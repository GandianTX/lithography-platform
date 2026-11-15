// src/features/admin-company-management/infrastructure/admin-company-adapter.ts

/**
 * 公司档案管理的 GraphQL adapter（外部技术边界唯一落点）。
 *
 * - 复用 shared/graphql 的 executeGraphQL（Apollo client、Token 注入、ingress 错误模型），
 *   不创建第二个 Apollo Client，不直接 fetch /graphql；
 * - 原始 DTO 与 operation 只停留在本目录；对外返回 feature 内部模型或显式业务结果；
 * - 业务拒绝按稳定的 extensions.code 大类映射为显式失败结果（不依赖生产可能隐藏的
 *   extensions.errorCode）；transport / auth / 网络类失败仍上抛 GraphQLIngressError，
 *   UNAUTHENTICATED 由共享 ingress 链路交给全局会话失效处理（本 adapter 不做登出）。
 *
 * 错误码真源：backend/src/core/common/errors/domain-error.ts 的 ORGANIZATION_MANAGEMENT_ERROR
 * 组与 graphql-exception.filter.ts 的大类映射（TARGET_NOT_FOUND→NOT_FOUND、
 * CODE_CONFLICT→CONFLICT、READ/WRITE_FAILED→INTERNAL_SERVER_ERROR、INPUT_NORMALIZE_*→BAD_USER_INPUT、
 * 权限不足→FORBIDDEN）。
 */

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  AdminCompanyCommandFailureReason,
  AdminCompanyCreateDraft,
  AdminCompanyListPage,
  AdminCompanyListQuery,
  AdminCompanyRecordResult,
  AdminCompanyUpdateDraft,
} from '../application/admin-company-management.types';

import type {
  AdminOrganizationDto,
  AdminOrganizationNamePageDto,
  AdminOrganizationPageDto,
} from './admin-company-management.dto';
import {
  mapAdminOrganizationDtoToRow,
  mapAdminOrganizationNamePageDtoToListPage,
  mapAdminOrganizationPageDtoToListPage,
} from './admin-company-management-mapper';

const ORGANIZATION_FIELDS = `
  id
  organizationCode
  name
  shortName
  contactName
  contactPhone
  contactEmail
  address
  remark
  isServiceProvider
  isManagedCompany
  kind
  status
  createdAt
  updatedAt
`;

const ADMIN_COMPANY_LIST_QUERY = `
  query AdminCompanyList($keyword: String, $pagination: PaginationArgs!, $status: OrganizationStatus, $isManagedCompany: Boolean, $isServiceProvider: Boolean) {
    adminOrganizationList(keyword: $keyword, pagination: $pagination, status: $status, isManagedCompany: $isManagedCompany, isServiceProvider: $isServiceProvider) {
      items {${ORGANIZATION_FIELDS}}
      total
      page
      pageSize
    }
  }
`;

const ADMIN_COMPANY_NAME_LIST_QUERY = `
  query AdminCompanyNameList($keyword: String, $pagination: PaginationArgs!) {
    adminOrganizationNameList(keyword: $keyword, pagination: $pagination) {
      items { id name }
      total
      page
      pageSize
    }
  }
`;

const ADMIN_COMPANY_DETAIL_QUERY = `
  query AdminCompanyDetail($organizationId: Int!) {
    adminOrganizationDetail(organizationId: $organizationId) {${ORGANIZATION_FIELDS}}
  }
`;

const ADMIN_CREATE_COMPANY_MUTATION = `
  mutation AdminCreateCompany($input: AdminCreateOrganizationInput!) {
    adminCreateOrganization(input: $input) {${ORGANIZATION_FIELDS}}
  }
`;

const ADMIN_UPDATE_COMPANY_MUTATION = `
  mutation AdminUpdateCompany($input: AdminUpdateOrganizationInput!) {
    adminUpdateOrganization(input: $input) {${ORGANIZATION_FIELDS}}
  }
`;

type OffsetPaginationVariables = {
  mode: 'OFFSET';
  page: number;
  pageSize: number;
  withTotal: true;
};

type AdminCompanyListQueryData = {
  adminOrganizationList: AdminOrganizationPageDto;
};

type AdminCompanyNameListQueryData = {
  adminOrganizationNameList: AdminOrganizationNamePageDto;
};

type AdminCompanyDetailQueryData = {
  adminOrganizationDetail: AdminOrganizationDto;
};

type AdminCompanyMutationData = {
  adminCreateOrganization?: AdminOrganizationDto;
  adminUpdateOrganization?: AdminOrganizationDto;
};

type CommandReasonMap = Partial<Record<string, AdminCompanyCommandFailureReason>>;

type AdminCompanyFailure = {
  message: string;
  ok: false;
  reason: AdminCompanyCommandFailureReason;
};

/**
 * 各命令的大类码 → 展示原因主映射（extensions.code 契约保证稳定）；
 * extensions.errorCode 仅作可选细化，生产隐藏时自动回退主映射，不会失效。
 */
const WRITE_REASON_BY_CATEGORY_CODE: CommandReasonMap = {
  NOT_FOUND: 'not-found',
  CONFLICT: 'duplicate-code',
  BAD_USER_INPUT: 'invalid-input',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'save-failed',
};

const READ_REASON_BY_CATEGORY_CODE: CommandReasonMap = {
  NOT_FOUND: 'not-found',
  BAD_USER_INPUT: 'invalid-input',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'load-failed',
};

const FALLBACK_MESSAGE_BY_REASON: Record<AdminCompanyCommandFailureReason, string> = {
  'duplicate-code': '公司编号冲突，请重试。',
  forbidden: '当前身份无权执行该操作。',
  'invalid-input': '输入不符合要求，请检查后重新提交。',
  'load-failed': '公司档案加载失败，请稍后重试。',
  'not-found': '目标公司不存在或已被删除，请刷新列表。',
  'save-failed': '公司档案保存失败，请稍后重试。',
};

function toCommandFailure(
  error: unknown,
  reasonByCategoryCode: CommandReasonMap,
): AdminCompanyFailure {
  const detail = readGraphQLErrorDetail(error);
  const reason = detail?.code ? reasonByCategoryCode[detail.code] : undefined;

  if (!detail || !reason) {
    // 未知业务形态或 transport / auth 类失败：按共享错误模型上抛，
    // 由调用方兜底展示；auth 类型由全局会话失效链路处理。
    throw error;
  }

  return {
    ok: false,
    reason,
    message: detail.errorMessage ?? FALLBACK_MESSAGE_BY_REASON[reason],
  };
}

function toPaginationVariables(query: AdminCompanyListQuery): OffsetPaginationVariables {
  return {
    mode: 'OFFSET',
    page: query.page,
    pageSize: query.pageSize,
    withTotal: true,
  };
}

/** 一级管理员完整列表（服务端分页、关键字与状态/维修资格筛选） */
export async function fetchAdminCompanies(
  query: AdminCompanyListQuery,
): Promise<AdminCompanyListPage> {
  const data = await executeGraphQL<
    AdminCompanyListQueryData,
    {
      isManagedCompany?: boolean;
      isServiceProvider?: boolean;
      keyword?: string;
      pagination: OffsetPaginationVariables;
      status?: string;
    }
  >(ADMIN_COMPANY_LIST_QUERY, {
    pagination: toPaginationVariables(query),
    ...(query.keyword ? { keyword: query.keyword } : {}),
    ...(query.status ? { status: query.status } : {}),
    // 「不筛选」与「筛选 false」是两个语义，只有 true 需要显式下发；
    // false 同样需要下发，因此这里按 null 判定而不是真值判定。
    ...(query.isServiceProvider === null ? {} : { isServiceProvider: query.isServiceProvider }),
  });

  return mapAdminOrganizationPageDtoToListPage(data.adminOrganizationList);
}

/** 二级管理员（及等级未知时）的最小名称名单，仅 id / name */
export async function fetchAdminCompanyNames(
  query: AdminCompanyListQuery,
): Promise<AdminCompanyListPage> {
  const data = await executeGraphQL<
    AdminCompanyNameListQueryData,
    { keyword?: string; pagination: OffsetPaginationVariables }
  >(ADMIN_COMPANY_NAME_LIST_QUERY, {
    pagination: toPaginationVariables(query),
    ...(query.keyword ? { keyword: query.keyword } : {}),
  });

  return mapAdminOrganizationNamePageDtoToListPage(data.adminOrganizationNameList);
}

export async function fetchAdminCompanyDetail(
  organizationId: number,
): Promise<AdminCompanyRecordResult> {
  try {
    const data = await executeGraphQL<AdminCompanyDetailQueryData, { organizationId: number }>(
      ADMIN_COMPANY_DETAIL_QUERY,
      { organizationId },
    );

    return { ok: true, organization: mapAdminOrganizationDtoToRow(data.adminOrganizationDetail) };
  } catch (error) {
    return toCommandFailure(error, READ_REASON_BY_CATEGORY_CODE);
  }
}

function toCreateInput(draft: AdminCompanyCreateDraft) {
  return {
    name: draft.name.trim(),
    contactPhone: draft.contactPhone.trim(),
    shortName: draft.shortName.trim() || null,
    contactName: draft.contactName.trim() || null,
    contactEmail: draft.contactEmail.trim() || null,
    address: draft.address.trim() || null,
    remark: draft.remark.trim() || null,
    isServiceProvider: draft.isServiceProvider,
  };
}

export async function adminCreateCompany(
  draft: AdminCompanyCreateDraft,
): Promise<AdminCompanyRecordResult> {
  try {
    const data = await executeGraphQL<
      AdminCompanyMutationData,
      { input: ReturnType<typeof toCreateInput> }
    >(ADMIN_CREATE_COMPANY_MUTATION, { input: toCreateInput(draft) });

    if (!data.adminCreateOrganization) {
      throw new Error('新增公司档案未返回落库结果。');
    }

    return { ok: true, organization: mapAdminOrganizationDtoToRow(data.adminCreateOrganization) };
  } catch (error) {
    return toCommandFailure(error, WRITE_REASON_BY_CATEGORY_CODE);
  }
}

/**
 * 编辑只提交弹窗判定发生变化的字段：undefined 序列化时省略（= 不修改），
 * null 表示明确清空；编号、受管归类与类别不在输入内，任何请求都无法改写。
 */
export async function adminUpdateCompany(
  draft: AdminCompanyUpdateDraft,
): Promise<AdminCompanyRecordResult> {
  const input: {
    organizationId: number;
    address?: string | null;
    contactEmail?: string | null;
    contactName?: string | null;
    contactPhone?: string;
    isServiceProvider?: boolean;
    name?: string;
    remark?: string | null;
    shortName?: string | null;
    status?: string;
  } = { organizationId: draft.organizationId };

  if (draft.name !== undefined) {
    input.name = draft.name.trim();
  }
  if (draft.contactPhone !== undefined) {
    input.contactPhone = draft.contactPhone.trim();
  }
  if (draft.shortName !== undefined) {
    input.shortName = draft.shortName;
  }
  if (draft.contactName !== undefined) {
    input.contactName = draft.contactName;
  }
  if (draft.contactEmail !== undefined) {
    input.contactEmail = draft.contactEmail;
  }
  if (draft.address !== undefined) {
    input.address = draft.address;
  }
  if (draft.remark !== undefined) {
    input.remark = draft.remark;
  }
  if (draft.status !== undefined) {
    input.status = draft.status;
  }
  if (draft.isServiceProvider !== undefined) {
    input.isServiceProvider = draft.isServiceProvider;
  }

  try {
    const data = await executeGraphQL<AdminCompanyMutationData, { input: typeof input }>(
      ADMIN_UPDATE_COMPANY_MUTATION,
      { input },
    );

    if (!data.adminUpdateOrganization) {
      throw new Error('编辑公司档案未返回落库结果。');
    }

    return { ok: true, organization: mapAdminOrganizationDtoToRow(data.adminUpdateOrganization) };
  } catch (error) {
    return toCommandFailure(error, WRITE_REASON_BY_CATEGORY_CODE);
  }
}

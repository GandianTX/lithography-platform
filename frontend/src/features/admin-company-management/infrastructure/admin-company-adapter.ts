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
 * CODE_CONFLICT/SUBMISSION_CONFLICT/ADMIN_BINDING_CONFLICT→CONFLICT、
 * READ/WRITE_FAILED→INTERNAL_SERVER_ERROR、INPUT_NORMALIZE 组与 SUBMISSION_KEY_INVALID→BAD_USER_INPUT、
 * 权限不足→FORBIDDEN）。
 */

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  AdminCompanyAdminAccountDetail,
  AdminCompanyAdminBinding,
  AdminCompanyCommandFailureReason,
  AdminCompanyCreateDraft,
  AdminCompanyCredentialResult,
  AdminCompanyListPage,
  AdminCompanyListQuery,
  AdminCompanyProvisionResult,
  AdminCompanyRecordResult,
  AdminCompanyUpdateDraft,
} from '../application/admin-company-management.types';

import type {
  AdminCompanyAdminAccountDetailDto,
  AdminCompanyAdminBindingDto,
  AdminCompanyProvisioningResultDto,
  AdminLevelTwoCredentialResultDto,
  AdminOrganizationDto,
  AdminOrganizationNamePageDto,
  AdminOrganizationPageDto,
} from './admin-company-management.dto';
import {
  mapAdminCompanyAdminAccountDetailDto,
  mapAdminCompanyAdminBindingDto,
  mapAdminCompanyProvisioningResultDto,
  mapAdminLevelTwoCredentialResultDto,
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

const ADMIN_PROVISION_COMPANY_MUTATION = `
  mutation AdminProvisionCompany($input: AdminCreateOrganizationInput!) {
    adminProvisionCompany(input: $input) {
      organization {${ORGANIZATION_FIELDS}}
      provisionedAdmin { accountId loginName nickname mustChangePassword }
      submission { submissionId replayed }
      temporaryPassword
    }
  }
`;

const ADMIN_COMPANY_ADMIN_BINDING_QUERY = `
  query AdminCompanyAdminBinding($organizationId: Int!) {
    adminCompanyAdminBinding(organizationId: $organizationId) {
      organizationId organizationCode companyName isManagedCompany companyStatus
      status reason boundAccountId boundLoginNameMasked candidateCount accountDisabled
    }
  }
`;

const ADMIN_COMPANY_ADMIN_ACCOUNT_DETAIL_QUERY = `
  query AdminCompanyAdminAccountDetail($organizationId: Int!) {
    adminCompanyAdminAccountDetail(organizationId: $organizationId) {
      organizationId organizationCode companyName isManagedCompany companyStatus
      status reason accountId loginName nickname mustChangePassword accountDisabled candidateCount
    }
  }
`;

const ADMIN_REISSUE_LEVEL_TWO_CREDENTIAL_MUTATION = `
  mutation AdminReissueCompanyAdminCredential($input: AdminReissueLevelTwoCredentialInput!) {
    adminReissueCompanyAdminCredential(input: $input) {
      organizationId adminAccountId loginName nickname mustChangePassword temporaryPassword
    }
  }
`;

const ADMIN_COMPANY_NAME_EXISTS_QUERY = `
  query AdminCompanyNameExists($name: String!, $excludeOrganizationId: Int) {
    adminOrganizationNameExists(name: $name, excludeOrganizationId: $excludeOrganizationId)
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
  adminUpdateOrganization?: AdminOrganizationDto;
};

type AdminCompanyProvisioningData = {
  adminProvisionCompany?: AdminCompanyProvisioningResultDto;
};

type AdminCompanyAdminBindingData = {
  adminCompanyAdminBinding?: AdminCompanyAdminBindingDto;
};

type AdminCompanyAdminAccountDetailData = {
  adminCompanyAdminAccountDetail?: AdminCompanyAdminAccountDetailDto;
};

type AdminLevelTwoCredentialData = {
  adminReissueCompanyAdminCredential?: AdminLevelTwoCredentialResultDto;
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
  // CONFLICT 覆盖：公司编号冲突、同标识改内容（SUBMISSION_CONFLICT）、
  // 派生登录名凭据冲突（ADMIN_BINDING_CONFLICT）。前两者由 errorCode 细化，
  // 生产环境隐藏 errorCode 时回退到同一大类语义。
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

/**
 * 业务细分码（`extensions.errorCode`）对大类映射的**精确覆盖**。
 *
 * DomainError 路径在生产环境同样下发 `errorCode`（只有 HttpException 路径会隐藏），
 * 因此「同标识改内容」可以稳定区别于「公司编号冲突」：前者不得提示用户原样重试。
 */
const DOMAIN_ERROR_REASON_OVERRIDES: CommandReasonMap = {
  ORGANIZATION_MANAGEMENT_SUBMISSION_CONFLICT: 'submission-conflict',
  // 目标未绑定 / 错绑：语义上不是「编号冲突」，单独给出可执行的提示
  ORGANIZATION_MANAGEMENT_ADMIN_BINDING_REQUIRED: 'credential-conflict',
  // 已首次改密、公司停用、账号停用或绑定冲突：目标当前不可补发/重置
  ORGANIZATION_MANAGEMENT_CREDENTIAL_REISSUE_NOT_ALLOWED: 'credential-not-allowed',
};

const FALLBACK_MESSAGE_BY_REASON: Record<AdminCompanyCommandFailureReason, string> = {
  'credential-conflict': '目标公司与绑定账号不一致或尚未绑定，请刷新列表后重试。',
  'credential-not-allowed': '目标当前不可补发或重置，请刷新列表确认绑定状态。',
  'duplicate-code': '公司编号冲突，请重试。',
  forbidden: '当前身份无权执行该操作。',
  'invalid-input': '输入不符合要求，请检查后重新提交。',
  'load-failed': '公司档案加载失败，请稍后重试。',
  'not-found': '目标公司不存在或已被删除，请刷新列表。',
  'save-failed': '公司档案保存失败，请稍后重试。',
  'submission-conflict': '本次提交内容与已提交记录不一致，请刷新后重试。',
};

function toCommandFailure(
  error: unknown,
  reasonByCategoryCode: CommandReasonMap,
): AdminCompanyFailure {
  const detail = readGraphQLErrorDetail(error);
  const reason =
    (detail?.errorCode ? DOMAIN_ERROR_REASON_OVERRIDES[detail.errorCode] : undefined) ??
    (detail?.code ? reasonByCategoryCode[detail.code] : undefined);

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

function toCreateInput(draft: AdminCompanyCreateDraft, submissionKey: string) {
  return {
    name: draft.name.trim(),
    contactPhone: draft.contactPhone.trim(),
    shortName: draft.shortName.trim() || null,
    contactName: draft.contactName.trim() || null,
    contactEmail: draft.contactEmail.trim() || null,
    address: draft.address.trim() || null,
    remark: draft.remark.trim() || null,
    status: draft.status,
    isServiceProvider: draft.isServiceProvider,
    submissionKey,
  };
}

/**
 * 一级管理员的精确同名提示（只读）。
 *
 * 服务端在全部公司档案范围内比较（含停用与未受管），编辑时传入自身主键排除自己；
 * 结果只用于弹窗提示，不阻断提交，也不改变「同名不合并」的写入语义。
 */
export async function checkAdminCompanyNameExists(params: {
  name: string;
  excludeOrganizationId?: number | null;
}): Promise<boolean> {
  const data = await executeGraphQL<
    { adminOrganizationNameExists: boolean },
    { name: string; excludeOrganizationId?: number }
  >(ADMIN_COMPANY_NAME_EXISTS_QUERY, {
    name: params.name,
    ...(params.excludeOrganizationId === undefined || params.excludeOrganizationId === null
      ? {}
      : { excludeOrganizationId: params.excludeOrganizationId }),
  });

  return data.adminOrganizationNameExists === true;
}

/**
 * 新增公司并开通二级管理员（新合同，提交标识幂等）。
 *
 * `submissionKey` 由调用方在首次发送前生成并复用；服务端以「用途 + 操作者 + 标识」
 * 唯一定位，同标识同内容回放、同标识改内容返回 `SUBMISSION_CONFLICT`。
 * `temporaryPassword` 只在首次成功响应中出现，回放恒为 `null`；调用方只能把它放进
 * 当次成功弹窗的组件 state，不得持久化或写入缓存。
 */
export async function adminCreateCompany(
  draft: AdminCompanyCreateDraft,
  submissionKey: string,
): Promise<AdminCompanyProvisionResult> {
  try {
    const data = await executeGraphQL<
      AdminCompanyProvisioningData,
      { input: ReturnType<typeof toCreateInput> }
    >(ADMIN_PROVISION_COMPANY_MUTATION, { input: toCreateInput(draft, submissionKey) });

    if (!data.adminProvisionCompany) {
      throw new Error('新增公司档案未返回落库结果。');
    }

    return mapAdminCompanyProvisioningResultDto(data.adminProvisionCompany);
  } catch (error) {
    return toCommandFailure(error, WRITE_REASON_BY_CATEGORY_CODE);
  }
}

/**
 * 一级按公司查询绑定事实（只读，无凭据）。
 *
 * 列表逐行展示绑定状态时使用：业务拒绝归一为显式失败结果，transport / auth 类失败上抛，
 * 由调用方逐行降级，不阻塞整张表格。
 */
export async function fetchAdminCompanyAdminBinding(
  organizationId: number,
): Promise<{ ok: true; binding: AdminCompanyAdminBinding } | { ok: false; message: string }> {
  try {
    const data = await executeGraphQL<AdminCompanyAdminBindingData, { organizationId: number }>(
      ADMIN_COMPANY_ADMIN_BINDING_QUERY,
      { organizationId },
    );

    if (!data.adminCompanyAdminBinding) {
      throw new Error('绑定查询未返回结果。');
    }

    return {
      ok: true,
      binding: mapAdminCompanyAdminBindingDto(data.adminCompanyAdminBinding),
    };
  } catch (error) {
    return toCommandFailure(error, READ_REASON_BY_CATEGORY_CODE);
  }
}

/**
 * 一级按公司窄查询二级管理员账号详情（只读，无凭据）。
 *
 * 与 `fetchAdminCompanyAdminBinding` 分开：本接口只在唯一合法绑定时返回完整登录名与
 * `mustChangePassword`，列表与详情都按需调用，不把完整登录名放进列表读面。
 */
export async function fetchAdminCompanyAdminAccountDetail(
  organizationId: number,
): Promise<{ ok: true; detail: AdminCompanyAdminAccountDetail } | { ok: false; message: string }> {
  try {
    const data = await executeGraphQL<
      AdminCompanyAdminAccountDetailData,
      { organizationId: number }
    >(ADMIN_COMPANY_ADMIN_ACCOUNT_DETAIL_QUERY, { organizationId });

    if (!data.adminCompanyAdminAccountDetail) {
      throw new Error('账号详情查询未返回结果。');
    }

    return {
      ok: true,
      detail: mapAdminCompanyAdminAccountDetailDto(data.adminCompanyAdminAccountDetail),
    };
  } catch (error) {
    return toCommandFailure(error, READ_REASON_BY_CATEGORY_CODE);
  }
}

/**
 * 补发二级管理员临时密码（仅一级、仅尚待首次改密的目标）。
 *
 * 成功响应携带本次新口令；mutation 由 shared/graphql 统一强制 `no-cache`，
 * 口令不会进入 Apollo 缓存。
 */
export async function adminReissueLevelTwoCredential(
  organizationId: number,
): Promise<AdminCompanyCredentialResult> {
  try {
    const data = await executeGraphQL<
      AdminLevelTwoCredentialData,
      { input: { organizationId: number } }
    >(ADMIN_REISSUE_LEVEL_TWO_CREDENTIAL_MUTATION, { input: { organizationId } });

    if (!data.adminReissueCompanyAdminCredential) {
      throw new Error('补发临时密码未返回结果。');
    }

    return mapAdminLevelTwoCredentialResultDto(data.adminReissueCompanyAdminCredential);
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

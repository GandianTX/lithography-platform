// src/features/admin-engineer-approval/infrastructure/admin-engineer-approval-adapter.ts

/**
 * 工程师注册审批的 GraphQL adapter（外部技术边界唯一落点）。
 *
 * - 复用 shared/graphql 的 executeGraphQL（Apollo client、Token 注入、ingress 错误模型），
 *   不创建第二个 Apollo Client，不直接 fetch /graphql；
 * - 作用域由服务端按请求期会话等级裁决：一级全范围、二级仅可信公司；
 *   前端不传组织参数，避免客户端自报范围；
 * - 业务拒绝按稳定的 extensions.code 大类映射为显式失败结果，transport / auth 类失败上抛。
 */

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  AdminEngineerRegistrationListPage,
  AdminEngineerRegistrationListQuery,
  AdminEngineerRegistrationReadResult,
  AdminEngineerReviewDraft,
  AdminEngineerReviewFailureReason,
  AdminEngineerReviewResult,
} from '../application/admin-engineer-approval.types';

import type {
  AdminEngineerRegistrationItemDto,
  AdminEngineerRegistrationPageDto,
} from './admin-engineer-approval.dto';
import {
  mapAdminEngineerRegistrationItemDtoToRow,
  mapAdminEngineerRegistrationPageDtoToListPage,
} from './admin-engineer-approval-mapper';

const APPLICANT_FIELDS = `
  id
  loginName
  loginEmail
  nickname
  companyName
  phone
  contactEmail
  role
  status
`;

const ITEM_FIELDS = `
  application {
    id
    accountId
    organizationId
    status
    applicationNote
    submittedAt
    reviewedByAccountId
    reviewedAt
    reviewComment
  }
  organizationName
  applicant {${APPLICANT_FIELDS}}
`;

const ADMIN_ENGINEER_REGISTRATION_LIST_QUERY = `
  query AdminEngineerRegistrations($pagination: PaginationArgs!, $status: EngineerRegistrationApplicationStatus) {
    adminEngineerRegistrations(pagination: $pagination, status: $status) {
      items {${ITEM_FIELDS}}
      total
      page
      pageSize
    }
  }
`;

const ADMIN_ENGINEER_REGISTRATION_DETAIL_QUERY = `
  query AdminEngineerRegistrationDetail($applicationId: Int!) {
    adminEngineerRegistrationDetail(applicationId: $applicationId) {${ITEM_FIELDS}}
  }
`;

const REVIEW_ENGINEER_REGISTRATION_MUTATION = `
  mutation ReviewEngineerRegistration($input: ReviewEngineerRegistrationInput!) {
    reviewEngineerRegistration(input: $input) {${ITEM_FIELDS}}
  }
`;

type OffsetPaginationVariables = {
  mode: 'OFFSET';
  page: number;
  pageSize: number;
  withTotal: true;
};

type AdminEngineerRegistrationListQueryData = {
  adminEngineerRegistrations: AdminEngineerRegistrationPageDto;
};

type AdminEngineerRegistrationDetailQueryData = {
  adminEngineerRegistrationDetail: AdminEngineerRegistrationItemDto;
};

type AdminEngineerReviewMutationData = {
  reviewEngineerRegistration?: AdminEngineerRegistrationItemDto;
};

type ReviewFailure = {
  message: string;
  ok: false;
  reason: AdminEngineerReviewFailureReason;
};

/**
 * 大类码 → 展示原因主映射（extensions.code 契约保证稳定）；
 * extensions.errorCode 仅作可选细化，生产隐藏时自动回退主映射。
 */
const REVIEW_REASON_BY_CATEGORY_CODE: Partial<Record<string, AdminEngineerReviewFailureReason>> = {
  NOT_FOUND: 'not-found',
  CONFLICT: 'state-conflict',
  BAD_USER_INPUT: 'invalid-input',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'save-failed',
};

const READ_REASON_BY_CATEGORY_CODE: Partial<Record<string, AdminEngineerReviewFailureReason>> = {
  NOT_FOUND: 'not-found',
  BAD_USER_INPUT: 'invalid-input',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'save-failed',
};

const FALLBACK_MESSAGE_BY_REASON: Record<AdminEngineerReviewFailureReason, string> = {
  forbidden: '当前身份无权处理该申请。',
  'invalid-input': '提交内容不符合要求，请检查后重试。',
  'not-found': '申请不存在或不在当前可见范围，请刷新列表。',
  'save-failed': '审批结果保存失败，请稍后重试。',
  'state-conflict': '该申请已被处理，请刷新后查看最新状态。',
};

function toReviewFailure(
  error: unknown,
  reasonByCategoryCode: Partial<Record<string, AdminEngineerReviewFailureReason>>,
): ReviewFailure {
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

function toPaginationVariables(
  query: AdminEngineerRegistrationListQuery,
): OffsetPaginationVariables {
  return {
    mode: 'OFFSET',
    page: query.page,
    pageSize: query.pageSize,
    withTotal: true,
  };
}

export async function fetchAdminEngineerRegistrations(
  query: AdminEngineerRegistrationListQuery,
): Promise<AdminEngineerRegistrationListPage> {
  const data = await executeGraphQL<
    AdminEngineerRegistrationListQueryData,
    { pagination: OffsetPaginationVariables; status?: string }
  >(ADMIN_ENGINEER_REGISTRATION_LIST_QUERY, {
    pagination: toPaginationVariables(query),
    ...(query.status ? { status: query.status } : {}),
  });

  return mapAdminEngineerRegistrationPageDtoToListPage(data.adminEngineerRegistrations);
}

export async function fetchAdminEngineerRegistrationDetail(
  applicationId: number,
): Promise<AdminEngineerRegistrationReadResult> {
  try {
    const data = await executeGraphQL<
      AdminEngineerRegistrationDetailQueryData,
      { applicationId: number }
    >(ADMIN_ENGINEER_REGISTRATION_DETAIL_QUERY, { applicationId });

    return {
      ok: true,
      registration: mapAdminEngineerRegistrationItemDtoToRow(data.adminEngineerRegistrationDetail),
    };
  } catch (error) {
    return toReviewFailure(error, READ_REASON_BY_CATEGORY_CODE);
  }
}

export async function reviewEngineerRegistration(
  draft: AdminEngineerReviewDraft,
): Promise<AdminEngineerReviewResult> {
  try {
    const data = await executeGraphQL<
      AdminEngineerReviewMutationData,
      { input: { applicationId: number; action: string; reviewComment: string | null } }
    >(REVIEW_ENGINEER_REGISTRATION_MUTATION, {
      input: {
        applicationId: draft.applicationId,
        action: draft.action,
        reviewComment: draft.reviewComment,
      },
    });

    if (!data.reviewEngineerRegistration) {
      throw new Error('审核命令未返回落库结果。');
    }

    return {
      ok: true,
      registration: mapAdminEngineerRegistrationItemDtoToRow(data.reviewEngineerRegistration),
    };
  } catch (error) {
    return toReviewFailure(error, REVIEW_REASON_BY_CATEGORY_CODE);
  }
}

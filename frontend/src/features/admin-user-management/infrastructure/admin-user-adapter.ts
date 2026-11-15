// src/features/admin-user-management/infrastructure/admin-user-adapter.ts

/**
 * 管理员用户管理的 GraphQL adapter（外部技术边界唯一落点）。
 *
 * - 复用 shared/graphql 的 executeGraphQL（Apollo client、Token 注入、ingress 错误模型），
 *   不创建第二个 Apollo Client，不直接 fetch /graphql；
 * - 原始 DTO 与 operation 只停留在本目录；对外返回 feature 内部模型或显式业务结果；
 * - 业务拒绝按稳定的 extensions.code 大类映射为显式失败结果（不依赖生产可能隐藏的
 *   extensions.errorCode）；transport / auth / 网络类失败仍上抛 GraphQLIngressError，
 *   UNAUTHENTICATED 由共享 ingress 链路交给全局会话失效处理（本 adapter 不做登出）。
 *
 * 错误码真源：backend/src/core/common/errors/domain-error.ts 的 ADMIN_USER_ERROR 组与
 * graphql-exception.filter.ts 的大类映射（TARGET_NOT_FOUND→NOT_FOUND、
 * CREDENTIAL_CONFLICT / STATUS_TRANSITION_NOT_ALLOWED / PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED
 * →CONFLICT、READ / WRITE / ROLE_DATA→INTERNAL_SERVER_ERROR、INPUT_NORMALIZE_*→BAD_USER_INPUT）。
 */

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  AdminUserCommandFailureReason,
  AdminUserCommandResult,
  AdminUserFilterRole,
  AdminUserListPage,
  AdminUserListQuery,
  AdminUserPasswordResetResult,
  AdminUserStatusFilter,
} from '../application/admin-user-management.types';

import type {
  AdminResetUserPasswordResultDto,
  AdminUserListPageDto,
} from './admin-user-management.dto';
import { mapAdminUserListPageDtoToListPage } from './admin-user-management-mapper';

const ADMIN_USERS_QUERY = `
  query AdminUsers($keyword: String, $pagination: PaginationArgs!, $role: IdentityTypeEnum, $status: AccountStatus) {
    adminUsers(keyword: $keyword, pagination: $pagination, role: $role, status: $status) {
      items {
        id
        loginName
        loginEmail
        nickname
        companyName
        contactEmail
        phone
        role
        status
        createdAt
        updatedAt
      }
      total
      page
      pageSize
    }
  }
`;

const ADMIN_SET_USER_STATUS_MUTATION = `
  mutation AdminSetUserStatus($input: AdminSetUserStatusInput!) {
    adminSetUserStatus(input: $input) {
      id
    }
  }
`;

/**
 * 重置为系统默认密码：协议层**只有** `accountId`，不接受任何客户端自报密码；
 * 默认密码由服务端运行期配置提供，回包只含固定安全提示。
 */
const ADMIN_RESET_USER_PASSWORD_TO_DEFAULT_MUTATION = `
  mutation AdminResetUserPasswordToDefault($input: AdminResetUserPasswordToDefaultInput!) {
    adminResetUserPasswordToDefault(input: $input) {
      accountId
      isUpdated
      notice
    }
  }
`;

type AdminUsersQueryData = {
  adminUsers: AdminUserListPageDto;
};

type AdminSetUserStatusData = {
  adminSetUserStatus: { id: number };
};

type AdminResetUserPasswordToDefaultData = {
  adminResetUserPasswordToDefault: AdminResetUserPasswordResultDto;
};

type AdminUsersQueryVariables = {
  keyword?: string;
  pagination: {
    mode: 'OFFSET';
    page: number;
    pageSize: number;
    withTotal: true;
  };
  role?: AdminUserFilterRole;
  status?: AdminUserStatusFilter;
};

type CommandReasonMap = Partial<Record<string, AdminUserCommandFailureReason>>;

/** 显式业务失败结果（AdminUserCommandResult 与 AdminUserPasswordResetResult 的失败分支同构） */
type AdminUserCommandFailure = {
  message: string;
  ok: false;
  reason: AdminUserCommandFailureReason;
};

/**
 * 各命令的大类码 → 展示原因主映射（extensions.code 契约保证稳定）；
 * extensions.errorCode 仅作可选细化，生产隐藏时自动回退主映射，不会失效。
 */
const STATUS_REASON_BY_CATEGORY_CODE: CommandReasonMap = {
  NOT_FOUND: 'not-found',
  CONFLICT: 'status-conflict',
  BAD_USER_INPUT: 'invalid-input',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'update-failed',
};

/**
 * 默认密码重置的失败映射：状态未收敛（`PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED`）
 * 与启停冲突同属 CONFLICT，统一展示为「当前状态不允许该操作」。
 */
const RESET_PASSWORD_REASON_BY_CATEGORY_CODE: CommandReasonMap = {
  NOT_FOUND: 'not-found',
  CONFLICT: 'status-conflict',
  BAD_USER_INPUT: 'invalid-input',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'reset-failed',
};

const FALLBACK_MESSAGE_BY_REASON: Record<AdminUserCommandFailureReason, string> = {
  forbidden: '当前身份无权执行该操作。',
  'invalid-input': '输入不符合要求，请检查后重新提交。',
  'not-found': '目标账号不存在或已被删除，请刷新列表。',
  'reset-failed': '密码重置失败，请稍后重试。',
  'status-conflict': '目标账号当前状态不允许该操作，请刷新列表后重试。',
  'update-failed': '操作失败，请稍后重试。',
};

function toCommandFailure(
  error: unknown,
  reasonByCategoryCode: CommandReasonMap,
): AdminUserCommandFailure {
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

/**
 * 管理员分页查询用户列表（服务端分页、搜索与筛选）。
 * keyword / role / status 为空时省略变量（与「未提供」语义一致，不发送显式 null）。
 */
export async function fetchAdminUsers(query: AdminUserListQuery): Promise<AdminUserListPage> {
  const variables: AdminUsersQueryVariables = {
    pagination: {
      mode: 'OFFSET',
      page: query.page,
      pageSize: query.pageSize,
      withTotal: true,
    },
    ...(query.keyword ? { keyword: query.keyword } : {}),
    ...(query.role ? { role: query.role } : {}),
    ...(query.status ? { status: query.status } : {}),
  };
  const data = await executeGraphQL<AdminUsersQueryData, AdminUsersQueryVariables>(
    ADMIN_USERS_QUERY,
    variables,
  );

  return mapAdminUserListPageDtoToListPage(data.adminUsers);
}

export async function adminSetUserStatus(input: {
  accountId: number;
  status: AdminUserStatusFilter;
}): Promise<AdminUserCommandResult> {
  try {
    await executeGraphQL<
      AdminSetUserStatusData,
      { input: { accountId: number; status: AdminUserStatusFilter } }
    >(ADMIN_SET_USER_STATUS_MUTATION, { input });

    return { ok: true };
  } catch (error) {
    return toCommandFailure(error, STATUS_REASON_BY_CATEGORY_CODE);
  }
}

export async function adminResetUserPasswordToDefault(input: {
  accountId: number;
}): Promise<AdminUserPasswordResetResult> {
  try {
    const data = await executeGraphQL<
      AdminResetUserPasswordToDefaultData,
      { input: { accountId: number } }
    >(ADMIN_RESET_USER_PASSWORD_TO_DEFAULT_MUTATION, { input });

    // 密码本身不出现在任何结果中，只回传后端固定安全提示
    return { ok: true, notice: data.adminResetUserPasswordToDefault.notice };
  } catch (error) {
    return toCommandFailure(error, RESET_PASSWORD_REASON_BY_CATEGORY_CODE);
  }
}

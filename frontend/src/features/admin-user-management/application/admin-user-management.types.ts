// src/features/admin-user-management/application/admin-user-management.types.ts

/**
 * 管理员用户管理的 feature 内部模型（application 层唯一消费面）。
 * 不依赖任何 GraphQL 原始 DTO 类型；原始形状只在 infrastructure 中经 mapper 清洗后进入这里。
 */

export type AdminUserRole = 'SUPER_ADMIN' | 'ENGINEER' | 'CUSTOMER';

/** 列表只读普通用户，角色筛选值域与后端 `ADMIN_USER_LIST_ROLE_FILTERS` 同源 */
export type AdminUserFilterRole = 'ENGINEER' | 'CUSTOMER';

/** 列表状态筛选值域（后端只开放 ACTIVE / INACTIVE） */
export type AdminUserStatusFilter = 'ACTIVE' | 'INACTIVE';

/**
 * 列表行状态忠实保留后端原值：页面只识别 ACTIVE / INACTIVE 并提供启停入口，
 * 其余状态（防御性兜底）按「不可写」处理，仅只读展示。
 */
export type AdminUserRow = {
  accountId: number;
  companyName: string | null;
  contactEmail: string | null;
  createdAt: string;
  loginEmail: string | null;
  loginName: string | null;
  nickname: string;
  phone: string | null;
  role: AdminUserRole;
  status: string;
  updatedAt: string;
};

export type AdminUserListQuery = {
  keyword: string | null;
  page: number;
  /** 角色筛选只开放普通用户值域（ENGINEER / CUSTOMER），管理员账号不在读面内 */
  role: AdminUserFilterRole | null;
  pageSize: number;
  status: AdminUserStatusFilter | null;
};

export type AdminUserListPage = {
  items: AdminUserRow[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * 命令失败原因（前端展示分类）：以稳定的 GraphQL 大类码 extensions.code 为主映射，
 * 不依赖生产环境可能隐藏的 extensions.errorCode；transport / auth 类失败不归入业务拒绝，
 * 仍由共享 GraphQL ingress 错误模型上抛，UNAUTHENTICATED 交给全局会话失效链路。
 */
export type AdminUserCommandFailureReason =
  | 'forbidden'
  | 'invalid-input'
  | 'not-found'
  | 'reset-failed'
  | 'status-conflict'
  | 'update-failed';

export type AdminUserCommandResult =
  | { ok: true }
  | { ok: false; reason: AdminUserCommandFailureReason; message: string };

/** 密码重置为默认密码成功只返回后端固定安全提示 notice，密码本身不出现在任何结果与提示中 */
export type AdminUserPasswordResetResult =
  | { ok: true; notice: string }
  | { ok: false; reason: AdminUserCommandFailureReason; message: string };

/** 已绑定二级管理员（一级专用窄查询的 feature 内部模型；无凭据字段） */
export type AdminBoundLevelTwoAdmin = {
  accountDisabled: boolean;
  accountId: number;
  companyName: string;
  companyStatus: string;
  loginName: string;
  nickname: string | null;
  organizationCode: string;
  organizationId: number;
};

export type AdminBoundLevelTwoAdminListQuery = {
  keyword: string | null;
  page: number;
  pageSize: number;
};

export type AdminBoundLevelTwoAdminPage = {
  items: AdminBoundLevelTwoAdmin[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * 二级管理员凭据结果（成功才有的模型）。
 * `temporaryPassword` 只允许经组件 state 交给当次成功弹窗，不落任何持久化或缓存。
 */
export type AdminLevelTwoCredentialResult = {
  adminAccountId: number;
  loginName: string;
  mustChangePassword: boolean;
  nickname: string | null;
  organizationId: number;
  temporaryPassword: string;
};

/** 凭据弹窗的展示快照：额外带上目标公司名与本次重置原因，关闭即销毁 */
export type AdminLevelTwoCredentialView = AdminLevelTwoCredentialResult & {
  companyName: string;
  reason: string;
};

/** 二级管理员凭据重置命令结果：成功携带本次新口令，失败沿用统一业务拒绝原因 */
export type AdminLevelTwoCredentialCommandResult =
  | { ok: true; credential: AdminLevelTwoCredentialResult }
  | { ok: false; reason: AdminUserCommandFailureReason; message: string };

/**
 * 凭据回包归属所需的会话身份快照（账号 + 会话代次，不含 Token）。
 *
 * 由页面注入：本 feature 不直接依赖 auth-session feature，保持 features 之间零耦合。
 */
export type AdminUserSessionIdentity = {
  accountId: number;
  epoch: number;
};

// src/features/admin-company-management/application/admin-company-management.types.ts

/**
 * 公司档案管理的 feature 内部模型（application 层唯一消费面）。
 * 不依赖任何 GraphQL 原始 DTO 类型；原始形状只在 infrastructure 中经 mapper 清洗后进入这里。
 */

/** 公司状态：与后端 `OrganizationStatus` 同口径 */
export type AdminOrganizationStatus = 'ACTIVE' | 'DISABLED';

/** 公司类别：与后端 `OrganizationKind` 同口径 */
export type AdminOrganizationKind = 'CLIENT' | 'PEER';

/** 一级管理员的完整公司档案行（含编号、受管归类与时间） */
export type AdminCompanyRow = {
  organizationId: number;
  organizationCode: string;
  name: string;
  shortName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  remark: string | null;
  isServiceProvider: boolean;
  isManagedCompany: boolean;
  kind: AdminOrganizationKind;
  status: AdminOrganizationStatus;
  createdAt: string;
  updatedAt: string;
};

/** 二级管理员可见的最小名称名单条目 */
export type AdminCompanyNameOption = {
  id: number;
  name: string;
};

export type AdminCompanyListQuery = {
  keyword: string | null;
  page: number;
  pageSize: number;
  status: AdminOrganizationStatus | null;
  isServiceProvider: boolean | null;
};

/**
 * 列表结果按读入口区分：一级为完整档案页，二级为最小名称页。
 * 用判别字段 `kind` 而不是把两种行拼成联合，渲染侧无需再次断言字段可用性。
 */
export type AdminCompanyListPage =
  | {
      kind: 'full';
      items: AdminCompanyRow[];
      page: number;
      pageSize: number;
      total: number;
    }
  | {
      kind: 'name';
      items: AdminCompanyNameOption[];
      page: number;
      pageSize: number;
      total: number;
    };

/** 新增草稿：编号、受管归类与类别都由服务端决定；状态与维修资格由用户独立选择 */
export type AdminCompanyCreateDraft = {
  name: string;
  shortName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  address: string;
  remark: string;
  status: AdminOrganizationStatus;
  isServiceProvider: boolean;
};

/**
 * 编辑草稿：键缺省 = 不修改；可选文本 null = 明确清空；string = 设置。
 * 只提交弹窗判定发生变化的字段，避免把打开弹窗时的旧值重发覆盖他人并发修改。
 */
export type AdminCompanyUpdateDraft = {
  organizationId: number;
  name?: string;
  shortName?: string | null;
  contactName?: string | null;
  contactPhone?: string;
  contactEmail?: string | null;
  address?: string | null;
  remark?: string | null;
  status?: AdminOrganizationStatus;
  isServiceProvider?: boolean;
};

/**
 * 命令失败原因（前端展示分类）：以稳定的 GraphQL 大类码 extensions.code 为主映射，
 * 不依赖生产环境可能隐藏的 extensions.errorCode；transport / auth 类失败不归入业务拒绝，
 * 仍由共享 GraphQL ingress 错误模型上抛，UNAUTHENTICATED 交给全局会话失效链路。
 */
export type AdminCompanyCommandFailureReason =
  | 'duplicate-code'
  | 'forbidden'
  | 'invalid-input'
  | 'load-failed'
  | 'not-found'
  | 'save-failed'
  /** 同一提交标识已提交过但内容不同：服务端明确拒绝，不得原样重试 */
  | 'submission-conflict'
  /** 补发/重置目标未绑定或与唯一绑定不一致 */
  | 'credential-conflict'
  /** 补发/重置目标当前不具备资格（已首次改密、公司停用、账号停用、绑定冲突） */
  | 'credential-not-allowed';

/** 详情 / 新增 / 编辑统一返回落库后的完整档案，便于列表与弹窗直接回读 */
export type AdminCompanyRecordResult =
  | { ok: true; organization: AdminCompanyRow }
  | { ok: false; reason: AdminCompanyCommandFailureReason; message: string };

/** 绑定状态：与后端 `evaluateAdminBinding` 四态同口径 */
export type AdminCompanyAdminBindingStatus =
  | 'BOUND'
  | 'UNCONFIGURED'
  | 'CONFLICT'
  | 'COMPANY_DISABLED';

/** 一级按公司查询的绑定事实（只读，仅脱敏登录名，无任何凭据） */
export type AdminCompanyAdminBinding = {
  organizationId: number;
  organizationCode: string;
  companyName: string;
  isManagedCompany: boolean;
  companyStatus: AdminOrganizationStatus;
  status: AdminCompanyAdminBindingStatus;
  reason: string | null;
  boundAccountId: number | null;
  boundLoginNameMasked: string | null;
  candidateCount: number;
  accountDisabled: boolean;
};

/** 新增公司并开通的完整结果：临时密码只在首次成功时为字符串，回放为 null */
export type AdminCompanyProvisionResult =
  | {
      ok: true;
      organization: AdminCompanyRow;
      provisionedAdmin: {
        accountId: number;
        loginName: string;
        nickname: string;
        mustChangePassword: boolean;
      };
      submission: { submissionId: number | null; replayed: boolean };
      temporaryPassword: string | null;
    }
  | { ok: false; reason: AdminCompanyCommandFailureReason; message: string };

/** 补发 / 重置结果：临时密码只在本组件生命周期内展示 */
export type AdminCompanyCredentialResult =
  | {
      ok: true;
      organizationId: number;
      adminAccountId: number;
      loginName: string;
      nickname: string | null;
      mustChangePassword: boolean;
      temporaryPassword: string;
    }
  | { ok: false; reason: AdminCompanyCommandFailureReason; message: string };

/** 凭据弹窗的数据快照：只存在于组件 state，关闭/卸载即销毁 */
export type AdminCompanyCredentialView = {
  organizationId: number;
  organizationName: string;
  loginName: string;
  nickname: string | null;
  temporaryPassword: string | null;
  mustChangePassword: boolean;
  replayed: boolean;
};

/** 读入口模式：一级完整读写；二级 / 等级未知只读最小名称名单 */
export type AdminCompanyListMode = 'full' | 'name-only';

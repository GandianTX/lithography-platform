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

/** 新增草稿：编号、受管归类、类别与状态均由服务端决定，不在草稿内 */
export type AdminCompanyCreateDraft = {
  name: string;
  shortName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  address: string;
  remark: string;
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
  | 'save-failed';

/** 详情 / 新增 / 编辑统一返回落库后的完整档案，便于列表与弹窗直接回读 */
export type AdminCompanyRecordResult =
  | { ok: true; organization: AdminCompanyRow }
  | { ok: false; reason: AdminCompanyCommandFailureReason; message: string };

/** 读入口模式：一级完整读写；二级 / 等级未知只读最小名称名单 */
export type AdminCompanyListMode = 'full' | 'name-only';

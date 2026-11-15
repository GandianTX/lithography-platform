// src/features/admin-engineer-approval/application/admin-engineer-approval.types.ts

/**
 * 工程师注册审批的 feature 内部模型（application 层唯一消费面）。
 * 不依赖任何 GraphQL 原始 DTO 类型；原始形状只在 infrastructure 中经 mapper 清洗后进入这里。
 */

/** 申请状态：与后端 `EngineerRegistrationApplicationStatus` 同口径 */
export type AdminEngineerRegistrationStatus = 'APPROVED' | 'PENDING' | 'REJECTED';

/** 审核动作：与后端 `EngineerRegistrationReviewAction` 同口径 */
export type AdminEngineerReviewAction = 'APPROVE' | 'REJECT';

/** 申请人公开资料（审批决策所需的最小面：姓名 / 电话 / 邮箱 / 登录名） */
export type AdminEngineerApplicant = {
  nickname: string;
  loginName: string | null;
  loginEmail: string | null;
  phone: string | null;
  contactEmail: string | null;
  companyName: string | null;
};

/** 审批队列 / 详情共用的行模型 */
export type AdminEngineerRegistrationRow = {
  applicationId: number;
  accountId: number;
  organizationId: number;
  organizationName: string | null;
  status: AdminEngineerRegistrationStatus;
  applicationNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewComment: string | null;
  applicant: AdminEngineerApplicant;
};

export type AdminEngineerRegistrationListQuery = {
  page: number;
  pageSize: number;
  status: AdminEngineerRegistrationStatus | null;
};

export type AdminEngineerRegistrationListPage = {
  items: AdminEngineerRegistrationRow[];
  page: number;
  pageSize: number;
  total: number;
};

/** 审核命令输入：拒绝时原因必填（trim 后非空），通过时可留空 */
export type AdminEngineerReviewDraft = {
  applicationId: number;
  action: AdminEngineerReviewAction;
  reviewComment: string | null;
};

/**
 * 命令失败原因（前端展示分类）：以稳定的 GraphQL 大类码 extensions.code 为主映射，
 * transport / auth 类失败仍由共享 GraphQL ingress 错误模型上抛。
 */
export type AdminEngineerReviewFailureReason =
  | 'forbidden'
  | 'invalid-input'
  | 'not-found'
  | 'save-failed'
  | 'state-conflict';

export type AdminEngineerReviewResult =
  | { ok: true; registration: AdminEngineerRegistrationRow }
  | { ok: false; reason: AdminEngineerReviewFailureReason; message: string };

/** 详情读取结果：与审核命令共用同一失败分类，渲染侧无需区分两种失败形态 */
export type AdminEngineerRegistrationReadResult = AdminEngineerReviewResult;

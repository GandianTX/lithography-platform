// src/features/registration/application/registration.types.ts

/** 注册公司候选：公开接口只暴露主键与名称 */
export type RegistrationOrganizationOption = {
  id: number;
  name: string;
};

/** 选择器对外提交值：表单需要同时展示名称，但服务端只认 id */
export type RegistrationOrganizationSelection = RegistrationOrganizationOption;

/** 公开公司候选分页结果 */
export type RegistrationOrganizationPage = {
  items: RegistrationOrganizationOption[];
  total: number;
  page: number;
  pageSize: number;
};

/** 公开公司候选检索参数（OFFSET 分页） */
export type RegistrationOrganizationSearch = {
  page: number;
  pageSize: number;
  keyword?: string;
};

/** 工程师申请状态（与后端 EngineerRegistrationApplicationStatus 同值） */
export const ENGINEER_REGISTRATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

export type EngineerRegistrationStatus = (typeof ENGINEER_REGISTRATION_STATUSES)[number];

/** 工程师申请状态展示名 */
export const ENGINEER_REGISTRATION_STATUS_LABELS: Record<EngineerRegistrationStatus, string> = {
  APPROVED: '已通过',
  PENDING: '审核中',
  REJECTED: '已拒绝',
};

/**
 * 本人最新一份工程师申请（受限会话读取）。
 *
 * 只含申请人自己需要看到的展示事实：目标公司、状态、申请说明与审核结论；
 * 不含账号主键与审核管理员身份。`organizationName` 在组织行缺失时为 null。
 */
export type MyEngineerRegistrationView = {
  applicationId: number;
  organizationId: number;
  organizationName: string | null;
  status: EngineerRegistrationStatus;
  applicationNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewComment: string | null;
};

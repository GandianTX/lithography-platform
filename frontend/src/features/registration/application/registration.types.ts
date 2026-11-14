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

// src/features/registration/index.ts

// barrel 只导出切片外实际消费的公开 API：注册公司候选类型、公开检索与共用选择器。
// S3 / S4 两个注册页从这里复用同一入口与资格口径。

export type {
  RegisterCustomerInput,
  RegisterCustomerResult,
} from './application/register-customer';
export {
  resolveRegisterCustomerErrorMessage,
  submitRegisterCustomer,
} from './application/register-customer';
export type {
  RegisterEngineerInput,
  RegisterEngineerResult,
} from './application/register-engineer';
export {
  resolveRegisterEngineerErrorMessage,
  submitRegisterEngineer,
} from './application/register-engineer';
export type {
  EngineerRegistrationStatus,
  MyEngineerRegistrationView,
  RegistrationOrganizationOption,
  RegistrationOrganizationPage,
  RegistrationOrganizationSearch,
  RegistrationOrganizationSelection,
} from './application/registration.types';
export { ENGINEER_REGISTRATION_STATUS_LABELS } from './application/registration.types';
export type { MyEngineerRegistrationState } from './application/use-my-engineer-registration';
export { useMyEngineerRegistration } from './application/use-my-engineer-registration';
export type {
  RegistrationOrganizationsState,
  UseRegistrationOrganizationsOptions,
} from './application/use-registration-organizations';
export {
  REGISTRATION_ORGANIZATION_PAGE_SIZE,
  useRegistrationOrganizations,
} from './application/use-registration-organizations';
export { fetchMyEngineerRegistration } from './infrastructure/my-engineer-registration-adapter';
export { fetchRegistrationOrganizations } from './infrastructure/registration-organization-adapter';
export { RegisterCustomerForm } from './ui/register-customer-form';
export { RegisterEngineerForm } from './ui/register-engineer-form';
export type { RegistrationOrganizationSelectProps } from './ui/registration-organization-select';
export { RegistrationOrganizationSelect } from './ui/registration-organization-select';

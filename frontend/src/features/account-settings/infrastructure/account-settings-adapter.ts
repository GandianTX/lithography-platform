// src/features/account-settings/infrastructure/account-settings-adapter.ts

/**
 * 账号设置的 GraphQL adapter（外部技术边界唯一落点）。
 *
 * - 复用 shared/graphql 的 executeGraphQL（Apollo client、Token 注入、ingress 错误模型），
 *   不创建第二个 Apollo Client，不直接 fetch /graphql；
 * - 原始 DTO 与 operation 只停留在本目录；对外返回 feature 内部模型或显式业务结果；
 * - 业务拒绝按稳定的 extensions.code 大类映射为显式失败结果（不依赖生产可能隐藏的
 *   extensions.errorCode）；transport / auth / 网络类失败仍上抛 GraphQLIngressError，
 *   UNAUTHENTICATED 由共享 ingress 链路交给全局会话失效处理（本 adapter 不做登出，
 *   修改密码成功后的客户端会话收口由页面装配层接线，见 pages/account-settings）。
 *
 * 错误码真源：backend/src/core/common/errors/domain-error.ts 的 MY_ACCOUNT_ERROR 组与
 * graphql-exception.filter.ts 的大类映射。显式条目：LOGIN_CREDENTIAL_BOTH_EMPTY /
 * CURRENT_PASSWORD_MISMATCH → BAD_USER_INPUT、CREDENTIAL_CONFLICT → CONFLICT；
 * READ / WRITE / ROLE_DATA 复用 ADMIN_USER_ERROR 的显式 INTERNAL_SERVER_ERROR 条目。
 * 两点边界：① INPUT_NORMALIZE_* 在 filter 的 errorCodeMap 中没有显式条目，走
 * `|| 'BAD_USER_INPUT'` 默认兜底（结论同显式映射，但 filter 里找不到这些条目）；
 * ② DTO 协议级校验（class-validator → BadRequestException）在生产环境被 filter 收敛为
 * INTERNAL_SERVER_ERROR 且不透传 errorMessage——输入格式说明因此由前端兜底
 * （见 ui/account-profile-form.tsx 与 ui/change-password-form.tsx）。
 */

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';
import { type MessageKey, translateNow } from '@/shared/i18n';

import type {
  AccountSettingsProfileDraft,
  AccountSettingsProfileFailureReason,
  AccountSettingsProfileUpdateResult,
  AccountSettingsView,
  ChangeMyPasswordFailureReason,
  ChangeMyPasswordInput,
  ChangeMyPasswordOutcome,
  CustomerCompanySupplementDraft,
  CustomerCompanySupplementFailureReason,
  CustomerCompanySupplementResult,
  ManagedCompanyPage,
} from '../application/account-settings.types';

import type {
  ChangeMyPasswordResultDto,
  MyAccountSettingsDto,
  RegistrationOrganizationSearchDto,
  SupplementMyCustomerCompanyResultDto,
  UpdateMyAccountSettingsResultDto,
} from './account-settings.dto';
import { mapMyAccountSettingsDtoToView } from './account-settings-mapper';

const MY_ACCOUNT_SETTINGS_FIELDS = `
      loginName
      loginEmail
      realName
      nickname
      companyName
      trustedCompanyName
      adminLevel
      phone
      contactEmail
      role
      status
      updatedAt
`;

const MY_ACCOUNT_SETTINGS_QUERY = `
  query MyAccountSettings {
    myAccountSettings {
${MY_ACCOUNT_SETTINGS_FIELDS}
    }
  }
`;

const UPDATE_MY_ACCOUNT_PROFILE_MUTATION = `
  mutation UpdateMyAccountProfile($input: UpdateMyAccountProfileInput!) {
    updateMyAccountProfile(input: $input) {
      isUpdated
      settings {
${MY_ACCOUNT_SETTINGS_FIELDS}
      }
    }
  }
`;

const CHANGE_MY_PASSWORD_MUTATION = `
  mutation ChangeMyPassword($input: ChangeMyPasswordInput!) {
    changeMyPassword(input: $input) {
      isUpdated
      notice
    }
  }
`;

const SUPPLEMENT_MY_CUSTOMER_COMPANY_MUTATION = `
  mutation SupplementMyCustomerCompany($input: SupplementMyCustomerCompanyInput!) {
    supplementMyCustomerCompany(input: $input) {
      isUpdated
      sameNamedCompanyName
      settings {
${MY_ACCOUNT_SETTINGS_FIELDS}
      }
    }
  }
`;

/** 与注册入口同一资格口径（ACTIVE + 受管），只取 id / name */
const MANAGED_COMPANIES_QUERY = `
  query ManagedCompanySearch($pagination: PaginationArgs!, $keyword: String) {
    registrationOrganizationSearch(pagination: $pagination, keyword: $keyword) {
      items {
        id
        name
      }
      total
      page
      pageSize
    }
  }
`;

type MyAccountSettingsQueryData = {
  myAccountSettings: MyAccountSettingsDto;
};

type UpdateMyAccountProfileData = {
  updateMyAccountProfile: UpdateMyAccountSettingsResultDto;
};

type ChangeMyPasswordData = {
  changeMyPassword: ChangeMyPasswordResultDto;
};

type UpdateMyAccountProfileInputDto = {
  contactEmail?: string | null;
  nickname?: string;
  phone?: string | null;
  realName?: string | null;
};

type SupplementMyCustomerCompanyInputDto = {
  organizationId?: number;
  organizationName?: string;
};

type SupplementMyCustomerCompanyData = {
  supplementMyCustomerCompany: SupplementMyCustomerCompanyResultDto;
};

type ManagedCompanySearchData = {
  registrationOrganizationSearch: RegistrationOrganizationSearchDto;
};

type CommandReasonMap<Reason extends string> = Partial<Record<string, Reason>>;

/** 大类码 → 展示原因映射（extensions.code 契约保证稳定）；errorMessage 仅作可选细化 */
const PROFILE_REASON_BY_CATEGORY_CODE: CommandReasonMap<AccountSettingsProfileFailureReason> = {
  BAD_USER_INPUT: 'invalid-input',
  CONFLICT: 'duplicate-credential',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'update-failed',
};

const PASSWORD_REASON_BY_CATEGORY_CODE: CommandReasonMap<ChangeMyPasswordFailureReason> = {
  BAD_USER_INPUT: 'invalid-input',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'update-failed',
};

const COMPANY_SUPPLEMENT_REASON_BY_CATEGORY_CODE: CommandReasonMap<CustomerCompanySupplementFailureReason> =
  {
    BAD_USER_INPUT: 'invalid-input',
    CONFLICT: 'already-bound',
    FORBIDDEN: 'forbidden',
    INTERNAL_SERVER_ERROR: 'update-failed',
  };

/** 可选细化：后端暴露 extensions.errorCode 时区分「组织不可用」与普通输入非法 */
const COMPANY_SUPPLEMENT_REFINED_REASON_BY_ERROR_CODE: CommandReasonMap<CustomerCompanySupplementFailureReason> =
  {
    ACCOUNT_ORGANIZATION_NOT_AVAILABLE: 'organization-not-available',
    MY_ACCOUNT_CUSTOMER_COMPANY_ALREADY_BOUND: 'already-bound',
    MY_ACCOUNT_CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT: 'already-bound',
    MY_ACCOUNT_CUSTOMER_COMPANY_INPUT_INVALID: 'invalid-input',
  };

const FALLBACK_MESSAGE_BY_REASON: Record<string, MessageKey> = {
  'already-bound': 'account.command.alreadyBound',
  'duplicate-credential': 'account.command.duplicateCredential',
  forbidden: 'account.command.forbidden',
  'invalid-input': 'account.command.invalidInput',
  'organization-not-available': 'account.command.organizationNotAvailable',
  'update-failed': 'account.command.failed',
};

function toCommandFailure<Reason extends string>(
  error: unknown,
  reasonByCategoryCode: CommandReasonMap<Reason>,
): { message: string; ok: false; reason: Reason } | null {
  const detail = readGraphQLErrorDetail(error);
  const reason = detail?.code ? reasonByCategoryCode[detail.code] : undefined;

  if (!detail || !reason) {
    return null;
  }

  return {
    message:
      detail.errorMessage ??
      translateNow(FALLBACK_MESSAGE_BY_REASON[reason] ?? 'account.command.failed'),
    ok: false,
    reason,
  };
}

/**
 * 当前账号设置读取（受保护 query）。
 * 失败（transport / auth / 数据守卫）原样上抛，由 application 的加载状态机收敛。
 */
export async function fetchMyAccountSettings(): Promise<AccountSettingsView> {
  const data = await executeGraphQL<MyAccountSettingsQueryData, Record<string, never>>(
    MY_ACCOUNT_SETTINGS_QUERY,
    {},
  );

  return mapMyAccountSettingsDtoToView(data.myAccountSettings);
}

/**
 * 三态 input 构造：draft 中 `undefined` 的键保持省略（不修改），显式 `null` 原样保留（清空），
 * 字符串原样传递（设置）。本函数不做 trim / 业务裁决——草稿由调用方按当前视图 diff 生成。
 * 本页只写 realName / nickname / phone / contactEmail；登录名与登录邮箱等旧字段不再由本页编辑。
 */
function toUpdateInput(draft: AccountSettingsProfileDraft): UpdateMyAccountProfileInputDto {
  const input: UpdateMyAccountProfileInputDto = {};

  if (draft.realName !== undefined) {
    input.realName = draft.realName;
  }

  if (draft.nickname !== undefined) {
    input.nickname = draft.nickname;
  }

  if (draft.phone !== undefined) {
    input.phone = draft.phone;
  }

  if (draft.contactEmail !== undefined) {
    input.contactEmail = draft.contactEmail;
  }

  return input;
}

/** 当前用户资料更新（受保护 mutation），返回后端权威的最新设置视图。 */
export async function updateMyAccountSettingsProfile(
  draft: AccountSettingsProfileDraft,
): Promise<AccountSettingsProfileUpdateResult> {
  try {
    const data = await executeGraphQL<
      UpdateMyAccountProfileData,
      { input: UpdateMyAccountProfileInputDto }
    >(UPDATE_MY_ACCOUNT_PROFILE_MUTATION, { input: toUpdateInput(draft) });

    return {
      isUpdated: data.updateMyAccountProfile.isUpdated,
      ok: true,
      settings: mapMyAccountSettingsDtoToView(data.updateMyAccountProfile.settings),
    };
  } catch (error) {
    const failure = toCommandFailure(error, PROFILE_REASON_BY_CATEGORY_CODE);

    if (failure) {
      return failure;
    }

    throw error;
  }
}

/**
 * 当前用户自助修改密码（受保护 mutation）。
 * 密码本身不出现在任何结果中，成功只回传后端固定安全提示；
 * 客户端会话收口（与当前会话比对后清理唯一会话真源并跳转登录）由页面装配层执行，
 * 发起时的会话身份采样发生在 useAccountSettings（adapter 不接触会话）。
 */
export async function changeMyPassword(
  input: ChangeMyPasswordInput,
): Promise<ChangeMyPasswordOutcome> {
  try {
    const data = await executeGraphQL<ChangeMyPasswordData, { input: ChangeMyPasswordInput }>(
      CHANGE_MY_PASSWORD_MUTATION,
      { input },
    );

    return { notice: data.changeMyPassword.notice, ok: true };
  } catch (error) {
    const failure = toCommandFailure(error, PASSWORD_REASON_BY_CATEGORY_CODE);

    if (failure) {
      return failure;
    }

    throw error;
  }
}

/**
 * 名单内受管公司候选（受保护只读，分页 + 关键字）。
 *
 * 复用注册入口的 `registrationOrganizationSearch`：资格口径由服务端决定
 * （ACTIVE 且受管），前端不做二次过滤；空白关键字整体省略。
 */
export async function searchManagedCompanies(search: {
  keyword?: string;
  page: number;
  pageSize: number;
}): Promise<ManagedCompanyPage> {
  const keyword = search.keyword?.trim();

  const data = await executeGraphQL<
    ManagedCompanySearchData,
    {
      pagination: { mode: 'OFFSET'; page: number; pageSize: number; withTotal: true };
      keyword?: string;
    }
  >(
    MANAGED_COMPANIES_QUERY,
    {
      pagination: {
        mode: 'OFFSET',
        page: search.page,
        pageSize: search.pageSize,
        withTotal: true,
      },
      ...(keyword ? { keyword } : {}),
    },
    { fetchPolicy: 'no-cache' },
  );

  const page = data.registrationOrganizationSearch;

  return {
    items: page.items,
    page: page.page ?? search.page,
    pageSize: page.pageSize ?? search.pageSize,
    total: page.total ?? 0,
  };
}

/**
 * 缺归属客户补录本人公司（受保护 mutation）。
 *
 * 二选一草稿直接映射为互斥入参；成功返回后端权威视图（与资料更新同一读模型）。
 * 业务拒绝按稳定大类码映射，`extensions.errorCode` 仅在暴露时细化「组织不可用」，
 * 生产隐藏该字段时回退大类码，不会失效。
 */
export async function supplementMyCustomerCompany(
  draft: CustomerCompanySupplementDraft,
): Promise<CustomerCompanySupplementResult> {
  const input: SupplementMyCustomerCompanyInputDto =
    draft.kind === 'existing'
      ? { organizationId: draft.organizationId }
      : { organizationName: draft.organizationName };

  try {
    const data = await executeGraphQL<
      SupplementMyCustomerCompanyData,
      { input: SupplementMyCustomerCompanyInputDto }
    >(SUPPLEMENT_MY_CUSTOMER_COMPANY_MUTATION, { input });

    return {
      isUpdated: data.supplementMyCustomerCompany.isUpdated,
      ok: true,
      sameNamedCompanyName: data.supplementMyCustomerCompany.sameNamedCompanyName,
      settings: mapMyAccountSettingsDtoToView(data.supplementMyCustomerCompany.settings),
    };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const categoryReason = detail?.code
      ? COMPANY_SUPPLEMENT_REASON_BY_CATEGORY_CODE[detail.code]
      : undefined;

    if (!detail || !categoryReason) {
      throw error;
    }

    const reason =
      (detail.errorCode
        ? COMPANY_SUPPLEMENT_REFINED_REASON_BY_ERROR_CODE[detail.errorCode]
        : undefined) ?? categoryReason;

    return {
      message: detail.errorMessage ?? translateNow(FALLBACK_MESSAGE_BY_REASON[reason]),
      ok: false,
      reason,
    };
  }
}

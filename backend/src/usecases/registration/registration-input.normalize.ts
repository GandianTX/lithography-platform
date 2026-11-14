// src/usecases/registration/registration-input.normalize.ts

import { AudienceTypeEnum, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  EngineerRegistrationReviewAction,
  EngineerRegistrationApplicationStatus,
} from '@app-types/models/registration.types';
import { DomainError } from '@core/common/errors';
import {
  ENGINEER_REGISTRATION_ERROR,
  INPUT_NORMALIZE_ERROR,
} from '@core/common/errors/domain-error';
import {
  normalizeEnumValue,
  normalizeOptionalText,
  normalizeRequiredText,
} from '@core/common/input-normalize/input-normalize.policy';

/** 申请说明与审核意见的数据库列上限（varchar(2000)），超长在输入层即拒绝 */
const REGISTRATION_TEXT_MAX_LENGTH = 2000;

/** 手填公司名称对应 `organization.name` 的列上限（varchar(200)） */
const REGISTRATION_ORGANIZATION_NAME_MAX_LENGTH = 200;

/** 真实姓名对应 `base_user_info.real_name` 的列上限（varchar(200)） */
const REGISTRATION_REAL_NAME_MAX_LENGTH = 200;

/** 联系电话对应 `base_user_info.phone` 的列上限（varchar(20)） */
const REGISTRATION_PHONE_MAX_LENGTH = 20;

/**
 * Web 注册可写邮箱上限：`base_user_info.email` 列宽 50。
 *
 * Web 入口按既定语义「联系邮箱默认取登录邮箱」，因此登录邮箱必须同时适配
 * `base_user_account.login_email`（100）与 `base_user_info.email`（50）两列。
 * 旧 `register` 入口维持原输入契约（254），不因本收敛被动收紧。
 */
export const WEB_REGISTRATION_EMAIL_MAX_LENGTH = 50;

/** Web 注册登录名上限：`base_user_account.login_name` 列宽 30 */
export const WEB_REGISTRATION_LOGIN_NAME_MAX_LENGTH = 30;

/**
 * Web 默认昵称基础候选的最大长度。
 *
 * `base_user_info.nickname` 列宽 50，昵称冲突时 `generateUniqueNicknameWithSuffix`
 * 追加 `#` + 6 位随机后缀共 7 个字符，故基础候选最多 43 个字符才能保证追加后仍在列内。
 */
export const WEB_REGISTRATION_NICKNAME_BASE_MAX_LENGTH = 43;

interface RegisterWithEmailNormalizeInput {
  loginEmail: string;
  nickname?: string | null;
}

interface RegisterWithEmailNormalizeOutput {
  loginEmail: string;
  nickname?: string;
}

interface RegisterWithThirdPartyNormalizeInput {
  email?: string | null;
}

interface RegisterWithThirdPartyNormalizeOutput {
  email?: string;
}

interface WeappRegisterNormalizeOutput {
  defaultNickname: string;
}

interface WeappRegisterParamsNormalizeInput {
  authCredential: string;
  audience: AudienceTypeEnum;
}

interface WeappRegisterParamsNormalizeOutput {
  authCredential: string;
  audience: AudienceTypeEnum;
}

export function normalizeRegisterWithEmailInput(
  input: RegisterWithEmailNormalizeInput,
): RegisterWithEmailNormalizeOutput {
  const normalizedLoginEmail = normalizeRequiredText(input.loginEmail, {
    fieldName: '登录邮箱',
  });
  return {
    loginEmail: normalizeRegistrationEmail(normalizedLoginEmail),
    nickname: normalizeRegistrationNickname(input.nickname),
  };
}

/**
 * Web 入口的列宽边界校验（在归一化之后、任何公司/账号写入之前执行）。
 *
 * - 登录邮箱：Web 联系邮箱默认取登录邮箱，必须适配 `base_user_info.email`（50）；
 * - 登录名：必须适配 `base_user_account.login_name`（30），长度仍要求 4–30。
 *
 * 旧 `register` 入口不调用本函数，维持原输入契约。
 */
export function assertWebRegistrationColumnLimits(input: {
  loginName?: string | null;
  loginEmail: string;
}): void {
  if (input.loginEmail.length > WEB_REGISTRATION_EMAIL_MAX_LENGTH) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `登录邮箱最多 ${WEB_REGISTRATION_EMAIL_MAX_LENGTH} 个字符`,
      { field: 'loginEmail' },
    );
  }

  if (input.loginName === null || typeof input.loginName === 'undefined') {
    return;
  }

  if (input.loginName.length < 4) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '登录名至少 4 个字符', {
      field: 'loginName',
    });
  }

  if (input.loginName.length > WEB_REGISTRATION_LOGIN_NAME_MAX_LENGTH) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `登录名最多 ${WEB_REGISTRATION_LOGIN_NAME_MAX_LENGTH} 个字符`,
      { field: 'loginName' },
    );
  }
}

export function normalizeRegistrationNicknameCandidatesInput(input: {
  providedNickname?: unknown;
  fallbackOptions?: unknown;
  /** 默认候选的最大字符数；提供时按字符截断，保证追加冲突后缀后仍在列内 */
  maxFallbackLength?: number;
}): {
  providedNickname?: string;
  fallbackOptions: string[];
} {
  const providedNickname = normalizeOptionalText(input.providedNickname, 'to_undefined', {
    fieldName: '昵称',
  });
  if (typeof input.fallbackOptions === 'undefined' || input.fallbackOptions === null) {
    return {
      providedNickname: providedNickname ?? undefined,
      fallbackOptions: [],
    };
  }
  if (!Array.isArray(input.fallbackOptions)) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT_LIST, '昵称备选项 必须是字符串列表');
  }

  const fallbackOptions: string[] = [];
  for (const option of input.fallbackOptions) {
    const normalized = normalizeOptionalText(option, 'to_undefined', {
      fieldName: '昵称备选项',
    });
    if (typeof normalized !== 'string') {
      continue;
    }
    // 按 Unicode 码点截断，避免把代理对（emoji / 生僻字）切成半个字符
    const bounded =
      typeof input.maxFallbackLength === 'number' && input.maxFallbackLength > 0
        ? Array.from(normalized).slice(0, input.maxFallbackLength).join('')
        : normalized;
    if (bounded.length > 0 && !fallbackOptions.includes(bounded)) {
      fallbackOptions.push(bounded);
    }
  }

  return {
    providedNickname: providedNickname ?? undefined,
    fallbackOptions,
  };
}

export function normalizeRegisterWithThirdPartyInput(
  input: RegisterWithThirdPartyNormalizeInput,
): RegisterWithThirdPartyNormalizeOutput {
  const normalizedEmail = normalizeOptionalText(input.email, 'to_undefined', {
    fieldName: '邮箱',
  });

  if (normalizedEmail === null) {
    return { email: undefined };
  }

  if (typeof normalizedEmail === 'undefined') {
    return { email: undefined };
  }

  return {
    email: normalizeRegistrationEmail(normalizedEmail),
  };
}

export function normalizeWeappRegisterInput(): WeappRegisterNormalizeOutput {
  return {
    defaultNickname: normalizeRegistrationNickname('微信用户') ?? '微信用户',
  };
}

export function normalizeWeappRegisterParams(
  input: WeappRegisterParamsNormalizeInput,
): WeappRegisterParamsNormalizeOutput {
  const normalizedCredential = normalizeRequiredText(input.authCredential, {
    fieldName: '身份凭证',
  });
  const normalizedAudience = normalizeEnumValue<AudienceTypeEnum>(
    input.audience,
    Object.values(AudienceTypeEnum),
    { fieldName: '客户端类型' },
  );

  return {
    authCredential: normalizedCredential,
    audience: normalizedAudience,
  };
}

function normalizeRegistrationNickname(value?: string | null): string | undefined {
  const normalizedNickname = normalizeOptionalText(value, 'to_undefined', {
    fieldName: '昵称',
  });

  if (normalizedNickname === null) {
    return undefined;
  }

  if (typeof normalizedNickname === 'undefined') {
    return undefined;
  }

  const transformedNickname = normalizeRegistrationNicknameText(normalizedNickname);
  const stableNickname = normalizeRequiredText(transformedNickname, {
    fieldName: '昵称',
  });
  return validateRegistrationNickname(stableNickname);
}

function normalizeRegistrationEmail(value: string): string {
  return value.toLowerCase();
}

function normalizeRegistrationNicknameText(value: string): string {
  const normalized = value
    .replace(/[\uFF01-\uFF5E]/g, (char) => {
      return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
    })
    .replace(/[\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
      '',
    )
    .trim();

  if (normalized.length === 0) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.OPTIONAL_TEXT_EMPTY_REJECTED, '昵称 不能为空白');
  }

  return normalized;
}

function validateRegistrationNickname(value: string): string {
  if (value.length < 2) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '昵称至少 2 个字符');
  }

  if (value.length > 20) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '昵称最多 20 个字符');
  }

  if (!/^(?![\p{Script=Han}]{8,})[\p{Script=Han}A-Za-z0-9 _\-\u00B7\u30FB.]{2,20}$/u.test(value)) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      '昵称长度限制：中文最多 7 个汉字，整体长度 2 到 20 个字符；允许中文、英文、数字、空格、下划线 _、短横线 -、中点 ·/・、点 .；不支持 Emoji',
    );
  }

  return value;
}

/**
 * 注册所选组织主键：必须是正整数。
 *
 * 只做输入形态校验；组织可用性由创建事务内按入口资格复核：
 * Web 注册用 `OrganizationQueryService.findEligibleRegistrationOption()`（ACTIVE 且受管），
 * 小程序注册与凭据重提用 `findActiveRegistrationOption()`（仅 ACTIVE），绝不信任客户端自报。
 */
export function normalizeRegistrationOrganizationId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DomainError(ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS, '请选择有效的组织', {
      field: 'organizationId',
    });
  }
  return value;
}

/**
 * 客户手填公司名称：可选；去首尾空白后为空视为未填（返回 null）。
 * 对应 `organization.name` 列上限 200，超长在输入层拒绝。
 * 同名公司不合并：写入侧会新建一条独立公司档。
 */
export function normalizeRegistrationOrganizationName(value: unknown): string | null {
  return normalizeRegistrationOptionalText(
    value,
    '公司名称',
    REGISTRATION_ORGANIZATION_NAME_MAX_LENGTH,
  );
}

/** 注册公司分支：选择名单内公司，或手填自家公司名称；二者互斥 */
export type RegistrationOrganizationChoice =
  { kind: 'EXISTING'; organizationId: number } | { kind: 'SELF_FILLED'; organizationName: string };

/**
 * 解析注册的公司分支。
 *
 * - 客户注册：`organizationId` 与 `organizationName` 必须恰好提供一个；
 *   混传或皆空均明确拒绝，不猜测用户意图；
 * - 工程师注册：本期只允许选择名单内公司，手填分支留给后续阶段。
 */
export function resolveRegistrationOrganizationChoice(input: {
  organizationId?: number | null;
  organizationName?: string | null;
  role: IdentityTypeEnum.CUSTOMER | IdentityTypeEnum.ENGINEER;
}): RegistrationOrganizationChoice {
  const hasOrganizationId =
    input.organizationId !== null && typeof input.organizationId !== 'undefined';
  const normalizedOrganizationName = normalizeRegistrationOrganizationName(input.organizationName);
  const hasOrganizationName = normalizedOrganizationName !== null;

  if (hasOrganizationId && hasOrganizationName) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      '所属公司只能选择名单内公司或手填自家公司名称，二者不能同时提交',
      { field: 'organizationName' },
    );
  }

  if (input.role === IdentityTypeEnum.ENGINEER) {
    if (hasOrganizationName) {
      throw new DomainError(
        INPUT_NORMALIZE_ERROR.INVALID_TEXT,
        '工程师注册必须选择名单内公司，不能手填公司名称',
        { field: 'organizationName' },
      );
    }
    return {
      kind: 'EXISTING',
      organizationId: normalizeRegistrationOrganizationId(input.organizationId),
    };
  }

  if (hasOrganizationId) {
    return {
      kind: 'EXISTING',
      organizationId: normalizeRegistrationOrganizationId(input.organizationId),
    };
  }

  if (hasOrganizationName) {
    return { kind: 'SELF_FILLED', organizationName: normalizedOrganizationName };
  }

  throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '请选择所属公司或手填自家公司名称', {
    field: 'organizationName',
  });
}

/**
 * 旧 `register` 入口的公司分支：只接受名单内公司主键，且必填。
 *
 * 与 Web 入口的差异：不支持手填公司名称（旧请求形状没有该字段），资格口径为
 * 仅 `ACTIVE`（事务内用 `findActiveRegistrationOption()` 复核），不要求受管。
 * 若调用方在旧通道提交 `organizationName`，明确拒绝而不是静默忽略。
 */
export function resolveLegacyRegistrationOrganizationChoice(input: {
  organizationId?: number | null;
  organizationName?: string | null;
}): RegistrationOrganizationChoice {
  if (normalizeRegistrationOrganizationName(input.organizationName) !== null) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      '旧版注册入口不支持手填公司名称，请提交 organizationId',
      { field: 'organizationName' },
    );
  }
  return {
    kind: 'EXISTING',
    organizationId: normalizeRegistrationOrganizationId(input.organizationId),
  };
}

/**
 * 工程师注册的真实姓名与联系电话：二者均必填。
 *
 * - 只做输入形态与列上限校验；`real_name` 为 varchar(200)、`phone` 为 varchar(20)，
 *   超长在进入事务前拒绝；
 * - 电话允许前导 `+` 与空格/短横线分隔，去分隔符后必须是 6–20 位数字；
 *   落库保留用户输入的 trim 原值，不做进一步改写；
 * - 客户注册不调用本收敛，姓名/电话不写入资料。
 */
export function normalizeEngineerRegistrationProfile(input: {
  realName: unknown;
  phone: unknown;
}): { realName: string; phone: string } {
  const realName = normalizeRequiredText(input.realName, { fieldName: '姓名' });
  if (realName.length > REGISTRATION_REAL_NAME_MAX_LENGTH) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `姓名最多 ${REGISTRATION_REAL_NAME_MAX_LENGTH} 个字符`,
      { field: 'realName' },
    );
  }

  const phone = normalizeRequiredText(input.phone, { fieldName: '联系电话' });
  if (phone.length > REGISTRATION_PHONE_MAX_LENGTH) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `联系电话最多 ${REGISTRATION_PHONE_MAX_LENGTH} 个字符`,
      { field: 'phone' },
    );
  }
  const compactPhone = phone.replace(/[\s-]/g, '');
  if (!/^\+?\d{6,20}$/.test(compactPhone)) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      '联系电话格式不正确，请填写 6–20 位数字',
      {
        field: 'phone',
      },
    );
  }

  return { realName, phone };
}

/**
 * 旧 `register` 入口的工程师资料：姓名与电话均可省略。
 *
 * - 两者都缺省（`null` / `undefined`）→ 返回 `null`，只创建待审账号与申请，不写姓名电话；
 * - 任一提供 → 复用与 Web 相同的必填与格式校验（即「部分提供」视为完整资料提交，
 *   缺另一项按必填错误拒绝）。
 */
export function normalizeLegacyEngineerRegistrationProfile(input: {
  realName: unknown;
  phone: unknown;
}): { realName: string; phone: string } | null {
  const realNameMissing = input.realName === null || typeof input.realName === 'undefined';
  const phoneMissing = input.phone === null || typeof input.phone === 'undefined';
  if (realNameMissing && phoneMissing) {
    return null;
  }
  return normalizeEngineerRegistrationProfile(input);
}

/**
 * 工程师申请说明：可选，去首尾空白；空白视为未填写（返回 null）。
 * 列上限 2000 字符，超长在输入层即拒绝。
 */
export function normalizeRegistrationApplicationNote(value: unknown): string | null {
  return normalizeRegistrationOptionalText(value, '申请说明');
}

/** 组织管理员审核意见：可选，去首尾空白；空白视为未填写（返回 null） */
export function normalizeEngineerRegistrationReviewComment(value: unknown): string | null {
  return normalizeRegistrationOptionalText(value, '审核意见');
}

/** 审核目标申请主键：必须是正整数（可见范围仍由用例按可信组织复核） */
export function normalizeEngineerRegistrationApplicationId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DomainError(ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS, '请选择有效的注册申请', {
      field: 'applicationId',
    });
  }
  return value;
}

/**
 * 申请人与审核管理员的凭据证明输入（本人状态查询 / 重提共用）。
 *
 * - 标识符允许登录名或登录邮箱（`AccountQueryService.findCredentialByLoginName()` 同口径），
 *   去首尾空白后必须非空；
 * - 密码**不 trim**：trim 会静默改写秘密，正确密码可能含首尾空白；
 *   纯空白在凭据比对时统一按 `CREDENTIAL_MISMATCH` 处理，不在输入层区分。
 */
export function normalizeEngineerRegistrationCredential(input: {
  accountIdentifier: unknown;
  password: unknown;
}): { accountIdentifier: string; password: string } {
  const accountIdentifier = normalizeRequiredText(input.accountIdentifier, {
    fieldName: '登录名或登录邮箱',
  });
  if (typeof input.password !== 'string' || input.password.length === 0) {
    throw new DomainError(ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS, '密码不能为空', {
      field: 'password',
    });
  }
  return { accountIdentifier, password: input.password };
}

/** 审核动作：只接受 APPROVE / REJECT 两个终态 */
export function normalizeEngineerRegistrationReviewAction(
  value: unknown,
): EngineerRegistrationReviewAction {
  return normalizeEnumValue<EngineerRegistrationReviewAction>(
    value,
    Object.values(EngineerRegistrationReviewAction),
    { fieldName: '审核动作' },
  );
}

/** 组织审核队列状态筛选：缺省/空白表示不筛选 */
export function normalizeEngineerRegistrationStatusFilter(
  value: unknown,
): EngineerRegistrationApplicationStatus | undefined {
  const normalized = normalizeOptionalText(value, 'to_undefined', { fieldName: '申请状态' });
  if (typeof normalized !== 'string') {
    return undefined;
  }
  return normalizeEnumValue<EngineerRegistrationApplicationStatus>(
    normalized,
    Object.values(EngineerRegistrationApplicationStatus),
    { fieldName: '申请状态' },
  );
}

/** 注册公司候选检索关键字：去首尾空白；空白视为未填；超长拒绝而非静默截断 */
export function normalizeRegistrationOrganizationKeyword(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '公司名称 必须是字符串', {
      field: 'keyword',
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, `公司名称最多 ${maxLength} 个字符`, {
      field: 'keyword',
    });
  }
  return trimmed;
}

/**
 * 注册文本型可选字段的统一收敛：非字符串按输入问题拒绝；去首尾空白后为空返回 null；
 * 超过列上限拒绝。`fieldName` 用于组装可定位字段的提示。
 */
function normalizeRegistrationOptionalText(
  value: unknown,
  fieldName: string,
  maxLength: number = REGISTRATION_TEXT_MAX_LENGTH,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new DomainError(ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS, `${fieldName}必须是字符串`, {
      field: fieldName,
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new DomainError(
      ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS,
      `${fieldName}最多 ${maxLength} 个字符`,
      { field: fieldName },
    );
  }
  return trimmed;
}

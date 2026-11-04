// src/usecases/registration/registration-input.normalize.ts

import { AudienceTypeEnum } from '@app-types/models/account.types';
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

export function normalizeRegistrationNicknameCandidatesInput(input: {
  providedNickname?: unknown;
  fallbackOptions?: unknown;
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
    if (typeof normalized === 'string' && !fallbackOptions.includes(normalized)) {
      fallbackOptions.push(normalized);
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
 * 只做输入形态校验；组织是否 ACTIVE 由创建事务内的
 * `OrganizationQueryService.findActiveRegistrationOption()` 复核，绝不信任客户端自报。
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

/**
 * 注册文本型可选字段的统一收敛：非字符串按输入问题拒绝；去首尾空白后为空返回 null；
 * 超过列上限拒绝。`fieldName` 用于组装可定位字段的提示。
 */
function normalizeRegistrationOptionalText(value: unknown, fieldName: string): string | null {
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
  if (trimmed.length > REGISTRATION_TEXT_MAX_LENGTH) {
    throw new DomainError(
      ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS,
      `${fieldName}最多 ${REGISTRATION_TEXT_MAX_LENGTH} 个字符`,
      { field: fieldName },
    );
  }
  return trimmed;
}

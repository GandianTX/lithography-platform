// src/core/organization/policy/admin-organization-provisioning.policy.ts

import { createHash } from 'crypto';
import { DomainError, ORGANIZATION_MANAGEMENT_ERROR } from '@core/common/errors/domain-error';
import {
  LOGIN_NAME_MAX_LENGTH,
  LOGIN_NAME_MIN_LENGTH,
  LOGIN_NAME_PATTERN,
} from '@core/account/policy/login-name.policy';

/**
 * 一级管理员「新增公司并开通二级管理员」的纯策略口径。
 *
 * 本文件只做无 I/O 的确定性换算与校验：
 * - 提交标识归一化（UUID 形状）与输入指纹；
 * - 开通账号的登录名 / 昵称推导；
 * - 首次临时密码候选生成。
 *
 * 刻意不引入 ORM、Repository、日志或第二套密码策略：指纹字段顺序、登录名前缀与
 * 临时密码形状必须单点定义，否则幂等回放与凭据口径会相互漂移。
 */

/** 提交标识语义域；新增用途必须新迁移（数据库 CHECK 失败关闭）。 */
export const ADMIN_ORGANIZATION_PROVISIONING_PURPOSE = 'ADMIN_CREATE_ORGANIZATION';

/** 开通账号登录名前缀；整体长度必须落在 `login_name` 列宽内。 */
export const PROVISIONED_ADMIN_LOGIN_PREFIX = 'orgadmin_';

/** 登录名中由公司编号派生摘要的十六进制字符数（9 + 20 = 29 ≤ 30）。 */
export const PROVISIONED_ADMIN_LOGIN_HASH_LENGTH = 20;

/** 登录名长度上限：与 `base_user_account.login_name` varchar(30) 一致。 */
export const PROVISIONED_ADMIN_LOGIN_MAX_LENGTH = LOGIN_NAME_MAX_LENGTH;

/** 昵称长度上限：与 `base_user_info.nickname` varchar(50) 一致。 */
export const PROVISIONED_ADMIN_NICKNAME_MAX_LENGTH = 50;

/** 临时密码固定前缀：保证同时含大写、小写、数字与特殊字符。 */
export const PROVISIONED_ADMIN_TEMPORARY_PASSWORD_PREFIX = 'Aa1!';

/** 临时密码随机段长度。 */
export const PROVISIONED_ADMIN_TEMPORARY_PASSWORD_RANDOM_LENGTH = 16;

/**
 * 临时密码随机字符表（恰好 64 个字符）。
 *
 * 长度取 2 的幂，使 `byte % 64` 无模偏置；排除易混淆字符 `I`/`O`/`l`/`0`/`1`。
 */
const TEMPORARY_PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZ' + // 24
  'abcdefghijkmnopqrstuvwxyz' + // 24
  '23456789' + // 8
  '!@#$%^&*'; // 8

/** UUID 形状（允许 1~8 版本、8/9/a/b 变体，大小写不敏感）。 */
const SUBMISSION_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 指纹输入：与 `CreateManagedCompanyData` 结构兼容，但只声明本策略真正消费的字段，
 * 避免 core 层反向依赖 modules 类型。
 */
export interface ProvisioningFingerprintInput {
  readonly name: string;
  readonly shortName: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string;
  readonly contactEmail: string | null;
  readonly address: string | null;
  readonly remark: string | null;
  readonly status: string;
  readonly isServiceProvider: boolean;
}

/** 指纹字段顺序（锁定，不得重排；重排即所有历史提交失效）。 */
const FINGERPRINT_FIELD_ORDER = [
  'name',
  'shortName',
  'contactName',
  'contactPhone',
  'contactEmail',
  'address',
  'remark',
  'status',
  'isServiceProvider',
] as const satisfies ReadonlyArray<keyof ProvisioningFingerprintInput>;

/**
 * 归一化并校验提交标识。
 *
 * - 去首尾空白并统一小写（数据库 `_ci` 排序规则下大小写等价，统一后可避免回放口径分裂）；
 * - 非字符串、空串或非 UUID 形状一律 `SUBMISSION_KEY_INVALID`（对外 `BAD_USER_INPUT`）。
 */
export function normalizeProvisioningSubmissionKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_KEY_INVALID,
      '提交标识必须是字符串',
    );
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || !SUBMISSION_KEY_PATTERN.test(normalized)) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_KEY_INVALID,
      '提交标识格式非法，请刷新页面后重试',
    );
  }

  return normalized;
}

/**
 * 计算规范化输入的 SHA-256 指纹。
 *
 * 以固定字段顺序的数组做 `JSON.stringify`，因此「同输入同指纹」；
 * `null` 与空串在指纹上可区分，防止静默混同。
 */
export function computeProvisioningInputFingerprint(data: ProvisioningFingerprintInput): string {
  const payload = FINGERPRINT_FIELD_ORDER.map((field) => data[field]);
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

/**
 * 由稳定公司编号推导开通账号登录名。
 *
 * 形如 `orgadmin_<sha256(code) 前 20 位十六进制>`，固定 29 字符：
 * 既满足 `login_name` varchar(30)，又避免直接暴露公司编号。
 */
export function deriveProvisionedAdminLoginName(organizationCode: string): string {
  const digest = createHash('sha256').update(organizationCode, 'utf8').digest('hex');
  const loginName =
    PROVISIONED_ADMIN_LOGIN_PREFIX + digest.slice(0, PROVISIONED_ADMIN_LOGIN_HASH_LENGTH);

  if (
    loginName.length < LOGIN_NAME_MIN_LENGTH ||
    loginName.length > PROVISIONED_ADMIN_LOGIN_MAX_LENGTH ||
    !LOGIN_NAME_PATTERN.test(loginName)
  ) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
      '开通账号登录名生成失败，请稍后重试',
    );
  }

  return loginName;
}

/**
 * 由公司名称推导开通账号昵称。
 *
 * 按 Unicode 码点截断（不切断代理对），并保证不产出空串。
 */
export function deriveProvisionedAdminNickname(companyName: string): string {
  const characters = Array.from(companyName.trim());
  if (characters.length === 0) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
      '开通账号昵称生成失败，请稍后重试',
    );
  }

  return characters.slice(0, PROVISIONED_ADMIN_NICKNAME_MAX_LENGTH).join('');
}

/**
 * 生成临时密码候选。
 *
 * 形态固定为 `Aa1!` + 16 位安全随机字母数字/符号；是否满足密码策略由调用方用
 * `PasswordPolicyService.validatePassword()` 裁决并在不合格时重试。
 * 本函数不记录、不返回任何可关联到具体账号的日志事实。
 *
 * @param randomBytes 安全随机源（生产传 `randomBytes`）；返回空 Buffer 视为故障
 */
export function generateTemporaryPasswordCandidate(randomBytes: (size: number) => Buffer): string {
  const bytes = randomBytes(32);
  if (bytes.length === 0) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
      '临时密码生成失败，请稍后重试',
    );
  }

  let suffix = '';
  for (const byte of bytes) {
    const character = TEMPORARY_PASSWORD_ALPHABET[byte % TEMPORARY_PASSWORD_ALPHABET.length];
    // 拒绝连续 3 个相同字符：避免候选因密码策略的重复字符规则而不合格。
    if (character === suffix[suffix.length - 1] && character === suffix[suffix.length - 2]) {
      continue;
    }
    suffix += character;
    if (suffix.length === PROVISIONED_ADMIN_TEMPORARY_PASSWORD_RANDOM_LENGTH) {
      break;
    }
  }

  if (suffix.length < PROVISIONED_ADMIN_TEMPORARY_PASSWORD_RANDOM_LENGTH) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
      '临时密码生成失败，请稍后重试',
    );
  }

  return PROVISIONED_ADMIN_TEMPORARY_PASSWORD_PREFIX + suffix;
}

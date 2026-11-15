// src/usecases/registration/engineer-registration-credential.ts

import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AccountCredentialSnapshot } from '@src/modules/account/account.types';
import { AccountService } from '@src/modules/account/base/services/account.service';

/**
 * 待审申请人凭据证明的单一判定实现（本人状态查询与拒绝后重提共用）。
 *
 * `AccountService.verifyPassword()` 对纯空白密码会抛 `AUTH_ERROR.INVALID_PASSWORD`
 * （登录语义，映射 UNAUTHENTICATED）；本场景把一切无法通过验证的情形统一收敛为
 * 「凭据不匹配」，不区分账号不存在、密码错误或密码形态异常，避免账户枚举。
 */
export function isEngineerRegistrationPasswordVerified(
  password: string,
  credential: AccountCredentialSnapshot,
): boolean {
  try {
    return AccountService.verifyPassword(password, credential.loginPassword, credential.createdAt);
  } catch {
    return false;
  }
}

/**
 * 凭据式入口的强制改密门禁（本人状态查询与拒绝后重提共用）。
 *
 * 与 JWT 会话的 `MUST_CHANGE_PASSWORD` 同口径：被要求改密的账号在完成改密前，
 * 不得通过「密码凭据」这条旁路执行其他操作，否则强制改密可被绕过。
 * 错误类别取稳定的 `PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS`（映射 `FORBIDDEN`），
 * 不依赖生产环境可能隐藏的细分错误码。
 */
export function assertCredentialPasswordChangeNotPending(credential: {
  readonly mustChangePassword: boolean;
}): void {
  if (credential.mustChangePassword) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '当前账号需要先修改登录密码');
  }
}

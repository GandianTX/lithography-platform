// src/usecases/registration/engineer-registration-credential.ts

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

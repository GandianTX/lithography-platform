// src/usecases/ai-conversation/engineer-ai-access.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  AI_CONVERSATION_ERROR,
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
  isDomainError,
} from '@core/common/errors/domain-error';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/**
 * AI 对话的工程师资格断言（建会话 / 提问 / 重试的单一实现）。
 *
 * 规则：`roles` 含 ENGINEER 且可信 JWT `activeRole` 精确为 ENGINEER。
 * 管理员即使继承工程师路由准入，也不能以 SUPER_ADMIN 身份取得提问资格
 * （R037／R038：管理员只读，不获得工程师提问身份），因此不能放宽为 hasRole。
 */
export function assertEngineerAiPermission(session: UsecaseSession, actionLabel: string): void {
  const hasEngineerRole = session.roles.includes(IdentityTypeEnum.ENGINEER);
  const isActiveRoleEngineer = session.activeRole === IdentityTypeEnum.ENGINEER;

  if (!hasEngineerRole || !isActiveRoleEngineer) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      `仅工程师账号可以${actionLabel}AI 对话`,
    );
  }
}

/**
 * 解析工程师的可信公司（会话归属公司的唯一来源）。
 *
 * - 无有效成员关系 → `COMPANY_REQUIRED`（引导先完成公司归属）；
 * - 成员角色不是 ENGINEER 或组织已停用 → `COMPANY_UNAVAILABLE`；
 * - 多条有效成员关系由 QueryService 直接拒绝（歧义不回退）。
 *
 * 公司只来自服务端事实，客户端传入的组织一律不参与。
 */
export async function resolveEngineerTrustedOrganization(params: {
  organizationContextService: TrustedOrganizationContextQueryService;
  accountId: number;
  transactionContext?: PersistenceTransactionContext;
}): Promise<number> {
  let fact: { organizationId: number; memberRole: string };
  try {
    fact = await params.organizationContextService.resolveForAccount({
      accountId: params.accountId,
      transactionContext: params.transactionContext,
    });
  } catch (error) {
    if (
      isDomainError(error) &&
      (error.code === ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP ||
        error.code === ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP)
    ) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.COMPANY_REQUIRED,
        '当前账号没有有效的公司归属，无法使用 AI 对话',
        { accountId: params.accountId },
        error,
      );
    }
    throw error;
  }

  // 成员角色来自数据库字符串列，与枚举值做字面比较（不做类型放宽）
  if (fact.memberRole !== String(IdentityTypeEnum.ENGINEER)) {
    throw new DomainError(
      AI_CONVERSATION_ERROR.COMPANY_UNAVAILABLE,
      '当前账号在公司内的角色不是工程师，无法使用 AI 对话',
      { accountId: params.accountId },
    );
  }

  return fact.organizationId;
}

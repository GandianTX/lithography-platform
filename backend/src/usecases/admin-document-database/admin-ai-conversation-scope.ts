// src/usecases/admin-document-database/admin-ai-conversation-scope.ts
// 管理员文档数据库域内的 AI 会话端点范围解析（任务 05 · S4.1）
//
// `adminAiConversations` / `adminAiMessages` 与任务 05 新增的只读详情、导出
// 复用同一授权边界（core 策略为唯一裁决点）：一级跨公司、二级仅本公司。
//
// 本文件只负责读取服务端事实（账号等级 + 唯一有效组织成员关系），
// 裁决交给 `@core/ai/ai-conversation-read-access.policy`。

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  assertAiAdminIdentity,
  assertAiAdminMembership,
  resolveAiAdminConversationScopeFromFacts,
  resolveAiAdminIdentityFacts,
  type AiAdminConversationScope,
  type AiAdminIdentityFacts,
} from '@core/ai/ai-conversation-read-access.policy';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/** 读取管理员原始事实（等级 + 唯一有效成员关系） */
async function loadAdminAiRawFacts(params: {
  session: UsecaseSession;
  accountQueryService: AccountQueryService;
  organizationContextService: TrustedOrganizationContextQueryService;
}): Promise<{
  accountId: number;
  roles: string[];
  activeRole: string | null;
  adminLevel: number | null;
  membership: { organizationId: number; memberRole: string } | null;
}> {
  // 身份先行（非管理员不查库）
  assertAiAdminIdentity({
    roles: params.session.roles,
    activeRole: params.session.activeRole ?? null,
  });
  const adminLevel = await params.accountQueryService.findAdminLevelByAccountId(
    params.session.accountId,
  );
  const membership =
    adminLevel === 1 || adminLevel === 2
      ? await params.organizationContextService.tryResolveForAccount({
          accountId: params.session.accountId,
        })
      : null;
  // 成员关系前提（失败关闭：无成员关系 / 角色不符）
  assertAiAdminMembership({
    adminLevel,
    membership:
      membership === null
        ? null
        : { organizationId: membership.organizationId, memberRole: membership.memberRole },
  });
  return {
    accountId: params.session.accountId,
    roles: [...params.session.roles],
    activeRole: params.session.activeRole ?? null,
    adminLevel,
    membership:
      membership === null
        ? null
        : { organizationId: membership.organizationId, memberRole: membership.memberRole },
  };
}

/** 管理员 AI 会话读侧范围（一级全公司 / 二级本公司；失败关闭） */
export async function resolveAdminAiConversationScope(params: {
  session: UsecaseSession;
  accountQueryService: AccountQueryService;
  organizationContextService: TrustedOrganizationContextQueryService;
}): Promise<AiAdminConversationScope> {
  return resolveAiAdminConversationScopeFromFacts(
    await loadAdminAiRawFacts({
      session: params.session,
      accountQueryService: params.accountQueryService,
      organizationContextService: params.organizationContextService,
    }),
  );
}

/** 管理员身份事实（供会话级读取权复核使用） */
export async function resolveAdminAiConversationIdentity(params: {
  session: UsecaseSession;
  accountQueryService: AccountQueryService;
  organizationContextService: TrustedOrganizationContextQueryService;
}): Promise<AiAdminIdentityFacts> {
  return resolveAiAdminIdentityFacts(
    await loadAdminAiRawFacts({
      session: params.session,
      accountQueryService: params.accountQueryService,
      organizationContextService: params.organizationContextService,
    }),
  );
}

// src/usecases/ai-conversation/admin-ai-conversation-access.ts
// 管理员 AI 会话授权装配（任务 05 · S4.1）
//
// 本模块只负责「从服务端读取授权事实」，裁决一律交给 core 策略
// （`@core/ai/ai-conversation-read-access.policy`）：
// - 账号侧管理员等级（数据库当前事实，不是 JWT 声明）；
// - 唯一有效组织成员关系（组织上下文解析，无有效关系时为 null）。
//
// 裁决口径：管理员侧读列表、读详情与导出复用同一边界——一级跨公司、二级仅本公司；
// 直传外公司会话 ID 与不存在同口径（不暴露会话是否存在）。

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  assembleAiAdminRawFacts,
  assertAiAdminIdentity,
  requiresAiAdminMembership,
  resolveAiAdminConversationScopeFromFacts,
  resolveAiAdminIdentityFacts,
  type AiAdminConversationScope,
  type AiAdminIdentityFacts,
  type AiAdminRawFacts,
} from '@core/ai/ai-conversation-read-access.policy';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

/** 管理员授权事实读取依赖（等级读账号域，可信公司读组织成员事实） */
export interface AiAdminConversationAccessDeps {
  readonly accountQueryService: AccountQueryService;
  readonly organizationContextService: TrustedOrganizationContextQueryService;
}

/**
 * 读取管理员原始事实（等级 + 唯一有效成员关系）。
 *
 * 成员关系只在等级为 1/2 时读取；等级非法时交由 core 策略按「等级不支持」拒绝。
 */
export async function loadAiAdminRawFacts(params: {
  session: UsecaseSession;
  deps: AiAdminConversationAccessDeps;
}): Promise<AiAdminRawFacts> {
  // 身份先行（非管理员不查库）
  assertAiAdminIdentity({
    roles: params.session.roles,
    activeRole: params.session.activeRole ?? null,
  });
  const adminLevel = await params.deps.accountQueryService.findAdminLevelByAccountId(
    params.session.accountId,
  );
  const membership = requiresAiAdminMembership(adminLevel)
    ? await params.deps.organizationContextService.tryResolveForAccount({
        accountId: params.session.accountId,
      })
    : null;
  // 前置断言与字段投影由 core 统一装配（管理员文档库域复用同一份）
  return assembleAiAdminRawFacts({
    accountId: params.session.accountId,
    roles: params.session.roles,
    activeRole: params.session.activeRole ?? null,
    adminLevel,
    membership:
      membership === null
        ? null
        : { organizationId: membership.organizationId, memberRole: membership.memberRole },
  });
}

/** 解析管理员读侧范围（一级全公司 / 二级本公司；失败关闭） */
export async function resolveAiAdminConversationScope(params: {
  session: UsecaseSession;
  deps: AiAdminConversationAccessDeps;
}): Promise<AiAdminConversationScope> {
  return resolveAiAdminConversationScopeFromFacts(
    await loadAiAdminRawFacts({ session: params.session, deps: params.deps }),
  );
}

/** 装配管理员身份事实（供会话级读取权复核使用） */
export async function resolveAiAdminConversationIdentity(params: {
  session: UsecaseSession;
  deps: AiAdminConversationAccessDeps;
}): Promise<AiAdminIdentityFacts> {
  return resolveAiAdminIdentityFacts(
    await loadAiAdminRawFacts({ session: params.session, deps: params.deps }),
  );
}

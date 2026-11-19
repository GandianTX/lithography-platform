// src/core/ai/ai-conversation-read-access.policy.spec.ts

import {
  AI_CONVERSATION_READ_DENIED_MESSAGES,
  assertAiAdminConversationReadAccess,
  assertAiAdminIdentity,
  assertAiAdminMembership,
  resolveAiAdminConversationListScope,
  resolveAiAdminConversationReadAccess,
  resolveAiAdminConversationScopeFromFacts,
  resolveAiAdminIdentityFacts,
  resolveAiAdminTrustedOrganizationId,
  type AiAdminIdentityFacts,
} from './ai-conversation-read-access.policy';

/**
 * 管理员读侧授权边界单测（任务 05 · S4.1）。
 *
 * 覆盖：身份失败关闭、等级失败关闭、成员关系前提、一级跨公司、
 * 二级仅本公司、外公司直传拒绝（与不存在同口径）。
 */
describe('AI 会话管理员读取授权策略', () => {
  const membership = (organizationId: number, memberRole = 'SUPER_ADMIN') => ({
    organizationId,
    memberRole,
  });

  const identity = (overrides: Partial<AiAdminIdentityFacts> = {}): AiAdminIdentityFacts => ({
    accountId: 10,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
    adminLevel: 1,
    organizationId: 100,
    trustedOrganizationId: 100,
    ...overrides,
  });

  describe('身份与等级', () => {
    it('非管理员身份失败关闭（roles / activeRole 不匹配）', () => {
      expect(
        resolveAiAdminConversationListScope(
          identity({ roles: ['ENGINEER'], activeRole: 'ENGINEER' }),
        ),
      ).toEqual({ allowed: false, reason: 'NOT_ADMIN' });
      expect(
        resolveAiAdminConversationListScope(
          identity({ roles: ['SUPER_ADMIN'], activeRole: 'ENGINEER' }),
        ),
      ).toEqual({ allowed: false, reason: 'NOT_ADMIN' });
      expect(
        resolveAiAdminConversationListScope(
          identity({ roles: ['ENGINEER'], activeRole: 'SUPER_ADMIN' }),
        ),
      ).toEqual({ allowed: false, reason: 'NOT_ADMIN' });
    });

    it('等级缺失或非法失败关闭，不按一级放行', () => {
      expect(resolveAiAdminConversationListScope(identity({ adminLevel: null }))).toEqual({
        allowed: false,
        reason: 'ADMIN_LEVEL_UNSUPPORTED',
      });
      expect(resolveAiAdminConversationListScope(identity({ adminLevel: 3 }))).toEqual({
        allowed: false,
        reason: 'ADMIN_LEVEL_UNSUPPORTED',
      });
    });

    it('一级管理员缺少有效组织管理员成员关系时失败关闭', () => {
      expect(
        resolveAiAdminConversationListScope(
          identity({ organizationId: null, trustedOrganizationId: null }),
        ),
      ).toEqual({ allowed: false, reason: 'ADMIN_MEMBERSHIP_MISSING' });
    });

    it('身份断言先于任何读库：非管理员直接抛错', () => {
      expect(() => assertAiAdminIdentity({ roles: ['ENGINEER'], activeRole: 'ENGINEER' })).toThrow(
        AI_CONVERSATION_READ_DENIED_MESSAGES.NOT_ADMIN,
      );
      expect(() =>
        assertAiAdminIdentity({ roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' }),
      ).not.toThrow();
    });
  });

  describe('成员关系前提', () => {
    it('等级 1/2 且成员角色为组织管理员时可信公司成立', () => {
      expect(
        resolveAiAdminTrustedOrganizationId({
          adminLevel: 1,
          membership: membership(100),
        }),
      ).toBe(100);
      expect(
        resolveAiAdminTrustedOrganizationId({
          adminLevel: 2,
          membership: membership(100),
        }),
      ).toBe(100);
    });

    it('无成员关系或角色不符时不产生可信公司', () => {
      expect(resolveAiAdminTrustedOrganizationId({ adminLevel: 2, membership: null })).toBeNull();
      expect(
        resolveAiAdminTrustedOrganizationId({
          adminLevel: 2,
          membership: membership(100, 'ENGINEER'),
        }),
      ).toBeNull();
    });

    it('成员关系缺失按组织口径拒绝，角色不符按权限口径拒绝', () => {
      expect(() => assertAiAdminMembership({ adminLevel: 2, membership: null })).toThrow(
        /有效组织成员关系/,
      );
      expect(() =>
        assertAiAdminMembership({ adminLevel: 2, membership: membership(100, 'CUSTOMER') }),
      ).toThrow(/组织管理员成员关系/);
      expect(assertAiAdminMembership({ adminLevel: null, membership: null })).toBeNull();
    });
  });

  describe('范围与读取权', () => {
    it('一级管理员为全公司范围', () => {
      expect(resolveAiAdminConversationListScope(identity())).toEqual({
        allowed: true,
        scope: { kind: 'ADMIN_GLOBAL' },
      });
    });

    it('二级管理员为本公司范围', () => {
      expect(
        resolveAiAdminConversationListScope(
          identity({ adminLevel: 2, organizationId: 100, trustedOrganizationId: 100 }),
        ),
      ).toEqual({
        allowed: true,
        scope: { kind: 'ADMIN_ORGANIZATION', organizationId: 100 },
      });
    });

    it('二级管理员读取本公司会话放行', () => {
      const result = resolveAiAdminConversationReadAccess({
        admin: identity({ adminLevel: 2, organizationId: 100, trustedOrganizationId: 100 }),
        conversation: { ownerAccountId: 20, ownerOrganizationId: 100 },
      });
      expect(result).toEqual({
        allowed: true,
        scope: { kind: 'ADMIN_ORGANIZATION', organizationId: 100 },
      });
    });

    it('二级管理员读取本公司工程师的独立会话放行（A05-06「二级本公司含独立会话」）', () => {
      // 独立会话不关联工单，归属公司取工程师所属公司（创建会话时写入 owner_organization_id）
      const result = resolveAiAdminConversationReadAccess({
        admin: identity({ adminLevel: 2, organizationId: 100, trustedOrganizationId: 100 }),
        conversation: { ownerAccountId: 20, ownerOrganizationId: 100 },
      });
      expect(result).toEqual({
        allowed: true,
        scope: { kind: 'ADMIN_ORGANIZATION', organizationId: 100 },
      });
    });

    it('二级管理员直传外公司会话被拒绝（与不存在同口径）', () => {
      const result = resolveAiAdminConversationReadAccess({
        admin: identity({ adminLevel: 2, organizationId: 100, trustedOrganizationId: 100 }),
        conversation: { ownerAccountId: 20, ownerOrganizationId: 999 },
      });
      expect(result).toEqual({ allowed: false, reason: 'OUTSIDE_ORGANIZATION' });
      expect(() =>
        assertAiAdminConversationReadAccess({
          admin: identity({ adminLevel: 2, organizationId: 100, trustedOrganizationId: 100 }),
          conversation: { ownerAccountId: 20, ownerOrganizationId: 999 },
        }),
      ).toThrow(/会话不存在或无权访问/);
    });

    it('二级管理员读取无归属公司的会话被拒绝', () => {
      expect(
        resolveAiAdminConversationReadAccess({
          admin: identity({ adminLevel: 2, organizationId: 100, trustedOrganizationId: 100 }),
          conversation: { ownerAccountId: 20, ownerOrganizationId: null },
        }),
      ).toEqual({ allowed: false, reason: 'OUTSIDE_ORGANIZATION' });
    });

    it('一级管理员跨公司读取放行', () => {
      expect(
        resolveAiAdminConversationReadAccess({
          admin: identity(),
          conversation: { ownerAccountId: 20, ownerOrganizationId: 999 },
        }),
      ).toEqual({ allowed: true, scope: { kind: 'ADMIN_GLOBAL' } });
    });
  });

  describe('事实装配', () => {
    it('身份事实由等级与成员关系推导', () => {
      expect(
        resolveAiAdminIdentityFacts({
          accountId: 10,
          roles: ['SUPER_ADMIN'],
          activeRole: 'SUPER_ADMIN',
          adminLevel: 2,
          membership: membership(100),
        }),
      ).toEqual({
        accountId: 10,
        roles: ['SUPER_ADMIN'],
        activeRole: 'SUPER_ADMIN',
        adminLevel: 2,
        organizationId: 100,
        trustedOrganizationId: 100,
      });
    });

    it('范围解析对不可确定的管理员失败关闭', () => {
      expect(() =>
        resolveAiAdminConversationScopeFromFacts({
          accountId: 10,
          roles: ['ENGINEER'],
          activeRole: 'ENGINEER',
          adminLevel: null,
          membership: null,
        }),
      ).toThrow(/仅管理员/);
    });
  });
});

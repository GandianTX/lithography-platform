// src/core/ai/engineer-conversation-access.policy.spec.ts
// 任务05 F01：工程师会话读／写判定的失败反例（对应 AUTH-01／02／03／04）。

import {
  canReadEngineerConversation,
  canWriteEngineerConversation,
  type EngineerConversationAccessFacts,
} from './engineer-conversation-access.policy';

const BASE: EngineerConversationAccessFacts = {
  requestId: null,
  conversationOwnerAccountId: 10,
  conversationOwnerOrganizationId: 5,
  viewerAccountId: 10,
  viewerOrganizationId: 5,
  requestFacts: null,
};

const workOrder = (
  overrides: Partial<EngineerConversationAccessFacts> = {},
): EngineerConversationAccessFacts => ({
  ...BASE,
  requestId: 900,
  requestFacts: { deletedAt: null, trustedServiceOrganizationId: 5 },
  ...overrides,
});

describe('工程师会话访问判定（F01）', () => {
  describe('独立会话', () => {
    it('本人可读可写', () => {
      expect(canReadEngineerConversation(BASE)).toBe(true);
      expect(canWriteEngineerConversation(BASE)).toBe(true);
    });

    it('同公司其他工程师也不可读（不因同公司扩大）', () => {
      const other = { ...BASE, viewerAccountId: 11 };
      expect(canReadEngineerConversation(other)).toBe(false);
      expect(canWriteEngineerConversation(other)).toBe(false);
    });

    it('公司变化不影响本人独立会话（沿用已确认独立历史规则）', () => {
      const moved = { ...BASE, viewerOrganizationId: 6 };
      expect(canReadEngineerConversation(moved)).toBe(true);
    });
  });

  describe('工单会话', () => {
    it('归属公司、工单未删、可信服务公司三者一致时可读', () => {
      expect(canReadEngineerConversation(workOrder())).toBe(true);
      expect(canWriteEngineerConversation(workOrder())).toBe(true);
    });

    it('AUTH-01：成员关系改到 B 后不可再读写原 A 工单会话', () => {
      const movedOut = workOrder({ viewerOrganizationId: 6 });
      expect(canReadEngineerConversation(movedOut)).toBe(false);
      expect(canWriteEngineerConversation(movedOut)).toBe(false);
    });

    it('AUTH-02：工单与 intake 可信服务公司改到 B 后，原 A 工程师不可读', () => {
      const retargeted = workOrder({
        requestFacts: { deletedAt: null, trustedServiceOrganizationId: 6 },
      });
      expect(canReadEngineerConversation(retargeted)).toBe(false);
      expect(canWriteEngineerConversation(retargeted)).toBe(false);
    });

    it('AUTH-03：工单软删 / 缺失 / 可信服务公司缺失一律拒绝', () => {
      expect(
        canReadEngineerConversation(
          workOrder({ requestFacts: { deletedAt: new Date(), trustedServiceOrganizationId: 5 } }),
        ),
      ).toBe(false);
      expect(canReadEngineerConversation(workOrder({ requestFacts: null }))).toBe(false);
      expect(
        canReadEngineerConversation(
          workOrder({ requestFacts: { deletedAt: null, trustedServiceOrganizationId: null } }),
        ),
      ).toBe(false);
    });

    it('AUTH-04：同公司可读，但非所有者不可续写', () => {
      const colleague = workOrder({ viewerAccountId: 11 });
      expect(canReadEngineerConversation(colleague)).toBe(true);
      expect(canWriteEngineerConversation(colleague)).toBe(false);
    });

    it('会话归属公司为空（历史数据）时失败关闭', () => {
      const legacy = workOrder({ conversationOwnerOrganizationId: null });
      expect(canReadEngineerConversation(legacy)).toBe(false);
    });

    it('查看者无公司归属时失败关闭', () => {
      const noCompany = workOrder({ viewerOrganizationId: null });
      expect(canReadEngineerConversation(noCompany)).toBe(false);
    });
  });
});

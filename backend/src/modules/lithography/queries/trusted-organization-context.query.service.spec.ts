// src/modules/lithography/queries/trusted-organization-context.query.service.spec.ts

import { DomainError, ORGANIZATION_ERROR } from '@core/common/errors/domain-error';
import { OrganizationMembershipFact } from '../organization.types';
import { TrustedOrganizationContextQueryService } from './trusted-organization-context.query.service';

const clientFact: OrganizationMembershipFact = {
  membershipId: 915001,
  organizationId: 910001,
  organizationCode: 'CLIENT_DEFAULT',
  organizationName: '甲方默认组织',
  organizationKind: 'CLIENT',
  memberRole: 'SUPER_ADMIN',
};

const peerFact: OrganizationMembershipFact = {
  membershipId: 915011,
  organizationId: 910002,
  organizationCode: 'PEER_ALT',
  organizationName: '同行隔离测试组织',
  organizationKind: 'PEER',
  memberRole: 'SUPER_ADMIN',
};

const makeMembershipQueryService = (facts: OrganizationMembershipFact[]) => ({
  listActiveMembershipsByAccount: jest.fn().mockResolvedValue(facts),
});

/** 断言 DomainError 的稳定业务码 */
const expectDomainErrorCode = async (
  promise: Promise<unknown>,
  code: string,
): Promise<DomainError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(domainError.code).toBe(code);
    return domainError;
  }
  throw new Error(`期望抛出 DomainError(${code})，但调用成功返回`);
};

describe('TrustedOrganizationContextQueryService', () => {
  it('恰有一条有效成员关系时返回该组织事实', async () => {
    const queryService = makeMembershipQueryService([clientFact]);
    const service = new TrustedOrganizationContextQueryService(queryService as never);

    const fact = await service.resolveForAccount({ accountId: 900001 });

    expect(queryService.listActiveMembershipsByAccount).toHaveBeenCalledWith({ accountId: 900001 });
    expect(fact).toEqual(clientFact);
  });

  it('无有效成员关系时抛 ORGANIZATION_NO_ACTIVE_MEMBERSHIP', async () => {
    const queryService = makeMembershipQueryService([]);
    const service = new TrustedOrganizationContextQueryService(queryService as never);

    const error = await expectDomainErrorCode(
      service.resolveForAccount({ accountId: 900201 }),
      ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
    );
    // 不泄露内部事实（错误 details 为空）
    expect(error.details).toBeUndefined();
  });

  it('多个有效成员关系时抛 ORGANIZATION_AMBIGUOUS_MEMBERSHIP（拒绝歧义，不回退全库）', async () => {
    const queryService = makeMembershipQueryService([clientFact, peerFact]);
    const service = new TrustedOrganizationContextQueryService(queryService as never);

    await expectDomainErrorCode(
      service.resolveForAccount({ accountId: 900001 }),
      ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
    );
  });

  it('透传事务上下文供写用例在同一事务连接上读取成员事实', async () => {
    const queryService = makeMembershipQueryService([clientFact]);
    const service = new TrustedOrganizationContextQueryService(queryService as never);
    const transactionContext = { marker: 'transaction-context' } as never;

    await service.resolveForAccount({ accountId: 900001, transactionContext });

    expect(queryService.listActiveMembershipsByAccount).toHaveBeenCalledWith({
      accountId: 900001,
      transactionContext,
    });
  });
});

// 文件位置：src/core/organization/policy/organization-context.policy.spec.ts

import { resolveSingletonOrganizationContext } from './organization-context.policy';

describe('organization context pure policy', () => {
  const fact = { organizationId: 1, organizationCode: 'CLIENT_DEFAULT' };

  it('恰有一条有效成员关系时决议 RESOLVED 并透传事实对象', () => {
    const resolution = resolveSingletonOrganizationContext([fact]);
    expect(resolution).toEqual({ kind: 'RESOLVED', fact });
  });

  it('无有效成员关系时决议 NO_ACTIVE_MEMBERSHIP', () => {
    expect(resolveSingletonOrganizationContext([])).toEqual({ kind: 'NO_ACTIVE_MEMBERSHIP' });
  });

  it('多个有效成员关系时决议 AMBIGUOUS_MEMBERSHIP（拒绝歧义，不回退全库）', () => {
    const second = { organizationId: 2, organizationCode: 'PEER_ALT' };
    expect(resolveSingletonOrganizationContext([fact, second])).toEqual({
      kind: 'AMBIGUOUS_MEMBERSHIP',
    });
  });
});

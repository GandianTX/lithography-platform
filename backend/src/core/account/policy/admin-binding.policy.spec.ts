import {
  evaluateAdminBinding,
  maskLoginName,
  type AdminBindingCandidate,
  type AdminBindingFacts,
} from './admin-binding.policy';

function candidate(overrides: Partial<AdminBindingCandidate> = {}): AdminBindingCandidate {
  return {
    accountId: 11,
    loginName: 'secondary-admin',
    adminLevel: 2,
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    roleConverged: true,
    role: 'SUPER_ADMIN',
    membershipRole: 'SUPER_ADMIN',
    membershipActive: true,
    customerOrganizationId: 7,
    ...overrides,
  };
}

function facts(overrides: Partial<AdminBindingFacts> = {}): AdminBindingFacts {
  return {
    organizationId: 7,
    organizationCode: 'ORG-MANAGED-A',
    companyStatus: 'ACTIVE',
    isManagedCompany: true,
    candidates: [candidate()],
    ...overrides,
  };
}

describe('maskLoginName', () => {
  it('保留首尾字符并隐藏中间内容', () => {
    expect(maskLoginName('admin01')).toBe('a***1');
    expect(maskLoginName('ab')).toBe('a***');
    expect(maskLoginName(' a ')).toBe('a***');
    expect(maskLoginName('   ')).toBe('(空)');
  });
});

describe('evaluateAdminBinding', () => {
  it('受管公司内没有候选账号时判定未配置', () => {
    const result = evaluateAdminBinding(facts({ candidates: [] }));

    expect(result).toMatchObject({
      status: 'UNCONFIGURED',
      reason: null,
      boundAccountId: null,
      boundLoginName: null,
      candidateCount: 0,
      accountDisabled: false,
    });
  });

  it('公司已停用时无候选判定公司停用，而不是未配置', () => {
    const result = evaluateAdminBinding(facts({ candidates: [], companyStatus: 'SUSPENDED' }));

    expect(result.status).toBe('COMPANY_DISABLED');
    expect(result.reason).toBeNull();
  });

  it('唯一合法候选判定已绑定并返回完整标识供内部比较', () => {
    const result = evaluateAdminBinding(facts());

    expect(result).toMatchObject({
      status: 'BOUND',
      reason: null,
      boundAccountId: 11,
      boundLoginName: 'secondary-admin',
      boundLoginNameMasked: 's***n',
      candidateCount: 1,
      accountDisabled: false,
    });
    expect(result.candidates).toEqual([{ accountId: 11, loginNameMasked: 's***n' }]);
  });

  it('合法绑定但账号停用仍判定已绑定，只标记停用', () => {
    const result = evaluateAdminBinding(
      facts({ candidates: [candidate({ accountStatus: 'SUSPENDED' })] }),
    );

    expect(result.status).toBe('BOUND');
    expect(result.boundAccountId).toBe(11);
    expect(result.accountDisabled).toBe(true);
  });

  it('合法绑定但资料状态非 ACTIVE 仍判定已绑定，只标记停用', () => {
    const result = evaluateAdminBinding(
      facts({ candidates: [candidate({ userState: 'PENDING' })] }),
    );

    expect(result.status).toBe('BOUND');
    expect(result.accountDisabled).toBe(true);
  });

  it('存在多个候选账号时判定冲突且不猜测绑定目标', () => {
    const result = evaluateAdminBinding(
      facts({
        candidates: [
          candidate({ accountId: 11, loginName: 'first-admin' }),
          candidate({ accountId: 12, loginName: 'second-admin' }),
        ],
      }),
    );

    expect(result).toMatchObject({
      status: 'CONFLICT',
      reason: 'MULTIPLE_BINDINGS',
      boundAccountId: null,
      boundLoginName: null,
      boundLoginNameMasked: null,
      candidateCount: 2,
    });
    expect(result.candidates.map((item) => item.loginNameMasked)).toEqual(['f***n', 's***n']);
  });

  it('公司停用优先于多绑定冲突', () => {
    const result = evaluateAdminBinding(
      facts({
        companyStatus: 'DISABLED',
        candidates: [candidate({ accountId: 11 }), candidate({ accountId: 12 })],
      }),
    );

    expect(result.status).toBe('COMPANY_DISABLED');
    expect(result.reason).toBe('MULTIPLE_BINDINGS');
    expect(result.boundAccountId).toBeNull();
  });

  it('成员关系不在有效状态时判定冲突', () => {
    const result = evaluateAdminBinding(
      facts({ candidates: [candidate({ membershipActive: false })] }),
    );

    expect(result).toMatchObject({
      status: 'CONFLICT',
      reason: 'MEMBERSHIP_INACTIVE',
      boundAccountId: null,
    });
  });

  it('成员角色不是 SUPER_ADMIN 时判定冲突', () => {
    const result = evaluateAdminBinding(
      facts({ candidates: [candidate({ membershipRole: 'ENGINEER' })] }),
    );

    expect(result).toMatchObject({
      status: 'CONFLICT',
      reason: 'MEMBERSHIP_ROLE_MISMATCH',
    });
  });

  it('等级不是 2 时判定冲突', () => {
    const result = evaluateAdminBinding(facts({ candidates: [candidate({ adminLevel: 1 })] }));

    expect(result).toMatchObject({ status: 'CONFLICT', reason: 'LEVEL_MISMATCH' });
  });

  it('等级缺失时判定冲突', () => {
    const result = evaluateAdminBinding(facts({ candidates: [candidate({ adminLevel: null })] }));

    expect(result).toMatchObject({ status: 'CONFLICT', reason: 'LEVEL_MISMATCH' });
  });

  it('三源角色未收敛时判定冲突', () => {
    const result = evaluateAdminBinding(
      facts({ candidates: [candidate({ roleConverged: false, role: null })] }),
    );

    expect(result).toMatchObject({ status: 'CONFLICT', reason: 'ROLE_NOT_CONVERGED' });
  });

  it('收敛角色不是 SUPER_ADMIN 时判定冲突', () => {
    const result = evaluateAdminBinding(facts({ candidates: [candidate({ role: 'ENGINEER' })] }));

    expect(result).toMatchObject({ status: 'CONFLICT', reason: 'ROLE_NOT_SUPER_ADMIN' });
  });

  it('账号归属另一家公司时判定冲突', () => {
    const result = evaluateAdminBinding(
      facts({ candidates: [candidate({ customerOrganizationId: 99 })] }),
    );

    expect(result).toMatchObject({ status: 'CONFLICT', reason: 'ORGANIZATION_MISMATCH' });
  });

  it('账号归属为空时视为待补齐，不判定归属冲突', () => {
    const result = evaluateAdminBinding(
      facts({ candidates: [candidate({ customerOrganizationId: null })] }),
    );

    expect(result.status).toBe('BOUND');
  });

  it('公司已停用时合法候选仍保留标识，但状态为公司停用', () => {
    const result = evaluateAdminBinding(facts({ companyStatus: 'SUSPENDED' }));

    expect(result).toMatchObject({
      status: 'COMPANY_DISABLED',
      boundAccountId: 11,
      boundLoginNameMasked: 's***n',
    });
  });

  it('非受管公司不是绑定判定对象，直接拒绝', () => {
    expect(() => evaluateAdminBinding(facts({ isManagedCompany: false }))).toThrow(/不是受管公司/);
  });
});

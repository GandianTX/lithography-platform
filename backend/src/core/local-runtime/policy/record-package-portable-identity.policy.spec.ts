/// <reference types="jest" />

/**
 * 跨端可移植来源身份裁决的定向测试（任务 09 S1-2）。
 *
 * 守住四类反例：
 * - 包内既无稳定标识也无账号名（旧包）⇒ 拒绝，**不回退数字 id**；
 * - 稳定标识未命中但账号名命中 ⇒ 按账号名映射（次级依据）；
 * - 账号名命中但姓名快照不一致（账号名被复用）⇒ 拒绝；
 * - 目标公司编码与包内来源公司编码不一致 ⇒ 拒绝。
 */

import {
  evaluateRecordPackageCompanyIdentity,
  evaluateRecordPackagePortableIdentity,
  type RecordPackagePortableSourceIdentity,
} from './record-package-portable-identity.policy';

const PORTABLE: RecordPackagePortableSourceIdentity = {
  sourceAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sourceAccountLoginName: 'engineer-1',
  sourceAccountName: '张三',
  sourceOrganizationCode: 'ORG-9',
};

describe('记录包跨端可移植来源身份裁决（S1-2）', () => {
  it('稳定标识在本机命中：放行并给出依据 STABLE_ID', () => {
    const decision = evaluateRecordPackagePortableIdentity({
      portable: PORTABLE,
      matchedByStableId: { accountId: 900101 },
      matchedByLoginName: null,
    });

    expect(decision).toEqual({
      allowed: true,
      sourceAccountId: 900101,
      basis: 'STABLE_ID',
    });
  });

  it('旧包（既无稳定标识也无账号名）：拒绝，不回退数字 id', () => {
    const decision = evaluateRecordPackagePortableIdentity({
      portable: { ...PORTABLE, sourceAccountUuid: null, sourceAccountLoginName: null },
      matchedByStableId: null,
      matchedByLoginName: null,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('缺少跨端可移植的来源账号标识');
  });

  it('稳定标识未命中但账号名命中：按账号名映射（依据 LOGIN_NAME_IN_COMPANY）', () => {
    const decision = evaluateRecordPackagePortableIdentity({
      portable: PORTABLE,
      matchedByStableId: null,
      matchedByLoginName: { accountId: 900202, realName: '张三' },
    });

    expect(decision).toEqual({
      allowed: true,
      sourceAccountId: 900202,
      basis: 'LOGIN_NAME_IN_COMPANY',
    });
  });

  it('账号名命中但姓名快照不一致（账号名被复用）：拒绝', () => {
    const decision = evaluateRecordPackagePortableIdentity({
      portable: PORTABLE,
      matchedByStableId: null,
      matchedByLoginName: { accountId: 900303, realName: '李四' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('姓名快照');
  });

  it('两个标识都未在本机命中：拒绝', () => {
    const decision = evaluateRecordPackagePortableIdentity({
      portable: PORTABLE,
      matchedByStableId: null,
      matchedByLoginName: null,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('不存在可核验的来源账号');
  });
});

describe('记录包公司身份裁决（跨安装口径）', () => {
  it('包内携带公司编码且与目标公司一致：放行（不看数字 id）', () => {
    const decision = evaluateRecordPackageCompanyIdentity({
      sourceOrganizationCode: 'ORG-9',
      sourceOrganizationId: 3,
      targetOrganizationCode: 'ORG-9',
      targetOrganizationId: 7,
    });

    expect(decision).toEqual({ allowed: true, basis: 'ORGANIZATION_CODE' });
  });

  it('包内公司编码与目标公司不一致：拒绝', () => {
    const decision = evaluateRecordPackageCompanyIdentity({
      sourceOrganizationCode: 'ORG-OTHER',
      sourceOrganizationId: 3,
      targetOrganizationCode: 'ORG-9',
      targetOrganizationId: 7,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('来源公司与导入目标公司不一致');
  });

  it('旧包无公司编码：回退数字 id 比较', () => {
    expect(
      evaluateRecordPackageCompanyIdentity({
        sourceOrganizationCode: null,
        sourceOrganizationId: 7,
        targetOrganizationCode: 'ORG-9',
        targetOrganizationId: 7,
      }),
    ).toEqual({ allowed: true, basis: 'ORGANIZATION_ID' });

    expect(
      evaluateRecordPackageCompanyIdentity({
        sourceOrganizationCode: null,
        sourceOrganizationId: 3,
        targetOrganizationCode: 'ORG-9',
        targetOrganizationId: 7,
      }).allowed,
    ).toBe(false);
  });
});

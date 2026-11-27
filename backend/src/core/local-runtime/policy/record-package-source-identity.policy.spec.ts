// src/core/local-runtime/policy/record-package-source-identity.policy.spec.ts
/// <reference types="jest" />

/**
 * 记录包来源身份本机可信裁决的定向测试（任务 09 S3 补丁 P4）。
 *
 * 守住四类反例：伪造来源账号、已停用账号、归属变化（已离开本公司／从未归属）、
 * 同公司他人（工程师无当前权限）。同时守住"原账号＝导入账号"的正常路径。
 */

import { AccountStatus } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';

import {
  evaluateRecordPackageSourceIdentity,
  type RecordPackageSourceIdentityFacts,
} from './record-package-source-identity.policy';

const SOURCE_ACCOUNT_ID = 900101;
const IMPORTER_ACCOUNT_ID = 900101;
const TARGET_ORGANIZATION_ID = 9;

function buildFacts(
  overrides: Partial<RecordPackageSourceIdentityFacts> = {},
): RecordPackageSourceIdentityFacts {
  return {
    sourceAccountId: SOURCE_ACCOUNT_ID,
    portable: {
      sourceAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sourceAccountLoginName: 'engineer-1',
      sourceAccountName: '张三',
      sourceOrganizationCode: 'ORG-9',
    },
    resolvedSourceAccountId: overrides.sourceAccountId === undefined ? SOURCE_ACCOUNT_ID : null,
    identityBasis: 'STABLE_ID' as const,
    accountStatus: AccountStatus.ACTIVE,
    userState: UserState.ACTIVE,
    memberships: [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        membershipStatus: 'ACTIVE',
        organizationStatus: 'ACTIVE',
      },
    ],
    ownerOrganizationId: TARGET_ORGANIZATION_ID,
    targetOrganizationId: TARGET_ORGANIZATION_ID,
    importerAccountId: IMPORTER_ACCOUNT_ID,
    importerAdminLevel: null,
    ...overrides,
  };
}

describe('记录包来源身份本机可信裁决（S3 补丁 P4）', () => {
  it('本人导入本人同公司记录：放行并带回已核验的来源账号', () => {
    const decision = evaluateRecordPackageSourceIdentity(buildFacts());

    expect(decision).toEqual({ allowed: true, sourceAccountId: SOURCE_ACCOUNT_ID });
  });

  it('伪造包内账号（本机不存在该账号）：拒绝，不静默改成导入人', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({ sourceAccountId: 999999999, accountStatus: null }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('不存在');
  });

  it('包内缺来源账号：拒绝（不得以导入人冒充原作者）', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({
        sourceAccountId: null,
        portable: {
          sourceAccountUuid: null,
          sourceAccountLoginName: null,
          sourceAccountName: null,
          sourceOrganizationCode: 'ORG-9',
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('跨端可移植的来源账号标识');
  });

  it.each([
    AccountStatus.BANNED,
    AccountStatus.SUSPENDED,
    AccountStatus.INACTIVE,
    AccountStatus.DELETED,
    AccountStatus.PENDING,
  ])('来源账号已停用（%s）：拒绝', (status) => {
    const decision = evaluateRecordPackageSourceIdentity(buildFacts({ accountStatus: status }));

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('已停用');
  });

  it('来源账号资料缺失：拒绝（原作者不可核验）', () => {
    const decision = evaluateRecordPackageSourceIdentity(buildFacts({ userState: null }));

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('没有资料记录');
  });

  it('来源账号资料已停用：拒绝', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({ userState: UserState.INACTIVE }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('资料已停用');
  });

  it('归属变化：来源账号已不在目标公司（无任何该公司的成员关系）：拒绝', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({
        memberships: [
          {
            organizationId: 10,
            membershipStatus: 'ACTIVE',
            organizationStatus: 'ACTIVE',
          },
        ],
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('在职成员');
  });

  it('归属变化：来源账号已离开本公司（成员关系 LEFT）：拒绝', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({
        memberships: [
          {
            organizationId: TARGET_ORGANIZATION_ID,
            membershipStatus: 'LEFT',
            organizationStatus: 'ACTIVE',
          },
        ],
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('已离开本公司');
  });

  it('本公司已停用：拒绝', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({
        memberships: [
          {
            organizationId: TARGET_ORGANIZATION_ID,
            membershipStatus: 'ACTIVE',
            organizationStatus: 'DISABLED',
          },
        ],
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('本公司已停用');
  });

  it('同公司他人（工程师导入同公司他人记录）：拒绝（工程师只能导入当前有权记录）', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({
        sourceAccountId: 900202,
        resolvedSourceAccountId: 900202,
        importerAccountId: IMPORTER_ACCOUNT_ID,
        importerAdminLevel: null,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('当前有权');
  });

  it('二级管理员按本公司范围导入同公司他人记录：放行', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({
        sourceAccountId: 900202,
        resolvedSourceAccountId: 900202,
        importerAdminLevel: 2,
      }),
    );

    expect(decision).toEqual({ allowed: true, sourceAccountId: 900202 });
  });

  it('一级管理员（无业务所属公司）：拒绝按公司范围接收他人记录', () => {
    const decision = evaluateRecordPackageSourceIdentity(
      buildFacts({
        sourceAccountId: 900202,
        resolvedSourceAccountId: 900202,
        importerAdminLevel: 1,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('一级管理员');
  });

  it('公司归属不一致的裁决已移出本策略（由公司业务编码裁决承担，见可移植身份策略单测）', () => {
    const decision = evaluateRecordPackageSourceIdentity(buildFacts({ ownerOrganizationId: 10 }));

    expect(decision.allowed).toBe(true);
  });

  it('包内未登记归属公司：不因此拒绝（其余事实成立即放行）', () => {
    const decision = evaluateRecordPackageSourceIdentity(buildFacts({ ownerOrganizationId: null }));

    expect(decision).toEqual({ allowed: true, sourceAccountId: SOURCE_ACCOUNT_ID });
  });
});

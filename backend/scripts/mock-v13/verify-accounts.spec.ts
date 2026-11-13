// scripts/mock-v13/verify-accounts.spec.ts

/**
 * 定向回归：access_group 在真实 MySQL 中是 JSON 列，mysql2 会返回原生数组。
 * 这里让校验器直接面对该形态，证明不会误拒；同时证明角色不一致仍然拒绝。
 */

/// <reference types="jest" />

import { MockVerificationError } from './errors';
import { ACCOUNTS, ORGANIZATIONS, mockEmail } from './manifest';
import { PackContext } from './packs-shared';
import { RunReport } from './report';
import { verifyAccounts } from './runner';

const ORGANIZATION_IDS = new Map(ORGANIZATIONS.map((org, index) => [org.code, 1001 + index]));

type AccessGroupFactory = (loginName: string, role: string) => unknown;

class AccountsQueryRunner {
  readonly calls: string[] = [];

  constructor(private readonly accessGroup: AccessGroupFactory = (_loginName, role) => [role]) {}

  query(sql: string, parameters: readonly unknown[] = []): Promise<unknown> {
    this.calls.push(sql);
    const values = [...parameters];

    if (sql.includes('FROM `base_user_account`')) {
      const loginName = String(values[0]);
      const index = ACCOUNTS.findIndex((account) => account.loginName === loginName);
      if (index < 0) return Promise.resolve([]);
      const spec = ACCOUNTS[index];
      return Promise.resolve([
        {
          id: index + 1,
          login_email: mockEmail(spec.loginName),
          status: spec.accountStatus,
          identity_hint: spec.role,
          admin_level: spec.adminLevel,
        },
      ]);
    }

    if (sql.includes('FROM `base_user_info`')) {
      const spec = ACCOUNTS[Number(values[0]) - 1];
      const profileOrganizationId =
        spec.profileOrganization === null
          ? null
          : (ORGANIZATION_IDS.get(
              ORGANIZATIONS.find((org) => org.key === spec.profileOrganization)?.code ?? '',
            ) ?? null);
      return Promise.resolve([
        {
          user_state: spec.userState,
          access_group: this.accessGroup(spec.loginName, spec.role),
          meta_digest: `enc:${JSON.stringify([spec.role])}`,
          customer_organization_id: profileOrganizationId,
        },
      ]);
    }

    if (sql.includes('FROM `organization`')) {
      const code = String(values[0]);
      const id = ORGANIZATION_IDS.get(code);
      return Promise.resolve(
        id === undefined ? [] : [{ id, organization_code: code, is_managed_company: 1 }],
      );
    }

    if (sql.includes('organization_membership m')) {
      const spec = ACCOUNTS[Number(values[0]) - 1];
      if (spec.organization === null) return Promise.resolve([]);
      const code =
        spec.organization === 'PLATFORM'
          ? 'PLATFORM'
          : (ORGANIZATIONS.find((org) => org.key === spec.organization)?.code ?? '');
      return Promise.resolve([
        {
          organization_code: code,
          is_managed_company: spec.organization === 'PLATFORM' ? 0 : 1,
          organization_status: 'ACTIVE',
          member_role: spec.role,
          status: 'ACTIVE',
        },
      ]);
    }

    if (sql.includes('engineer_registration_application')) {
      const spec = ACCOUNTS[Number(values[0]) - 1];
      const status = spec.key === 'pending-engineer' ? 'PENDING' : 'REJECTED';
      return Promise.resolve([{ status }]);
    }

    return Promise.resolve([]);
  }
}

function createContext(queryRunner: AccountsQueryRunner): PackContext {
  const report = new RunReport();
  report.startPack('p0-org-accounts');
  return {
    qr: queryRunner,
    report,
    encryption: {
      encrypt: (plain: string) => `enc:${plain}`,
      decrypt: (cipher: string) => cipher.replace(/^enc:/u, ''),
    },
  } as unknown as PackContext;
}

describe('verifyAccounts 的 access_group 解析', () => {
  it('接受 MySQL 实际返回的原生数组', async () => {
    const queryRunner = new AccountsQueryRunner();
    await expect(verifyAccounts(createContext(queryRunner))).resolves.toBeUndefined();
  });

  it('继续接受 JSON 字符串形态', async () => {
    const queryRunner = new AccountsQueryRunner((_loginName, role) => JSON.stringify([role]));
    await expect(verifyAccounts(createContext(queryRunner))).resolves.toBeUndefined();
  });

  it('资料角色与账号角色不一致时仍然拒绝', async () => {
    const queryRunner = new AccountsQueryRunner((loginName, role) =>
      loginName === 'mock_v13_admin_l1_a' ? ['CUSTOMER'] : [role],
    );
    const error = await verifyAccounts(createContext(queryRunner)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MockVerificationError);
    expect((error as Error).message).toContain('资料角色 [CUSTOMER] 与账号角色 SUPER_ADMIN 不一致');
  });

  it('拒绝非法 JSON、非数组与非字符串元素', async () => {
    const cases: unknown[] = ['["SUPER_ADMIN"', '{"role":"SUPER_ADMIN"}', ['SUPER_ADMIN', 1]];
    for (const invalid of cases) {
      const queryRunner = new AccountsQueryRunner((loginName, role) =>
        loginName === 'mock_v13_admin_l1_a' ? invalid : [role],
      );
      const error = await verifyAccounts(createContext(queryRunner)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MockVerificationError);
      expect((error as Error).message).toContain('access_group 不是合法角色数组');
    }
  });
});

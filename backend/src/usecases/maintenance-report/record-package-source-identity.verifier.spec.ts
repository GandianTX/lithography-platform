// src/usecases/maintenance-report/record-package-source-identity.verifier.spec.ts
/// <reference types="jest" />

/**
 * 记录包来源身份核验器的定向测试（任务 09 S3 补丁 P4）。
 *
 * 守住「包内自报身份不是授权真源」：核验结论只由**本机数据库当前事实**决定。
 */

import { AccountStatus } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';

import { RecordPackageSourceIdentityVerifier } from './record-package-source-identity.verifier';

const SOURCE_ACCOUNT_ID = 900101;
const IMPORTER_ACCOUNT_ID = 900101;
const TARGET_ORGANIZATION_ID = 9;

function buildVerifier(
  options: {
    accountStatus?: AccountStatus | null;
    userState?: UserState | null;
    memberships?: Array<{
      organizationId: number;
      membershipStatus: string;
      organizationStatus: string;
    }>;
    importerAdminLevel?: number | null;
  } = {},
) {
  const findSessionAuthoritySnapshot = jest.fn().mockResolvedValue({
    accountId: SOURCE_ACCOUNT_ID,
    accountStatus:
      options.accountStatus === undefined ? AccountStatus.ACTIVE : options.accountStatus,
    identityHint: 'ENGINEER',
    mustChangePassword: false,
    credentialVersion: 1,
    adminLevel: null,
    userInfo:
      options.userState === undefined && options.accountStatus === null
        ? null
        : { userState: options.userState === undefined ? UserState.ACTIVE : options.userState },
  });
  const listMembershipsForBinding = jest.fn().mockResolvedValue(
    options.memberships ?? [
      {
        membershipId: 1,
        organizationId: TARGET_ORGANIZATION_ID,
        memberRole: 'ENGINEER',
        membershipStatus: 'ACTIVE',
        organizationStatus: 'ACTIVE',
      },
    ],
  );
  const findAdminLevelByAccountId = jest
    .fn()
    .mockResolvedValue(
      options.importerAdminLevel === undefined ? null : options.importerAdminLevel,
    );

  const findCrossInstallationIdentity = jest
    .fn()
    .mockImplementation((params: { accountUuid?: string | null; loginName?: string | null }) => {
      if (params.accountUuid === null && params.loginName === null) {
        return Promise.resolve(null);
      }
      if (
        params.loginName === 'engineer-2' ||
        params.accountUuid === 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
      ) {
        return Promise.resolve({
          accountId: 900202,
          accountUuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
          loginName: 'engineer-2',
          realName: '李四',
          accountStatus: AccountStatus.ACTIVE,
          userState: UserState.ACTIVE,
        });
      }
      if (params.accountUuid === 'not-found-uuid') {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        accountId: SOURCE_ACCOUNT_ID,
        accountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        loginName: 'engineer-1',
        realName: '张三',
        accountStatus: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });
    });

  const verifier = new RecordPackageSourceIdentityVerifier(
    {
      findSessionAuthoritySnapshot,
      findAdminLevelByAccountId,
      findCrossInstallationIdentity,
    } as never,
    { listMembershipsForBinding } as never,
    {
      findOrganizationIdentityById: () =>
        Promise.resolve({ organizationCode: 'ORG-9', id: TARGET_ORGANIZATION_ID }),
    } as never,
  );

  return {
    verifier,
    findSessionAuthoritySnapshot,
    listMembershipsForBinding,
    findAdminLevelByAccountId,
  };
}

describe('记录包来源身份核验器（S3 补丁 P4）', () => {
  it('本人导入本人记录：放行并带回已核验账号', async () => {
    const { verifier } = buildVerifier();

    const decision = await verifier.verify({
      sourceAccountId: SOURCE_ACCOUNT_ID,
      portableSourceIdentity: {
        sourceAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        sourceAccountLoginName: 'engineer-1',
        sourceAccountName: '张三',
        sourceOrganizationCode: 'ORG-9',
      },
      ownerOrganizationId: TARGET_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      importerAccountId: IMPORTER_ACCOUNT_ID,
    });

    expect(decision).toEqual({ allowed: true, sourceAccountId: SOURCE_ACCOUNT_ID });
  });

  it('包内既无数字账号 id 也无可移植标识：不查库即拒绝（不给"未知即放行"的机会）', async () => {
    const { verifier, findSessionAuthoritySnapshot } = buildVerifier();

    const decision = await verifier.verify({
      sourceAccountId: null,
      portableSourceIdentity: {
        sourceAccountUuid: null,
        sourceAccountLoginName: null,
        sourceAccountName: null,
        sourceOrganizationCode: 'ORG-9',
      },
      ownerOrganizationId: TARGET_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      importerAccountId: IMPORTER_ACCOUNT_ID,
    });

    expect(decision.allowed).toBe(false);
    expect(findSessionAuthoritySnapshot).not.toHaveBeenCalled();
  });

  it('来源账号在本机不存在：拒绝', async () => {
    const { verifier } = buildVerifier({ accountStatus: null });

    const decision = await verifier.verify({
      sourceAccountId: SOURCE_ACCOUNT_ID,
      portableSourceIdentity: {
        sourceAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        sourceAccountLoginName: 'engineer-1',
        sourceAccountName: '张三',
        sourceOrganizationCode: 'ORG-9',
      },
      ownerOrganizationId: TARGET_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      importerAccountId: IMPORTER_ACCOUNT_ID,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('不存在');
  });

  it('来源账号已停用：拒绝', async () => {
    const { verifier } = buildVerifier({ accountStatus: AccountStatus.BANNED });

    const decision = await verifier.verify({
      sourceAccountId: SOURCE_ACCOUNT_ID,
      portableSourceIdentity: {
        sourceAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        sourceAccountLoginName: 'engineer-1',
        sourceAccountName: '张三',
        sourceOrganizationCode: 'ORG-9',
      },
      ownerOrganizationId: TARGET_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      importerAccountId: IMPORTER_ACCOUNT_ID,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('已停用');
  });

  it('归属变化：来源账号不在目标公司的在职成员关系里：拒绝', async () => {
    const { verifier } = buildVerifier({
      memberships: [
        {
          organizationId: 10,
          membershipStatus: 'ACTIVE',
          organizationStatus: 'ACTIVE',
        },
      ],
    });

    const decision = await verifier.verify({
      sourceAccountId: SOURCE_ACCOUNT_ID,
      portableSourceIdentity: {
        sourceAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        sourceAccountLoginName: 'engineer-1',
        sourceAccountName: '张三',
        sourceOrganizationCode: 'ORG-9',
      },
      ownerOrganizationId: TARGET_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      importerAccountId: IMPORTER_ACCOUNT_ID,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('在职成员');
  });

  it('同公司他人（工程师）：拒绝', async () => {
    const { verifier } = buildVerifier();

    const decision = await verifier.verify({
      sourceAccountId: 900202,
      portableSourceIdentity: {
        sourceAccountUuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        sourceAccountLoginName: 'engineer-2',
        sourceAccountName: '李四',
        sourceOrganizationCode: 'ORG-9',
      },
      ownerOrganizationId: TARGET_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      importerAccountId: IMPORTER_ACCOUNT_ID,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('当前有权');
  });

  it('导入者账号行读不到时按非管理员处理（失败关闭，不扩大权限）', async () => {
    const { verifier, findAdminLevelByAccountId } = buildVerifier();
    findAdminLevelByAccountId.mockRejectedValue(new Error('账户不存在'));

    const decision = await verifier.verify({
      sourceAccountId: 900202,
      portableSourceIdentity: {
        sourceAccountUuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        sourceAccountLoginName: 'engineer-2',
        sourceAccountName: '李四',
        sourceOrganizationCode: 'ORG-9',
      },
      ownerOrganizationId: TARGET_ORGANIZATION_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      importerAccountId: IMPORTER_ACCOUNT_ID,
    });

    expect(decision.allowed).toBe(false);
  });
});

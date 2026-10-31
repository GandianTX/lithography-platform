// src/usecases/account/visible-user-info-organization.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { UserInfoView } from '@app-types/models/auth.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import {
  ACCOUNT_ERROR,
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountService } from '@src/modules/account/base/services/account.service';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import {
  ADMIN_ACCOUNT_ID,
  TARGET_ACCOUNT_ID,
  createFakeTransactionHarness,
  createOrganizationIsolationMocks,
} from '../../../test/support/account/admin-user.fixture';
import type { FetchUserInfoUsecase } from './fetch-user-info.usecase';
import { GetVisibleUserInfoUsecase } from './get-visible-user-info.usecase';
import { UpdateVisibleUserInfoUsecase } from './update-visible-user-info.usecase';

/**
 * 旧账号资料接口的组织范围回归（P1）。
 *
 * 覆盖「非本人目标必须同属一个有效组织」在读写两条链路上的裁决与顺序：
 * - 角色策略先于任何数据库访问（CUSTOMER 用目标 ID 探测存在性同样被拒）；
 * - 写路径先锁目标、再解析组织、再读取资料；
 * - 跨组织 / 目标无有效成员关系 / 目标不存在使用同一拒绝码与文案；
 * - 本人路径不进入组织解析（历史无组织账号仍可自查自改）；
 * - 既有字段白名单与身份提示限制保持不变。
 */

const OPERATOR_ACCOUNT_ID = 3;

const engineerSession = (accountId = OPERATOR_ACCOUNT_ID): UsecaseSession => ({
  accountId,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
});

const adminSession = (accountId = ADMIN_ACCOUNT_ID): UsecaseSession => ({
  accountId,
  roles: [IdentityTypeEnum.SUPER_ADMIN],
  activeRole: IdentityTypeEnum.SUPER_ADMIN,
});

const customerSession = (accountId = 4): UsecaseSession => ({
  accountId,
  roles: [IdentityTypeEnum.CUSTOMER],
  activeRole: IdentityTypeEnum.CUSTOMER,
});

const targetView = (overrides: Partial<UserInfoView> = {}): UserInfoView => ({
  accountId: TARGET_ACCOUNT_ID,
  nickname: 'target_nickname',
  gender: Gender.SECRET,
  birthDate: null,
  avatarUrl: null,
  email: 'target@example.com',
  signature: null,
  accessGroup: [IdentityTypeEnum.CUSTOMER],
  address: null,
  phone: null,
  tags: null,
  geographic: null,
  metaDigest: null,
  notifyCount: 0,
  unreadCount: 0,
  userState: UserState.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('旧账号资料接口组织范围', () => {
  const isolation = createOrganizationIsolationMocks();
  const harness = createFakeTransactionHarness();
  const calls: string[] = [];

  const fetchUserInfoUsecase = {
    executeStrict: jest.fn(),
  } as unknown as FetchUserInfoUsecase;

  const accountService = {
    lockByIdForUpdate: jest.fn(),
    updateUserInfoFields: jest.fn(),
    updateAccount: jest.fn(),
  } as unknown as AccountService;

  const accountQueryService = {
    checkNicknameExists: jest.fn(),
  } as unknown as AccountQueryService;

  const buildGetUsecase = (): GetVisibleUserInfoUsecase =>
    new GetVisibleUserInfoUsecase(
      fetchUserInfoUsecase,
      isolation.organizationContextQueryService,
      isolation.organizationMembershipQueryService,
    );

  const buildUpdateUsecase = (): UpdateVisibleUserInfoUsecase =>
    new UpdateVisibleUserInfoUsecase(
      accountService,
      accountQueryService,
      fetchUserInfoUsecase,
      isolation.organizationContextQueryService,
      isolation.organizationMembershipQueryService,
      harness.transactionRunner,
    );

  const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
    await expect(promise).rejects.toMatchObject({ code });
  };

  beforeEach(() => {
    calls.length = 0;
    harness.reset();
    jest.clearAllMocks();

    isolation.resolveForAccount.mockReset();
    isolation.resolveForAccount.mockImplementation(() => {
      calls.push('resolveOrganization');
      return Promise.resolve({
        membershipId: 1,
        organizationId: 100,
        organizationCode: 'E2E_PRIMARY',
        organizationName: '测试组织',
        organizationKind: 'CLIENT',
        memberRole: 'ENGINEER',
      });
    });
    isolation.findActiveMembership.mockReset();
    isolation.findActiveMembership.mockImplementation(() => {
      calls.push('findActiveMembership');
      return Promise.resolve({
        membershipId: 2,
        organizationId: 100,
        organizationCode: 'E2E_PRIMARY',
        organizationName: '测试组织',
        organizationKind: 'CLIENT',
        memberRole: 'CUSTOMER',
      });
    });

    (fetchUserInfoUsecase.executeStrict as jest.Mock).mockReset();
    (fetchUserInfoUsecase.executeStrict as jest.Mock).mockImplementation(
      (params: { accountId: number }) => {
        calls.push(`fetch:${params.accountId}`);
        return Promise.resolve(targetView({ accountId: params.accountId }));
      },
    );

    (accountService.lockByIdForUpdate as jest.Mock).mockReset();
    (accountService.lockByIdForUpdate as jest.Mock).mockImplementation((accountId: number) => {
      calls.push(`lock:${accountId}`);
      return Promise.resolve({ id: accountId, identityHint: IdentityTypeEnum.CUSTOMER });
    });
    (accountService.updateUserInfoFields as jest.Mock).mockReset();
    (accountService.updateUserInfoFields as jest.Mock).mockImplementation(() => {
      calls.push('updateUserInfoFields');
      return Promise.resolve();
    });
    (accountService.updateAccount as jest.Mock).mockReset();
    (accountService.updateAccount as jest.Mock).mockImplementation(() => {
      calls.push('updateAccount');
      return Promise.resolve();
    });
    (accountQueryService.checkNicknameExists as jest.Mock).mockReset();
    (accountQueryService.checkNicknameExists as jest.Mock).mockResolvedValue(false);
  });

  describe('GetVisibleUserInfoUsecase', () => {
    it('本人读取不解析组织（历史无组织账号仍可自查）', async () => {
      const view = await buildGetUsecase().execute({
        session: engineerSession(TARGET_ACCOUNT_ID),
        targetAccountId: TARGET_ACCOUNT_ID,
      });

      expect(view.accountId).toBe(TARGET_ACCOUNT_ID);
      expect(calls).toEqual([`fetch:${TARGET_ACCOUNT_ID}`]);
      expect(isolation.resolveForAccount).not.toHaveBeenCalled();
      expect(isolation.findActiveMembership).not.toHaveBeenCalled();
    });

    it('ENGINEER 读取同组织目标通过', async () => {
      const view = await buildGetUsecase().execute({
        session: engineerSession(),
        targetAccountId: TARGET_ACCOUNT_ID,
      });

      expect(view.accountId).toBe(TARGET_ACCOUNT_ID);
      expect(calls).toEqual([
        'resolveOrganization',
        'findActiveMembership',
        `fetch:${TARGET_ACCOUNT_ID}`,
      ]);
    });

    it('SUPER_ADMIN 读取同组织目标通过', async () => {
      await expect(
        buildGetUsecase().execute({
          session: adminSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
      ).resolves.toMatchObject({ accountId: TARGET_ACCOUNT_ID });
    });

    it('跨组织读取拒绝，且不读取目标资料', async () => {
      isolation.findActiveMembership.mockImplementationOnce(() => {
        calls.push('findActiveMembership');
        return Promise.resolve(null);
      });

      await expectCode(
        buildGetUsecase().execute({
          session: adminSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ACCOUNT_ERROR.USER_INFO_NOT_FOUND,
      );
      expect(calls).toEqual(['resolveOrganization', 'findActiveMembership']);
      expect(fetchUserInfoUsecase.executeStrict).not.toHaveBeenCalled();
    });

    it('操作者无有效组织时失败关闭，不泄露目标是否存在', async () => {
      isolation.resolveForAccount.mockRejectedValueOnce(
        new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '无有效组织'),
      );

      await expectCode(
        buildGetUsecase().execute({
          session: engineerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
      );
      expect(isolation.findActiveMembership).not.toHaveBeenCalled();
      expect(fetchUserInfoUsecase.executeStrict).not.toHaveBeenCalled();
    });

    it('操作者组织事实冲突时失败关闭', async () => {
      isolation.resolveForAccount.mockRejectedValueOnce(
        new DomainError(ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP, '组织事实冲突'),
      );

      await expectCode(
        buildGetUsecase().execute({
          session: engineerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
      );
    });

    it('CUSTOMER 读取他人：角色拒绝先于组织解析', async () => {
      await expectCode(
        buildGetUsecase().execute({
          session: customerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        PERMISSION_ERROR.ACCESS_DENIED,
      );
      expect(calls).toEqual([]);
    });
  });

  describe('UpdateVisibleUserInfoUsecase', () => {
    it('本人更新不解析组织，且先锁目标再读取资料', async () => {
      const result = await buildUpdateUsecase().execute({
        session: engineerSession(TARGET_ACCOUNT_ID),
        targetAccountId: TARGET_ACCOUNT_ID,
        patch: { nickname: 'self_nickname_new' },
      });

      expect(result.isUpdated).toBe(true);
      expect(calls).toEqual([
        `lock:${TARGET_ACCOUNT_ID}`,
        `fetch:${TARGET_ACCOUNT_ID}`,
        'updateUserInfoFields',
        `fetch:${TARGET_ACCOUNT_ID}`,
      ]);
      expect(isolation.resolveForAccount).not.toHaveBeenCalled();
    });

    it('非本人更新：锁定 → 组织解析 → 成员核验 → 读取 → 写入', async () => {
      const result = await buildUpdateUsecase().execute({
        session: engineerSession(),
        targetAccountId: TARGET_ACCOUNT_ID,
        patch: { nickname: 'other_nickname_new' },
      });

      expect(result.isUpdated).toBe(true);
      expect(calls).toEqual([
        `lock:${TARGET_ACCOUNT_ID}`,
        'resolveOrganization',
        'findActiveMembership',
        `fetch:${TARGET_ACCOUNT_ID}`,
        'updateUserInfoFields',
        `fetch:${TARGET_ACCOUNT_ID}`,
      ]);
      expect(accountService.updateUserInfoFields).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: TARGET_ACCOUNT_ID,
          patch: { nickname: 'other_nickname_new' },
        }),
      );
    });

    it('SUPER_ADMIN 跨组织更新拒绝，目标不被写入', async () => {
      isolation.findActiveMembership.mockImplementationOnce(() => {
        calls.push('findActiveMembership');
        return Promise.resolve(null);
      });

      await expectCode(
        buildUpdateUsecase().execute({
          session: adminSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
          patch: { nickname: 'should_not_write' },
        }),
        ACCOUNT_ERROR.USER_INFO_NOT_FOUND,
      );
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(calls).toEqual([
        `lock:${TARGET_ACCOUNT_ID}`,
        'resolveOrganization',
        'findActiveMembership',
      ]);
    });

    it('操作者无有效组织时拒绝写入', async () => {
      isolation.resolveForAccount.mockRejectedValueOnce(
        new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '无有效组织'),
      );

      await expectCode(
        buildUpdateUsecase().execute({
          session: engineerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
          patch: { phone: '13900000000' },
        }),
        ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
      );
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('操作者组织事实冲突时拒绝写入', async () => {
      isolation.resolveForAccount.mockRejectedValueOnce(
        new DomainError(ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP, '组织事实冲突'),
      );

      await expectCode(
        buildUpdateUsecase().execute({
          session: engineerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
          patch: { phone: '13900000001' },
        }),
        ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
      );
      expect(isolation.findActiveMembership).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('目标不存在：锁定阶段拒绝，与跨组织同码同文案', async () => {
      (accountService.lockByIdForUpdate as jest.Mock).mockRejectedValueOnce(
        new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账户不存在'),
      );

      await expectCodeWithMessage(
        buildUpdateUsecase().execute({
          session: engineerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
          patch: { nickname: 'nope' },
        }),
        ACCOUNT_ERROR.USER_INFO_NOT_FOUND,
        '目标用户不存在',
      );
      expect(isolation.resolveForAccount).not.toHaveBeenCalled();
      expect(fetchUserInfoUsecase.executeStrict).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('CUSTOMER 更新他人：角色拒绝先于加锁，无法用目标 ID 探测存在性', async () => {
      await expectCode(
        buildUpdateUsecase().execute({
          session: customerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
          patch: { nickname: 'probe' },
        }),
        PERMISSION_ERROR.ACCESS_DENIED,
      );
      expect(calls).toEqual([]);
    });

    it('非本人更新计数类字段仍按既有白名单拒绝', async () => {
      await expectCode(
        buildUpdateUsecase().execute({
          session: engineerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
          patch: { notifyCount: 5 },
        }),
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      );
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('非本人更新邮箱（不在他人可写白名单）被忽略，不落库', async () => {
      const result = await buildUpdateUsecase().execute({
        session: engineerSession(),
        targetAccountId: TARGET_ACCOUNT_ID,
        patch: { email: 'hijack@example.com' },
      });

      expect(result.isUpdated).toBe(false);
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('非本人修改 identityHint 仍被拒绝', async () => {
      await expectCode(
        buildUpdateUsecase().execute({
          session: engineerSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
          patch: {},
          identityHint: IdentityTypeEnum.ENGINEER,
        }),
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      );
    });
  });
});

/** 断言错误码与对外文案同时一致（跨组织与目标不存在不可区分）。 */
async function expectCodeWithMessage(
  promise: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code, message });
}

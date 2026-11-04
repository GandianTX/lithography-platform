// src/usecases/account/get-account-by-id.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  AccountStatus,
  IdentityTypeEnum,
  type UserAccountView,
} from '@app-types/models/account.types';
import {
  ACCOUNT_ERROR,
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import {
  ADMIN_ACCOUNT_ID,
  ADMIN_ORGANIZATION_ID,
  TARGET_ACCOUNT_ID,
  captureThrownError,
  createOrganizationIsolationMocks,
  createSuperAdminSession,
} from '../../../test/support/account/admin-user.fixture';
import { GetAccountByIdUsecase } from './get-account-by-id.usecase';

/**
 * 旧 `account(id)` 查询的组织范围回归（P1）。
 *
 * 旧实现把 SUPER_ADMIN 的跨账号放行放在 account 域 QueryService 内，缺少可信组织事实，
 * 管理员因此可以读取任意组织的目标。现在授权上移到 Usecase，本文件固定证明：
 * - 本人查询保留原行为，且不进入组织解析；
 * - 非本人查询仍是**原有管理员权限**（roles 含 SUPER_ADMIN），ENGINEER / CUSTOMER 不放宽；
 * - 管理员通过后再叠加同组织校验；跨组织 / 目标无有效成员关系 / 目标不存在统一为
 *   `USER_INFO_NOT_FOUND`（NOT_FOUND），不泄露登录邮箱、角色或登录历史；
 * - 组织事实缺失、歧义时失败关闭，且全部裁决早于账号行读取。
 */

const TARGET_UNAVAILABLE_MESSAGE = '目标用户不存在';

const targetView = (overrides: Partial<UserAccountView> = {}): UserAccountView => ({
  id: TARGET_ACCOUNT_ID,
  loginName: 'target_user',
  loginEmail: 'target@example.com',
  status: AccountStatus.ACTIVE,
  identityHint: IdentityTypeEnum.CUSTOMER,
  recentLoginHistory: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const engineerSession = (accountId = 3): UsecaseSession => ({
  accountId,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
});

const customerSession = (accountId = 4): UsecaseSession => ({
  accountId,
  roles: [IdentityTypeEnum.CUSTOMER],
  activeRole: IdentityTypeEnum.CUSTOMER,
});

/** 非本人且不具备原 `hasRole(roles, SUPER_ADMIN)` 权限的会话组合 */
const unauthorizedSessions = (): Array<[string, UsecaseSession]> => [
  ['ENGINEER 会话', engineerSession(5)],
  ['CUSTOMER 会话', customerSession(6)],
  [
    'roles 不含 SUPER_ADMIN（矛盾 activeRole）',
    {
      accountId: 7,
      roles: [IdentityTypeEnum.ENGINEER],
      activeRole: IdentityTypeEnum.SUPER_ADMIN,
    },
  ],
];

describe('GetAccountByIdUsecase（account(id) 组织范围）', () => {
  const isolation = createOrganizationIsolationMocks();
  const calls: string[] = [];

  const accountQueryService = {
    findAccountSnapshotById: jest.fn(),
  } as unknown as AccountQueryService;

  const buildUsecase = (): GetAccountByIdUsecase =>
    new GetAccountByIdUsecase(
      accountQueryService,
      isolation.organizationContextQueryService,
      isolation.organizationMembershipQueryService,
    );

  const expectCode = async (promise: Promise<unknown>, code: string): Promise<unknown> =>
    captureThrownError(promise).then((error) => {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(code);
      return error;
    });

  beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();

    isolation.resolveForAccount.mockReset();
    isolation.resolveForAccount.mockImplementation((params: { accountId: number }) => {
      calls.push(`resolve:${params.accountId}`);
      return Promise.resolve({
        membershipId: 1,
        organizationId: ADMIN_ORGANIZATION_ID,
        organizationCode: 'E2E_TEST_PRIMARY',
        organizationName: '测试组织',
        organizationKind: 'CLIENT',
        memberRole: 'SUPER_ADMIN',
      });
    });

    isolation.findActiveMembership.mockReset();
    isolation.findActiveMembership.mockImplementation(
      (params: { accountId: number; organizationId: number }) => {
        calls.push(`membership:${params.accountId}@${params.organizationId}`);
        return Promise.resolve({
          membershipId: 2,
          organizationId: ADMIN_ORGANIZATION_ID,
          organizationCode: 'E2E_TEST_PRIMARY',
          organizationName: '测试组织',
          organizationKind: 'CLIENT',
          memberRole: 'CUSTOMER',
        });
      },
    );

    (accountQueryService.findAccountSnapshotById as jest.Mock).mockReset();
    (accountQueryService.findAccountSnapshotById as jest.Mock).mockImplementation(
      (params: { accountId: number }) => {
        calls.push(`snapshot:${params.accountId}`);
        return Promise.resolve(targetView({ id: params.accountId }));
      },
    );
  });

  describe('合法路径', () => {
    it('本人查询保留原行为：不解析组织、不要求管理员角色', async () => {
      const result = await buildUsecase().execute({
        session: engineerSession(TARGET_ACCOUNT_ID),
        targetAccountId: TARGET_ACCOUNT_ID,
      });

      expect(result).toEqual(targetView());
      expect(calls).toEqual([`snapshot:${TARGET_ACCOUNT_ID}`]);
      expect(isolation.resolveForAccount).not.toHaveBeenCalled();
      expect(isolation.findActiveMembership).not.toHaveBeenCalled();
    });

    it('管理员查询同组织目标：按原字段契约返回', async () => {
      const result = await buildUsecase().execute({
        session: createSuperAdminSession(),
        targetAccountId: TARGET_ACCOUNT_ID,
      });

      expect(result).toEqual(targetView());
      expect(result.loginEmail).toBe('target@example.com');
      expect(calls).toEqual([
        `resolve:${ADMIN_ACCOUNT_ID}`,
        `membership:${TARGET_ACCOUNT_ID}@${ADMIN_ORGANIZATION_ID}`,
        `snapshot:${TARGET_ACCOUNT_ID}`,
      ]);
    });
  });

  describe('拒绝路径', () => {
    it('管理员查询跨组织目标：拒绝且不读取账号行、不泄露敏感字段', async () => {
      isolation.findActiveMembership.mockImplementationOnce(
        (params: { accountId: number; organizationId: number }) => {
          calls.push(`membership:${params.accountId}@${params.organizationId}`);
          return Promise.resolve(null);
        },
      );

      const error = await expectCode(
        buildUsecase().execute({
          session: createSuperAdminSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ACCOUNT_ERROR.USER_INFO_NOT_FOUND,
      );

      expect((error as DomainError).message).toBe(TARGET_UNAVAILABLE_MESSAGE);
      expect((error as DomainError).details).toBeUndefined();
      expect(calls).toEqual([
        `resolve:${ADMIN_ACCOUNT_ID}`,
        `membership:${TARGET_ACCOUNT_ID}@${ADMIN_ORGANIZATION_ID}`,
      ]);
      expect(accountQueryService.findAccountSnapshotById).not.toHaveBeenCalled();
      expect(JSON.stringify(error)).not.toContain('target@example.com');
    });

    it.each(unauthorizedSessions())(
      '非本人查询权限不足（%s）：仍拒绝且先于组织解析',
      async (_label, session) => {
        await expectCode(
          buildUsecase().execute({ session, targetAccountId: TARGET_ACCOUNT_ID }),
          PERMISSION_ERROR.ACCESS_DENIED,
        );
        expect(calls).toEqual([]);
        expect(accountQueryService.findAccountSnapshotById).not.toHaveBeenCalled();
      },
    );

    it('操作者组织事实缺失：失败关闭，不核验目标成员关系', async () => {
      isolation.resolveForAccount.mockRejectedValueOnce(
        new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '无有效组织'),
      );

      await expectCode(
        buildUsecase().execute({
          session: createSuperAdminSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
      );
      expect(isolation.resolveForAccount).toHaveBeenCalledWith({ accountId: ADMIN_ACCOUNT_ID });
      expect(isolation.findActiveMembership).not.toHaveBeenCalled();
      expect(accountQueryService.findAccountSnapshotById).not.toHaveBeenCalled();
    });

    it('操作者组织事实冲突：失败关闭，不核验目标成员关系', async () => {
      isolation.resolveForAccount.mockRejectedValueOnce(
        new DomainError(ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP, '组织事实冲突'),
      );

      await expectCode(
        buildUsecase().execute({
          session: createSuperAdminSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
      );
      expect(isolation.resolveForAccount).toHaveBeenCalledWith({ accountId: ADMIN_ACCOUNT_ID });
      expect(isolation.findActiveMembership).not.toHaveBeenCalled();
      expect(accountQueryService.findAccountSnapshotById).not.toHaveBeenCalled();
    });

    it('目标不存在与跨组织使用同一拒绝口径', async () => {
      isolation.findActiveMembership.mockResolvedValueOnce(null);
      const crossOrg = await expectCode(
        buildUsecase().execute({
          session: createSuperAdminSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ACCOUNT_ERROR.USER_INFO_NOT_FOUND,
      );

      isolation.findActiveMembership.mockResolvedValueOnce(null);
      const missingTarget = await expectCode(
        buildUsecase().execute({
          session: createSuperAdminSession(),
          targetAccountId: 9_999_999,
        }),
        ACCOUNT_ERROR.USER_INFO_NOT_FOUND,
      );

      expect((missingTarget as DomainError).message).toBe((crossOrg as DomainError).message);
      expect((missingTarget as DomainError).details).toBe((crossOrg as DomainError).details);
      expect(accountQueryService.findAccountSnapshotById).not.toHaveBeenCalled();
    });

    it('授权后账号行消失：非本人沿用同一「目标不可用」口径', async () => {
      (accountQueryService.findAccountSnapshotById as jest.Mock).mockResolvedValueOnce(null);

      const error = await expectCode(
        buildUsecase().execute({
          session: createSuperAdminSession(),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ACCOUNT_ERROR.USER_INFO_NOT_FOUND,
      );
      expect((error as DomainError).message).toBe(TARGET_UNAVAILABLE_MESSAGE);
      expect(accountQueryService.findAccountSnapshotById).toHaveBeenCalledTimes(1);
    });

    it('本人账号行消失：保留原 ACCOUNT_NOT_FOUND 口径', async () => {
      (accountQueryService.findAccountSnapshotById as jest.Mock).mockResolvedValueOnce(null);

      await expectCode(
        buildUsecase().execute({
          session: engineerSession(TARGET_ACCOUNT_ID),
          targetAccountId: TARGET_ACCOUNT_ID,
        }),
        ACCOUNT_ERROR.ACCOUNT_NOT_FOUND,
      );
    });

    it.each([0, -1, 1.5])(
      '非法目标账户 ID（%s）：拒绝且不触发任何读取',
      async (targetAccountId) => {
        await expectCode(
          buildUsecase().execute({ session: createSuperAdminSession(), targetAccountId }),
          PERMISSION_ERROR.ACCESS_DENIED,
        );
        expect(calls).toEqual([]);
      },
    );
  });

  it('CUSTOMER 查询他人：角色拒绝先于组织解析（不扩大工程师/客户访问权）', async () => {
    await expectCode(
      buildUsecase().execute({
        session: customerSession(),
        targetAccountId: TARGET_ACCOUNT_ID,
      }),
      PERMISSION_ERROR.ACCESS_DENIED,
    );
    expect(calls).toEqual([]);
  });
});

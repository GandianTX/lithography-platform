// src/usecases/registration/resubmit-engineer-registration.usecase.spec.ts
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import { ACCOUNT_ERROR, ENGINEER_REGISTRATION_ERROR } from '@core/common/errors/domain-error';
import { AccountService } from '@src/modules/account/base/services/account.service';
import type { AccountCredentialSnapshot } from '@src/modules/account/account.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import { EngineerRegistrationService } from '@src/modules/lithography/engineer-registration.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { PinoLogger } from 'nestjs-pino';
import { ResubmitEngineerRegistrationUsecase } from './resubmit-engineer-registration.usecase';

describe('ResubmitEngineerRegistrationUsecase（拒绝后重提）', () => {
  const ACCOUNT_ID = 401;
  const ORGANIZATION_ID = 12;
  const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
  const PASSWORD = 'Str0ng!Passw0rd';
  const PASSWORD_HASH = AccountService.hashPasswordWithTimestamp(PASSWORD, CREATED_AT);

  let accountService: { lockMyAccountCredentialSnapshot: jest.Mock };
  let accountQueryService: {
    findCredentialByLoginName: jest.Mock;
    getLoginBootstrapSnapshot: jest.Mock;
  };
  let adminUserQueryService: { findAdminUserStatusFacts: jest.Mock };
  let organizationQueryService: { findActiveRegistrationOption: jest.Mock };
  let organizationMembershipQueryService: { listActiveMembershipsByAccount: jest.Mock };
  let engineerRegistrationService: {
    lockLatestApplicationByAccountId: jest.Mock;
    insertApplication: jest.Mock;
  };
  let engineerRegistrationQueryService: { findById: jest.Mock };
  let logger: { setContext: jest.Mock; info: jest.Mock; error: jest.Mock };
  let transactionRunner: { run: jest.Mock };
  let usecase: ResubmitEngineerRegistrationUsecase;

  const command = () => ({
    accountIdentifier: 'pending-engineer',
    password: PASSWORD,
    organizationId: ORGANIZATION_ID,
    applicationNote: '再次申请',
  });

  const credential = (): AccountCredentialSnapshot => ({
    id: ACCOUNT_ID,
    status: AccountStatus.PENDING,
    loginPassword: PASSWORD_HASH,
    createdAt: CREATED_AT,
  });

  const application = (
    status: EngineerRegistrationApplicationStatus,
    id = 7,
  ): EngineerRegistrationApplicationSnapshot => ({
    id,
    accountId: ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    status,
    applicationNote: null,
    submittedAt: CREATED_AT,
    reviewedByAccountId: status === EngineerRegistrationApplicationStatus.PENDING ? null : 1,
    reviewedAt: status === EngineerRegistrationApplicationStatus.PENDING ? null : CREATED_AT,
    reviewComment: status === EngineerRegistrationApplicationStatus.REJECTED ? '资料不足' : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  beforeEach(() => {
    accountService = {
      lockMyAccountCredentialSnapshot: jest.fn().mockResolvedValue({
        id: ACCOUNT_ID,
        status: AccountStatus.PENDING,
        loginPassword: PASSWORD_HASH,
        createdAt: CREATED_AT,
      }),
    };
    accountQueryService = {
      findCredentialByLoginName: jest.fn().mockResolvedValue(credential()),
      getLoginBootstrapSnapshot: jest.fn().mockResolvedValue({
        account: { identityHint: IdentityTypeEnum.ENGINEER },
        userInfo: {
          accessGroup: [IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.ENGINEER],
        },
      }),
    };
    adminUserQueryService = {
      findAdminUserStatusFacts: jest
        .fn()
        .mockResolvedValue({ accountStatus: AccountStatus.PENDING, userState: UserState.PENDING }),
    };
    organizationQueryService = {
      findActiveRegistrationOption: jest
        .fn()
        .mockResolvedValue({ id: ORGANIZATION_ID, name: '测试组织' }),
    };
    organizationMembershipQueryService = {
      listActiveMembershipsByAccount: jest.fn().mockResolvedValue([]),
    };
    engineerRegistrationService = {
      lockLatestApplicationByAccountId: jest
        .fn()
        .mockResolvedValue(application(EngineerRegistrationApplicationStatus.REJECTED)),
      insertApplication: jest.fn().mockResolvedValue({ applicationId: 8 }),
    };
    engineerRegistrationQueryService = {
      findById: jest
        .fn()
        .mockResolvedValue(application(EngineerRegistrationApplicationStatus.PENDING, 8)),
    };
    logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() };
    transactionRunner = {
      run: jest.fn(async (fn: (ctx: PersistenceTransactionContext) => Promise<unknown>) =>
        fn({ transaction: {} } as unknown as PersistenceTransactionContext),
      ),
    };

    usecase = new ResubmitEngineerRegistrationUsecase(
      accountService as unknown as AccountService,
      accountQueryService as unknown as AccountQueryService,
      adminUserQueryService as unknown as AdminUserQueryService,
      organizationQueryService as unknown as OrganizationQueryService,
      organizationMembershipQueryService as unknown as OrganizationMembershipQueryService,
      engineerRegistrationService as unknown as EngineerRegistrationService,
      engineerRegistrationQueryService as unknown as EngineerRegistrationQueryService,
      logger as unknown as PinoLogger,
      transactionRunner as never,
    );
  });

  describe('凭据证明', () => {
    it('账号不存在时事务外即返回 CREDENTIAL_MISMATCH', async () => {
      accountQueryService.findCredentialByLoginName.mockResolvedValue(null);

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH,
      });
      expect(transactionRunner.run).not.toHaveBeenCalled();
    });

    it('密码错误时全部裁决中止，不写入任何申请', async () => {
      accountService.lockMyAccountCredentialSnapshot.mockResolvedValue({
        id: ACCOUNT_ID,
        status: AccountStatus.PENDING,
        loginPassword: PASSWORD_HASH,
        createdAt: CREATED_AT,
      });

      await expect(
        usecase.execute({ ...command(), password: 'Wrong#Pass2026' }),
      ).rejects.toMatchObject({ code: ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH });
      expect(engineerRegistrationService.insertApplication).not.toHaveBeenCalled();
    });
  });

  describe('前置事实复核', () => {
    it('非工程师账号不得重提', async () => {
      accountQueryService.getLoginBootstrapSnapshot.mockResolvedValue({
        account: { identityHint: IdentityTypeEnum.CUSTOMER },
        userInfo: {
          accessGroup: [IdentityTypeEnum.CUSTOMER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
        },
      });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.ACCOUNT_NOT_PENDING,
      });
    });

    it('账号双状态非 PENDING/PENDING 时不得重提', async () => {
      adminUserQueryService.findAdminUserStatusFacts.mockResolvedValue({
        accountStatus: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.ACCOUNT_NOT_PENDING,
      });
    });

    it('已有有效成员关系时拒绝重提，防止绕过成员边界', async () => {
      organizationMembershipQueryService.listActiveMembershipsByAccount.mockResolvedValue([
        { id: 1, organizationId: ORGANIZATION_ID, memberRole: IdentityTypeEnum.ENGINEER },
      ]);

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.RESUBMIT_NOT_ALLOWED,
      });
      expect(engineerRegistrationService.insertApplication).not.toHaveBeenCalled();
    });

    it('所选组织失效时拒绝重提', async () => {
      organizationQueryService.findActiveRegistrationOption.mockResolvedValue(null);

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE,
      });
    });
  });

  describe('申请历史可重提性', () => {
    it('无历史申请时返回 RESUBMIT_NOT_ALLOWED', async () => {
      engineerRegistrationService.lockLatestApplicationByAccountId.mockResolvedValue(null);

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.RESUBMIT_NOT_ALLOWED,
      });
    });

    it('最新申请仍待审时返回 PENDING_APPLICATION_EXISTS', async () => {
      engineerRegistrationService.lockLatestApplicationByAccountId.mockResolvedValue(
        application(EngineerRegistrationApplicationStatus.PENDING),
      );

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.PENDING_APPLICATION_EXISTS,
      });
    });

    it('最新申请已通过时不允许再次申请', async () => {
      engineerRegistrationService.lockLatestApplicationByAccountId.mockResolvedValue(
        application(EngineerRegistrationApplicationStatus.APPROVED),
      );

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.RESUBMIT_NOT_ALLOWED,
      });
    });
  });

  describe('重提成功：新增 PENDING，不覆盖历史', () => {
    it('插入新申请并返回最小事实，历史行不被改写', async () => {
      const result = await usecase.execute(command());

      expect(result).toMatchObject({
        applicationId: 8,
        organizationId: ORGANIZATION_ID,
        status: EngineerRegistrationApplicationStatus.PENDING,
        submittedAt: CREATED_AT,
      });
      expect(engineerRegistrationService.insertApplication).toHaveBeenCalledWith(
        {
          accountId: ACCOUNT_ID,
          organizationId: ORGANIZATION_ID,
          applicationNote: '再次申请',
          submittedAt: expect.any(Date),
        },
        expect.anything(),
      );
    });
  });
});

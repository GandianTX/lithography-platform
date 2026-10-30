// src/usecases/registration/review-engineer-registration.usecase.spec.ts
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  EngineerRegistrationApplicationStatus,
  EngineerRegistrationReviewAction,
} from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import { ENGINEER_REGISTRATION_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AdminUserView } from '@src/modules/account/account.types';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import { EngineerRegistrationService } from '@src/modules/lithography/engineer-registration.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { PinoLogger } from 'nestjs-pino';
import { ReviewEngineerRegistrationUsecase } from './review-engineer-registration.usecase';

describe('ReviewEngineerRegistrationUsecase（组织管理员一次性终态决策）', () => {
  const ADMIN_ACCOUNT_ID = 1;
  const APPLICANT_ACCOUNT_ID = 501;
  const ORGANIZATION_ID = 5;
  const APPLICATION_ID = 61;
  const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

  let session: UsecaseSession;
  let accountService: {
    lockMyAccountCredentialSnapshot: jest.Mock;
    updateAccount: jest.Mock;
    updateUserInfoFields: jest.Mock;
  };
  let accountQueryService: { getLoginBootstrapSnapshot: jest.Mock };
  let adminUserQueryService: {
    findAdminUserStatusFacts: jest.Mock;
    findAdminUserViewById: jest.Mock;
  };
  let organizationMembershipQueryService: { listActiveMembershipsByAccount: jest.Mock };
  let organizationMembershipService: { insertMembership: jest.Mock };
  let engineerRegistrationService: {
    lockApplicationById: jest.Mock;
    updateApplicationDecision: jest.Mock;
  };
  let engineerRegistrationQueryService: { findById: jest.Mock };
  let organizationContext: { resolveForAccount: jest.Mock };
  let logger: { setContext: jest.Mock; info: jest.Mock; error: jest.Mock };
  let transactionRunner: { run: jest.Mock };
  let usecase: ReviewEngineerRegistrationUsecase;

  let currentStatus: EngineerRegistrationApplicationStatus;
  let reviewComment: string | null;

  const application = (
    status: EngineerRegistrationApplicationStatus,
  ): EngineerRegistrationApplicationSnapshot => ({
    id: APPLICATION_ID,
    accountId: APPLICANT_ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    status,
    applicationNote: '希望加入组织',
    submittedAt: CREATED_AT,
    reviewedByAccountId:
      status === EngineerRegistrationApplicationStatus.PENDING ? null : ADMIN_ACCOUNT_ID,
    reviewedAt: status === EngineerRegistrationApplicationStatus.PENDING ? null : CREATED_AT,
    reviewComment,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const applicantView = (status: AccountStatus): AdminUserView => ({
    id: APPLICANT_ACCOUNT_ID,
    loginName: 'pending-engineer',
    loginEmail: 'pending@example.com',
    nickname: '待审工程师',
    companyName: null,
    phone: null,
    contactEmail: null,
    role: IdentityTypeEnum.ENGINEER,
    status,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const organizationFact = (memberRole: string) => ({
    membershipId: 9,
    organizationId: ORGANIZATION_ID,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '测试组织',
    organizationKind: 'CLIENT',
    memberRole,
  });

  beforeEach(() => {
    session = {
      accountId: ADMIN_ACCOUNT_ID,
      roles: [IdentityTypeEnum.SUPER_ADMIN],
      activeRole: IdentityTypeEnum.SUPER_ADMIN,
    };
    currentStatus = EngineerRegistrationApplicationStatus.PENDING;
    reviewComment = null;

    accountService = {
      lockMyAccountCredentialSnapshot: jest.fn().mockResolvedValue({
        id: APPLICANT_ACCOUNT_ID,
        status: AccountStatus.PENDING,
        loginPassword: 'hash',
        createdAt: CREATED_AT,
      }),
      updateAccount: jest.fn().mockResolvedValue(undefined),
      updateUserInfoFields: jest.fn().mockResolvedValue(undefined),
    };
    accountQueryService = {
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
      findAdminUserViewById: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            applicantView(
              currentStatus === EngineerRegistrationApplicationStatus.APPROVED
                ? AccountStatus.ACTIVE
                : AccountStatus.PENDING,
            ),
          ),
        ),
    };
    organizationMembershipQueryService = {
      listActiveMembershipsByAccount: jest.fn().mockResolvedValue([]),
    };
    organizationMembershipService = {
      insertMembership: jest.fn().mockResolvedValue({ membershipId: 10 }),
    };
    engineerRegistrationService = {
      lockApplicationById: jest
        .fn()
        .mockImplementation(() => Promise.resolve(application(currentStatus))),
      updateApplicationDecision: jest.fn().mockImplementation((data) => {
        currentStatus = data.status;
        reviewComment = data.reviewComment;
        return Promise.resolve({ updated: true });
      }),
    };
    engineerRegistrationQueryService = {
      findById: jest.fn().mockImplementation(() => Promise.resolve(application(currentStatus))),
    };
    organizationContext = {
      resolveForAccount: jest
        .fn()
        .mockResolvedValue(organizationFact(IdentityTypeEnum.SUPER_ADMIN)),
    };
    logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() };
    transactionRunner = {
      run: jest.fn(async (fn: (ctx: PersistenceTransactionContext) => Promise<unknown>) =>
        fn({ transaction: {} } as unknown as PersistenceTransactionContext),
      ),
    };

    usecase = new ReviewEngineerRegistrationUsecase(
      accountService as unknown as AccountService,
      accountQueryService as unknown as AccountQueryService,
      adminUserQueryService as unknown as AdminUserQueryService,
      organizationMembershipQueryService as unknown as OrganizationMembershipQueryService,
      organizationMembershipService as unknown as OrganizationMembershipService,
      engineerRegistrationService as unknown as EngineerRegistrationService,
      engineerRegistrationQueryService as unknown as EngineerRegistrationQueryService,
      organizationContext as unknown as TrustedOrganizationContextQueryService,
      logger as unknown as PinoLogger,
      transactionRunner as never,
    );
  });

  const approveCommand = () => ({
    session,
    applicationId: APPLICATION_ID,
    action: EngineerRegistrationReviewAction.APPROVE,
    reviewComment: '资料齐全',
  });

  const rejectCommand = (comment: string | null = '资料不足') => ({
    session,
    applicationId: APPLICATION_ID,
    action: EngineerRegistrationReviewAction.REJECT,
    reviewComment: comment,
  });

  describe('权限与组织边界', () => {
    it('非超级管理员会话在事务前即被拒绝', async () => {
      session = { accountId: 2, roles: [IdentityTypeEnum.ENGINEER], activeRole: undefined };

      await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      });
      expect(transactionRunner.run).not.toHaveBeenCalled();
    });

    it('所属组织成员角色不是 SUPER_ADMIN 时拒绝审核', async () => {
      organizationContext.resolveForAccount.mockResolvedValue(
        organizationFact(IdentityTypeEnum.ENGINEER),
      );

      await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      });
      expect(engineerRegistrationService.lockApplicationById).not.toHaveBeenCalled();
    });

    it('跨组织申请按不存在处理，不暴露其他组织申请', async () => {
      engineerRegistrationQueryService.findById.mockResolvedValue({
        ...application(EngineerRegistrationApplicationStatus.PENDING),
        organizationId: ORGANIZATION_ID + 1,
      });

      await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND,
      });
      expect(engineerRegistrationService.lockApplicationById).not.toHaveBeenCalled();
    });

    it('拒绝时必须填写审核意见（事务前拒绝）', async () => {
      await expect(usecase.execute(rejectCommand('   '))).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS,
      });
      expect(transactionRunner.run).not.toHaveBeenCalled();
    });
  });

  describe('锁内复核失败关闭', () => {
    it('申请已非 PENDING 时返回 APPLICATION_STATE_CONFLICT', async () => {
      currentStatus = EngineerRegistrationApplicationStatus.APPROVED;

      await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
      });
      expect(accountService.updateAccount).not.toHaveBeenCalled();
    });

    it('申请人双状态非 PENDING/PENDING 时返回 APPLICATION_STATE_CONFLICT', async () => {
      adminUserQueryService.findAdminUserStatusFacts.mockResolvedValue({
        accountStatus: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });

      await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
      });
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
    });

    it('申请人已有有效成员关系时返回 APPLICATION_STATE_CONFLICT', async () => {
      organizationMembershipQueryService.listActiveMembershipsByAccount.mockResolvedValue([
        { membershipId: 3, organizationId: ORGANIZATION_ID, memberRole: 'ENGINEER' },
      ]);

      await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
      });
      expect(accountService.updateAccount).not.toHaveBeenCalled();
    });

    it('并发第二次决策（条件更新未命中）返回 CONFLICT，不覆盖历史', async () => {
      engineerRegistrationService.updateApplicationDecision.mockResolvedValue({ updated: false });

      await expect(usecase.execute(approveCommand())).rejects.toMatchObject({
        code: ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT,
      });
    });

    it('先锁账号行再锁申请行，锁序与重提流程一致', async () => {
      await usecase.execute(approveCommand());

      expect(
        accountService.lockMyAccountCredentialSnapshot.mock.invocationCallOrder[0],
      ).toBeLessThan(engineerRegistrationService.lockApplicationById.mock.invocationCallOrder[0]);
    });
  });

  describe('审核通过：账号、资料与成员关系同事务生效', () => {
    it('写 ENGINEER 成员关系、双状态 ACTIVE 并通过申请，返回审核后视图', async () => {
      const result = await usecase.execute(approveCommand());

      expect(organizationMembershipService.insertMembership).toHaveBeenCalledWith(
        {
          organizationId: ORGANIZATION_ID,
          accountId: APPLICANT_ACCOUNT_ID,
          memberRole: IdentityTypeEnum.ENGINEER,
        },
        expect.anything(),
      );
      expect(accountService.updateAccount).toHaveBeenCalledWith(
        APPLICANT_ACCOUNT_ID,
        expect.objectContaining({ status: AccountStatus.ACTIVE }),
        expect.anything(),
      );
      expect(accountService.updateUserInfoFields).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: APPLICANT_ACCOUNT_ID,
          patch: { userState: UserState.ACTIVE },
        }),
      );
      expect(engineerRegistrationService.updateApplicationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationId: APPLICATION_ID,
          status: EngineerRegistrationApplicationStatus.APPROVED,
          reviewedByAccountId: ADMIN_ACCOUNT_ID,
          reviewComment: '资料齐全',
        }),
        expect.anything(),
      );
      expect(result.application.status).toBe(EngineerRegistrationApplicationStatus.APPROVED);
      expect(result.applicant.status).toBe(AccountStatus.ACTIVE);
    });
  });

  describe('审核拒绝：只记录决策，账号保持待审', () => {
    it('不建立成员关系、不改账号状态，只写 REJECTED 与意见', async () => {
      const result = await usecase.execute(rejectCommand());

      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(engineerRegistrationService.updateApplicationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationId: APPLICATION_ID,
          status: EngineerRegistrationApplicationStatus.REJECTED,
          reviewComment: '资料不足',
        }),
        expect.anything(),
      );
      expect(result.application.status).toBe(EngineerRegistrationApplicationStatus.REJECTED);
      expect(result.applicant.status).toBe(AccountStatus.PENDING);
    });
  });
});

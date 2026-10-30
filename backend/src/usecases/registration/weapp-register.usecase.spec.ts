// src/usecases/registration/weapp-register.usecase.spec.ts
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  ThirdPartyProviderEnum,
} from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { ThirdPartySession } from '@app-types/models/third-party-auth.types';
import { ACCOUNT_ERROR, THIRDPARTY_ERROR } from '@core/common/errors/domain-error';
import { ThirdPartyAuthQueryService } from '@modules/third-party-auth/queries/third-party-auth.query.service';
import { ThirdPartyAuthService } from '@modules/third-party-auth/third-party-auth.service';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { PinoLogger } from 'nestjs-pino';
import { WeappRegisterUsecase } from './weapp-register.usecase';

describe('WeappRegisterUsecase（注册事务语义）', () => {
  const ACCOUNT_ID = 201;
  const ORGANIZATION_ID = 21;

  let tpa: {
    resolveIdentity: jest.Mock;
    bindThirdPartyForRegistration: jest.Mock;
    getWeappPhoneNumber: jest.Mock;
  };
  let thirdPartyAuthQueryService: { findAccountByThirdParty: jest.Mock };
  let accountService: {
    createAccountEntity: jest.Mock;
    saveAccount: jest.Mock;
    updateAccountPasswordHash: jest.Mock;
    createUserInfoEntity: jest.Mock;
    saveUserInfo: jest.Mock;
    updateAccount: jest.Mock;
  };
  let accountQueryService: {
    pickAvailableNickname: jest.Mock;
    getUserAccountViewById: jest.Mock;
  };
  let organizationQueryService: { findActiveRegistrationOption: jest.Mock };
  let organizationMembershipService: { insertMembership: jest.Mock };
  let logger: { setContext: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };

  let txContext: PersistenceTransactionContext;
  let committed: boolean;
  let rolledBack: boolean;
  let transactionRunner: { run: jest.Mock };

  let usecase: WeappRegisterUsecase;

  const validParams = () => ({
    provider: ThirdPartyProviderEnum.WEAPP,
    authCredential: 'wx-code-e2e',
    audience: AudienceTypeEnum.SSTSWEAPP,
    organizationId: ORGANIZATION_ID,
  });

  const session = (): ThirdPartySession =>
    ({
      provider: ThirdPartyProviderEnum.WEAPP,
      providerUserId: 'openid-1',
      unionId: null,
      profile: { nickname: 'WeappUser' },
      sessionKeyRaw: 'session-key',
    }) as unknown as ThirdPartySession;

  beforeEach(() => {
    txContext = { transaction: {} } as unknown as PersistenceTransactionContext;
    committed = false;
    rolledBack = false;

    tpa = {
      resolveIdentity: jest.fn().mockResolvedValue(session()),
      bindThirdPartyForRegistration: jest.fn().mockResolvedValue(undefined),
      getWeappPhoneNumber: jest.fn(),
    };
    thirdPartyAuthQueryService = { findAccountByThirdParty: jest.fn().mockResolvedValue(null) };
    accountService = {
      createAccountEntity: jest.fn(),
      saveAccount: jest.fn(),
      updateAccountPasswordHash: jest.fn(),
      createUserInfoEntity: jest.fn(),
      saveUserInfo: jest.fn(),
      updateAccount: jest.fn(),
    };
    accountQueryService = {
      pickAvailableNickname: jest.fn().mockResolvedValue('微信用户_abc123'),
      getUserAccountViewById: jest.fn().mockResolvedValue({ id: ACCOUNT_ID }),
    };
    organizationQueryService = {
      findActiveRegistrationOption: jest
        .fn()
        .mockResolvedValue({ id: ORGANIZATION_ID, name: '测试组织' }),
    };
    organizationMembershipService = {
      insertMembership: jest.fn().mockResolvedValue({ membershipId: 1 }),
    };
    logger = {
      setContext: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    transactionRunner = {
      run: jest.fn(async (fn: (ctx: PersistenceTransactionContext) => Promise<unknown>) => {
        try {
          const result = await fn(txContext);
          committed = true;
          return result;
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      }),
    };

    accountService.saveAccount.mockImplementation(({ account }) => ({
      ...account,
      id: ACCOUNT_ID,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }));

    usecase = new WeappRegisterUsecase(
      tpa as unknown as ThirdPartyAuthService,
      thirdPartyAuthQueryService as unknown as ThirdPartyAuthQueryService,
      accountService as unknown as AccountService,
      accountQueryService as unknown as AccountQueryService,
      organizationQueryService as unknown as OrganizationQueryService,
      organizationMembershipService as unknown as OrganizationMembershipService,
      logger as unknown as PinoLogger,
      transactionRunner as never,
    );
  });

  describe('注册成功：事务内直接写 ACTIVE / ACTIVE', () => {
    it('账号实体以 status=ACTIVE 创建，资料显式写 userState=ACTIVE', async () => {
      const result = await usecase.execute(validParams());

      expect(result).toMatchObject({ success: true, accountId: ACCOUNT_ID });

      const accountArg = accountService.createAccountEntity.mock.calls[0][0];
      expect(accountArg.transactionContext).toBe(txContext);
      expect(accountArg.accountData).toMatchObject({
        status: AccountStatus.ACTIVE,
        identityHint: IdentityTypeEnum.CUSTOMER,
      });

      const userInfoArg = accountService.createUserInfoEntity.mock.calls[0][0];
      expect(userInfoArg.transactionContext).toBe(txContext);
      expect(userInfoArg.userInfoData).toMatchObject({
        accountId: ACCOUNT_ID,
        userState: UserState.ACTIVE,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
      });
    });

    it('事务提交后不再调用 updateAccount(...ACTIVE) 补救，第三方绑定照常创建', async () => {
      await usecase.execute(validParams());

      expect(accountService.updateAccount).not.toHaveBeenCalled();
      expect(tpa.bindThirdPartyForRegistration).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ACCOUNT_ID }),
      );
      expect(committed).toBe(true);
      expect(rolledBack).toBe(false);
    });

    it('账号、密码哈希与资料写入共享同一事务上下文', async () => {
      await usecase.execute(validParams());

      expect(accountService.updateAccountPasswordHash).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ACCOUNT_ID, transactionContext: txContext }),
      );
      expect(accountService.saveUserInfo).toHaveBeenCalledWith(
        expect.objectContaining({ transactionContext: txContext }),
      );
    });

    it('同事务绑定所选组织为 CUSTOMER 成员', async () => {
      await usecase.execute(validParams());

      expect(organizationQueryService.findActiveRegistrationOption).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORGANIZATION_ID, transactionContext: txContext }),
      );
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledWith(
        {
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          memberRole: IdentityTypeEnum.CUSTOMER,
        },
        txContext,
      );
    });
  });

  describe('所选组织校验', () => {
    it('组织不存在或已停用：账号零落库，事务回滚，第三方绑定不执行', async () => {
      organizationQueryService.findActiveRegistrationOption.mockResolvedValue(null);

      await expect(usecase.execute(validParams())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE,
      });

      expect(accountService.saveAccount).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(tpa.bindThirdPartyForRegistration).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
    });

    it('未提供 organizationId 时在事务前拒绝', async () => {
      await expect(
        usecase.execute({ ...validParams(), organizationId: undefined }),
      ).rejects.toMatchObject({ code: 'ENGINEER_REGISTRATION_INVALID_PARAMS' });

      expect(transactionRunner.run).not.toHaveBeenCalled();
    });
  });

  describe('失败原子性', () => {
    it('userInfo 保存失败时异常上抛、事务回滚，不返回注册成功', async () => {
      accountService.saveUserInfo.mockRejectedValue(new Error('user_info insert failed'));

      await expect(usecase.execute(validParams())).rejects.toMatchObject({
        code: THIRDPARTY_ERROR.REGISTRATION_FAILED,
      });

      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
      expect(accountService.updateAccount).not.toHaveBeenCalled();
      // 账号创建事务失败时，第三方绑定不得进行
      expect(tpa.bindThirdPartyForRegistration).not.toHaveBeenCalled();
    });
  });
});

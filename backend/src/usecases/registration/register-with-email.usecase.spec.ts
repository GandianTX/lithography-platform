// src/usecases/registration/register-with-email.usecase.spec.ts
import { AccountStatus, IdentityTypeEnum, UserAccountView } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { ACCOUNT_ERROR, DomainError } from '@core/common/errors';
import { INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EngineerRegistrationService } from '@src/modules/lithography/engineer-registration.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { OrganizationService } from '@src/modules/lithography/organization.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { PinoLogger } from 'nestjs-pino';
import { RegisterWithEmailUsecase } from './register-with-email.usecase';
import { RegisterTypeEnum } from '@app-types/services/register.types';

describe('RegisterWithEmailUsecase（注册事务语义）', () => {
  const ACCOUNT_ID = 101;
  const ORGANIZATION_ID = 11;

  let accountService: {
    createAccountEntity: jest.Mock;
    saveAccount: jest.Mock;
    updateAccountPasswordHash: jest.Mock;
    createUserInfoEntity: jest.Mock;
    saveUserInfo: jest.Mock;
    updateAccount: jest.Mock;
  };
  let accountQueryService: {
    checkAccountExists: jest.Mock;
    pickAvailableNickname: jest.Mock;
    getUserAccountViewById: jest.Mock;
  };
  let passwordPolicyService: { validatePassword: jest.Mock };
  let organizationQueryService: { findEligibleRegistrationOption: jest.Mock };
  let organizationService: { createSelfRegisteredCompany: jest.Mock };
  let organizationMembershipService: { insertMembership: jest.Mock };
  let engineerRegistrationService: { insertApplication: jest.Mock };
  let logger: { setContext: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };

  /** 模拟 TransactionRunner：成功提交、异常回滚，并把事务上下文透传给回调 */
  let txContext: PersistenceTransactionContext;
  let committed: boolean;
  let rolledBack: boolean;
  let transactionRunner: { run: jest.Mock };

  let usecase: RegisterWithEmailUsecase;

  const validParams = () => ({
    loginName: 'newuser',
    loginEmail: 'newuser@example.com',
    loginPassword: 'Str0ng!Passw0rd',
    nickname: '新用户',
    type: RegisterTypeEnum.CUSTOMER,
    organizationId: ORGANIZATION_ID,
    clientIp: '127.0.0.1',
  });

  const savedView = (): UserAccountView =>
    ({
      id: ACCOUNT_ID,
      status: AccountStatus.ACTIVE,
    }) as unknown as UserAccountView;

  beforeEach(() => {
    txContext = { transaction: {} } as unknown as PersistenceTransactionContext;
    committed = false;
    rolledBack = false;

    accountService = {
      createAccountEntity: jest.fn(),
      saveAccount: jest.fn(),
      updateAccountPasswordHash: jest.fn(),
      createUserInfoEntity: jest.fn(),
      saveUserInfo: jest.fn(),
      updateAccount: jest.fn(),
    };
    accountQueryService = {
      checkAccountExists: jest.fn().mockResolvedValue(false),
      pickAvailableNickname: jest.fn().mockResolvedValue('新用户'),
      getUserAccountViewById: jest.fn().mockResolvedValue(savedView()),
    };
    passwordPolicyService = {
      validatePassword: jest.fn().mockReturnValue({ isValid: true, errors: [] }),
    };
    organizationQueryService = {
      findEligibleRegistrationOption: jest
        .fn()
        .mockResolvedValue({ id: ORGANIZATION_ID, name: '测试公司' }),
    };
    organizationService = {
      createSelfRegisteredCompany: jest.fn().mockResolvedValue({ id: 7001 }),
    };
    organizationMembershipService = {
      insertMembership: jest.fn().mockResolvedValue({ membershipId: 1 }),
    };
    engineerRegistrationService = {
      insertApplication: jest.fn().mockResolvedValue({ applicationId: 9001 }),
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

    // saveAccount 返回带 id / createdAt 的账号实体
    accountService.saveAccount.mockImplementation(({ account }) => ({
      ...account,
      id: ACCOUNT_ID,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }));

    usecase = new RegisterWithEmailUsecase(
      accountService as unknown as AccountService,
      accountQueryService as unknown as AccountQueryService,
      passwordPolicyService as unknown as PasswordPolicyService,
      organizationQueryService as unknown as OrganizationQueryService,
      organizationService as unknown as OrganizationService,
      organizationMembershipService as unknown as OrganizationMembershipService,
      engineerRegistrationService as unknown as EngineerRegistrationService,
      logger as unknown as PinoLogger,
      transactionRunner as never,
    );
  });

  describe('注册成功：事务内直接写 ACTIVE / ACTIVE', () => {
    it('账号实体以 status=ACTIVE 创建（不再先写 PENDING 再补救）', async () => {
      await usecase.execute(validParams());

      expect(accountService.createAccountEntity).toHaveBeenCalledTimes(1);
      const arg = accountService.createAccountEntity.mock.calls[0][0];
      expect(arg.transactionContext).toBe(txContext);
      expect(arg.accountData).toMatchObject({
        status: AccountStatus.ACTIVE,
        identityHint: IdentityTypeEnum.CUSTOMER,
      });
    });

    it('userInfo 实体在事务内显式写 userState=ACTIVE，不依赖 Entity 默认值', async () => {
      await usecase.execute(validParams());

      expect(accountService.createUserInfoEntity).toHaveBeenCalledTimes(1);
      const arg = accountService.createUserInfoEntity.mock.calls[0][0];
      expect(arg.transactionContext).toBe(txContext);
      expect(arg.userInfoData).toMatchObject({
        accountId: ACCOUNT_ID,
        userState: UserState.ACTIVE,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
      });
    });

    it('账号、密码哈希与资料写入共享同一事务上下文，事务正常提交', async () => {
      const result = await usecase.execute(validParams());

      expect(result).toMatchObject({ success: true, accountId: ACCOUNT_ID });
      expect(accountService.updateAccountPasswordHash).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ACCOUNT_ID, transactionContext: txContext }),
      );
      expect(accountService.saveUserInfo).toHaveBeenCalledWith(
        expect.objectContaining({ transactionContext: txContext }),
      );
      expect(committed).toBe(true);
      expect(rolledBack).toBe(false);
    });

    it('事务提交后不再单独调用 updateAccount(...ACTIVE) 补救', async () => {
      await usecase.execute(validParams());

      expect(accountService.updateAccount).not.toHaveBeenCalled();
    });
  });

  const engineerParams = () => ({
    ...validParams(),
    type: RegisterTypeEnum.ENGINEER,
    realName: '张三',
    phone: '138-0013-8000',
    applicationNote: '希望加入组织',
  });

  describe('所选组织与开通结果分支', () => {
    it('客户注册：同事务绑定所选组织为 CUSTOMER 成员，返回 REGISTERED 且无申请', async () => {
      const result = await usecase.execute(validParams());

      expect(result).toMatchObject({
        success: true,
        registrationStatus: 'REGISTERED',
        applicationId: null,
      });
      expect(organizationQueryService.findEligibleRegistrationOption).toHaveBeenCalledWith(
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
      // 客户可信公司归属写 base_user_info.customer_organization_id
      const userInfoArg = accountService.createUserInfoEntity.mock.calls[0][0];
      expect(userInfoArg.userInfoData).toMatchObject({
        customerOrganizationId: ORGANIZATION_ID,
      });
      expect(engineerRegistrationService.insertApplication).not.toHaveBeenCalled();
    });

    it('工程师注册：账号双状态 PENDING，写姓名电话，不建成员关系，落待审申请', async () => {
      const result = await usecase.execute(engineerParams());

      const accountArg = accountService.createAccountEntity.mock.calls[0][0];
      expect(accountArg.accountData).toMatchObject({
        status: AccountStatus.PENDING,
        identityHint: IdentityTypeEnum.ENGINEER,
      });
      const userInfoArg = accountService.createUserInfoEntity.mock.calls[0][0];
      expect(userInfoArg.userInfoData).toMatchObject({
        userState: UserState.PENDING,
        realName: '张三',
        phone: '138-0013-8000',
        customerOrganizationId: null,
        accessGroup: [IdentityTypeEnum.ENGINEER],
        metaDigest: [IdentityTypeEnum.ENGINEER],
      });
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      // 申请写入只接受申请参数：状态固定 PENDING、审批字段由 Service 置空
      expect(engineerRegistrationService.insertApplication).toHaveBeenCalledWith(
        {
          accountId: ACCOUNT_ID,
          organizationId: ORGANIZATION_ID,
          applicationNote: '希望加入组织',
          submittedAt: expect.any(Date),
        },
        txContext,
      );
      const applicationArg = engineerRegistrationService.insertApplication.mock.calls[0][0];
      expect(applicationArg).not.toHaveProperty('status');
      expect(applicationArg).not.toHaveProperty('reviewedByAccountId');
      expect(applicationArg).not.toHaveProperty('reviewedAt');
      expect(applicationArg).not.toHaveProperty('reviewComment');
      expect(result).toMatchObject({
        success: true,
        registrationStatus: 'PENDING_REVIEW',
        applicationId: 9001,
      });
    });

    it('所选公司不存在、已停用或已撤销受管资格：账号零落库，事务回滚', async () => {
      organizationQueryService.findEligibleRegistrationOption.mockResolvedValue(null);

      await expect(usecase.execute(validParams())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE,
      });

      expect(accountService.saveAccount).not.toHaveBeenCalled();
      expect(accountService.saveUserInfo).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(engineerRegistrationService.insertApplication).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
    });

    it('候选查询后公司被撤销受管资格：工程师提交同样拒绝且无申请写入', async () => {
      organizationQueryService.findEligibleRegistrationOption.mockResolvedValue(null);

      await expect(usecase.execute(engineerParams())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE,
      });

      expect(accountService.saveAccount).not.toHaveBeenCalled();
      expect(engineerRegistrationService.insertApplication).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
    });

    it('仅允许客户或工程师注册类型，其他类型在事务前即拒绝', async () => {
      await expect(
        usecase.execute({ ...validParams(), type: 'SUPER_ADMIN' as unknown as RegisterTypeEnum }),
      ).rejects.toMatchObject({ code: ACCOUNT_ERROR.REGISTRATION_FAILED });

      expect(transactionRunner.run).not.toHaveBeenCalled();
    });
  });

  describe('失败原子性：任一步失败不得返回成功或留下半成品', () => {
    it('userInfo 保存失败时异常上抛、事务回滚，不返回注册成功', async () => {
      accountService.saveUserInfo.mockRejectedValue(new Error('user_info insert failed'));

      await expect(usecase.execute(validParams())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.REGISTRATION_FAILED,
      });

      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
      // 失败路径不得出现任何事务外补救写
      expect(accountService.updateAccount).not.toHaveBeenCalled();
    });

    it('工程师缺姓名或电话：事务前拒绝，不发生任何落库写入', async () => {
      await expect(usecase.execute({ ...engineerParams(), realName: '   ' })).rejects.toMatchObject(
        {
          code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
        },
      );
      await expect(usecase.execute({ ...engineerParams(), phone: '' })).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });
      await expect(usecase.execute({ ...engineerParams(), realName: null })).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.saveAccount).not.toHaveBeenCalled();
      expect(accountService.saveUserInfo).not.toHaveBeenCalled();
    });

    it('待审申请写入失败：账号与资料随事务回滚，不返回成功', async () => {
      engineerRegistrationService.insertApplication.mockRejectedValue(
        new Error('application insert failed'),
      );

      await expect(usecase.execute(engineerParams())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.REGISTRATION_FAILED,
      });

      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    });

    it('密码策略失败时同样不发生任何落库写入', async () => {
      passwordPolicyService.validatePassword.mockReturnValue({
        isValid: false,
        errors: ['密码强度不足'],
      });

      await expect(usecase.execute(validParams())).rejects.toBeInstanceOf(DomainError);

      expect(accountService.saveAccount).not.toHaveBeenCalled();
      expect(accountService.saveUserInfo).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
    });
  });

  describe('手填自家公司分支', () => {
    const selfFilledParams = () => ({
      loginName: 'newuser',
      loginEmail: 'newuser@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      nickname: '新用户',
      type: RegisterTypeEnum.CUSTOMER,
      organizationName: '  手填光刻公司  ',
    });

    it('同事务新建公司，客户资料与成员都绑定新公司 ID', async () => {
      const result = await usecase.execute(selfFilledParams());

      expect(result).toMatchObject({ success: true, registrationStatus: 'REGISTERED' });
      expect(organizationQueryService.findEligibleRegistrationOption).not.toHaveBeenCalled();
      expect(organizationService.createSelfRegisteredCompany).toHaveBeenCalledWith({
        name: '手填光刻公司',
        transactionContext: txContext,
      });
      const userInfoArg = accountService.createUserInfoEntity.mock.calls[0][0];
      expect(userInfoArg.userInfoData).toMatchObject({ customerOrganizationId: 7001 });
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledWith(
        {
          organizationId: 7001,
          accountId: ACCOUNT_ID,
          memberRole: IdentityTypeEnum.CUSTOMER,
        },
        txContext,
      );
      expect(committed).toBe(true);
    });

    it('手填公司创建失败：账号零落库且事务回滚', async () => {
      organizationService.createSelfRegisteredCompany.mockRejectedValue(
        new Error('organization insert failed'),
      );

      await expect(usecase.execute(selfFilledParams())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.REGISTRATION_FAILED,
      });

      expect(accountService.saveAccount).not.toHaveBeenCalled();
      expect(accountService.saveUserInfo).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
    });

    it('混传公司 ID 与手填名称：事务前拒绝', async () => {
      await expect(
        usecase.execute({ ...validParams(), organizationName: '手填公司' }),
      ).rejects.toBeInstanceOf(DomainError);

      expect(transactionRunner.run).not.toHaveBeenCalled();
    });

    it('公司 ID 与手填名称皆空：事务前拒绝', async () => {
      await expect(
        usecase.execute({
          ...validParams(),
          organizationId: undefined,
          organizationName: undefined,
        }),
      ).rejects.toBeInstanceOf(DomainError);

      expect(transactionRunner.run).not.toHaveBeenCalled();
    });

    it('工程师注册不允许手填公司：事务前拒绝', async () => {
      const params = selfFilledParams();

      await expect(
        usecase.execute({ ...params, type: RegisterTypeEnum.ENGINEER }),
      ).rejects.toBeInstanceOf(DomainError);

      expect(transactionRunner.run).not.toHaveBeenCalled();
    });
  });

  describe('并发唯一约束冲突', () => {
    it('邮箱唯一索引冲突映射为账号已存在，且事务回滚', async () => {
      accountService.saveAccount.mockRejectedValue({
        code: 'ER_DUP_ENTRY',
        errno: 1062,
        message: "Duplicate entry 'a@b.com' for key 'base_user_account.uk_login_email'",
      });

      await expect(usecase.execute(validParams())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.ACCOUNT_ALREADY_EXISTS,
      });

      expect(accountService.saveUserInfo).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
    });

    it('非账号唯一键冲突仍按通用注册失败处理', async () => {
      accountService.saveAccount.mockRejectedValue({
        code: 'ER_DUP_ENTRY',
        errno: 1062,
        message: "Duplicate entry 'x' for key 'uk_something_else'",
      });

      await expect(usecase.execute(validParams())).rejects.toMatchObject({
        code: ACCOUNT_ERROR.REGISTRATION_FAILED,
      });
    });
  });
});

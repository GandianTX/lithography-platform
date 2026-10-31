// src/usecases/registration/get-engineer-registration-status.usecase.spec.ts
import { AccountStatus, IdentityTypeEnum, UserAccountView } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import {
  AUTH_ERROR,
  ENGINEER_REGISTRATION_ERROR,
  INPUT_NORMALIZE_ERROR,
} from '@core/common/errors/domain-error';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AccountCredentialSnapshot } from '@src/modules/account/account.types';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { GetEngineerRegistrationStatusUsecase } from './get-engineer-registration-status.usecase';

describe('GetEngineerRegistrationStatusUsecase（本人凭据证明与可见范围）', () => {
  const ACCOUNT_ID = 301;
  const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
  const PASSWORD = 'Str0ng!Passw0rd';
  const PASSWORD_HASH = AccountService.hashPasswordWithTimestamp(PASSWORD, CREATED_AT);

  let accountQueryService: {
    findCredentialByLoginName: jest.Mock;
    getUserAccountViewById: jest.Mock;
  };
  let engineerRegistrationQueryService: {
    findLatestByAccountId: jest.Mock;
    listByAccountId: jest.Mock;
  };
  let usecase: GetEngineerRegistrationStatusUsecase;

  const credential = (): AccountCredentialSnapshot => ({
    id: ACCOUNT_ID,
    status: AccountStatus.PENDING,
    loginPassword: PASSWORD_HASH,
    createdAt: CREATED_AT,
  });

  const view = (identityHint: IdentityTypeEnum): UserAccountView =>
    ({ id: ACCOUNT_ID, status: AccountStatus.PENDING, identityHint }) as unknown as UserAccountView;

  const snapshot = (
    status: EngineerRegistrationApplicationStatus,
    id = 1,
  ): EngineerRegistrationApplicationSnapshot => ({
    id,
    accountId: ACCOUNT_ID,
    organizationId: 11,
    status,
    applicationNote: null,
    submittedAt: CREATED_AT,
    reviewedByAccountId: null,
    reviewedAt: null,
    reviewComment: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const offset = (page = 1, pageSize = 10) => ({ mode: 'OFFSET', page, pageSize }) as const;

  beforeEach(() => {
    accountQueryService = {
      findCredentialByLoginName: jest.fn().mockResolvedValue(credential()),
      getUserAccountViewById: jest.fn().mockResolvedValue(view(IdentityTypeEnum.ENGINEER)),
    };
    engineerRegistrationQueryService = {
      findLatestByAccountId: jest
        .fn()
        .mockResolvedValue(snapshot(EngineerRegistrationApplicationStatus.PENDING)),
      listByAccountId: jest.fn().mockImplementation((_accountId, pagination) =>
        Promise.resolve({
          items: [snapshot(EngineerRegistrationApplicationStatus.PENDING)],
          total: 1,
          page: pagination.page,
          pageSize: pagination.pageSize,
        }),
      ),
    };
    usecase = new GetEngineerRegistrationStatusUsecase(
      accountQueryService as unknown as AccountQueryService,
      engineerRegistrationQueryService as unknown as EngineerRegistrationQueryService,
    );
  });

  describe('凭据证明失败统一收敛，不泄露账号是否存在', () => {
    it('账号不存在与密码错误返回同一 CREDENTIAL_MISMATCH', async () => {
      accountQueryService.findCredentialByLoginName.mockResolvedValueOnce(null);
      await expect(
        usecase.execute({ accountIdentifier: 'nobody', password: PASSWORD, pagination: offset() }),
      ).rejects.toMatchObject({ code: ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH });

      accountQueryService.findCredentialByLoginName.mockResolvedValueOnce(credential());
      await expect(
        usecase.execute({ accountIdentifier: 'newuser', password: 'wrong', pagination: offset() }),
      ).rejects.toMatchObject({ code: ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH });

      expect(engineerRegistrationQueryService.findLatestByAccountId).not.toHaveBeenCalled();
    });

    it('空白密码不抛出内部密码错误码，同样收敛为 CREDENTIAL_MISMATCH', async () => {
      await expect(
        usecase.execute({ accountIdentifier: 'newuser', password: '   ', pagination: offset() }),
      ).rejects.toMatchObject({ code: ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH });

      // 内部密码异常码不得外泄
      await expect(
        usecase.execute({ accountIdentifier: 'newuser', password: '   ', pagination: offset() }),
      ).rejects.not.toMatchObject({ code: AUTH_ERROR.INVALID_PASSWORD });
    });

    it('空标识符在输入层即拒绝', async () => {
      await expect(
        usecase.execute({ accountIdentifier: '  ', password: PASSWORD, pagination: offset() }),
      ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY });

      expect(accountQueryService.findCredentialByLoginName).not.toHaveBeenCalled();
    });
  });

  describe('只读与可见范围', () => {
    it('非工程师账号不返回任何申请历史', async () => {
      accountQueryService.getUserAccountViewById.mockResolvedValue(view(IdentityTypeEnum.CUSTOMER));

      await expect(
        usecase.execute({ accountIdentifier: 'newuser', password: PASSWORD, pagination: offset() }),
      ).rejects.toMatchObject({ code: ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND });

      expect(engineerRegistrationQueryService.findLatestByAccountId).not.toHaveBeenCalled();
    });

    it('CURSOR 分页明确拒绝，避免静默改写查询语义', async () => {
      await expect(
        usecase.execute({
          accountIdentifier: 'newuser',
          password: PASSWORD,
          pagination: { mode: 'CURSOR', limit: 10 },
        }),
      ).rejects.toMatchObject({ code: ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS });

      expect(accountQueryService.findCredentialByLoginName).not.toHaveBeenCalled();
    });

    it('成功返回本人最新申请与分页历史，页大小按上限收敛', async () => {
      const result = await usecase.execute({
        accountIdentifier: 'newuser',
        password: PASSWORD,
        pagination: offset(1, 500),
      });

      expect(result.accountId).toBe(ACCOUNT_ID);
      expect(result.latest?.status).toBe(EngineerRegistrationApplicationStatus.PENDING);
      expect(result.applications).toMatchObject({ total: 1, page: 1, pageSize: 100 });
      expect(engineerRegistrationQueryService.listByAccountId).toHaveBeenCalledWith(ACCOUNT_ID, {
        page: 1,
        pageSize: 100,
      });
    });
  });
});

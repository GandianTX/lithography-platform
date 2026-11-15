// src/usecases/registration/get-my-engineer-registration.usecase.spec.ts
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { ENGINEER_REGISTRATION_ERROR, isDomainError } from '@core/common/errors/domain-error';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { GetMyEngineerRegistrationUsecase } from './get-my-engineer-registration.usecase';

describe('GetMyEngineerRegistrationUsecase（受限会话读取本人申请）', () => {
  const ACCOUNT_ID = 401;
  const ORGANIZATION_ID = 21;
  const CREATED_AT = new Date('2026-02-01T00:00:00.000Z');
  const REVIEWED_AT = new Date('2026-02-02T00:00:00.000Z');

  let engineerRegistrationQueryService: { findLatestByAccountId: jest.Mock };
  let organizationQueryService: { findOrganizationNameById: jest.Mock };
  let usecase: GetMyEngineerRegistrationUsecase;

  const session: UsecaseSession = {
    accountId: ACCOUNT_ID,
    roles: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
  };

  const snapshot = (
    overrides: Partial<EngineerRegistrationApplicationSnapshot> = {},
  ): EngineerRegistrationApplicationSnapshot => ({
    id: 77,
    accountId: ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    status: EngineerRegistrationApplicationStatus.REJECTED,
    applicationNote: '从事光刻设备维护 5 年',
    submittedAt: CREATED_AT,
    reviewedByAccountId: 9,
    reviewedAt: REVIEWED_AT,
    reviewComment: '请补充公司授权证明',
    createdAt: CREATED_AT,
    updatedAt: REVIEWED_AT,
    ...overrides,
  });

  beforeEach(() => {
    engineerRegistrationQueryService = {
      findLatestByAccountId: jest.fn().mockResolvedValue(snapshot()),
    };
    organizationQueryService = {
      findOrganizationNameById: jest.fn().mockResolvedValue('示例光刻科技'),
    };
    usecase = new GetMyEngineerRegistrationUsecase(
      engineerRegistrationQueryService as unknown as EngineerRegistrationQueryService,
      organizationQueryService as unknown as OrganizationQueryService,
    );
  });

  it('按 Session 账号读取最新申请并附带目标公司名称', async () => {
    const result = await usecase.execute({ session });

    expect(engineerRegistrationQueryService.findLatestByAccountId).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(organizationQueryService.findOrganizationNameById).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
    });
    expect(result).toEqual({
      applicationId: 77,
      organizationId: ORGANIZATION_ID,
      organizationName: '示例光刻科技',
      status: EngineerRegistrationApplicationStatus.REJECTED,
      applicationNote: '从事光刻设备维护 5 年',
      submittedAt: CREATED_AT,
      reviewedAt: REVIEWED_AT,
      reviewComment: '请补充公司授权证明',
    });
  });

  it('不返回审核管理员账号等他人数据', async () => {
    const result = await usecase.execute({ session });

    expect(result).not.toHaveProperty('accountId');
    expect(result).not.toHaveProperty('reviewedByAccountId');
  });

  it('申请不存在时按 APPLICATION_NOT_FOUND 失败关闭', async () => {
    engineerRegistrationQueryService.findLatestByAccountId.mockResolvedValue(null);

    await expect(usecase.execute({ session })).rejects.toMatchObject({
      code: ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND,
    });
    expect(organizationQueryService.findOrganizationNameById).not.toHaveBeenCalled();
  });

  it('目标公司行缺失时名称为 null，其余事实照常返回', async () => {
    organizationQueryService.findOrganizationNameById.mockResolvedValue(null);

    const result = await usecase.execute({ session });

    expect(result.organizationName).toBeNull();
    expect(result.applicationId).toBe(77);
  });

  it('组织名称直读失败时原样上抛，不伪造公司名', async () => {
    const failure = new Error('db unavailable');
    organizationQueryService.findOrganizationNameById.mockRejectedValue(failure);

    await expect(usecase.execute({ session })).rejects.toBe(failure);
    expect(isDomainError(failure)).toBe(false);
  });
});

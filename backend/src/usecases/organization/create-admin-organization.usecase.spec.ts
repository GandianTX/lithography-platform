// src/usecases/organization/create-admin-organization.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { CreateAdminOrganizationUsecase } from './create-admin-organization.usecase';
import type {
  CompanyProvisioningResult,
  ProvisionCompanyWithAdminCommand,
  ProvisionedAdminSummary,
} from './company-provisioning.types';
import { ProvisionCompanyWithAdminUsecase } from './provision-company-with-admin.usecase';

/**
 * 旧合同入口在 S2 起是**纯委托层**：本 spec 只验证透传与返回形状裁剪，
 * 完整开通/幂等/回滚语义由 `provision-company-with-admin.usecase.spec.ts` 覆盖。
 */
describe('CreateAdminOrganizationUsecase（旧合同委托层）', () => {
  const session: UsecaseSession = {
    accountId: 30,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: null,
  };

  const admin: ProvisionedAdminSummary = {
    accountId: 901,
    loginName: 'orgadmin_abcdef0123456789abcd',
    nickname: '光刻设备（上海）有限公司',
    mustChangePassword: true,
  };

  const provisionResult: CompanyProvisioningResult = {
    organization: {
      id: 501,
      organizationCode: 'ADMIN_ORG_0001',
      name: '光刻设备（上海）有限公司',
      shortName: null,
      contactName: null,
      contactPhone: '021-12345678',
      contactEmail: null,
      address: null,
      remark: null,
      isServiceProvider: false,
      isManagedCompany: true,
      kind: 'CLIENT',
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    admin,
    submission: { submissionId: 77, replayed: false },
    temporaryPassword: 'Aa1!secret',
  };

  let provisionUsecase: {
    execute: jest.Mock<Promise<CompanyProvisioningResult>, [ProvisionCompanyWithAdminCommand]>;
  };
  let usecase: CreateAdminOrganizationUsecase;

  beforeEach(() => {
    provisionUsecase = { execute: jest.fn().mockResolvedValue(provisionResult) };
    usecase = new CreateAdminOrganizationUsecase(
      provisionUsecase as unknown as ProvisionCompanyWithAdminUsecase,
    );
  });

  it('全部输入字段原样透传到开通用例', async () => {
    await usecase.execute({
      session,
      name: '公司',
      contactPhone: '021',
      shortName: '简称',
      contactName: '联系人',
      contactEmail: 'contact@example.com',
      address: '地址',
      remark: '备注',
      status: 'DISABLED',
      isServiceProvider: true,
    });

    expect(provisionUsecase.execute).toHaveBeenCalledTimes(1);
    expect(provisionUsecase.execute.mock.calls[0][0]).toEqual({
      session,
      submissionKey: undefined,
      name: '公司',
      contactPhone: '021',
      shortName: '简称',
      contactName: '联系人',
      contactEmail: 'contact@example.com',
      address: '地址',
      remark: '备注',
      status: 'DISABLED',
      isServiceProvider: true,
    });
  });

  it('旧合同不传提交标识时保持 undefined，走无幂等路径', async () => {
    await usecase.execute({ session, name: '公司', contactPhone: '021' });

    const command = provisionUsecase.execute.mock.calls[0][0];
    expect(command.submissionKey).toBeUndefined();
    expect('submissionKey' in command).toBe(true);
  });

  it('调用方显式提供提交标识时原样透传（不在此层归一化）', async () => {
    const submissionKey = ' 3F2504E0-4F89-11D3-9A0C-0305E82C3301 ';

    await usecase.execute({ session, name: '公司', contactPhone: '021', submissionKey });

    expect(provisionUsecase.execute.mock.calls[0][0].submissionKey).toBe(submissionKey);
  });

  it('只返回公司与管理员摘要，丢弃提交标识结果与一次性临时密码', async () => {
    const result = await usecase.execute({ session, name: '公司', contactPhone: '021' });

    expect(result).toEqual({
      organization: provisionResult.organization,
      admin,
    });
    expect('temporaryPassword' in result).toBe(false);
    expect('submission' in result).toBe(false);
  });
});

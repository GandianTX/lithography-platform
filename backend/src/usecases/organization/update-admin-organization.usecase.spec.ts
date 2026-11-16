// src/usecases/organization/update-admin-organization.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { ORGANIZATION_MANAGEMENT_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { PinoLogger } from 'nestjs-pino';
import { OrganizationService } from '@src/modules/lithography/organization.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import { UpdateAdminOrganizationUsecase } from './update-admin-organization.usecase';

describe('UpdateAdminOrganizationUsecase（一级编辑公司档案）', () => {
  const lockedView: AdminOrganizationView = {
    id: 7,
    organizationCode: 'ADMIN_ORG_0001',
    name: '旧全称',
    shortName: '旧简称',
    contactName: null,
    contactPhone: '021-1',
    contactEmail: null,
    address: null,
    remark: null,
    isServiceProvider: false,
    isManagedCompany: true,
    kind: 'CLIENT',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  let organizationService: { updateManagedCompany: jest.Mock };
  let organizationQueryService: {
    lockAdminOrganizationForUpdate: jest.Mock;
    findAdminOrganizationView: jest.Mock;
  };
  let logger: { setContext: jest.Mock; info: jest.Mock; error: jest.Mock };
  let transactionRunner: { run: jest.Mock };
  let usecase: UpdateAdminOrganizationUsecase;

  const levelOneSession: UsecaseSession = {
    accountId: 30,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: null,
  };

  beforeEach(() => {
    organizationService = { updateManagedCompany: jest.fn().mockResolvedValue(undefined) };
    organizationQueryService = {
      lockAdminOrganizationForUpdate: jest.fn().mockResolvedValue(lockedView),
      findAdminOrganizationView: jest.fn().mockResolvedValue({
        ...lockedView,
        name: '新全称',
        shortName: null,
        status: 'DISABLED',
        isServiceProvider: true,
      }),
    };
    logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() };
    transactionRunner = {
      run: jest.fn(async (callback: (tx: PersistenceTransactionContext) => Promise<unknown>) =>
        callback({} as PersistenceTransactionContext),
      ),
    };
    usecase = new UpdateAdminOrganizationUsecase(
      organizationService as unknown as OrganizationService,
      organizationQueryService as unknown as OrganizationQueryService,
      logger as unknown as PinoLogger,
      transactionRunner as never,
    );
  });

  it('事务内先锁目标，再按白名单补丁写入并回读返回真实视图', async () => {
    const result = await usecase.execute({
      session: levelOneSession,
      organizationId: 7,
      name: ' 新全称 ',
      shortName: null,
      status: 'DISABLED',
      isServiceProvider: true,
    });

    expect(organizationQueryService.lockAdminOrganizationForUpdate).toHaveBeenCalledWith({
      organizationId: 7,
      transactionContext: expect.anything(),
    });
    expect(organizationService.updateManagedCompany).toHaveBeenCalledWith({
      organizationId: 7,
      patch: { name: '新全称', shortName: null, status: 'DISABLED', isServiceProvider: true },
      updatedAt: expect.any(Date),
      transactionContext: expect.anything(),
    });
    expect(result).toMatchObject({ name: '新全称', status: 'DISABLED', isServiceProvider: true });
  });

  it('未传字段不进入补丁，未传字段的现有值保持不变', async () => {
    organizationQueryService.findAdminOrganizationView.mockResolvedValue({
      ...lockedView,
      address: '上海市',
    });

    await usecase.execute({
      session: levelOneSession,
      organizationId: 7,
      address: '上海市',
    });

    expect(organizationService.updateManagedCompany).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { address: '上海市' } }),
    );
    // 补丁中只有 address：编号、受管归类、类别不会被任何输入写入
    const call = organizationService.updateManagedCompany.mock.calls[0][0] as {
      patch: Record<string, unknown>;
    };
    expect(Object.keys(call.patch)).toEqual(['address']);
  });

  it('目标不存在（锁读为空）返回 TARGET_NOT_FOUND 且不执行写入', async () => {
    organizationQueryService.lockAdminOrganizationForUpdate.mockResolvedValue(null);

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: 404, name: '新全称' }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.TARGET_NOT_FOUND });

    expect(organizationService.updateManagedCompany).not.toHaveBeenCalled();
  });

  it('回读与补丁不一致时按写入失败关闭，不返回假成功', async () => {
    organizationQueryService.findAdminOrganizationView.mockResolvedValue({ ...lockedView });

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: 7, name: '新全称' }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED });
  });

  it('唯一索引冲突映射为 CODE_CONFLICT', async () => {
    organizationService.updateManagedCompany.mockRejectedValue({ errno: 1062 });

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: 7, name: '新全称' }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.CODE_CONFLICT });
  });

  it('二级管理员拒绝，且不开事务、不锁目标', async () => {
    await expect(
      usecase.execute({
        session: {
          accountId: 31,
          roles: [IdentityTypeEnum.SUPER_ADMIN],
          activeRole: IdentityTypeEnum.SUPER_ADMIN,
          adminLevel: 2,
          adminOrganizationId: 7,
        },
        organizationId: 7,
        name: '新全称',
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(organizationQueryService.lockAdminOrganizationForUpdate).not.toHaveBeenCalled();
  });
});

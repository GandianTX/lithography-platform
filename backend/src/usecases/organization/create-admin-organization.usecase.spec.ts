// src/usecases/organization/create-admin-organization.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_MANAGEMENT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { PinoLogger } from 'nestjs-pino';
import { OrganizationService } from '@src/modules/lithography/organization.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import { CreateAdminOrganizationUsecase } from './create-admin-organization.usecase';

describe('CreateAdminOrganizationUsecase（一级新增公司档案）', () => {
  const createdView: AdminOrganizationView = {
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
  };

  let organizationService: { createManagedCompany: jest.Mock };
  let organizationQueryService: { findAdminOrganizationView: jest.Mock };
  let logger: { setContext: jest.Mock; info: jest.Mock; error: jest.Mock };
  let transactionRunner: { run: jest.Mock };
  let usecase: CreateAdminOrganizationUsecase;

  const levelOneSession: UsecaseSession = {
    accountId: 30,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: null,
  };

  beforeEach(() => {
    organizationService = {
      createManagedCompany: jest
        .fn()
        .mockResolvedValue({ id: 501, organizationCode: 'ADMIN_ORG_0001' }),
    };
    organizationQueryService = {
      findAdminOrganizationView: jest.fn().mockResolvedValue(createdView),
    };
    logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() };
    transactionRunner = {
      run: jest.fn(async (callback: (tx: PersistenceTransactionContext) => Promise<unknown>) =>
        callback({} as PersistenceTransactionContext),
      ),
    };
    usecase = new CreateAdminOrganizationUsecase(
      organizationService as unknown as OrganizationService,
      organizationQueryService as unknown as OrganizationQueryService,
      logger as unknown as PinoLogger,
      transactionRunner,
    );
  });

  it('一级管理员新增：归一整填入参，事务内创建后回读返回真实落库视图', async () => {
    const result = await usecase.execute({
      session: levelOneSession,
      name: '  光刻设备（上海）有限公司 ',
      contactPhone: ' 021-12345678 ',
    });

    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
    expect(organizationService.createManagedCompany).toHaveBeenCalledWith(
      {
        name: '光刻设备（上海）有限公司',
        contactPhone: '021-12345678',
        shortName: null,
        contactName: null,
        contactEmail: null,
        address: null,
        remark: null,
        status: 'ACTIVE',
        isServiceProvider: false,
      },
      expect.anything(),
    );
    expect(organizationQueryService.findAdminOrganizationView).toHaveBeenCalledWith({
      organizationId: 501,
      transactionContext: expect.anything(),
    });
    expect(result).toEqual(createdView);
  });

  it('显式停用状态与维修资格一起透传到存储层，一次写入落定', async () => {
    await usecase.execute({
      session: levelOneSession,
      name: ' 停用公司 ',
      contactPhone: '021',
      status: 'DISABLED',
      isServiceProvider: true,
    });

    expect(organizationService.createManagedCompany).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DISABLED', isServiceProvider: true }),
      expect.anything(),
    );
  });

  it('创建后回读失败按写入失败关闭，不返回假成功', async () => {
    organizationQueryService.findAdminOrganizationView.mockResolvedValue(null);

    await expect(
      usecase.execute({ session: levelOneSession, name: '公司', contactPhone: '021' }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED });

    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
  });

  it('编号唯一索引冲突映射为 CODE_CONFLICT', async () => {
    organizationService.createManagedCompany.mockRejectedValue({ code: 'ER_DUP_ENTRY' });

    await expect(
      usecase.execute({ session: levelOneSession, name: '公司', contactPhone: '021' }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.CODE_CONFLICT });
  });

  it('其他数据库异常收敛为 WRITE_FAILED 且不泄露原始错误', async () => {
    organizationService.createManagedCompany.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      usecase.execute({ session: levelOneSession, name: '公司', contactPhone: '021' }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED });
  });

  it('二级管理员与非管理员拒绝，且不开启事务', async () => {
    const rejectedSessions: UsecaseSession[] = [
      { accountId: 1, roles: [IdentityTypeEnum.CUSTOMER], activeRole: IdentityTypeEnum.CUSTOMER },
      {
        accountId: 31,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
        activeRole: IdentityTypeEnum.SUPER_ADMIN,
        adminLevel: 2,
        adminOrganizationId: 27,
      },
    ];

    for (const session of rejectedSessions) {
      await expect(
        usecase.execute({ session, name: '公司', contactPhone: '021' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    }

    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('全称或联系电话 trim 后为空时在事务前拒绝', async () => {
    await expect(
      usecase.execute({ session: levelOneSession, name: '   ', contactPhone: '021' }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY });

    expect(transactionRunner.run).not.toHaveBeenCalled();
  });
});

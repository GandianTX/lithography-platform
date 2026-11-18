// src/modules/lithography/admin-organization-provisioning.service.spec.ts

import { DomainError } from '@core/common/errors/domain-error';
import type { InsertResult, Repository, UpdateResult } from 'typeorm';
import { AdminOrganizationProvisioningRequestEntity } from './entities/admin-organization-provisioning-request.entity';
import {
  AdminOrganizationProvisioningService,
  DuplicateProvisioningRequestError,
} from './admin-organization-provisioning.service';

type RepositoryMock = {
  insert: jest.Mock;
  update: jest.Mock;
  findOne: jest.Mock;
};

function asRepository(
  mock: RepositoryMock,
): Repository<AdminOrganizationProvisioningRequestEntity> {
  return mock as unknown as Repository<AdminOrganizationProvisioningRequestEntity>;
}

function duplicateError(keyName: string): Error {
  return Object.assign(new Error(`ER_DUP_ENTRY: Duplicate entry 'x' for key '${keyName}'`), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
  });
}

describe('AdminOrganizationProvisioningService（提交标识读写）', () => {
  const baseParams = {
    purpose: 'ADMIN_CREATE_ORGANIZATION',
    submissionKey: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    actorAccountId: 42,
    inputFingerprint: 'a'.repeat(64),
  };

  it('reserve 以 PENDING 状态写入并返回提交行主键', async () => {
    const repository: RepositoryMock = {
      insert: jest.fn(() =>
        Promise.resolve({ identifiers: [{ id: 11 }] } as unknown as InsertResult),
      ),
      update: jest.fn(),
      findOne: jest.fn(),
    };
    const service = new AdminOrganizationProvisioningService(asRepository(repository));

    await expect(service.reserve(baseParams)).resolves.toBe(11);
    expect(repository.insert).toHaveBeenCalledWith({
      purpose: baseParams.purpose,
      submissionKey: baseParams.submissionKey,
      actorAccountId: baseParams.actorAccountId,
      inputFingerprint: baseParams.inputFingerprint,
      state: 'PENDING',
    });
  });

  it('reserve 命中提交标识唯一键时抛 DuplicateProvisioningRequestError', async () => {
    for (const keyName of [
      'uk_provisioning_purpose_actor_key',
      'admin_organization_provisioning_request.uk_provisioning_purpose_actor_key',
    ]) {
      const repository: RepositoryMock = {
        insert: jest.fn(() => Promise.reject(duplicateError(keyName))),
        update: jest.fn(),
        findOne: jest.fn(),
      };
      const service = new AdminOrganizationProvisioningService(asRepository(repository));

      await expect(service.reserve(baseParams)).rejects.toBeInstanceOf(
        DuplicateProvisioningRequestError,
      );
    }
  });

  it('reserve 命中其他唯一键时收敛为 WRITE_FAILED', async () => {
    const repository: RepositoryMock = {
      insert: jest.fn(() => Promise.reject(duplicateError('uk_login_name'))),
      update: jest.fn(),
      findOne: jest.fn(),
    };
    const service = new AdminOrganizationProvisioningService(asRepository(repository));

    await expect(service.reserve(baseParams)).rejects.toMatchObject({
      name: 'DomainError',
    });
    await expect(service.reserve(baseParams)).rejects.toBeInstanceOf(DomainError);
  });

  it('reserve 非重复键异常原样上抛', async () => {
    const failure = new Error('connection lost');
    const repository: RepositoryMock = {
      insert: jest.fn(() => Promise.reject(failure)),
      update: jest.fn(),
      findOne: jest.fn(),
    };
    const service = new AdminOrganizationProvisioningService(asRepository(repository));

    await expect(service.reserve(baseParams)).rejects.toBe(failure);
  });

  it('reserve 未拿到主键时收敛为 WRITE_FAILED', async () => {
    const repository: RepositoryMock = {
      insert: jest.fn(() => Promise.resolve({ identifiers: [{}] } as unknown as InsertResult)),
      update: jest.fn(),
      findOne: jest.fn(),
    };
    const service = new AdminOrganizationProvisioningService(asRepository(repository));

    await expect(service.reserve(baseParams)).rejects.toBeInstanceOf(DomainError);
  });

  it('complete 写入公司与账号引用并置 COMPLETED', async () => {
    const repository: RepositoryMock = {
      insert: jest.fn(),
      update: jest.fn(() => Promise.resolve({ affected: 1 } as unknown as UpdateResult)),
      findOne: jest.fn(),
    };
    const service = new AdminOrganizationProvisioningService(asRepository(repository));

    await service.complete({ requestId: 11, organizationId: 5, adminAccountId: 6 });

    expect(repository.update).toHaveBeenCalledWith(
      { id: 11 },
      expect.objectContaining({
        organizationId: 5,
        adminAccountId: 6,
        state: 'COMPLETED',
      }),
    );
  });

  it('complete 未命中目标行时收敛为 WRITE_FAILED', async () => {
    const repository: RepositoryMock = {
      insert: jest.fn(),
      update: jest.fn(() => Promise.resolve({ affected: 0 } as unknown as UpdateResult)),
      findOne: jest.fn(),
    };
    const service = new AdminOrganizationProvisioningService(asRepository(repository));

    await expect(
      service.complete({ requestId: 11, organizationId: 5, adminAccountId: 6 }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('findByKey 返回窄事实', async () => {
    const repository: RepositoryMock = {
      insert: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn(() =>
        Promise.resolve({
          id: 11,
          inputFingerprint: 'b'.repeat(64),
          state: 'COMPLETED',
          organizationId: 5,
          adminAccountId: 6,
        } as AdminOrganizationProvisioningRequestEntity),
      ),
    };
    const service = new AdminOrganizationProvisioningService(asRepository(repository));

    await expect(service.findByKey(baseParams)).resolves.toEqual({
      id: 11,
      inputFingerprint: 'b'.repeat(64),
      state: 'COMPLETED',
      organizationId: 5,
      adminAccountId: 6,
    });
    expect(repository.findOne).toHaveBeenCalledWith({
      where: {
        purpose: baseParams.purpose,
        submissionKey: baseParams.submissionKey,
        actorAccountId: baseParams.actorAccountId,
      },
    });
  });

  it('findByKey 缺失时返回 null', async () => {
    const repository: RepositoryMock = {
      insert: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn(() => Promise.resolve(null)),
    };
    const service = new AdminOrganizationProvisioningService(asRepository(repository));

    await expect(service.findByKey(baseParams)).resolves.toBeNull();
  });
});

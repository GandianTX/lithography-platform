// src/modules/lithography/organization.service.spec.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import type { EntityManager, Repository } from 'typeorm';

import { OrganizationEntity } from './entities/organization.entity';
import { OrganizationService } from './organization.service';

type RepositoryMock = {
  create: jest.Mock;
  save: jest.Mock;
};

function createRepositoryMock(nextId: number): RepositoryMock {
  return {
    create: jest.fn((input: Partial<OrganizationEntity>) => input),
    save: jest.fn((entity: Partial<OrganizationEntity>) =>
      Promise.resolve({ ...entity, id: nextId }),
    ),
  };
}

function asRepository(mock: RepositoryMock): Repository<OrganizationEntity> {
  return mock as unknown as Repository<OrganizationEntity>;
}

describe('OrganizationService.createSelfRegisteredCompany（客户手填公司写路径）', () => {
  it('默认仓库写入启用、未受管、无维修服务资格的公司档', async () => {
    const repository = createRepositoryMock(7001);
    const service = new OrganizationService(asRepository(repository));

    await expect(service.createSelfRegisteredCompany({ name: '客户手填公司' })).resolves.toEqual({
      id: 7001,
    });

    expect(repository.create).toHaveBeenCalledTimes(1);
    const created = repository.create.mock.calls[0][0] as Partial<OrganizationEntity>;
    expect(created).toMatchObject({
      name: '客户手填公司',
      kind: 'CLIENT',
      status: 'ACTIVE',
      isManagedCompany: false,
      isServiceProvider: false,
    });
    // 组织编码与名称解耦：同名公司不会撞唯一索引，也不会被隐式合并
    expect(created.organizationCode).toMatch(/^SELF_REG_[0-9a-f-]{36}$/);
    expect(repository.save).toHaveBeenCalledWith(created);
  });

  it('同名公司两次创建使用各自独立的组织编码，不做合并', async () => {
    const repository = createRepositoryMock(7001);
    const service = new OrganizationService(asRepository(repository));

    await service.createSelfRegisteredCompany({ name: '同名公司' });
    await service.createSelfRegisteredCompany({ name: '同名公司' });

    const [first, second] = repository.create.mock.calls.map(
      ([input]) => input as Partial<OrganizationEntity>,
    );
    expect(first.organizationCode).not.toBe(second.organizationCode);
  });

  it('传入事务上下文时沿同一事务仓库写入，不触碰注入的默认仓库', async () => {
    const defaultRepository = createRepositoryMock(7001);
    const transactionalRepository = createRepositoryMock(7002);
    const manager = {
      getRepository: jest.fn().mockReturnValue(transactionalRepository),
    } as unknown as EntityManager;
    const transactionContext: PersistenceTransactionContext =
      createTypeOrmPersistenceTransactionContext(manager);
    const service = new OrganizationService(asRepository(defaultRepository));

    await expect(
      service.createSelfRegisteredCompany({ name: '事务内公司', transactionContext }),
    ).resolves.toEqual({ id: 7002 });

    expect(manager.getRepository).toHaveBeenCalledWith(OrganizationEntity);
    expect(transactionalRepository.save).toHaveBeenCalledTimes(1);
    expect(defaultRepository.create).not.toHaveBeenCalled();
    expect(defaultRepository.save).not.toHaveBeenCalled();
  });
});

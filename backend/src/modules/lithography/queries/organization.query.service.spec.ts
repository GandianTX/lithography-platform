// src/modules/lithography/queries/organization.query.service.spec.ts
import type { EntityManager, Repository } from 'typeorm';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { OrganizationEntity } from '../entities/organization.entity';
import { OrganizationQueryService } from './organization.query.service';

type QueryBuilderMock = {
  select: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  getManyAndCount: jest.Mock;
};

describe('OrganizationQueryService（注册公司资格与检索）', () => {
  let queryBuilder: QueryBuilderMock;
  let repository: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
  let service: OrganizationQueryService;

  beforeEach(() => {
    queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[{ id: 2, name: '受管公司B' }], 1]),
    };
    repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      findOne: jest.fn(),
    };
    service = new OrganizationQueryService(repository as unknown as Repository<OrganizationEntity>);
  });

  describe('searchEligibleRegistrationOptions', () => {
    it('资格固定为 ACTIVE 且属于一级维护名单，只选主键与名称并稳定排序', async () => {
      const page = await service.searchEligibleRegistrationOptions({
        pagination: { page: 1, pageSize: 20 },
      });

      expect(page).toEqual({
        items: [{ id: 2, name: '受管公司B' }],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      expect(queryBuilder.select).toHaveBeenCalledWith(['organization.id', 'organization.name']);
      expect(queryBuilder.where).toHaveBeenCalledWith('organization.status = :status', {
        status: 'ACTIVE',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'organization.is_managed_company = :isManagedCompany',
        { isManagedCompany: true },
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('organization.name', 'ASC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('organization.id', 'ASC');
      expect(queryBuilder.skip).toHaveBeenCalledWith(0);
      expect(queryBuilder.take).toHaveBeenCalledWith(20);
    });

    it('关键字走参数化 LIKE，通配符按普通字符转义', async () => {
      await service.searchEligibleRegistrationOptions({
        keyword: ' A%_\\B ',
        pagination: { page: 1, pageSize: 10 },
      });

      expect(queryBuilder.andWhere).toHaveBeenLastCalledWith('organization.name LIKE :keyword', {
        keyword: '%A\\%\\_\\\\B%',
      });
    });

    it('空白关键字不追加名称过滤', async () => {
      await service.searchEligibleRegistrationOptions({
        keyword: '   ',
        pagination: { page: 1, pageSize: 10 },
      });

      expect(queryBuilder.andWhere).toHaveBeenCalledTimes(1);
    });

    it('页码与页大小归一并限制单页上限', async () => {
      await service.searchEligibleRegistrationOptions({
        pagination: { page: 0, pageSize: 500 },
      });

      expect(queryBuilder.skip).toHaveBeenCalledWith(0);
      expect(queryBuilder.take).toHaveBeenCalledWith(50);
    });
  });

  describe('findEligibleRegistrationOption', () => {
    it('按主键 + ACTIVE + 受管资格复核，存在时只返回主键与名称', async () => {
      repository.findOne.mockResolvedValue({ id: 7, name: '受管公司' });

      const result = await service.findEligibleRegistrationOption({ organizationId: 7 });

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 7, status: 'ACTIVE', isManagedCompany: true },
        select: { id: true, name: true },
      });
      expect(result).toEqual({ id: 7, name: '受管公司' });
    });

    it('停用或撤销受管资格时返回 null', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.findEligibleRegistrationOption({ organizationId: 7 }),
      ).resolves.toBeNull();
    });

    it('事务内写前复核加共享行锁，阻止复核后并发停用或撤销受管资格', async () => {
      repository.findOne.mockResolvedValue({ id: 7, name: '受管公司' });
      const transactionContext = createTypeOrmPersistenceTransactionContext({
        getRepository: () => repository,
      } as unknown as EntityManager);

      await service.findEligibleRegistrationOption({ organizationId: 7, transactionContext });

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 7, status: 'ACTIVE', isManagedCompany: true },
        select: { id: true, name: true },
        lock: { mode: 'pessimistic_read' },
      });
    });
  });

  describe('findActiveRegistrationOption（旧入口口径）', () => {
    it('仅按主键与 ACTIVE 复核，不要求受管资格', async () => {
      repository.findOne.mockResolvedValue({ id: 9, name: '普通公司' });

      await service.findActiveRegistrationOption({ organizationId: 9 });

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 9, status: 'ACTIVE' },
        select: { id: true, name: true },
      });
    });
  });
});

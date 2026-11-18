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
  getCount: jest.Mock;
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
      getCount: jest.fn().mockResolvedValue(0),
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

  describe('existsEligibleRegistrationOptionByName', () => {
    it('资格固定为 ACTIVE 且受管，名称先合并空白再 TRIM 后小写整体相等，不使用 LIKE', async () => {
      queryBuilder.getCount.mockResolvedValue(1);

      const exists = await service.existsEligibleRegistrationOptionByName({
        normalizedName: '光刻 公司',
      });

      expect(exists).toBe(true);
      expect(queryBuilder.where).toHaveBeenCalledWith('organization.status = :status', {
        status: 'ACTIVE',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'organization.is_managed_company = :isManagedCompany',
        { isManagedCompany: true },
      );
      expect(queryBuilder.andWhere).toHaveBeenLastCalledWith(
        expect.stringContaining('LOWER(TRIM(REGEXP_REPLACE(organization.name'),
        { normalizedName: '光刻 公司' },
      );
      const nameCondition = queryBuilder.andWhere.mock.calls.at(-1)?.[0] as string;
      // 归一顺序：REGEXP_REPLACE 必须最贴近列名（先合并空白），TRIM 套在其外层，否则首尾 tab / 换行漏命中
      expect(nameCondition).toMatch(/LOWER\(TRIM\(REGEXP_REPLACE\(organization\.name/);
      // 列名只出现一次，排除「先 TRIM 再 REGEXP_REPLACE」的并列写法
      expect(nameCondition.match(/organization\.name/g)).toHaveLength(1);
      // 两侧显式重音敏感排序规则
      expect(nameCondition.match(/utf8mb4_0900_as_cs/g)).toHaveLength(2);
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('LIKE'),
        expect.anything(),
      );
      expect(queryBuilder.skip).not.toHaveBeenCalled();
      expect(queryBuilder.take).not.toHaveBeenCalled();
    });

    it('未命中时返回 false', async () => {
      queryBuilder.getCount.mockResolvedValue(0);

      await expect(
        service.existsEligibleRegistrationOptionByName({ normalizedName: '不存在公司' }),
      ).resolves.toBe(false);
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

  describe('findActiveOrganizationForWrite（写前复核）', () => {
    it('仅按主键与 ACTIVE 复核，不要求受管资格（补录后的未受管公司同样有效）', async () => {
      repository.findOne.mockResolvedValue({ id: 9, name: '未受管客户公司' });

      const result = await service.findActiveOrganizationForWrite({ organizationId: 9 });

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 9, status: 'ACTIVE' },
        select: { id: true, name: true },
      });
      expect(result).toEqual({ id: 9, name: '未受管客户公司' });
    });

    it('停用时返回 null（写流程失败关闭）', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.findActiveOrganizationForWrite({ organizationId: 9 }),
      ).resolves.toBeNull();
    });

    it('事务内按当前读加共享行锁，与并发停用写入串行', async () => {
      repository.findOne.mockResolvedValue({ id: 9, name: '未受管客户公司' });
      const transactionContext = createTypeOrmPersistenceTransactionContext({
        getRepository: () => repository,
      } as unknown as EntityManager);

      await service.findActiveOrganizationForWrite({ organizationId: 9, transactionContext });

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 9, status: 'ACTIVE' },
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

describe('OrganizationQueryService（管理员公司档案完整视图）', () => {
  const entityRow = {
    id: 7,
    organizationCode: 'ADMIN_ORG_0001',
    name: '光刻设备（上海）有限公司',
    shortName: '光刻设备',
    contactName: '张三',
    contactPhone: '021-12345678',
    contactEmail: 'ops@example.com',
    address: '上海市',
    remark: null,
    isServiceProvider: true,
    isManagedCompany: true,
    kind: 'CLIENT',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

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
      getManyAndCount: jest.fn().mockResolvedValue([[entityRow], 1]),
      getCount: jest.fn(),
    };
    repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      findOne: jest.fn(),
    };
    service = new OrganizationQueryService(repository as unknown as Repository<OrganizationEntity>);
  });

  describe('searchAdminOrganizations', () => {
    it('关键字同时匹配全称/编号/简称，并稳定排序与分页', async () => {
      const page = await service.searchAdminOrganizations({
        keyword: '光刻',
        pagination: { page: 2, pageSize: 10 },
      });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '(organization.name LIKE :keyword OR organization.organizationCode LIKE :keyword OR organization.shortName LIKE :keyword)',
        { keyword: '%光刻%' },
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('organization.name', 'ASC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('organization.id', 'ASC');
      expect(queryBuilder.skip).toHaveBeenCalledWith(10);
      expect(queryBuilder.take).toHaveBeenCalledWith(10);
      expect(page.total).toBe(1);
      // 完整视图字段直通，不做业务加工
      expect(page.items[0]).toMatchObject({
        id: 7,
        organizationCode: 'ADMIN_ORG_0001',
        isManagedCompany: true,
        isServiceProvider: true,
        kind: 'CLIENT',
        status: 'ACTIVE',
      });
    });

    it('状态、受管与维修资格分别过滤；未提供则不加条件', async () => {
      await service.searchAdminOrganizations({
        status: 'DISABLED',
        isManagedCompany: true,
        isServiceProvider: false,
        pagination: { page: 1, pageSize: 20 },
      });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('organization.status = :status', {
        status: 'DISABLED',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'organization.isManagedCompany = :isManagedCompany',
        { isManagedCompany: true },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'organization.isServiceProvider = :isServiceProvider',
        { isServiceProvider: false },
      );

      queryBuilder.andWhere.mockClear();
      await service.searchAdminOrganizations({ pagination: { page: 1, pageSize: 20 } });
      expect(queryBuilder.andWhere).not.toHaveBeenCalled();
    });

    it('页大小按上限 50 截断，页码下限归一', async () => {
      await service.searchAdminOrganizations({ pagination: { page: 0, pageSize: 500 } });

      expect(queryBuilder.skip).toHaveBeenCalledWith(0);
      expect(queryBuilder.take).toHaveBeenCalledWith(50);
    });

    it('关键字中的 LIKE 通配符按普通字符转义', async () => {
      await service.searchAdminOrganizations({
        keyword: '100%_公司',
        pagination: { page: 1, pageSize: 20 },
      });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(expect.stringContaining('LIKE :keyword'), {
        keyword: '%100\\%\\_公司%',
      });
    });
  });

  describe('findAdminOrganizationView', () => {
    it('按主键读取完整视图，不过滤状态', async () => {
      repository.findOne.mockResolvedValue({ ...entityRow, status: 'DISABLED' });

      const view = await service.findAdminOrganizationView({ organizationId: 7 });

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 7 } });
      expect(view).toMatchObject({ id: 7, status: 'DISABLED' });
    });

    it('不存在返回 null', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findAdminOrganizationView({ organizationId: 404 })).resolves.toBeNull();
    });
  });

  describe('lockAdminOrganizationForUpdate', () => {
    it('事务内以悲观写锁读取目标行', async () => {
      repository.findOne.mockResolvedValue(entityRow);
      const transactionContext = createTypeOrmPersistenceTransactionContext({
        getRepository: () => repository,
      } as unknown as EntityManager);

      const view = await service.lockAdminOrganizationForUpdate({
        organizationId: 7,
        transactionContext,
      });

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 7 },
        lock: { mode: 'pessimistic_write' },
      });
      expect(view).toMatchObject({ id: 7 });
    });
  });
});

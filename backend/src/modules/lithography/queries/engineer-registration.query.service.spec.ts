// src/modules/lithography/queries/engineer-registration.query.service.spec.ts

import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { EngineerRegistrationQueryService } from './engineer-registration.query.service';

const makeRepo = () => ({
  findOne: jest.fn(),
  findAndCount: jest.fn(),
});

const applicationRow = {
  id: 916001,
  accountId: 900301,
  organizationId: 910001,
  status: 'PENDING',
  applicationNote: '申请加入组织',
  submittedAt: new Date('2026-10-29T08:00:00.000Z'),
  reviewedByAccountId: null,
  reviewedAt: null,
  reviewComment: null,
  pendingAccountId: 900301,
  createdAt: new Date('2026-10-29T08:00:01.000Z'),
  updatedAt: new Date('2026-10-29T08:00:01.000Z'),
};

describe('EngineerRegistrationQueryService', () => {
  it('本人申请历史按提交时间倒序分页，并把总数与会话内的记录一起返回', async () => {
    const repo = makeRepo();
    repo.findAndCount.mockResolvedValue([[applicationRow], 3]);
    const service = new EngineerRegistrationQueryService(repo as never);

    const page = await service.listByAccountId(900301, { page: 2, pageSize: 1 });

    expect(repo.findAndCount).toHaveBeenCalledWith({
      where: { accountId: 900301 },
      order: { submittedAt: 'DESC', id: 'DESC' },
      skip: 1,
      take: 1,
    });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: 916001, accountId: 900301 });
  });

  it('非法页码/页大小按 1 归一，避免负 skip 与零页大小', async () => {
    const repo = makeRepo();
    repo.findAndCount.mockResolvedValue([[applicationRow], 1]);
    const service = new EngineerRegistrationQueryService(repo as never);

    const page = await service.listByAccountId(900301, { page: 0, pageSize: -5 });

    expect(repo.findAndCount).toHaveBeenCalledWith({
      where: { accountId: 900301 },
      order: { submittedAt: 'DESC', id: 'DESC' },
      skip: 0,
      take: 1,
    });
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(1);
  });

  it('最新申请按主键倒序读取，用于判断是否存在可重提的拒绝记录', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ ...applicationRow, status: 'REJECTED' });
    const service = new EngineerRegistrationQueryService(repo as never);

    const latest = await service.findLatestByAccountId(900301);

    expect(repo.findOne).toHaveBeenCalledWith({
      where: { accountId: 900301 },
      order: { id: 'DESC' },
    });
    expect(latest).toMatchObject({ id: 916001, status: 'REJECTED' });
  });

  it('最新申请不存在时返回 null，不以空对象冒充记录', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const service = new EngineerRegistrationQueryService(repo as never);

    expect(await service.findLatestByAccountId(900301)).toBeNull();
  });

  it('组织审核队列限定组织并按提交时间正序分页，状态缺省表示不筛选', async () => {
    const repo = makeRepo();
    repo.findAndCount.mockResolvedValue([[applicationRow], 2]);
    const service = new EngineerRegistrationQueryService(repo as never);

    const page = await service.listByOrganization({
      organizationId: 910001,
      pagination: { page: 1, pageSize: 10 },
    });

    expect(repo.findAndCount).toHaveBeenCalledWith({
      where: { organizationId: 910001 },
      order: { submittedAt: 'ASC', id: 'ASC' },
      skip: 0,
      take: 10,
    });
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ id: 916001, organizationId: 910001 });
  });

  it('组织审核队列带状态筛选时把状态条件下推到数据库', async () => {
    const repo = makeRepo();
    repo.findAndCount.mockResolvedValue([[], 0]);
    const service = new EngineerRegistrationQueryService(repo as never);

    await service.listByOrganization({
      organizationId: 910001,
      status: EngineerRegistrationApplicationStatus.PENDING,
      pagination: { page: 1, pageSize: 10 },
    });

    expect(repo.findAndCount).toHaveBeenCalledWith({
      where: { organizationId: 910001, status: 'PENDING' },
      order: { submittedAt: 'ASC', id: 'ASC' },
      skip: 0,
      take: 10,
    });
  });
});

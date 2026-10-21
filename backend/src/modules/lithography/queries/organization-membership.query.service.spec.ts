// src/modules/lithography/queries/organization-membership.query.service.spec.ts

import { OrganizationEntity } from '../entities/organization.entity';
import { OrganizationMembershipEntity } from '../entities/organization-membership.entity';
import { OrganizationMembershipQueryService } from './organization-membership.query.service';

const makeMembershipRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
});

const makeOrganizationRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
});

const membershipEntity = (
  overrides: Partial<OrganizationMembershipEntity> = {},
): OrganizationMembershipEntity =>
  ({
    id: 915001,
    organizationId: 910001,
    accountId: 900101,
    memberRole: 'ENGINEER',
    status: 'ACTIVE',
    ...overrides,
  }) as unknown as OrganizationMembershipEntity;

const organizationEntity = (overrides: Partial<OrganizationEntity> = {}): OrganizationEntity =>
  ({
    id: 910001,
    organizationCode: 'CLIENT_DEFAULT',
    name: '甲方默认组织',
    kind: 'CLIENT',
    status: 'ACTIVE',
    ...overrides,
  }) as unknown as OrganizationEntity;

/** 读取 TypeORM FindOperator 私有字段（In 的值集合），索引访问避免命名约定冲突 */
const findOperatorValue = (operator: unknown): unknown =>
  (operator as Record<string, unknown>)['_value'];

describe('OrganizationMembershipQueryService', () => {
  it('列出有效成员关系：只取 ACTIVE 成员并装配组织事实', async () => {
    const membershipRepo = makeMembershipRepo();
    const organizationRepo = makeOrganizationRepo();
    membershipRepo.find.mockResolvedValue([membershipEntity()]);
    organizationRepo.find.mockResolvedValue([organizationEntity()]);
    const service = new OrganizationMembershipQueryService(
      membershipRepo as never,
      organizationRepo as never,
    );

    const facts = await service.listActiveMembershipsByAccount({ accountId: 900101 });

    expect(membershipRepo.find).toHaveBeenCalledWith({
      where: { accountId: 900101, status: 'ACTIVE' },
      order: { id: 'ASC' },
    });
    expect(facts).toEqual([
      {
        membershipId: 915001,
        organizationId: 910001,
        organizationCode: 'CLIENT_DEFAULT',
        organizationName: '甲方默认组织',
        organizationKind: 'CLIENT',
        memberRole: 'ENGINEER',
      },
    ]);
  });

  it('组织被停用时事实被剔除（成员 ACTIVE 也不能通过）', async () => {
    const membershipRepo = makeMembershipRepo();
    const organizationRepo = makeOrganizationRepo();
    membershipRepo.find.mockResolvedValue([membershipEntity()]);
    // 组织查询带 status = ACTIVE 条件，停用组织不会命中
    organizationRepo.find.mockResolvedValue([]);
    const service = new OrganizationMembershipQueryService(
      membershipRepo as never,
      organizationRepo as never,
    );

    const facts = await service.listActiveMembershipsByAccount({ accountId: 900101 });

    expect(facts).toEqual([]);
    const organizationWhere = organizationRepo.find.mock.calls[0]?.[0] as {
      where: { id: unknown; status: string };
    };
    expect(organizationWhere.where.status).toBe('ACTIVE');
    expect(findOperatorValue(organizationWhere.where.id)).toEqual([910001]);
  });

  it('无成员关系时不查询组织表', async () => {
    const membershipRepo = makeMembershipRepo();
    const organizationRepo = makeOrganizationRepo();
    membershipRepo.find.mockResolvedValue([]);
    const service = new OrganizationMembershipQueryService(
      membershipRepo as never,
      organizationRepo as never,
    );

    const facts = await service.listActiveMembershipsByAccount({ accountId: 900201 });

    expect(facts).toEqual([]);
    expect(organizationRepo.find).not.toHaveBeenCalled();
  });

  it('按账号与组织校验有效成员资格：命中时返回事实', async () => {
    const membershipRepo = makeMembershipRepo();
    const organizationRepo = makeOrganizationRepo();
    membershipRepo.findOne.mockResolvedValue(
      membershipEntity({ memberRole: 'SUPER_ADMIN', accountId: 900001 }),
    );
    organizationRepo.find.mockResolvedValue([organizationEntity({ id: 910001 })]);
    const service = new OrganizationMembershipQueryService(
      membershipRepo as never,
      organizationRepo as never,
    );

    const fact = await service.findActiveMembership({ accountId: 900001, organizationId: 910001 });

    expect(membershipRepo.findOne).toHaveBeenCalledWith({
      where: { accountId: 900001, organizationId: 910001, status: 'ACTIVE' },
    });
    // 组织查询按成员关系归属收集组织 ID（与成员行实际归属一致）
    const organizationWhere = organizationRepo.find.mock.calls[0]?.[0] as {
      where: { id: unknown };
    };
    expect(findOperatorValue(organizationWhere.where.id)).toEqual([910001]);
    expect(fact).not.toBeNull();
    expect(fact?.memberRole).toBe('SUPER_ADMIN');
  });

  it('指定组织校验：成员不存在或组织停用时返回 null', async () => {
    const membershipRepo = makeMembershipRepo();
    const organizationRepo = makeOrganizationRepo();
    const service = new OrganizationMembershipQueryService(
      membershipRepo as never,
      organizationRepo as never,
    );

    // 成员不存在：不再查询组织表
    membershipRepo.findOne.mockResolvedValue(null);
    await expect(
      service.findActiveMembership({ accountId: 900101, organizationId: 910001 }),
    ).resolves.toBeNull();
    expect(organizationRepo.find).not.toHaveBeenCalled();

    // 成员存在但组织停用：组织查询返回空 → 事实为 null
    membershipRepo.findOne.mockResolvedValue(membershipEntity());
    organizationRepo.find.mockResolvedValue([]);
    await expect(
      service.findActiveMembership({ accountId: 900101, organizationId: 910001 }),
    ).resolves.toBeNull();
    expect(organizationRepo.find).toHaveBeenCalled();
  });
});

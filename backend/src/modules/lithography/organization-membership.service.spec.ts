// src/modules/lithography/organization-membership.service.spec.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import { OrganizationMembershipService } from './organization-membership.service';

const makeRepo = () => ({
  create: jest.fn((value: unknown) => value),
  save: jest.fn(),
});

describe('OrganizationMembershipService', () => {
  it('插入显式落 ACTIVE 初始状态：status=ACTIVE 且 left_at 为 NULL，归属与角色透传落库', async () => {
    const repo = makeRepo();
    repo.save.mockResolvedValue({ id: 915101 });
    const service = new OrganizationMembershipService(repo as never);

    const result = await service.insertMembership({
      organizationId: 910001,
      accountId: 900101,
      memberRole: IdentityTypeEnum.ENGINEER,
    });

    expect(result).toEqual({ membershipId: 915101 });
    // 初始状态与实体 chk_organization_membership_period 一致：
    // ACTIVE 必须同时 left_at IS NULL，避免行单独满足一个 CHECK 而在提交时才发现
    expect(repo.create).toHaveBeenCalledWith({
      organizationId: 910001,
      accountId: 900101,
      memberRole: IdentityTypeEnum.ENGINEER,
      status: 'ACTIVE',
      leftAt: null,
    });
  });

  it('落库失败原样上抛原始异常：错误语义由调用方按所在阶段统一裁决，本层不臆测错误码', async () => {
    const repo = makeRepo();
    const rawError = new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded');
    repo.save.mockRejectedValue(rawError);
    const service = new OrganizationMembershipService(repo as never);

    await expect(
      service.insertMembership({
        organizationId: 910001,
        accountId: 900101,
        memberRole: IdentityTypeEnum.ENGINEER,
      }),
    ).rejects.toBe(rawError);
  });
});

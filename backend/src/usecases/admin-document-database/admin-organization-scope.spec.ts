// src/usecases/admin-document-database/admin-organization-scope.spec.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  captureThrownError,
  createSuperAdminSession,
} from '../../../test/support/account/admin-user.fixture';
import { resolveAdminOrganizationScope } from './admin-organization-scope';

const ADMIN_ACCOUNT_ID = 100001;

function createHarness(
  options: {
    adminLevel?: number | null;
    organizationId?: number;
    memberRole?: string;
    membershipError?: Error;
    session?: Partial<UsecaseSession>;
  } = {},
) {
  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(options.adminLevel ?? null),
  };
  const resolveForAccount = options.membershipError
    ? jest.fn().mockRejectedValue(options.membershipError)
    : jest.fn().mockResolvedValue({
        organizationId: options.organizationId ?? 700001,
        memberRole: options.memberRole ?? IdentityTypeEnum.SUPER_ADMIN,
      });
  const trustedOrganizationContext = { resolveForAccount };
  return {
    params: {
      session: createSuperAdminSession({ accountId: ADMIN_ACCOUNT_ID, ...options.session }),
      accountQueryService: accountQueryService as unknown as AccountQueryService,
      trustedOrganizationContext:
        trustedOrganizationContext as unknown as TrustedOrganizationContextQueryService,
    },
    accountQueryService,
    trustedOrganizationContext,
  };
}

/**
 * 管理员工单组织范围解析：
 * - level 1 为全局（organizationId = null）；
 * - level 2 只取可信组织上下文中成员角色仍为 SUPER_ADMIN 的组织，不接受客户端输入；
 * - 关系缺失、角色不符、组织无效、归属歧义以及 admin_level 为 null/非法时失败关闭。
 */
describe('resolveAdminOrganizationScope', () => {
  it('admin_level = 1：全局范围，不查询组织上下文', async () => {
    const { params, trustedOrganizationContext } = createHarness({ adminLevel: 1 });

    await expect(resolveAdminOrganizationScope(params)).resolves.toEqual({
      adminLevel: 1,
      organizationId: null,
    });
    expect(trustedOrganizationContext.resolveForAccount).not.toHaveBeenCalled();
  });

  it('admin_level = 1：即使会话带着旧公司事实也不查询成员关系，仍保持全公司', async () => {
    const { params, trustedOrganizationContext } = createHarness({
      adminLevel: 1,
      session: { adminOrganizationId: 700099 },
    });

    await expect(resolveAdminOrganizationScope(params)).resolves.toEqual({
      adminLevel: 1,
      organizationId: null,
    });
    expect(trustedOrganizationContext.resolveForAccount).not.toHaveBeenCalled();
  });

  it('admin_level = null：失败关闭，不按一级放行', async () => {
    const { params, trustedOrganizationContext } = createHarness({ adminLevel: null });

    const error = await captureThrownError(resolveAdminOrganizationScope(params));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(trustedOrganizationContext.resolveForAccount).not.toHaveBeenCalled();
  });

  it('admin_level = 2：唯一有效 SUPER_ADMIN 关系返回可信本公司', async () => {
    const { params, trustedOrganizationContext } = createHarness({
      adminLevel: 2,
      organizationId: 700002,
      memberRole: IdentityTypeEnum.SUPER_ADMIN,
    });

    await expect(resolveAdminOrganizationScope(params)).resolves.toEqual({
      adminLevel: 2,
      organizationId: 700002,
    });
    expect(trustedOrganizationContext.resolveForAccount).toHaveBeenCalledWith({
      accountId: ADMIN_ACCOUNT_ID,
    });
  });

  it('admin_level = 2：旧会话公司事实不能覆盖当前可信成员公司', async () => {
    const { params, trustedOrganizationContext } = createHarness({
      adminLevel: 2,
      organizationId: 700002,
      memberRole: IdentityTypeEnum.SUPER_ADMIN,
      session: { adminOrganizationId: 700099 },
    });

    await expect(resolveAdminOrganizationScope(params)).resolves.toEqual({
      adminLevel: 2,
      organizationId: 700002,
    });
    // 只按账号重新解析，不读取会话中的旧公司事实
    expect(trustedOrganizationContext.resolveForAccount).toHaveBeenCalledWith({
      accountId: ADMIN_ACCOUNT_ID,
    });
  });

  it.each([IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER])(
    'admin_level = 2 且唯一关系角色为 %s：角色不符失败关闭',
    async (memberRole) => {
      const { params, trustedOrganizationContext } = createHarness({
        adminLevel: 2,
        organizationId: 700002,
        memberRole,
      });

      const error = await captureThrownError(resolveAdminOrganizationScope(params));

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(trustedOrganizationContext.resolveForAccount).toHaveBeenCalledTimes(1);
    },
  );

  it('admin_level = 2 且无有效成员关系：失败关闭', async () => {
    const { params } = createHarness({
      adminLevel: 2,
      membershipError: new DomainError(
        ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
        '当前账号没有有效组织成员关系，无法执行组织范围操作',
      ),
    });

    const error = await captureThrownError(resolveAdminOrganizationScope(params));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP);
  });

  it('admin_level = 2 且成员关系歧义：失败关闭', async () => {
    const { params } = createHarness({
      adminLevel: 2,
      membershipError: new DomainError(
        ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
        '当前账号存在多个有效组织成员关系，无法确定组织范围',
      ),
    });

    const error = await captureThrownError(resolveAdminOrganizationScope(params));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP);
  });

  it('非法 admin_level：按 FORBIDDEN 失败关闭，不回退全库', async () => {
    const { params, trustedOrganizationContext } = createHarness({ adminLevel: 3 });

    const error = await captureThrownError(resolveAdminOrganizationScope(params));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(trustedOrganizationContext.resolveForAccount).not.toHaveBeenCalled();
  });
});

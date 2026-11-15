// src/core/account/policy/admin-scope.policy.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { resolveAdminScope, resolveOrganizationScopedAdminScope } from './admin-scope.policy';

/**
 * 管理员作用域裁决单测：只允许「精确管理员身份 + 合法等级 + 二级可信公司」，
 * 其余一律 FORBIDDEN，避免等级缺失被当成一级全范围。
 */
describe('resolveAdminScope', () => {
  const baseSession: UsecaseSession = {
    accountId: 10,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: 9,
  };

  it('一级管理员返回全范围，可信公司可为空', () => {
    expect(resolveAdminScope({ ...baseSession, adminOrganizationId: 9 }, '查看名单')).toEqual({
      level: 1,
      organizationId: 9,
    });
    expect(resolveAdminScope({ ...baseSession, adminOrganizationId: null }, '查看名单')).toEqual({
      level: 1,
      organizationId: null,
    });
  });

  it('一级管理员的非法可信公司按缺失处理，不影响全范围', () => {
    expect(resolveAdminScope({ ...baseSession, adminOrganizationId: 0 }, '查看名单')).toEqual({
      level: 1,
      organizationId: null,
    });
    expect(resolveAdminScope({ ...baseSession, adminOrganizationId: -3 }, '查看名单')).toEqual({
      level: 1,
      organizationId: null,
    });
  });

  it('二级管理员返回本公司作用域', () => {
    expect(
      resolveAdminScope({ ...baseSession, adminLevel: 2, adminOrganizationId: 27 }, '查看名单'),
    ).toEqual({ level: 2, organizationId: 27 });
  });

  it('二级管理员缺少可信公司时拒绝', () => {
    expect(() =>
      resolveAdminScope({ ...baseSession, adminLevel: 2, adminOrganizationId: null }, '查看名单'),
    ).toThrow(expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }));
    expect(() =>
      resolveAdminScope({ ...baseSession, adminLevel: 2, adminOrganizationId: 0 }, '查看名单'),
    ).toThrow(expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }));
  });

  it('管理员等级缺失或非法时拒绝', () => {
    expect(() => resolveAdminScope({ ...baseSession, adminLevel: null }, '查看名单')).toThrow(
      expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }),
    );
    expect(() => resolveAdminScope({ ...baseSession, adminLevel: 3 }, '查看名单')).toThrow(
      expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }),
    );
    expect(() => resolveAdminScope({ ...baseSession, adminLevel: undefined }, '查看名单')).toThrow(
      expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }),
    );
  });

  it('非管理员角色或活跃角色不是管理员时拒绝', () => {
    expect(() =>
      resolveAdminScope({ ...baseSession, roles: [IdentityTypeEnum.CUSTOMER] }, '查看名单'),
    ).toThrow(expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }));
    expect(() =>
      resolveAdminScope({ ...baseSession, activeRole: IdentityTypeEnum.CUSTOMER }, '查看名单'),
    ).toThrow(expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }));
  });
});

/**
 * 审批域作用域：一级归一为全范围（company = null），二级保留可信公司；
 * 等级缺失/非法与二级缺公司仍由底层 `resolveAdminScope` 失败关闭。
 */
describe('resolveOrganizationScopedAdminScope', () => {
  const baseSession: UsecaseSession = {
    accountId: 10,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    adminOrganizationId: 9,
  };

  it('一级管理员即使有成员公司也归一为全范围', () => {
    expect(
      resolveOrganizationScopedAdminScope({ ...baseSession, adminOrganizationId: 9 }, '审核'),
    ).toEqual({ level: 1, organizationId: null });
  });

  it('二级管理员保留请求期可信公司', () => {
    expect(
      resolveOrganizationScopedAdminScope(
        { ...baseSession, adminLevel: 2, adminOrganizationId: 27 },
        '审核',
      ),
    ).toEqual({ level: 2, organizationId: 27 });
  });

  it('等级缺失、非法或二级缺公司时拒绝', () => {
    expect(() =>
      resolveOrganizationScopedAdminScope({ ...baseSession, adminLevel: null }, '审核'),
    ).toThrow(expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }));
    expect(() =>
      resolveOrganizationScopedAdminScope({ ...baseSession, adminLevel: 3 }, '审核'),
    ).toThrow(expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }));
    expect(() =>
      resolveOrganizationScopedAdminScope(
        { ...baseSession, adminLevel: 2, adminOrganizationId: null },
        '审核',
      ),
    ).toThrow(expect.objectContaining({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS }));
  });
});

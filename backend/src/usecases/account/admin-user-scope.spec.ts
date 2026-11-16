// src/usecases/account/admin-user-scope.spec.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import {
  createAdminOrganizationFact,
  createLevelTwoAdminSession,
  createOrganizationIsolationMocks,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { assertAdminUserManagementScope } from './admin-user-scope';

/**
 * 任务 08.4：列表 / 启停 / 默认密码重置共用的管理员作用域断言。
 *
 * 重点是两条与旧实现不同的边界：
 * 1. 等级必须来自请求期会话（`adminLevel`），角色正确但等级缺失仍拒绝；
 * 2. 一级是平台级角色，**不要求也不解析**成员公司；只有二级才复核成员关系。
 */
describe('assertAdminUserManagementScope', () => {
  const organizationIsolation = createOrganizationIsolationMocks();

  const run = (session: Parameters<typeof assertAdminUserManagementScope>[0]['session']) =>
    assertAdminUserManagementScope({
      session,
      actionLabel: '查看',
      organizationContext: organizationIsolation.organizationContextQueryService,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    organizationIsolation.resolveForAccount
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
  });

  it('一级管理员返回全范围作用域，且不解析成员公司', async () => {
    await expect(run(createSuperAdminSession())).resolves.toEqual({
      level: 1,
      organizationId: null,
    });
    expect(organizationIsolation.resolveForAccount).not.toHaveBeenCalled();
  });

  it('一级管理员即使请求期带有成员公司也不收窄范围', async () => {
    await expect(run(createSuperAdminSession({ adminOrganizationId: 100 }))).resolves.toEqual({
      level: 1,
      organizationId: null,
    });
    expect(organizationIsolation.resolveForAccount).not.toHaveBeenCalled();
  });

  it('二级管理员在成员关系复核通过后返回可信公司作用域', async () => {
    const session = createLevelTwoAdminSession();
    await expect(run(session)).resolves.toEqual({ level: 2, organizationId: 100 });
    expect(organizationIsolation.resolveForAccount).toHaveBeenCalledWith({
      accountId: session.accountId,
      transactionContext: undefined,
    });
  });

  it('二级管理员的成员角色不再是 SUPER_ADMIN 时失败关闭', async () => {
    organizationIsolation.resolveForAccount
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact({ memberRole: 'CUSTOMER' }));

    await expect(run(createLevelTwoAdminSession())).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
  });

  it('二级管理员的成员公司与请求期可信公司不一致时失败关闭', async () => {
    organizationIsolation.resolveForAccount
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact({ organizationId: 999 }));

    await expect(run(createLevelTwoAdminSession())).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
  });

  it.each([
    ['等级缺失', { adminLevel: null }],
    ['等级非法', { adminLevel: 3 }],
  ])('%s 时失败关闭，且不解析成员公司', async (_label, overrides) => {
    await expect(run(createSuperAdminSession(overrides))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(organizationIsolation.resolveForAccount).not.toHaveBeenCalled();
  });

  it('二级管理员缺少可信公司归属时失败关闭', async () => {
    await expect(
      run(createSuperAdminSession({ adminLevel: 2, adminOrganizationId: null })),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(organizationIsolation.resolveForAccount).not.toHaveBeenCalled();
  });

  it.each(createUnauthorizedSessions())(
    '%s 在角色层就被拒绝，且不解析成员公司',
    async (_label, session) => {
      await expect(
        assertAdminUserManagementScope({
          session,
          actionLabel: '查看',
          organizationContext: organizationIsolation.organizationContextQueryService,
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(organizationIsolation.resolveForAccount).not.toHaveBeenCalled();
    },
  );

  it('普通角色的会话即使带等级也不放行', async () => {
    await expect(
      run(
        createSuperAdminSession({
          roles: [IdentityTypeEnum.CUSTOMER],
          activeRole: IdentityTypeEnum.CUSTOMER,
        }),
      ),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
  });
});

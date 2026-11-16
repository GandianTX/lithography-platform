// src/usecases/admin-document-database/admin-document-database-permission.spec.ts

import {
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
  DomainError,
} from '@core/common/errors/domain-error';
import {
  captureThrownError,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { createAdminDocumentDatabaseAccessMocks } from '../../../test/support/account/admin-document-database-access.fixture';
import {
  assertAdminDocumentDatabaseGlobalAccess,
  assertAdminDocumentDatabasePermission,
} from './admin-document-database-permission';

/**
 * PR3 S4：管理员文档数据库精确权限断言单测。
 *
 * 失败关闭规则与用户管理断言同源：roles 含 SUPER_ADMIN 且可信 JWT activeRole
 * 精确为 SUPER_ADMIN 才放行；两类「半管理员」矛盾会话（只满足其一）必须拒绝。
 */
describe('assertAdminDocumentDatabasePermission', () => {
  it('SUPER_ADMIN roles + activeRole 精确匹配时放行', () => {
    expect(() =>
      assertAdminDocumentDatabasePermission(createSuperAdminSession(), '查看维修申请数据'),
    ).not.toThrow();
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时失败关闭拒绝',
    async ({ session }) => {
      const error = (await captureThrownError(
        Promise.resolve().then(() =>
          assertAdminDocumentDatabasePermission(session, '查看维修申请数据'),
        ),
      )) as DomainError;

      expect(error).toBeInstanceOf(DomainError);
      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(error.message).toContain('仅超级管理员可以查看维修申请数据');
    },
  );

  it('拒绝 details 不携带任何身份事实', async () => {
    const [engineerSession] = createUnauthorizedSessions();
    const thrown = (await captureThrownError(
      Promise.resolve().then(() =>
        assertAdminDocumentDatabasePermission(engineerSession[1], '查看文档数据库统计'),
      ),
    )) as DomainError;

    expect(thrown.details).toBeUndefined();
  });
});

/**
 * F1：全域入口 = 角色断言 + 当前等级（必须 1）+ 可信组织成员事实。
 *
 * 三项均在业务读取前完成；等级与成员任意一项不满足即失败关闭，不降级、不回退全库。
 */
describe('assertAdminDocumentDatabaseGlobalAccess', () => {
  const createDeps = () => {
    const access = createAdminDocumentDatabaseAccessMocks();
    return {
      access,
      deps: {
        accountQueryService: { findAdminLevelByAccountId: access.findAdminLevelByAccountId },
        organizationContextService: { resolveForAccount: access.resolveForAccount },
      },
    };
  };

  it('一级管理员 + 单一有效组织成员时放行并返回组织事实', async () => {
    const { deps } = createDeps();

    const membership = await assertAdminDocumentDatabaseGlobalAccess({
      session: createSuperAdminSession(),
      ...deps,
      actionLabel: '查看文档数据库统计',
    });

    expect(membership.organizationId).toBe(100);
    expect(deps.accountQueryService.findAdminLevelByAccountId).toHaveBeenCalledWith(
      createSuperAdminSession().accountId,
    );
    expect(deps.organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: createSuperAdminSession().accountId,
    });
  });

  it.each([2, null, 0, 3])('当前等级 %j 时失败关闭，且不读取成员事实', async (level) => {
    const { access, deps } = createDeps();
    access.setAdminLevel(level);

    const error = (await captureThrownError(
      assertAdminDocumentDatabaseGlobalAccess({
        session: createSuperAdminSession(),
        ...deps,
        actionLabel: '查看维修申请数据库',
      }),
    )) as DomainError;

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(error.message).toContain('仅一级管理员可以查看维修申请数据库');
    expect(deps.organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['无有效成员', ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'],
    ['多关系歧义', ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP, '存在多个有效组织成员关系'],
  ])('%s 时失败关闭并向业务层冒泡', async (_label, code, message) => {
    const { access, deps } = createDeps();
    access.setMembershipError(new DomainError(code, message));

    const error = (await captureThrownError(
      assertAdminDocumentDatabaseGlobalAccess({
        session: createSuperAdminSession(),
        ...deps,
        actionLabel: '查看文档数据库统计',
      }),
    )) as DomainError;

    expect(error.code).toBe(code);
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时角色断言先行拒绝，不读取等级与成员事实',
    async ({ session }) => {
      const { deps } = createDeps();

      const error = (await captureThrownError(
        assertAdminDocumentDatabaseGlobalAccess({
          session,
          ...deps,
          actionLabel: '查看文档数据库统计',
        }),
      )) as DomainError;

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(deps.accountQueryService.findAdminLevelByAccountId).not.toHaveBeenCalled();
      expect(deps.organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    },
  );
});
